// Repair pass: fix live copies uploaded by copy-email jobs whose received date
// was stamped with the import time (fts items with receivedAt NULL at copy
// time). Dry-run by default; --apply PATCHes PR_MESSAGE_DELIVERY_TIME
// (SystemTime 0x0E06) on each wrong live message.
// Usage: node scripts/fix-copy-dates.js <dstUpn> [--apply]
const fs = require('fs');
const path = require('path');
const D = require('better-sqlite3');
const { Auth } = require('../lib/auth');
const { GraphClient } = require('../lib/graph');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
cfg.dataDir = path.resolve(__dirname, '..', cfg.dataDir || './data');
const dstUpn = process.argv[2];
const apply = process.argv.includes('--apply');
if (!dstUpn) { console.error('usage: node scripts/fix-copy-dates.js <dstUpn> [--apply]'); process.exit(1); }

const db = new D(path.join(cfg.dataDir, 'state.db'), { readonly: true });
const jobs = db.prepare(`SELECT id, upn, startedAt, finishedAt, detail FROM jobs WHERE kind='copy-email'`).all()
  .map(j => { try { return { ...j, d: JSON.parse(j.detail) }; } catch { return null; } })
  .filter(j => j && j.d && j.d.target === 'live' && j.d.dstUpn === dstUpn && j.startedAt && j.finishedAt);
if (!jobs.length) { console.log('no finished live copy-email jobs found for', dstUpn); process.exit(0); }
// Windows widened by 2 min: createdDateTime is stamped during the run.
const windows = jobs.map(j => [new Date(j.startedAt).getTime() - 120000, new Date(j.finishedAt).getTime() + 120000]);
const inWindow = t => windows.some(([a, b]) => t >= a && t <= b);
console.log(`${jobs.length} job(s), ${windows.length} window(s):`);
for (const j of jobs) console.log(`  job ${j.id}: ${j.startedAt} → ${j.finishedAt} src=${j.upn || j.d.srcUpn} dst=${j.d.dstLabel}`);

const srcUpnOf = j => j.upn || j.d.srcUpn;
const findDate = (srcUpn, subject) => {
  const row = db.prepare(`SELECT receivedAt FROM items WHERE upn=? AND subject=? AND status='done' AND receivedAt IS NOT NULL ORDER BY receivedAt LIMIT 1`).get(srcUpn, subject);
  return row ? row.receivedAt : null;
};

(async () => {
  const graph = new GraphClient(new Auth(cfg), () => {}, cfg);
  const roots = new Map(); // folderId -> label
  for (const j of jobs) {
    const rid = (j.d.dst && j.d.dst.folderId) || 'msgfolderroot';
    if (!roots.has(rid)) roots.set(rid, j.d.dstLabel);
  }
  let fixable = 0, unfixable = 0, okCount = 0, patched = 0, patchFailed = 0;
  for (const [rootId, label] of roots) {
    // Walk the whole destination-root subtree.
    const stack = [rootId];
    const seen = new Set();
    while (stack.length) {
      const fid = stack.pop();
      if (seen.has(fid)) continue;
      seen.add(fid);
      for await (const kids of graph.pages(`/users/${dstUpn}/mailFolders/${fid}/childFolders?$select=id,displayName&$top=100`))
        for (const c of kids) stack.push(c.id);
      let folderHits = 0;
      for await (const msgs of graph.pages(`/users/${dstUpn}/mailFolders/${fid}/messages?$select=id,subject,receivedDateTime,createdDateTime&$top=100`)) {
      for (const m of msgs) {
        const created = new Date(m.createdDateTime).getTime();
        const received = new Date(m.receivedDateTime).getTime();
        if (!inWindow(created)) continue;
        if (Math.abs(received - created) >= 30 * 60 * 1000) { okCount++; continue; } // correct date already
        folderHits++;
        if (!m.subject) { unfixable++; continue; }
        // Try each contributing source mailbox (jobs may have different srcUpns).
        let date = null;
        for (const j of jobs) { date = findDate(srcUpnOf(j), m.subject); if (date) break; }
        if (!date) { unfixable++; continue; }
        fixable++;
        if (apply) {
          try {
            await graph.req(`/users/${dstUpn}/messages/${m.id}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ singleValueExtendedProperties: [{ id: 'SystemTime 0x0E06', value: new Date(date).toISOString() }] })
            });
            patched++;
            await new Promise(r => setTimeout(r, 150));
          } catch (e) { patchFailed++; console.log(`  PATCH failed (${m.subject}): ${e.message}`); }
        }
      }
      if (folderHits) console.log(`folder ${fid.slice(0, 24)}…: ${folderHits} wrong-date message(s)`);
      }
    }
    console.log(`root "${label}" scanned`);
  }
  console.log(`${apply ? 'APPLY' : 'DRY-RUN'}: fixable=${fixable} unfixable=${unfixable} alreadyCorrect=${okCount}` +
    (apply ? ` patched=${patched} patchFailed=${patchFailed}` : ' (re-run with --apply to patch)'));
})().catch(e => { console.error('FAILED:', e); process.exit(1); });
