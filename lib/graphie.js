// Graph Mailbox Import/Export client (archive path) — BETA endpoints.
// STRICTLY READ-ONLY against the source mailbox: folder/item enumeration,
// delta sync and exportItems (a read-only export; the source item is never
// changed, moved or deleted). No import/write operation exists in this file.
//
// Auto-expanding archive support: folder/item requests can return
// HTTP 308 to an auxiliary partition (Location: same path under another MBX:
// GUID on graph.microsoft.com); exportItems reports per-item
// ErrorArchiveFolderMovedPermanently with the redirect URL in the message.
// Redirect policy: HTTPS + graph.microsoft.com + /admin/exchange/mailboxes/
// path only, max 5 hops, loop detection, every hop logged.
const { httpSignal } = require('./util');

const BETA = 'https://graph.microsoft.com/beta';
const MAX_HOPS = 5;
const EXPORT_BATCH = 20; // documented exportItems limit

class GraphIeError extends Error {
  constructor(message, kind, extra) {
    super(message);
    this.kind = kind; // 'retryable' | 'auth' | 'routing' | 'data' | 'permanent'
    Object.assign(this, extra || {});
  }
}

class GraphIe {
  constructor(cfg, auth, log) {
    this.cfg = cfg;
    this.auth = auth;
    this.log = log || (() => { });
    this.timeoutMs = cfg.httpTimeoutMs || 120000;
    this.signal = null; // set by the engine per run
    this.cooldownUntil = 0;
    this.maxInFlight = 4;
    this._inFlight = 0;
    this._waiters = [];
    this._successStreak = 0;
  }

  // Redirect policy: HTTPS, graph.microsoft.com host, exchange mailboxes path
  // (Microsoft returns varying casing: /admin/Exchange/Mailboxes/…).
  static checkRedirect(url) {
    try {
      const u = new URL(url);
      return u.protocol === 'https:' && u.host === 'graph.microsoft.com'
        && /^\/(beta|v1\.0)\/admin\/exchange\/mailboxes\//i.test(u.pathname);
    } catch { return false; }
  }

  async _sleep(ms) {
    if (this.signal?.aborted) { const e = new Error('aborted'); e.aborted = true; throw e; }
    await new Promise((res, rej) => {
      const t = setTimeout(res, ms);
      this.signal?.addEventListener('abort', () => { clearTimeout(t); const e = new Error('aborted'); e.aborted = true; rej(e); }, { once: true });
    });
  }

  _throttled() { this.maxInFlight = Math.max(1, this.maxInFlight >> 1); this._successStreak = 0; }
  _succeeded() { if (++this._successStreak >= 50 && this.maxInFlight < 4) { this.maxInFlight++; this._successStreak = 0; } }

  async _acquire() {
    if (this._inFlight < this.maxInFlight) { this._inFlight++; return; }
    await new Promise((res, rej) => {
      const w = { res, rej };
      this._waiters.push(w);
      this.signal?.addEventListener('abort', () => { const e = new Error('aborted'); e.aborted = true; w.rej(e); }, { once: true });
    });
  }
  _release() { this._inFlight--; const w = this._waiters.shift(); if (w) { this._inFlight++; w.res(); } }

