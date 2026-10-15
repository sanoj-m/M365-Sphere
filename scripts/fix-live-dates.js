// Repair live messages whose received date was stamped with the IMPORT time
// (MIME upload stamps receivedDateTime = upload time; Outlook then shows the
// copy time instead of the email's real date).
//
// Truth sources, in order:
//  1. LOCAL STORE match by internetMessageId: for each live folder, a lazily
//     built map Message-ID → receivedAt from same-named local folders' EML
//     files (they keep the original RFC822 headers). Covers copies uploaded
//     from FTS items whose MIME carries no Date header.
//  2. The live MIME's own Date: header — but ONLY when it disagrees with the
//     upload stamp (Mode A: received≈created, header old). When the header
//     equals the upload time but received is old (Mode B: Exchange rewrote
//     the header at import), received is already right — left untouched.
//
// Dry-run by default; --apply PATCHes PidTagMessageDeliveryTime (0x0E06) and
// PidTagClientSubmitTime (0x0039) via graph.setMessageDates. New uploads
// self-correct in graph.postMessageMime — this fixes the historical ones.
// Usage: node scripts/fix-live-dates.js <upn> [--since YYYY-MM-DD] [--apply]
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const D = require('better-sqlite3');
const { Auth } = require('../lib/auth');
const { GraphClient, mimeDateHeader } = require('../lib/graph');
const { parseMimeHeaders, safeName } = require('../lib/engine');
const { ftsMime } = require('../lib/fts');
const { simpleParser } = require('mailparser');
const crypto = require('crypto');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
cfg.dataDir = path.resolve(__dirname, '..', cfg.dataDir || './data');
const upn = process.argv[2];
const apply = process.argv.includes('--apply');
const sinceArg = (process.argv.find(a => a.startsWith('--since=')) || '').slice(8) || '2026-09-01';
if (!upn) { console.error('usage: node scripts/fix-live-dates.js <upn> [--since YYYY-MM-DD] [--apply]'); process.exit(1); }
const since = new Date(sinceArg);
if (isNaN(+since)) { console.error('bad --since date'); process.exit(1); }

const db = new D(path.join(cfg.dataDir, 'state.db'), { readonly: true });
const normName = s => String(s || '').trim().toLowerCase();
const normMid = s => String(s || '').replace(/[<>]/g, '').trim().toLowerCase();
const localFoldersByName = new Map();
for (const f of db.prepare('SELECT upn, scope, folderId, name, path FROM folders').all()) {
  const k = normName(f.name);
  if (!localFoldersByName.has(k)) localFoldersByName.set(k, []);
  localFoldersByName.get(k).push(f);
}

// A truth date must be plausible: some source EMLs carry garbage Date headers
// (e.g. 2002-01-01 placeholders from broken automated senders) — never patch
// a good received date toward those.
const plausible = d => {
  const t = +new Date(d);
  return !isNaN(t) && t >= +new Date('2008-01-01T00:00:00Z') && t <= Date.now() + 2 * 86400000;
};

// Message-ID → receivedAt from same-named local folders' EML files (lazy).
const midCache = new Map();
function midMapFor(name) {
  const key = normName(name);
  if (midCache.has(key)) return midCache.get(key);
  const map = new Map();
  for (const f of localFoldersByName.get(key) || []) {
    if (f.upn === upn) continue; // truth must come from OTHER mailboxes' copies — the target's own backup rows carry the same upload stamps
    const dir = path.join(cfg.dataDir, 'store', safeName(f.upn), f.scope, ...String(f.path || '').split('/').filter(Boolean).map(safeName));
    const items = db.prepare(`SELECT fileId, receivedAt FROM items WHERE upn=? AND scope=? AND folderId=? AND status='done' AND receivedAt IS NOT NULL AND fileId IS NOT NULL`).all(f.upn, f.scope, f.folderId);
    for (const it of items) {
      if (!plausible(it.receivedAt)) continue;
      const fp = path.join(dir, it.fileId + '.eml.gz');
      if (!fs.existsSync(fp)) continue;
      try {
        const h = parseMimeHeaders(zlib.gunzipSync(fs.readFileSync(fp)));
        if (h.messageId) map.set(h.messageId, it.receivedAt || h.receivedAt);
      } catch { }
    }
  }
  midCache.set(key, map);
  return map;
}

