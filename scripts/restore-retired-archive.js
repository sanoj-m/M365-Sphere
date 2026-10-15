// Restore local archive items whose retire broke during a move-email job
// (the 'dstFolderId is not defined' bug): the .fts.gz content files landed in
// the graveyard while their items rows were deleted. Rebuilds each row and
// moves the file back to its original folder directory.
//
// Folder mapping: the job recreated the source folder structure at the
// destination mailbox root (rel paths), so relPath -> original path is
// recomputed exactly like the engine did. File -> folder is matched by
// subject+receivedAt against the uploaded messages at the destination.
//
// Dry-run by default; pass --apply to execute.
// Usage: node scripts/restore-retired-archive.js <jobId> [--apply]
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const jobId = parseInt(process.argv[2], 10);
const APPLY = process.argv.includes('--apply');
if (!Number.isFinite(jobId)) { console.error('usage: node scripts/restore-retired-archive.js <jobId> [--apply]'); process.exit(1); }

const cfg = require('../config.json');
const D = require('better-sqlite3');
const { Auth } = require('../lib/auth.js');
const { GraphClient } = require('../lib/graph.js');
const { ftsMime, ftsPreview } = require('../lib/fts.js');
const { parseMimeHeaders } = require('../lib/engine.js');
const { safeName } = require('../lib/util.js');

const storeRoot = path.join(cfg.dataDir, 'store');
const key = (s, r) => String(s || '').trim().toLowerCase() + '|' + String(r || '').slice(0, 19);
const folderDir = (upn, scope, folderPath) =>
  path.join(storeRoot, safeName(upn), scope, ...String(folderPath).split('/').map(safeName));