  // One HTTP call with retry classification + redirect following.
  // Returns { res, finalMailboxId } — caller reads the body. Redirect hops
  // reissue the identical request (method + body) to the Location URL.
  async _raw(url, opts = {}, upn = '') {
    const hops = [];
    let current = url;
    for (let hop = 0; hop <= MAX_HOPS; hop++) {
      let lastErr = null, redirected = false;
      for (let i = 0; i < 10; i++) {
        if (this.signal?.aborted) { const e = new Error('aborted'); e.aborted = true; throw e; }
        const wait = this.cooldownUntil - Date.now();
        if (wait > 0) await this._sleep(wait + Math.random() * 500);
        await this._acquire();
        try {
          const tok = await this.auth.graphToken();
          const res = await fetch(current, {
            ...opts,
            headers: { ...(opts.headers || {}), Authorization: `Bearer ${tok}` },
            redirect: 'manual',
            signal: httpSignal(opts.signal || this.signal, this.timeoutMs)
          });
          this._succeeded();
          if (res.status === 308) {
            const loc = res.headers.get('location');
            if (!loc || !GraphIe.checkRedirect(loc)) {
              throw new GraphIeError(`308 redirect to untrusted location: ${loc}`, 'routing');
            }
            hops.push(loc);
            this.log('info', upn, `[graphie] 308 redirect → auxiliary partition ${loc.match(/mailboxes\/([^/]+)/i)?.[1] || '?'} (hop ${hops.length})`);
            current = loc;
            redirected = true;
            break; // next hop
          }
          if (res.status === 401 && i === 0) { this.auth.clearToken?.(); continue; }
          if (res.status === 401 || res.status === 403) {
            throw new GraphIeError(`Graph IE ${res.status}: ${(await res.text()).slice(0, 300)}`, 'auth', { status: res.status });
          }
          if (res.status === 429) {
            const ra = parseInt(res.headers.get('retry-after') || '5', 10) || 5;
            this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + Math.min(30, ra) * 1000);
            this._throttled();
            lastErr = new GraphIeError('Graph IE throttled (429)', 'retryable');
            await this._sleep(Math.min(120, ra * (i + 1)) * 1000 + Math.random() * 3000);
            continue;
          }
          if (res.status >= 500) {
            lastErr = new GraphIeError(`Graph IE ${res.status}: ${(await res.text()).slice(0, 300)}`, 'retryable');
            await this._sleep(Math.min(60, 2 ** i * 2) * 1000 + Math.random() * 3000);
            continue;
          }
          return { res, hops, finalUrl: current };
        } catch (e) {
          if (e.aborted || e instanceof GraphIeError && e.kind !== 'retryable') throw e;
          lastErr = e.kind === 'retryable' ? e : new GraphIeError(String(e.message || e), 'retryable');
          if (e.kind !== 'retryable') throw e;
          await this._sleep(Math.min(60, 2 ** i * 2) * 1000 + Math.random() * 3000);
        } finally { this._release(); }
      }
      if (redirected) continue; // follow the redirect: next hop
      throw lastErr || new GraphIeError('Graph IE retries exhausted', 'retryable');
    }
    throw new GraphIeError(`too many archive redirects (> ${MAX_HOPS})`, 'routing', { hops });
  }

  async _json(url, opts, upn) {
    const { res, hops, finalUrl } = await this._raw(url, opts, upn);
    if (res.status === 404) return { json: null, hops, finalUrl };
    if (!res.ok) throw new GraphIeError(`Graph IE ${res.status}: ${(await res.text()).slice(0, 300)}`, 'data', { status: res.status });
    return { json: await res.json(), hops, finalUrl };
  }

  // Mailbox IDs for a user: { primary, archive } (archive = inPlaceArchiveMailboxId).
  async mailboxIds(upn) {
    const tok = await this.auth.graphToken();
    const r = await fetch(`${BETA}/users/${encodeURIComponent(upn)}/settings/exchange`, {
      headers: { Authorization: `Bearer ${tok}` }, signal: httpSignal(this.signal, this.timeoutMs)
    });
    if (!r.ok) throw new GraphIeError(`exchangeSettings ${r.status}: ${(await r.text()).slice(0, 200)}`, r.status === 403 ? 'auth' : 'retryable');
    const j = await r.json();
    const es = (j.value && j.value[0]) || j;
    return { primary: es.primaryMailboxId || null, archive: es.inPlaceArchiveMailboxId || null };
  }

  // Archive folder delta. Pages through nextLinks (redirect-aware); returns
  // { folders, deltaToken, partitions:Set<MBX id> } — partitions = every
  // physical mailbox seen via redirects during this enumeration.
  async foldersDelta(upn, mailboxId, token, onFolder) {
    let url = token || `${BETA}/admin/exchange/mailboxes/${encodeURIComponent(mailboxId)}/folders/delta`;
    const folders = [], partitions = new Set();
    while (url) {
      const { json, finalUrl } = await this._json(url, {}, upn);
      if (!json) throw new GraphIeError('folder delta: mailbox/folder gone (404)', 'routing', { gone: true });
      const m = finalUrl.match(/mailboxes\/([^/]+)/i);
      if (m && decodeURIComponent(m[1]) !== mailboxId) partitions.add(decodeURIComponent(m[1]));
      for (const f of json.value || []) {
        folders.push(f);
        if (onFolder) await onFolder(f, decodeURIComponent(m?.[1] || mailboxId));
      }
      url = json['@odata.nextLink'] || null;
      if (!url && json['@odata.deltaLink']) return { folders, deltaToken: json['@odata.deltaLink'], partitions: [...partitions] };
    }
    throw new GraphIeError('folder delta ended without a deltaLink', 'data');
  }

  // Item-id delta for one folder. Same redirect semantics; expanded folders
  // (AEA) redirect the whole listing to the auxiliary partition.
  // NOTE: this beta endpoint rejects $select (only $filter=receivedDateTime and
  // $orderby are documented) — FTS items carry no subject/date metadata.
  async itemsDelta(upn, mailboxId, folderId, token) {
    let url = token || `${BETA}/admin/exchange/mailboxes/${encodeURIComponent(mailboxId)}/folders/${encodeURIComponent(folderId)}/items/delta`;
    const ids = [], deleted = [], partitions = new Set();
    while (url) {
      const { json, finalUrl } = await this._json(url, {}, upn);
      if (!json) { const e = new GraphIeError('item delta: gone (404)', 'routing'); e.gone = true; throw e; }
      const m = finalUrl.match(/mailboxes\/([^/]+)/i);
      if (m && decodeURIComponent(m[1]) !== mailboxId) partitions.add(decodeURIComponent(m[1]));
      for (const it of json.value || []) {
        if (it['@removed']) deleted.push(it.id); else ids.push(it.id);
      }
      url = json['@odata.nextLink'] || null;
      if (!url && json['@odata.deltaLink']) return { ids, deleted, token: json['@odata.deltaLink'], partitions: [...partitions] };
    }
    throw new GraphIeError('item delta ended without a deltaLink', 'data');
  }

  // exportItems: max 20 ids per request (documented). Per-item
  // ErrorArchiveFolderMovedPermanently errors are resolved by reissuing a
  // single-item export to the redirect URL from the error message.
  // Returns { items: [{ itemId, changeKey, data(Buffer) }], failed: [{itemId,error}] }.
  // data is the raw opaque FTS bytes (decoded from base64) — never parsed.
  async exportItems(upn, mailboxId, itemIds) {
    const out = { items: [], failed: [] };
    for (let i = 0; i < itemIds.length; i += EXPORT_BATCH) {
      const batch = itemIds.slice(i, i + EXPORT_BATCH);
      const { res, finalUrl } = await this._raw(`${BETA}/admin/exchange/mailboxes/${encodeURIComponent(mailboxId)}/exportItems`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ itemIds: batch })
      }, upn);
      if (!res.ok) throw new GraphIeError(`exportItems ${res.status}: ${(await res.text()).slice(0, 300)}`, res.status === 403 ? 'auth' : 'data', { status: res.status });
      const j = await res.json();
      for (const r of j.value || []) {
        if (r.data) { out.items.push({ itemId: r.itemId, changeKey: r.changeKey, data: Buffer.from(r.data, 'base64') }); continue; }
        const redir = r.error && /ErrorArchiveFolderMovedPermanently/.test(r.error.code || '') ? r.error.message.match(/https:\/\/\S+/)?.[0] : null;
        if (redir && GraphIe.checkRedirect(redir)) {
          try {
            const sub = await this.exportItems(upn, mailboxIdFromUrl(redir) || mailboxId, [r.itemId]);
            out.items.push(...sub.items); out.failed.push(...sub.failed);
            continue;
          } catch (e) { out.failed.push({ itemId: r.itemId, error: e.message }); continue; }
        }
        out.failed.push({ itemId: r.itemId, error: r.error ? `${r.error.code}: ${String(r.error.message).slice(0, 200)}` : 'no data returned' });
      }
      void finalUrl;
    }
    return out;
  }
}

function mailboxIdFromUrl(url) {
  try { return decodeURIComponent(new URL(url).pathname.match(/mailboxes\/([^/]+)/i)?.[1] || ''); } catch { return null; }
}

module.exports = { GraphIe, GraphIeError, EXPORT_BATCH };
