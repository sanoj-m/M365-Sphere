// Verify every stored email's embedded images: attachment end-markers
// (PNG/GIF/JPEG) + inline cid: references must resolve to an attachment.
// Writes data/image-verify-report.json (per-folder counts + bad item list) and
// prints a summary. Read-only.
// Usage: node scripts/verify-images.js <upn> [--scope=archive] [--source=pst-import]
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { simpleParser } = require('mailparser');
const { Store } = require('../lib/store');
const { safeName } = require('../lib/util');

const upn = process.argv[2];
if (!upn) { console.error('usage: node scripts/verify-images.js <upn> [--scope=archive] [--source=pst-import]'); process.exit(1); }
const scopeArg = (process.argv.find(a => a.startsWith('--scope=')) || '').split('=')[1] || null;
const sourceArg = (process.argv.find(a => a.startsWith('--source=')) || '').split('=')[1] || null;

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
cfg.dataDir = path.resolve(__dirname, '..', cfg.dataDir || './data');
const store = new Store(cfg.dataDir);
const storeRoot = path.join(cfg.dataDir, 'store');

function checkImages(parsed) {
  const bad = [];
  const cids = new Set((parsed.attachments || []).map(a => a.cid).filter(Boolean));
  for (const a of parsed.attachments || []) {
    const d = a.content;
    if (!d || d.length < 8) { if ((a.contentType || '').startsWith('image/')) bad.push(`${a.filename || '?'}: empty`); continue; }
    const isPng = d.slice(0, 4).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47]));
    const isGif = d.slice(0, 3).toString('latin1') === 'GIF';
    const isJpg = d[0] === 0xFF && d[1] === 0xD8;
    if (!isPng && !isGif && !isJpg) continue;
    let end = d.length;
    while (end > 8 && d[end - 1] === 0) end--;
    if (isPng && !d.slice(end - 8, end).includes(Buffer.from('IEND'))) bad.push(`${a.filename || '?'}: truncated PNG`);
    if (isGif && d[end - 1] !== 0x3B) bad.push(`${a.filename || '?'}: truncated GIF`);
    if (isJpg && !(d[end - 2] === 0xFF && d[end - 1] === 0xD9)) bad.push(`${a.filename || '?'}: truncated JPEG`);
  }
  if (parsed.html) {
    for (const m of String(parsed.html).matchAll(/cid:([^"'\s>]+)/g)) {
      const cid = m[1];
      if (!cids.has(cid) && !parsed.attachments.some(a => a.cid && cid.includes(a.cid)) && !parsed.attachments.some(a => a.filename && cid.toLowerCase().includes(a.filename.toLowerCase())))
        bad.push(`unresolved cid: ${cid.slice(0, 40)}`);
    }
  }
  return bad;
}

(async () => {
  const where = [`i.upn=?`, `i.status='done'`, `i.fileId IS NOT NULL`, `i.format='eml'`];
  const args = [upn];
  if (scopeArg) { where.push('i.scope=?'); args.push(scopeArg); }
  if (sourceArg) { where.push('i.sourceApi=?'); args.push(sourceArg); }
  const rows = store.db.prepare(`SELECT i.itemId, i.fileId, i.subject, i.size, i.sourceApi, f.path, f.scope FROM items i
    JOIN folders f ON f.upn=i.upn AND f.scope=i.scope AND f.folderId=i.folderId
    WHERE ${where.join(' AND ')}`).all(...args);
  console.log(`${rows.length} email(s) to check`);
  const byFolder = new Map();
  const badItems = [];
  const reasonCounts = {};
  const bump = r => { const k = r.split(':')[0].includes('cid') ? 'unresolved cid' : r.split(' ')[0] + (r.includes('PNG') ? ' PNG' : r.includes('GIF') ? ' GIF' : r.includes('JPEG') ? ' JPEG' : ''); reasonCounts[k] = (reasonCounts[k] || 0) + 1; };
  let n = 0, bad = 0, missing = 0;
  for (const r of rows) {
    const dir = path.join(storeRoot, safeName(upn), r.scope, ...String(r.path || '').split('/').filter(Boolean).map(safeName));
    const f = path.join(dir, r.fileId + '.eml.gz');
    if (!fs.existsSync(f)) { missing++; continue; }
    let problems = [];
    try {
      const parsed = await simpleParser(zlib.gunzipSync(fs.readFileSync(f)));
      problems = checkImages(parsed);
    } catch (e) { problems = [`parse error: ${String(e.message || e).slice(0, 60)}`]; }
    n++;
    const key = r.path || '(root)';
    if (problems.length) {
      bad++;
      for (const p of problems) bump(p);
      if (!byFolder.has(key)) byFolder.set(key, { checked: 0, bad: 0 });
      byFolder.get(key).bad++;
      if (badItems.length < 500) badItems.push({ folder: key, subject: r.subject, itemId: r.itemId.slice(0, 16), source: r.sourceApi, problems });
    }
    byFolder.set(key, { ...(byFolder.get(key) || { checked: 0, bad: 0 }), checked: (byFolder.get(key)?.checked || 0) + 1 });
    if (n % 1000 === 0) { console.log(`  …${n} checked, ${bad} bad`); await new Promise(res => setImmediate(res)); }
  }
  const report = { upn, at: new Date().toISOString(), checked: n, bad, missingFiles: missing, reasonCounts, folders: [...byFolder.entries()].filter(([, v]) => v.bad).map(([path, v]) => ({ path, ...v })).sort((a, b) => b.bad - a.bad), badItems };
  const out = path.join(cfg.dataDir, 'image-verify-report.json');
  fs.writeFileSync(out, JSON.stringify(report, null, 1));
  console.log(`checked ${n}, bad ${bad}, missing files ${missing} → ${out}`);
  for (const f of report.folders.slice(0, 15)) console.log(`  ${f.bad}/${f.checked}  ${f.path}`);
})();
