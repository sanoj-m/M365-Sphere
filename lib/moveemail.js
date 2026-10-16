// Move email: like copy-email, but with MOVE semantics — the destination copy
// is uploaded & verified BEFORE the source is removed, so a move never loses
// email. Local sources are retired to the store graveyard (_graveyard/<upn>/)
// and their DB row deleted (same convention as the compare toLive move); live
// sources are moved to Deleted Items (recoverable server-side). A source is
// also removed when the item already sits at the destination — but only on a
// real verified match (Message-ID / subject+receivedAt key live-side, sha256 /
// row-with-file local-side), never on a fuzzy-only guess. If source removal
// fails after a successful copy, the item still counts as done (a leftover
// duplicate is safe; data loss is not).
//
// srcType 'local': source folders/items from the backup store (same selection
// model as copy-email, keys 'scope:folderId').
// srcType 'live':  source folders are LIVE folders of srcUpn, keys
// 'live:<folderId>'; target must be 'live'. Same-mailbox moves use Graph
// /move (atomic, server-side); cross-mailbox moves download the MIME, upload
// via EWS CreateItem, then move the source to Deleted Items.
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
const { ftsMime } = require('./fts');
const { safeName } = require('./util');

const sha1 = s => crypto.createHash('sha1').update(String(s)).digest('hex');
const normMsgId = s => { const v = String(s || '').replace(/[<>]/g, '').trim().toLowerCase(); return v || null; };
const itemKey = (subject, receivedAt) => String(subject || '').trim().toLowerCase() + '|' + String(receivedAt || '').slice(0, 19);

// Same in-run retry classification as copy-email (see lib/copyemail.js).
const maxAttempts = e => {
  const m = String((e && e.message) || '');
  if (/not uploadable to live|local file missing|fts stream not reconstructable|message not found/i.test(m)) return 1;
  const st = e && e.status;
  if (st && st >= 400 && st < 500 && st !== 429) return 1;
  if (st === 429 || st >= 500 || e.fault || /^(EWS|Graph)\b/i.test(m)) return 2;
  if (/ECONNRESET|ETIMEDOUT|ECONNREFUSED|socket hang up|fetch failed|network|throttl/i.test(m)) return 3;
  return 1;
};
const RETRY_WAITS = [2000, 10000, 30000];

class MoveEmailEngine {
  constructor({ cfg, store, graph, ews, engine, log, bus }) {
    this.cfg = cfg; this.store = store; this.graph = graph; this.ews = ews; this.engine = engine; this.log = log; this.bus = bus;
    this._runs = new Map(); // srcUpn -> { stop, aborter } — one move-email job per source mailbox
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
    return this._runs.size > 0;
  }
  _progress(jobId, patch) { this.store.updateJob(jobId, patch); this.bus.emit('progress', patch); }

  // Undo plan recording: buffered rows flushed in one transaction every 200 or
  // every 5 s, whichever comes first — a crash must not lose hundreds of rows.
  // Plan write failures must never break the move itself.
  _planRecorder(planJobId, base) {
    const buf = [];
    let timer = null;
    const flush = () => {
      if (!buf.length) return;
      const rows = buf.splice(0, buf.length);
      try { this.store.moveEmailPlanInsert(rows); }
      catch (e) { this.log('warn', base.srcUpn, 'move email undo-plan write failed: ' + e.message); }
    };
    const arm = () => {
      if (timer) return;
      timer = setTimeout(() => { timer = null; flush(); }, 5000);
      if (timer.unref) timer.unref();
    };
    return {
      add(r) {
        buf.push({ jobId: planJobId, ...base, ...r, createdAt: new Date().toISOString() });
        if (buf.length >= 200) flush(); else arm();
      },
      flush() { if (timer) { clearTimeout(timer); timer = null; } flush(); }
    };
  }

  // Graveyard-retire a moved local source file + delete its DB row (compare
  // toLive move convention). Failures are logged by the caller, never fatal.
  async _retireLocal(upn, scope, folderRow, item, folderMap) {
    const fp = itemFile(this.storeRoot, upn, scope, folderRow, item.fileId, folderMap);
    if (fp) {
      const gdir = path.join(this.storeRoot, '_graveyard', safeName(upn));
      await fsp.mkdir(gdir, { recursive: true });
      await fsp.rename(fp, path.join(gdir, item.fileId + '.eml.gz'));
    }
    this.store.deleteItem(upn, scope, item.folderId, item.itemId);
  }

