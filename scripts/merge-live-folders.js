// Merge live-mailbox folders: move every message from the source folders into
// the destination folder, merging same-named subfolders (never duplicating),
// creating destination subfolders as needed. Messages already present in the
// destination (same internetMessageId, or same subject+receivedDateTime) are
// SKIPPED as duplicates. Source folders are deleted only when empty — except
// folders whose only remaining messages are verified duplicates (their twins
// are safe in the destination); anything else left behind stops the delete.
// Moves preserve receivedDateTime. Dry-run by default; --apply executes.
// Usage: node scripts/merge-live-folders.js <upn> --src "60 Bids - declined" --src "61 Bids - declined" --dst "61 Bids - declined (historic)" [--apply]
const fs = require('fs');
const path = require('path');
const { Auth } = require('../lib/auth');
const { GraphClient } = require('../lib/graph');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
const upn = process.argv[2];
const apply = process.argv.includes('--apply');
const srcs = process.argv.flatMap((a, i) => a === '--src' ? [process.argv[i + 1]] : []);
const dstName = (process.argv[process.argv.indexOf('--dst') + 1] || '');
if (!upn || !srcs.length || !dstName) { console.error('usage: … <upn> --src "A" [--src "B"] --dst "C" [--apply]'); process.exit(1); }

const norm = s => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
const keyOf = m => normMid(m.internetMessageId) || `s:${norm(m.subject)}|${m.receivedDateTime || ''}`;
const normMid = s => String(s || '').replace(/[<>]/g, '').trim().toLowerCase();

