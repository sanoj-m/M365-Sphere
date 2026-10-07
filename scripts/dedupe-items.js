// Remove duplicate copies of the same physical message within one folder
// (typically the old EWS .eml.gz copy + the Graph-IE .fts.gz copy of the same
// item). Keeps the copy with the best data: format='eml' (clean) beats
// format='fts' (page-break-corrupted); then a file on disk; then larger size.
// Usage: node scripts/dedupe-items.js [upn] [--dry]
const fs = require('fs');
const path = require('path');
const { Store } = require('../lib/store');
const { safeName } = require('../lib/util');

const upnArg = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : null;
const DRY = process.argv.includes('--dry');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
cfg.dataDir = path.resolve(__dirname, '..', cfg.dataDir || './data');
const store = new Store(cfg.dataDir);
const storeRoot = path.join(cfg.dataDir, 'store');

const groups = store.db.prepare(`
  SELECT upn, scope, folderId, subject, receivedAt, sender, COUNT(*) c
  FROM items WHERE status='done' AND subject IS NOT NULL AND fileId IS NOT NULL
  ${upnArg ? 'AND upn=@upn' : ''}
  GROUP BY upn, scope, folderId, subject, receivedAt, sender HAVING c > 1`).all(...(upnArg ? [{ upn: upnArg }] : []));
console.log(`${groups.length} duplicate group(s)${DRY ? ' (DRY RUN)' : ''}`);

const getItems = store.db.prepare(`SELECT itemId, fileId, format, size FROM items
  WHERE upn=? AND scope=? AND folderId=? AND status='done' AND fileId IS NOT NULL
    AND (subject IS ? OR subject=?) AND (receivedAt IS ? OR receivedAt=?) AND (sender IS ? OR sender=?)`);
const getFolder = store.db.prepare(`SELECT path FROM folders WHERE upn=? AND scope=? AND folderId=?`);

let removed = 0, freed = 0, errors = 0;
for (const g of groups) {
  const rows = getItems.all(g.upn, g.scope, g.folderId, g.subject, g.subject, g.receivedAt, g.receivedAt, g.sender, g.sender);
  if (rows.length < 2) continue;
  const rank = r => (r.format === 'eml' ? 2 : 0) + (r.size || 0) / 1e12;
  rows.sort((a, b) => rank(b) - rank(a));
  const keep = rows[0];
  const folder = getFolder.get(g.upn, g.scope, g.folderId);
  const dir = path.join(storeRoot, safeName(g.upn), g.scope, ...String((folder && folder.path) || '').split('/').filter(Boolean).map(safeName));
  for (const r of rows.slice(1)) {
    try {
      if (!DRY) {
        for (const ext of ['.eml.gz', '.fts.gz']) {
          const f = path.join(dir, r.fileId + ext);
          if (fs.existsSync(f)) { freed += fs.statSync(f).size; fs.rmSync(f, { force: true }); }
        }
        store.deleteItem(g.upn, g.scope, g.folderId, r.itemId);
      } else {
        for (const ext of ['.eml.gz', '.fts.gz']) {
          const f = path.join(dir, r.fileId + ext);
          if (fs.existsSync(f)) freed += fs.statSync(f).size;
        }
      }
      removed++;
    } catch (e) { errors++; console.log(`  FAIL ${r.itemId.slice(0, 20)}: ${String(e.message || e).slice(0, 100)}`); }
  }
}
console.log(`removed ${removed} duplicate item(s), freed ${Math.round(freed / 1024 ** 2)} MB${errors ? `, ${errors} errors` : ''}`);
if (!DRY) { for (const m of store.db.prepare(`SELECT DISTINCT upn FROM items`).all()) store.recomputeMailboxBytes(m.upn); }
