// EXO eDiscovery (Premium) export pipeline: backs up FULL mailboxes (including
// the complete online archive with auto-expanding auxiliary partitions, which
// EWS cannot reach) to local PSTs via the Microsoft Graph eDiscovery API —
// the replacement for the retired Security & Compliance
// New-ComplianceSearchAction -Export path.
// Chunked by sent-date range; chunk identity = (upn, from, to) in exo_exports —
// done chunks are never re-exported. One chunk at a time (Microsoft throttles
// export to ~2 GB/hr). Per chunk: create search under the shared case, attach
// the mailbox's custodian, estimateStatistics, per-chunk review set +
// addToReviewSet, reviewSet export (exportStructure 'pst'), then stream the
// exportFileMetadata downloadUrls to disk with a delegated download token.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { safeName } = require('./util');

const TAIL = '9999-12-31';
const GRAPH = 'https://graph.microsoft.com/v1.0';
const CASE_NAME = 'M365-Sphere Export';
const EXO_PS_CLIENT_ID = 'fb78d390-0c51-40cd-8e17-fdbfab77341b'; // "Microsoft Exchange REST API Based Powershell" (first-party public client)
const DOWNLOAD_SCOPE = 'b26e684c-5068-4120-a679-64a5d2c909d9/.default'; // MicrosoftPurviewEDiscovery (eDiscovery.Download.Read)
const GRANT_HINT = ' — Graph eDiscovery export needs two one-time grants: (1) run scripts/grant-ediscovery-graph.ps1 (application permission eDiscovery.ReadWrite.All on Microsoft Graph, plus delegated eDiscovery.Download.Read on MicrosoftPurviewEDiscovery), and (2) acquire the delegated download token: node scripts/exo-delegate-token.js "b26e684c-5068-4120-a679-64a5d2c909d9/.default offline_access" data/exo-download-refresh-token.json (device-code sign-in as an eDiscovery admin)';

const isoDate = d => d.toISOString().slice(0, 10);
const addMonths = (d, n) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
const searchNameFor = (upn, from, to) =>
  `mb365-${crypto.createHash('sha1').update(upn).digest('hex').slice(0, 8)}-${from}-${to === TAIL ? 'tail' : to}`;

function planChunks(earliestIso, now = new Date(), months = 6) {
  const chunks = [];
  let start = earliestIso ? new Date(earliestIso.slice(0, 7) + '-01T00:00:00Z') : new Date('2015-01-01T00:00:00Z');
  if (isNaN(start)) start = new Date('2015-01-01T00:00:00Z');
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  for (let f = start; f <= end; f = addMonths(f, months)) {
    const t = addMonths(f, months);
    chunks.push({ chunkFrom: isoDate(f), chunkTo: t > end ? TAIL : isoDate(t) });
  }
  return chunks;
}

class ExoExport {
  constructor({ cfg, store, log, bus, auth, ingest }) {
    this.cfg = cfg; this.store = store; this.log = log; this.bus = bus; this.auth = auth; this.ingest = ingest;
    this.outDir = path.join(cfg.dataDir, 'exo-export');
    this.caseFile = path.join(cfg.dataDir, 'exo-case.json');
    this.live = { running: false };
    this._stop = false;
    this._custodians = {}; // upn -> { custodianId, userSourceId } (in-memory; persisted in exo-case.json)
  }

  get running() { return this.live.running; }

  stop() {
    this._stop = true;
  }

  summary() {
    const s = this.store.exoExportStats();
    return {
      running: this.live.running,
      current: this.live.running ? this.live.current || null : null,
      chunksDone: s.chunksDone || 0,
      chunksTotal: s.chunksTotal || 0,
      chunksFailed: s.chunksFailed || 0,
      bytesDone: s.bytesDone || 0,
      itemsIngested: s.itemsIngested || 0,
      bytesIngested: s.bytesIngested || 0,
      lastError: this.live.lastError || null
    };
  }