(async () => {
  const graph = new GraphClient(new Auth(cfg), (...a) => console.log('[graph]', ...a), cfg);
  const tree = await graph.folderTree(upn);
  const byId = new Map(tree.map(f => [f.folderId, f]));
  const childrenOf = pid => tree.filter(f => (f.parentId || null) === pid);
  const dstRoot = tree.find(f => !f.parentId && norm(f.name) === norm(dstName));
  const srcRoots = srcs.map(s => tree.find(f => !f.parentId && norm(f.name) === norm(s)));
  if (!dstRoot) throw new Error(`destination root not found: ${dstName}`);
  for (const [i, s] of srcs.entries()) if (!srcRoots[i]) throw new Error(`source root not found: ${s}`);
  console.log(`${apply ? 'APPLY' : 'DRY RUN'} — merge ${srcs.map(s => `"${s}"`).join(' + ')} → "${dstName}"`);

  const virtual = new Map(); // dstParentId|normName -> fake node (dry-run creations)
  const dstChild = async (parentId, name) => {
    const hit = childrenOf(parentId).find(f => norm(f.name) === norm(name)) || virtual.get(parentId + '|' + norm(name));
    if (hit) return { node: hit, created: false };
    if (apply) {
      const id = await graph.ensureChildFolder(upn, parentId, name);
      const node = { folderId: id, parentId, name, itemCount: 0 };
      tree.push(node);
      return { node, created: true };
    }
    const node = { folderId: 'virtual-' + parentId + '|' + norm(name), parentId, name, itemCount: 0 };
    virtual.set(parentId + '|' + norm(name), node);
    return { node, created: true };
  };

  const keyCache = new Map(); // folderId -> Set(keys) (live dst folders only; virtual start empty)
  const dstKeys = async fid => {
    if (keyCache.has(fid)) return keyCache.get(fid);
    const set = new Set();
    if (!String(fid).startsWith('virtual-')) {
      for await (const batch of graph.pages(`/users/${encodeURIComponent(upn)}/mailFolders/${encodeURIComponent(fid)}/messages?$select=id,internetMessageId,subject,receivedDateTime&$top=200`))
        for (const m of batch) set.add(keyOf(m));
    }
    keyCache.set(fid, set);
    return set;
  };

  const stat = { foldersMovedContent: 0, foldersCreated: 0, foldersMerged: 0, moved: 0, dupesSkipped: 0, deletedEmpty: 0, deletedDupesOnly: 0, keptNonEmpty: 0, dupesDiscarded: 0, errors: 0 };
  const mergeFolder = async (src, dstParent, depth) => {
    const pad = '  '.repeat(depth);
    // 1. direct messages → dstParent (dedupe). List ALL ids first: paging
    // through a folder while moving its messages corrupts the continuation —
    // messages get silently skipped (that was the 2026-10-14 leftover bug).
    const dstKeys0 = await dstKeys(dstParent.folderId);
    const pending = [];
    for await (const batch of graph.pages(`/users/${encodeURIComponent(upn)}/mailFolders/${encodeURIComponent(src.folderId)}/messages?$select=id,internetMessageId,subject,receivedDateTime&$top=200`))
      for (const m of batch) pending.push(m);
    let listed = pending.length;
    for (const m of pending) {
      const k = keyOf(m);
      if (dstKeys0.has(k)) { stat.dupesSkipped++; continue; }
      if (apply) {
        try { await graph.moveMessage(upn, m.id, dstParent.folderId); stat.moved++; dstKeys0.add(k); }
        catch (e) { stat.errors++; console.log(`${pad}MOVE FAIL "${String(m.subject).slice(0, 60)}": ${String(e.message || e).slice(0, 120)}`); }
      } else { stat.moved++; dstKeys0.add(k); }
    }
    if (listed) { stat.foldersMovedContent++; console.log(`${pad}${src.name}: ${apply ? 'moved' : 'would move'} ${stat.moved} so far…`); }
    // 2. children: merge into same-named dst child (created as needed)
    for (const c of childrenOf(src.folderId)) {
      const { node: dc, created } = await dstChild(dstParent.folderId, c.name);
      if (created) stat.foldersCreated++; else stat.foldersMerged++;
      await mergeFolder(c, dc, depth + 1);
    }
    // 3. delete source folder when safe
    const fresh = apply ? await graph.getJson(`/users/${encodeURIComponent(upn)}/mailFolders/${encodeURIComponent(src.folderId)}?$select=id,totalItemCount,childFolderCount`) : { totalItemCount: stat.moved === 0 ? 0 : undefined, childFolderCount: 0 };
    const remaining = apply ? (fresh.totalItemCount || 0) : 0;
    const kidsLeft = apply ? (fresh.childFolderCount || 0) : 0;
    if (apply && kidsLeft === 0 && remaining === 0) {
      await graph.deleteFolder(upn, src.folderId); stat.deletedEmpty++;
      console.log(`${pad}deleted empty: ${src.name}`);
    } else if (apply && kidsLeft === 0 && remaining > 0) {
      // everything left should be verified duplicates — confirm before deleting
      const dstK = await dstKeys(dstParent.folderId);
      let dupes = 0, alien = 0;
      for await (const batch of graph.pages(`/users/${encodeURIComponent(upn)}/mailFolders/${encodeURIComponent(src.folderId)}/messages?$select=id,internetMessageId,subject,receivedDateTime&$top=200`))
        for (const m of batch) (dstK.has(keyOf(m)) ? dupes++ : alien++);
      if (alien === 0 && dupes > 0) {
        await graph.deleteFolder(upn, src.folderId); stat.deletedDupesOnly++; stat.dupesDiscarded += dupes;
        console.log(`${pad}deleted dupes-only: ${src.name} (${dupes} verified duplicate copy/copies discarded — twins safe in destination)`);
      } else {
        stat.keptNonEmpty++;
        console.log(`${pad}KEPT non-empty: ${src.name} — ${remaining} item(s) (${alien} NOT in destination!) — not deleted`);
      }
    } else if (!apply) {
      stat.deletedEmpty++; // optimistic dry-run accounting
    }
  };

  for (const s of srcRoots) await mergeFolder(s, dstRoot, 0);
  console.log(`${apply ? 'APPLIED' : 'DRY RUN'} result:`, JSON.stringify(stat));
  console.log(`moves: ${stat.moved} message(s), dupes skipped: ${stat.dupesSkipped}, dst folders created: ${stat.foldersCreated}, merged: ${stat.foldersMerged}, src folders deleted: ${stat.deletedEmpty}${stat.deletedDupesOnly ? ` (+${stat.deletedDupesOnly} dupes-only, ${stat.dupesDiscarded} dupe copies discarded)` : ''}, kept non-empty: ${stat.keptNonEmpty}, errors: ${stat.errors}`);
  if (!apply) console.log('re-run with --apply to execute');
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