  start({ srcUpn, srcType, dstUpn, target, folderKeys, dst, onlyItems = null, retryOf = null, force = false, fullPath = false }) {
    dstUpn = dstUpn || srcUpn;
    if (this._runs.has(srcUpn)) throw new Error('a move-email job is already running for this mailbox');
    return srcType === 'live'
      ? this._startLive({ srcUpn, dstUpn, folderKeys, dst, onlyItems, retryOf, force, fullPath })
      : this._startLocal({ srcUpn, dstUpn, target, folderKeys, dst, onlyItems, retryOf, force });
  }

  // ---------- local backup source (copy-email flow + retire after verified) ----------
  _startLocal({ srcUpn, dstUpn, target, folderKeys, dst, onlyItems, retryOf, force = false }) {
    const srcFolders = this.store.listFolders(srcUpn);
    const byKey = new Map(srcFolders.map(f => [f.scope + ':' + f.folderId, f]));
    const selected = new Map(); // scope:folderId -> folder row (picked + descendants)
    for (const key of folderKeys) {
      const root = byKey.get(key);
      if (!root) continue;
      for (const f of srcFolders) {
        if (f.scope !== root.scope) continue;
        for (let cur = f; cur; cur = byKey.get(cur.scope + ':' + cur.parentId)) {
          if (cur.folderId === root.folderId && cur.scope === root.scope) { selected.set(f.scope + ':' + f.folderId, f); break; }
        }
      }
    }
    if (!selected.size) throw new Error('no selected folders found in the local store');
    let items = this.store.copyableItems(srcUpn, [...selected.keys()]);
    if (onlyItems) items = items.filter(it => onlyItems.has(it.scope + ':' + it.folderId + ':' + it.itemId));
    if (!items.length) throw new Error(onlyItems ? 'the recorded failed items no longer exist in the local store' : 'no downloaded items match the selection');
    const run = { stop: false, aborter: new AbortController() };
    this._runs.set(srcUpn, run);
    const sig = run.aborter.signal;
    const jobId = this.store.createJob('move-email', items.length, srcUpn);
    // Retry runs append to the ORIGINAL job's plan so undo covers the whole
    // logical operation.
    const plan = this._planRecorder(retryOf || jobId, { srcUpn, srcType: 'local', dstUpn, target });
    const bytesTotal = items.reduce((a, it) => a + (it.size || 0), 0);
    let bytesCopied = 0;
    const dstLabel = target === 'live'
      ? (dst.folderId ? String(dst.folderId) : 'mailbox root')
      : (dst.folderId ? (this.store.getFolder(dstUpn, dst.scope, dst.folderId) || {}).path || String(dst.folderId) : String(dst.name));
    const failedKeys = [];
    const detail = extra => JSON.stringify({ srcUpn, srcType: 'local', dstUpn, target, folderKeys, dst, dstLabel, bytesTotal, bytesCopied, ...(retryOf ? { retryOf } : {}), failedKeys, ...extra });
    this._progress(jobId, { detail: detail({ done: 0, skipped: 0, failed: 0, errors: [] }) });
    this.log('info', srcUpn, `move email → ${target === 'live' ? 'live ' : 'local '}${dstUpn} "${dstLabel}": ${items.length} item(s) across ${selected.size} folder(s)`);
    (async () => {
      let done = 0, skipped = 0, failed = 0, foldersDone = 0;
      const errors = [];
      const prog = { upn: srcUpn, srcType: 'local', dstUpn, target, dstLabel, currentDest: '', bytesTotal, bytesDone: 0, foldersTotal: selected.size, foldersDone: 0, itemsTotal: items.length, itemsDone: 0, currentFolder: '', done, skipped, failed };
      this.runProgress.set(srcUpn, prog);
      const syncProg = () => Object.assign(prog, { foldersDone, itemsDone: done + skipped + failed, done, skipped, failed, bytesDone: bytesCopied });
      const srcFolderMap = new Map(srcFolders.map(f => [f.folderId, f]));
      try {
        let liveRootId = null, localRoot = null;
        if (target === 'live') {
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
        const liveDestIds = new Map();
        const ewsFolderIds = new Map();
        const toEwsFolderId = async restId => {
          if (!ewsFolderIds.has(restId)) {
            const conv = await this.ews.convertRestIds(dstUpn, [restId], this.graph, sig);
            const id = conv.get(restId);
            if (!id) throw new Error('destination folder id conversion failed');
            ewsFolderIds.set(restId, id);
          }
          return ewsFolderIds.get(restId);
        };
        const foldersSorted = [...selected.values()].sort((a, b) => String(a.path).split('/').length - String(b.path).split('/').length);
        const itemsByFolder = new Map();
        for (const it of items) {
          const k = it.scope + ':' + it.folderId;
          if (!itemsByFolder.has(k)) itemsByFolder.set(k, []);
          itemsByFolder.get(k).push(it);
        }
        for (const f of foldersSorted) {
          if (run.stop) break;
          prog.currentFolder = f.path || f.name;
          let top = f;
          for (let cur = byKey.get(f.scope + ':' + f.parentId); cur && selected.has(cur.scope + ':' + cur.folderId); cur = byKey.get(cur.scope + ':' + cur.parentId)) top = cur;
          const base = top.path.slice(0, top.path.length - top.name.length).replace(/\/$/, '');
          const rel = f.path.slice(base ? base.length + 1 : 0);
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
            // Remove the local source after the destination holds the item.
            // retireReason: 'moved' (fresh upload) or 'already there' (verified
            // skip) — a failure here never fails the item. ARCHIVE-scope
            // sources are never retired: archive moves behave as copies so the
            // local archive backup always stays intact.
            const retireLocal = async (it, reason, dstRef = {}) => {
              if (it.scope === 'archive') {
                this.log('info', srcUpn, `move email: ${reason === 'moved' ? 'copied (archive source kept)' : 'already there — archive source kept'} (${f.path}: ${it.subject || it.itemId})`);
                return;
              }
              try {
                await this._retireLocal(srcUpn, it.scope, f, it, srcFolderMap);
                plan.add({
                  itemKey: it.scope + ':' + it.folderId + ':' + it.itemId,
                  srcFolderId: it.folderId, srcFolderPath: f.path,
                  srcLiveId: null, dstFolderId: destFolderId, dstLiveId: dstRef.liveId || null,
                  action: reason === 'moved' ? 'moved' : 'retired-verified-skip',
                  fileId: it.fileId,
                  itemRow: JSON.stringify({ row: it, dstScope: dst.scope || null, dstItemId: dstRef.itemId || null, msgId: dstRef.msgId || null })
                });
                this.log('info', srcUpn, `move email: ${reason === 'moved' ? 'moved' : 'already there — source retired'} (${f.path}: ${it.subject || it.itemId})`);
              } catch (e) {
                this.log('warn', srcUpn, `moved but source retire failed for ${it.fileId}: ${e.message}`);
              }
            };
            for (const it of itemsByFolder.get(f.scope + ':' + f.folderId) || []) {
              if (run.stop) break;
              try {
                const raw = await readRaw(this.storeRoot, srcUpn, it.scope, f, it.fileId, srcFolderMap);
                if (!raw) throw new Error('local file missing');
                const mime = it.format === 'fts' ? ftsMime(raw) : raw;
                if (!mime) throw new Error('fts stream not reconstructable');
                const hdr = parseMimeHeaders(mime);
                const subject = hdr.subject != null ? hdr.subject : it.subject;
                const receivedAt = hdr.receivedAt || it.receivedAt;
                const msgId = hdr.messageId;
                const key = itemKey(subject, receivedAt);
                const verifiedPresent = (msgId && destMsgIds.has(msgId)) || destKeys.has(key);
                if (verifiedPresent || (!force && destFuzzy.has(subject, receivedAt, it.size))) {
                  skipped++; syncProg();
                  // Verified destination match = the move's intent is satisfied;
                  // retire the source too. Fuzzy-only skips keep the source.
                  if (verifiedPresent) await retireLocal(it, 'already', { msgId });
                  continue;
                }
                const dstRef = { liveId: null, itemId: null, msgId };
                const doCopy = async () => {
                  if (target === 'live') {
                    const ewsId = await this.ews.uploadMessage(dstUpn, await toEwsFolderId(destFolderId), mime, receivedAt, sig);
                    if (!ewsId) throw new Error('upload failed');
                    dstRef.liveId = ewsId; // EWS id — undo moves it aside via EWS
                    return 'done';
                  }
                  const sha256 = crypto.createHash('sha256').update(mime).digest('hex');
                  if (destSha.has(sha256)) return 'skipped';
                  const itemId = 'cpy-' + sha1(msgId || (subject + '|' + receivedAt) || it.itemId);
                  dstRef.itemId = itemId;
                  const existing = this.store.getItem(dstUpn, dst.scope, destFolderId, itemId);
                  if (existing && existing.status === 'done' && existing.fileId
                    && itemFile(this.storeRoot, dstUpn, dst.scope, destFolderRow, existing.fileId, dstFolderMap)) {
                    destSha.add(sha256);
                    return 'skipped';
                  }
                  const fileId = sha1('cpy' + itemId);
                  const tmp = path.join(dir, fileId + '.tmp-' + crypto.randomUUID());
                  await pipeline(Readable.from(mime), zlib.createGzip(), fs.createWriteStream(tmp));
                  await fsp.rename(tmp, path.join(dir, fileId + '.eml.gz'));
                  this.store.upsertItem({
                    upn: dstUpn, scope: dst.scope, folderId: destFolderId, itemId, fileId,
                    subject, receivedAt, sender: hdr.sender,
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
                  skipped++; syncProg();
                  await retireLocal(it, 'already', dstRef); // sha256/row-with-file verified match
                  continue;
                }
                // Batch-local keys are deliberately NOT added to destKeys: a
                // subject+receivedAt match against an item uploaded earlier in
                // this run is not content-proof (PST-imported mail often shares
                // key fields) — such items fall through to the fuzzy branch
                // (source kept) instead of being retired without a real copy.
                if (msgId) destMsgIds.add(msgId);
                destFuzzy.add(subject, receivedAt, it.size);
                done++; bytesCopied += mime.length; syncProg();
                await retireLocal(it, 'moved', dstRef);
              } catch (e) {
                if (e.aborted || (e.name === 'AbortError')) throw e;
                failed++;
                if (failedKeys.length < 5000) failedKeys.push(it.scope + ':' + it.folderId + ':' + it.itemId);
                if (errors.length < 10) errors.push(String(e.message || e).slice(0, 300));
                this.log('warn', srcUpn, `move email failed (${f.path}: ${it.subject || it.itemId}): ${String(e.message || e).slice(0, 200)}`);
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
            this.log('warn', srcUpn, `move email: destination for "${f.path}" not resolved: ${String(e.message || e).slice(0, 200)}`);
          }
          foldersDone++; syncProg();
        }
        if (target === 'local') this.store.recomputeMailboxBytes(dstUpn);
        this.store.recomputeMailboxBytes(srcUpn); // sources retired
        plan.flush();
        const status = run.stop ? 'stopped' : 'done';
        this._progress(jobId, { status, done: done + skipped + failed, detail: detail({ done, skipped, failed, errors }), finishedAt: new Date().toISOString() });
        this.log(failed ? 'warn' : 'info', srcUpn, `move email ${srcUpn} → ${dstUpn} ${status}: ${done} moved, ${skipped} skipped (already there), ${failed} failed`);
      } catch (e) {
        if (e.aborted || e.name === 'AbortError' || run.stop) {
          this._progress(jobId, { status: 'stopped', done: done + skipped + failed, detail: detail({ done, skipped, failed, errors }), finishedAt: new Date().toISOString() });
        } else {
          this._progress(jobId, { status: 'error', done: done + skipped + failed, detail: detail({ done, skipped, failed, errors: errors.concat(String(e.message || e).slice(0, 300)).slice(0, 10) }), finishedAt: new Date().toISOString() });
          this.log('error', srcUpn, 'move email failed: ' + e.message);
        }
      } finally {
        plan.flush();
        this._runs.delete(srcUpn);
        this.runProgress.delete(srcUpn);
      }
    })();
    return { jobId, total: items.length };
  }

  // ---------- live source (live → live only) ----------
  // folderKeys: 'live:<folderId>'. The saved live tree
  // (data/live-folders/<upn>.json, written by /api/live/:upn/folders) provides
  // the folder list; missing → a fresh graph.folderTree walk.
  async _liveFolders(srcUpn) {
    try {
      const rec = JSON.parse(await fsp.readFile(path.join(this.cfg.dataDir, 'live-folders', safeName(srcUpn) + '.json'), 'utf8'));
      if (Array.isArray(rec.folders) && rec.folders.length) return rec.folders;
    } catch { }
    return this.graph.folderTree(srcUpn);
  }

  _startLive({ srcUpn, dstUpn, folderKeys, dst, onlyItems, retryOf, force = false, fullPath = false }) {
    const run = { stop: false, aborter: new AbortController() };
    this._runs.set(srcUpn, run);
    const sig = run.aborter.signal;
    const dstLabel = dst.folderId ? String(dst.folderId) : 'mailbox root';
    const failedKeys = []; // 'live:<folderId>:<messageId>'
    let bytesCopied = 0;
    const detail = extra => JSON.stringify({ srcUpn, srcType: 'live', dstUpn, target: 'live', folderKeys, dst, dstLabel, fullPath, bytesTotal: 0, bytesCopied, ...(retryOf ? { retryOf } : {}), failedKeys, ...extra });
    this.log('info', srcUpn, `move email (live) → live ${dstUpn} "${dstLabel}": ${folderKeys.length} folder(s)`);
    const jobId = this.store.createJob('move-email', 0, srcUpn);
    const plan = this._planRecorder(retryOf || jobId, { srcUpn, srcType: 'live', dstUpn, target: 'live' });
    this._progress(jobId, { detail: detail({ done: 0, skipped: 0, failed: 0, errors: [] }) });
    (async () => {
      let done = 0, skipped = 0, failed = 0, foldersDone = 0;
      const errors = [];
      const prog = { upn: srcUpn, srcType: 'live', dstUpn, target: 'live', dstLabel, currentDest: '', bytesTotal: 0, bytesDone: 0, foldersTotal: 0, foldersDone: 0, itemsTotal: 0, itemsDone: 0, currentFolder: '', done, skipped, failed };
      this.runProgress.set(srcUpn, prog);
      const syncProg = () => Object.assign(prog, { foldersDone, itemsDone: done + skipped + failed, done, skipped, failed, bytesDone: bytesCopied });
      try {
        const all = await this._liveFolders(srcUpn);
        const byId = new Map(all.map(f => [f.folderId, f]));
        // Expand the selection: every picked folder plus all its descendants.
        const picked = new Set(folderKeys.map(k => k.replace(/^live:/, '')));
        const selected = new Map();
        for (const f of all) {
          for (let cur = f; cur; cur = byId.get(cur.parentId)) {
            if (picked.has(cur.folderId)) { selected.set(f.folderId, f); break; }
          }
        }
        if (!selected.size) throw new Error('no selected folders found in the live mailbox (refresh the folder list?)');
        // Total comes from the folders' itemCount (Graph totalItemCount).
        prog.foldersTotal = selected.size;
        prog.itemsTotal = [...selected.values()].reduce((a, f) => a + (f.itemCount || 0), 0);
        this.store.updateJob(jobId, { total: prog.itemsTotal });
        const foldersSorted = [...selected.values()].sort((a, b) => String(a.path).split('/').length - String(b.path).split('/').length);
        const liveDestIds = new Map(); // relPath -> live folder id
        const ewsFolderIds = new Map();
        const toEwsFolderId = async restId => {
          if (!ewsFolderIds.has(restId)) {
            const conv = await this.ews.convertRestIds(dstUpn, [restId], this.graph, sig);
            const id = conv.get(restId);
            if (!id) throw new Error('destination folder id conversion failed');
            ewsFolderIds.set(restId, id);
          }
          return ewsFolderIds.get(restId);
        };
        const sameMailbox = srcUpn.toLowerCase() === dstUpn.toLowerCase();
        const liveRootId = dst.folderId || 'msgfolderroot';
        for (const f of foldersSorted) {
          if (run.stop) break;
          prog.currentFolder = f.path || f.name;
          // Path relative to the topmost selected ancestor's parent —
          // unless fullPath is set (recreate the whole source path from the
          // mailbox root, e.g. when moving into a bare destination root).
          let rel;
          if (fullPath) rel = String(f.path || f.name).replace(/^Mailbox root\//, '');
          else {
            let top = f;
            for (let cur = byId.get(f.parentId); cur && selected.has(cur.folderId); cur = byId.get(cur.parentId)) top = cur;
            const base = String(top.path || '').slice(0, String(top.path).length - String(top.name).length).replace(/\/$/, '');
            rel = String(f.path || f.name).slice(base ? base.length + 1 : 0);
          }
          try {
            let destFolderId;
            if (liveDestIds.has(rel)) destFolderId = liveDestIds.get(rel);
            else {
              let parent = liveRootId, walk = [];
              for (const seg of rel.split('/').filter(Boolean)) {
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
            prog.currentDest = rel;
            const destMsgIds = new Set(), destKeys = new Set(), destFuzzy = fuzzyDupes();
            for (const m of await this.graph.listMessages(dstUpn, destFolderId, sig)) {
              const mid = normMsgId(m.internetMessageId);
              if (mid) destMsgIds.add(mid);
              destKeys.add(itemKey(m.subject, m.receivedAt));
              destFuzzy.add(m.subject, m.receivedAt, null);
            }
            let msgs = await this.graph.listMessages(srcUpn, f.folderId, sig);
            if (onlyItems) msgs = msgs.filter(m => onlyItems.has('live:' + f.folderId + ':' + m.id));
            for (const m of msgs) {
              if (run.stop) break;
              const mid = normMsgId(m.internetMessageId);
              const key = itemKey(m.subject, m.receivedAt);
              try {
                const verifiedPresent = (mid && destMsgIds.has(mid)) || destKeys.has(key);
                // force=true: fuzzy-only look-alikes are uploaded anyway (the
                // user accepts possible true duplicates); verified duplicates
                // still skip the upload and only retire the source.
                if (verifiedPresent || (!force && destFuzzy.has(m.subject, m.receivedAt, null))) {
                  skipped++; syncProg();
                  // Verified destination match = move satisfied; drop the live
                  // source copy (to Deleted Items — recoverable). Fuzzy-only
                  // skips keep the source in place.
                  if (verifiedPresent) {
                    try {
                      const retired = await this.graph.moveToDeletedItems(srcUpn, m.id, sig);
                      plan.add({
                        itemKey: 'live:' + f.folderId + ':' + m.id,
                        srcFolderId: f.folderId, srcFolderPath: f.path,
                        srcLiveId: (retired && retired.id) || m.id, dstFolderId: destFolderId, dstLiveId: null,
                        action: 'retired-verified-skip', fileId: null,
                        itemRow: JSON.stringify({ liveId: m.id, msgId: mid, subject: m.subject, receivedAt: m.receivedAt })
                      });
                      this.log('info', srcUpn, `move email: already there — source retired to Deleted Items (${f.path}: ${m.subject || m.id})`);
                    } catch (e) {
                      this.log('warn', srcUpn, `already at destination but source retire failed for ${m.id}: ${e.message}`);
                    }
                  }
                  continue;
                }
                const dstRef = { dstLiveId: null, srcLiveId: null };
                const doMove = async () => {
                  if (sameMailbox) {
                    // Atomic server-side move — zero loss.
                    if (destFolderId === f.folderId) return 'done'; // already in that folder
                    const moved = await this.graph.moveMessage(srcUpn, m.id, destFolderId, sig);
                    if (!moved) throw new Error('move failed');
                    dstRef.dstLiveId = moved.id || null; // NEW REST id after the move
                    return 'done';
                  }
                  // Cross-mailbox: download → EWS upload (verified) → source to
                  // Deleted Items only AFTER the upload succeeded.
                  const mime = await this.graph.getMessageMime(srcUpn, m.id, sig);
                  if (!mime) throw new Error('message not found on server');
                  const hdr = parseMimeHeaders(mime);
                  const ewsId = await this.ews.uploadMessage(dstUpn, await toEwsFolderId(destFolderId), mime, hdr.receivedAt || m.receivedAt, sig);
                  if (!ewsId) throw new Error('upload failed');
                  bytesCopied += mime.length;
                  dstRef.dstLiveId = ewsId; // EWS id at the destination
                  const retired = await this.graph.moveToDeletedItems(srcUpn, m.id, sig);
                  dstRef.srcLiveId = (retired && retired.id) || m.id;
                  return 'done';
                };
                let result = null;
                for (let attempt = 0; ;) {
                  try { result = await doMove(); break; }
                  catch (e) {
                    if (e.aborted || e.name === 'AbortError' || run.stop) throw e;
                    if (attempt >= maxAttempts(e) - 1) throw e;
                    await new Promise(r => setTimeout(r, RETRY_WAITS[Math.min(attempt, RETRY_WAITS.length - 1)] + Math.random() * 1000));
                    attempt++;
                    if (run.stop) { const err = new Error('operation aborted'); err.name = 'AbortError'; err.aborted = true; throw err; }
                  }
                }
                if (mid) destMsgIds.add(mid);
                // no destKeys.add here — a batch-local subject+receivedAt match is
                // not content-proof; such items fall back to fuzzy (source kept).
                destFuzzy.add(m.subject, m.receivedAt, null);
                done++; syncProg();
                plan.add({
                  itemKey: 'live:' + f.folderId + ':' + m.id,
                  srcFolderId: f.folderId, srcFolderPath: f.path,
                  srcLiveId: dstRef.srcLiveId, dstFolderId: destFolderId, dstLiveId: dstRef.dstLiveId,
                  action: 'moved', fileId: null,
                  itemRow: JSON.stringify({ liveId: m.id, msgId: mid, subject: m.subject, receivedAt: m.receivedAt })
                });
              } catch (e) {
                if (e.aborted || (e.name === 'AbortError')) throw e;
                failed++;
                if (failedKeys.length < 5000) failedKeys.push('live:' + f.folderId + ':' + m.id);
                if (errors.length < 10) errors.push(String(e.message || e).slice(0, 300));
                this.log('warn', srcUpn, `move email failed (${f.path}: ${m.subject || m.id}): ${String(e.message || e).slice(0, 200)}`);
                syncProg();
              }
              this._progress(jobId, { done: done + skipped + failed, detail: detail({ done, skipped, failed, errors }) });
            }
          } catch (e) {
            if (e.aborted || e.name === 'AbortError') throw e;
            if (errors.length < 10) errors.push(String(e.message || e).slice(0, 300));
            this.log('warn', srcUpn, `move email: destination for "${f.path}" not resolved: ${String(e.message || e).slice(0, 200)}`);
          }
          foldersDone++; syncProg();
        }
        const status = run.stop ? 'stopped' : 'done';
        this._progress(jobId, { status, done: done + skipped + failed, detail: detail({ done, skipped, failed, errors }), finishedAt: new Date().toISOString() });
        this.log(failed ? 'warn' : 'info', srcUpn, `move email ${srcUpn} → ${dstUpn} ${status}: ${done} moved, ${skipped} skipped (already there), ${failed} failed`);
      } catch (e) {
        if (e.aborted || e.name === 'AbortError' || run.stop) {
          this._progress(jobId, { status: 'stopped', done: done + skipped + failed, detail: detail({ done, skipped, failed, errors }), finishedAt: new Date().toISOString() });
        } else {
          this._progress(jobId, { status: 'error', done: done + skipped + failed, detail: detail({ done, skipped, failed, errors: errors.concat(String(e.message || e).slice(0, 300)).slice(0, 10) }), finishedAt: new Date().toISOString() });
          this.log('error', srcUpn, 'move email failed: ' + e.message);
        }
      } finally {
        plan.flush();
        this._runs.delete(srcUpn);
        this.runProgress.delete(srcUpn);
      }
    })();
    return { jobId, total: 0 };
  }

  // ---------- undo ----------
  // Reverse a recorded move plan (move_email_plan rows of the move-email job).
  // Best-effort per item, 404s count as done; recoverable at every step:
  // destination copies go to Deleted Items / the graveyard, sources come back
  // from the graveyard or Deleted Items.
  get undoRunning() { return this._undoRunning === true; }

  undo(planJobId) {
    if (this._undoRunning) throw new Error('a move-email undo is already running');
    const rows = this.store.moveEmailPlanAll(planJobId);
    if (!rows.length) throw new Error('nothing to undo — no recorded plan rows for this job');
    this._undoRunning = true;
    const jobId = this.store.createJob('move-email-undo', rows.length, rows[0].srcUpn);
    const detail = extra => JSON.stringify({ undoOf: planJobId, ...extra });
    this._progress(jobId, { detail: detail({ restored: 0, cleaned: 0, failed: 0, errors: [] }) });
    const is404 = e => (e && e.status === 404) || /ErrorItemNotFound/i.test(String((e && e.fault) || (e && e.message) || e));
    (async () => {
      let restored = 0, cleaned = 0, failed = 0;
      const errors = [];
      const noteErr = (r, e) => {
        failed++;
        if (errors.length < 10) errors.push(String(e.message || e).slice(0, 300));
        this.log('warn', r.srcUpn, `move email undo failed (${r.srcFolderPath || r.srcFolderId}: ${r.itemKey}): ${String(e.message || e).slice(0, 200)}`);
      };
      try {
        for (let i = 0; i < rows.length; i++) {
          const r = rows[i];
          let extra = {};
          try { extra = r.itemRow ? JSON.parse(r.itemRow) : {}; } catch { }
          let restoredSource = false, cleanedDst = false;
          try {
            if (r.srcType === 'local') {
              const scope = String(r.itemKey || '').split(':')[0];
              // Restore the source file from the graveyard + its items row.
              if (r.fileId) {
                const gfile = path.join(this.storeRoot, '_graveyard', safeName(r.srcUpn), r.fileId + '.eml.gz');
                const folderRow = this.store.getFolder(r.srcUpn, scope, r.srcFolderId);
                if (folderRow && fs.existsSync(gfile)) {
                  const dir = this.engine.folderDir(r.srcUpn, scope, folderRow.path);
                  await fsp.mkdir(dir, { recursive: true });
                  await fsp.rename(gfile, path.join(dir, r.fileId + '.eml.gz'));
                  restoredSource = true;
                  if (extra.row) {
                    const { upn, scope: sc, folderId, itemId, fileId, size, sha256, subject, receivedAt, format, sender } = extra.row;
                    this.store.upsertItem({ upn, scope: sc, folderId, itemId, fileId, size, sha256, subject, receivedAt, format, sender });
                  }
                }
              }
              // Remove the copy this move placed at the destination. A verified
              // skip put nothing new there — that copy pre-existed, so undo only
              // restores the source and leaves the destination untouched.
              if (r.action === 'moved') {
                if (r.target === 'live') {
                  if (r.dstLiveId) {
                    // Uploaded copies are tracked by EWS id (ConvertId to RestId
                    // is tenant-blocked) — move aside via EWS.
                    await this.ews.moveToDeletedItems(r.dstUpn, r.dstLiveId).catch(e => { if (!is404(e)) throw e; });
                    cleanedDst = true;
                  } else if (extra.msgId && r.dstFolderId) {
                    const hit = (await this.graph.listMessages(r.dstUpn, r.dstFolderId))
                      .find(m => normMsgId(m.internetMessageId) === extra.msgId);
                    if (hit) await this.graph.moveToDeletedItems(r.dstUpn, hit.id).catch(e => { if (!is404(e)) throw e; });
                    cleanedDst = true; // not found = already gone
                  }
                } else if (extra.dstItemId && extra.dstScope) {
                  const row = this.store.getItem(r.dstUpn, extra.dstScope, r.dstFolderId, extra.dstItemId);
                  if (row) {
                    const dstFolderRow = this.store.getFolder(r.dstUpn, extra.dstScope, r.dstFolderId);
                    const fp = dstFolderRow && row.fileId ? itemFile(this.storeRoot, r.dstUpn, extra.dstScope, dstFolderRow, row.fileId, null) : null;
                    if (fp) {
                      const gdir = path.join(this.storeRoot, '_graveyard', safeName(r.dstUpn));
                      await fsp.mkdir(gdir, { recursive: true });
                      await fsp.rename(fp, path.join(gdir, row.fileId + '.eml.gz')).catch(() => { });
                    }
                    this.store.deleteItem(r.dstUpn, extra.dstScope, r.dstFolderId, extra.dstItemId);
                  }
                  cleanedDst = true; // no row = already gone
                }
              } else {
                cleanedDst = true; // skip-retire: destination copy pre-existed, left in place
              }
            } else {
              const sameMailbox = String(r.srcUpn).toLowerCase() === String(r.dstUpn).toLowerCase();
              if (r.action === 'moved') {
                if (sameMailbox) {
                  // Atomic move reversal: bring the message back to its folder.
                  let id = r.dstLiveId;
                  if (!id && extra.msgId && r.dstFolderId) {
                    const hit = (await this.graph.listMessages(r.dstUpn, r.dstFolderId))
                      .find(m => normMsgId(m.internetMessageId) === extra.msgId);
                    if (hit) id = hit.id;
                  }
                  if (id) {
                    await this.graph.moveMessage(r.srcUpn, id, r.srcFolderId).catch(e => { if (!is404(e)) throw e; });
                    restoredSource = true; cleanedDst = true;
                  }
                } else {
                  // Cross-mailbox: dst copy aside (EWS id), source back from
                  // Deleted Items.
                  if (r.dstLiveId) {
                    await this.ews.moveToDeletedItems(r.dstUpn, r.dstLiveId).catch(e => { if (!is404(e)) throw e; });
                    cleanedDst = true;
                  }
                  if (r.srcLiveId) {
                    await this.graph.moveMessage(r.srcUpn, r.srcLiveId, r.srcFolderId).catch(e => { if (!is404(e)) throw e; });
                    restoredSource = true;
                  }
                }
              } else {
                // Verified-skip retire: bring the source back from Deleted Items;
                // the pre-existing destination copy stays.
                if (r.srcLiveId) {
                  await this.graph.moveMessage(r.srcUpn, r.srcLiveId, r.srcFolderId).catch(e => { if (!is404(e)) throw e; });
                  restoredSource = true;
                }
                cleanedDst = true;
              }
            }
            if (r.action === 'moved') {
              if (!restoredSource && !cleanedDst) throw new Error('nothing left to reverse (no destination copy, no source copy found)');
            } else if (!restoredSource) {
              throw new Error('source copy not found (graveyard file / Deleted Items message missing)');
            }
            if (restoredSource) restored++;
            if (cleanedDst && r.action === 'moved') cleaned++;
          } catch (e) { noteErr(r, e); }
          if ((i + 1) % 5 === 0 || i === rows.length - 1) {
            this._progress(jobId, { done: i + 1, detail: detail({ restored, cleaned, failed, errors }) });
          }
        }
        this.store.recomputeMailboxBytes(rows[0].srcUpn);
        if (rows[0].target === 'local' || rows.some(r => r.srcType === 'local')) this.store.recomputeMailboxBytes(rows[0].dstUpn);
        // Keep the plan when items failed so a re-undo can pick them up.
        if (!failed) this.store.moveEmailPlanClear(planJobId);
        this._progress(jobId, { status: 'done', done: rows.length, detail: detail({ restored, cleaned, failed, errors }), finishedAt: new Date().toISOString() });
        this.log(failed ? 'warn' : 'info', rows[0].srcUpn,
          `move email undo (job ${planJobId}): ${restored} source(s) restored, ${cleaned} destination copy/copies removed, ${failed} failed`);
      } catch (e) {
        this._progress(jobId, { status: 'error', detail: detail({ restored, cleaned, failed, errors: errors.concat(String(e.message || e).slice(0, 300)).slice(0, 10) }), finishedAt: new Date().toISOString() });
        this.log('error', rows[0].srcUpn, 'move email undo failed: ' + e.message);
      } finally {
        this._undoRunning = false;
      }
    })();
    return { jobId, total: rows.length };
  }
}

module.exports = { MoveEmailEngine };
