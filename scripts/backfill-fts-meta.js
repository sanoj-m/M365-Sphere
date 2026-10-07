// One-off: backfill subject/sender/receivedAt for FTS items from the stored
// .fts.gz files themselves (local parse, no API calls). Safe to re-run.
// Usage: node scripts/backfill-fts-meta.js [upn]
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { Store } = require('../lib/store');
const { ftsPreview } = require('../lib/fts');
const { safeName } = require('../lib/util');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
cfg.dataDir = path.resolve(__dirname, '..', cfg.dataDir || './data');
const onlyUpn = process.argv[2];

const store = new Store(cfg.dataDir);
// Materialize rows up front: writing while a SELECT iteration is open on the
// same connection crashes better-sqlite3.
const rows = store.db.prepare(`SELECT upn, scope, folderId, itemId, fileId FROM items
  WHERE format='fts' AND (subject IS NULL OR sender IS NULL) AND fileId IS NOT NULL
  ${onlyUpn ? 'AND upn=?' : ''}`).all(...(onlyUpn ? [onlyUpn] : []));
console.log(`${rows.length} FTS item(s) missing metadata`);
const folderPath = new Map();
for (const f of store.db.prepare(`SELECT upn, scope, folderId, path FROM folders`).all())
  folderPath.set(`${f.upn} ${f.scope} ${f.folderId}`, f.path);
const upd = store.db.prepare(`UPDATE items SET subject=?, sender=?, receivedAt=? WHERE upn=? AND scope=? AND folderId=? AND itemId=?`);
const segs = p => String(p || '').split('/').filter(Boolean).map(safeName);
let done = 0, failed = 0, skipped = 0;
const tx = store.db.transaction(batch => { for (const b of batch) upd.run(...b); });
let batch = [];
for (const r of rows) {
  try {
    const fpath = folderPath.get(`${r.upn} ${r.scope} ${r.folderId}`);
    const f = path.join(cfg.dataDir, 'store', safeName(r.upn), r.scope, ...segs(fpath || ''), r.fileId + '.fts.gz');
    if (fs.statSync(f).size > 400 * 1024 * 1024) { skipped++; continue; } // avoid OOM on giant streams
    const buf = zlib.gunzipSync(fs.readFileSync(f));
    const pv = ftsPreview(buf, { metaOnly: true });
    batch.push([pv.subject !== '(no subject)' ? pv.subject : null, pv.from || null, pv.date || null, r.upn, r.scope, r.folderId, r.itemId]);
    if (batch.length >= 500) { tx(batch); batch = []; }
    done++;
  } catch { failed++; }
  if (done % 1000 === 0 && done) console.log(`  ${done}…`);
}
if (batch.length) tx(batch);
console.log(`backfilled ${done}, failed ${failed}, skipped ${skipped}`);
