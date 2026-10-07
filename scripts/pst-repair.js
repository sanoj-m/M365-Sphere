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
if (!upn || !pstDir) { console.error('usage: node scripts/pst-repair.js <upn> <pstDir> [--dry]'); process.exit(1); }

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
cfg.dataDir = path.resolve(__dirname, '..', cfg.dataDir || './data');
const store = new Store(cfg.dataDir);
const storeRoot = path.join(cfg.dataDir, 'store');

// condensePaths-style folder name: every non-alphanumeric char → '-'
// (parens are kept by Purview's friendlyName scheme, dashes collapse nothing)
const condense = s => String(s || '').replace(/[^a-zA-Z0-9()]/g, '-');

// Pre-index DB folders for this mailbox: condensed path → folder row.
const folderIndex = new Map();
for (const f of store.db.prepare(`SELECT folderId, name, path, scope FROM folders WHERE upn=?`).all(upn)) {
  const p = String(f.path || '');
  const stripped = p.replace(/^Archive root\//, '');
  folderIndex.set(f.scope + '|' + stripped.split('/').map(condense).join('/'), f);
}

const ARCHIVE_SCOPES = new Set(['archive']);
function resolveFolder(pstPath) {
  // PST roots: '00c-Operations/...' (archive) or 'Inbox'/'Sent Items' (primary)
  for (const scope of ['archive', 'primary']) {
    const f = folderIndex.get(scope + '|' + pstPath);
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

async function processPst(pstPath, log) {
  const pst = new PSTFile(pstPath);
  const rec = { file: path.basename(pstPath), startedAt: new Date().toISOString(), folders: 0, messages: 0, replaced: 0, skipped: 0, unmatched: 0, failed: 0, verifyFailures: 0, bytes: 0 };
  const walk = async (folder, parentPath) => {
    let name = '';
    try { name = folder.displayName || ''; } catch { }
    if (['Top of Personal Folders', 'Search Root', 'IPM_VIEWS', 'IPM_COMMON_VIEWS', 'Recoverable-Items', 'TeamsMessagesData', 'Folder-Memberships', 'SkypeSpacesData', 'SPAM Search Folder 2', 'Deleted Items'].includes(name)) {
      let subs = []; try { subs = folder.getSubFolders(); } catch { }
      if (name !== 'Deleted Items' && name !== 'SPAM Search Folder 2') for (const s of subs) await walk(s, parentPath);
      return;
    }
    const fullPath = parentPath ? `${parentPath}/${name}` : name;
    let emailCount = 0;
    try { emailCount = folder.emailCount || 0; } catch { }
    if (emailCount > 0) {
      const dbFolder = resolveFolder(fullPath);
      if (dbFolder) {
        rec.folders++;
        const scope = dbFolder.scope;
        const dbItems = store.db.prepare(`SELECT * FROM items WHERE upn=? AND scope=? AND folderId=? AND status='done'`).all(upn, scope, dbFolder.folderId);
        const byKey = new Map();
        for (const it of dbItems) {
          const k = `${normSubj(it.subject)}|${minOf(it.receivedAt)}`;
          if (!byKey.has(k)) byKey.set(k, []);
          byKey.get(k).push(it);
        }
        const dir = path.join(storeRoot, safeName(upn), scope, ...String(dbFolder.path || '').split('/').filter(Boolean).map(safeName));
        const upd = store.db.prepare(`UPDATE items SET subject=?, sender=?, receivedAt=?, size=?, sha256=?, format='eml', sourceApi='pst-import' WHERE upn=? AND scope=? AND folderId=? AND itemId=?`);
        for (let i = 0; i < emailCount; i++) {
          let child;
          try { child = folder.getNextChild(); } catch { rec.failed++; continue; }
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
            let dbItem = closest(byKey.get(`${normSubj(subject)}|${minOf(receivedAt)}`));
            if (!dbItem && subject) dbItem = closest(dbItems.filter(it => normSubj(it.subject) === normSubj(subject)));
            if (!dbItem) { rec.unmatched++; continue; }
            if (dbItem.format === 'eml' && !(FORCE && dbItem.sourceApi === 'pst-import')) { rec.skipped++; continue; }
            const eml = buildEml(child);
            // verification: parse + image trailers
            const parsed = await simpleParser(eml);
            const v = verifyImages(parsed);
            if (v.bad) {
              rec.verifyFailures++;
              console.log(`  VERIFY FAIL (${v.bad}/${v.images} images): ${String(subject).slice(0, 60)}`);
            }
            if (!DRY) {
              await fsp.writeFile(path.join(dir, dbItem.fileId + '.tmp'), zlib.gzipSync(eml));
              await fsp.rename(path.join(dir, dbItem.fileId + '.tmp'), path.join(dir, dbItem.fileId + '.eml.gz'));
              await fsp.rm(path.join(dir, dbItem.fileId + '.fts.gz'), { force: true });
              upd.run(subject, sender, receivedAt, eml.length, crypto.createHash('sha256').update(eml).digest('hex'), upn, scope, dbFolder.folderId, dbItem.itemId);
              dbItem.format = 'eml';
            }
            rec.replaced++;
            rec.bytes += eml.length;
            if (rec.replaced % 50 === 0) console.log(`  …${rec.replaced} replaced`);
          } catch (e) { rec.failed++; console.log(`  FAIL: ${String(e.message || e).slice(0, 120)}`); }
        }
      } else {
        // consume messages so the walk stays in sync, count as unmatched-folder
        let n = 0;
        for (let i = 0; i < emailCount; i++) { try { if (!folder.getNextChild()) break; n++; } catch { break; } }
        if (n) console.log(`  no DB folder for PST path "${fullPath}" (${n} msgs)`);
        rec.unmatched += n;
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
  console.log(`${path.basename(pstPath)}: folders ${rec.folders}, msgs ${rec.messages}, replaced ${rec.replaced}, skipped ${rec.skipped}, unmatched ${rec.unmatched}, failed ${rec.failed}, verifyFailures ${rec.verifyFailures}`);
}

(async () => {
  const psts = fs.readdirSync(pstDir).filter(f => f.toLowerCase().endsWith('.pst') && !f.startsWith('~')).sort();
  console.log(`${psts.length} PST(s) in ${pstDir}${DRY ? ' (DRY RUN)' : ''}`);
  const logFile = path.join(cfg.dataDir, 'pst-import-log.json');
  const log = fs.existsSync(logFile) ? JSON.parse(fs.readFileSync(logFile, 'utf8')) : [];
  for (const p of psts) await processPst(path.join(pstDir, p), log);
  if (!DRY) fs.writeFileSync(logFile, JSON.stringify(log, null, 1));
  store.recomputeMailboxBytes(upn);
  console.log('done');
})();
