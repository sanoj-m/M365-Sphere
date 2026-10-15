// Copy email: copy items from the local backup store (primary + archive scopes)
// to a live mailbox folder (EWS CreateItem — Graph MIME import creates drafts
// with the import date) or a local backup folder in any
// mailbox's store. Copy only — the source is never modified. The source folder
// structure is re-created under the destination with merge-by-name semantics,
// and emails already present at the destination are skipped (normalized
// Message-ID, subject+receivedAt key, fuzzy ±2 min/±10% size; toLocal also
// sha256 + row-with-file), so re-running a copy just skips what's there.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');
const { readRaw, itemFile } = require('./preview');
const { parseMimeHeaders } = require('./engine');
const { fuzzyDupes } = require('./dedupe');
const { ftsMime, ftsDate } = require('./fts');

const sha1 = s => crypto.createHash('sha1').update(String(s)).digest('hex');
const normMsgId = s => { const v = String(s || '').replace(/[<>]/g, '').trim().toLowerCase(); return v || null; };
const itemKey = (subject, receivedAt) => String(subject || '').trim().toLowerCase() + '|' + String(receivedAt || '').slice(0, 19);

// In-run retry classification. graph.req/ews.call already retry 429/5xx
// internally (10 attempts), so their exhausted errors get only 2 item-level
// attempts; plain network/fs errors get 3; permanent ones fail at once.
const maxAttempts = e => {
  const m = String((e && e.message) || '');
  if (/not uploadable to live|local file missing|fts stream not reconstructable/i.test(m)) return 1;
  const st = e && e.status;
  if (st && st >= 400 && st < 500 && st !== 429) return 1;
  if (st === 429 || st >= 500 || e.fault || /^(EWS|Graph)\b/i.test(m)) return 2;
  if (/ECONNRESET|ETIMEDOUT|ECONNREFUSED|socket hang up|fetch failed|network|throttl/i.test(m)) return 3;
  return 1;
};
const RETRY_WAITS = [2000, 10000, 30000];

class CopyEmailEngine {
  constructor({ cfg, store, graph, ews, engine, log, bus }) {
    this.cfg = cfg; this.store = store; this.graph = graph; this.ews = ews; this.engine = engine; this.log = log; this.bus = bus;
    this._runs = new Map(); // srcUpn -> { stop, aborter } — one copy-email job per source mailbox
    this.runProgress = new Map(); // srcUpn -> live progress, exposed via /api/status
    this.storeRoot = path.join(cfg.dataDir, 'store');
  }

  get running() { return this._runs.size > 0; }
  isRunning(upn) { return this._runs.has(upn); }
  stop(upn) {
    if (upn) {
      const run = this._runs.get(upn);
      if (!run) return false;
      run.stop = true;
      if (run.aborter) run.aborter.abort();
      return true;
    }
    for (const run of this._runs.values()) { run.stop = true; if (run.aborter) run.aborter.abort(); }
    // A global stop stops EVERYTHING — drop the queue too.
    this.store.copyQueueClear();
    return this._runs.size > 0;
  }
  // Start the oldest queued copy when no run is active (called when a run
  // finishes and on server startup). Synchronous pop → no double-start race.
  pumpQueue() {
    if (this._runs.size) return;
    const next = this.store.copyQueueNext();
    if (!next) return;
    this.store.copyQueueRemove(next.id);
    let cfg = {};
    try { cfg = JSON.parse(next.config || '{}'); } catch { }
    try {
      this.start({
        srcUpn: next.srcUpn, dstUpn: next.dstUpn, target: next.target,
        folderKeys: cfg.folderKeys || [], items: cfg.items || null, dst: cfg.dst,
        srcMode: cfg.srcMode || 'store', srcFolders: cfg.srcFolders || null,
        dstLabel: cfg.dstLabel || null, srcLabel: cfg.srcLabel || null,
        onlyItems: Array.isArray(cfg.failedKeys) && cfg.failedKeys.length ? new Set(cfg.failedKeys) : null,
        retryOf: cfg.retryOf || null
      });
      this.log('info', next.srcUpn, `copy email: started queued job (#${next.id})`);
    } catch (e) {
      this.log('warn', next.srcUpn, `copy email: queued job #${next.id} could not start: ${e.message}`);
      setImmediate(() => this.pumpQueue()); // skip the broken entry, try the next
    }
  }
  _progress(jobId, patch) { this.store.updateJob(jobId, patch); this.bus.emit('progress', patch); }

