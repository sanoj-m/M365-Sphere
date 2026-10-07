// Backup/verify engine: drives Graph (primary) and EWS (archive), checkpoints every
// item as .eml.gz under dataDir/store/<upn>/<scope>/<folderPath>/<fileId>.eml.gz.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { promisify } = require('util');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');
const { safeName } = require('./util');
const { refreshCoverage } = require('./coverage');
const { ftsPreview } = require('./fts');

const gunzipAsync = promisify(zlib.gunzip);

const encodeId = id => Buffer.from(String(id), 'utf8').toString('base64url');
// Graph item ids are 200-800 chars — base64url filenames blow past NTFS limits.
// sha1 hex is 40 chars, always safe.
const fileIdFor = id => crypto.createHash('sha1').update(String(id)).digest('hex');

// Minimal RFC 2047 mime-word decode so Subject/From/Date come from the MIME itself,
// replacing a whole extra getMessageMeta Graph call per item.
function parseMimeHeaders(mime) {
  let subject = null, receivedAt = null, sender = null, messageId = null;
  try {
    const head = mime.slice(0, Math.min(mime.length, 32768)).toString('utf8');
    const get = name => {
      const m = head.match(new RegExp(`^${name}:[ \\t]*((?:[^\\r\\n]*(?:\\r?\\n[ \\t][^\\r\\n]*)*))`, 'im'));
      return m ? m[1].replace(/\r?\n[ \t]+/g, ' ').trim() : null;
    };
    const dec = s => s == null ? null : s.replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (whole, cs, enc, txt) => {
      try {
        const buf = enc.toUpperCase() === 'B'
          ? Buffer.from(txt, 'base64')
          : Buffer.from(txt.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))), 'binary');
        return buf.toString('utf8');
      } catch { return whole; }
    });
    subject = dec(get('Subject'));
    sender = dec(get('From'));
    const d = get('Date');
    if (d) { const t = Date.parse(d); if (!isNaN(t)) receivedAt = new Date(t).toISOString(); }
    const mid = get('Message-ID');
    if (mid) messageId = mid.replace(/[<>]/g, '').trim().toLowerCase() || null;
  } catch { subject = null; }
  return { subject, receivedAt, sender, messageId };
}

class Engine {
  constructor({ cfg, store, graph, ews, graphie, log, bus }) {
    this.cfg = cfg; this.store = store; this.graph = graph; this.ews = ews; this.graphie = graphie || null; this.log = log; this.bus = bus;
    this.running = false;
    this._stop = false;
    // Per-scope stop: lets the operator halt only primary or only archive
    // syncing mid-run; the other scope continues. In-flight batches finish.
    this._stopScopes = { primary: false, archive: false };
    // Per-mailbox scoped stop: upns flagged here skip that scope when their
    // turn comes (or break out of it if already syncing).
    this._stopScopeUpns = { primary: new Set(), archive: new Set() };
    this._aborter = null;
    this.live = {}; // per-upn live backup progress: { scope, foldersTotal, foldersDone, itemsTotal, itemsDone, currentFolder }
    this.jobUpns = []; // upns covered by the currently running backup job
    this._liveEmitAt = 0;
    this._byteDeltas = {}; // upn -> { primary, archive } accumulated since last flush
    this.storeRoot = path.join(cfg.dataDir, 'store');
  }

  stop() {
    this._stop = true;
    if (this._aborter) this._aborter.abort();
    this.log('info', '', 'stop requested — halting now');
  }
  // Graceful per-scope stop: the current folder batch finishes, then that scope
  // is skipped for the rest of the run. With upn, only that mailbox is affected.
  // Returns false if no run is active.
  stopScope(scope, upn) {
    if (!this.running) return false;
    if (upn) this._stopScopeUpns[scope].add(upn);
    else this._stopScopes[scope] = true;
    this.log('info', upn || '', `${scope} sync stop requested — finishing current folder batch, then skipping ${scope}`);
    this.emitLive();
    return true;
  }
  scopeStopped(scope, upn) {
    return this._stop || !!this._stopScopes[scope] || !!(upn && this._stopScopeUpns[scope].has(upn));
  }
  get stopped() { return this._stop; }

  // Start a cancellable run: in-flight Graph/EWS requests and backoff sleeps
  // reject immediately when stop() aborts the controller.
  _beginRun() {
    this._aborter = new AbortController();
    this.graph.signal = this._aborter.signal;
    this.ews.signal = this._aborter.signal;
    if (this.graphie) this.graphie.signal = this._aborter.signal;
  }
  _endRun() {
    this.graph.signal = null;
    this.ews.signal = null;
    if (this.graphie) this.graphie.signal = null;
    this._aborter = null;
  }

  // Throttled live-progress broadcast (in-memory only, not persisted to jobs table).
  emitLive() {
    const now = Date.now();
    if (now - this._liveEmitAt < 500) return;
    this._liveEmitAt = now;
    this.bus.emit('progress', { live: this.live });
  }

  // Human-readable phase ("Enumerating archive folders (EWS)… 120 found") shown
  // in the live panel (currentFolder slot) and mirrored into the job detail so
  // the top progress bar says what the run is doing, not just which mailbox.
  _setLivePhase(upn, text) {
    const L = this.live[upn];
    if (!L) return;
    L.currentFolder = text;
    this.emitLive();
  }
  _jobPhase(jobId, upn, text) {
    if (!jobId) return;
    const now = Date.now();
    if (now - (this._phaseAt || 0) < 1000) return;
    this._phaseAt = now;
    this.progress(jobId, { detail: `${upn} — ${text}` });
  }
  _phase(upn, jobId, text) {
    this._setLivePhase(upn, text);
    this._jobPhase(jobId, upn, text);
  }

  progress(jobId, patch) {
    this.store.updateJob(jobId, patch);
    this.bus.emit('progress', patch);
  }

  // ---------- Discover ----------
  async discover() {
    if (this.running) throw new Error('already running');
    this.running = true; this._stop = false;
    this._beginRun();
    const job = this.store.createJob('discover');
    try {
      this.log('info', '', 'discovering mailboxes…');
      const users = await this.graph.listUsers();
      let n = 0;
      for (const u of users) {
        if (this.stopped) break;
        this.store.upsertMailbox(u.upn, u.type);
        n++;
      }
      this.progress(job, { status: 'done', total: n, done: n, detail: `${n} mailboxes`, finishedAt: new Date().toISOString() });
      this.log('info', '', `discover complete: ${n} mailboxes`);
    } catch (e) {
      if (e.aborted || this.stopped) {
        this.progress(job, { status: 'stopped', finishedAt: new Date().toISOString() });
        this.log('info', '', 'discover stopped');
      } else {
        this.progress(job, { status: 'error', detail: String(e.message), finishedAt: new Date().toISOString() });
        this.log('error', '', 'discover failed: ' + e.message);
      }
    } finally { this._endRun(); this.running = false; }
  }

