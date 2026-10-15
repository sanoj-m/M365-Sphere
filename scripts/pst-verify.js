// Verifies every PST in a directory: opens it, walks all folders, and tries
// to read every message. Per-file result appended to data/pst-verify-log.json:
// { file, checkedAt, status: 'ok'|'failed', folders, messages, failedMessages,
//   retry, remark } — failed files get retry:true and a remark with the reason.
//
// Usage: node scripts/pst-verify.js <upn> <pstDir>
const fs = require('fs');
const path = require('path');
const { PSTFile, PSTMessage } = require('pst-extractor');

const [upn, pstDir] = process.argv.slice(2);
const ONLY = (process.argv.find(a => a.startsWith('--file=')) || '').slice(7) || null;
if (!upn || !pstDir) { console.error('usage: node scripts/pst-verify.js <upn> <pstDir> [--file=name.pst]'); process.exit(1); }

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
cfg.dataDir = path.resolve(__dirname, '..', cfg.dataDir || './data');

function verifyPst(pstPath) {
  const rec = { file: path.basename(pstPath), checkedAt: new Date().toISOString(), status: 'ok', folders: 0, messages: 0, failedMessages: 0, retry: false, remark: '' };
  const reasons = [];
  const note = m => { if (reasons.length < 5 && !reasons.includes(m)) reasons.push(m); };
  let pst;
  try {
    pst = new PSTFile(pstPath);
  } catch (e) {
    rec.status = 'failed'; rec.retry = true;
    rec.remark = `cannot open PST: ${String(e.message || e).slice(0, 200)}`;
    return rec;
  }
  // Container system folders: don't read their messages, but DO descend.
  const CONTAINERS = new Set(['Top of Personal Folders', 'Search Root', 'IPM_VIEWS', 'IPM_COMMON_VIEWS', 'Recoverable-Items', 'TeamsMessagesData', 'Folder-Memberships', 'SkypeSpacesData']);
  // Leaf system/search folders: skip entirely (they throw benign btree errors).
  const SKIP = new Set(['SPAM Search Folder 2', 'Purges', 'Versions', 'Audits', 'SubstrateHolds', 'DiscoveryHolds', 'Deleted Items']);
  const walk = folder => {
    let name = '';
    try { name = folder.displayName || ''; } catch { }
    if (SKIP.has(name)) return;
    if (CONTAINERS.has(name)) {
      let subs = []; try { subs = folder.getSubFolders(); } catch { }
      for (const s of subs) walk(s);
      return;
    }
    let emailCount = 0;
    try { emailCount = folder.emailCount || 0; } catch (e) { note(`emailCount: ${String(e.message || e).slice(0, 80)}`); }
    if (emailCount > 0) {
      rec.folders++;
      let read = 0;
      for (let i = 0; i < emailCount; i++) {
        let child;
        try { child = folder.getNextChild(); } catch (e) {
          rec.failedMessages++;
          note(`read message: ${String(e.message || e).slice(0, 80)}`);
          continue;
        }
        if (!child) break;
        if (!(child instanceof PSTMessage)) continue;
        read++;
        try { void child.subject; void child.messageSize; } catch (e) {
          rec.failedMessages++;
          note(`message props: ${String(e.message || e).slice(0, 80)}`);
        }
      }
      rec.messages += read;
      if (read < emailCount - rec.failedMessages) note(`short read: ${read}/${emailCount} messages readable`);
    }
    let subs = [];
    try { subs = folder.getSubFolders(); } catch (e) { note(`subfolders: ${String(e.message || e).slice(0, 80)}`); }
    for (const s of subs) walk(s);
  };
  try {
    walk(pst.getRootFolder());
  } catch (e) {
    rec.status = 'failed'; rec.retry = true;
    rec.remark = `walk aborted: ${String(e.message || e).slice(0, 200)}`;
  } finally {
    try { pst.close(); } catch { }
  }
  // Only genuinely unreadable MESSAGES fail a PST. Subfolder-enumeration notes
  // (e.g. 'SPAM Search Folder 2' — a search folder with no real subfolder
  // table) are recorded as an informational remark but stay status 'ok'.
  if (rec.status === 'ok' && (rec.failedMessages > 0 || reasons.length)) {
    rec.remark = `${rec.failedMessages} unreadable message(s). ${reasons.join('; ')}`.slice(0, 300);
    if (rec.failedMessages > 0) { rec.status = 'failed'; rec.retry = true; }
  }
  return rec;
}

(async () => {
  let psts = fs.readdirSync(pstDir).filter(f => f.toLowerCase().endsWith('.pst') && !f.startsWith('~')).sort();
  if (ONLY) {
    if (!psts.includes(ONLY)) { console.error(`PST not found: ${ONLY}`); process.exit(1); }
    psts = [ONLY];
  }
  console.log(`${psts.length} PST(s) to verify in ${pstDir}`);
  const logFile = path.join(cfg.dataDir, 'pst-verify-log.json');
  const log = fs.existsSync(logFile) ? JSON.parse(fs.readFileSync(logFile, 'utf8')) : [];
  let ok = 0, failed = 0;
  for (const p of psts) {
    const rec = verifyPst(path.join(pstDir, p));
    log.push(rec);
    rec.status === 'ok' ? ok++ : failed++;
    console.log(`${rec.file}: ${rec.status.toUpperCase()} folders ${rec.folders}, msgs ${rec.messages}, failedMsgs ${rec.failedMessages}${rec.remark ? ' — ' + rec.remark : ''}`);
    fs.writeFileSync(logFile, JSON.stringify(log, null, 1));
  }
  console.log(`done: ${ok} ok, ${failed} failed (marked retry:true in ${logFile})`);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
