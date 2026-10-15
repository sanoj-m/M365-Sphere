// Undo a move-email job (live→live): moves the source messages back from the
// source mailbox's Deleted Items to their original folders, and moves the
// copies the job uploaded at the destination to the destination's Deleted
// Items.
//
// Folder mapping: the job recreated the source folder structure at the
// destination (merge-by-name), so the destination's folders with the same
// paths hold copies of everything the job touched (uploaded by the job, or
// pre-existing — which is why items 'skipped'). We list those destination
// folders and match each Deleted Items message by internetMessageId (exact)
// or subject+receivedAt (fallback) to recover its original folder path, then
// move it back to the source mailbox's same-path live folder.
//
// Dry-run by default; pass --apply to execute.
// Usage: node scripts/undo-move-email.js <jobId> [--apply]
const fs = require('fs');
const path = require('path');

const jobId = parseInt(process.argv[2], 10);
const APPLY = process.argv.includes('--apply');
if (!Number.isFinite(jobId)) { console.error('usage: node scripts/undo-move-email.js <jobId> [--apply]'); process.exit(1); }

const cfg = require('../config.json');
const D = require('better-sqlite3');
const { Auth } = require('../lib/auth.js');
const { GraphClient } = require('../lib/graph.js');

const key = (subject, receivedAt) => String(subject || '').trim().toLowerCase() + '|' + String(receivedAt || '').slice(0, 19);
const normMsgId = s => { const v = String(s || '').replace(/[<>]/g, '').trim().toLowerCase(); return v || null; };