  _emit() { this.bus.emit('progress', { exoExport: true }); }

  // ---- Graph plumbing ----------------------------------------------------

  async _graph(method, urlPath, body) {
    const tok = await this.auth.graphToken();
    const r = await fetch(`${GRAPH}${urlPath}`, {
      method,
      headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    if (r.status === 403 || r.status === 401) {
      let msg = `Graph ${method} ${urlPath} returned ${r.status}`;
      try { msg += ': ' + JSON.stringify(await r.json()).slice(0, 200); } catch { }
      throw new Error(msg + GRANT_HINT);
    }
    if (r.status === 204) return null;
    const j = await r.json().catch(() => null);
    if (!r.ok) throw new Error(`Graph ${method} ${urlPath} returned ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
    return j;
  }

  _readCaseFile() {
    try { return JSON.parse(fs.readFileSync(this.caseFile, 'utf8')); } catch { return {}; }
  }

  _writeCaseFile(j) {
    fs.writeFileSync(this.caseFile, JSON.stringify(j, null, 2));
  }

  // One-time: find (or create) the shared eDiscovery case; ids cached in
  // data/exo-case.json.
  async _ensureCase() {
    if (this._caseId) return this._caseId;
    const cached = this._readCaseFile();
    if (cached.caseId) { this._caseId = cached.caseId; this._custodians = cached.custodians || {}; return this._caseId; }
    const found = await this._graph('GET', `/security/cases/ediscoveryCases?$filter=${encodeURIComponent(`displayName eq '${CASE_NAME}'`)}&$select=id`);
    let id = found && found.value && found.value[0] && found.value[0].id;
    if (!id) {
      const created = await this._graph('POST', '/security/cases/ediscoveryCases', { displayName: CASE_NAME });
      id = created.id;
      this.log('info', '', `[exo-export] created eDiscovery case "${CASE_NAME}" (${id})`);
    }
    this._caseId = id;
    cached.caseId = id; cached.custodians = this._custodians;
    this._writeCaseFile(cached);
    return id;
  }

  // One-time per mailbox: add the mailbox as a case custodian and wait for it
  // to become active (cached in exo-case.json, keyed by upn).
  async _ensureMailboxSource(upn) {
    const hit = this._custodians[upn];
    if (hit && typeof hit === 'object' && hit.sourceId) return hit;
    const caseId = await this._ensureCase();
    const list = await this._graph('GET', `/security/cases/ediscoveryCases/${caseId}/noncustodialDataSources?$select=id,status,displayName`);
    let src = list && list.value && list.value.find(s => (s.displayName || '').toLowerCase() === upn.toLowerCase());
    if (!src) {
      src = await this._graph('POST', `/security/cases/ediscoveryCases/${caseId}/noncustodialDataSources`, {
        dataSource: { '@odata.type': 'microsoft.graph.security.userSource', email: upn }
      });
      this.log('info', upn, `[exo-export] added mailbox data source to case (${src.id})`);
    }
    // Wait until the source is active before searching against it.
    const deadline = Date.now() + (parseInt(this.cfg.exoExportTimeoutMs, 10) || 30 * 60 * 1000);
    for (;;) {
      if (this._stop) throw new Error('stopped');
      const s = await this._graph('GET', `/security/cases/ediscoveryCases/${caseId}/noncustodialDataSources/${src.id}?$select=status`);
      if (s.status === 'active') break;
      if (Date.now() > deadline) throw new Error(`mailbox data source ${upn} did not become active before the timeout`);
      await new Promise(r => setTimeout(r, 15000));
    }
    this._custodians[upn] = { sourceId: src.id };
    const cached = this._readCaseFile();
    cached.caseId = caseId; cached.custodians = this._custodians;
    this._writeCaseFile(cached);
    return this._custodians[upn];
  }

  // Poll a long-running operation URL (from a 202 Location header) until it
  // reaches a terminal state.
  async _pollOperation(opUrl, timeoutMs, phase) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (this._stop) throw new Error('stopped');
      const tok = await this.auth.graphToken();
      const r = await fetch(opUrl, { headers: { Authorization: `Bearer ${tok}` } });
      if (r.status === 403 || r.status === 401) throw new Error(`Graph operation poll (${phase}) returned ${r.status}` + GRANT_HINT);
      const j = await r.json().catch(() => ({}));
      const status = j.status;
      if (status === 'succeeded' || status === 'completed') return j;
      if (status === 'failed') throw new Error(`${phase} operation failed: ${JSON.stringify(j).slice(0, 300)}`);
      if (Date.now() > deadline) throw new Error(`${phase} operation did not complete before the timeout (${Math.round(timeoutMs / 60000)} min, cfg.exoExportTimeoutMs)`);
      this.live.current = { ...(this.live.current || {}), phase };
      this._emit();
      await new Promise(r => setTimeout(r, 30000));
    }
  }

  _locationHeader(r) {
    const loc = r.headers.get('location');
    if (!loc) throw new Error('Graph returned 202 without a Location header');
    return loc;
  }

  // POST helper that surfaces the Location header of a 202 long-running op.
  async _graphOp(urlPath, body, phase) {
    const tok = await this.auth.graphToken();
    const r = await fetch(`${GRAPH}${urlPath}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    });
    if (r.status === 403 || r.status === 401) throw new Error(`Graph POST ${urlPath} returned ${r.status}` + GRANT_HINT);
    if (r.status !== 202 && !r.ok) {
      const j = await r.json().catch(() => null);
      throw new Error(`Graph POST ${urlPath} (${phase}) returned ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
    }
    return this._locationHeader(r);
  }

  // Best-effort extraction of the contentQuery hit count after a successful
  // estimateStatistics: the operation/search statistics surface a
  // contentQuery subcount with an itemCount. Returns null when the shape
  // differs (caller then proceeds to export and treats "no export files" as
  // empty).
  async _estimateItemCount(caseId, searchId, opResult) {
    const shapes = [opResult, null];
    try { shapes[1] = await this._graph('GET', `/security/cases/ediscoveryCases/${caseId}/searches/${searchId}?$expand=statistics`); } catch { }
    for (const s of shapes) {
      const stats = s && (s.statistics || (s.additionalData && s.additionalData.statistics));
      const cq = stats && (stats.contentQuery || (Array.isArray(stats) && stats.find(x => x && x.queryType === 'contentQuery')));
      if (cq && typeof cq.itemCount === 'number') return cq.itemCount;
    }
    return null;
  }

  // ---- Delegated download token (MicrosoftPurviewEDiscovery) -------------

  // Delegated token for the export-file download host, redeemed from the
  // one-time device-code refresh token (data/exo-download-refresh-token.json,
  // acquired via scripts/exo-delegate-token.js with the download scope).
  async _downloadToken() {
    const p = path.join(this.cfg.dataDir, 'exo-download-refresh-token.json');
    if (!fs.existsSync(p)) throw new Error('delegated download token file missing (data/exo-download-refresh-token.json)' + GRANT_HINT);
    if (this._dl && this._dl.exp > Date.now() + 60000) return this._dl.tok;
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    const r = await fetch(`https://login.microsoftonline.com/${this.cfg.tenantId}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: EXO_PS_CLIENT_ID,
        refresh_token: j.refreshToken,
        scope: DOWNLOAD_SCOPE
      })
    });
    const t = await r.json();
    if (!t.access_token) throw new Error('download token refresh failed: ' + String(t.error_description || t.error || 'unknown').slice(0, 200) + GRANT_HINT);
    // Refresh tokens rotate — persist the new one.
    if (t.refresh_token) {
      j.refreshToken = t.refresh_token;
      j.acquiredAt = new Date().toISOString();
      fs.writeFileSync(p, JSON.stringify(j, null, 2));
    }
    this._dl = { tok: t.access_token, exp: Date.now() + (t.expires_in || 3600) * 1000 };
    return this._dl.tok;
  }

  // Stream one export file to a staging path. A redirect to the Entra sign-in
  // page means the delegated download scope was not consented.
  async _downloadFile(url, dest, timeoutMs, upn) {
    const tok = await this._downloadToken();
    const r = await fetch(url, { headers: { Authorization: `Bearer ${tok}`, 'X-AllowWithAADToken': 'true' } });
    const finalHost = String(r.url || '');
    if (r.status !== 200 || /login\.microsoftonline|\.aspx/i.test(finalHost) || /html/i.test(r.headers.get('content-type') || '')) {
      throw new Error(`export file download was redirected to a sign-in page (${r.status} ${finalHost.slice(0, 120)}) — the delegated eDiscovery.Download.Read grant or consent is missing` + GRANT_HINT);
    }
    const tmp = dest + '.part';
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(tmp);
      const timer = setTimeout(() => { out.destroy(); reject(new Error('download timed out')); }, timeoutMs);
      Readable.fromWeb(r.body).on('error', reject).pipe(out)
        .on('finish', () => { clearTimeout(timer); resolve(); })
        .on('error', e => { clearTimeout(timer); reject(e); });
    });
    fs.renameSync(tmp, dest);
  }

  // ---- Orchestration ------------------------------------------------------

  _planMailbox(upn) {
    const months = parseInt(this.cfg.exoExportChunkMonths, 10) || 6;
    const minRecv = this.store.db.prepare('SELECT MIN(receivedAt) r FROM items WHERE upn=?').get(upn).r;
    for (const c of planChunks(minRecv, new Date(), months)) {
      this.store.planChunk(upn, c.chunkFrom, c.chunkTo, searchNameFor(upn, c.chunkFrom, c.chunkTo));
    }
  }

  // Run pending chunks (newly planned for the given upn(s), or everything
  // left over from earlier runs). Resumable: only chunks that are not 'done'
  // with the PST on disk are processed.
  async runExport({ upn, upns } = {}) {
    if (this.live.running) throw new Error('an EXO export is already running');
    const maxRetries = parseInt(this.cfg.exoExportRetries, 10) || 5;
    const explicit = upn ? [upn] : (upns || null);
    if (explicit) {
      for (const u of explicit) {
        if (!this.store.getMailbox(u)) throw new Error(`Mailbox not found: ${u}`);
        this._planMailbox(u);
      }
    }
    // A server restart mid-chunk leaves rows 'running' — put them back on the pile.
    this.store.db.prepare(`UPDATE exo_exports SET status='pending' WHERE status='running'`).run();
    this._stop = false;
    this.live = { running: true, lastError: null };
    this._emit();
    try {
      if (!explicit) {
        // Plan chunks for every archive mailbox, then work off the global pile
        // (this is also the restart-resume path: planning is INSERT OR IGNORE).
        for (const m of this.store.listMailboxes()) {
          if (m.hasArchive || (m.serverArchiveBytes || 0) > 0) this._planMailbox(m.upn);
        }
      }
      for (;;) {
        if (this._stop) { this.log('info', '', 'EXO export stopped by user'); break; }
        const chunks = this.store.exoOpenChunks().filter(c => !(c.status === 'failed' && c.attempts >= maxRetries));
        const next = chunks[0];
        if (!next) break;
        await this._runChunkWithRetry(next, maxRetries);
      }
      const s = this.store.exoExportStats();
      const failedLeft = this.store.exoOpenChunks().filter(c => c.status === 'failed').length;
      this.log('info', '', `EXO export finished: ${s.chunksDone}/${s.chunksTotal} chunks done (${Math.round((s.bytesDone || 0) / 1024 ** 3)} GB)${failedLeft ? `, ${failedLeft} chunk(s) failed after ${maxRetries} attempts` : ''}`);
    } finally {
      this.live = { running: false, lastError: this.live.lastError || null };
      this._emit();
    }
  }

  async _runChunkWithRetry(chunk, maxRetries) {
    for (;;) {
      try {
        await this._runChunk(chunk);
        return;
      } catch (e) {
        if (this._stop) {
          this.store.markChunk(chunk.upn, chunk.chunkFrom, chunk.chunkTo, { status: 'pending' });
          return;
        }
        const attempts = (this.store.getChunk(chunk.upn, chunk.chunkFrom, chunk.chunkTo).attempts || 0) + 1;
        this.store.markChunk(chunk.upn, chunk.chunkFrom, chunk.chunkTo, { status: 'failed', attempts, error: String(e.message || e).slice(0, 500) });
        this.live.lastError = `${chunk.upn} ${chunk.chunkFrom}…${chunk.chunkTo}: ${e.message}`;
        this._emit();
        if (attempts >= maxRetries) {
          this.log('error', chunk.upn, `EXO export chunk ${chunk.chunkFrom}…${chunk.chunkTo} failed after ${attempts} attempts: ${e.message}`);
          return;
        }
        const waitSec = Math.min(30 * 2 ** (attempts - 1), 600);
        this.log('warn', chunk.upn, `EXO export chunk ${chunk.chunkFrom}…${chunk.chunkTo} failed (attempt ${attempts}/${maxRetries}): ${e.message} — retrying in ${waitSec}s`);
        await new Promise(r => {
          const t = setTimeout(r, waitSec * 1000);
          const iv = setInterval(() => { if (this._stop) { clearTimeout(t); clearInterval(iv); r(); } }, 1000);
        });
        if (this._stop) return;
      }
    }
  }

  async _runChunk(chunk) {
    const { upn, chunkFrom, chunkTo } = chunk;
    const searchName = chunk.searchName || searchNameFor(upn, chunkFrom, chunkTo);
    const outMbx = path.join(this.outDir, safeName(upn));
    fs.mkdirSync(outMbx, { recursive: true });
    const finalName = `${chunkFrom}_${chunkTo === TAIL ? 'tail' : chunkTo}.pst`;
    const finalPath = path.join(outMbx, finalName);
    // Idempotency: never re-export a chunk whose PST already exists. If it was
    // never ingested into the backup store (older row / earlier failure), do that now.
    if (fs.existsSync(finalPath)) {
      const done = { status: 'done', pstPath: finalPath, bytes: fs.statSync(finalPath).size, finishedAt: new Date().toISOString() };
      const ing = await this._ingestChunk(upn, chunkFrom, chunkTo, [finalPath], chunk.ingestedItems || 0);
      this.store.markChunk(upn, chunkFrom, chunkTo, { ...done, ...ing });
      return;
    }
    const timeoutMs = parseInt(this.cfg.exoExportTimeoutMs, 10) || 30 * 60 * 1000;
    const kql = chunkTo === TAIL ? `sent>=${chunkFrom}` : `sent>=${chunkFrom} AND sent<${chunkTo}`;
    this.store.markChunk(upn, chunkFrom, chunkTo, { status: 'running', startedAt: new Date().toISOString() });
    this.live.current = { upn, chunkFrom, chunkTo, phase: 'search' };
    this._emit();
    this.log('info', upn, `EXO export chunk ${chunkFrom}…${chunkTo} starting (KQL: ${kql})`);

    const caseId = await this._ensureCase();
    let searchId = null;
    try {
      // 1. Search under the case, with the mailbox attached via the
      // /additionalSources API (standard-case route; custodian/noncustodial
      // bindings are premium-only and userSources provision unreliably).
      const search = await this._graph('POST', `/security/cases/ediscoveryCases/${caseId}/searches`, {
        displayName: searchName,
        contentQuery: kql
      });
      searchId = search.id;
      await this._graph('POST', `/security/cases/ediscoveryCases/${caseId}/searches/${searchId}/additionalSources`, {
        '@odata.type': 'microsoft.graph.security.userSource',
        email: upn
      });

      // 2. Estimate → item count (0 → done-empty).
      const estLoc = await this._graphOp(`/security/cases/ediscoveryCases/${caseId}/searches/${searchId}/estimateStatistics`, {}, 'estimateStatistics');
      const estOp = await this._pollOperation(estLoc, timeoutMs, 'estimate');
      const items = await this._estimateItemCount(caseId, searchId, estOp);
      if (items === 0) {
        this.store.markChunk(upn, chunkFrom, chunkTo, { status: 'done', pstPath: null, bytes: 0, items: 0, error: null, finishedAt: new Date().toISOString() });
        this.log('info', upn, `EXO export chunk ${chunkFrom}…${chunkTo}: no items in range — marked done (empty)`);
        return;
      }
      this.live.current = { ...(this.live.current || {}), items };
      this._emit();

      // 3. Direct export from the search (exportResult) — no review set needed.
      this.live.current = { ...(this.live.current || {}), phase: 'export' };
      this._emit();
      const expLoc = await this._graphOp(`/security/cases/ediscoveryCases/${caseId}/searches/${searchId}/exportResult`, {
        displayName: searchName,
        exportCriteria: 'searchHits',
        additionalOptions: 'splitSource, includeFolderAndPath, condensePaths, friendlyName',
        exportFormat: 'pst'
      }, 'export');
      const expOp = await this._pollOperation(expLoc, timeoutMs * 2, 'export');
      const files = expOp.exportFileMetadata || (expOp.additionalData && expOp.additionalData.exportFileMetadata) || [];
      if (!files.length) {
        this.store.markChunk(upn, chunkFrom, chunkTo, { status: 'done', pstPath: null, bytes: 0, items: items || 0, error: null, finishedAt: new Date().toISOString() });
        this.log('info', upn, `EXO export chunk ${chunkFrom}…${chunkTo}: export produced no files — marked done (empty)`);
        return;
      }

      // 5. Download into a staging dir (the .partial marker), then publish atomically.
      const tmpDir = path.join(outMbx, '.partial-' + searchName);
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.mkdirSync(tmpDir, { recursive: true });
      this.log('info', upn, `EXO export chunk ${chunkFrom}…${chunkTo}: downloading ${files.length} export file(s) (${Math.round(files.reduce((a, f) => a + (f.size || 0), 0) / 1024 ** 2)} MB)…`);
      this.live.current = { ...(this.live.current || {}), phase: 'download' };
      this._emit();
      try {
        let i = 0;
        for (const f of files) {
          if (this._stop) throw new Error('stopped');
          const staged = path.join(tmpDir, f.fileName || `export-${i}.pst`);
          await this._downloadFile(f.downloadUrl, staged, timeoutMs * 3, upn);
          i++;
        }
        const psts = this._findPsts(tmpDir);
        if (!psts.length) throw new Error('download finished but no .pst files were produced');
        let total = 0;
        const published = [];
        psts.forEach((p, idx) => {
          const dst = psts.length === 1 ? finalPath : path.join(outMbx, finalName.replace(/\.pst$/, `_${idx + 1}.pst`));
          fs.rmSync(dst, { force: true });
          fs.renameSync(p, dst);
          total += fs.statSync(dst).size;
          published.push(dst);
        });
        this.store.markChunk(upn, chunkFrom, chunkTo, { status: 'done', pstPath: finalPath, bytes: total, items: items || 0, error: null, finishedAt: new Date().toISOString() });
        this.log('info', upn, `EXO export chunk ${chunkFrom}…${chunkTo} done: ${psts.length} PST file(s), ${Math.round(total / 1024 ** 2)} MB`);
        const ing = await this._ingestChunk(upn, chunkFrom, chunkTo, published, 0);
        this.store.markChunk(upn, chunkFrom, chunkTo, ing);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    } finally {
      // Cleanup so retries don't accumulate objects; best-effort.
      try { if (searchId) await this._graph('DELETE', `/security/cases/ediscoveryCases/${caseId}/searches/${searchId}`); } catch { }
    }
  }

  // Pull each published PST into the browsable backup store. Ingest failures
  // surface as chunk failures (the PST stays on disk; the re-run re-ingests
  // cheaply because item ids are stable and identical content is skipped).
  async _ingestChunk(upn, chunkFrom, chunkTo, pstPaths, alreadyIngested) {
    if (!this.ingest) return { ingestedItems: alreadyIngested, ingestedBytes: 0 };
    this.live.current = { ...(this.live.current || {}), upn, chunkFrom, chunkTo, phase: 'ingest' };
    this._emit();
    let ingestedItems = alreadyIngested, ingestedBytes = 0;
    for (const p of pstPaths) {
      const r = await this.ingest.ingestPst({ upn, pstPath: p });
      ingestedItems += r.items;
      ingestedBytes += r.bytes;
    }
    return { ingestedItems, ingestedBytes };
  }

  // Manual PST import: ingest every .pst sitting in data/exo-export/<upn> that
  // the user produced via a MANUAL Purview portal export (the API export path
  // requires Purview pay-as-you-go billing on standard-license tenants).
  // A .ingested.json manifest (name+size) makes repeat calls cheap — only new
  // or changed PSTs are parsed again (ingest itself is also idempotent).
  async importLocalPsts(upn) {
    if (this.live.running) throw new Error('an EXO export/import job is already running');
    const dir = path.join(this.outDir, safeName(upn));
    const manifestFile = path.join(dir, '.ingested.json');
    let manifest = {};
    try { manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')); } catch { }
    const psts = fs.existsSync(dir)
      ? fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.pst')).map(f => path.join(dir, f))
      : [];
    this.live.running = true;
    this.live.current = { upn, phase: 'ingest', file: null };
    this._emit();
    let imported = 0, items = 0, bytes = 0;
    try {
      this.log('info', upn, `EXO PST import: scanning ${dir} — ${psts.length} PST file(s) found`);
      for (const p of psts) {
        if (this._stop) break;
        const st = fs.statSync(p);
        const key = path.basename(p);
        if (manifest[key] && manifest[key].size === st.size && manifest[key].mtimeMs === st.mtimeMs) continue;
        this.live.current = { upn, phase: 'ingest', file: key };
        this._emit();
        this.log('info', upn, `EXO PST import: ingesting ${key} (${Math.round(st.size / 1024 ** 2)} MB)…`);
        const r = await this.ingest.ingestPst({ upn, pstPath: p });
        manifest[key] = { size: st.size, mtimeMs: st.mtimeMs, items: r.items, bytes: r.bytes };
        fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
        imported++; items += r.items; bytes += r.bytes;
        this.log('info', upn, `EXO PST import: ${key} done — ${r.items} item(s), ${Math.round(r.bytes / 1024 ** 2)} MB ingested into the backup store`);
      }
      this.log(imported ? 'info' : 'warn', upn, imported
        ? `EXO PST import finished: ${imported} new PST(s), ${items} item(s), ${Math.round(bytes / 1024 ** 2)} MB`
        : 'EXO PST import: nothing new — drop exported PST files into ' + dir + ' first');
      return { imported, items, bytes };
    } finally {
      this.live.running = false;
      this.live.current = null;
      this._emit();
    }
  }

  _findPsts(dir) {
    const out = [];
    const walk = d => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.toLowerCase().endsWith('.pst')) out.push(p);
      }
    };
    walk(dir);
    return out;
  }
}

module.exports = { ExoExport, planChunks, searchNameFor, TAIL };