(async () => {
  const db = new D(path.join(cfg.dataDir, 'state.db'));
  db.pragma('busy_timeout=10000');
  const job = db.prepare('SELECT * FROM jobs WHERE id=?').get(jobId);
  if (!job || job.kind !== 'move-email') throw new Error('move-email job not found');
  const d = JSON.parse(job.detail || '{}');
  const srcUpn = d.srcUpn, dstUpn = d.dstUpn;
  console.log(`job ${jobId}: ${srcUpn} (${d.srcType}) -> ${dstUpn}`);

  // Retired fileIds from the warn logs of this job's day window.
  const logs = db.prepare(`SELECT message FROM events WHERE message LIKE 'moved but source retire failed for %'
    AND ts BETWEEN ? AND ?`).all(
    new Date(+new Date(job.startedAt) - 60000).toISOString(),
    new Date(+(job.finishedAt ? new Date(job.finishedAt) : new Date()) + 60000).toISOString());
  const fileIds = logs.map(r => (r.message.match(/for ([0-9a-f]{40}):/) || [])[1]).filter(Boolean);
  console.log('retired fileIds found in logs:', fileIds.length);
  if (!fileIds.length) return;

  // Selected folders and the engine's rel-path computation.
  const sel = new Map(); // folderId -> row
  const scope = d.folderKeys[0].split(':')[0];
  for (const k of d.folderKeys) {
    const row = db.prepare('SELECT * FROM folders WHERE upn=? AND scope=? AND folderId=?').get(srcUpn, scope, k.slice(scope.length + 1));
    if (row) sel.set(row.folderId, row);
  }
  const allFolders = db.prepare('SELECT * FROM folders WHERE upn=? AND scope=?').all(srcUpn, scope);
  const byId = new Map(allFolders.map(f => [f.folderId, f]));
  const relToRow = new Map(); // rel path -> original folder row
  for (const f of sel.values()) {
    let top = f;
    for (let cur = byId.get(f.parentId); cur && sel.has(cur.folderId); cur = byId.get(cur.parentId)) top = cur;
    const base = top.path.slice(0, top.path.length - top.name.length).replace(/\/$/, '');
    const rel = f.path.slice(base ? base.length + 1 : 0);
    relToRow.set(rel, f);
  }
  console.log('selected folders:', sel.size, '| rel paths mapped:', relToRow.size);

  // Messages at the destination: key(subject|receivedAt) -> rel path.
  const auth = new Auth(cfg);
  const graph = new GraphClient(auth, () => {}, cfg);
  const dstTree = await graph.folderTree(dstUpn);
  const dstByPath = new Map(dstTree.map(r => [r.path, r.folderId || r.id]));
  const keyToRow = new Map(), keyNormToRow = new Map(), dateCount = new Map(), dateToRow = new Map();
  let listed = 0;
  for (const [rel, row] of relToRow) {
    const dfid = dstByPath.get(rel);
    if (!dfid) continue;
    let msgs = [];
    try { msgs = await graph.listMessages(dstUpn, dfid); } catch { continue; }
    listed++;
    for (const m of msgs) {
      const k = key(m.subject, m.receivedAt);
      if (!keyToRow.has(k)) keyToRow.set(k, row);
      const kn = String(m.subject || '').trim().toLowerCase().replace(/\s+/g, '') + '|' + String(m.receivedAt || '').slice(0, 19);
      if (!keyNormToRow.has(kn)) keyNormToRow.set(kn, row);
      const dt = String(m.receivedAt || '').slice(0, 19);
      dateCount.set(dt, (dateCount.get(dt) || 0) + 1);
      if (!dateToRow.has(dt)) dateToRow.set(dt, row);
    }
  }
  console.log('destination folders listed:', listed, '| keys:', keyToRow.size);

  // Match each graveyard file by parsing its FTS content.
  const gdir = path.join(storeRoot, '_graveyard', safeName(srcUpn));
  const restores = [], unmatched = [], missing = [];
  for (const fileId of fileIds) {
    const gf = path.join(gdir, fileId + '.eml.gz');
    if (!fs.existsSync(gf)) { missing.push(fileId); continue; }
    const raw = zlib.gunzipSync(fs.readFileSync(gf));
    // Content can be plain MIME (parse directly) or an FTS stream (MAPI props).
    let hdr, format;
    if (/^[A-Za-z][A-Za-z0-9-]*:/.test(raw.slice(0, 64).toString('latin1'))) {
      hdr = parseMimeHeaders(raw); format = 'eml';
    } else {
      const pv = ftsPreview(raw, { metaOnly: true });
      hdr = { subject: pv.subject !== '(no subject)' ? pv.subject : null, receivedAt: pv.date || null, sender: pv.from || null };
      format = 'fts';
    }
    const kn = String(hdr.subject || '').trim().toLowerCase().replace(/\s+/g, '') + '|' + String(hdr.receivedAt || '').slice(0, 19);
    const dt = String(hdr.receivedAt || '').slice(0, 19);
    const row = keyToRow.get(key(hdr.subject, hdr.receivedAt)) || keyNormToRow.get(kn)
      || (dt && dateCount.get(dt) === 1 ? dateToRow.get(dt) : null);
    if (row) restores.push({ fileId, raw, row, hdr, format });
    else unmatched.push({ fileId, subject: hdr.subject, receivedAt: hdr.receivedAt });
  }
  console.log(`matched to original folder: ${restores.length} | unmatched: ${unmatched.length} | file missing: ${missing.length}`);
  for (const u of unmatched.slice(0, 10)) console.log('  unmatched:', u.fileId.slice(0, 8), u.subject, u.receivedAt);
  if (!APPLY) { console.log('\nDRY RUN — pass --apply to execute.'); return; }

  const upsert = db.prepare(`INSERT INTO items(upn,scope,folderId,itemId,subject,receivedAt,size,fileId,status,lastError,attempts,updatedAt,sha256,format,sourceApi,physicalMailboxId,sender)
    VALUES (@upn,@scope,@folderId,@itemId,@subject,@receivedAt,@size,@fileId,'done',NULL,0,@updatedAt,@sha256,@format,'ie',NULL,@sender)
    ON CONFLICT(upn,scope,folderId,itemId) DO NOTHING`);
  let ok = 0, fail = 0;
  for (const r of restores) {
    try {
      const dir = folderDir(srcUpn, scope, r.row.path);
      await fsp.mkdir(dir, { recursive: true });
      const dstFile = path.join(dir, r.fileId + (r.format === 'fts' ? '.fts.gz' : '.eml.gz'));
      await fsp.rename(path.join(gdir, r.fileId + '.eml.gz'), dstFile);
      upsert.run({
        upn: srcUpn, scope, folderId: r.row.folderId, itemId: 'rst-' + r.fileId,
        subject: r.hdr.subject || null, receivedAt: r.hdr.receivedAt || null, sender: r.hdr.sender || null,
        size: r.raw.length, fileId: r.fileId, updatedAt: new Date().toISOString(),
        sha256: crypto.createHash('sha256').update(r.raw).digest('hex'), format: r.format
      });
      ok++;
      if (ok % 50 === 0) console.log('  restored', ok, '…');
    } catch (e) { fail++; console.error('  FAILED:', r.fileId.slice(0, 8), String(e.message).slice(0, 150)); }
  }
  console.log(`restored: ${ok} ok, ${fail} failed`);
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
