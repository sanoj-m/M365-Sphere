// One-time migration: rename legacy base64url(itemId).eml.gz files to sha1 hex
// names and update items.fileId (+ sha256 if missing). Idempotent. --dry = report only.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { safeName } = require('../lib/util');

const dry = process.argv.includes('--dry');
const root = path.resolve(__dirname, '..');
const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
const storeRoot = path.resolve(root, cfg.dataDir || './data', 'store');

const encodeId = id => Buffer.from(String(id), 'utf8').toString('base64url');
const fileIdFor = id => crypto.createHash('sha1').update(String(id)).digest('hex');
const dirFor = (upn, scope, folderPath) =>
  path.join(storeRoot, safeName(upn), scope, ...String(folderPath).split('/').map(safeName));

const db = new Database(path.join(root, cfg.dataDir || './data', 'state.db'));
const rows = db.prepare(`
  SELECT i.upn, i.scope, i.folderId, i.itemId, i.fileId, i.status, i.size, i.sha256, f.path AS folderPath
  FROM items i JOIN folders f ON f.upn = i.upn AND f.scope = i.scope AND f.folderId = i.folderId
  WHERE i.fileId IS NOT NULL`).all();

const upd = db.prepare('UPDATE items SET fileId=?, sha256=COALESCE(sha256, ?) WHERE upn=? AND scope=? AND folderId=? AND itemId=?');
let scanned = 0, migrated = 0, skipped = 0, failed = 0, missing = 0, conflict = 0, corrupt = 0;
const errors = [];

for (const r of rows) {
  const fileId = fileIdFor(r.itemId);
  if (r.fileId === fileId) { skipped++; continue; } // already sha1-named
  scanned++;
  const dir = dirFor(r.upn, r.scope, r.folderPath);
  const legacyFile = path.join(dir, encodeId(r.itemId) + '.eml.gz');
  const newFile = path.join(dir, fileId + '.eml.gz');
  if (!fs.existsSync(legacyFile)) { missing++; continue; } // no legacy file on disk (e.g. deduped/retired)
  if (fs.existsSync(newFile)) {
    conflict++;
    errors.push(`BOTH exist (${r.upn}/${r.scope}${r.folderPath}): ${r.itemId}`);
    continue;
  }
  let raw;
  try {
    raw = zlib.gunzipSync(fs.readFileSync(legacyFile));
  } catch (e) {
    corrupt++;
    errors.push(`gunzip failed (${r.upn}/${r.scope}${r.folderPath}): ${e.message}`);
    continue;
  }
  if (dry) { migrated++; continue; }
  try {
    fs.renameSync(legacyFile, newFile);
    try {
      const sha256 = crypto.createHash('sha256').update(raw).digest('hex');
      db.transaction(() => upd.run(fileId, r.sha256 ? null : sha256, r.upn, r.scope, r.folderId, r.itemId))();
      migrated++;
    } catch (e) {
      fs.renameSync(newFile, legacyFile); // roll back the rename
      throw e;
    }
  } catch (e) {
    failed++;
    errors.push(`rename/db failed (${r.upn}/${r.scope}${r.folderPath}): ${e.message}`);
  }
  if ((migrated + failed) % 500 === 0) console.log(`... ${migrated} migrated, ${failed} failed`);
}

console.log(`\n${dry ? 'DRY RUN — ' : ''}scanned=${scanned} migrated=${migrated} skipped(sha1)=${skipped} legacy-file-missing=${missing} conflict=${conflict} corrupt=${corrupt} failed=${failed}`);
if (errors.length) {
  console.log(`\n${Math.min(errors.length, 20)} of ${errors.length} anomalies:`);
  for (const e of errors.slice(0, 20)) console.log(`  ${e}`);
}
db.close();
process.exit(failed > 0 || (conflict > 0 && !dry) ? 1 : 0);
