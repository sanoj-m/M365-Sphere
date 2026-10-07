// Local-only duplicate cleanup. The same physical email can be stored several
// times under different API ids (Graph AAMk…, Graph-IE ie-…, exo…, EWS) — e.g.
// once via PST import and once via a compare-page copy. This finds such groups
// INSIDE one folder (same subject, receivedAt within 2 min, size within 10%),
// keeps the copy whose id matches the folder's namespace (else the oldest), and
// retires the extras to the graveyard. Nothing touches the live mailbox, and
// retired files are recoverable from data/store/_graveyard/.
// Usage: node scripts/cleanup-local-dupes.js <upn> [--scope=primary|archive] [--apply]
// Default is a dry run — prints what WOULD be retired, changes nothing.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const D = require('better-sqlite3');
const { itemFile } = require('../lib/preview');
const { safeName } = require('../lib/util');

const upn = process.argv[2];
const apply = process.argv.includes('--apply');
const scopeArg = (process.argv.find(a => a.startsWith('--scope=')) || '').split('=')[1] || null;
if (!upn) { console.error('usage: node scripts/cleanup-local-dupes.js <upn> [--scope=primary|archive] [--apply]'); process.exit(1); }

const dataDir = path.join(__dirname, '..', 'data');
const storeRoot = path.join(dataDir, 'store');
const db = new D(path.join(dataDir, 'state.db'), apply ? {} : { readonly: true });

const folders = db.prepare(`SELECT folderId, scope, parentId, name, path FROM folders WHERE upn=?${scopeArg ? ' AND scope=?' : ''}`)
  .all(...(scopeArg ? [upn, scopeArg] : [upn]));
const folderByKey = new Map(folders.map(f => [f.scope + '|' + f.folderId, f]));
const folderMapByScope = new Map();
for (const f of folders) {
  if (!folderMapByScope.has(f.scope)) folderMapByScope.set(f.scope, new Map());
  folderMapByScope.get(f.scope).set(f.folderId, f);
}

const items = db.prepare(`SELECT itemId, fileId, scope, folderId, subject, receivedAt, size, sha256, updatedAt FROM items
  WHERE upn=? AND status='done' AND fileId IS NOT NULL${scopeArg ? ' AND scope=?' : ''}`)
  .all(...(scopeArg ? [upn, scopeArg] : [upn]));

const ns = id => String(id).startsWith('ie-') ? 'ie' : String(id).startsWith('exo') ? 'exo' : 'raw';
const groups = new Map();
for (const it of items) {
  const s = String(it.subject || '').trim().toLowerCase();
  if (!s) continue;
  const key = it.scope + '|' + it.folderId + '|' + s;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(it);
}

const toRetire = [];
let clusters = 0;
for (const list of groups.values()) {
  if (list.length < 2) continue;
  list.sort((a, b) => String(a.receivedAt).localeCompare(String(b.receivedAt)));
  // Cluster: gap to the previous item > 2 min starts a new cluster.
  let cluster = [list[0]];
  const flush = () => {
    if (cluster.length < 2) return;
    const folderId = cluster[0].folderId;
    cluster.sort((a, b) =>
      ((ns(b.itemId) === ns(b.folderId)) - (ns(a.itemId) === ns(a.folderId)))
      || String(a.updatedAt).localeCompare(String(b.updatedAt)));
    const keeper = cluster[0];
    const dupes = cluster.slice(1).filter(d =>
      (keeper.sha256 && d.sha256 === keeper.sha256)
      || (keeper.size && d.size && Math.abs(d.size - keeper.size) / Math.max(d.size, keeper.size) <= 0.10));
    if (dupes.length) {
      clusters++;
      toRetire.push({ keeper, dupes, folderId });
    }
  };
  for (let i = 1; i < list.length; i++) {
    const gap = Math.abs(+new Date(list[i].receivedAt) - +new Date(list[i - 1].receivedAt));
    if (gap > 120000) { flush(); cluster = []; }
    cluster.push(list[i]);
  }
  flush();
}

const totalDupes = toRetire.reduce((n, g) => n + g.dupes.length, 0);
console.log(`${upn}: ${items.length} stored email(s), ${clusters} duplicate group(s), ${totalDupes} extra cop${totalDupes === 1 ? 'y' : 'ies'} ${apply ? 'to retire' : 'WOULD be retired (dry run — pass --apply)'}`);
for (const g of toRetire.slice(0, 30)) {
  console.log(`\n"${g.keeper.subject}" (${g.keeper.receivedAt}) — keep ${ns(g.keeper.itemId)}:${String(g.keeper.itemId).slice(0, 24)}…`);
  for (const d of g.dupes) console.log(`   retire ${ns(d.itemId)}:${String(d.itemId).slice(0, 24)}… size ${d.size}`);
}
if (toRetire.length > 30) console.log(`\n… and ${toRetire.length - 30} more group(s)`);
if (!apply) process.exit(0);

(async () => {
  let retired = 0, missing = 0;
  const del = db.prepare('DELETE FROM items WHERE upn=? AND scope=? AND folderId=? AND itemId=?');
  const gdir = path.join(storeRoot, '_graveyard', safeName(upn));
  await fsp.mkdir(gdir, { recursive: true });
  for (const g of toRetire) {
    const folder = folderByKey.get(g.keeper.scope + '|' + g.folderId);
    for (const d of g.dupes) {
      const fp = itemFile(storeRoot, upn, d.scope, folder || { name: '', path: '' }, d.fileId, folderMapByScope.get(d.scope));
      try {
        if (fp) await fsp.rename(fp, path.join(gdir, d.fileId + '.eml.gz'));
        else missing++;
        del.run(upn, d.scope, d.folderId, d.itemId);
        retired++;
      } catch (e) {
        console.error(`FAILED ${d.itemId}: ${e.message}`);
      }
    }
  }
  // Recompute stored byte totals (mirrors engine._updateBytes).
  const sums = db.prepare(`SELECT scope, COALESCE(SUM(size),0) b FROM items WHERE upn=? AND status='done' GROUP BY scope`).all(upn);
  let primaryBytes = 0, archiveBytes = 0;
  for (const s of sums) { if (s.scope === 'archive') archiveBytes = s.b; else primaryBytes = s.b; }
  db.prepare('UPDATE mailboxes SET primaryBytes=?, archiveBytes=? WHERE upn=?').run(primaryBytes, archiveBytes, upn);
  console.log(`\nRetired ${retired} duplicate file(s) to ${gdir}${missing ? ` (${missing} file(s) were already missing on disk)` : ''}. Live mailbox untouched.`);
})().catch(e => { console.error(e); process.exit(1); });
