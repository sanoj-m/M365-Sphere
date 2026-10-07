// One-off: backfill sender (and missing subject/date) for EML items by parsing
// the stored .eml.gz headers locally. No API calls. Safe to re-run.
// Usage: node scripts/backfill-eml-sender.js [upn]
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { Store } = require('../lib/store');
const { safeName } = require('../lib/util');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
cfg.dataDir = path.resolve(__dirname, '..', cfg.dataDir || './data');
const onlyUpn = process.argv[2];

const dec = s => s == null ? null : s.replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (whole, cs, enc, txt) => {
  try {
    const buf = enc.toUpperCase() === 'B'
      ? Buffer.from(txt, 'base64')
      : Buffer.from(txt.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))), 'binary');
    return buf.toString('utf8');
  } catch { return whole; }
});

const store = new Store(cfg.dataDir);
const rows = store.db.prepare(`SELECT upn, scope, folderId, itemId, fileId FROM items
  WHERE format='eml' AND sender IS NULL AND fileId IS NOT NULL
  ${onlyUpn ? 'AND upn=?' : ''}`).all(...(onlyUpn ? [onlyUpn] : []));
console.log(`${rows.length} EML item(s) missing sender`);
const folderPath = new Map();
for (const f of store.db.prepare('SELECT upn, scope, folderId, path FROM folders').all())
  folderPath.set(`${f.upn} ${f.scope} ${f.folderId}`, f.path);
const upd = store.db.prepare('UPDATE items SET sender=COALESCE(sender,?), subject=COALESCE(subject,?), receivedAt=COALESCE(receivedAt,?) WHERE upn=? AND scope=? AND folderId=? AND itemId=?');
const tx = store.db.transaction(batch => { for (const b of batch) upd.run(...b); });
const segs = p => String(p || '').split('/').filter(Boolean).map(safeName);
let done = 0, failed = 0, batch = [];
for (const r of rows) {
  try {
    const f = path.join(cfg.dataDir, 'store', safeName(r.upn), r.scope,
      ...segs(folderPath.get(`${r.upn} ${r.scope} ${r.folderId}`) || ''), r.fileId + '.eml.gz');
    const buf = zlib.gunzipSync(fs.readFileSync(f));
    const head = buf.slice(0, Math.min(buf.length, 32768)).toString('utf8');
    const get = n => { const m = head.match(new RegExp(`^${n}:[ \\t]*((?:[^\\r\\n]*(?:\\r?\\n[ \\t][^\\r\\n]*)*))`, 'im')); return m ? m[1].replace(/\r?\n[ \t]+/g, ' ').trim() : null; };
    const d = get('Date');
    batch.push([dec(get('From')), dec(get('Subject')), d && !isNaN(Date.parse(d)) ? new Date(Date.parse(d)).toISOString() : null, r.upn, r.scope, r.folderId, r.itemId]);
    if (batch.length >= 500) { tx(batch); batch = []; }
    done++;
  } catch { failed++; }
  if (done % 2000 === 0 && done) console.log(`  ${done}…`);
}
if (batch.length) tx(batch);
console.log(`backfilled ${done}, failed ${failed}`);