// Content fingerprint: subject + visible text (tags AND entities stripped —
// Exchange re-serializes html attributes/charset/entities on import) +
// attachment bytes (byte-identical across copies).
const visibleText = s => String(s || '')
  .replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, '')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&#(x?[0-9a-f]+);/gi, (_, n) => { try { return String.fromCodePoint(n[0].toLowerCase() === 'x' ? parseInt(n.slice(1), 16) : +n); } catch { return ' '; } })
  .replace(/&(nbsp|amp|lt|gt|quot|apos);/gi, (_, e) => ({ nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[e.toLowerCase()])
  .replace(/\s+/g, '');
async function bodyFp(buf) {
  try {
    const mail = await simpleParser(buf);
    const h = crypto.createHash('sha256');
    h.update(String(mail.subject || '').replace(/\s+/g, ' ').trim().toLowerCase());
    h.update('\x00' + visibleText(mail.html || mail.text));
    const atts = (mail.attachments || []).slice().sort((x, y) => String(x.filename).localeCompare(String(y.filename)));
    for (const a of atts) { h.update(`\x00att${a.filename || ''}:`); h.update(a.content); }
    return h.digest('hex');
  } catch { return null; }
}
const normSubj = s => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();

// fp → Set(receivedAt) for same-named local folders' items with this subject
// (lazy per folder+subject). EML files first (cheap); FTS reconstruction only
// on a second pass when the EML map misses — ftsMime is expensive on big blobs.
const FP_MAX_FILE = 30 * 1024 * 1024; // skip monster files (>30 MB) for fp
const fpCache = new Map();
async function bodyMapFor(folderName, subject, includeFts) {
  const key = normName(folderName) + '|' + normSubj(subject) + (includeFts ? '|fts' : '');
  if (fpCache.has(key)) return fpCache.get(key);
  const map = new Map();
  for (const lf of localFoldersByName.get(normName(folderName)) || []) {
    if (lf.upn === upn) continue; // see midMapFor — own backup rows are stamp-poisoned
    const dir = path.join(cfg.dataDir, 'store', safeName(lf.upn), lf.scope, ...String(lf.path || '').split('/').filter(Boolean).map(safeName));
    const items = db.prepare(`SELECT fileId, receivedAt, subject FROM items WHERE upn=? AND scope=? AND folderId=? AND status='done' AND receivedAt IS NOT NULL AND fileId IS NOT NULL`).all(lf.upn, lf.scope, lf.folderId)
      .filter(it => plausible(it.receivedAt) && normSubj(it.subject) === normSubj(subject));
    for (const it of items) {
      let raw = null;
      const emlPath = path.join(dir, it.fileId + '.eml.gz');
      const ftsPath = path.join(dir, it.fileId + '.fts.gz');
      try {
        if (fs.existsSync(emlPath)) {
          if (fs.statSync(emlPath).size > FP_MAX_FILE) continue;
          raw = zlib.gunzipSync(fs.readFileSync(emlPath));
        } else if (includeFts && fs.existsSync(ftsPath)) {
          if (fs.statSync(ftsPath).size > FP_MAX_FILE) continue;
          raw = ftsMime(zlib.gunzipSync(fs.readFileSync(ftsPath)));
        }
      } catch { raw = null; }
      if (!raw) continue;
      const fp = await bodyFp(raw);
      if (!fp) continue;
      if (!map.has(fp)) map.set(fp, new Set());
      map.get(fp).add(it.receivedAt);
    }
  }
  fpCache.set(key, map);
  return map;
}
async function bodyLookup(folderName, subject, fp) {
  const eml = (await bodyMapFor(folderName, subject, false)).get(fp);
  if (eml && eml.size === 1) return [...eml][0];
  const fts = (await bodyMapFor(folderName, subject, true)).get(fp);
  if (fts && fts.size === 1) return [...fts][0];
  return null;
}

// Hard timeout wrapper: graph.req's socket timeout doesn't always fire on
// stalled streaming reads — never let one message hang the whole pass.
const withTimeout = (p, ms, tag) => Promise.race([
  p,
  new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout ${tag}`)), ms))
]);

(async () => {
  const graph = new GraphClient(new Auth(cfg), () => { }, cfg);
  const tree = await graph.folderTree(upn);
  console.log(`${tree.length} live folders`);
  let scanned = 0, ok = 0, modeB = 0, noDate = 0, wrong = 0, patched = 0, failed = 0, unfixable = 0, close = 0, oldVar = 0;
  const STAMP = 30 * 60 * 1000;
  const t0 = Date.now();
  const processOne = async (f, m, mmap) => {
    scanned++;
    const created = +new Date(m.createdDateTime);
    const recv = +new Date(m.receivedDateTime);
    const stampedR = Math.abs(recv - created) <= STAMP;
    let truth = null, via = null;
    const imid = normMid(m.internetMessageId);
    if (imid && mmap.has(imid)) { truth = mmap.get(imid); via = 'message-id'; }
    if (!truth) {
      let mime;
      try { mime = await withTimeout(graph.getMessageMime(upn, m.id), 90000, 'mime'); } catch { failed++; return; }
      // Content fingerprint against local same-subject copies (covers
      // mailbox-migration Message-ID re-stamps). Only an exact single-date
      // match is trusted — never guess between dates.
      const liveFp = mime ? await withTimeout(bodyFp(mime), 60000, 'fp').catch(() => null) : null;
      if (liveFp) {
        const hit = await bodyLookup(f.name, m.subject, liveFp);
        if (hit) { truth = hit; via = 'content'; }
      }
      if (!truth) {
        const hdr = mime ? mimeDateHeader(mime) : null;
        if (!hdr && !imid) { noDate++; return; }
        // The Date header is trustworthy only when received looks
        // upload-stamped (Mode A) and the header itself is NOT the stamp.
        // When received is old but the header matches the stamp (Mode B),
        // received is already right — leave it.
        const hdrStamped = hdr && Math.abs(+hdr - created) <= STAMP;
        if (hdr && !hdrStamped && stampedR && plausible(hdr)) { truth = hdr.toISOString(); via = 'date-header'; }
      }
    }
    if (!truth) { stampedR ? unfixable++ : modeB++; return; }
    const drift = Math.abs(+new Date(truth) - recv);
    // Only LARGE drifts are upload-stamps. Small differences (minutes to
    // hours) are legitimate: the same email has different delivery times
    // in different mailboxes (routing). Never "fix" those.
    if (drift <= 5 * 60 * 1000) { ok++; return; }
    if (drift <= 24 * 3600 * 1000) { close++; return; }
    // An upload stamp sits in the COPY ERA (this app exists since ~2026-08).
    // Large drifts between two OLD dates are cross-mailbox delivery variance
    // from long ago — not stamps, never touch them.
    if (recv < +new Date('2026-06-01T00:00:00Z')) { oldVar++; return; }
    wrong++;
    if (wrong <= 20 || wrong % 100 === 0) console.log(`wrong(${via}): "${String(m.subject).slice(0, 55)}" received=${m.receivedDateTime} real=${truth}`);
    if (apply) {
      try { await graph.setMessageDates(upn, m.id, truth); patched++; }
      catch (e) { failed++; console.log(`PATCH failed: ${String(e.message || e).slice(0, 120)}`); }
    }
  };
  for (const f of tree) {
    const q = `/users/${encodeURIComponent(upn)}/mailFolders/${encodeURIComponent(f.folderId)}/messages?$select=id,subject,internetMessageId,receivedDateTime,createdDateTime&$top=200`
      + `&$filter=createdDateTime ge ${since.toISOString()}`;
    const fStart = Date.now();
    const fScanned0 = scanned, fWrong0 = wrong;
    const mmap = midMapFor(f.name);
    for await (const batch of graph.pages(q)) {
      // Small pool: overlaps network downloads (graph client self-throttles).
      for (let i = 0; i < batch.length; i += 6) {
        await Promise.all(batch.slice(i, i + 6).map(m => processOne(f, m, mmap)));
        if (scanned % 200 < 6) {
          const rate = Math.round(scanned / ((Date.now() - t0) / 60000));
          console.log(`…${scanned} scanned (${rate}/min), ${wrong} wrong, ${patched} patched — ${f.path || f.name}`);
        }
      }
    }
    console.log(`folder ${f.path || f.name} done: ${scanned - fScanned0} scanned, ${wrong - fWrong0} wrong, ${Math.round((Date.now() - fStart) / 1000)}s`);
  }
  console.log(`${apply ? 'APPLIED' : 'DRY RUN'}: ${scanned} message(s) created since ${sinceArg} — ${wrong} upload-stamped (${patched} patched), ${ok} already correct, ${close} close-match (routing variance, left as-is), ${oldVar} old-dates variance (pre-copy-era, left as-is), ${modeB} header-rewritten-but-received-correct, ${unfixable} unfixable (no source of truth), ${noDate} no date/id, ${failed} failed`);
  if (!apply && wrong) console.log('re-run with --apply to fix them');
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
