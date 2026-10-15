// Repairs Graph-IE FTS items (page-break-corrupted attachments) from clean
// compliance-export PSTs (e.g. pst-import/user1/*.pst) — REPLACEMENT, not
// duplication: each matched message's .eml.gz overwrites the same fileId, the
// .fts.gz is deleted, and the row becomes format='eml'. No new rows, no extra
// disk usage beyond the swapped content.
//
// Tracking: every run appends a per-PST record to data/pst-import-log.json
// (file, timestamps, matched/replaced/skipped/unmatched/verifyFailures).
//
// Matching per folder: PST condensed path (condensePaths style: each
// non-alphanumeric char run → '-') → DB folder path under 'Archive root'
// (scope archive) or primary paths; then subject+date (minute) inside the
// folder, fallback same-subject closest size. Verification: rebuilt .eml must
// parse, and every image attachment must end with its proper trailer
// (PNG IEND, GIF 0x3B, JPEG FFD9) — failures are counted and logged.
//
// Usage: node scripts/pst-repair.js <upn> <pstDir> [--dry]
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { PSTFile, PSTMessage } = require('pst-extractor');
const { simpleParser } = require('mailparser');
const { Store } = require('../lib/store');
const { safeName } = require('../lib/util');
const { buildEml } = require('../lib/pstingest');

const [upn, pstDir] = process.argv.slice(2);
const DRY = process.argv.includes('--dry');
const FORCE = process.argv.includes('--force'); // rebuild even format='eml' rows made by pst-import
const ONLY = (process.argv.find(a => a.startsWith('--file=')) || '').slice(7) || null; // process a single PST
if (!upn || !pstDir) { console.error('usage: node scripts/pst-repair.js <upn> <pstDir> [--dry] [--file=name.pst]'); process.exit(1); }

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
cfg.dataDir = path.resolve(__dirname, '..', cfg.dataDir || './data');
const store = new Store(cfg.dataDir);
const storeRoot = path.join(cfg.dataDir, 'store');

// Live progress for the dashboard panel (throttled writes).
const progressFile = path.join(cfg.dataDir, 'pst-repair-progress.json');
let startedAt = null;
let lastProgressWrite = 0;
function writeProgress(rec, pstPath, state, force) {
  const now = Date.now();
  if (!force && now - lastProgressWrite < 1500) return;
  lastProgressWrite = now;
  try {
    fs.writeFileSync(progressFile, JSON.stringify({
      pid: process.pid, upn, startedAt, state, updatedAt: new Date().toISOString(),
      current: rec && { file: path.basename(pstPath), folders: rec.folders, messages: rec.messages, replaced: rec.replaced, skipped: rec.skipped, unmatched: rec.unmatched, failed: rec.failed, verifyFailures: rec.verifyFailures }
    }));
  } catch { }
}

