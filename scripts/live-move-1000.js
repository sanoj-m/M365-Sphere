// Move 1000–1999 coded child folders of "13 Project(s) - closed" between two
// LIVE mailboxes: archive-projectclosed.2@ → archive-projectclosed@.
// Merge semantics: an email already in the destination folder (same
// internetMessageId, else same subject + received minute) is NOT copied — the
// source copy just moves to Deleted Items. After a folder is fully emptied the
// source folder is deleted. Graph cross-mailbox move = MIME download + upload
// + original dates restored, then source to Deleted Items (recoverable).
//
// Usage: node scripts/live-move-1000.js [--dry]   (default: dry run)
const { GraphClient } = require('../lib/graph');
const { Auth } = require('../lib/auth');
const fs = require('fs');
const path = require('path');

const SRC = process.env.SRC_UPN || 'source@example.com';
const DST = process.env.DST_UPN || 'dest@example.com';
const PARENT_RE = /^13 Projects? - closed$/i;
const CODE_RE = /^(\d{4})\b/;
const DRY = !process.argv.includes('--apply');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
const log = (lvl, m) => console.log(`${new Date().toISOString()} ${lvl} ${m}`);
const graph = new GraphClient(new Auth(cfg), log, cfg);

// Live progress for the dashboard Tasks panel (throttled writes).
const progressFile = path.join(__dirname, '..', 'data', 'live-move-progress.json');
let lastWrite = 0;
const progress = { pid: process.pid, startedAt: new Date().toISOString(), state: 'running', src: SRC, dst: DST, foldersTotal: 0, foldersDone: 0, currentFolder: null, itemsTotal: 0, itemsDone: 0, moved: 0, dupSkipped: 0, failed: 0 };
function writeProgress(force) {
  const now = Date.now();
  if (!force && now - lastWrite < 2000) return;
  lastWrite = now;
  try { fs.writeFileSync(progressFile, JSON.stringify({ ...progress, updatedAt: new Date().toISOString() })); } catch { }
}

const minOf = d => { const t = d ? new Date(d) : null; return t && !isNaN(t) ? t.toISOString().slice(0, 16) : ''; };

async function main() {
  const [srcTree, dstTree] = [await graph.folderTree(SRC), await graph.folderTree(DST)];
  const srcParent = srcTree.find(f => PARENT_RE.test(f.name));
  const dstParent = dstTree.find(f => PARENT_RE.test(f.name));
  if (!srcParent) throw new Error(`source parent folder not found in ${SRC}`);
  if (!dstParent) throw new Error(`destination parent folder not found in ${DST}`);
  log('info', `source parent: "${srcParent.name}" (${srcParent.folderId.slice(0, 12)}…)  dest parent: "${dstParent.name}"`);

  const children = srcTree
    .filter(f => f.parentId === srcParent.folderId)
    .map(f => ({ ...f, code: (CODE_RE.exec(f.name) || [])[1] }))
    .filter(f => f.code && +f.code >= 1000 && +f.code < 2000)
    .sort((a, b) => a.name.localeCompare(b.name));
  const kept = srcTree.filter(f => f.parentId === srcParent.folderId).length - children.length;
  log('info', `${children.length} folder(s) with codes 1000–1999 to move; ${kept} sibling folder(s) (incl. 2000+) stay in ${SRC}`);

  const dstChildren = dstTree.filter(f => f.parentId === dstParent.folderId);

  progress.foldersTotal = children.length;
  progress.itemsTotal = children.reduce((a, f) => a + (f.itemCount || 0), 0);
  writeProgress(true);
  let totalMsgs = 0, toCopy = 0, dups = 0, moved = 0, dupSkipped = 0, failed = 0, foldersDeleted = 0;
  for (const folder of children) {
    const existing = dstChildren.find(d => d.name === folder.name);
    if (DRY) {
      log('info', `[dry] ${folder.name} — ${folder.itemCount} msg(s) → ${existing ? 'merge into existing dest folder' : 'new dest folder'}`);
      totalMsgs += folder.itemCount || 0;
      continue;
    }
    const dstFolder = existing || await graph.ensureChildFolderEx(DST, dstParent.folderId, folder.name).then(r => ({ folderId: r.id, name: folder.name }));
    progress.currentFolder = folder.name;
    writeProgress(true);
    // Destination dedupe keys
    const dstMsgs = await graph.listMessageKeys(DST, dstFolder.folderId);
    const dstKeys = new Set();
    for (const m of dstMsgs) {
      if (m.internetMessageId) dstKeys.add('mid:' + m.internetMessageId);
      dstKeys.add('sk:' + (m.subject || '').trim().toLowerCase() + '|' + minOf(m.receivedDateTime));
    }
    const srcMsgs = await graph.listMessageKeys(SRC, folder.folderId);
    let fMoved = 0, fDup = 0, fFail = 0;
    for (const m of srcMsgs) {
      const isDup = (m.internetMessageId && dstKeys.has('mid:' + m.internetMessageId)) ||
        dstKeys.has('sk:' + (m.subject || '').trim().toLowerCase() + '|' + minOf(m.receivedDateTime));
      try {
        if (!isDup) {
          const mime = await graph.getMessageMime(SRC, m.id);
          const created = await graph.postMessageMime(DST, dstFolder.folderId, mime);
          if (m.receivedDateTime && created && created.id) {
            try { await graph.setMessageDates(DST, created.id, m.receivedDateTime); } catch { }
          }
          fMoved++;
        } else fDup++;
        // Move fully out of the source either way (Deleted Items = recoverable).
        await graph.moveToDeletedItems(SRC, m.id);
      } catch (e) {
        fFail++;
        log('warn', `  FAIL ${folder.name}: ${String(m.subject || '').slice(0, 60)} — ${String(e.message || e).slice(0, 120)}`);
      }
      progress.itemsDone++; progress.moved += 0; writeProgress(false);
    }
    moved += fMoved; dupSkipped += fDup; failed += fFail;
    progress.foldersDone++; progress.moved = moved; progress.dupSkipped = dupSkipped; progress.failed = failed; writeProgress(true);
    // Delete the source folder only when fully emptied.
    let left = -1;
    try { left = await graph.folderItemCount(SRC, folder.folderId); } catch { }
    if (left === 0) {
      try { await graph.deleteFolder(SRC, folder.folderId); foldersDeleted++; } catch (e) { log('warn', `  could not delete empty folder ${folder.name}: ${e.message}`); }
    }
    log('info', `${folder.name}: moved ${fMoved}, duplicates skipped ${fDup}, failed ${fFail}${left === 0 ? ' — source folder deleted' : left > 0 ? ` — ${left} item(s) left (subfolders or failures)` : ''}`);
  }

  if (DRY) {
    log('info', `[dry] TOTAL: ${children.length} folder(s), ${totalMsgs} message(s) would move. Re-run with --apply to execute.`);
  } else {
    progress.state = 'done'; writeProgress(true);
    log('info', `DONE: moved ${moved}, duplicates skipped ${dupSkipped}, failed ${failed}, source folders deleted ${foldersDeleted}/${children.length}`);
  }
}

main().catch(e => { try { progress.state = 'error'; progress.error = String(e.message || e); writeProgress(true); } catch { } console.error('FATAL:', e); process.exit(1); });
