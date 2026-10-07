// One-off targeted eDiscovery search → PST export → download, reusing ExoExport.
// Proves clean-attachment recovery for aux-partition items (where EWS can't reach).
// Usage: node scripts/exo-search-test.js <upn> <kql> <outDir>
const fs = require('fs');
const path = require('path');
const { Store } = require('../lib/store');
const { Auth } = require('../lib/auth');
const { ExoExport } = require('../lib/exoexport');

const [upn, kql, outDir] = process.argv.slice(2);
if (!upn || !kql) { console.error('usage: node scripts/exo-search-test.js <upn> <kql> [outDir]'); process.exit(1); }

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
cfg.dataDir = path.resolve(__dirname, '..', cfg.dataDir || './data');
const store = new Store(cfg.dataDir);
const ex = new ExoExport({ cfg, store, log: (lvl, mb, msg) => console.log(`  [${lvl}] ${mb} ${msg}`), bus: { emit: () => { } }, auth: new Auth(cfg) });
ex.outDir = path.resolve(outDir || path.join(__dirname, '..', 'data', 'exo-export-test'));
fs.mkdirSync(ex.outDir, { recursive: true });

(async () => {
  const caseId = await ex._ensureCase();
  const search = await ex._graph('POST', `/security/cases/ediscoveryCases/${caseId}/searches`, {
    displayName: 'imgfix-' + Date.now().toString(36), contentQuery: kql
  });
  const searchId = search.id;
  try {
    await ex._graph('POST', `/security/cases/ediscoveryCases/${caseId}/searches/${searchId}/additionalSources`, {
      '@odata.type': 'microsoft.graph.security.userSource', email: upn
    });
    const timeoutMs = 30 * 60 * 1000;
    const estLoc = await ex._graphOp(`/security/cases/ediscoveryCases/${caseId}/searches/${searchId}/estimateStatistics`, {}, 'estimateStatistics');
    const estOp = await ex._pollOperation(estLoc, timeoutMs, 'estimate');
    const items = (await ex._estimateItemCount(caseId, searchId, estOp)) ?? estOp.indexedItemCount ?? null;
    console.log('estimate items:', items);
    if (!items) return;
    const expLoc = await ex._graphOp(`/security/cases/ediscoveryCases/${caseId}/searches/${searchId}/exportResult`, {
      displayName: 'imgfix', exportCriteria: 'searchHits',
      additionalOptions: 'splitSource, includeFolderAndPath, condensePaths, friendlyName', exportFormat: 'pst'
    }, 'export');
    const expOp = await ex._pollOperation(expLoc, timeoutMs * 2, 'export');
    const files = expOp.exportFileMetadata || (expOp.additionalData && expOp.additionalData.exportFileMetadata) || [];
    console.log('export files:', files.map(f => `${f.fileName} (${Math.round((f.size || 0) / 1024)} KB)`));
    for (const f of files) {
      const dest = path.join(ex.outDir, f.fileName || 'export.pst');
      await ex._downloadFile(f.downloadUrl, dest, timeoutMs * 3, upn);
      console.log('downloaded', dest);
    }
  } finally {
    try { await ex._graph('DELETE', `/security/cases/ediscoveryCases/${caseId}/searches/${searchId}`); } catch { }
  }
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