  // ---------- Backup ----------
  async runBackup(upn, upns, opts = {}) {
    if (this.running) throw new Error('already running');
    this.running = true; this._stop = false;
    this._stopScopes = { primary: false, archive: false };
    this._stopScopeUpns = { primary: new Set(), archive: new Set() };
    this._beginRun();
    const list = Array.isArray(upns)
      ? upns.map(u => this.store.getMailbox(u)).filter(Boolean)
      : upn
        ? [this.store.getMailbox(upn)].filter(Boolean)
        : this.store.listMailboxes().filter(m => m.status !== 'syncing');
    if (!list.length) { this._endRun(); this.running = false; throw new Error('no matching mailboxes'); }
    this.jobUpns = list.map(m => m.upn);
    const job = this.store.createJob('backup', list.length);
    try {
      let done = 0;
      for (const m of list) {
        if (this.stopped) break;
        await this.backupMailbox(m.upn, job, done, opts.scope, opts.provider);
        done++;
        this.progress(job, { done, detail: m.upn });
      }
      this.progress(job, { status: this.stopped ? 'stopped' : 'done', finishedAt: new Date().toISOString() });
    } catch (e) {
      if (!e.aborted && !this.stopped) throw e;
      this.progress(job, { status: 'stopped', finishedAt: new Date().toISOString() });
      this.log('info', '', 'backup stopped');
    } finally {
      this.live = {};
      this.jobUpns = [];
      this.bus.emit('progress', { live: this.live });
      this._endRun();
      this.running = false;
    }
  }

  async backupMailbox(upn, jobId, doneSoFar, scope, provider) {
    this.store.patchMailboxFields(upn, { status: 'syncing', lastError: null, backupScope: scope || 'all' });
    this.live[upn] = { scope: '', foldersTotal: 0, foldersDone: 0, itemsTotal: 0, itemsDone: 0, currentFolder: '', enumFound: 0 };
    this.bus.emit('progress', { live: this.live });
    this.log('info', upn, scope ? `${scope}-only backup started` : 'backup started');
    const runId = this.store.createRun({ upn, scope: scope || 'all', provider: provider || (this.cfg.graphExchangeExportEnabled ? 'graph+graphie' : 'graph+ews') });
    let pending = 0;
    let archiveSeen = false;
    const scopes = scope ? [scope] : ['primary', 'archive'];
    for (const sc of scopes) {
      if (this.stopped) break;
      if (this.scopeStopped(sc, upn)) {
        this.log('info', upn, `${sc} scope skipped (stopped by user) — re-run to continue it`);
        pending += 1; // keep the mailbox 'partial' so resume picks this scope up
        continue;
      }
      if (sc === 'archive' && this.store.getMailbox(upn)?.hasArchive === 0) continue;
      try {
        pending += await this.syncScope(upn, sc, jobId, provider);
        if (sc === 'archive') {
          archiveSeen = true;
          // Auto-expanding archives move most content to auxiliary storages that
          // EWS/Graph cannot see — warn once per run so the gap is visible.
          const mbx = this.store.getMailbox(upn);
          const ieOn = this.graphie && this.cfg.graphExchangeExportEnabled;
          if (mbx && mbx.autoExpandingArchive && !ieOn) {
            this.log('warn', upn, `auto-expanding archive: auxiliary archive storage is not accessible via EWS — backup covers the main archive partition only (${mbx.archiveBytes || 0} bytes accessible of ${mbx.serverArchiveBytes != null ? mbx.serverArchiveBytes : 'unknown'} bytes reported by Exchange)`);
          }
        }
      } catch (e) {
        if (e.aborted) throw e;
        const msg = String(e.message || e);
        if (sc === 'archive' && /could not be found|not found in the store|ErrorFolderNotFound/i.test(msg)) {
          this.store.patchMailboxFields(upn, { hasArchive: 0 });
          this.log('info', upn, 'no online archive for this mailbox — skipping archive scope');
          continue;
        }
        // Permanent failures (access denied / impersonation missing / 403) will never
        // succeed on retry — mark the mailbox 'skipped' so the auto-resume sweep and
        // pending counts ignore it until the operator fixes permissions and re-runs.
        if (/\b403\b|ErrorAccessDenied|impersonat|permission|denied|full_access/i.test(msg)) {
          this.store.patchMailboxFields(upn, { status: 'skipped', lastError: msg.slice(0, 500) });
          this.log('error', upn, `${sc} sync failed permanently (access denied) — mailbox marked 'skipped'; fix permissions/impersonation, then run Backup manually to retry`);
          const cov = refreshCoverage(this.store, upn, { ieEnabled: !!(this.graphie && this.cfg.graphExchangeExportEnabled) });
          this.store.finishRun(runId, { coverageState: cov ? cov.state : 'BLOCKED' });
          delete this.live[upn];
          this.bus.emit('progress', { live: this.live });
          return;
        }
        this.log('warn', upn, `${sc} sync failed: ${msg}`);
        if (sc === 'primary') {
          this.store.patchMailboxFields(upn, { status: 'error', lastError: msg.slice(0, 500) });
          const cov = refreshCoverage(this.store, upn, { ieEnabled: !!(this.graphie && this.cfg.graphExchangeExportEnabled) });
          this.store.finishRun(runId, { coverageState: cov ? cov.state : 'FAILED' });
          delete this.live[upn];
          this.bus.emit('progress', { live: this.live });
          return;
        }
        pending += 1; // archive failed -> mailbox is partial
      }
    }
    // recompute stored bytes from item rows
    this._updateBytes(upn);
    // A mailbox is only fully backed up when every folder's stored rows match the
    // live folder item count — never trust delta/fetch success alone. hiddenCount
    // is the part of the count no EWS listing can ever return (hidden/associated
    // items, or auto-expanding-archive auxiliary partitions EWS cannot reach).
    const short = this.store.db.prepare(`
      SELECT f.name, f.itemCount, f.hiddenCount,
        (SELECT COUNT(*) FROM items i WHERE i.upn=f.upn AND i.scope=f.scope AND i.folderId=f.folderId AND i.status IN ('done','deduped')) stored,
        (SELECT COUNT(*) FROM items i2 WHERE i2.upn=f.upn AND i2.scope=f.scope AND i2.folderId=f.folderId AND i2.status='failed') failed
      FROM folders f WHERE f.upn=? AND f.folderId NOT LIKE 'exo%'`).all(upn)
      // Folders whose remaining gap is entirely failed (poison) or unreachable
      // (hidden) items are done as far as retries go — don't hold the mailbox
      // 'partial' for them.
      .filter(f => f.itemCount > 0 && f.stored + f.failed + (f.hiddenCount || 0) < f.itemCount);
    if (short.length) {
      pending += short.reduce((a, f) => a + (f.itemCount - f.stored - f.failed - (f.hiddenCount || 0)), 0);
      this.log('warn', upn, `incomplete folders: ${short.slice(0, 5).map(f => `${f.name} ${f.stored}/${f.itemCount}`).join(', ')}${short.length > 5 ? ' …' : ''} — re-run backup to continue`);
    }
    // Unreachable content (hidden/associated items, AEA auxiliary partitions) is
    // no longer absorbed: it holds coverage at PARTIAL. Retries still skip it —
    // the run ends, but the mailbox is never reported fully backed up.
    const unreachable = this.store.db.prepare(
      `SELECT COALESCE(SUM(hiddenCount),0) n FROM folders WHERE upn=? AND folderId NOT LIKE 'exo%'`).get(upn).n;
    if (unreachable > 0) {
      this.log('warn', upn, `${unreachable} item(s) unreachable via the backup APIs (hidden/associated or auto-expanding auxiliary partitions) — coverage is PARTIAL; use EXO export / PST import to capture them`);
    }
    const fields = { status: (pending > 0 || unreachable > 0) ? 'partial' : 'done' };
    if (archiveSeen) fields.hasArchive = 1;
    this.store.patchMailboxFields(upn, fields);
    // EWS browse-copy pass: fold the EWS namespace into the IE tree so the UI
    // shows one hierarchy with both .eml.gz (browse) and .fts.gz (restore) items.
    if (provider === 'ews' && archiveSeen) {
      const m = this.store.mergeArchiveNamespaces(upn);
      if (m.movedItems || m.dropped) this.log('info', upn, `browse copies merged into the archive tree (${m.movedItems} items, ${m.dropped} folders)`);
    }
    const L = this.live[upn];
    const cov = refreshCoverage(this.store, upn, { ieEnabled: !!(this.graphie && this.cfg.graphExchangeExportEnabled) });
    this.store.finishRun(runId, {
      itemsDiscovered: L ? L.itemsTotal : 0, itemsNew: L ? L.itemsDone : 0,
      itemsFailed: this.store.db.prepare(`SELECT COUNT(*) n FROM items WHERE upn=? AND status='failed'`).get(upn).n,
      serverBytes: (this.store.getMailbox(upn).serverPrimaryBytes || 0) + (this.store.getMailbox(upn).serverArchiveBytes || 0) || null,
      coverageState: cov ? cov.state : null
    });
    this.log(pending > 0 || unreachable > 0 ? 'warn' : 'info', upn, `backup finished: ${pending} item(s) pending${unreachable ? `, ${unreachable} unreachable` : ''} — coverage ${cov ? cov.state : 'unknown'}`);
    delete this.live[upn];
    this.bus.emit('progress', { live: this.live });
  }