(async () => {
  const db = new D(path.join(cfg.dataDir, 'state.db'), { readonly: true });
  const job = db.prepare('SELECT * FROM jobs WHERE id=?').get(jobId);
  if (!job || job.kind !== 'move-email') throw new Error('move-email job not found');
  const d = JSON.parse(job.detail || '{}');
  if (d.srcType !== 'live' || d.target !== 'live') throw new Error('only live→live jobs are supported');
  const srcUpn = d.srcUpn, dstUpn = d.dstUpn;
  const from = new Date(+new Date(job.startedAt) - 5 * 60000).toISOString();
  const to = new Date(+(job.finishedAt ? new Date(job.finishedAt) : new Date()) + 5 * 60000).toISOString();
  console.log(`job ${jobId}: ${srcUpn} -> ${dstUpn}, window ${from} .. ${to}`);

  const auth = new Auth(cfg);
  const graph = new GraphClient(auth, () => {}, cfg);

  const loadTree = upn => {
    const f = path.join(cfg.dataDir, 'live-folders', upn.replace(/[^a-z0-9@._-]/gi, '_') + '.json');
    if (!fs.existsSync(f)) throw new Error('no saved live tree for ' + upn);
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    return j.folders || j; // rows: { folderId|id, parentId, name, path, itemCount }
  };
  const fid = r => r.folderId || r.id;
  const srcRows = loadTree(srcUpn);
  const dstRows = srcUpn === dstUpn ? srcRows : loadTree(dstUpn);
  const srcByPath = new Map(srcRows.map(r => [r.path, fid(r)]));
  const dstByPath = new Map(dstRows.map(r => [r.path, fid(r)]));

  // Expand the job's selected live roots to their descendants (same rule the
  // engine used): path -> live folderId at the SOURCE.
  const roots = new Set((d.folderKeys || []).map(k => String(k).replace(/^live:/, '')));
  const srcById = new Map(srcRows.map(r => [fid(r), r]));
  const selPaths = []; // paths of selected folders incl. descendants
  for (const r of srcRows) {
    for (let cur = r; cur; cur = srcById.get(cur.parentId)) {
      if (roots.has(fid(cur))) { selPaths.push(r.path); break; }
    }
  }
  console.log(`selected source folder paths (incl. descendants): ${selPaths.length}`);

  // Build message -> path maps from the destination's same-path folders.
  const listAll = async (upn, folderId, extra) => {
    const sel = 'id,internetMessageId,subject,receivedDateTime,lastModifiedDateTime';
    let q = `/users/${encodeURIComponent(upn)}/mailFolders/${encodeURIComponent(folderId)}/messages?$select=${sel}&$top=200`;
    if (extra) q += '&' + extra;
    const out = [];
    for await (const batch of graph.pages(q)) out.push(...batch);
    return out;
  };
  const byMsgId = new Map(), byKey = new Map();
  let dstFoldersListed = 0;
  for (const p of selPaths) {
    const dfid = dstByPath.get(p);
    if (!dfid) continue;
    let msgs;
    try { msgs = await listAll(dstUpn, dfid); } catch { continue; }
    dstFoldersListed++;
    for (const m of msgs) {
      const mid = normMsgId(m.internetMessageId);
      if (mid && !byMsgId.has(mid)) byMsgId.set(mid, p);
      const k = key(m.subject, m.receivedDateTime);
      if (!byKey.has(k)) byKey.set(k, p);
    }
  }
  console.log(`destination folders listed: ${dstFoldersListed} (msgIds ${byMsgId.size}, keys ${byKey.size})`);

  // Messages the job moved into the source's Deleted Items (the move stamps
  // lastModifiedDateTime — filter by the job window).
  const deleted = await listAll(srcUpn, 'deleteditems',
    `$filter=lastModifiedDateTime ge ${from} and lastModifiedDateTime le ${to}`);
  console.log(`in ${srcUpn} Deleted Items within window: ${deleted.length}`);

  const restores = [], unmatched = [];
  for (const m of deleted) {
    const p = byMsgId.get(normMsgId(m.internetMessageId)) || byKey.get(key(m.subject, m.receivedDateTime));
    const folderId = p && srcByPath.get(p);
    if (folderId) restores.push({ id: m.id, msgId: normMsgId(m.internetMessageId), subject: m.subject, receivedAt: m.receivedDateTime, folderId, path: p });
    else unmatched.push({ id: m.id, subject: m.subject, receivedAt: m.receivedDateTime });
  }
  console.log(`resolvable to original folder: ${restores.length} | unmatched (left in Deleted Items): ${unmatched.length}`);
  for (const u of unmatched.slice(0, 10)) console.log('  unmatched:', u.subject, u.receivedAt);

  // Destination copies the job UPLOADED: in dst same-path folders, modified
  // within the window, Message-ID in the restored set. (Pre-existing copies —
  // the job's skips — have older timestamps and are never touched.)
  const movedMsgIds = new Set(restores.map(r => r.msgId).filter(Boolean));
  const movedKeys = new Set(restores.map(r => key(r.subject, r.receivedAt)));
  const dstHits = [];
  if (dstUpn !== srcUpn && movedMsgIds.size) {
    for (const p of selPaths) {
      const dfid = dstByPath.get(p);
      if (!dfid) continue;
      let msgs = [];
      try { msgs = await listAll(dstUpn, dfid, `$filter=lastModifiedDateTime ge ${from} and lastModifiedDateTime le ${to}`); } catch { continue; }
      for (const m of msgs) {
        const mid = normMsgId(m.internetMessageId);
        if ((mid && movedMsgIds.has(mid)) || movedKeys.has(key(m.subject, m.receivedDateTime))) dstHits.push({ id: m.id, subject: m.subject, folderPath: p });
      }
    }
    console.log(`uploaded copies found at ${dstUpn}: ${dstHits.length}`);
  }

  if (!APPLY) { console.log('\nDRY RUN — pass --apply to execute.'); return; }

  let ok = 0, fail = 0;
  for (const r of restores) {
    try { await graph.moveMessage(srcUpn, r.id, r.folderId); ok++; }
    catch (e) { fail++; console.error('  restore failed:', r.subject, String(e.message).slice(0, 120)); }
    if ((ok + fail) % 100 === 0) console.log(`  restored ${ok + fail}/${restores.length}…`);
  }
  console.log(`restored to ${srcUpn}: ${ok} ok, ${fail} failed`);
  let dok = 0, dfail = 0;
  for (const h of dstHits) {
    try { await graph.moveToDeletedItems(dstUpn, h.id); dok++; }
    catch (e) { dfail++; console.error('  dst cleanup failed:', h.subject, String(e.message).slice(0, 120)); }
  }
  console.log(`destination copies moved to ${dstUpn} Deleted Items: ${dok} ok, ${dfail} failed`);
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
