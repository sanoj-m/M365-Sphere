// Microsoft Graph client: user enumeration, folder tree, message delta sync, MIME download.
const { httpSignal } = require('./util');
const GRAPH = 'https://graph.microsoft.com/v1.0';

class GraphClient {
  constructor(auth, log, cfg = {}) {
    this.auth = auth; this.log = log; this.cooldownUntil = 0;
    this.timeoutMs = cfg.httpTimeoutMs || 120000;
    // Adaptive concurrency: halve on every 429, recover +1 after 50 straight successes.
    this.maxInFlight = 6;
    this._inFlight = 0;
    this._waiters = [];
    this._successStreak = 0;
    // Set by the engine while a job runs; aborting it cancels in-flight fetches
    // and backoff sleeps immediately so Stop takes effect at once.
    this.signal = null;
  }

  _aborted() {
    const e = new Error('operation aborted');
    e.name = 'AbortError'; e.aborted = true;
    return e;
  }

  _sleep(ms, sig) {
    return new Promise((res, rej) => {
      if (sig && sig.aborted) { rej(this._aborted()); return; }
      const t = setTimeout(() => { cleanup(); res(); }, ms);
      const onAbort = () => { clearTimeout(t); rej(this._aborted()); };
      const cleanup = () => { if (sig) sig.removeEventListener('abort', onAbort); };
      if (sig) sig.addEventListener('abort', onAbort, { once: true });
    });
  }

  async _acquire(sig) {
    if (sig && sig.aborted) throw this._aborted();
    if (this._inFlight < this.maxInFlight) { this._inFlight++; return; }
    await new Promise((res, rej) => {
      const w = () => { cleanup(); res(); };
      const onAbort = () => {
        const i = this._waiters.indexOf(w);
        if (i >= 0) this._waiters.splice(i, 1);
        cleanup();
        rej(this._aborted());
      };
      const cleanup = () => { if (sig) sig.removeEventListener('abort', onAbort); };
      if (sig) sig.addEventListener('abort', onAbort, { once: true });
      this._waiters.push(w);
    });
    this._inFlight++;
  }

  _release() {
    this._inFlight--;
    const next = this._waiters.shift();
    if (next) next();
  }

  _throttled() { this.maxInFlight = Math.max(1, this.maxInFlight >> 1); this._successStreak = 0; }

  _succeeded() {
    if (++this._successStreak >= 50 && this.maxInFlight < 6) { this.maxInFlight++; this._successStreak = 0; }
  }