  // Single source of truth for a folder's on-disk directory.
  folderDir(upn, scope, folderPath) {
    return path.join(this.storeRoot, safeName(upn), scope, ...String(folderPath).split('/').map(safeName));
  }

  // Recompute stored byte totals from item rows — exact, but expensive; used once
  // per mailbox (end of run) as the reconciliation point.
  _updateBytes(upn) {
    const sums = this.store.db.prepare(
      `SELECT scope, COALESCE(SUM(size),0) b FROM items WHERE upn=? AND status='done' GROUP BY scope`).all(upn);
    const fields = { primaryBytes: 0, archiveBytes: 0 };
    for (const s of sums) fields[s.scope === 'archive' ? 'archiveBytes' : 'primaryBytes'] = s.b;
    this.store.patchMailboxFields(upn, fields);
    delete this._byteDeltas[upn];
  }

  // Cheap live progress: accumulate byte deltas in memory while fetching and apply
  // them with an incremental UPDATE once per folder instead of a full SUM per batch.
  _addBytes(upn, scope, n) {
    const d = this._byteDeltas[upn] || (this._byteDeltas[upn] = { primary: 0, archive: 0 });
    d[scope === 'archive' ? 'archive' : 'primary'] += n;
  }
  _flushBytes(upn) {
    const d = this._byteDeltas[upn];
    if (!d || (!d.primary && !d.archive)) return;
    this._byteDeltas[upn] = { primary: 0, archive: 0 };
    this.store.db.prepare('UPDATE mailboxes SET primaryBytes=primaryBytes+?, archiveBytes=archiveBytes+? WHERE upn=?')
      .run(d.primary, d.archive, upn);
  }