  start({ srcUpn, dstUpn, target, folderKeys = [], dst, items: itemKeys = null, onlyItems = null, retryOf = null, srcMode = 'store', srcFolders: liveSrcRows = null, dstLabel: clientLabel = null, srcLabel: clientSrcLabel = null }) {
    dstUpn = dstUpn || srcUpn;
    if (this._runs.has(srcUpn)) throw new Error('a copy-email job is already running for this mailbox');
    const live = srcMode === 'live';
    // Folder universe: local-store rows keyed '<scope>:<folderId>', or the
    // client-supplied live tree rows ({id,parentId,name,path}) keyed 'live:<id>'.
    const srcFolderRows = live ? (liveSrcRows || []) : this.store.listFolders(srcUpn);
    const rows = live
      ? srcFolderRows.map(f => ({ scope: 'live', folderId: f.id, parentId: f.parentId || null, name: f.name, path: f.path }))
      : srcFolderRows;
    const byKey = new Map(rows.map(f => [f.scope + ':' + f.folderId, f]));
    // Item-level picks: flat copy into the chosen destination folder/root — no
    // folder-structure recreation. Store keys 'scope:folderId:itemId', live keys
    // 'live:folderId:msgId' — the implied folders scope the item query.
    const flat = Array.isArray(itemKeys) && itemKeys.length > 0;
    const pickSet = flat ? new Set(itemKeys) : null;
    if (flat) {
      const implied = new Set();
      for (const k of itemKeys) {
        const i1 = k.indexOf(':'); const i2 = i1 < 0 ? -1 : k.indexOf(':', i1 + 1);
        if (i2 > 0) implied.add(k.slice(0, i2));
      }
      folderKeys = [...implied];
    }
    // Exact selection: copy exactly the folders in folderKeys (independent
    // checkbox semantics — children are NOT auto-included).
    const selected = new Map(); // folder key -> folder row
    for (const key of folderKeys) {
      const root = byKey.get(key);
      if (root) selected.set(key, root);
    }
    if (!selected.size) throw new Error(live ? 'no selected folders in the supplied live tree' : 'no selected folders found in the local store');
    const dstLabel = (typeof clientLabel === 'string' && clientLabel.trim() ? clientLabel.trim().slice(0, 160) : null)
      || (target === 'live'
        ? (dst.folderId ? String(dst.folderId) : 'mailbox root')
        : (dst.folderId ? (this.store.getFolder(dstUpn, dst.scope, dst.folderId) || {}).path || String(dst.folderId) : String(dst.name)));
    const run = { stop: false, aborter: new AbortController() };
    this._runs.set(srcUpn, run);
    const sig = run.aborter.signal; // per-job abort channel — never touch graph.signal
    const kick = { selected, byKey, rows, flat, itemKeys, retryOf, srcUpn, dstUpn, target, dst, dstLabel, srcLabel: clientSrcLabel || null, run, sig, live };

    if (!live) {
      let items = this.store.copyableItems(srcUpn, [...selected.keys()]);
      if (pickSet) items = items.filter(it => pickSet.has(it.scope + ':' + it.folderId + ':' + it.itemId));
      // Retry runs: restrict to the failed items recorded on the original job.
      if (onlyItems) items = items.filter(it => onlyItems.has(it.scope + ':' + it.folderId + ':' + it.itemId));
      if (!items.length) {
        this._runs.delete(srcUpn);
        throw new Error(onlyItems ? 'the recorded failed items no longer exist in the local store' : flat ? 'the picked emails no longer exist in the local store' : 'no downloaded items match the selection');
      }
      const jobId = this.store.createJob('copy-email', items.length, srcUpn);
      this._exec({ ...kick, jobId, items });
      return { jobId, total: items.length };
    }

    // Live source: list each selected folder's messages first (needed for the
    // job total + bytesTotal), then run the shared copy loop. The job row only
    // exists once listing succeeded — start() returns jobId:null in this mode.
    (async () => {
      try {
        let items = [];
        for (const f of selected.values()) {
          if (run.stop) break;
          for (const m of await this.graph.listMessageKeys(srcUpn, f.folderId, sig)) {
            items.push({
              scope: 'live', folderId: f.folderId, itemId: m.id,
              subject: m.subject != null ? m.subject : null,
              receivedAt: m.receivedDateTime || null,
              internetMessageId: m.internetMessageId || null,
              size: m.size || 0
            });
          }
        }
        if (pickSet) items = items.filter(it => pickSet.has(it.scope + ':' + it.folderId + ':' + it.itemId));
        if (onlyItems) items = items.filter(it => onlyItems.has(it.scope + ':' + it.folderId + ':' + it.itemId));
        if (!items.length) throw new Error(onlyItems ? 'the recorded failed items no longer exist in the live mailbox' : flat ? 'the picked emails no longer exist in the live mailbox' : 'the selected live folders have no messages');
        const jobId = this.store.createJob('copy-email', items.length, srcUpn);
        this._exec({ ...kick, jobId, items });
      } catch (e) {
        this.log('error', srcUpn, 'copy email (live source): ' + e.message);
        this._runs.delete(srcUpn);
        this.runProgress.delete(srcUpn);
        this.pumpQueue();
      }
    })();
    return { jobId: null, total: null };
  }