  async req(pathOrUrl, opts = {}, retries = 10) {
    const url = pathOrUrl.startsWith('http') ? pathOrUrl : GRAPH + pathOrUrl;
    // Per-call abort signal (opts.signal) lets concurrent jobs (copy/dedupe)
    // cancel independently of the engine-wide this.signal.
    const sig = opts.signal || this.signal;
    let retried401 = false, lastErr = null;
    for (let i = 0; i < retries; i++) {
      if (sig && sig.aborted) throw this._aborted();
      // Shared throttle cooldown: when any request sees a 429, every worker
      // waits it out instead of stampeding the mailbox with parallel retries.
      const cool = this.cooldownUntil - Date.now();
      if (cool > 0) await this._sleep(cool + Math.random() * 500, sig);
      // Token fetch is inside the retry loop: a token-endpoint blip gets the
      // same backoff as any other network failure.
      let tok;
      try {
        tok = await this.auth.graphToken();
      } catch (e) {
        lastErr = e;
        if (e.aborted || e.name === 'AbortError' || (sig && sig.aborted)) throw this._aborted();
        const wait = Math.min(60, 2 ** i * 2) + Math.random() * 3;
        await this._sleep(wait * 1000, sig);
        continue;
      }
      await this._acquire(sig);
      let r;
      try {
        r = await fetch(url, { ...opts, signal: httpSignal(sig, this.timeoutMs), headers: { Authorization: `Bearer ${tok}`, ...(opts.headers || {}) } });
      } catch (e) {
        if (e.aborted || (sig && sig.aborted)) throw this._aborted();
        // Network failure (ECONNRESET/ETIMEDOUT/timeout/socket hangup): same backoff as 5xx.
        lastErr = e;
        const wait = Math.min(60, 2 ** i * 2) + Math.random() * 3;
        await this._sleep(wait * 1000, sig);
        continue;
      } finally {
        this._release();
      }
      if (r.status === 401 && !retried401) {
        // Cached token rejected — drop it and retry once with a fresh token.
        retried401 = true;
        if (typeof this.auth.clearToken === 'function') this.auth.clearToken();
        else if (this.auth.cache && typeof this.auth.cache.clear === 'function') this.auth.cache.clear();
        continue;
      }
      if (r.status === 429 || r.status >= 500) {
        lastErr = new Error(`Graph ${r.status} [${url.slice(0, 120)}]`);
        lastErr.status = r.status;
        let wait;
        if (r.status === 429) {
          const ra = parseInt(r.headers.get('retry-after') || '5', 10);
          // Escalate on repeated throttling — Graph keeps 429ing while the
          // mailbox stays hot, so a fixed Retry-After just re-hits the limit.
          wait = Math.min(120, ra * (i + 1));
          this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + ra * 1000);
          this._throttled();
        } else {
          wait = Math.min(60, 2 ** i * 2);
        }
        wait += Math.random() * 3; // jitter: avoid all workers retrying in lockstep
        await this._sleep(wait * 1000, sig);
        continue;
      }
      if (r.status === 404) { this._succeeded(); return null; }
      if (!r.ok) {
        const t = (await r.text()).slice(0, 400);
        const err = new Error(`Graph ${r.status}: ${t} [${url.slice(0, 120)}]`);
        err.status = r.status;
        throw err;
      }
      this._succeeded();
      return r;
    }
    // Retries exhausted: surface the real last failure, not a generic 429 label.
    throw lastErr || new Error(`Graph request failed after ${retries} attempts: ${url.slice(0, 140)}`);
  }

  async getJson(pathOrUrl, signal = null) {
    const r = await this.req(pathOrUrl, signal ? { signal } : {});
    return r ? r.json() : null;
  }

  async * pages(pathOrUrl, signal = null) {
    let next = pathOrUrl;
    while (next) {
      const j = await this.getJson(next, signal);
      if (!j) return;
      yield j.value || [];
      next = j['@odata.nextLink'] || null;
    }
  }

  // All mail-enabled user objects (user + shared/resource mailboxes appear here).
  // Graph v1.0 exposes no recipient-type property, so classify from fields on this
  // same call: guests (B2B #EXT# accounts) by userType; shared/resource mailboxes
  // carry no assigned licenses while licensed user mailboxes do.
  async listUsers() {
    const out = [];
    for await (const batch of this.pages(`/users?$select=id,userPrincipalName,displayName,mail,userType,assignedLicenses&$top=999`)) {
      for (const u of batch) {
        if (!u.userPrincipalName) continue;
        const licensed = (u.assignedLicenses || []).length > 0;
        // Skip users that cannot have a mailbox (no mail address, no license) —
        // they would only fail on every backup run.
        if (!u.mail && !licensed) continue;
        const type = u.userType === 'Guest' ? 'guest' : licensed ? 'user' : 'shared';
        out.push({ upn: u.userPrincipalName.toLowerCase(), type });
      }
    }
    return out;
  }

  // Full folder tree of the primary mailbox with live item counts.
  // onFolder(folder) fires as each folder is discovered (for live persistence).
  async folderTree(upn, onProgress, onFolder = null) {
    const tree = [];
    const push = f => { tree.push(f); if (onFolder) onFolder(f); };
    // Items sitting directly in the mailbox root are not part of any top-level
    // folder — expose the root itself as a syncable folder.
    try {
      const root = await this.getJson(`/users/${encodeURIComponent(upn)}/mailFolders/root?$select=id,displayName,totalItemCount`);
      if (root) push({ folderId: root.id, parentId: null, name: 'Mailbox root', path: 'Mailbox root', itemCount: root.totalItemCount || 0 });
    } catch (e) {
      this.log('warn', upn, 'folderTree: mailbox root unreadable: ' + e.message);
    }
    const walk = async (parentId, parentPath) => {
      const q = parentId
        ? `/users/${encodeURIComponent(upn)}/mailFolders/${encodeURIComponent(parentId)}/childFolders`
        : `/users/${encodeURIComponent(upn)}/mailFolders`;
      for await (const batch of this.pages(`${q}${q.includes('?') ? '&' : '?'}$select=id,displayName,parentFolderId,totalItemCount,childFolderCount&$top=200`)) {
        const kids = [];
        for (const f of batch) {
          const path = parentPath ? parentPath + '/' + f.displayName : f.displayName;
          push({ folderId: f.id, parentId: parentId || null, name: f.displayName, path, itemCount: f.totalItemCount || 0 });
          kids.push([f.id, path]);
        }
        // Bounded-parallel child walk — serial awaits made large trees crawl.
        for (let i = 0; i < kids.length; i += 4) {
          await Promise.all(kids.slice(i, i + 4).map(([id, p]) => walk(id, p)));
        }
        if (onProgress) onProgress(tree.length, parentPath);
      }
    };
    await walk(null, '');
    return tree;
  }

  // Delta sync: returns { token, ids: [...], deleted: [...] }. token=deltaLink for next run.
  async deltaIds(upn, folderId, deltaToken) {
    let url = deltaToken ||
      `/users/${encodeURIComponent(upn)}/mailFolders/${encodeURIComponent(folderId)}/messages/delta?$select=id`;
    const ids = [], deleted = [];
    while (url) {
      let r;
      try {
        r = await this.req(url);
      } catch (e) {
        if (e.status === 410) { const g = new Error('delta token expired'); g.gone = true; throw g; }
        throw e;
      }
      if (!r) {
        // req() returns null on 404 — the folder is gone; force a full re-sync
        // (same handling as an expired/invalid delta token).
        const g = new Error('folder not found (404 on delta)');
        g.gone = true;
        throw g;
      }
      const j = await r.json();
      for (const it of j.value || []) {
        if (it['@removed']) deleted.push(it.id); else ids.push(it.id);
      }
      url = j['@odata.nextLink'] || null;
      if (!url && j['@odata.deltaLink']) return { token: j['@odata.deltaLink'], ids, deleted };
      if (!url) {
        // A delta page with neither nextLink nor deltaLink means the listing is
        // incomplete — returning here would pass partial ids off as a full sync
        // and cause false deletions downstream.
        throw new Error(`delta page missing both @odata.nextLink and @odata.deltaLink (folder ${folderId})`);
      }
    }
    throw new Error('delta sync ended without a deltaLink');
  }

  async getMessageMime(upn, id, signal = null) {
    const r = await this.req(`/users/${encodeURIComponent(upn)}/messages/${encodeURIComponent(id)}/$value`, signal ? { signal } : {});
    return r ? Buffer.from(await r.arrayBuffer()) : null;
  }

  // Import a raw RFC822 message into a folder (MIME upload). Returns the created
  // message object ({ id, internetMessageId, subject, receivedDateTime, ... }).
  async postMessageMime(upn, folderId, mime, signal = null) {
    const r = await this.req(
      `/users/${encodeURIComponent(upn)}/mailFolders/${encodeURIComponent(folderId)}/messages?$select=id,internetMessageId,subject,receivedDateTime`,
      { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: mime, signal });
    return r ? r.json() : null;
  }

  async getMessageMeta(upn, id, signal = null) {
    return this.getJson(`/users/${encodeURIComponent(upn)}/messages/${encodeURIComponent(id)}?$select=id,internetMessageId,subject,receivedDateTime`, signal);
  }

  // Resolve (creating as needed) a slash-separated folder path in a mailbox.
  // Returns the leaf folder id. Names are matched case-insensitively among the
  // parent's children; Exchange allows duplicate display names, so we always
  // reuse an existing match instead of blindly creating.
  async ensureFolderPath(upn, pathStr, signal = null) {
    let parentId = null;
    for (const seg of String(pathStr).split('/').filter(Boolean)) {
      parentId = await this._ensureChildFolder(upn, parentId, seg, signal);
    }
    return parentId;
  }

  async ensureChildFolder(upn, parentId, name, signal = null) { return this._ensureChildFolder(upn, parentId, name, signal); }

  // Same as ensureChildFolder but also reports whether the folder was created
  // (vs an existing same-named child being reused).
  async ensureChildFolderEx(upn, parentId, name, signal = null) {
    const base = `/users/${encodeURIComponent(upn)}/mailFolders`;
    const listUrl = parentId
      ? `${base}/${encodeURIComponent(parentId)}/childFolders?$select=id,displayName&$top=200`
      : `${base}?$select=id,displayName&$top=200`;
    for await (const batch of this.pages(listUrl, signal)) {
      const hit = batch.find(f => String(f.displayName).toLowerCase() === name.toLowerCase());
      if (hit) return { id: hit.id, created: false };
    }
    const createUrl = parentId ? `${base}/${encodeURIComponent(parentId)}/childFolders` : base;
    const r = await this.req(createUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: name }),
      signal
    });
    const j = await r.json();
    return { id: j.id, created: true };
  }

  async _ensureChildFolder(upn, parentId, name, signal = null) {
    const base = `/users/${encodeURIComponent(upn)}/mailFolders`;
    const listUrl = parentId
      ? `${base}/${encodeURIComponent(parentId)}/childFolders?$select=id,displayName&$top=200`
      : `${base}?$select=id,displayName&$top=200`;
    for await (const batch of this.pages(listUrl, signal)) {
      const hit = batch.find(f => String(f.displayName).toLowerCase() === name.toLowerCase());
      if (hit) return hit.id;
    }
    const createUrl = parentId ? `${base}/${encodeURIComponent(parentId)}/childFolders` : base;
    const r = await this.req(createUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: name }),
      signal
    });
    const j = await r.json();
    return j.id;
  }

  async folderItemCount(upn, folderId, signal = null) {
    const j = await this.getJson(`/users/${encodeURIComponent(upn)}/mailFolders/${encodeURIComponent(folderId)}?$select=id,totalItemCount`, signal);
    return j ? (j.totalItemCount || 0) : null;
  }

  // Move a message to an arbitrary destination folder id (or a well-known name
  // like 'deleteditems'). Returns the moved message object ({ id, ... }).
  async moveMessage(upn, messageId, destinationId, signal = null) {
    const r = await this.req(`/users/${encodeURIComponent(upn)}/messages/${encodeURIComponent(messageId)}/move`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ destinationId }),
      signal
    });
    return r ? r.json() : null;
  }

  // Move a message to the mailbox's Deleted Items folder (recoverable server-side).
  async moveToDeletedItems(upn, messageId, signal = null) {
    return this.moveMessage(upn, messageId, 'deleteditems', signal);
  }

  // Delete a mail folder (Graph refuses non-empty folders). Tolerates 404.
  async deleteFolder(upn, folderId, signal = null) {
    try {
      await this.req(`/users/${encodeURIComponent(upn)}/mailFolders/${encodeURIComponent(folderId)}`, { method: 'DELETE', signal });
      return true;
    } catch (e) {
      if (e && e.status === 404) return false;
      throw e;
    }
  }

  // Compare page listing: id + display fields incl. sender.
  async listMessages(upn, folderId, signal = null) {
    const out = [];
    const q = `/users/${encodeURIComponent(upn)}/mailFolders/${encodeURIComponent(folderId)}/messages?$select=id,internetMessageId,subject,receivedDateTime,from&$top=200`;
    for await (const batch of this.pages(q, signal)) {
      for (const m of batch) {
        const fa = m.from && m.from.emailAddress;
        out.push({
          id: m.id,
          internetMessageId: m.internetMessageId || null,
          subject: m.subject || null,
          receivedAt: m.receivedDateTime || null,
          sender: fa ? (fa.name ? `${fa.name} <${fa.address}>` : fa.address) : ''
        });
      }
    }
    return out;
  }

  // Lightweight message listing for dedupe scans.
  async listMessageKeys(upn, folderId, signal = null) {
    const out = [];
    const q = `/users/${encodeURIComponent(upn)}/mailFolders/${encodeURIComponent(folderId)}/messages?$select=id,internetMessageId,subject,receivedDateTime&$top=200`;
    for await (const batch of this.pages(q, signal)) out.push(...batch);
    return out;
  }
}

module.exports = { GraphClient };