  // Archive folder enumeration via EWS SyncFolderHierarchy: folders are
  // persisted as they arrive (an interrupted run keeps its progress) and a
  // stored sync cursor makes later runs validate only the changes. Falls back
  // to the full FindFolder walk if hierarchy sync fails.
  async _enumArchive(upn, jobId) {
    const L = this.live[upn];
    const track = n => {
      if (L) { L.enumFound = n; this.emitLive(); }
      this._phase(upn, jobId, `Enumerating archive folders (EWS)… ${n} found`);
    };
    const mbox = this.store.getMailbox(upn) || {};
    let state = mbox.archiveHierarchyState || '';
    // Known folders map, kept up to date during enumeration so paths resolve and
    // each discovered folder is persisted immediately (the UI lists them live).
    const byId = new Map(this.store.listFolders(upn).filter(f => f.scope === 'archive').map(f => [f.folderId, f]));
    if (!byId.has('archivemsgfolderroot')) {
      byId.set('archivemsgfolderroot', { folderId: 'archivemsgfolderroot', parentId: null, name: 'Archive root', path: 'Archive root', itemCount: 0 });
    }
    // Live-upsert only folders we don't know yet; updates/renames of known
    // folders go through the final pass below so on-disk rename moves work.
    const upsertLive = f => {
      if (byId.has(f.folderId)) return;
      const parent = byId.get(f.parentId);
      const path = parent && parent.path ? parent.path + '/' + f.name : f.name;
      const row = { upn, scope: 'archive', folderId: f.folderId, parentId: f.parentId, name: f.name, path, itemCount: f.itemCount, deltaToken: undefined, syncState: undefined };
      this.store.upsertFolder(row);
      byId.set(f.folderId, { ...row, path });
    };
    let res;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        res = await this.ews.syncFolderHierarchy(upn, state, null, track, upsertLive);
        break;
      } catch (e) {
        // Stale/corrupt cursor (e.g. after long inactivity): drop it and do one
        // full hierarchy sync. Anything else falls back to the FindFolder walk.
        if (attempt === 0 && state && /sync.*state|InvalidSyncState/i.test(String(e.fault || e.message))) {
          this.log('warn', upn, 'archive hierarchy sync state rejected — re-enumerating from scratch');
          state = '';
          continue;
        }
        this.log('warn', upn, `archive hierarchy sync failed (${String(e.fault || e.message).slice(0, 200)}) — falling back to full folder walk`);
        const onEnum = (n, p) => {
          if (L) { L.enumFound = n; this.emitLive(); }
          this._phase(upn, jobId, `Enumerating archive folders (EWS)… ${n} found${p ? ` — in ${p}` : ''}`);
        };
        const onFolder = f => {
          this.store.upsertFolder({ upn, scope: 'archive', ...f, deltaToken: undefined, syncState: undefined });
          byId.set(f.folderId, { upn, scope: 'archive', ...f });
        };
        const folders = await this.ews.folderTree(upn, onEnum, null, onFolder);
        this._reconcileFolders(upn, 'archive', folders);
        return folders;
      }
    }
    const full = !state;
    for (const f of res.changed) {
      const parent = byId.get(f.parentId);
      const path = parent && parent.path ? parent.path + '/' + f.name : f.name;
      const prev = byId.get(f.folderId);
      if (prev && (prev.path || prev.name) !== path) {
        const oldDir = this.folderDir(upn, 'archive', prev.path || prev.name);
        try {
          if (fs.existsSync(oldDir)) await fsp.rename(oldDir, this.folderDir(upn, 'archive', path));
        } catch { /* best-effort — affected files are re-fetched if the move fails */ }
      }
      const row = { upn, scope: 'archive', folderId: f.folderId, parentId: f.parentId, name: f.name, path, itemCount: f.itemCount, deltaToken: undefined, syncState: undefined };
      this.store.upsertFolder(row);
      byId.set(f.folderId, { ...row, path });
    }
    for (const id of res.deleted) {
      this.store.db.prepare('DELETE FROM items WHERE upn=? AND scope=? AND folderId=?').run(upn, 'archive', id);
      this.store.db.prepare('DELETE FROM folders WHERE upn=? AND scope=? AND folderId=?').run(upn, 'archive', id);
      byId.delete(id);
    }
    this.store.patchMailboxFields(upn, { archiveHierarchyState: res.syncState });
    const folders = [...byId.values()];
    if (full) this._reconcileFolders(upn, 'archive', folders);
    return folders;
  }

  // Archive enumeration via Graph Mailbox IE (beta): folder delta on the archive
  // mailbox, following 308 redirects into AEA auxiliary partitions (each physical
  // partition seen is recorded in archive_partitions). Folder/item ids are stored
  // under the 'ie-' namespace so this path coexists with the EWS archive rows.
  async _enumArchiveIe(upn, jobId) {
    const L = this.live[upn];
    const track = n => {
      if (L) { L.enumFound = n; this.emitLive(); }
      this._phase(upn, jobId, `Enumerating archive folders (Graph IE)… ${n} found`);
    };
    const ids = await this.graphie.mailboxIds(upn);
    if (!ids.archive) throw new Error('archive mailbox could not be found (no inPlaceArchiveMailboxId)');
    this.store.patchMailboxFields(upn, { archiveMailboxId: ids.archive, hasArchive: 1 });
    const mbox = this.store.getMailbox(upn) || {};
    const cursor = mbox.archiveIeState || null;
    const byId = new Map(this.store.listFolders(upn).filter(f => f.scope === 'archive' && f.folderId.startsWith('ie-')).map(f => [f.folderId, f]));
    let n = 0;
    const toRow = f => {
      const folderId = 'ie-' + f.id;
      const parentId = f.parentFolderId ? 'ie-' + f.parentFolderId : null;
      // The archive root comes back with no displayName — name it like the EWS
      // synthetic root so paths and the tree stay clean.
      const name = f.displayName || 'Archive root';
      const parent = parentId && byId.get(parentId);
      const path = parent && parent.path ? parent.path + '/' + name : name;
      return { upn, scope: 'archive', folderId, parentId, name, path, itemCount: f.totalItemCount || 0 };
    };
    const onFolder = f => {
      if (f['@removed']) return;
      const row = toRow(f);
      if (!byId.has(row.folderId)) {
        this.store.upsertFolder({ ...row, deltaToken: undefined, syncState: undefined });
        byId.set(row.folderId, row);
      }
      track(++n);
    };
    const res = await this.graphie.foldersDelta(upn, ids.archive, cursor, onFolder);
    for (const p of res.partitions) {
      this.store.upsertPartition({ upn, partitionId: p, partitionType: 'aux', discoveredVia: 'graphie-redirect', status: 'reachable' });
      this.log('info', upn, `auxiliary archive partition reachable via Graph IE: ${p}`);
    }
    // Apply changes (renames) + deletions.
    for (const f of res.folders) {
      const row = toRow(f);
      if (f['@removed']) {
        this.store.db.prepare('DELETE FROM items WHERE upn=? AND scope=? AND folderId=?').run(upn, 'archive', row.folderId);
        this.store.db.prepare('DELETE FROM folders WHERE upn=? AND scope=? AND folderId=?').run(upn, 'archive', row.folderId);
        continue;
      }
      const prev = this.store.getFolder(upn, 'archive', row.folderId);
      if (prev && (prev.path || prev.name) !== (row.path || row.name)) {
        const oldDir = this.folderDir(upn, 'archive', prev.path || prev.name);
        try { if (fs.existsSync(oldDir)) await fsp.rename(oldDir, this.folderDir(upn, 'archive', row.path || row.name)); } catch { }
      }
      this.store.upsertFolder({ ...row, deltaToken: undefined, syncState: undefined });
      byId.set(row.folderId, row);
    }
    this.store.patchMailboxFields(upn, { archiveIeState: res.deltaToken });
    const folders = [...byId.values()];
    if (!cursor) this._reconcileFolders(upn, 'archive', folders, 'ie');
    return folders;
  }

  // IE folder sync: item-id delta → exportItems batches (full-fidelity FTS,
  // stored as <sha1>.fts.gz). FTS is opaque — never parsed; browse copies come
  // from the EWS path or PST ingest.
  async syncFolderIe(upn, folder) {
    const L = this.live[upn];
    const dbFolder = this.store.getFolder(upn, 'archive', folder.folderId) || {};
    const mailboxId = (this.store.getMailbox(upn) || {}).archiveMailboxId;
    if (!mailboxId) throw new Error('archive mailbox id unknown — run enumeration first');
    const rawFolderId = folder.folderId.slice(3); // strip 'ie-'
    const fullListing = !dbFolder.deltaToken;
    const remote = await this.graphie.itemsDelta(upn, mailboxId, rawFolderId, dbFolder.deltaToken || null);
    for (const p of remote.partitions || []) {
      this.store.upsertPartition({ upn, partitionId: p, partitionType: 'aux', discoveredVia: 'graphie-redirect', status: 'reachable' });
    }
    // Record which physical partition this folder's content lives in (AEA moves
    // folders between partitions) — drives per-partition coverage stats.
    this.store.db.prepare('UPDATE folders SET physicalMailboxId=? WHERE upn=? AND scope=? AND folderId=?')
      .run((remote.partitions && remote.partitions[0]) || null, upn, 'archive', folder.folderId);
    const localRows = this.store.folderItemIds(upn, 'archive', folder.folderId);
    const known = new Set(localRows.map(r => r.itemId));
    const retired = [];
    const commit = () => {
      if (fullListing) {
        const remoteIds = new Set(remote.ids.map(x => 'ie-' + (x.id || x)));
        for (const row of localRows) if (!remoteIds.has(row.itemId)) retired.push(row);
      }
      for (const id of remote.deleted || []) {
        const row = this.store.getItem(upn, 'archive', folder.folderId, 'ie-' + id);
        if (row) retired.push(row);
      }
      for (const row of retired) this.store.markItemDeletedFromSource(upn, 'archive', folder.folderId, row.itemId);
      for (const x of remote.ids) {
        const itemId = 'ie-' + (x.id || x);
        if (!known.has(itemId)) {
          this.store.upsertItem({ upn, scope: 'archive', folderId: folder.folderId, itemId, subject: x.subject || null, receivedAt: x.receivedAt || null, status: 'pending', lastError: null, format: 'fts', sourceApi: 'graphie' });
          known.add(itemId);
        } else {
          this.store.clearItemDeletedFromSource(upn, 'archive', folder.folderId, itemId);
        }
      }
      this.store.upsertFolder({ upn, scope: 'archive', folderId: folder.folderId, parentId: folder.parentId, name: folder.name, path: folder.path, itemCount: folder.itemCount, deltaToken: remote.token, syncState: undefined });
    };
    if (typeof this.store.tx === 'function') this.store.tx(commit)(); else commit();
    // Incremental deltas never re-report previously failed items — re-queue them.
    const queue = remote.ids.map(x => x.id || x).filter(id => {
      const row = this.store.getItem(upn, 'archive', folder.folderId, 'ie-' + id);
      return !row || !['done', 'deduped'].includes(row.status);
    });
    for (const r of this.store.pendingItems(upn, 'archive', folder.folderId)) {
      const raw = r.itemId.slice(3);
      if (!queue.includes(raw) && (r.attempts || 0) < 5) queue.push(raw);
    }
    if (!queue.length) return 0;

    const dir = this.folderDir(upn, 'archive', folder.path || folder.name);
    fs.mkdirSync(dir, { recursive: true });
    if (L) { L.itemsTotal += queue.length; this.emitLive(); }
    this._setLivePhase(upn, folder.path || folder.name);
    let pending = 0;
    // Bounded-parallel batch export: a few exportItems calls in flight per folder
    // (the GraphIE client's adaptive concurrency still caps global parallelism and
    // backs off on 429 — this just removes the strict serialization).
    const ieConc = Math.max(1, Math.min(4, this.cfg.ieBatchConcurrency || 3));
    const batches = [];
    for (let i = 0; i < queue.length; i += 20) batches.push(queue.slice(i, i + 20));
    let bi = 0;
    const worker = async () => {
      while (bi < batches.length) {
        if (this.stopped || this.scopeStopped('archive', upn)) { pending += (batches.length - bi) * 20; bi = batches.length; break; }
        const batch = batches[bi++];
        try {
          const res = await this.graphie.exportItems(upn, mailboxId, batch);
        for (const it of res.items) {
          const itemId = 'ie-' + it.itemId;
          const fileId = fileIdFor(itemId);
          const tmp = path.join(dir, fileId + '.tmp');
          const ftsFile = path.join(dir, fileId + '.fts.gz');
          await pipeline(Readable.from(it.data), zlib.createGzip(), fs.createWriteStream(tmp));
          await fsp.rename(tmp, ftsFile); // atomic publish
          this._addBytes(upn, 'archive', it.data.length);
          const prevRow = this.store.getItem(upn, 'archive', folder.folderId, itemId);
          // Metadata for the list pane: subject/sender/date are not in the delta —
          // extract them locally from the FTS stream itself.
          let meta = {};
          try {
            const pv = ftsPreview(it.data, { metaOnly: true });
            meta = { subject: pv.subject !== '(no subject)' ? pv.subject : null, sender: pv.from || null, receivedAt: pv.date || null };
          } catch { }
          this.store.upsertItem({
            upn, scope: 'archive', folderId: folder.folderId, itemId, fileId,
            subject: meta.subject ?? prevRow?.subject ?? null,
            sender: meta.sender ?? prevRow?.sender ?? null,
            receivedAt: meta.receivedAt ?? prevRow?.receivedAt ?? null,
            size: it.data.length, status: 'done', lastError: null, format: 'fts', sourceApi: 'graphie',
            attempts: (prevRow?.attempts || 0) + 1,
            sha256: crypto.createHash('sha256').update(it.data).digest('hex')
          });
        }
        for (const f of res.failed) {
          const itemId = 'ie-' + f.itemId;
          const ex = this.store.getItem(upn, 'archive', folder.folderId, itemId);
          const attempts = (ex?.attempts || 0) + 1;
          if (attempts >= 5) this.store.markItemFailed(upn, 'archive', folder.folderId, itemId, String(f.error).slice(0, 400));
          else this.store.upsertItem({ upn, scope: 'archive', folderId: folder.folderId, itemId, status: 'pending', lastError: String(f.error).slice(0, 400), attempts });
          pending++;
        }
        if (L) { L.itemsDone += batch.length; this.emitLive(); }
      } catch (e) {
        if (e.aborted) throw e;
        this.log('warn', upn, `IE export batch failed (${String(e.message || e).slice(0, 160)}) — ${batch.length} item(s) stay pending`);
        pending += batch.length;
      }
      }
    };
    await Promise.all(Array.from({ length: ieConc }, worker));
    this._flushBytes(upn);
    return pending;
  }

  // Drop folder rows (and their item rows) that vanished remotely. Provider
  // namespaces ('exo%' PST-ingest, 'ie-%' Graph IE) are foreign to EWS/Graph
  // listings and to each other — never reconcile them away.
  _reconcileFolders(upn, scope, folders, providerNs = '') {
    const prevFolders = this.store.listFolders(upn).filter(f => f.scope === scope);
    const seen = new Set(folders.map(f => f.folderId));
    for (const old of prevFolders) {
      if (old.folderId.startsWith('exo')) continue;
      if (providerNs !== 'ie' && old.folderId.startsWith('ie-')) continue;
      if (providerNs === 'ie' && !old.folderId.startsWith('ie-')) continue;
      if (!seen.has(old.folderId)) {
        // folder vanished remotely: drop its item rows (files remain on disk, harmless)
        this.store.db.prepare('DELETE FROM items WHERE upn=? AND scope=? AND folderId=?').run(upn, scope, old.folderId);
        this.store.db.prepare('DELETE FROM folders WHERE upn=? AND scope=? AND folderId=?').run(upn, scope, old.folderId);
      }
    }
  }

  // Sync one scope (primary via Graph; archive via EWS, or Graph Mailbox IE when
  // the graphExchangeExportEnabled flag is on — the IE path reaches AEA auxiliary
  // partitions via 308 redirects). provider='ews' forces the EWS archive path
  // (browsable .eml.gz copies of the main partition). Returns count of non-done items.
  async syncScope(upn, scope, jobId, provider) {
    const L0 = this.live[upn];
    if (L0) { L0.scope = scope; this.emitLive(); }
    const useIe = scope === 'archive' && this.graphie && this.cfg.graphExchangeExportEnabled && provider !== 'ews';
    const label = scope === 'archive' ? (useIe ? 'archive folders (Graph IE)' : 'archive folders (EWS)') : 'primary folders (Graph)';
    let folders;
    if (scope === 'archive') {
      folders = useIe ? await this._enumArchiveIe(upn, jobId) : await this._enumArchive(upn, jobId);
    } else {
      const onEnum = (n, p) => this._phase(upn, jobId, `Enumerating ${label}… ${n} found${p ? ` — in ${p}` : ''}`);
      this._phase(upn, jobId, `Enumerating ${label}…`);
      // Persist newly discovered folders as enumeration walks, so the folder
      // tree in the UI lists them live. Known folders are left for the final
      // pass below (which also handles on-disk renames).
      const onFolder = f => {
        if (!this.store.getFolder(upn, scope, f.folderId)) {
          this.store.upsertFolder({ upn, scope, ...f, deltaToken: undefined, syncState: undefined });
        }
      };
      folders = await this.graph.folderTree(upn, onEnum, onFolder);
      if (folders.length) {
        this._reconcileFolders(upn, scope, folders);
        for (const f of folders) {
          const prev = this.store.getFolder(upn, scope, f.folderId);
          // Folder renamed remotely: move the on-disk directory so files follow it.
          if (prev && (prev.path || prev.name) !== (f.path || f.name)) {
            const oldDir = this.folderDir(upn, scope, prev.path || prev.name);
            try {
              if (fs.existsSync(oldDir)) await fsp.rename(oldDir, this.folderDir(upn, scope, f.path || f.name));
            } catch { /* best-effort — affected files are re-fetched if the move fails */ }
          }
          this.store.upsertFolder({ upn, scope, ...f, deltaToken: undefined, syncState: undefined });
        }
      }
    }
    if (!folders.length) return 0;

    const L = this.live[upn];
    if (L) { L.foldersTotal += folders.length; L.enumFound = 0; this.emitLive(); }

    let pending = 0;
    const conc = Math.max(1, this.cfg.concurrency || 3);
    for (let i = 0; i < folders.length; i += conc) {
      if (this.stopped) break;
      if (this.scopeStopped(scope, upn)) {
        this.log('info', upn, `${scope} sync stopped by user at folder ${i}/${folders.length} — remaining folders resume next run`);
        pending += 1;
        break;
      }
      const batch = folders.slice(i, i + conc);
      this._jobPhase(jobId, upn, `${scope}: folders ${i + 1}–${Math.min(i + conc, folders.length)}/${folders.length} — ${batch[0].path || batch[0].name}`);
      // A folder that fails (e.g. Graph throttling kills its delta paging mid-way)
      // must not abort the whole run — log it, count its items as pending, continue.
      const results = await Promise.all(batch.map(async f => {
        try {
          return await (useIe ? this.syncFolderIe(upn, f) : this.syncFolder(upn, scope, f));
        } catch (e) {
          if (e.aborted) throw e;
          this.log('warn', upn, `folder "${f.path || f.name}" sync failed (${String(e.message || e).slice(0, 160)}) — will resume next run`);
          // Count what is genuinely still missing from the DB rather than the
          // whole folder — most items may already be stored from earlier runs.
          const storedDone = this.store.countDoneItems(upn, scope, f.folderId);
          return Math.max(0, (f.itemCount || 0) - (f.hiddenCount || 0) - storedDone);
        }
      }));
      pending += results.reduce((a, b) => a + b, 0);
      if (L) { L.foldersDone += results.length; this.emitLive(); }
    }
    return pending;
  }

  // Lightweight "is there anything new?" check for a fully-backed-up mailbox:
  // re-enumerates the folder trees of the scopes that have stored folders and
  // compares folder ids + item counts against the DB. No item data is fetched.
  // Returns true when a backup run would have work to do.
  async hasNewItems(upn) {
    const stored = this.store.listFolders(upn);
    for (const scope of ['primary', 'archive']) {
      const local = new Map(stored.filter(f => f.scope === scope).map(f => [f.folderId, f.itemCount || 0]));
      if (!local.size) continue; // scope never synced — nothing to compare against
      const remote = scope === 'primary'
        ? await this.graph.folderTree(upn)
        : await this.ews.folderTree(upn);
      for (const f of remote) {
        if (!local.has(f.folderId)) return true; // new folder
        if ((f.itemCount || 0) !== local.get(f.folderId)) return true; // arrivals or deletions
      }
    }
    return false;
  }

  async syncFolder(upn, scope, folder) {
    const L = this.live[upn];
    if (L) { L.currentFolder = folder.path || folder.name; this.emitLive(); }    const dbFolder = this.store.getFolder(upn, scope, folder.folderId) || {};
    // Fully-synced folder with a live cursor: nothing can have been missed,
    // skip the remote listing entirely. hiddenCount covers items the server
    // counts but no listing returns (hidden/associated messages).
    const hasCursor = scope === 'primary' ? !!dbFolder.deltaToken : !!dbFolder.syncState;
    const hidden = dbFolder.hiddenCount || 0;
    if (hasCursor && folder.itemCount != null
      && this.store.countDoneItems(upn, scope, folder.folderId) + hidden >= folder.itemCount
      && this.store.pendingItems(upn, scope, folder.folderId).length === 0) {
      return 0;
    }
    const dir = this.folderDir(upn, scope, folder.path || folder.name);
    fs.mkdirSync(dir, { recursive: true });

    // Lists remote ids (delta/incremental when a cursor exists) and registers
    // pending rows atomically with the new cursor. forceFull drops the cursor.
    const listAndQueue = async forceFull => {
      let fullListing = forceFull;
      let remote, newToken = null, newState = null;
      if (scope === 'primary') {
        try {
          remote = await this.graph.deltaIds(upn, folder.folderId, forceFull ? null : dbFolder.deltaToken || null);
          newToken = remote.token;
        } catch (e) {
          if (!e.gone) throw e;
          this.log('info', upn, `folder "${folder.name}": delta token expired — full re-sync of this folder`);
          remote = await this.graph.deltaIds(upn, folder.folderId, null);
          newToken = remote.token;
          fullListing = true;
        }
      } else {
        remote = await this.ews.syncFolderItems(upn, folder.folderId, forceFull ? '' : dbFolder.syncState || '');
        newState = remote.syncState;
      }

      // Delta semantics: with a stored token, remote.ids/deleted are CHANGES only — the local
      // rows not mentioned are still valid. Without a token (full sync), remote.ids is the
      // complete folder listing, so pruning local rows not in it is correct.
      // Deletion mirroring is gated by cfg.pruneDeleted (default false): this is a backup
      // tool, so remotely-deleted items are NEVER erased locally by default — the row keeps
      // its status and file, and deletedFromSourceAt records when the source lost it.
      // pruneDeleted=true restores the old mirror (rows 'deleted', files to _graveyard).
      const prune = this.cfg.pruneDeleted === true;
      const incremental = !fullListing;
      const localRows = this.store.folderItemIds(upn, scope, folder.folderId);
      const queue = remote.ids.map(x => scope === 'primary' ? { id: x, changeKey: null } : x);
      const known = new Set(localRows.map(r => r.itemId));
      const retired = []; // rows whose remote counterpart vanished: { itemId, fileId }
      const commit = () => {
        if (!incremental) {
          const remoteIds = new Set(remote.ids.map(x => scope === 'primary' ? x : x.id));
          for (const row of localRows) {
            if (!remoteIds.has(row.itemId) && row.status !== 'deleted') retired.push(row);
          }
        }
        for (const id of remote.deleted || []) {
          const row = this.store.getItem(upn, scope, folder.folderId, id);
          if (row && row.status !== 'deleted') retired.push(row);
        }
        for (const row of retired) {
          if (prune) this.store.deleteItem(upn, scope, folder.folderId, row.itemId);
          else if (this.cfg.graveyardDeleted === true) this.store.upsertItem({ upn, scope, folderId: folder.folderId, itemId: row.itemId, fileId: row.fileId, status: 'deleted', lastError: null });
          else this.store.markItemDeletedFromSource(upn, scope, folder.folderId, row.itemId);
        }
        // Register every queued item as a pending row BEFORE the cursor is saved.
        // Without these rows a run that stops mid-folder loses all trace of
        // unfetched items — they are never re-reported by delta sync and the
        // folder stays permanently incomplete. Cursor persist + pruning + row
        // registration commit atomically.
        const retiredIds = new Set(retired.map(r => r.itemId));
        for (const it of queue) {
          // Re-register unknown rows; also resurrect rows previously marked 'deleted'
          // when the item reappears remotely.
          if (!known.has(it.id) || retiredIds.has(it.id)) {
            this.store.upsertItem({ upn, scope, folderId: folder.folderId, itemId: it.id, status: 'pending', lastError: null });
            known.add(it.id);
          } else {
            // Item reappeared/still present remotely — clear any deletion marker.
            this.store.clearItemDeletedFromSource(upn, scope, folder.folderId, it.id);
          }
        }
        this.store.upsertFolder({ upn, scope, folderId: folder.folderId, parentId: folder.parentId, name: folder.name, path: folder.path, itemCount: folder.itemCount, deltaToken: newToken, syncState: newState });
      };
      // tx() returns a better-sqlite3 transaction function — it must be CALLED.
      if (typeof this.store.tx === 'function') this.store.tx(commit)(); else commit();
      // File moves/deletes happen after the DB transaction commits — only when the
      // operator opted into graveyard/prune mirroring; default keeps files in place.
      if (prune || this.cfg.graveyardDeleted === true) {
        for (const row of retired) await this._retireFile(upn, dir, row, prune);
      }
      // Incremental deltas never re-report previously failed items — re-queue them explicitly.
      const queued = new Set(queue.map(q => q.id));
      for (const r of this.store.pendingItems(upn, scope, folder.folderId)) {
        if (!queued.has(r.itemId)) queue.push({ id: r.itemId, changeKey: null });
      }
      queue._remoteCount = remote.ids.length;
      return queue;
    };

    let queue = await listAndQueue(false);
    let lastRemoteCount = queue._remoteCount || 0;
    // Self-heal a cursor that drifted from the item table: the incremental listing
    // reports nothing while the folder count says items are missing locally.
    // hiddenCount is the part of the count no listing ever returns — exclude it.
    const missing = (folder.itemCount || 0) - hidden - this.store.countDoneItems(upn, scope, folder.folderId);
    if (!queue.length && missing > 0) {
      this.store.clearFolderCursor(upn, scope, folder.folderId);
      dbFolder.deltaToken = null; dbFolder.syncState = null;
      queue = await listAndQueue(true);
      lastRemoteCount = queue._remoteCount || 0;
      if (!queue.length) {
        // Full listing returned nothing new: the gap is items EWS counts but
        // never enumerates. Record the offset so this folder is treated as
        // complete instead of re-listing forever.
        const gap = (folder.itemCount || 0) - lastRemoteCount;
        this.store.setFolderHiddenCount(upn, scope, folder.folderId, Math.max(0, gap));
        if (gap >= (folder.itemCount || 0) && gap > 0) {
          this.log('info', upn, `folder "${folder.name}": contents not accessible via EWS (auto-expanding archive auxiliary partition?) — ${gap} item(s) unreachable, excluded from backup`);
        } else if (gap > 0) {
          this.log('info', upn, `folder "${folder.name}": ${gap} item(s) not enumerable (hidden/associated) — marked reconciled`);
        }
      } else {
        this.log('warn', upn, `folder "${folder.name}": cursor drift — dropped and re-listed (${queue.length} item(s) to fetch)`);
      }
    }
    if (queue._remoteCount != null) delete queue._remoteCount;

    // fetches
    let pending = 0;
    const conc = Math.max(1, this.cfg.concurrency || 3);
    if (L) { L.itemsTotal += queue.length; this.emitLive(); }
    for (let i = 0; i < queue.length; i += conc) {
      if (this.stopped) { pending += queue.length - i; break; }
      const results = await Promise.all(queue.slice(i, i + conc).map(it => this.fetchItem(upn, scope, folder, dir, it.id, it.changeKey)));
      pending += results.filter(Boolean).length;
      if (L) { L.itemsDone += results.length; this.emitLive(); }
    }
    this._flushBytes(upn);
    return pending;
  }

  // Handle the on-disk file of a remotely-deleted item. prune=true: unlink.
  // Otherwise move it to the graveyard so the backup never mirrors a mailbox purge.
  async _retireFile(upn, dir, row, prune) {
    if (!row.fileId) return;
    const fp = path.join(dir, row.fileId + '.eml.gz');
    try {
      if (prune) { await fsp.unlink(fp); return; }
      const gdir = path.join(this.storeRoot, '_graveyard', safeName(upn));
      await fsp.mkdir(gdir, { recursive: true });
      await fsp.rename(fp, path.join(gdir, row.fileId + '.eml.gz'));
    } catch { /* missing file or cross-volume move — leave it */ }
  }

  // Returns true if item is left in non-done state.
  async fetchItem(upn, scope, folder, dir, itemId, changeKey) {
    const existing = this.store.getItem(upn, scope, folder.folderId, itemId);
    // 'deduped' rows intentionally have no local copy kept in place — do not re-download.
    if (existing && (existing.status === 'done' || existing.status === 'deduped')) return false;
    if ((existing?.attempts || 0) >= 5) {
      // Poison item — stop burning requests on it.
      this.store.markItemFailed(upn, scope, folder.folderId, itemId, existing.lastError || 'gave up after 5 attempts');
      this.log('warn', upn, `item marked failed after 5 attempts (${folder.name})`);
      return false;
    }
    const fileId = fileIdFor(itemId);
    const newFile = path.join(dir, fileId + '.eml.gz');
    // Migration: pre-sha1 backups stored files under base64url(itemId). Reuse
    // the legacy file (verified by gunzip) instead of re-downloading.
    if (!fs.existsSync(newFile)) {
      const legacyFile = path.join(dir, encodeId(itemId) + '.eml.gz');
      try {
        if (fs.existsSync(legacyFile)) {
          const raw = await gunzipAsync(await fsp.readFile(legacyFile));
          await fsp.rename(legacyFile, newFile);
          const size = existing?.size || (await fsp.stat(newFile)).size;
          this._addBytes(upn, scope, size);
          this.store.upsertItem({
            upn, scope, folderId: folder.folderId, itemId, fileId,
            subject: existing?.subject ?? null, receivedAt: existing?.receivedAt ?? null,
            size, status: 'done', lastError: null,
            attempts: (existing?.attempts || 0) + 1,
            sha256: crypto.createHash('sha256').update(raw).digest('hex')
          });
          return false;
        }
      } catch { /* legacy file missing or corrupt — fall through and re-download */ }
    }
    try {
      let mime, meta = {};
      if (scope === 'primary') {
        mime = await this.graph.getMessageMime(upn, itemId);
      } else {
        mime = await this.ews.getItemMime(upn, itemId, changeKey);
      }
      if (mime && mime.length) meta = parseMimeHeaders(mime);
      if (!mime) {
        // Item vanished remotely (404) — drop the row instead of retrying forever.
        this.store.deleteItem(upn, scope, folder.folderId, itemId);
        this.log('info', upn, `item vanished remotely (${folder.name}) — removed from index`);
        return false;
      }
      if (!mime.length) throw new Error('empty MIME content');
      const tmp = path.join(dir, fileId + '.tmp');
      await pipeline(Readable.from(mime), zlib.createGzip(), fs.createWriteStream(tmp));
      await fsp.rename(tmp, newFile); // atomic publish
      this._addBytes(upn, scope, mime.length);
      this.store.upsertItem({
        upn, scope, folderId: folder.folderId, itemId, fileId,
        subject: (meta && meta.subject) || null, receivedAt: (meta && meta.receivedAt) || null,
        sender: (meta && meta.sender) || null,
        size: mime.length, status: 'done', lastError: null, attempts: (existing?.attempts || 0) + 1,
        sha256: crypto.createHash('sha256').update(mime).digest('hex')
      });
      return false;
    } catch (e) {
      if (e.aborted) throw e;
      if (e.gone || e.status === 404) {
        this.store.deleteItem(upn, scope, folder.folderId, itemId);
        this.log('info', upn, `item gone remotely (${folder.name}) — removed from index`);
        return false;
      }
      const attempts = (existing?.attempts || 0) + 1;
      if (attempts >= 5) {
        this.store.markItemFailed(upn, scope, folder.folderId, itemId, String(e.message || e).slice(0, 400));
        this.log('warn', upn, `item fetch failed permanently (${folder.name}): ${String(e.message || e).slice(0, 200)}`);
        return false;
      }
      // Never reference a fileId whose file was not actually written.
      this.store.upsertItem({
        upn, scope, folderId: folder.folderId, itemId,
        ...(fs.existsSync(newFile) ? { fileId } : {}),
        status: 'pending', lastError: String(e.message || e).slice(0, 400), attempts
      });
      if (!existing || (existing.attempts || 0) < 2) {
        this.log('warn', upn, `item fetch failed (${folder.name}): ${String(e.message || e).slice(0, 200)}`);
      }
      return true;
    }
  }

  // ---------- Verify ----------
  async runVerify(upn) {
    if (this.running) throw new Error('already running');
    this.running = true; this._stop = false;
    this._beginRun();
    const list = upn
      ? [this.store.getMailbox(upn)].filter(Boolean)
      : this.store.listMailboxes().filter(m => m.status === 'done' || m.status === 'partial');
    const job = this.store.createJob('verify', list.length);
    try {
      let done = 0, okCount = 0;
      for (const m of list) {
        if (this.stopped) break;
        const ok = await this.verifyMailbox(m.upn);
        if (ok) okCount++;
        done++;
        this.progress(job, { done, detail: m.upn });
      }
      this.progress(job, { status: this.stopped ? 'stopped' : 'done', detail: `${okCount}/${done} passed`, finishedAt: new Date().toISOString() });
    } catch (e) {
      if (!e.aborted && !this.stopped) throw e;
      this.progress(job, { status: 'stopped', finishedAt: new Date().toISOString() });
    } finally { this._endRun(); this.running = false; }
  }

  countFilesOnDisk(upn, scope, folderPath) {
    const dir = this.folderDir(upn, scope, folderPath);
    try {
      let n = 0;
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isFile() && e.name.endsWith('.eml.gz')) n++;
      }
      return n;
    } catch { return 0; }
  }

  async verifyMailbox(upn) {
    this.log('info', upn, 'verify started');
    const report = { at: new Date().toISOString(), ok: true, pendingTotal: 0, integrity: { checked: 0, failed: 0 }, folders: [], topErrors: [] };
    try {
      // live counts
      let live = [];
      try { live = live.concat((await this.graph.folderTree(upn)).map(f => ({ ...f, scope: 'primary' }))); }
      catch (e) { this.log('warn', upn, 'verify: live primary folder counts unavailable: ' + e.message); }
      try {
        const arch = await this.ews.folderTree(upn);
        live = live.concat(arch.map(f => ({ ...f, scope: 'archive' })));
      } catch (e) {
        if (/impersonat|permission|denied/i.test(String(e.message))) {
          report.topErrors.push({ n: 1, lastError: 'archive inaccessible (ApplicationImpersonation role assignment missing)' });
        }
      }
      const liveByKey = new Map(live.map(f => [f.scope + '|' + f.folderId, f]));

      const stored = this.store.listFolders(upn);
      const checked = new Set();
      for (const f of stored) {
        checked.add(f.scope + '|' + f.folderId);
        const liveF = liveByKey.get(f.scope + '|' + f.folderId);
        const graph = liveF ? liveF.itemCount : f.itemCount;
        const local = this.store.countDoneItems(upn, f.scope, f.folderId);
        const onDisk = this.countFilesOnDisk(upn, f.scope, (liveF && liveF.path) || f.path || f.name);
        const missing = Math.max(0, graph - local);
        if (missing > 0) {
          report.ok = false;
          // Heal: a saved delta token/syncState means incremental sync will never
          // re-report the missing items. Reset the cursor so the next backup does
          // a full re-scan of this folder and re-fetches everything incomplete.
          if (f.deltaToken || f.syncState) {
            this.store.clearFolderCursor(upn, f.scope, f.folderId);
            this.log('info', upn, `verify: "${f.path || f.name}" missing ${missing} — sync cursor reset, next backup re-scans this folder fully`);
          }
        }
        report.folders.push({ scope: f.scope, name: f.name, path: (liveF && liveF.path) || f.path || f.name, graph, local, missing, onDisk });
      }
      for (const f of live) {
        if (checked.has(f.scope + '|' + f.folderId)) continue;
        report.folders.push({ scope: f.scope, name: f.name, path: f.path || f.name, graph: f.itemCount, local: 0, missing: f.itemCount, onDisk: 0 });
        report.ok = false;
      }
      report.pendingTotal = this.store.pendingTotal(upn);
      report.missingTotal = report.folders.reduce((s, f) => s + f.missing, 0);
      if (report.pendingTotal > 0) report.ok = false;

      // integrity sampling: gunzip random stored items and check the sha256 of
      // the MIME bytes against the value recorded at fetch time (when present).
      const sample = this.store.randomItems(upn, 50);
      for (const it of sample) {
        const folder = stored.find(f => f.scope === it.scope && f.folderId === it.folderId);
        const dir = folder ? this.folderDir(upn, it.scope, folder.path || folder.name) : this.folderDir(upn, it.scope, '');
        let fp = path.join(dir, it.fileId + '.eml.gz');
        if (!fs.existsSync(fp)) {
          // Pre-sha1 files may still sit under the legacy base64url name.
          const legacy = path.join(dir, encodeId(it.itemId) + '.eml.gz');
          if (fs.existsSync(legacy)) { try { await fsp.rename(legacy, fp); } catch { fp = legacy; } }
        }
        let failMsg = null;
        try {
          const raw = await gunzipAsync(await fsp.readFile(fp));
          if (it.sha256 && crypto.createHash('sha256').update(raw).digest('hex') !== it.sha256) {
            failMsg = 'sha256 mismatch';
          }
        } catch (e) { failMsg = e.message; }
        if (failMsg) {
          report.integrity.failed++;
          // Heal: mark the item pending so the next backup re-downloads it
          // instead of reporting the same corrupt file on every verify run.
          this.store.upsertItem({
            upn, scope: it.scope, folderId: it.folderId, itemId: it.itemId,
            subject: it.subject, receivedAt: it.receivedAt, size: it.size, fileId: it.fileId,
            status: 'pending', lastError: 'integrity check failed: ' + String(failMsg).slice(0, 200)
          });
          this.log('warn', upn, `corrupt file: ${it.fileId} (${failMsg}) — marked pending for re-fetch`);
        }
        report.integrity.checked++;
      }
      if (report.integrity.failed > 0) report.ok = false;

      report.topErrors = report.topErrors.concat(this.store.topErrors(upn).map(r => ({ n: r.n, lastError: r.lastError })));
      this.store.patchMailboxFields(upn, { verifyOk: report.ok ? 1 : 0, verifyAt: report.at, verifyReport: JSON.stringify(report) });
      refreshCoverage(this.store, upn, { ieEnabled: !!(this.graphie && this.cfg.graphExchangeExportEnabled) });
      this.log(report.ok ? 'info' : 'warn', upn, report.ok ? 'verify PASSED' : `verify FAILED — ${report.missingTotal} missing vs source, ${report.pendingTotal} pending, see report`);
      return report.ok;
    } catch (e) {
      this.log('error', upn, 'verify error: ' + e.message);
      report.ok = false;
      this.store.patchMailboxFields(upn, { verifyOk: 0, verifyAt: report.at, verifyReport: JSON.stringify(report) });
      return false;
    }
  }
}

module.exports = { Engine, safeName, parseMimeHeaders };
