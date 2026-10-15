// Cleanup for folders created by pst-repair's insert-as-new:
//  1. Purview 'ApplicationDataRoot' analytics subtrees (not email) — deleted.
//  2. 'exo' folders whose whole path squash-matches a REAL folder in the same
//     scope (e.g. '05b-VOs-submitted/4275-Podium-/-Basement' ==
//     '05b VOs submitted/4275 Podium / Basement') — items + files merged into
//     the real folder, exo folder removed.
//  3. Leftover empty exo ancestors pruned bottom-up; orphaned exo folders
//     (deleted parent) remounted at root.
// Dry run by default; pass --apply to execute.
// Usage: node scripts/cleanup-pst-folders.js <upn> [--apply]
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { Store } = require('../lib/store');
const { safeName } = require('../lib/util');

const [upn] = process.argv.slice(2);
const APPLY = process.argv.includes('--apply');
if (!upn) { console.error('usage: node scripts/cleanup-pst-folders.js <upn> [--apply]'); process.exit(1); }
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
const dataDir = path.resolve(__dirname, '..', cfg.dataDir || './data');
const store = new Store(dataDir);
const storeRoot = path.join(dataDir, 'store');
const squash = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const dirOf = (scope, p) => path.join(storeRoot, safeName(upn), scope, ...String(p || '').split('/').filter(Boolean).map(safeName));

(async () => {
  const folders = store.db.prepare(`SELECT scope, folderId, parentId, path FROM folders WHERE upn=?`).all(upn);
  const byId = new Map(folders.map(f => [f.scope + '|' + f.folderId, f]));
  const isExo = f => f.folderId.startsWith('exo');
  const realBySquash = new Map();
  for (const f of folders) if (!isExo(f) && f.path) {
    const k = f.scope + '|' + squash(f.path);
    if (!realBySquash.has(k)) realBySquash.set(k, f);
  }
  const itemCount = f => store.db.prepare(`SELECT COUNT(*) n FROM items WHERE upn=? AND scope=? AND folderId=?`).get(upn, f.scope, f.folderId).n;
  const plan = { appDataDeleted: 0, merged: [], pruned: 0, remounted: 0 };

  const delFolder = f => {
    const items = store.db.prepare(`SELECT itemId, fileId FROM items WHERE upn=? AND scope=? AND folderId=?`).all(upn, f.scope, f.folderId);
    if (APPLY) {
      for (const it of items) for (const ext of ['.eml.gz', '.fts.gz'])
        fsp.rm(path.join(dirOf(f.scope, f.path), (it.fileId || '') + ext), { force: true }).catch(() => { });
      store.db.prepare(`DELETE FROM items WHERE upn=? AND scope=? AND folderId=?`).run(upn, f.scope, f.folderId);
      store.db.prepare(`DELETE FROM folders WHERE upn=? AND scope=? AND folderId=?`).run(upn, f.scope, f.folderId);
    }
    plan.appDataDeleted += items.length;
    byId.delete(f.scope + '|' + f.folderId);
  };

  // 1. ApplicationDataRoot subtrees (deepest first so children go before parents)
  const appData = folders.filter(f => isExo(f) && (f.path === 'ApplicationDataRoot' || String(f.path).startsWith('ApplicationDataRoot/')))
    .sort((a, b) => b.path.length - a.path.length);
  for (const f of appData) delFolder(f);

  // 2. Merge exo folders that squash-match a real folder (deepest first)
  const exoRest = [...byId.values()].filter(isExo).sort((a, b) => String(b.path).length - String(a.path).length);
  for (const f of exoRest) {
    const real = realBySquash.get(f.scope + '|' + squash(f.path));
    if (!real) continue;
    const items = store.db.prepare(`SELECT itemId, fileId FROM items WHERE upn=? AND scope=? AND folderId=?`).all(upn, f.scope, f.folderId);
    plan.merged.push({ from: f.path, to: real.path, items: items.length });
    if (APPLY) {
      for (const it of items) {
        if (!it.fileId) continue;
        for (const ext of ['.eml.gz', '.fts.gz']) {
          const src = path.join(dirOf(f.scope, f.path), it.fileId + ext);
          const dstDir = dirOf(real.scope, real.path);
          await fsp.mkdir(dstDir, { recursive: true }).catch(() => { });
          await fsp.rename(src, path.join(dstDir, it.fileId + ext)).catch(() => { });
        }
      }
      store.db.prepare(`UPDATE items SET folderId=? WHERE upn=? AND scope=? AND folderId=?`).run(real.folderId, upn, f.scope, f.folderId);
      store.db.prepare(`DELETE FROM folders WHERE upn=? AND scope=? AND folderId=?`).run(upn, f.scope, f.folderId);
    }
    byId.delete(f.scope + '|' + f.folderId);
  }

  // 3. Prune empty exo ancestors bottom-up; remount orphans at root
  let changed = true;
  while (changed) {
    changed = false;
    const hasChild = new Set();
    for (const f of byId.values()) if (f.parentId) hasChild.add(f.scope + '|' + f.parentId);
    for (const f of [...byId.values()].filter(isExo)) {
      if (!hasChild.has(f.scope + '|' + f.folderId) && itemCount(f) === 0) {
        if (APPLY) store.db.prepare(`DELETE FROM folders WHERE upn=? AND scope=? AND folderId=?`).run(upn, f.scope, f.folderId);
        byId.delete(f.scope + '|' + f.folderId);
        plan.pruned++;
        changed = true;
      }
    }
  }
  for (const f of [...byId.values()].filter(isExo)) {
    if (f.parentId && !byId.has(f.scope + '|' + f.parentId)) {
      if (APPLY) store.db.prepare(`UPDATE folders SET parentId=NULL WHERE upn=? AND scope=? AND folderId=?`).run(upn, f.scope, f.folderId);
      plan.remounted++;
    }
  }

  if (APPLY) store.recomputeMailboxBytes(upn);
  console.log(APPLY ? 'APPLIED' : 'DRY RUN', JSON.stringify({ ...plan, merged: plan.merged.length }, null, 1));
  for (const m of plan.merged) console.log(`  merge ${m.items}x "${m.from}" -> "${m.to}"`);
})();
