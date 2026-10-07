// Dedupe: find duplicate emails and move them aside — recoverably.
// Local: duplicates go to data/store/<upn>/_duplicates/<original folder path>/
// with a manifest, and their DB rows become status='deduped'. Nothing is deleted.
// Live (primary mailbox via Graph): duplicates are verified by full-content
// SHA-256 and moved to Deleted Items/Dedupe <date>/<original folder path>,
// recoverable on the server side.
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { safeName } = require('./util');

// Canonical-copy preference: Inbox first, then shallowest/shortest path, then
// oldest received date.
function pickCanonical(items) {
  const score = it => {
    const p = String(it.folderPath || it.folderName || '').toLowerCase();
    return (p === 'inbox' ? 0 : p.startsWith('inbox/') ? 1 : 2) * 1e9
      + String(it.folderPath || '').split('/').length * 1e6
      + (Date.parse(it.receivedAt || '') || 0) / 1e6;
  };
  return [...items].sort((a, b) => score(a) - score(b));
}

// Duplicate fingerprint for live MIME: Exchange rewrites transport headers AND
// re-wraps the MIME per copy (different multipart boundaries/encodings), and
// signature relays rewrite the text part — verified by diffing two live copies
// (same Message-ID/attachments/html-modulo-whitespace, different raw bytes).
// Fingerprint = identity headers + whitespace-stripped html (or text fallback)
// + decoded attachment bytes. Logical identity, not byte identity.
const { simpleParser } = require('mailparser');
async function mimeFingerprint(buf) {
  const mail = await simpleParser(buf);
  const h = crypto.createHash('sha256');
  const norm = v => String(v || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const addr = v => {
    const list = Array.isArray(v) ? v : (v && v.value) || [];
    return list.map(a => (a.address || '').toLowerCase()).sort().join(',');
  };
  h.update([
    norm(mail.subject), addr(mail.from), addr(mail.to), addr(mail.cc),
    String(mail.messageId || '').toLowerCase(),
    mail.date ? mail.date.toISOString() : ''
  ].join('|'));
  if (mail.html) h.update('\x00html\x00' + String(mail.html).replace(/\s+/g, ''));
  else h.update('\x00text\x00' + String(mail.text || '').replace(/\s+/g, ''));
  const atts = (mail.attachments || []).slice()
    .sort((x, y) => String(x.filename).localeCompare(String(y.filename)) || ((x.size || 0) - (y.size || 0)));
  for (const a of atts) { h.update(`\x00att\x00${norm(a.filename)}:${a.contentType}:`); h.update(a.content); }
  return h.digest('hex');
}

class DedupeEngine {
  constructor({ cfg, store, graph, log, bus }) {
    this.cfg = cfg; this.store = store; this.graph = graph; this.log = log; this.bus = bus;
    this._runs = new Map(); // upn -> { stop, aborter } — one dedupe job per mailbox
    this.checkProgress = new Map(); // upn -> live dry-run progress, exposed via /api/status
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

  // ---------- Fuzzy cross-channel grouping (shared) ----------
  // Same physical email copied by different APIs (Graph/EWS/Graph-IE/PST) gets
  // different ids and slightly normalized MIME, so sha256/Message-ID grouping
  // never catches it. Fuzzy rule: same subject, receivedAt within 2 min, size
  // within 10% when both sizes are known.
  _fuzzyClusters(list) {
    const out = [];
    list.sort((a, b) => String(a.receivedAt).localeCompare(String(b.receivedAt)));
    let cluster = [list[0]];
    const flush = () => { if (cluster.length > 1) out.push(cluster); };
    for (let i = 1; i < list.length; i++) {
      const gap = Math.abs(+new Date(list[i].receivedAt) - +new Date(list[i - 1].receivedAt));
      if (gap > 120000) { flush(); cluster = []; }
      cluster.push(list[i]);
    }
    flush();
    return out;
  }

  // Local fuzzy groups within ONE folder (sha256 groups are mailbox-wide and
  // stay authoritative for identical content; fuzzy only takes clusters whose
  // content DIFFERS — i.e. groups the sha pass can never see).
  _fuzzyLocalGroups(upn) {
    const rows = this.store.db.prepare(`
      SELECT i.scope, i.folderId, i.itemId, i.fileId, i.subject, i.receivedAt, i.size, i.sha256,
             f.path AS folderPath, f.name AS folderName
      FROM items i JOIN folders f ON f.upn=i.upn AND f.scope=i.scope AND f.folderId=i.folderId
      WHERE i.upn=? AND i.status='done' AND i.fileId IS NOT NULL AND i.subject IS NOT NULL AND i.subject != ''`).all(upn);
    const byKey = new Map();
    for (const r of rows) {
      const k = r.scope + '|' + r.folderId + '|' + String(r.subject).trim().toLowerCase();
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(r);
    }
    const out = [];
    for (const list of byKey.values()) {
      if (list.length < 2) continue;
      for (const cluster of this._fuzzyClusters(list)) {
        if (new Set(cluster.map(c => c.sha256).filter(Boolean)).size < 2) continue; // identical content — sha pass owns it
        const [keep, ...rest] = pickCanonical(cluster);
        const dupes = rest.filter(d =>
          (keep.sha256 && d.sha256 === keep.sha256)
          || (keep.size && d.size && Math.abs(d.size - keep.size) / Math.max(d.size, keep.size) <= 0.10));
        if (dupes.length) out.push({ keep, dupes });
      }
    }
    return out;
  }

  // Live fuzzy groups: candidates the Message-ID grouping missed (copies with
  // different/absent Message-IDs). Ids already in a key-group are excluded.
  // Live apply still verifies byte-identity before moving anything, so a false
  // positive here only costs an extra MIME download, never a wrong move.
  _fuzzyLiveGroups(all, assigned) {
    const bySubj = new Map();
    for (const m of all) {
      const s = String(m.subject || '').trim().toLowerCase();
      if (!s || !m.receivedAt || assigned.has(m.id)) continue;
      if (!bySubj.has(s)) bySubj.set(s, []);
      bySubj.get(s).push(m);
    }
    const out = [];
    for (const list of bySubj.values()) {
      if (list.length < 2) continue;
      for (const cluster of this._fuzzyClusters(list)) {
        const seen = new Set();
        const uniq = cluster.filter(x => !assigned.has(x.id) && !seen.has(x.id) && seen.add(x.id));
        if (uniq.length > 1) { uniq.forEach(x => assigned.add(x.id)); out.push(uniq); }
      }
    }
    return out;
  }

  // ---------- Local check (dry run) ----------
  checkLocal(upn) {
    const jobId = this.store.createJob('dedupe-check', 0, upn);
    try {
      const groups = this.store.duplicateGroups(upn);
      const out = [];
      let dupItems = 0, reclaimable = 0;
      for (const g of groups) {
        const items = this.store.itemsByHash(upn, g.scope, g.sha256);
        const [keep, ...dups] = pickCanonical(items);
        dupItems += dups.length;
        reclaimable += dups.reduce((a, i) => a + (i.size || 0), 0);
        out.push({
          scope: g.scope, sha256: g.sha256.slice(0, 12), count: g.n, via: 'content',
          subject: keep.subject || '(no subject)', receivedAt: keep.receivedAt,
          keep: keep.folderPath, duplicates: dups.map(d => d.folderPath)
        });
      }
      // Fuzzy pass: cross-channel copies (different ids, normalized MIME) in one folder.
      for (const g of this._fuzzyLocalGroups(upn)) {
        dupItems += g.dupes.length;
        reclaimable += g.dupes.reduce((a, i) => a + (i.size || 0), 0);
        out.push({
          scope: g.keep.scope, count: g.dupes.length + 1, via: 'fuzzy',
          subject: g.keep.subject || '(no subject)', receivedAt: g.keep.receivedAt,
          keep: g.keep.folderPath, duplicates: g.dupes.map(d => d.folderPath)
        });
      }
      this._progress(jobId, { status: 'done', total: dupItems, done: dupItems, detail: `${out.length} duplicate group(s), ${dupItems} item(s) can be moved aside`, finishedAt: new Date().toISOString() });
      return { groups: out.length, dupItems, reclaimable, sample: out.slice(0, 50) };
    } catch (e) {
      this._progress(jobId, { status: 'error', detail: String(e.message).slice(0, 300), finishedAt: new Date().toISOString() });
      throw e;
    }
  }

  // ---------- Local apply ----------
  async applyLocal(upn) {
    if (this._runs.has(upn)) throw new Error('a dedupe job is already running for this mailbox');
    const report = this.checkLocal(upn);
    if (!report.dupItems) return { jobId: null, moved: 0, message: 'no duplicates found' };
    const run = { stop: false, aborter: new AbortController() };
    this._runs.set(upn, run);
    const jobId = this.store.createJob('dedupe', report.dupItems, upn);
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const dupRoot = path.join(this.storeRoot, safeName(upn), '_duplicates');
    const manifest = { upn, at: new Date().toISOString(), moved: [] };
    (async () => {
      let done = 0, moved = 0, missing = 0;
      const moveOne = async d => {
        const segs = String(d.folderPath || d.folderName || '').split('/').filter(Boolean).map(safeName);
        const src = path.join(this.storeRoot, safeName(upn), d.scope, ...segs, d.fileId + '.eml.gz');
        const dstDir = path.join(dupRoot, d.scope, ...segs);
        const dst = path.join(dstDir, d.fileId + '.eml.gz');
        try {
          await fsp.mkdir(dstDir, { recursive: true });
          await fsp.rename(src, dst);
          this.store.setItemStatus(upn, d.scope, d.folderId, d.itemId, 'deduped');
          manifest.moved.push({ scope: d.scope, folderId: d.folderId, itemId: d.itemId, fileId: d.fileId, folderPath: d.folderPath });
          moved++;
        } catch (e) {
          missing++;
          this.log('warn', upn, `dedupe: could not move ${d.fileId} (${d.folderPath}): ${e.message}`);
        }
        done++;
        if (done % 10 === 0) this._progress(jobId, { done, detail: `${upn}: ${done}/${report.dupItems} moved aside` });
      };
      try {
        for (const g of this.store.duplicateGroups(upn)) {
          if (run.stop) break;
          const items = this.store.itemsByHash(upn, g.scope, g.sha256);
          const [, ...dups] = pickCanonical(items);
          for (const d of dups) {
            if (run.stop) break;
            await moveOne(d);
          }
        }
        // Fuzzy pass (cross-channel copies) — queried AFTER the sha pass so rows
        // it already moved aside (status 'deduped') are not re-processed.
        for (const g of this._fuzzyLocalGroups(upn)) {
          if (run.stop) break;
          for (const d of g.dupes) {
            if (run.stop) break;
            await moveOne(d);
          }
        }
        await fsp.mkdir(dupRoot, { recursive: true });
        await fsp.writeFile(path.join(dupRoot, `manifest-${ts}.json`), JSON.stringify(manifest, null, 1));
        this.store.recomputeMailboxBytes(upn);
        this._progress(jobId, { status: run.stop ? 'stopped' : 'done', done, detail: `${moved} moved to _duplicates (${missing} missing file(s))`, finishedAt: new Date().toISOString() });
        this.log('info', upn, `dedupe complete: ${moved} duplicate(s) moved to _duplicates — folder structure kept, manifest manifest-${ts}.json`);
      } catch (e) {
        this._progress(jobId, { status: 'error', done, detail: String(e.message).slice(0, 300), finishedAt: new Date().toISOString() });
        this.log('error', upn, 'dedupe failed: ' + e.message);
      } finally { this._runs.delete(upn); }
    })();
    return { jobId, total: report.dupItems };
  }

  // ---------- Local restore (latest manifest) ----------
  async restoreLocal(upn) {
    const dupRoot = path.join(this.storeRoot, safeName(upn), '_duplicates');
    const files = (await fsp.readdir(dupRoot).catch(() => []))
      .filter(f => f.startsWith('manifest-') && f.endsWith('.json')).sort();
    if (!files.length) throw new Error('no dedupe manifest found — nothing to restore');
    const manifest = JSON.parse(await fsp.readFile(path.join(dupRoot, files[files.length - 1]), 'utf8'));
    let restored = 0, missing = 0;
    for (const m of manifest.moved || []) {
      const segs = String(m.folderPath || '').split('/').filter(Boolean).map(safeName);
      const src = path.join(dupRoot, m.scope, ...segs, m.fileId + '.eml.gz');
      const dstDir = path.join(this.storeRoot, safeName(upn), m.scope, ...segs);
      try {
        await fsp.mkdir(dstDir, { recursive: true });
        await fsp.rename(src, path.join(dstDir, m.fileId + '.eml.gz'));
        this.store.setItemStatus(upn, m.scope, m.folderId, m.itemId, 'done');
        restored++;
      } catch { missing++; }
    }
    this.store.recomputeMailboxBytes(upn);
    this.log('info', upn, `dedupe restore: ${restored} item(s) restored from ${files[files.length - 1]}${missing ? `, ${missing} file(s) missing` : ''}`);
    return { restored, missing, manifest: files[files.length - 1] };
  }

  // Folder list for live scans, excluding the Deleted Items and Junk Email
  // subtrees. Deleted Items is where dedupe moves verified duplicates, so
  // re-runs after a stop resume where they left off; junk is exempt by policy.
  async _liveFolders(upn) {
    const tree = await this.graph.folderTree(upn);
    const excluded = new Set();
    for (const wk of ['deleteditems', 'junkemail']) {
      try { const d = await this.graph.getJson(`/users/${encodeURIComponent(upn)}/mailFolders/${wk}?$select=id`); if (d && d.id) excluded.add(d.id); } catch { }
    }
    for (let grew = true; grew;) {
      grew = false;
      for (const f of tree) if (f.parentId && excluded.has(f.parentId) && !excluded.has(f.folderId)) { excluded.add(f.folderId); grew = true; }
    }
    return tree.filter(f => f.itemCount > 0 && !excluded.has(f.folderId));
  }

  // ---------- Live check (primary mailbox via Graph) ----------
  async checkLive(upn) {
    const prog = { upn, foldersDone: 0, foldersTotal: 0, currentFolder: 'reading folder tree…', messages: 0, groups: 0 };
    this.checkProgress.set(upn, prog);
    const jobId = this.store.createJob('dedupe-check', 0, upn);
    this.log('info', upn, 'live dedupe check: scanning folders…');
    try {
      const folders = await this._liveFolders(upn);
      const byKey = new Map(); // internetMessageId|subject|receivedAt -> [{id, folder}]
      prog.foldersTotal = folders.length;
      for (const f of folders) {
        prog.currentFolder = f.path || f.name;
        const msgs = await this.graph.listMessageKeys(upn, f.folderId);
        for (const m of msgs) {
          const key = m.internetMessageId || `${(m.subject || '').trim()}|${m.receivedDateTime || ''}`;
          if (!key || key === '|') continue;
          const arr = byKey.get(key) || [];
          arr.push({ id: m.id, folder: f.path || f.name, subject: m.subject, receivedAt: m.receivedDateTime });
          byKey.set(key, arr);
        }
        prog.foldersDone++;
        prog.messages += msgs.length;
        prog.groups = [...byKey.values()].reduce((a, g) => a + (g.length > 1 ? 1 : 0), 0);
        this._progress(jobId, { detail: `scanning folders ${prog.foldersDone}/${folders.length} — ${prog.messages} message(s), ${prog.groups} candidate group(s)` });
      }
      const groups = [...byKey.values()].filter(g => g.length > 1);
      const assigned = new Set(groups.flat().map(x => x.id));
      const allGroups = groups.concat(this._fuzzyLiveGroups([...byKey.values()].flat(), assigned));
      const sample = allGroups.slice(0, 50).map(g => ({
        subject: g[0].subject || '(no subject)', receivedAt: g[0].receivedAt, count: g.length,
        folders: g.map(x => x.folder)
      }));
      const dupItems = allGroups.reduce((a, g) => a + g.length - 1, 0);
      this._progress(jobId, { status: 'done', total: dupItems, done: dupItems, detail: `${allGroups.length} duplicate group(s), ${dupItems} item(s) can be moved aside`, finishedAt: new Date().toISOString() });
      this.log('info', upn, `live dedupe check: ${folders.length} folders, ${prog.messages} message(s) scanned — ${allGroups.length} duplicate group(s) (${groups.length} by Message-ID, ${allGroups.length - groups.length} fuzzy), ${dupItems} item(s) can be moved aside`);
      return { groups: allGroups.length, dupItems, sample };
    } catch (e) {
      this._progress(jobId, { status: 'error', detail: String(e.message).slice(0, 300), finishedAt: new Date().toISOString() });
      throw e;
    } finally {
      this.checkProgress.delete(upn);
    }
  }

  // ---------- Live apply: verified extras go to Deleted Items ----------
  // Resumable: verified outcomes are persisted per item in dedupe_live_plan.
  // A resume run moves leftover 'pending' items without re-verifying and skips
  // items already marked kept/moved/failed, so an interrupted "move duplicates
  // aside" never redoes the fingerprint-verify work.
  async applyLive(upn, { resume = false } = {}) {
    if (this._runs.has(upn)) throw new Error('a dedupe job is already running for this mailbox');
    const run = { stop: false, aborter: new AbortController() }; // stop via run.stop checks between folders/items
    this._runs.set(upn, run);
    const jobId = this.store.createJob('dedupe-live', 0, upn);
    const runRoot = `Dedupe ${new Date().toISOString().slice(0, 10)}`;
    (async () => {
      let moved = 0, failed = 0, unverified = 0;
      try {
        const prior = new Map(); // liveId -> plan row
        if (resume) for (const r of this.store.dedupeLivePlanAll(upn)) prior.set(r.liveId, r);
        else this.store.clearDedupeLivePlan(upn);
        const priorPending = [...prior.values()].filter(r => r.status === 'pending').length;
        if (prior.size) this.log('info', upn, `live dedupe: resuming saved plan — ${priorPending} verified move(s) pending, ${prior.size - priorPending} already-processed item(s) skipped without re-verify`);

        this.log('info', upn, 'live dedupe: scanning folders…');
        const folders = await this._liveFolders(upn);
        const byKey = new Map();
        let scanned = 0;
        for (const f of folders) {
          if (run.stop) break;
          const msgs = await this.graph.listMessageKeys(upn, f.folderId);
          for (const m of msgs) {
            const key = m.internetMessageId || `${(m.subject || '').trim()}|${m.receivedDateTime || ''}`;
            if (!key || key === '|') continue;
            const arr = byKey.get(key) || [];
            arr.push({ id: m.id, folder: f.path || f.name, subject: m.subject, receivedAt: m.receivedDateTime });
            byKey.set(key, arr);
          }
          scanned++;
          this._progress(jobId, { detail: `scanning folders ${scanned}/${folders.length}`, total: scanned, done: scanned });
        }
        const keyGroups = [...byKey.values()].filter(g => g.length > 1);
        const assigned = new Set(keyGroups.flat().map(x => x.id));
        const groups = keyGroups.concat(this._fuzzyLiveGroups([...byKey.values()].flat(), assigned));
        this.log('info', upn, `live dedupe: ${groups.length} candidate group(s) (${keyGroups.length} by Message-ID, ${groups.length - keyGroups.length} fuzzy) — verifying content…`);

        // Verify by normalized-content fingerprint (stable headers + body —
        // Exchange rewrites transport headers per copy, so raw bytes never
        // match). Only fingerprint-identical messages are duplicates — and
        // each group's verified duplicates move IMMEDIATELY, so progress is
        // visible and a stop/resume never redoes a long verify-only phase.
        const folderIds = new Map();
        const dstFolderId = async relPath => {
          const segs = String(relPath || '').split('/').filter(Boolean);
          const key = segs.join('/');
          if (folderIds.has(key)) return folderIds.get(key);
          let parent = 'deleteditems';
          for (const seg of segs) parent = await this.graph.ensureChildFolder(upn, parent, seg);
          folderIds.set(key, parent);
          return parent;
        };
        const seen = new Set(); // liveIds touched this run
        const moveOne = async (id, dstPath) => {
          try {
            const dst = await dstFolderId(dstPath);
            await this.graph.moveMessage(upn, id, dst);
            moved++;
            this.store.markDedupeLiveItem(upn, id, 'moved');
          } catch (e) {
            if (/\b404\b|itemnotfound|ErrorItemNotFound/i.test(String(e.message || e))) {
              moved++; // already gone — an earlier run moved it
              this.store.markDedupeLiveItem(upn, id, 'moved');
            } else {
              failed++; // move failure: the item stays put
              this.store.markDedupeLiveItem(upn, id, 'failed');
              this.log('warn', upn, `live dedupe move failed: ${String(e.message || e).slice(0, 200)}`);
            }
          }
        };
        const candidates = groups.reduce((a, g) => a + g.length - 1, 0);
        this._progress(jobId, { total: candidates, done: 0, detail: `verifying + moving ${candidates} candidate(s)…` });
        let gi = 0;
        for (const g of groups) {
          if (run.stop) break;
          gi++;
          // Keep the copy in Inbox when present, else the first found.
          g.sort((a, b) => (String(b.folder).toLowerCase() === 'inbox') - (String(a.folder).toLowerCase() === 'inbox'));
          let keepHash = null;
          for (const x of g.slice(1)) {
            if (run.stop) break;
            seen.add(x.id);
            const p = prior.get(x.id);
            if (p && p.status !== 'pending') { // kept / moved / failed in an earlier run
              if (p.status === 'failed') failed++; else unverified++;
              continue;
            }
            if (p && p.status === 'pending') { // verified identical earlier, move left over
              await moveOne(x.id, p.dstPath || `${runRoot}/${x.folder}`);
              continue;
            }
            if (keepHash === null) {
              try { keepHash = await mimeFingerprint(await this.graph.getMessageMime(upn, g[0].id)); }
              catch (e) {
                this.log('warn', upn, `live dedupe: skipped group "${g[0].subject || '(no subject)'}" — canonical copy unreadable: ${String(e.message || e).slice(0, 150)}`);
                break;
              }
            }
            let h;
            try { h = await mimeFingerprint(await this.graph.getMessageMime(upn, x.id)); }
            catch (e) {
              unverified++;
              this.store.upsertDedupeLiveItem(upn, { liveId: x.id, dstPath: `${runRoot}/${x.folder}`, status: 'kept' });
              this.log('warn', upn, `live dedupe: kept "${x.subject || '(no subject)'}" in ${x.folder} — could not verify content: ${String(e.message || e).slice(0, 150)}`);
              continue;
            }
            if (h !== keepHash) {
              unverified++;
              this.store.upsertDedupeLiveItem(upn, { liveId: x.id, dstPath: `${runRoot}/${x.folder}`, status: 'kept' });
              this.log('warn', upn, `live dedupe: kept "${x.subject || '(no subject)'}" in ${x.folder} — content differs from the kept copy`);
              continue;
            }
            this.store.upsertDedupeLiveItem(upn, { liveId: x.id, dstPath: `${runRoot}/${x.folder}`, status: 'pending' });
            await moveOne(x.id, `${runRoot}/${x.folder}`);
          }
          if (gi % 5 === 0) this._progress(jobId, { done: moved + failed + unverified, detail: `group ${gi}/${groups.length}: ${moved} moved, ${failed} failed, ${unverified} skipped (not identical)` });
        }
        // Leftover pending items whose group no longer re-scans as duplicated
        // (e.g. the kept copy moved between runs): still move them.
        if (!run.stop) {
          for (const p of prior.values()) {
            if (run.stop) break;
            if (p.status !== 'pending' || seen.has(p.liveId)) continue;
            await moveOne(p.liveId, p.dstPath);
          }
        }
        const remaining = this.store.dedupeLivePlanAll(upn).filter(r => r.status === 'pending').length;
        this._progress(jobId, { status: run.stop ? 'stopped' : 'done', done: moved + failed + unverified, detail: `${moved} moved to Deleted Items/${runRoot}, ${failed} failed, ${unverified} skipped (not identical)${remaining ? `, ${remaining} pending (Restart resumes)` : ''}`, finishedAt: new Date().toISOString() });
        this.log(failed ? 'warn' : 'info', upn, `live dedupe complete: ${moved} item(s) in Deleted Items/${runRoot} (folder structure kept, recoverable), ${failed} failed, ${unverified} skipped — content differed${remaining ? `, ${remaining} move(s) left pending for resume` : ''}`);
      } catch (e) {
        if (e.aborted || run.stop) {
          this._progress(jobId, { status: 'stopped', detail: 'stopped', finishedAt: new Date().toISOString() });
        } else {
          this._progress(jobId, { status: 'error', detail: String(e.message).slice(0, 300), finishedAt: new Date().toISOString() });
          this.log('error', upn, 'live dedupe failed: ' + e.message);
        }
      } finally { this._runs.delete(upn); }
    })();
    return { jobId };
  }
}

module.exports = { DedupeEngine, mimeFingerprint };
