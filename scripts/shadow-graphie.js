// Read-only shadow validation: enumerate the archive with the Graph Mailbox IE
// provider and compare against the folders/items the EWS path has recorded in
// the DB. Nothing is written to the DB or the source mailbox.
// Usage: node scripts/shadow-graphie.js <upn>
const path = require('path');
const fs = require('fs');
const { Auth } = require('../lib/auth');
const { Store } = require('../lib/store');
const { GraphIe } = require('../lib/graphie');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
cfg.dataDir = path.resolve(__dirname, '..', cfg.dataDir || './data');
const upn = process.argv[2];
if (!upn) { console.error('usage: node scripts/shadow-graphie.js <upn>'); process.exit(1); }

(async () => {
  const auth = new Auth(cfg);
  const store = new Store(cfg.dataDir);
  const graphie = new GraphIe(cfg, auth, (lvl, mb, msg) => console.log(`  [${lvl}] ${msg}`));

  const ids = await graphie.mailboxIds(upn);
  if (!ids.archive) { console.log('no archive mailbox'); return; }
  console.log(`archive mailbox: ${ids.archive}`);

  const t0 = Date.now();
  const res = await graphie.foldersDelta(upn, ids.archive, null);
  const ieFolders = res.folders.filter(f => !f['@removed']);
  const ieItems = ieFolders.reduce((a, f) => a + (f.totalItemCount || 0), 0);
  console.log(`\nGraph IE: ${ieFolders.length} folders, ${ieItems} items reported, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`aux partitions seen via redirects: ${res.partitions.length ? res.partitions.join(', ') : 'none'}`);

  const ewsRows = store.listFolders(upn).filter(f => f.scope === 'archive' && !f.folderId.startsWith('exo') && !f.folderId.startsWith('ie-'));
  const ewsItems = ewsRows.reduce((a, f) => a + (f.itemCount || 0), 0);
  console.log(`EWS (DB):  ${ewsRows.length} folders, ${ewsItems} items reported`);

  const ieNames = new Set(ieFolders.map(f => f.displayName));
  const missing = ewsRows.filter(r => r.folderId !== 'archivemsgfolderroot' && !ieNames.has(r.name));
  if (missing.length) console.log(`folders in EWS but not in IE (by name): ${missing.slice(0, 5).map(f => f.name).join(', ')}${missing.length > 5 ? ' …' : ''}`);
  console.log(ieFolders.length >= ewsRows.length - 1 ? '\nSHADOW MATCH (IE sees at least as much as EWS)' : '\nSHADOW MISMATCH — investigate before enabling');
})().catch(e => { console.error('shadow failed:', e.message); process.exit(1); });