  // Shared copy loop for both source modes. Everything destination-side
  // (structure recreation, skip sets, retry, queue) is identical; only the
  // source item read differs (store file vs Graph MIME fetch).
  _exec({ jobId, items, selected, byKey, rows, flat, itemKeys, retryOf, srcUpn, dstUpn, target, dst, dstLabel, srcLabel, run, sig, live }) {
    const bytesTotal = items.reduce((a, it) => a + (it.size || 0), 0);
    let bytesCopied = 0; // actual mime bytes of items that finished as 'done'
    const failedKeys = []; // 'scope:folderId:itemId' of failed items — capped, drives the retry endpoint
    const detail = extra => JSON.stringify({
      srcUpn, dstUpn, target, srcMode: live ? 'live' : 'store',
      ...(live ? { srcFolders: rows.map(f => ({ id: f.folderId, parentId: f.parentId, name: f.name, path: f.path })) } : {}),
      folderKeys: [...selected.keys()], ...(flat ? { items: itemKeys } : {}), dst, dstLabel,
      ...(srcLabel ? { srcLabel } : {}),
      bytesTotal, bytesCopied, ...(retryOf ? { retryOf } : {}), failedKeys, ...extra
    });
    this._progress(jobId, { detail: detail({ done: 0, skipped: 0, failed: 0, errors: [] }) });
    this.log('info', srcUpn, `copy email${live ? ' (live source)' : ''} → ${target === 'live' ? 'live ' : 'local '}${dstUpn} "${dstLabel}": ${items.length}${flat ? ' picked' : ''} item(s) across ${selected.size} folder(s)`);
    (async () => {
      let done = 0, skipped = 0, failed = 0, foldersDone = 0;
      const errors = [];
      const prog = { upn: srcUpn, dstUpn, target, srcMode: live ? 'live' : 'store', dstLabel, currentDest: '', bytesTotal, bytesDone: 0, foldersTotal: selected.size, foldersDone: 0, itemsTotal: items.length, itemsDone: 0, currentFolder: '', done, skipped, failed };
      this.runProgress.set(srcUpn, prog);
      const syncProg = () => Object.assign(prog, { foldersDone, itemsDone: done + skipped + failed, done, skipped, failed, bytesDone: bytesCopied });
      const srcFolderMap = new Map(rows.map(f => [f.folderId, f]));
      try {
        // Destination root.
        let liveRootId = null, localRoot = null; // localRoot: { folderId, path }
        if (target === 'live') {
          // null folderId = mailbox root; Graph accepts the well-known id
          // 'msgfolderroot' as the parent for the ensureChildFolderEx walk.
          liveRootId = dst.folderId || 'msgfolderroot';
        } else if (dst.folderId) {
          const row = this.store.getFolder(dstUpn, dst.scope, dst.folderId);
          if (!row) throw new Error('destination folder not found in the local store');
          localRoot = { folderId: row.folderId, path: row.path };
        } else {
          const rootPath = String(dst.name).trim();
          const rootId = 'cpy' + sha1(`${dstUpn}|${dst.scope}|${rootPath}`);
          this.store.upsertFolder({ upn: dstUpn, scope: dst.scope, folderId: rootId, parentId: null, name: rootPath, path: rootPath, itemCount: 0, deltaToken: undefined, syncState: undefined });
          localRoot = { folderId: rootId, path: rootPath };
        }
        const dstFolderRows = target === 'local' ? this.store.listFolders(dstUpn).filter(f => f.scope === dst.scope) : [];
        const dstByPath = new Map(dstFolderRows.map(f => [f.path, f]));
        const dstFolderMap = new Map(dstFolderRows.map(f => [f.folderId, f]));
        const liveDestIds = new Map(); // relPath -> live folder id
        const ewsFolderIds = new Map(); // live REST folder id -> EWS id (per-run cache)
        const toEwsFolderId = async restId => {
          if (!ewsFolderIds.has(restId)) {
            const conv = await this.ews.convertRestIds(dstUpn, [restId], this.graph, sig);
            const id = conv.get(restId);
            if (!id) throw new Error('destination folder id conversion failed');
            ewsFolderIds.set(restId, id);
          }
          return ewsFolderIds.get(restId);
        };
        // Items grouped per source folder, shallowest folders first so parents
        // are created before their children.
        const foldersSorted = [...selected.values()].sort((a, b) => String(a.path).split('/').length - String(b.path).split('/').length);
        const itemsByFolder = new Map(); // scope:folderId -> item rows
        for (const it of items) {
          const k = it.scope + ':' + it.folderId;
          if (!itemsByFolder.has(k)) itemsByFolder.set(k, []);
          itemsByFolder.get(k).push(it);
        }
        for (const f of foldersSorted) {
          if (run.stop) break;
          prog.currentFolder = f.path || f.name;
          // Path relative to the topmost selected ancestor's parent, so the
          // topmost picked folder becomes the first segment under the destination.
          let top = f;
          for (let cur = byKey.get(f.scope + ':' + f.parentId); cur && selected.has(cur.scope + ':' + cur.folderId); cur = byKey.get(cur.scope + ':' + cur.parentId)) top = cur;
          const base = top.path.slice(0, top.path.length - top.name.length).replace(/\/$/, '');
          const rel = flat ? '' : f.path.slice(base ? base.length + 1 : 0); // flat item picks: straight into the destination folder/root
          try {
            let destFolderId, destPath;
            if (target === 'live') {
              if (liveDestIds.has(rel)) { destFolderId = liveDestIds.get(rel); }
              else {
                let parent = liveRootId, segs = rel.split('/').filter(Boolean), walk = [];
                for (const seg of segs) {
                  walk.push(seg);
                  const wk = walk.join('/');
                  if (!liveDestIds.has(wk)) {
                    const ensured = await this.graph.ensureChildFolderEx(dstUpn, parent, seg, sig);
                    liveDestIds.set(wk, ensured.id);
                  }
                  parent = liveDestIds.get(wk);
                }
                destFolderId = parent;
                liveDestIds.set(rel, destFolderId);
              }
            } else {
              const full = localRoot.path ? localRoot.path + '/' + rel : rel;
              const hit = dstByPath.get(full);
              if (hit) { destFolderId = hit.folderId; destPath = hit.path; }
              else {
                // Merge-by-path: create each missing segment under the local root.
                let parentId = localRoot.folderId, curPath = localRoot.path;
                for (const seg of rel.split('/').filter(Boolean)) {
                  curPath = curPath ? curPath + '/' + seg : seg;
                  const ex = dstByPath.get(curPath);
                  if (ex) { parentId = ex.folderId; continue; }
                  const fid = 'cpy' + sha1(`${dstUpn}|${dst.scope}|${curPath}`);
                  this.store.upsertFolder({ upn: dstUpn, scope: dst.scope, folderId: fid, parentId, name: seg, path: curPath, itemCount: 0, deltaToken: undefined, syncState: undefined });
                  const row = { upn: dstUpn, scope: dst.scope, folderId: fid, parentId, name: seg, path: curPath };
                  dstByPath.set(curPath, row);
                  dstFolderMap.set(fid, row);
                  parentId = fid;
                }
                destFolderId = parentId; destPath = curPath;
              }
            }
            prog.currentDest = target === 'live' ? rel : destPath;
            // Per-folder destination skip sets.
            const destMsgIds = new Set(), destKeys = new Set(), destSha = new Set(), destFuzzy = fuzzyDupes();
            let dir = null, destFolderRow = null;
            if (target === 'live') {
              for (const m of await this.graph.listMessages(dstUpn, destFolderId, sig)) {
                const mid = normMsgId(m.internetMessageId);
                if (mid) destMsgIds.add(mid);
                destKeys.add(itemKey(m.subject, m.receivedAt));
                destFuzzy.add(m.subject, m.receivedAt, null);
              }
            } else {
              destFolderRow = dstByPath.get(destPath);
              dir = this.engine.folderDir(dstUpn, dst.scope, destPath);
              await fsp.mkdir(dir, { recursive: true });
              for (const row of this.store.listItemsAll(dstUpn, dst.scope, destFolderId)) {
                if (row.sha256) destSha.add(row.sha256);
                destKeys.add(itemKey(row.subject, row.receivedAt));
                destFuzzy.add(row.subject, row.receivedAt, row.size);
              }
            }
            for (const it of itemsByFolder.get(f.scope + ':' + f.folderId) || []) {
              if (run.stop) break;
              try {
                // Source read: store file (with FTS reconstruction) or live
                // Graph MIME fetch. Both produce { mime, subject, receivedAt,
                // msgId, sender } — everything below is mode-agnostic.
                let mime, subject, receivedAt, msgId, sender = null;
                if (live) {
                  mime = await this.graph.getMessageMime(srcUpn, it.itemId, sig);
                  if (!mime) throw new Error('message not found on server');
                  const hdr0 = parseMimeHeaders(mime);
                  subject = it.subject != null ? it.subject : hdr0.subject;
                  receivedAt = it.receivedAt || hdr0.receivedAt;
                  msgId = normMsgId(it.internetMessageId) || hdr0.messageId;
                  sender = hdr0.sender;
                } else {
                  const raw = await readRaw(this.storeRoot, srcUpn, it.scope, f, it.fileId, srcFolderMap);
                  if (!raw) throw new Error('local file missing');
                  // FTS streams (Graph import/export archive items) aren't MIME —
                  // reconstruct RFC822 from the stream's properties/attachments.
                  mime = it.format === 'fts' ? ftsMime(raw) : raw;
                  if (!mime) throw new Error('fts stream not reconstructable');
                  const hdr = parseMimeHeaders(mime);
                  subject = hdr.subject != null ? hdr.subject : it.subject;
                  receivedAt = hdr.receivedAt || it.receivedAt
                    || (it.format === 'fts' ? ftsDate(raw) : null);
                  msgId = hdr.messageId;
                  sender = hdr.sender;
                }
                const key = itemKey(subject, receivedAt);
                if ((msgId && destMsgIds.has(msgId)) || destKeys.has(key)
                  || destFuzzy.has(subject, receivedAt, it.size)) { skipped++; syncProg(); continue; }
                // The actual copy, wrapped in an item-level retry (transient
                // errors only — see maxAttempts). Returns 'done' or 'skipped'.
                const doCopy = async () => {
                  if (target === 'live') {
                    // EWS CreateItem (not Graph MIME import): Graph always creates
                    // a draft stamped with the import time and cannot be fixed via
                    // PATCH; EWS honors MAPI flags/dates on save. Success = verified.
                    const ewsId = await this.ews.uploadMessage(dstUpn, await toEwsFolderId(destFolderId), mime, receivedAt, sig);
                    if (!ewsId) throw new Error('upload failed');
                    return 'done';
                  }
                  const sha256 = crypto.createHash('sha256').update(mime).digest('hex');
                  if (destSha.has(sha256)) return 'skipped';
                  // Live-sourced items keep their live id (compare toLocal
                  // convention: itemId = liveId, fileId = sha1(liveId)).
                  const itemId = live ? it.itemId : 'cpy-' + sha1(msgId || (subject + '|' + receivedAt) || it.itemId);
                  const existing = this.store.getItem(dstUpn, dst.scope, destFolderId, itemId);
                  if (existing && existing.status === 'done' && existing.fileId
                    && itemFile(this.storeRoot, dstUpn, dst.scope, destFolderRow, existing.fileId, dstFolderMap)) {
                    destSha.add(sha256);
                    return 'skipped';
                  }
                  const fileId = live ? sha1(String(it.itemId)) : sha1('cpy' + itemId);
                  const tmp = path.join(dir, fileId + '.tmp-' + crypto.randomUUID());
                  await pipeline(Readable.from(mime), zlib.createGzip(), fs.createWriteStream(tmp));
                  await fsp.rename(tmp, path.join(dir, fileId + '.eml.gz'));
                  this.store.upsertItem({
                    upn: dstUpn, scope: dst.scope, folderId: destFolderId, itemId, fileId,
                    subject, receivedAt, sender,
                    size: mime.length, status: 'done', attempts: 0,
                    sha256
                  });
                  destSha.add(sha256);
                  return 'done';
                };
                let result = null;
                for (let attempt = 0; ;) {
                  try { result = await doCopy(); break; }
                  catch (e) {
                    if (e.aborted || e.name === 'AbortError' || run.stop) throw e;
                    if (attempt >= maxAttempts(e) - 1) throw e;
                    await new Promise(r => setTimeout(r, RETRY_WAITS[Math.min(attempt, RETRY_WAITS.length - 1)] + Math.random() * 1000));
                    attempt++;
                    if (run.stop) { const err = new Error('operation aborted'); err.name = 'AbortError'; err.aborted = true; throw err; }
                  }
                }
                if (result === 'skipped') {
                  if (msgId) destMsgIds.add(msgId);
                  destKeys.add(key);
                  skipped++; syncProg(); continue;
                }
                if (msgId) destMsgIds.add(msgId);
                destKeys.add(key);
                destFuzzy.add(subject, receivedAt, it.size);
                done++; bytesCopied += mime.length; syncProg();
              } catch (e) {
                if (e.aborted || (e.name === 'AbortError')) throw e;
                failed++;
                if (failedKeys.length < 5000) failedKeys.push(it.scope + ':' + it.folderId + ':' + it.itemId);
                if (errors.length < 10) errors.push(String(e.message || e).slice(0, 300));
                this.log('warn', srcUpn, `copy email failed (${f.path}: ${it.subject || it.itemId}): ${String(e.message || e).slice(0, 200)}`);
                syncProg();
              }
              this._progress(jobId, { done: done + skipped + failed, detail: detail({ done, skipped, failed, errors }) });
            }
          } catch (e) {
            if (e.aborted || e.name === 'AbortError') throw e;
            const folderItems = itemsByFolder.get(f.scope + ':' + f.folderId) || [];
            failed += folderItems.length;
            for (const it of folderItems) if (failedKeys.length < 5000) failedKeys.push(it.scope + ':' + it.folderId + ':' + it.itemId);
            if (errors.length < 10) errors.push(String(e.message || e).slice(0, 300));
            this.log('warn', srcUpn, `copy email: destination for "${f.path}" not resolved: ${String(e.message || e).slice(0, 200)}`);
          }
          foldersDone++; syncProg();
        }
        if (target === 'local') this.store.recomputeMailboxBytes(dstUpn);
        const status = run.stop ? 'stopped' : 'done';
        this._progress(jobId, { status, done: done + skipped + failed, detail: detail({ done, skipped, failed, errors }), finishedAt: new Date().toISOString() });
        this.log(failed ? 'warn' : 'info', srcUpn, `copy email ${srcUpn} → ${dstUpn} ${status}: ${done} copied, ${skipped} skipped (already there), ${failed} failed`);
      } catch (e) {
        if (e.aborted || e.name === 'AbortError' || run.stop) {
          this._progress(jobId, { status: 'stopped', done: done + skipped + failed, detail: detail({ done, skipped, failed, errors }), finishedAt: new Date().toISOString() });
        } else {
          this._progress(jobId, { status: 'error', done: done + skipped + failed, detail: detail({ done, skipped, failed, errors: errors.concat(String(e.message || e).slice(0, 300)).slice(0, 10) }), finishedAt: new Date().toISOString() });
          this.log('error', srcUpn, 'copy email failed: ' + e.message);
        }
      } finally {
        this._runs.delete(srcUpn);
        this.runProgress.delete(srcUpn);
        this.pumpQueue(); // run the next queued copy, if any
      }
    })();
    return { jobId, total: items.length };
  }
}

module.exports = { CopyEmailEngine };