// Purview condensed-name style: whitespace → '-', path-illegal chars (except
// '/', which Purview keeps verbatim in display names) → '-', everything else
// (notably + & , ( )) kept. Matches the names inside the exported PSTs.
const condense = s => String(s || '').replace(/\s/g, '-').replace(/[:*?"<>|]/g, '-');

// Pre-index DB folders for this mailbox, two key shapes:
//  - primary: condensed path segments joined by '/'
//  - flat fallback: condensed whole path with '/' → '-' (a '/' INSIDE a real
//    folder name becomes a phantom PST path segment; flattening both sides
//    makes 'Podium-/-Basement' match DB 'Podium / Basement').
const folderIndex = new Map();
const folderFlat = new Map();
const folderSquash = new Map();
const squash = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
for (const f of store.db.prepare(`SELECT folderId, name, path, scope FROM folders WHERE upn=?`).all(upn)) {
  const p = String(f.path || '');
  const stripped = p.replace(/^Archive root\//, '');
  const key = f.scope + '|' + stripped.split('/').map(condense).join('/');
  folderIndex.set(key, f);
  const flat = f.scope + '|' + condense(stripped).replace(/\//g, '-');
  if (!folderFlat.has(flat)) folderFlat.set(flat, f);
  // Last-resort: alnum-only squash — insensitive to EVERY punctuation
  // difference between the real name and Purview's condensed form
  // ('KAFD 3.0' vs 'KAFD-3-0', 'USD 1.3m' vs 'USD-1-3m').
  const sq = f.scope + '|' + squash(stripped);
  if (!folderSquash.has(sq)) folderSquash.set(sq, f);
}

const ARCHIVE_SCOPES = new Set(['archive']);
function resolveFolder(pstPath) {
  // PST roots: '00c-Operations/...' (archive) or 'Inbox'/'Sent Items' (primary)
  const flat = pstPath.replace(/\//g, '-');
  const sq = squash(pstPath);
  for (const scope of ['archive', 'primary']) {
    const f = folderIndex.get(scope + '|' + pstPath) || folderFlat.get(scope + '|' + flat) || folderSquash.get(scope + '|' + sq);
    if (f) return f;
  }
  return null;
}

const normSubj = s => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
const minOf = d => { const t = d ? new Date(d) : null; return t && !isNaN(t) ? t.toISOString().slice(0, 16) : ''; };

function verifyImages(parsed) {
  let bad = 0, n = 0;
  for (const a of parsed.attachments || []) {
    const ct = a.contentType || '';
    const data = a.content;
    if (!data || data.length < 8) continue;
    const isPng = data.slice(0, 4).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47]));
    const isGif = data.slice(0, 3).toString('latin1') === 'GIF';
    const isJpg = data[0] === 0xFF && data[1] === 0xD8;
    if (!isPng && !isGif && !isJpg) continue;
    n++;
    // PST attachment streams may pad with trailing NULs — ignore them.
    let end = data.length;
    while (end > 8 && data[end - 1] === 0) end--;
    if (isPng && !data.slice(end - 8, end).includes(Buffer.from('IEND'))) bad++;
    if (isGif && data[end - 1] !== 0x3B) bad++;
    if (isJpg && !(data[end - 2] === 0xFF && data[end - 1] === 0xD9)) bad++;
  }
  return { images: n, bad };
}

// Lazy mailbox-wide fallback index: subject|received-minute → items (with
// scope + folder path), for PST folders that no longer exist at their exported
// path (renamed/moved/renumbered on the server after the backup ran).
let globalIndex = null;
function loadGlobalIndex() {
  globalIndex = new Map();
  const rows = store.db.prepare(`SELECT i.*, f.path AS folderPath FROM items i JOIN folders f ON f.upn=i.upn AND f.scope=i.scope AND f.folderId=i.folderId
    WHERE i.upn=? AND i.status='done' AND i.subject IS NOT NULL AND i.subject != '' AND i.receivedAt IS NOT NULL`).all(upn);
  for (const it of rows) {
    const k = `${normSubj(it.subject)}|${minOf(it.receivedAt)}`;
    if (!globalIndex.has(k)) globalIndex.set(k, []);
    globalIndex.get(k).push(it);
  }
  console.log(`  mailbox-wide fallback index: ${rows.length} items`);
}

// Insert-as-new for messages the backup never captured — ONLY into folders
// that exist on the server (resolved via resolveFolder / mailbox-wide match).
// PST folders with no server counterpart are counted unmatched, never created
// (user directive 2026-10-08: no folders that don't exist on the archive server).
async function insertNew(child, meta, rec, folderStat) {
  const { dbFolder, fullPath, subject, sender, receivedAt, size0 } = meta;
  if (!dbFolder) return false; // no server folder — caller counts unmatched
  const eml = buildEml(child);
  const sha256 = crypto.createHash('sha256').update(eml).digest('hex');
  const scope = dbFolder.scope;
  const folderRow = dbFolder;
  let mid = null; try { mid = child.internetMessageId || null; } catch { }
  const key = `${folderRow.folderId}|${mid || `${subject || ''}|${receivedAt || ''}|${size0}`}`;
  const itemId = 'pst-' + crypto.createHash('sha1').update(key).digest('hex');
  const fileId = crypto.createHash('sha1').update('pst' + key).digest('hex');
  // Same verification the rebuild path gets: parse + image trailers.
  const parsed = await simpleParser(eml);
  const v = verifyImages(parsed);
  if (v.bad) {
    rec.verifyFailures++; folderStat.verifyFailures++;
    console.log(`  VERIFY FAIL (${v.bad}/${v.images} images): ${String(subject).slice(0, 60)}`);
  }
  if (!DRY) {
    const dir = path.join(storeRoot, safeName(upn), scope, ...String(folderRow.path || '').split('/').filter(Boolean).map(safeName));
    await fsp.mkdir(dir, { recursive: true });
    const existing = store.getItem(upn, scope, folderRow.folderId, itemId);
    if (!(existing && existing.status === 'done' && existing.sha256 === sha256)) {
      await fsp.writeFile(path.join(dir, fileId + '.tmp'), zlib.gzipSync(eml));
      await fsp.rename(path.join(dir, fileId + '.tmp'), path.join(dir, fileId + '.eml.gz'));
    }
    store.upsertItem({ upn, scope, folderId: folderRow.folderId, itemId, fileId, subject, sender, receivedAt, size: eml.length, status: 'done', lastError: null, attempts: 1, sha256, format: 'eml', sourceApi: 'pst-import' });
  }
  // keep the run-local fallback index coherent so later folders match this item
  if (globalIndex && subject && receivedAt) {
    const k = `${normSubj(subject)}|${minOf(receivedAt)}`;
    const arr = globalIndex.get(k) || [];
    arr.push({ folderId: folderRow.folderId, scope, folderPath: folderRow.path });
    globalIndex.set(k, arr);
  }
  return true;
}

async function processPst(pstPath, log) {
  const pst = new PSTFile(pstPath);
  const rec = { file: path.basename(pstPath), startedAt: new Date().toISOString(), folders: 0, messages: 0, replaced: 0, skipped: 0, unmatched: 0, inserted: 0, failed: 0, verifyFailures: 0, bytes: 0, folderStats: [] };
  const walk = async (folder, parentPath) => {
    let name = '';
    try { name = folder.displayName || ''; } catch { }
    // Container roots: not real folders, but real folders hang below them.
    if (['Top of Personal Folders', 'Search Root', 'IPM_VIEWS', 'IPM_COMMON_VIEWS', 'Recoverable-Items', 'TeamsMessagesData', 'Folder-Memberships', 'SkypeSpacesData'].includes(name)) {
      let subs = []; try { subs = folder.getSubFolders(); } catch { }
      for (const s of subs) await walk(s, parentPath);
      return;
    }
    // Search/system leaf folders Purview adds: not part of the mailbox backup,
    // nothing in the DB can ever match them — skip the whole subtree quietly.
    if (['SPAM Search Folder 2', 'Deleted Items', 'Deletions', 'Purges', 'Audits', 'DiscoveryHolds', 'Versions', 'SubstrateHolds', 'TeamsMeetings', 'Flagged-Emails', 'ApplicationDataRoot', 'ComplianceMetadata', 'SubstrateContacts', 'OneNotePagePreviews', 'Recipient-Cache', 'Contacts'].includes(name)) return;
    const fullPath = parentPath ? `${parentPath}/${name}` : name;
    let emailCount = 0;
    try { emailCount = folder.emailCount || 0; } catch { }
    if (emailCount > 0) {
      const dbFolder = resolveFolder(fullPath);
      let dbItems = null, byKey = null;
      if (dbFolder) {
        rec.folders++;
        dbItems = store.db.prepare(`SELECT i.*, f.path AS folderPath FROM items i JOIN folders f ON f.upn=i.upn AND f.scope=i.scope AND f.folderId=i.folderId WHERE i.upn=? AND i.scope=? AND i.folderId=? AND i.status='done'`).all(upn, dbFolder.scope, dbFolder.folderId);
        byKey = new Map();
        for (const it of dbItems) {
          const k = `${normSubj(it.subject)}|${minOf(it.receivedAt)}`;
          if (!byKey.has(k)) byKey.set(k, []);
          byKey.get(k).push(it);
        }
      } else {
        // Folder renamed/moved/renumbered on the server since the backup:
        // match its emails mailbox-wide so they still rebuild where the copy lives now.
        if (!globalIndex) loadGlobalIndex();
        byKey = globalIndex;
        console.log(`  folder not in DB, mailbox-wide match: "${fullPath}" (${emailCount} msgs)`);
      }
      const folderStat = { path: dbFolder ? (dbFolder.path || fullPath) : fullPath, replaced: 0, skipped: 0, unmatched: 0, inserted: 0, failed: 0, verifyFailures: 0 };
      rec.folderStats.push(folderStat);
      const upd = store.db.prepare(`UPDATE items SET subject=?, sender=?, receivedAt=?, size=?, sha256=?, format='eml', sourceApi='pst-import' WHERE upn=? AND scope=? AND folderId=? AND itemId=?`);
      for (let i = 0; i < emailCount; i++) {
        try {
        let child;
        try { child = folder.getNextChild(); } catch (e) { rec.failed++; folderStat.failed++; if (folderStat.failed === 1) console.log(`  unreadable message(s) in ${folderStat.path}: ${String(e.message || e).slice(0, 100)}`); continue; }
        if (!child) break;
        if (!(child instanceof PSTMessage)) continue;
        rec.messages++;
        try {
          const subject = (() => { try { return child.subject || null; } catch { return null; } })();
          const receivedAt = (() => { try { return child.messageDeliveryTime ? child.messageDeliveryTime.toISOString() : null; } catch { return null; } })();
          const senderName = (() => { try { return child.senderName || null; } catch { return null; } })();
          const senderEmail = (() => { try { return child.senderEmailAddress || null; } catch { return null; } })();
          const sender = senderEmail && senderEmail.includes('@') ? (senderName ? `${senderName} <${senderEmail}>` : senderEmail) : (senderName || senderEmail);
          const size0 = (() => { try { return Number(child.messageSize || 0); } catch { return 0; } })();
          const closest = arr => arr && arr.length
            ? arr.reduce((a, b) => Math.abs((b.size || 0) - size0) < Math.abs((a.size || 0) - size0) ? b : a)
            : null;
          const key = `${normSubj(subject)}|${minOf(receivedAt)}`;
          let targets;
          if (dbFolder) {
            const one = closest(byKey.get(key)) || (subject ? closest(dbItems.filter(it => normSubj(it.subject) === normSubj(subject))) : null);
            targets = one ? [one] : [];
          } else {
            targets = (subject && receivedAt) ? (byKey.get(key) || []) : [];
          }
          if (!targets.length) {
            // Never captured by the backup: insert as a new item — but ONLY
            // into a folder that exists on the server; otherwise unmatched.
            try {
              const ok = await insertNew(child, { dbFolder, fullPath, subject, sender, receivedAt, size0 }, rec, folderStat);
              if (ok) { rec.inserted++; folderStat.inserted++; } else { rec.unmatched++; folderStat.unmatched++; }
            } catch (e) { rec.failed++; folderStat.failed++; console.log(`  FAIL insert: ${String(e.message || e).slice(0, 120)}`); }
            continue;
          }
          // PST is primary: replace any matched local copy — except an
          // identical earlier pst-import rebuild (cheap idempotency).
          let eml = null, sha = null;
          for (const dbItem of targets) {
            if (dbItem.format === 'eml' && dbItem.sourceApi === 'pst-import' && !FORCE) { rec.skipped++; folderStat.skipped++; continue; }
            if (!eml) { eml = buildEml(child); sha = crypto.createHash('sha256').update(eml).digest('hex'); }
            if (dbItem.sourceApi === 'pst-import' && dbItem.sha256 === sha && !FORCE) { rec.skipped++; folderStat.skipped++; continue; }
            // verification: parse + image trailers
            const parsed = await simpleParser(eml);
            const v = verifyImages(parsed);
            if (v.bad) {
              rec.verifyFailures++;
              folderStat.verifyFailures++;
              console.log(`  VERIFY FAIL (${v.bad}/${v.images} images): ${String(subject).slice(0, 60)}`);
            }
            if (!DRY) {
              const dir = path.join(storeRoot, safeName(upn), dbItem.scope, ...String(dbItem.folderPath || '').split('/').filter(Boolean).map(safeName));
              await fsp.mkdir(dir, { recursive: true });
              await fsp.writeFile(path.join(dir, dbItem.fileId + '.tmp'), zlib.gzipSync(eml));
              await fsp.rename(path.join(dir, dbItem.fileId + '.tmp'), path.join(dir, dbItem.fileId + '.eml.gz'));
              await fsp.rm(path.join(dir, dbItem.fileId + '.fts.gz'), { force: true });
              upd.run(subject, sender, receivedAt, eml.length, sha, upn, dbItem.scope, dbItem.folderId, dbItem.itemId);
              dbItem.format = 'eml';
            }
            rec.replaced++;
            folderStat.replaced++;
            rec.bytes += eml.length;
            if (rec.replaced % 50 === 0) console.log(`  …${rec.replaced} replaced`);
          }
        } catch (e) { rec.failed++; folderStat.failed++; console.log(`  FAIL: ${String(e.message || e).slice(0, 120)}`); }
        } catch { } finally { writeProgress(rec, pstPath, 'running'); }
      }
    }
    let subs = [];
    try { subs = folder.getSubFolders(); } catch { }
    for (const sub of subs) await walk(sub, name === 'Top-of-Information-Store' || name === '' ? parentPath : fullPath);
  };
  try {
    await walk(pst.getRootFolder(), '');
  } finally {
    try { pst.close(); } catch { }
  }
  rec.finishedAt = new Date().toISOString();
  log.push(rec);
  console.log(`${path.basename(pstPath)}: folders ${rec.folders}, msgs ${rec.messages}, replaced ${rec.replaced}, skipped ${rec.skipped}, unmatched ${rec.unmatched}, inserted ${rec.inserted}, failed ${rec.failed}, verifyFailures ${rec.verifyFailures}`);
}

(async () => {
  startedAt = new Date().toISOString();
  let psts = fs.readdirSync(pstDir).filter(f => f.toLowerCase().endsWith('.pst') && !f.startsWith('~')).sort();
  if (ONLY) {
    if (!psts.includes(ONLY)) { console.error(`PST not found: ${ONLY}`); process.exit(1); }
    psts = [ONLY];
  }
  console.log(`${psts.length} PST(s) in ${pstDir}${ONLY ? ` (only ${ONLY})` : ''}${DRY ? ' (DRY RUN)' : ''}`);
  const logFile = path.join(cfg.dataDir, 'pst-import-log.json');
  const log = fs.existsSync(logFile) ? JSON.parse(fs.readFileSync(logFile, 'utf8')) : [];
  for (const p of psts) {
    await processPst(path.join(pstDir, p), log);
    if (!DRY) fs.writeFileSync(logFile, JSON.stringify(log, null, 1)); // per-file: panel table updates live
  }
  writeProgress(null, null, 'done', true);
  store.recomputeMailboxBytes(upn);
  console.log('done');
})();
