// M365-Sphere — local web server + dashboard
const express = require('express');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const crypto = require('crypto');
const { Auth } = require('./lib/auth');
const { GraphClient } = require('./lib/graph');
const { EwsClient } = require('./lib/ews');
const { Store } = require('./lib/store');
const { Engine, parseMimeHeaders } = require('./lib/engine');
const { PstExporter } = require('./lib/pst');
const { Setup } = require('./lib/setup');
const { Exo } = require('./lib/exo');
const { ExoExport } = require('./lib/exoexport');
const { PstIngest } = require('./lib/pstingest');
const { CopyEngine } = require('./lib/copy');
const { DedupeEngine } = require('./lib/dedupe');
const { parseStoredItem, toPreview, readRaw, chainPath, itemFile } = require('./lib/preview');
const { simpleParser } = require('mailparser');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');
const fsp = require('fs/promises');
const { ftsPreview, ftsAttachment } = require('./lib/fts');
const { safeName, isValidUpn } = require('./lib/util');
const { computeCoverage, refreshCoverage } = require('./lib/coverage');
const archiver = require('archiver');

const CONFIG_PATH = path.join(__dirname, 'config.json');
if (!fs.existsSync(CONFIG_PATH)) {
  const template = path.join(__dirname, 'config.example.json');
  if (!fs.existsSync(template)) {
    console.error('config.example.json is missing from the install folder — reinstall or restore it, then start again.');
    process.exit(1);
  }
  fs.copyFileSync(template, CONFIG_PATH);
  console.log('Created config.json from template -> EDIT IT, then restart.');
  process.exit(1);
}
const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
cfg.dataDir = path.resolve(__dirname, cfg.dataDir || './data');
cfg.pstDir = path.resolve(__dirname, cfg.pstDir || './pst-export');

const store = new Store(cfg.dataDir);
// Startup reconciliation: jobs left 'running' by a crash become 'interrupted';
// prune old events/jobs at startup and then daily.
try { if (store.reconcileJobs) store.reconcileJobs(); } catch (e) { console.error('reconcileJobs failed:', e.message); }
const pruneStore = () => {
  try { if (store.pruneEvents) store.pruneEvents(20000); } catch (e) { console.error('pruneEvents failed:', e.message); }
  try { if (store.pruneJobs) store.pruneJobs(200); } catch (e) { console.error('pruneJobs failed:', e.message); }
};
pruneStore();
setInterval(pruneStore, 24 * 60 * 60 * 1000).unref();
// Disaster-recovery copy of the state DB (also refreshed after each finished job).
try { if (store.snapshot) store.snapshot(); } catch (e) { console.error('DB snapshot failed:', e.message); }
const bus = new EventEmitter();
bus.setMaxListeners(100);
const log = (level, mailbox, message) => {
  store.log(level, mailbox || '', message);
  bus.emit('event', { ts: new Date().toISOString(), level, mailbox: mailbox || '', message });
};
const auth = new Auth(cfg);
const graph = new GraphClient(auth, log, cfg);
const ews = new EwsClient(auth, log, cfg);
// Graph Mailbox Import/Export (beta) archive provider — read-only; only
// constructed when the feature flag is on. See docs/archive-upgrade-plan.md.
const { GraphIe } = require('./lib/graphie');
const graphie = cfg.graphExchangeExportEnabled ? new GraphIe(cfg, auth, log) : null;
const engine = new Engine({ cfg, store, graph, ews, graphie, log, bus });
const pst = new PstExporter({ cfg, store, log, bus });
const setup = new Setup({ cfg, log, configPath: CONFIG_PATH });
const exo = new Exo({ cfg, log, bus, auth });
const exoExport = new ExoExport({ cfg, store, log, bus, auth, ingest: new PstIngest({ cfg, store, log, bus }) });
const copyEngine = new CopyEngine({ cfg, store, graph, log, bus });
const dedupeEngine = new DedupeEngine({ cfg, store, graph, log, bus });
// Device sign-in prompt for an in-flight EXO sizes job, exposed via /api/status
// (same pattern as archiveSignIn in /api/setup/status).
let exoSignIn = null;

const app = express();
app.use(express.json({ limit: '1mb' })); // PST plans can be large folder lists

// Session token guard: all /api/* calls must present the token. Prefer the
// Authorization: Bearer header (or x-session-token); ?token= remains only
// because browser download links and EventSource cannot set headers.
const sessionToken = crypto.randomUUID();
// The token file is written only AFTER the port is bound (see app.listen below) —
// a duplicate instance that dies on EADDRINUSE must not invalidate running clients.
const isLoopbackAddr = ip => ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
// LOCAL THREAT MODEL: the dashboard is a local-only app (loopback bind). The token
// exists to stop OTHER local processes/web pages from driving the API (the endpoint
// also rejects cross-site browser fetches via Sec-Fetch-Site), not to protect
// against a malicious process running as the same user — such a process can read
// data/session-token anyway. Never bind this server to a non-loopback address.
app.get('/session-token.js', (req, res) => {
  // Cross-site pages (e.g. a malicious website driving localhost from the user's
  // browser) send Sec-Fetch-Site: cross-site — refuse them. The dashboard's own
  // script tag / fetch come from the same origin and pass. Older clients without
  // the header fall back to the loopback check below.
  const sfs = req.get('sec-fetch-site');
  if (sfs && sfs !== 'same-origin' && sfs !== 'same-site' && sfs !== 'none')
    return res.status(403).json({ error: 'session token is only served to same-origin clients' });
  if (!isLoopbackAddr(req.socket.remoteAddress || '')) return res.status(403).json({ error: 'session token is only served to loopback clients' });
  res.set('Cache-Control', 'no-store');
  res.type('application/javascript').send(`window.__SESSION_TOKEN=${JSON.stringify(sessionToken)};`);
});
app.use('/api', (req, res, next) => {
  const h = req.get('authorization') || '';
  const t = (h.startsWith('Bearer ') ? h.slice(7) : '') || req.get('x-session-token') || req.query.token;
  if (t === sessionToken) return next();
  res.status(401).json({ error: 'missing or invalid session token' });
});
// UPNs end up in filesystem paths — validate strictly at the API boundary.
app.param('upn', (req, res, next, val) => {
  if (isValidUpn(val)) return next();
  res.status(400).json({ error: 'invalid mailbox id' });
});

const wrap = fn => async (req, res) => {
  try { res.json(await fn(req) || { ok: true }); }
  catch (e) { res.status(e.status || (e.message && e.message.includes('already running') ? 409 : 500)).json({ error: String(e.message || e) }); }
};

app.get('/api/status', wrap(async () => ({
  aggregates: store.aggregates(),
  jobs: store.listJobs(),
  running: engine.running,
  pstRunning: pst.running,
  compareRunning,
  pstDetail: pst.detail(),
  copyRunning: copyEngine.running,
  dedupeRunning: dedupeEngine.running,
  dedupeRuns: [...dedupeEngine._runs.keys()],
  dedupeChecks: [...dedupeEngine.checkProgress.values()],
  sizesRunning,
  scanRunning,
  exoExport: exoExport.summary(),
  fixTasks: fixTasks.slice(-60),
  exoSignIn,
  autoResumeSuppressed,
  configured: cfg.clientId && !cfg.clientId.startsWith('your-'),
  tenant: cfg.tenantName || cfg.tenantId,
  archiveGranted: !!cfg.archiveGranted,
  scopes: cfg.scopes,
  live: engine.live,
  jobUpns: engine.jobUpns
})));
app.get('/api/mailboxes', wrap(async () => {
  const exoBytes = store.exoExportBytesByUpn();
  return store.listMailboxes().map(m => ({ ...m, verifyReport: undefined, exoExportBytes: exoBytes[m.upn] || 0 }));
}));
app.get('/api/mailbox/:upn', wrap(async req => {
  const m = store.getMailbox(req.params.upn);
  if (!m) throw new Error('Mailbox not found');
  let report = null;
  try { report = m.verifyReport ? JSON.parse(m.verifyReport) : null; } catch { }
  // Auto-expanding archive coverage gap: bytes Exchange reports but EWS can never reach.
  const ewsArch = m.ewsArchiveBytes != null ? m.ewsArchiveBytes : m.archiveBytes;
  const archiveGapBytes = m.autoExpandingArchive && m.serverArchiveBytes != null && ewsArch != null
    ? Math.max(0, m.serverArchiveBytes - ewsArch) : null;
  return { ...m, archiveGapBytes, folders: store.listFolders(m.upn), report, events: store.mailboxEvents(m.upn, 100), live: engine.live[m.upn] || null };
}));
app.get('/api/mailbox/:upn/folders', wrap(async req => {
  const m = store.getMailbox(req.params.upn);
  if (!m) throw new Error('Mailbox not found');
  let folders = store.folderStats(m.upn);
  // Namespace coexistence: once Graph IE ('ie-') archive rows exist, hide plain
  // EWS archive rows that hold no local content — they are the same logical
  // folders enumerated twice (scan rows vs IE rows).
  if (folders.some(f => f.scope === 'archive' && f.folderId.startsWith('ie-'))) {
    folders = folders.filter(f => f.scope !== 'archive' || f.folderId.startsWith('ie-') || f.folderId.startsWith('exo') || f.backedUp > 0);
  }
  return { upn: m.upn, status: m.status, pstStatus: m.pstStatus, folders, live: engine.live[m.upn] || null, scanLive: scanLive[m.upn] || null };
}));
// Coverage = local verified data vs server-reported data. Separate from job
// status on purpose: a 'done' job can still have PARTIAL coverage.
app.get('/api/mailbox/:upn/coverage', wrap(async req => {
  const m = store.getMailbox(req.params.upn);
  if (!m) throw new Error('Mailbox not found');
  // Stale derived rows: once real aux partitions are discovered, drop the
  // 'aux-combined' placeholder the sizes job created.
  store.db.prepare(`DELETE FROM archive_partitions WHERE upn=? AND partitionId='aux-combined'
    AND EXISTS (SELECT 1 FROM archive_partitions WHERE upn=? AND partitionType='aux' AND partitionId != 'aux-combined')`).run(m.upn, m.upn);
  // Per-partition local stats, computed live from items in folders attributed to
  // each physical partition (folders.physicalMailboxId, learned from redirects).
  const byPid = new Map(store.db.prepare(`
    SELECT f.physicalMailboxId pid, COUNT(*) n, COALESCE(SUM(i.size),0) bytes
    FROM items i JOIN folders f ON f.upn=i.upn AND f.scope=i.scope AND f.folderId=i.folderId
    WHERE i.upn=? AND i.scope='archive' AND i.status IN ('done','deduped') AND f.physicalMailboxId IS NOT NULL
    GROUP BY f.physicalMailboxId`).all(m.upn).map(r => [r.pid, r]));
  const partitions = store.listPartitions(m.upn).map(p => ({
    ...p,
    backedUpItems: byPid.get(p.partitionId)?.n || 0,
    backedUpBytes: byPid.get(p.partitionId)?.bytes || 0
  }));
  const runs = store.listRuns(m.upn, 10);
  return { upn: m.upn, coverage: computeCoverage(store, m.upn, { ieEnabled: !!graphie }), partitions, runs };
}));
// PST import recovery stats: per-PST log records + live rebuilt/remaining counts.
app.get('/api/mailbox/:upn/pst-repair', wrap(async req => {
  const m = store.getMailbox(req.params.upn);
  if (!m) throw new Error('Mailbox not found');
  const logFile = path.join(cfg.dataDir, 'pst-import-log.json');
  let log = [];
  try { log = JSON.parse(fs.readFileSync(logFile, 'utf8')); } catch { }
  const byFile = new Map();
  for (const r of log) byFile.set(r.file, { ...byFile.get(r.file), ...r, replaced: (byFile.get(r.file)?.replaced || 0) + r.replaced });
  // Every PST on disk, processed or not.
  const pstDir = path.join(__dirname, 'pst-import', m.upn.split('@')[0]);
  const onDisk = fs.existsSync(pstDir)
    ? fs.readdirSync(pstDir).filter(f => f.toLowerCase().endsWith('.pst') && !f.startsWith('~')).sort()
    : [];
  const psts = onDisk.map(f => {
    const rec = byFile.get(f);
    return { file: f, size: fs.statSync(path.join(pstDir, f)).size, processed: !!rec, replaced: rec?.replaced || 0, verifyFailures: rec?.verifyFailures || 0, finishedAt: rec?.finishedAt || null };
  });
  for (const [f, rec] of byFile) if (!onDisk.includes(f)) psts.push({ file: f, size: null, processed: true, replaced: rec.replaced || 0, verifyFailures: rec.verifyFailures || 0, finishedAt: rec.finishedAt || null, missing: true });
  const rebuilt = store.db.prepare(`SELECT COUNT(*) c, COALESCE(SUM(size),0) bytes FROM items WHERE upn=? AND sourceApi='pst-import'`).get(m.upn);
  const remaining = store.db.prepare(`SELECT COUNT(*) c FROM items WHERE upn=? AND format='fts' AND status='done'`).get(m.upn);
  const totals = log.reduce((a, r) => ({ replaced: a.replaced + r.replaced, skipped: a.skipped + r.skipped, unmatched: a.unmatched + r.unmatched, failed: a.failed + r.failed, verifyFailures: a.verifyFailures + (r.verifyFailures || 0) }),
    { replaced: 0, skipped: 0, unmatched: 0, failed: 0, verifyFailures: 0 });
  return { upn: m.upn, psts, totals, rebuiltItems: rebuilt.c, rebuiltBytes: rebuilt.bytes, remainingFts: remaining.c, lastRun: log.length ? log[log.length - 1].finishedAt : null, ...pstRepairState.status() };
}));

// Run the PST recovery (scripts/pst-repair.js) as a DETACHED background job:
// it survives server restarts, and its state lives in files (job json + log)
// so the panel always shows the truth instead of a stale "running".
const pstRepairState = {
  file: () => path.join(cfg.dataDir, 'pst-repair-job.json'),
  logFile: () => path.join(cfg.dataDir, 'pst-repair-run.log'),
  read() { try { return JSON.parse(fs.readFileSync(this.file(), 'utf8')); } catch { return null; } },
  alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } },
  status() {
    const j = this.read();
    if (!j || !j.pid) return { running: false, lastLine: null };
    const running = this.alive(j.pid);
    let lastLine = null;
    try {
      const lines = fs.readFileSync(this.logFile(), 'utf8').trim().split('\n').filter(Boolean);
      lastLine = lines.length ? lines[lines.length - 1].slice(0, 300) : null;
    } catch { }
    return { running, lastLine, startedAt: j.startedAt, upn: j.upn };
  }
};
app.post('/api/mailbox/:upn/pst-repair', wrap(async req => {
  const m = store.getMailbox(req.params.upn);
  if (!m) throw new Error('Mailbox not found');
  if (pstRepairState.status().running) { const e = new Error('PST recovery already running'); e.status = 409; throw e; }
  const pstDir = path.join(__dirname, 'pst-import', m.upn.split('@')[0]);
  if (!fs.existsSync(pstDir) || !fs.readdirSync(pstDir).some(f => f.toLowerCase().endsWith('.pst')))
    throw new Error(`No PSTs found in pst-import/${m.upn.split('@')[0]} — drop the PST files there first`);
  const out = fs.openSync(pstRepairState.logFile(), 'w');
  const child = spawn(process.execPath, [path.join(__dirname, 'scripts', 'pst-repair.js'), m.upn, pstDir],
    { stdio: ['ignore', out, out], detached: true });
  child.unref();
  const startedAt = new Date().toISOString();
  fs.writeFileSync(pstRepairState.file(), JSON.stringify({ pid: child.pid, upn: m.upn, startedAt }));
  fs.closeSync(out);
  log('info', m.upn, `PST recovery started from pst-import/${m.upn.split('@')[0]} (pid ${child.pid})`);
  bus.emit('job', { kind: 'pst-repair', upn: m.upn, status: 'running' });
  return { ok: true, startedAt, pid: child.pid };
}));

const guardIdle = upn => {
  if (engine.running || pst.running) throw new Error('already running — stop the current job before deleting');
  const m = store.getMailbox(upn);
  if (!m) throw new Error('Mailbox not found');
  if (m.status === 'syncing') throw new Error('already running — mailbox is syncing');
  return m;
};
app.delete('/api/mailbox/:upn/backup', wrap(async req => {
  const m = guardIdle(req.params.upn);
  const scope = req.query.scope;
  if (scope != null && scope !== 'primary' && scope !== 'archive') { const e = new Error('scope must be primary or archive'); e.status = 400; throw e; }
  const dir = scope
    ? path.join(cfg.dataDir, 'store', safeName(m.upn), scope)
    : path.join(cfg.dataDir, 'store', safeName(m.upn));
  fs.rmSync(dir, { recursive: true, force: true });
  store.deleteMailboxData(m.upn, scope);
  log('info', m.upn, scope
    ? `stored ${scope} backup deleted (local .eml.gz files + database rows for that scope)`
    : 'stored backup deleted (local .eml.gz store + database rows)');
  return { ok: true };
}));
app.delete('/api/mailbox/:upn/folder', wrap(async req => {
  const m = guardIdle(req.params.upn);
  const { scope, folderId } = req.query;
  if (scope !== 'primary' && scope !== 'archive') { const e = new Error('scope must be primary or archive'); e.status = 400; throw e; }
  if (!folderId) { const e = new Error('folderId is required'); e.status = 400; throw e; }
  const folder = store.getFolder(m.upn, scope, folderId);
  if (!folder) { const e = new Error('Folder not found'); e.status = 404; throw e; }
  fs.rmSync(engine.folderDir(m.upn, scope, folder.path), { recursive: true, force: true });
  const { removedItems, removedFolders } = store.deleteFolder(m.upn, scope, folderId);
  log('info', m.upn, `folder "${folder.path}" (${scope}) deleted from local store: ${removedItems} item(s), ${removedFolders} folder(s) — server copy untouched`);
  return { ok: true, removedItems, removedFolders };
}));
app.delete('/api/mailbox/:upn/events', wrap(async req => {
  const m = store.getMailbox(req.params.upn);
  if (!m) throw new Error('Mailbox not found');
  const removed = store.clearEvents(m.upn);
  log('info', '', `events cleared for ${m.upn} (${removed} row(s))`);
  return { ok: true, removed };
}));

app.delete('/api/pst/:upn', wrap(async req => {
  const m = guardIdle(req.params.upn);
  let removed = 0;
  const dir = path.join(cfg.pstDir, safeName(m.upn));
  if (fs.existsSync(dir)) { removed = fs.readdirSync(dir).length; fs.rmSync(dir, { recursive: true, force: true }); }
  const jobsRoot = path.join(cfg.dataDir, 'pstjobs');
  if (fs.existsSync(jobsRoot)) {
    for (const e of fs.readdirSync(jobsRoot)) {
      if (e.startsWith(m.upn + '_') || e.startsWith(safeName(m.upn) + '_')) {
        fs.rmSync(path.join(jobsRoot, e), { recursive: true, force: true });
      }
    }
  }
  store.patchMailboxFields(m.upn, { pstStatus: '' });
  log('info', m.upn, `PST files deleted (${removed} file(s))`);
  return { ok: true, removed };
}));
app.get('/api/mailbox/:upn/items', wrap(async req => {
  const { scope, folderId } = req.query;
  if (!store.getMailbox(req.params.upn)) throw new Error('Mailbox not found');
  if (!scope || !folderId) throw new Error('scope and folderId are required');
  const limit = Math.min(Math.max(parseInt(req.query.limit || '500', 10) || 500, 1), 100000);
  return { items: store.listItems(req.params.upn, scope, folderId, limit) };
}));
const resolveItem = req => {
  const { scope, folderId, itemId } = req.query;
  const folder = store.getFolder(req.params.upn, scope, folderId);
  const item = store.getItem(req.params.upn, scope, folderId, itemId);
  if (!item || !item.fileId) throw new Error('Item not found');
  const folderMap = new Map(store.listFolders(req.params.upn).filter(f => f.scope === scope).map(f => [f.folderId, f]));
  return { scope, folder, fileId: item.fileId, item, folderMap };
};
app.get('/api/mailbox/:upn/item', wrap(async req => {
  const { scope, folder, fileId, item, folderMap } = resolveItem(req);
  // FTS (Graph IE full-fidelity) items: render a best-effort preview extracted
  // from the opaque stream (lib/fts.js — heuristic, preview-only; the .fts.gz
  // stays the untouched restore copy).
  if (item.format === 'fts') {
    const raw = await readRaw(engine.storeRoot, req.params.upn, scope, folder || {}, fileId, folderMap);
    if (!raw) throw new Error('Stored file not found on disk');
    try {
      return ftsPreview(raw);
    } catch {
      return { fts: true, subject: item.subject, receivedAt: item.receivedAt, size: item.size,
        note: 'Full-fidelity restore copy (Exchange FTS format). Preview could not be extracted from this item — download it instead.' };
    }
  }
  const parsed = await parseStoredItem(engine.storeRoot, req.params.upn, scope, folder || {}, fileId, folderMap);
  if (!parsed) throw new Error('Stored file not found on disk');
  return toPreview(parsed);
}));
app.get('/api/mailbox/:upn/download', async (req, res) => {
  try {
    const { scope, folder, fileId, item, folderMap } = resolveItem(req);
    const raw = await readRaw(engine.storeRoot, req.params.upn, scope, folder || {}, fileId, folderMap);
    if (!raw) return res.status(404).json({ error: 'Stored file not found on disk' });
    const name = safeName(item.subject || 'email') || 'email';
    const fts = item.format === 'fts';
    res.set({
      'Content-Type': fts ? 'application/octet-stream' : 'message/rfc822',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}.${fts ? 'fts' : 'eml'}`
    });
    res.send(raw);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});
app.get('/api/mailbox/:upn/export-folder', async (req, res) => {
  try {
    const { scope, folderId } = req.query;
    const recursive = req.query.recursive === '1';
    const upn = req.params.upn;
    const all = store.listFolders(upn).filter(f => f.scope === scope);
    const folderMap = new Map(all.map(f => [f.folderId, f]));
    const root = folderMap.get(folderId);
    if (!root) return res.status(404).json({ error: 'Folder not found' });
    const wanted = new Set([folderId]);
    if (recursive) {
      let grew = true;
      while (grew) {
        grew = false;
        for (const f of all) {
          if (f.parentId && wanted.has(f.parentId) && !wanted.has(f.folderId)) { wanted.add(f.folderId); grew = true; }
        }
      }
    }
    // Pass 1: plan entry names and estimate total bytes from stored MIME sizes so
    // the cap is enforced before any bytes hit the wire.
    const maxBytes = cfg.maxExportBytes || 2 * 1024 * 1024 * 1024;
    const planned = [];
    let total = 0;
    for (const fid of wanted) {
      const f = folderMap.get(fid);
      const prefix = chainPath(folderMap, f).split('/').map(safeName).join('/');
      for (const it of store.listItems(upn, scope, fid, 1000000)) {
        planned.push({ f, name: `${prefix}/${safeName(it.subject || 'email').slice(0, 60) || 'email'}-${safeName(it.itemId.slice(-8))}.eml`, item: it });
        total += it.size || 0;
      }
    }
    if (!planned.length) return res.status(404).json({ error: 'No backed-up emails in this folder' });
    if (total > maxBytes) return res.status(413).json({ error: `folder export too large (~${Math.round(total / 1024 / 1024)} MB > ${Math.round(maxBytes / 1024 / 1024)} MB cap, cfg.maxExportBytes)` });
    // Pass 2: stream a store-only zip straight to the response — no full-buffer build.
    res.set({
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(safeName(root.name || 'folder'))}.zip`
    });
    const archive = new archiver.ZipArchive({ store: true });
    archive.on('error', () => { try { res.socket.destroy(); } catch { } });
    archive.pipe(res);
    let sent = 0;
    for (const p of planned) {
      const raw = await readRaw(engine.storeRoot, upn, scope, p.f, p.item.fileId, folderMap);
      if (!raw) continue;
      sent += raw.length;
      if (sent > maxBytes) { archive.abort(); return res.socket.destroy(); }
      archive.append(raw, { name: p.name });
    }
    await archive.finalize();
  } catch (e) {
    if (res.headersSent) { try { res.socket.destroy(); } catch { } return; }
    res.status(500).json({ error: String(e.message || e) });
  }
});
app.get('/api/mailbox/:upn/attachment', async (req, res) => {
  try {
    const { scope, folder, fileId, item, folderMap } = resolveItem(req);
    const idx = parseInt(req.query.index || '0', 10);
    if (item.format === 'fts') {
      const raw = await readRaw(engine.storeRoot, req.params.upn, scope, folder || {}, fileId, folderMap);
      const a = raw && ftsAttachment(raw, idx);
      if (!a) return res.status(404).json({ error: 'Attachment not found' });
      res.set({
        'Content-Type': a.contentType,
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(a.filename)}`
      });
      return res.send(a.data);
    }
    const parsed = await parseStoredItem(engine.storeRoot, req.params.upn, scope, folder || {}, fileId, folderMap);
    const a = parsed && parsed.attachments && parsed.attachments[idx];
    if (!a) return res.status(404).json({ error: 'Attachment not found' });
    res.set({
      'Content-Type': a.contentType || 'application/octet-stream',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(a.filename || 'attachment')}`
    });
    res.send(a.content);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});
app.post('/api/discover', wrap(() => engine.discover()));
app.post('/api/backup', wrap(req => {
  // Backups and PST exports are designed to run concurrently: the engine
  // publishes item files atomically (tmp + rename) and the exporter only
  // reads local files. Only copy/dedupe (which move files) are excluded.
  if (copyEngine.running || dedupeEngine.running) { const e = new Error('a copy/dedupe job is running — stop it before starting a backup'); e.status = 409; throw e; }
  // Disk-space preflight: refuse to start when the store drive is below the
  // configured reserve (default 10 GB) — never run the disk into the ground.
  try {
    const st = fs.statfsSync(cfg.dataDir);
    const reserve = cfg.diskReserveBytes || 10 * 1024 ** 3;
    if (st.available < reserve) {
      const e = new Error(`insufficient disk space: ${(st.available / 2 ** 30).toFixed(1)} GB free, reserve is ${(reserve / 2 ** 30).toFixed(1)} GB — free space or lower diskReserveBytes`);
      e.status = 507; throw e;
    }
  } catch (e) { if (e.status) throw e; /* statfs failure must not block backups */ }
  const scope = req.body && req.body.scope;
  if (scope != null && scope !== 'archive' && scope !== 'primary') { const e = new Error('invalid scope: only "primary" and "archive" are supported'); e.status = 400; throw e; }
  const provider = req.body && req.body.provider;
  if (provider != null && provider !== 'ews' && provider !== 'graphie') { const e = new Error('invalid provider: only "ews" and "graphie" are supported'); e.status = 400; throw e; }
  const one = req.body && req.body.upn, many = req.body && req.body.upns;
  if ((one && !isValidUpn(one)) || (Array.isArray(many) && many.some(u => !isValidUpn(u)))) { const e = new Error('invalid mailbox id'); e.status = 400; throw e; }
  autoResumeSuppressed = false; // manual start re-arms the auto-resume sweep
  // Engine busy → queue as a background task instead of failing; it starts
  // automatically when the current job finishes.
  if (engine.running || fixTasks.some(fixActive)) {
    const t = { id: ++fixSeq, kind: 'backup', upn: one || null, upns: many || null, scope: scope || null, provider: provider || null, status: 'queued', queuedAt: new Date().toISOString() };
    fixTasks.push(t);
    log('info', one || '', `backup queued behind the running job${scope ? ` (${scope} only)` : ''}`);
    pumpFixTasks();
    return { ok: true, queued: true, task: t };
  }
  return engine.runBackup(one, many, { scope, provider });
}));
let sizesRunning = false;
let sizesStop = false;
let sizesAborter = null;
app.post('/api/sizes', wrap(async req => {
  if (sizesRunning) { const e = new Error('a sizes scan is already running — stop the current job first'); e.status = 409; throw e; }
  const source = ['ews', 'exo', 'both'].includes(req.body && req.body.source) ? req.body.source : 'both';
  const upn = req.body && req.body.upn;
  const upns = req.body && Array.isArray(req.body.upns) ? req.body.upns.filter(u => typeof u === 'string') : null;
  if (upn && !isValidUpn(upn)) { const e = new Error('invalid mailbox id'); e.status = 400; throw e; }
  if (upns && upns.some(u => !isValidUpn(u))) { const e = new Error('invalid mailbox id'); e.status = 400; throw e; }
  // Bulk fetch covers licensed user mailboxes only (shared/guest skipped for now);
  // a single-mailbox fetch via {upn} or a selection via {upns} works for any type.
  const targets = upns ? upns : upn ? [upn] : store.listMailboxes().filter(m => m.type === 'user').map(m => m.upn);
  if ((upn || upns) && targets.some(u => !store.getMailbox(u))) throw new Error('Mailbox not found');
  const jobId = store.createJob('sizes', targets.length);
  sizesRunning = true; sizesStop = false;
  const aborter = new AbortController();
  sizesAborter = aborter;
  (async () => {
    let exoFailed = false;
    if (source !== 'ews') {
      // Authoritative path: one EXO PowerShell process walks all targets
      // (per-chunk processes would re-prompt the device sign-in each chunk).
      try {
        log('info', '', 'fetching sizes via Exchange Online PowerShell (authoritative)…');
        const res = await exo.mailboxStats(targets, si => {
          exoSignIn = si;
          bus.emit('progress', { job: jobId });
          if (si) log('info', '', `EXO sign-in requested — code ${si.code} at microsoft.com/devicelogin`);
        });
        let done = 0;
        for (const u of targets) {
          const st = res.stats[u];
          const err = res.errors[u];
          if (st) {
            store.patchMailboxFields(u, {
              serverPrimaryBytes: st.primaryBytes,
              serverArchiveBytes: st.archiveBytes,
              serverPrimaryItems: st.primaryItems,
              serverArchiveItems: st.archiveItems,
              serverSizeAt: new Date().toISOString(),
              hasArchive: st.archiveStatus === 'Active' ? 1 : 0,
              autoExpandingArchive: st.autoExpanding ? 1 : 0,
              sizeSource: 'exo'
            });
            log('info', u, `server size (EXO): primary ${st.primaryBytes} bytes` + (st.archiveBytes == null ? '' : `, archive ${st.archiveBytes} bytes`) + (st.autoExpanding ? ', auto-expanding archive' : ''));
            // Partition inventory from real reported numbers only: EXO archiveBytes is
            // the TOTAL archive (all partitions); the EWS-accessible main partition is
            // measured in the EWS phase below. An AEA mailbox with a gap gets a derived
            // 'aux-combined' row — never split into fabricated per-partition sizes.
            if (st.archiveStatus === 'Active') {
              const mbx = store.getMailbox(u);
              const mainBytes = mbx && mbx.ewsArchiveBytes != null ? mbx.ewsArchiveBytes : null;
              store.upsertPartition({ upn: u, partitionId: 'main', partitionType: 'main', discoveredVia: 'ews', logicalBytes: mainBytes });
              if (st.autoExpanding && st.archiveBytes != null && mainBytes != null && st.archiveBytes > mainBytes) {
                store.upsertPartition({ upn: u, partitionId: 'aux-combined', partitionType: 'aux', discoveredVia: 'exo-derived', logicalBytes: st.archiveBytes - mainBytes, status: 'unreachable' });
              }
            }
            refreshCoverage(store, u, { ieEnabled: !!graphie });
          } else {
            log('error', u, 'EXO size fetch failed: ' + (err || 'unknown'));
          }
          store.updateJob(jobId, { done: ++done, detail: u });
          bus.emit('progress', { job: jobId });
        }
        if (source === 'exo') {
          const nErr = Object.keys(res.errors).length;
          store.updateJob(jobId, { status: sizesStop ? 'stopped' : nErr ? 'error' : 'done', finishedAt: new Date().toISOString() });
          bus.emit('progress', { job: jobId });
        }
      } catch (e) {
        exoFailed = true;
        log('error', '', 'EXO sizes job failed: ' + String(e.message || e));
        if (source === 'exo') store.updateJob(jobId, { status: 'error', finishedAt: new Date().toISOString() });
        else log('warn', '', 'falling back to EWS-only sizes (folder walk) for all mailboxes');
      }
      if (source === 'exo') return;
    }
    // EWS phase. After a successful EXO pass ('both'), only the archive-accessible
    // portion is missing — primary is fully visible to EWS, so walking it again
    // would be wasted time. If EXO failed, fall back to a full EWS walk.
    let phaseTargets = targets, archiveOnly = false;
    if (source === 'both' && !exoFailed) {
      phaseTargets = targets.filter(u => { const m = store.getMailbox(u); return m && m.hasArchive; });
      archiveOnly = true;
      log('info', '', `EXO totals stored — measuring EWS-accessible archive size for ${phaseTargets.length} archive mailbox(es)…`);
      store.updateJob(jobId, { total: targets.length + phaseTargets.length });
      if (!phaseTargets.length) {
        store.updateJob(jobId, { status: 'done', finishedAt: new Date().toISOString() });
        bus.emit('progress', { job: jobId });
        return;
      }
    }
    let done = source === 'both' && !exoFailed ? targets.length : 0, failed = false, next = 0;
    const conc = engine.running ? 2 : Math.max(1, Math.min(4, parseInt(cfg.sizeScanConcurrency || '3', 10) || 3));
    const worker = async () => {
      while (next < phaseTargets.length && !sizesStop) {
        const u = phaseTargets[next++];
        store.updateJob(jobId, { done, detail: u });
        bus.emit('progress', { job: jobId });
        log('info', u, archiveOnly ? 'measuring accessible archive size…' : 'fetching server sizes…');
        let lastPing = 0;
        const onProgress = (folders, bytes) => {
          const now = Date.now();
          if (now - lastPing < 1000) return;
          lastPing = now;
          store.updateJob(jobId, { done, detail: `${u} — ${folders} folders scanned` });
          bus.emit('progress', { job: jobId });
        };
        try {
          if (archiveOnly) {
            const ab = await ews.folderSize(u, 'archivemsgfolderroot', onProgress, undefined, aborter.signal);
            store.patchMailboxFields(u, { ewsArchiveBytes: ab });
            store.upsertPartition({ upn: u, partitionId: 'main', partitionType: 'main', discoveredVia: 'ews', logicalBytes: ab });
            const mbx = store.getMailbox(u);
            if (mbx && mbx.autoExpandingArchive && mbx.serverArchiveBytes != null && mbx.serverArchiveBytes > ab) {
              store.upsertPartition({ upn: u, partitionId: 'aux-combined', partitionType: 'aux', discoveredVia: 'exo-derived', logicalBytes: mbx.serverArchiveBytes - ab, status: 'unreachable' });
            }
            refreshCoverage(store, u, { ieEnabled: !!graphie });
            log('info', u, `accessible archive size: ${ab} bytes`);
          } else {
            const s = await ews.mailboxSizes(u, onProgress, undefined, aborter.signal);
            const fields = {
              ewsPrimaryBytes: s.primaryBytes,
              ewsArchiveBytes: s.archiveBytes,
              serverSizeAt: new Date().toISOString(),
              hasArchive: s.archiveBytes != null ? 1 : 0
            };
            // EXO stats are authoritative (they include auto-expanding archive
            // auxiliary storage) — don't let an EWS scan clobber them.
            const cur = store.getMailbox(u);
            if (!cur || cur.sizeSource !== 'exo') {
              fields.serverPrimaryBytes = s.primaryBytes;
              fields.serverArchiveBytes = s.archiveBytes;
              fields.sizeSource = 'ews';
            }
            store.patchMailboxFields(u, fields);
            log('info', u, `server size: primary ${s.primaryBytes} bytes` + (s.archiveBytes == null ? '' : `, archive ${s.archiveBytes} bytes`));
          }
        } catch (e) {
          if (e.aborted || e.name === 'AbortError') throw e;
          failed = true;
          log('error', u, 'server size fetch failed: ' + String(e.fault || e.message || e));
        }
        store.updateJob(jobId, { done: ++done, detail: u });
        bus.emit('progress', { job: jobId });
      }
    };
    try {
      await Promise.all(Array.from({ length: conc }, worker));
    } catch (e) {
      if (!(e && (e.aborted || e.name === 'AbortError'))) throw e;
    }
    if (sizesStop) {
      log('info', '', 'sizes job stopped by user');
      store.updateJob(jobId, { status: 'stopped', finishedAt: new Date().toISOString() });
      bus.emit('progress', { job: jobId });
      return;
    }
    store.updateJob(jobId, { status: failed ? 'error' : 'done', finishedAt: new Date().toISOString() });
    bus.emit('progress', { job: jobId });
  })().catch(e => {
    log('error', '', 'sizes job failed: ' + String(e.message || e));
    store.updateJob(jobId, { status: 'error', finishedAt: new Date().toISOString() });
  }).finally(() => {
    sizesRunning = false;
    sizesAborter = null;
    exoSignIn = null;
    bus.emit('progress', { job: jobId });
  });
  return { ok: true, jobId, total: targets.length };
}));
// ---------- Count scan: refresh remote item counts without downloading items ----------
// Walks each mailbox's folder tree (Graph primary, EWS archive) and upserts the
// server-side item counts, so "X / Y emails" reflects reality before any backup.
// Cursors (deltaToken/syncState) are passed undefined → COALESCE keeps them.
let scanRunning = false;
let scanStop = false;
let scanAborter = null;
const scanLive = {}; // upn -> { scope, folders } while a count scan walks it
app.post('/api/scan', wrap(async req => {
  if (scanRunning) { const e = new Error('a count scan is already running — stop the current job first'); e.status = 409; throw e; }
  const upn = req.body && req.body.upn;
  const upns = req.body && Array.isArray(req.body.upns) ? req.body.upns.filter(u => typeof u === 'string') : null;
  const scope = ['primary', 'archive'].includes(req.body && req.body.scope) ? req.body.scope : null;
  if (upn && !isValidUpn(upn)) { const e = new Error('invalid mailbox id'); e.status = 400; throw e; }
  if (upns && upns.some(u => !isValidUpn(u))) { const e = new Error('invalid mailbox id'); e.status = 400; throw e; }
  const targets = upns ? upns : upn ? [upn] : store.listMailboxes().filter(m => m.type === 'user').map(m => m.upn);
  if ((upn || upns) && targets.some(u => !store.getMailbox(u))) throw new Error('Mailbox not found');
  const jobId = store.createJob('scan', targets.length);
  scanRunning = true; scanStop = false;
  const aborter = new AbortController();
  scanAborter = aborter;
  const upsert = (u, sc) => f => store.upsertFolder({ upn: u, scope: sc, ...f, deltaToken: undefined, syncState: undefined });
  (async () => {
    let done = 0, failed = false, next = 0;
    const conc = engine.running ? 2 : Math.max(1, Math.min(4, parseInt(cfg.scanConcurrency || '3', 10) || 3));
    const worker = async () => {
      while (next < targets.length && !scanStop) {
        const u = targets[next++];
        store.updateJob(jobId, { done, detail: u });
        bus.emit('progress', { job: jobId });
        log('info', u, `scanning folder counts${scope ? ` (${scope})` : ''}…`);
        let lastPing = 0, lastLogged = 0;
        const onProgress = (folders) => {
          if (scanLive[u]) scanLive[u].folders = folders;
          const now = Date.now();
          if (now - lastPing >= 1000) {
            lastPing = now;
            store.updateJob(jobId, { done, detail: `${u} — ${folders} folders scanned` });
            bus.emit('progress', { job: jobId });
          }
          if (folders - lastLogged >= 250) {
            lastLogged = folders;
            log('info', u, `count scan: ${folders} folders…`);
          }
        };
        try {
          if (!scope || scope === 'primary') {
            scanLive[u] = { scope: 'primary', folders: 0 };
            await graph.folderTree(u, onProgress, upsert(u, 'primary'));
          }
          const m = store.getMailbox(u);
          // Archive walk when an archive is known/assumed; sizes never fetched
          // (EXO grant pending) means unknown, so try anyway — EWS errors
          // simply mean there is no accessible archive.
          if ((!scope || scope === 'archive') && m && (m.hasArchive || (m.serverArchiveBytes == null && m.ewsArchiveBytes == null))) {
            try {
              scanLive[u] = { scope: 'archive', folders: 0 };
              await ews.folderTree(u, onProgress, aborter.signal, upsert(u, 'archive'));
            } catch (e2) {
              if (e2.aborted || e2.name === 'AbortError') throw e2;
              log('warn', u, 'archive count scan skipped: ' + String(e2.fault || e2.message || e2));
            }
          }
          log('info', u, 'count scan complete');
        } catch (e) {
          if (e.aborted || e.name === 'AbortError') throw e;
          failed = true;
          log('error', u, 'count scan failed: ' + String(e.fault || e.message || e));
        }
        delete scanLive[u];
        store.updateJob(jobId, { done: ++done, detail: u });
        bus.emit('progress', { job: jobId });
      }
    };
    try {
      await Promise.all(Array.from({ length: conc }, worker));
    } catch (e) {
      if (!(e && (e.aborted || e.name === 'AbortError'))) throw e;
    }
    if (scanStop) {
      log('info', '', 'count scan stopped by user');
      store.updateJob(jobId, { status: 'stopped', finishedAt: new Date().toISOString() });
      bus.emit('progress', { job: jobId });
      return;
    }
    store.updateJob(jobId, { status: failed ? 'error' : 'done', finishedAt: new Date().toISOString() });
    bus.emit('progress', { job: jobId });
  })().catch(e => {
    log('error', '', 'count scan failed: ' + String(e.message || e));
    store.updateJob(jobId, { status: 'error', finishedAt: new Date().toISOString() });
  }).finally(() => {
    scanRunning = false;
    scanAborter = null;
    bus.emit('progress', { job: jobId });
  });
  return { ok: true, jobId, total: targets.length };
}));
// ---------- EXO compliance-search export (full mailbox incl. archive) ----------
// Independent of backup/PST jobs (network-bound, read-only on local files).
app.post('/api/exo-export', wrap(req => {
  if (exoExport.running) { const e = new Error('an EXO export is already running'); e.status = 409; throw e; }
  const one = req.body && req.body.upn, many = req.body && req.body.upns;
  if ((one && !isValidUpn(one)) || (Array.isArray(many) && many.some(u => !isValidUpn(u)))) { const e = new Error('invalid mailbox id'); e.status = 400; throw e; }
  if ((one || many) && (one ? [one] : many).some(u => !store.getMailbox(u))) { const e = new Error('Mailbox not found'); e.status = 404; throw e; }
  const jobId = store.createJob('exoexport', 0);
  exoExport.runExport({ upn: one || undefined, upns: Array.isArray(many) && many.length ? many : undefined })
    .then(() => store.updateJob(jobId, { status: 'done', finishedAt: new Date().toISOString() }))
    .catch(e => {
      log('error', '', 'EXO export failed: ' + String(e.message || e));
      store.updateJob(jobId, { status: 'error', detail: String(e.message || e).slice(0, 300), finishedAt: new Date().toISOString() });
    });
  log('info', one || '', `EXO export started${many && many.length > 1 ? ` for ${many.length} mailboxes` : ''} (full mailbox incl. online archive → ${path.join(cfg.dataDir, 'exo-export')})`);
  return { ok: true, jobId };
}));
// Manual PST import: ingest .pst files the user dropped into
// data/exo-export/<upn>/ (from a manual Purview portal export) into the
// browsable backup store. Free route for tenants without Purview billing.
app.post('/api/exo-ingest', wrap(async req => {
  if (exoExport.running) { const e = new Error('an EXO export/import job is already running'); e.status = 409; throw e; }
  const upn = req.body && req.body.upn;
  if (!isValidUpn(upn)) { const e = new Error('invalid mailbox id'); e.status = 400; throw e; }
  if (!store.getMailbox(upn)) { const e = new Error('Mailbox not found'); e.status = 404; throw e; }
  return exoExport.importLocalPsts(upn);
}));
app.delete('/api/mailbox/:upn/exo-export', wrap(req => {
  if (exoExport.running) { const e = new Error('an EXO export is running — stop it first'); e.status = 409; throw e; }
  const m = store.getMailbox(req.params.upn);
  if (!m) throw new Error('Mailbox not found');
  const dir = path.join(cfg.dataDir, 'exo-export', safeName(m.upn));
  let removed = 0;
  if (fs.existsSync(dir)) { removed = fs.readdirSync(dir).length; fs.rmSync(dir, { recursive: true, force: true }); }
  store.deleteExoExport(m.upn);
  log('info', m.upn, `EXO export PSTs deleted (${removed} file/dir entr${removed === 1 ? 'y' : 'ies'})`);
  return { ok: true, removed };
}));
app.post('/api/verify', wrap(req => {
  if (pst.running) { const e = new Error('a PST export is running — stop it before starting a verify'); e.status = 409; throw e; }
  const vupn = req.body && req.body.upn;
  if (vupn && !isValidUpn(vupn)) { const e = new Error('invalid mailbox id'); e.status = 400; throw e; }
  if (engine.running || fixTasks.some(fixActive)) {
    const t = { id: ++fixSeq, kind: 'verify', upn: vupn || null, status: 'queued', queuedAt: new Date().toISOString() };
    fixTasks.push(t);
    log('info', vupn || '', 'verify queued behind the running job');
    pumpFixTasks();
    return { ok: true, queued: true, task: t };
  }
  return engine.runVerify(vupn);
}));

// ---------- Background task queue ----------
// fix-gaps tasks run verify + backup; queued 'backup'/'verify' tasks come from
// action buttons pressed while the engine is busy. Each task waits for the
// engine to be free, so the UI stays usable during long-running jobs.
const fixTasks = []; // {id, kind: fix|backup|verify, upn, upns?, scope?, status: queued|waiting|verify|backup|done|error|cancelled, note, queuedAt, startedAt, finishedAt}
let fixSeq = 0;
let fixPumping = false;
const fixActive = t => ['queued', 'waiting', 'verify', 'backup'].includes(t.status);
const sleep2s = () => new Promise(r => setTimeout(r, 2000));
async function pumpFixTasks() {
  if (fixPumping) return;
  fixPumping = true;
  try {
    for (;;) {
      const t = fixTasks.find(x => x.status === 'queued');
      if (!t) break;
      try {
        t.status = 'waiting';
        while (engine.running || pst.running || copyEngine.running || dedupeEngine.running) {
          if (t.cancelled) throw new Error('cancelled');
          await sleep2s();
        }
        t.startedAt = new Date().toISOString();
        if (t.kind === 'backup') {
          t.status = 'backup';
          log('info', t.upn || '', 'queued backup started');
          await engine.runBackup(t.upn, t.upns, { scope: t.scope || undefined, provider: t.provider || undefined });
        } else if (t.kind === 'verify') {
          t.status = 'verify';
          log('info', t.upn || '', 'queued verify started');
          await engine.runVerify(t.upn || undefined);
        } else {
          t.status = 'verify';
          log('info', t.upn, 'fix-gaps: verify started (cursors of incomplete folders will be reset)');
          await engine.runVerify(t.upn);
          while (engine.running) await sleep2s();
          t.status = 'backup';
          log('info', t.upn, 'fix-gaps: backup started to fill the gaps');
          await engine.runBackup(t.upn, null, {});
        }
        t.status = 'done';
        log('info', t.upn || '', `${t.kind === 'fix' ? 'fix-gaps' : 'queued ' + t.kind}: completed`);
      } catch (e) {
        t.status = t.cancelled ? 'cancelled' : 'error';
        t.note = String(e.message || e);
        if (!t.cancelled) log('warn', t.upn, `fix-gaps failed: ${t.note}`);
      } finally {
        t.finishedAt = new Date().toISOString();
        // keep the list bounded, prefer dropping oldest finished tasks
        if (fixTasks.length > 60) {
          const i = fixTasks.findIndex(x => !fixActive(x));
          if (i >= 0) fixTasks.splice(i, 1);
        }
      }
    }
  } finally { fixPumping = false; }
}
app.post('/api/fix-gaps', wrap(req => {
  const upn = req.body && req.body.upn;
  if (!upn || !isValidUpn(upn)) { const e = new Error('invalid mailbox id'); e.status = 400; throw e; }
  if (!store.getMailbox(upn)) throw new Error('Mailbox not found');
  if (fixTasks.some(t => t.upn === upn && fixActive(t))) { const e = new Error('a fix-gaps task for this mailbox is already queued or running'); e.status = 409; throw e; }
  const t = { id: ++fixSeq, kind: 'fix', upn, status: 'queued', queuedAt: new Date().toISOString() };
  fixTasks.push(t);
  log('info', upn, 'fix-gaps task queued');
  pumpFixTasks();
  return { ok: true, task: t };
}));
app.get('/api/tasks', wrap(async () => ({ fixTasks: fixTasks.slice(-60) })));
app.delete('/api/tasks/:id', wrap(req => {
  const t = fixTasks.find(x => x.id === Number(req.params.id));
  if (!t) throw new Error('Task not found');
  if (t.status === 'queued' || t.status === 'waiting') { t.cancelled = true; t.status = 'cancelled'; t.finishedAt = new Date().toISOString(); }
  else { const e = new Error('only queued tasks can be cancelled — stop the running verify/backup instead'); e.status = 409; throw e; }
  return { ok: true };
}));
app.post('/api/pst', wrap(req => {
  // Safe alongside a backup: the engine publishes item files atomically
  // (tmp + rename), so the exporter never reads a partial file; items that
  // arrive mid-export are simply picked up by the next run (resume manifest).
  const pupn = req.body && req.body.upn;
  if (pupn && !isValidUpn(pupn)) { const e = new Error('invalid mailbox id'); e.status = 400; throw e; }
  let plan = req.body && req.body.plan;
  const scope = req.body && req.body.scope;
  // Scope-only export: one plan part holding the scope's top-level folders
  // (the exporter matches subfolders by segment-aware prefix).
  if (scope === 'primary' || scope === 'archive') {
    if (!pupn) { const e = new Error('scope export needs a mailbox id'); e.status = 400; throw e; }
    if (plan) { const e = new Error('pass either scope or plan, not both'); e.status = 400; throw e; }
    const tops = store.folderStats(pupn).filter(f => f.scope === scope && f.backedUp > 0 && !(f.path || '').includes('/'));
    if (!tops.length) { const e = new Error(`no downloaded ${scope} folders to export`); e.status = 400; throw e; }
    plan = [{ name: scope, folders: tops.map(f => `${scope}/${f.path}`) }];
  }
  if (pstPending) { const e = new Error('a PST export is already queued for the scheduled window'); e.status = 409; throw e; }
  if (!inPstWindow()) {
    pstPending = { upn: pupn || null, plan: plan || null };
    log('info', '', `PST export queued — scheduled between ${cfg.pstWindow.from} and ${cfg.pstWindow.to} (config.json: pstWindow)`);
    return { ok: true, queued: true, window: cfg.pstWindow };
  }
  return pst.runExport(pupn, plan)
    .catch(e => {
      if (String(e.message || e).startsWith('Invalid PST plan')) { e.status = 400; }
      throw e;
    });
}));

// Off-hours PST scheduling: with `pstWindow: {"from":"20:00","to":"08:00"}`
// in config.json, export requests made outside the window queue up and start
// automatically when the window opens (one pending export at a time).
const pstToMin = s => { const [h, m] = String(s || '0:0').split(':').map(Number); return (h || 0) * 60 + (m || 0); };
const inPstWindow = () => {
  const w = cfg.pstWindow;
  if (!w || !w.from || !w.to) return true;
  const cur = new Date().getHours() * 60 + new Date().getMinutes();
  const f = pstToMin(w.from), t = pstToMin(w.to);
  if (f === t) return true;
  return f < t ? (cur >= f && cur < t) : (cur >= f || cur < t); // overnight windows
};
let pstPending = null; // {upn, plan}
setInterval(() => {
  if (!pstPending || pst.running || !inPstWindow()) return;
  const p = pstPending;
  pstPending = null;
  log('info', '', `scheduled PST export starting (window ${cfg.pstWindow.from}–${cfg.pstWindow.to}): ${p.upn || 'all mailboxes'}`);
  pst.runExport(p.upn, p.plan).catch(e => log('error', '', 'scheduled PST export failed: ' + e.message));
}, 60 * 1000).unref();
// ---------- Copy/move: local backup → live mailbox ----------
app.post('/api/copy', wrap(req => {
  // Copy reads local files and writes to the target mailbox — safe to run
  // alongside a backup (per-call Graph abort signals keep Stop working).
  if (pst.running || copyEngine.running || dedupeEngine.running) { const e = new Error('another job is running — stop it first'); e.status = 409; throw e; }
  const { srcUpn, dstUpn, folderKeys, mode, prefix } = req.body || {};
  if (!isValidUpn(srcUpn) || !isValidUpn(dstUpn)) { const e = new Error('invalid mailbox id'); e.status = 400; throw e; }
  if (srcUpn === dstUpn) { const e = new Error('source and target mailbox must differ'); e.status = 400; throw e; }
  if (!store.getMailbox(srcUpn)) { const e = new Error('source mailbox not found'); e.status = 404; throw e; }
  if (mode != null && mode !== 'copy' && mode !== 'move') { const e = new Error('mode must be copy or move'); e.status = 400; throw e; }
  if (Array.isArray(folderKeys) && folderKeys.some(k => typeof k !== 'string')) { const e = new Error('invalid folder selection'); e.status = 400; throw e; }
  if (prefix != null && (typeof prefix !== 'string' || prefix.length > 120)) { const e = new Error('invalid prefix'); e.status = 400; throw e; }
  return copyEngine.start({ srcUpn, dstUpn, folderKeys, mode: mode || 'copy', prefix });
}));
app.get('/api/copy/:jobId', wrap(async req => {
  const jobId = parseInt(req.params.jobId, 10);
  if (!Number.isFinite(jobId)) { const e = new Error('invalid job id'); e.status = 400; throw e; }
  const job = store.listJobs().find(j => j.id === jobId)
    || store.db.prepare('SELECT * FROM jobs WHERE id=?').get(jobId);
  if (!job) { const e = new Error('job not found'); e.status = 404; throw e; }
  return { job, report: store.copyReport(jobId), running: copyEngine.running };
}));

// ---------- Compare: live mailbox browse (read-only) + per-item transfer ----------
const liveFolderCache = new Map(); // upn -> { at, folders }
const liveFolderProg = new Map();  // upn -> { running, found, current }
const liveFolderDir = () => path.join(cfg.dataDir, 'live-folders');
// Folder walks are expensive (Graph throttling), so a fetched tree is kept
// forever — memory first, data/live-folders/<upn>.json across restarts —
// and only re-walked when the user explicitly asks (refresh=1).
app.get('/api/live/:upn/folders/progress', wrap(async req =>
  liveFolderProg.get(req.params.upn) || { running: false, found: 0, current: '' }));
app.get('/api/live/:upn/folders', wrap(async req => {
  const upn = req.params.upn;
  if (req.query.refresh === '1') {
    if (liveFolderProg.get(upn)?.running) { const e = new Error('folder fetch already running for this mailbox'); e.status = 409; throw e; }
    liveFolderProg.set(upn, { running: true, found: 0, current: '' });
    try {
      const folders = await graph.folderTree(upn,
        (n, currentPath) => liveFolderProg.set(upn, { running: true, found: n, current: currentPath || '' }));
      const rec = { at: Date.now(), folders };
      liveFolderCache.set(upn, rec);
      await fsp.mkdir(liveFolderDir(), { recursive: true });
      await fsp.writeFile(path.join(liveFolderDir(), safeName(upn) + '.json'), JSON.stringify(rec));
      return rec;
    } finally {
      liveFolderProg.delete(upn);
    }
  }
  const hit = liveFolderCache.get(upn);
  if (hit) return hit;
  try {
    const rec = JSON.parse(await fsp.readFile(path.join(liveFolderDir(), safeName(upn) + '.json'), 'utf8'));
    liveFolderCache.set(upn, rec);
    return rec;
  } catch { }
  return { folders: null, at: null };
}));
app.get('/api/live/:upn/items', wrap(async req => {
  const { folderId } = req.query;
  if (!folderId) { const e = new Error('folderId is required'); e.status = 400; throw e; }
  return { items: await graph.listMessages(req.params.upn, folderId) };
}));
app.get('/api/live/:upn/item', wrap(async req => {
  const mime = await graph.getMessageMime(req.params.upn, req.query.itemId);
  if (!mime) { const e = new Error('Item not found'); e.status = 404; throw e; }
  return { ...toPreview(await simpleParser(mime)), size: mime.length };
}));
app.get('/api/live/:upn/download', async (req, res) => {
  try {
    const mime = await graph.getMessageMime(req.params.upn, req.query.itemId);
    if (!mime) return res.status(404).json({ error: 'Item not found' });
    const name = safeName(parseMimeHeaders(mime).subject || 'email') || 'email';
    res.set({
      'Content-Type': 'message/rfc822',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}.eml`
    });
    res.send(mime);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});
app.get('/api/live/:upn/attachment', async (req, res) => {
  try {
    const mime = await graph.getMessageMime(req.params.upn, req.query.itemId);
    if (!mime) return res.status(404).json({ error: 'Item not found' });
    const idx = parseInt(req.query.index || '0', 10);
    const parsed = await simpleParser(mime);
    const a = parsed.attachments && parsed.attachments[idx];
    if (!a) return res.status(404).json({ error: 'Attachment not found' });
    res.set({
      'Content-Type': a.contentType || 'application/octet-stream',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(a.filename || 'attachment')}`
    });
    res.send(a.content);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Synchronous per-item transfer between the local store and a live mailbox.
// direction 'toLive': local .eml.gz → Graph MIME import into dstFolderId.
// direction 'toLocal': live message → gz file in the local store (scope dstScope).
// Every successful item is recorded in `compareUndo` so the action can be reversed.
let compareUndo = null; // { label, at, direction, mode, srcUpn, dstUpn, dstScope, records, foldersCreated }
// Message-ID / internetMessageId normalization for transfer dedupe keys.
const normMsgId = s => { const v = String(s || '').replace(/[<>]/g, '').trim().toLowerCase(); return v || null; };
// Fuzzy "same email" matcher across API channels: Graph/EWS/Graph-IE/PST copies
// of one physical message get different ids, and receivedAt/size drift by a few
// seconds/bytes (Exchange normalizes MIME). Exact subject + receivedAt within
// 2 min + size within 10% (when known on both sides) counts as a duplicate.
const fuzzyDupes = () => {
  const list = [];
  const norm = s => String(s || '').trim().toLowerCase();
  return {
    add(subject, receivedAt, size) {
      list.push({ s: norm(subject), t: receivedAt ? (+new Date(receivedAt) || null) : null, z: size || null });
    },
    has(subject, receivedAt, size) {
      const s = norm(subject); if (!s) return false;
      const t = receivedAt ? (+new Date(receivedAt) || null) : null;
      for (const e of list) {
        if (e.s !== s) continue;
        if (e.t && t && Math.abs(e.t - t) > 120000) continue;
        if (e.z && size && Math.abs(e.z - size) / Math.max(e.z, size) > 0.10) continue;
        return true;
      }
      return false;
    }
  };
};
// One compare transfer at a time, with cooperative cancellation (POST /api/stop/compare).
let compareRunning = false, compareStop = false;
// Live progress of the running (or last finished) compare action — kept after
// completion so a late poll still returns the final state.
let compareProg = null; // { running, kind, label, src, dst, startedAt, foldersDone, foldersTotal, itemsDone, itemsTotal, done, skipped, failed, currentFolder, stopped }
const sideName = (upn, name, tag) => (tag ? `${upn} (${tag})` : upn) + (name ? ` · ${name}` : '');
const compareGuard = fn => wrap(async req => {
  if (copyEngine.running) { const e = new Error('a copy job is running — stop it first'); e.status = 409; throw e; }
  if (compareRunning) { const e = new Error('a compare transfer is already running'); e.status = 409; throw e; }
  compareRunning = true; compareStop = false;
  try { return await fn(req); } finally {
    compareRunning = false;
    if (compareProg) { compareProg.running = false; compareProg.stopped = compareStop; }
  }
});
app.get('/api/compare/progress', wrap(async req => compareProg || { running: false }));
// Persistent compare transfer history (one row per completed action).
const logCompare = r => { try { store.addCompareLog(r); } catch (e) { console.error('compare_log insert failed:', e.message); } };
app.get('/api/compare/history', wrap(async req => {
  const upn = typeof req.query.upn === 'string' && req.query.upn ? req.query.upn : null;
  if (upn && !isValidUpn(upn)) { const e = new Error('invalid mailbox id'); e.status = 400; throw e; }
  return { rows: store.compareHistory(upn) };
}));
app.post('/api/compare/transfer', compareGuard(async req => {
  if (copyEngine.running) { const e = new Error('a copy job is running — stop it first'); e.status = 409; throw e; }
  const { direction, mode, srcUpn, dstUpn, items, dstFolderId, dstFolder } = req.body || {};
  if (direction !== 'toLive' && direction !== 'toLocal') { const e = new Error('direction must be toLive or toLocal'); e.status = 400; throw e; }
  if (mode !== 'copy' && mode !== 'move') { const e = new Error('mode must be copy or move'); e.status = 400; throw e; }
  if (!isValidUpn(srcUpn) || !isValidUpn(dstUpn)) { const e = new Error('invalid mailbox id'); e.status = 400; throw e; }
  if (!Array.isArray(items) || !items.length || items.length > 200) { const e = new Error('items must be an array of 1..200 entries'); e.status = 400; throw e; }
  const dstScope = req.body && req.body.dstScope === 'archive' ? 'archive' : 'primary';
  if (direction === 'toLive' && !dstFolderId) { const e = new Error('dstFolderId is required'); e.status = 400; throw e; }
  if (direction === 'toLocal' && (!dstFolder || typeof dstFolder.folderId !== 'string' || typeof dstFolder.path !== 'string')) {
    const e = new Error('dstFolder {folderId, name, path} is required'); e.status = 400; throw e;
  }
  const scopeMaps = new Map(); // scope -> Map(folderId -> folder row)
  const folderMapFor = (upn, sc) => {
    const key = upn + '|' + sc;
    if (!scopeMaps.has(key)) scopeMaps.set(key, new Map(store.listFolders(upn).filter(f => f.scope === sc).map(f => [f.folderId, f])));
    return scopeMaps.get(key);
  };
  const results = [];
  const records = [];
  let done = 0, failed = 0, skipped = 0;
  compareProg = {
    running: true, kind: 'transfer',
    label: `${mode === 'move' ? 'Move' : 'Copy'} ${items.length} email(s)`,
    src: sideName(srcUpn, req.body.srcName, direction === 'toLive' ? ((items[0] && items[0].scope) || 'primary') : 'live'),
    dst: sideName(dstUpn, req.body.dstName, direction === 'toLive' ? 'live' : dstScope),
    startedAt: new Date().toISOString(), foldersDone: 0, foldersTotal: 1,
    itemsDone: 0, itemsTotal: items.length, done: 0, skipped: 0, failed: 0,
    currentFolder: '', stopped: false
  };
  const syncProg = () => Object.assign(compareProg, { done, skipped, failed, itemsDone: done + skipped + failed });
  if (direction === 'toLive') {
    // Dedupe against the destination folder: Message-ID set + subject|receivedAt keys.
    const destMsgIds = new Set(), destKeys = new Set(), destFuzzy = fuzzyDupes();
    for (const m of await graph.listMessages(dstUpn, dstFolderId)) {
      const mid = normMsgId(m.internetMessageId);
      if (mid) destMsgIds.add(mid);
      destKeys.add(String(m.subject || '').trim().toLowerCase() + '|' + String(m.receivedAt || '').slice(0, 19));
      destFuzzy.add(m.subject, m.receivedAt, null);
    }
    for (const it of items) {
      if (compareStop) break;
      const ref = it && it.itemId;
      try {
        if (!it || typeof it.scope !== 'string' || typeof it.folderId !== 'string' || typeof it.itemId !== 'string') throw new Error('invalid item reference');
        const item = store.getItem(srcUpn, it.scope, it.folderId, it.itemId);
        if (!item || !item.fileId) throw new Error('item not found in local store');
        const folder = store.getFolder(srcUpn, it.scope, it.folderId);
        const folderMap = folderMapFor(srcUpn, it.scope);
        const mime = await readRaw(engine.storeRoot, srcUpn, it.scope, folder || {}, item.fileId, folderMap);
        if (!mime) throw new Error('local file missing');
        const hdr = parseMimeHeaders(mime);
        const msgId = hdr.messageId;
        const key = String(hdr.subject != null ? hdr.subject : item.subject || '').trim().toLowerCase() + '|'
          + String(hdr.receivedAt || item.receivedAt || '').slice(0, 19);
        if ((msgId && destMsgIds.has(msgId)) || destKeys.has(key)
          || destFuzzy.has(hdr.subject != null ? hdr.subject : item.subject, hdr.receivedAt || item.receivedAt, item.size)) {
          skipped++; results.push({ ref, ok: true, skipped: true }); syncProg();
          continue;
        }
        const created = await graph.postMessageMime(dstUpn, dstFolderId, mime);
        if (!created || !created.id) throw new Error('upload failed');
        const meta = await graph.getMessageMeta(dstUpn, created.id);
        if (!meta) throw new Error('upload verification failed');
        if (msgId) destMsgIds.add(msgId);
        destKeys.add(key);
        destFuzzy.add(hdr.subject != null ? hdr.subject : item.subject, hdr.receivedAt || item.receivedAt, item.size);
        const rec = { createdId: created.id };
        if (mode === 'move') {
          rec.itemRow = item;
          rec.scope = it.scope; rec.folderId = it.folderId; rec.itemId = it.itemId; rec.fileId = item.fileId;
          const fp = itemFile(engine.storeRoot, srcUpn, it.scope, folder, item.fileId, folderMap);
          if (fp) {
            const gdir = path.join(engine.storeRoot, '_graveyard', safeName(srcUpn));
            await fsp.mkdir(gdir, { recursive: true });
            rec.graveyardPath = path.join(gdir, item.fileId + '.eml.gz');
            await fsp.rename(fp, rec.graveyardPath).catch(() => { });
          }
          store.deleteItem(srcUpn, it.scope, it.folderId, it.itemId);
        }
        done++; records.push(rec); results.push({ ref, ok: true }); syncProg();
      } catch (e) {
        failed++; results.push({ ref, ok: false, error: String(e.message || e).slice(0, 300) }); syncProg();
      }
    }
    if (mode === 'move') store.recomputeMailboxBytes(srcUpn);
  } else {
    store.upsertFolder({ upn: dstUpn, scope: dstScope, folderId: dstFolder.folderId, parentId: dstFolder.parentId || null, name: dstFolder.name || '', path: dstFolder.path, itemCount: dstFolder.itemCount || 0, deltaToken: undefined, syncState: undefined });
    const dir = engine.folderDir(dstUpn, dstScope, dstFolder.path);
    await fsp.mkdir(dir, { recursive: true });
    // Dedupe: sha256 + subject|receivedAt of what's already stored at the
    // destination, plus Message-IDs handled this run (dupes within the source).
    const destMsgIds = new Set(), destKeys = new Set(), destSha = new Set(), destFuzzy = fuzzyDupes();
    for (const row of store.listItemsAll(dstUpn, dstScope, dstFolder.folderId)) {
      if (row.sha256) destSha.add(row.sha256);
      destKeys.add(String(row.subject || '').trim().toLowerCase() + '|' + String(row.receivedAt || '').slice(0, 19));
      destFuzzy.add(row.subject, row.receivedAt, row.size);
    }
    for (const it of items) {
      if (compareStop) break;
      const ref = it && it.id;
      try {
        if (!it || typeof it.id !== 'string') throw new Error('invalid item reference');
        const existing = store.getItem(dstUpn, dstScope, dstFolder.folderId, it.id);
        if (existing && existing.status === 'done' && existing.fileId
          && itemFile(engine.storeRoot, dstUpn, dstScope, dstFolder, existing.fileId, folderMapFor(dstUpn, dstScope))) {
          skipped++; results.push({ ref, ok: true, skipped: true }); syncProg();
          continue;
        }
        const mime = await graph.getMessageMime(srcUpn, it.id);
        if (!mime) throw new Error('message not found on server');
        const meta = parseMimeHeaders(mime);
        const msgId = meta.messageId;
        const key = String(meta.subject || '').trim().toLowerCase() + '|' + String(meta.receivedAt || '').slice(0, 19);
        const sha256 = crypto.createHash('sha256').update(mime).digest('hex');
        if ((msgId && destMsgIds.has(msgId)) || destKeys.has(key) || destSha.has(sha256)
          || destFuzzy.has(meta.subject, meta.receivedAt, mime.length)) {
          skipped++; results.push({ ref, ok: true, skipped: true }); syncProg();
          continue;
        }
        const fileId = crypto.createHash('sha1').update(String(it.id)).digest('hex');
        const tmp = path.join(dir, fileId + '.tmp-' + crypto.randomUUID());
        await pipeline(Readable.from(mime), zlib.createGzip(), fs.createWriteStream(tmp));
        await fsp.rename(tmp, path.join(dir, fileId + '.eml.gz'));
        store.upsertItem({
          upn: dstUpn, scope: dstScope, folderId: dstFolder.folderId, itemId: it.id, fileId,
          subject: meta.subject, receivedAt: meta.receivedAt, sender: meta.sender,
          size: mime.length, status: 'done', attempts: 0,
          sha256
        });
        if (msgId) destMsgIds.add(msgId);
        destKeys.add(key);
        destSha.add(sha256);
        destFuzzy.add(meta.subject, meta.receivedAt, mime.length);
        const rec = { folder: { folderId: dstFolder.folderId, parentId: dstFolder.parentId || null, name: dstFolder.name || '', path: dstFolder.path }, itemId: it.id, fileId };
        if (mode === 'move') {
          const moved = await graph.moveToDeletedItems(srcUpn, it.id);
          if (moved && moved.id) { rec.movedLiveId = moved.id; rec.srcLiveFolderId = typeof req.body.srcFolderId === 'string' ? req.body.srcFolderId : null; }
        }
        done++; records.push(rec); results.push({ ref, ok: true }); syncProg();
      } catch (e) {
        failed++; results.push({ ref, ok: false, error: String(e.message || e).slice(0, 300) }); syncProg();
      }
    }
    store.recomputeMailboxBytes(dstUpn);
  }
  log('info', direction === 'toLive' ? dstUpn : srcUpn,
    `compare ${mode} ${direction}: ${done} done, ${skipped} skipped, ${failed} failed (${items.length} item(s), ${srcUpn} → ${dstUpn})`);
  syncProg(); compareProg.foldersDone = 1;
  let undo = null;
  if (done > 0) {
    const dstName = typeof req.body.dstName === 'string' && req.body.dstName ? req.body.dstName
      : (direction === 'toLive' ? dstFolderId : dstFolder.path);
    const label = `${mode} ${done} email(s) → ${direction === 'toLive' ? 'live' : 'local'} "${dstName}"`;
    compareUndo = { label, at: new Date().toISOString(), direction, mode, srcUpn, dstUpn, dstScope, records, foldersCreated: [] };
    undo = { label };
  }
  logCompare({
    kind: 'transfer', direction, mode, srcUpn, dstUpn, dstScope,
    srcName: req.body.srcName || '', dstName: typeof req.body.dstName === 'string' ? req.body.dstName : '',
    itemsTotal: items.length, done, skipped, failed, stopped: compareStop,
    detail: results.filter(x => x.error).slice(0, 5).map(x => x.error).join(' · ') || null
  });
  return { done, failed, skipped, results, undo, stopped: compareStop };
}));

// Folder-level copy (copy only — no move) with merge semantics: the source
// folder incl. its whole subtree is copied into the destination folder.
// Same-named destination folders are REUSED (merged), never duplicated; an
// email already present at the destination (subject+receivedAt key) is skipped.
app.post('/api/compare/transfer-folder', compareGuard(async req => {
  if (copyEngine.running) { const e = new Error('a copy job is running — stop it first'); e.status = 409; throw e; }
  const { direction, srcUpn, dstUpn, srcFolder, srcFolders, dstFolderId, dstFolder } = req.body || {};
  if (direction !== 'toLive' && direction !== 'toLocal') { const e = new Error('direction must be toLive or toLocal'); e.status = 400; throw e; }
  if (!isValidUpn(srcUpn) || !isValidUpn(dstUpn)) { const e = new Error('invalid mailbox id'); e.status = 400; throw e; }
  if (!srcFolder || typeof srcFolder.folderId !== 'string' || typeof srcFolder.name !== 'string') {
    const e = new Error('srcFolder {folderId, name} is required'); e.status = 400; throw e;
  }
  const dstScope = req.body && req.body.dstScope === 'archive' ? 'archive' : 'primary';
  const itemKey = (subject, receivedAt) => String(subject || '').trim().toLowerCase() + '|' + String(receivedAt || '').slice(0, 19);
  const errors = [];
  const records = [];
  const foldersCreated = []; // children before parents (deepest first) for undo
  let done = 0, skipped = 0, failed = 0, folders = 0;
  const noteErr = e => {
    failed++; if (errors.length < 10) errors.push(String(e.message || e).slice(0, 300));
    if (compareProg) Object.assign(compareProg, { done, skipped, failed, itemsDone: done + skipped + failed });
  };

  if (direction === 'toLive') {
    // dstFolderId may be null → the folder lands at the live mailbox root.
    const scope = srcFolder.scope === 'archive' ? 'archive' : 'primary';
    const rows = store.listFolders(srcUpn).filter(f => f.scope === scope);
    const byId = new Map(rows.map(f => [f.folderId, f]));
    if (!byId.has(srcFolder.folderId)) { const e = new Error('source folder not found in local store'); e.status = 404; throw e; }
    // Subtree = the folder itself + every descendant (walk parentId links).
    const subtree = rows.filter(f => {
      for (let cur = f; cur; cur = byId.get(cur.parentId)) if (cur.folderId === srcFolder.folderId) return true;
      return false;
    }).sort((a, b) => a.path.split('/').length - b.path.split('/').length);
    const folderMap = new Map(rows.map(f => [f.folderId, f]));
    const destIds = new Map(); // local srcFolderId -> live dest folder id
    compareProg = {
      running: true, kind: 'folder', label: `Folder copy "${srcFolder.name}"`,
      src: sideName(srcUpn, srcFolder.name, srcFolder.scope === 'archive' ? 'archive' : 'primary'), dst: sideName(dstUpn, req.body.dstName || (dstFolderId ? '' : 'mailbox root'), 'live'),
      startedAt: new Date().toISOString(), foldersDone: 0, foldersTotal: subtree.length,
      itemsDone: 0, itemsTotal: subtree.reduce((n, f) => n + (f.itemCount || 0), 0),
      done: 0, skipped: 0, failed: 0, currentFolder: '', stopped: false
    };
    const syncProg = () => Object.assign(compareProg, { done, skipped, failed, itemsDone: done + skipped + failed });
    for (const f of subtree) {
      if (compareStop) break;
      try {
        const parentDest = f.folderId === srcFolder.folderId ? (dstFolderId || null) : destIds.get(f.parentId);
        if (parentDest == null && f.folderId !== srcFolder.folderId) throw new Error('parent destination folder not resolved');
        const ensured = await graph.ensureChildFolderEx(dstUpn, parentDest, f.name);
        const destLiveId = ensured.id;
        if (ensured.created) foldersCreated.unshift(destLiveId);
        destIds.set(f.folderId, destLiveId);
        folders++;
        compareProg.currentFolder = f.name; compareProg.foldersDone = folders;
        const destMsgIds = new Set(), destKeys = new Set(), destFuzzy = fuzzyDupes();
        for (const m of await graph.listMessages(dstUpn, destLiveId)) {
          const mid = normMsgId(m.internetMessageId);
          if (mid) destMsgIds.add(mid);
          destKeys.add(itemKey(m.subject, m.receivedAt));
          destFuzzy.add(m.subject, m.receivedAt, null);
        }
        for (const item of store.listItemsAll(srcUpn, scope, f.folderId)) {
          if (compareStop) break;
          try {
            const mime = await readRaw(engine.storeRoot, srcUpn, scope, f, item.fileId, folderMap);
            if (!mime) throw new Error('local file missing');
            const hdr = parseMimeHeaders(mime);
            const msgId = hdr.messageId;
            const key = itemKey(hdr.subject != null ? hdr.subject : item.subject, hdr.receivedAt || item.receivedAt);
            if ((msgId && destMsgIds.has(msgId)) || destKeys.has(key)
              || destFuzzy.has(hdr.subject != null ? hdr.subject : item.subject, hdr.receivedAt || item.receivedAt, item.size)) { skipped++; syncProg(); continue; }
            const created = await graph.postMessageMime(dstUpn, destLiveId, mime);
            if (!created || !created.id) throw new Error('upload failed');
            const meta = await graph.getMessageMeta(dstUpn, created.id);
            if (!meta) throw new Error('upload verification failed');
            if (msgId) destMsgIds.add(msgId);
            destKeys.add(key);
            destFuzzy.add(hdr.subject != null ? hdr.subject : item.subject, hdr.receivedAt || item.receivedAt, item.size);
            done++; records.push({ createdId: created.id }); syncProg();
          } catch (e) { noteErr(e); }
        }
      } catch (e) { noteErr(e); }
    }
  } else {
    if (!Array.isArray(srcFolders) || !srcFolders.length) { const e = new Error('srcFolders (live subtree rows) is required'); e.status = 400; throw e; }
    // dstFolder may be omitted → the folder lands at the local mailbox root.
    const dstRoot = dstFolder && typeof dstFolder.path === 'string'
      ? dstFolder
      : { folderId: null, parentId: null, name: '', path: '' };
    // Archive-only: the local archive tree is rooted at 'Archive root', so a
    // root-level copy must target it to merge by path (primary is unchanged).
    if (dstScope === 'archive' && !dstRoot.path) {
      const ar = store.listFolders(dstUpn).find(f => f.scope === 'archive' && f.path === 'Archive root');
      if (ar) { dstRoot.folderId = ar.folderId; dstRoot.path = ar.path; dstRoot.name = ar.name; }
    }
    // Archive-only: selecting the same-named archive folder as destination
    // means "merge into this folder", not "create a child with the same name".
    const sameFolder = dstScope === 'archive' && !!dstRoot.name && dstRoot.name === srcFolder.name;
    const srcRootRow = srcFolders.find(f => f.folderId === srcFolder.folderId);
    if (!srcRootRow || typeof srcRootRow.path !== 'string') { const e = new Error('srcFolders must include the source folder itself'); e.status = 400; throw e; }
    const srcBase = srcRootRow.path.slice(0, srcRootRow.path.length - srcRootRow.name.length).replace(/\/$/, ''); // path of srcFolder's parent ('' at top level)
    const relPath = f => f.path.slice(srcBase ? srcBase.length + 1 : 0); // path relative to srcFolder's parent
    const dstRows = store.listFolders(dstUpn).filter(f => f.scope === dstScope);
    const byPath = new Map(dstRows.map(f => [f.path, f]));
    const folderMap = new Map(dstRows.map(f => [f.folderId, f]));
    // Reuse a destination folder at the same path (merge), else create it with
    // the live folder's id (consistent with Graph backups).
    const resolveDest = (liveFolder, parentDestId) => {
      const rel = sameFolder
        ? (liveFolder.folderId === srcFolder.folderId ? '' : liveFolder.path.slice(srcRootRow.path.length + 1))
        : relPath(liveFolder);
      const p = rel ? (dstRoot.path ? dstRoot.path + '/' : '') + rel : dstRoot.path;
      const hit = byPath.get(p);
      if (hit) return { folderId: hit.folderId, path: p, created: false };
      store.upsertFolder({ upn: dstUpn, scope: dstScope, folderId: liveFolder.folderId, parentId: parentDestId, name: liveFolder.name, path: p, itemCount: 0, deltaToken: undefined, syncState: undefined });
      const row = { upn: dstUpn, scope: dstScope, folderId: liveFolder.folderId, parentId: parentDestId, name: liveFolder.name, path: p };
      byPath.set(p, row);
      dstRows.push(row);
      folderMap.set(liveFolder.folderId, row);
      return { folderId: liveFolder.folderId, path: p, created: true };
    };
    const subtree = [...srcFolders].sort((a, b) => String(a.path).split('/').length - String(b.path).split('/').length);
    const destByLiveId = new Map(); // live folderId -> { folderId, path }
    compareProg = {
      running: true, kind: 'folder', label: `Folder copy "${srcFolder.name}"`,
      src: sideName(srcUpn, srcFolder.name, 'live'), dst: sideName(dstUpn, req.body.dstName || (dstRoot.path ? dstRoot.path : 'mailbox root'), dstScope),
      startedAt: new Date().toISOString(), foldersDone: 0, foldersTotal: subtree.length,
      itemsDone: 0, itemsTotal: srcFolders.reduce((n, f) => n + (f.itemCount || 0), 0),
      done: 0, skipped: 0, failed: 0, currentFolder: '', stopped: false
    };
    const syncProg = () => Object.assign(compareProg, { done, skipped, failed, itemsDone: done + skipped + failed });
    for (const f of subtree) {
      if (compareStop) break;
      try {
        const parentDest = f.folderId === srcFolder.folderId ? dstRoot.folderId : (destByLiveId.get(f.parentId) || {}).folderId;
        if (parentDest == null && f.folderId !== srcFolder.folderId) throw new Error('parent destination folder not resolved');
        const dest = resolveDest(f, parentDest);
        destByLiveId.set(f.folderId, dest);
        if (dest.created) foldersCreated.unshift({ scope: dstScope, folderId: dest.folderId, path: dest.path });
        folders++;
        compareProg.currentFolder = f.name; compareProg.foldersDone = folders;
        const dir = engine.folderDir(dstUpn, dstScope, dest.path);
        await fsp.mkdir(dir, { recursive: true });
        const destFolderRow = { folderId: dest.folderId, parentId: parentDest, name: f.name, path: dest.path };
        const destKeys = new Set(), destSha = new Set(), destMsgIds = new Set(), destFuzzy = fuzzyDupes();
        for (const row of store.listItemsAll(dstUpn, dstScope, dest.folderId)) {
          if (row.sha256) destSha.add(row.sha256);
          destKeys.add(itemKey(row.subject, row.receivedAt));
          destFuzzy.add(row.subject, row.receivedAt, row.size);
        }
        for (const it of await graph.listMessages(srcUpn, f.folderId)) {
          if (compareStop) break;
          const key = itemKey(it.subject, it.receivedAt);
          const msgId = normMsgId(it.internetMessageId);
          if ((msgId && destMsgIds.has(msgId)) || destKeys.has(key)
            || destFuzzy.has(it.subject, it.receivedAt, null)) { skipped++; syncProg(); continue; }
          try {
            const existing = store.getItem(dstUpn, dstScope, dest.folderId, it.id);
            if (existing && existing.status === 'done' && existing.fileId
              && itemFile(engine.storeRoot, dstUpn, dstScope, destFolderRow, existing.fileId, folderMap)) {
              if (msgId) destMsgIds.add(msgId);
              destKeys.add(key); skipped++; syncProg();
              continue;
            }
            const mime = await graph.getMessageMime(srcUpn, it.id);
            if (!mime) throw new Error('message not found on server');
            const meta = parseMimeHeaders(mime);
            const sha256 = crypto.createHash('sha256').update(mime).digest('hex');
            if (destSha.has(sha256)) {
              if (msgId) destMsgIds.add(msgId);
              destKeys.add(key); skipped++; syncProg();
              continue;
            }
            const fileId = crypto.createHash('sha1').update(String(it.id)).digest('hex');
            const tmp = path.join(dir, fileId + '.tmp-' + crypto.randomUUID());
            await pipeline(Readable.from(mime), zlib.createGzip(), fs.createWriteStream(tmp));
            await fsp.rename(tmp, path.join(dir, fileId + '.eml.gz'));
            store.upsertItem({
              upn: dstUpn, scope: dstScope, folderId: dest.folderId, itemId: it.id, fileId,
              subject: meta.subject, receivedAt: meta.receivedAt, sender: meta.sender,
              size: mime.length, status: 'done', attempts: 0,
              sha256
            });
            if (msgId) destMsgIds.add(msgId);
            destKeys.add(key);
            destSha.add(sha256);
            destFuzzy.add(meta.subject, meta.receivedAt, mime.length);
            done++; records.push({ folder: destFolderRow, itemId: it.id, fileId }); syncProg();
          } catch (e) { noteErr(e); }
        }
      } catch (e) { noteErr(e); }
    }
    store.recomputeMailboxBytes(dstUpn);
  }
  log('info', direction === 'toLive' ? dstUpn : srcUpn,
    `compare folder copy ${direction}: ${done} done, ${skipped} skipped, ${failed} failed across ${folders} folder(s) (${srcUpn} → ${dstUpn})`);
  let undo = null;
  if (done > 0 || foldersCreated.length) {
    const dstName = typeof req.body.dstName === 'string' && req.body.dstName ? req.body.dstName
      : (direction === 'toLive' ? (dstFolderId || 'mailbox root') : (dstFolder && dstFolder.path ? dstFolder.path : 'mailbox root'));
    const label = `folder copy "${srcFolder.name}" → ${direction === 'toLive' ? 'live' : 'local'} "${dstName}" (${done} emails, ${foldersCreated.length} folders)`;
    compareUndo = { label, at: new Date().toISOString(), direction, mode: 'copy', srcUpn, dstUpn, dstScope, records, foldersCreated };
    undo = { label };
  }
  logCompare({
    kind: 'folder', direction, mode: 'copy', srcUpn, dstUpn, dstScope,
    srcName: srcFolder.name, dstName: typeof req.body.dstName === 'string' ? req.body.dstName : '',
    itemsTotal: compareProg ? compareProg.itemsTotal : 0, done, skipped, failed, folders, stopped: compareStop,
    detail: errors.slice(0, 5).join(' · ') || null
  });
  return { done, skipped, failed, folders, errors, undo, stopped: compareStop };
}));

// ---------- Compare undo ----------
// One-slot undo for the last compare transfer (single-item or folder). In-memory
// only — the slot is lost on restart. Best-effort reversal; never aborts on one
// failure.
app.get('/api/compare/undo', wrap(async req => {
  return compareUndo
    ? { available: true, label: compareUndo.label, at: compareUndo.at }
    : { available: false };
}));
app.post('/api/compare/undo', compareGuard(async req => {
  if (!compareUndo) { const e = new Error('nothing to undo'); e.status = 409; throw e; }
  const u = compareUndo;
  compareUndo = null;
  const errors = [];
  let undone = 0, failed = 0;
  compareProg = {
    running: true, kind: 'undo', label: `Undo: ${u.label}`,
    src: u.srcUpn, dst: u.dstUpn,
    startedAt: new Date().toISOString(), foldersDone: 0, foldersTotal: u.foldersCreated.length,
    itemsDone: 0, itemsTotal: u.records.length + u.foldersCreated.length,
    done: 0, skipped: 0, failed: 0, currentFolder: '', stopped: false
  };
  const noteErr = e => {
    failed++; if (errors.length < 10) errors.push(String(e.message || e).slice(0, 300));
    Object.assign(compareProg, { done: undone, failed, itemsDone: undone + failed + compareProg.foldersDone });
  };
  let restoredLocal = false;
  for (const rec of u.records) {
    if (compareStop) break;
    try {
      if (u.direction === 'toLive') {
        // Reverse the upload: the created live copy goes to Deleted Items.
        await graph.moveMessage(u.dstUpn, rec.createdId, 'deleteditems');
        if (rec.graveyardPath) {
          // Reverse a move: bring the local file + row back.
          const folderRow = store.getFolder(u.srcUpn, rec.scope, rec.folderId);
          if (folderRow) {
            const dir = engine.folderDir(u.srcUpn, rec.scope, folderRow.path);
            await fsp.mkdir(dir, { recursive: true });
            await fsp.rename(rec.graveyardPath, path.join(dir, rec.fileId + '.eml.gz')).catch(() => { });
          }
          if (rec.itemRow) store.upsertItem(rec.itemRow);
          restoredLocal = true;
        }
      } else {
        // Reverse the download: retire the local file to the graveyard + drop the row.
        const fp = itemFile(engine.storeRoot, u.dstUpn, u.dstScope, rec.folder, rec.fileId, null);
        if (fp) {
          const gdir = path.join(engine.storeRoot, '_graveyard', safeName(u.dstUpn));
          await fsp.mkdir(gdir, { recursive: true });
          await fsp.rename(fp, path.join(gdir, rec.fileId + '.eml.gz')).catch(() => { });
        }
        store.deleteItem(u.dstUpn, u.dstScope, rec.folder.folderId, rec.itemId);
        // Reverse a move: bring the live message back from Deleted Items.
        if (rec.movedLiveId && rec.srcLiveFolderId) await graph.moveMessage(u.srcUpn, rec.movedLiveId, rec.srcLiveFolderId);
      }
      undone++;
      Object.assign(compareProg, { done: undone, itemsDone: undone + failed + compareProg.foldersDone });
    } catch (e) { noteErr(e); }
  }
  // Remove folders that the transfer created (deepest first, only when empty).
  for (const fc of u.foldersCreated) {
    if (compareStop) break;
    try {
      compareProg.currentFolder = fc.path || '';
      if (u.direction === 'toLive') {
        await graph.deleteFolder(u.dstUpn, fc);
      } else {
        if (store.countItems(u.dstUpn, fc.scope, fc.folderId) === 0) {
          store.db.prepare('DELETE FROM folders WHERE upn=? AND scope=? AND folderId=?').run(u.dstUpn, fc.scope, fc.folderId);
          await fsp.rmdir(engine.folderDir(u.dstUpn, fc.scope, fc.path)).catch(() => { });
        }
      }
      compareProg.foldersDone++;
      compareProg.itemsDone = undone + failed + compareProg.foldersDone;
    } catch (e) { noteErr(e); }
  }
  if (u.direction === 'toLive') { if (restoredLocal) store.recomputeMailboxBytes(u.srcUpn); }
  else store.recomputeMailboxBytes(u.dstUpn);
  log('info', u.direction === 'toLive' ? u.dstUpn : u.srcUpn,
    `compare undo "${u.label}": ${undone} undone, ${failed} failed`);
  logCompare({
    kind: 'undo', direction: u.direction, mode: u.mode, srcUpn: u.srcUpn, dstUpn: u.dstUpn, dstScope: u.dstScope,
    done: undone, failed, stopped: compareStop,
    detail: u.label + (errors.length ? ' — ' + errors.slice(0, 3).join(' · ') : '')
  });
  return { undone, failed, errors, stopped: compareStop };
}));

// ---------- Dedupe ----------
app.post('/api/dedupe/check', wrap(async req => {
  const { upn, target } = req.body || {};
  if (!isValidUpn(upn)) { const e = new Error('invalid mailbox id'); e.status = 400; throw e; }
  if (!store.getMailbox(upn)) { const e = new Error('Mailbox not found'); e.status = 404; throw e; }
  if (target === 'live') return dedupeEngine.checkLive(upn);
  return dedupeEngine.checkLocal(upn);
}));
app.post('/api/dedupe/apply', wrap(req => {
  if (pst.running || copyEngine.running) { const e = new Error('another job is running — stop it first'); e.status = 409; throw e; }
  const { upn, target } = req.body || {};
  if (!isValidUpn(upn)) { const e = new Error('invalid mailbox id'); e.status = 400; throw e; }
  if (!store.getMailbox(upn)) { const e = new Error('Mailbox not found'); e.status = 404; throw e; }
  if (dedupeEngine.isRunning(upn)) { const e = new Error('this mailbox already has a dedupe job running'); e.status = 409; throw e; }
  // Local dedupe moves this mailbox's files aside — refuse only while that very
  // mailbox is mid-sync; live dedupe talks to the server and can run alongside.
  if (target !== 'live' && engine.running && engine.jobUpns.includes(upn)) {
    const e = new Error('this mailbox is syncing right now — dedupe it after the backup finishes or stop the backup first'); e.status = 409; throw e;
  }
  return target === 'live' ? dedupeEngine.applyLive(upn) : dedupeEngine.applyLocal(upn);
}));
app.post('/api/dedupe/restore', wrap(async req => {
  const { upn } = req.body || {};
  if (!isValidUpn(upn)) { const e = new Error('invalid mailbox id'); e.status = 400; throw e; }
  if (dedupeEngine.isRunning(upn)) { const e = new Error('this mailbox has a dedupe job running'); e.status = 409; throw e; }
  return dedupeEngine.restoreLocal(upn);
}));

let autoResumeSuppressed = false; // full manual stop: sweep stays off until the user starts a backup again
app.post('/api/stop', wrap(req => {
  const scope = req.body && req.body.scope;
  if (scope === 'primary' || scope === 'archive') {
    // Scoped stop: halt only that scope of the running backup (graceful — the
    // current folder batch finishes). With {upn} only that mailbox's scope is
    // skipped. Does not suppress auto-resume: the rest of the run continues.
    const upn = req.body && req.body.upn;
    if (upn && !isValidUpn(upn)) { const e = new Error('invalid mailbox id'); e.status = 400; throw e; }
    if (!engine.stopScope(scope, upn || undefined)) { const e = new Error('no backup is running'); e.status = 409; throw e; }
    return { ok: true, scope, upn: upn || null };
  }
  engine.stop();
  pst.stop();
  pstPending = null;
  copyEngine.stop();
  dedupeEngine.stop();
  exoExport.stop();
  compareStop = true;
  sizesStop = true;
  if (sizesAborter) sizesAborter.abort();
  scanStop = true;
  if (scanAborter) scanAborter.abort();
  exo.kill();  autoResumeSuppressed = true;
  log('info', '', 'stopped by user — auto-resume is off until you start a backup manually');
  return { ok: true };
}));
// Per-task stop endpoints — stop exactly one running job without touching others.
app.post('/api/stop/compare', wrap(() => {
  if (!compareRunning) return { ok: true, alreadyStopped: true };
  compareStop = true;
  log('info', '', 'compare transfer stop requested — finishing the current item');
  return { ok: true };
}));
app.post('/api/stop/backup', wrap(() => {
  if (!engine.running) return { ok: true, alreadyStopped: true };
  engine.stop();
  autoResumeSuppressed = true; // don't let the sweep restart a job the user halted
  log('info', '', 'backup/verify stopped by user');
  return { ok: true };
}));
app.post('/api/stop/pst', wrap(() => {
  // Idempotent: the export may have just ended (or was stopped by the global
  // Stop) between the UI poll and the click — a 409 there is noise, not an error.
  const cancelledPending = !!pstPending;
  pstPending = null;
  if (!pst.running) return { ok: true, alreadyStopped: true, cancelledPending };
  pst.stop();
  log('info', '', 'PST export stopped by user');
  return { ok: true, cancelledPending };
}));
app.post('/api/stop/sizes', wrap(() => {
  if (!sizesRunning) return { ok: true, alreadyStopped: true };
  sizesStop = true;
  if (sizesAborter) sizesAborter.abort();
  log('info', '', 'sizes scan stopped by user');
  return { ok: true };
}));
app.post('/api/stop/scan', wrap(() => {
  if (!scanRunning) return { ok: true, alreadyStopped: true };
  scanStop = true;
  if (scanAborter) scanAborter.abort();
  log('info', '', 'count scan stopped by user');
  return { ok: true };
}));
app.post('/api/stop/copy', wrap(() => {
  if (!copyEngine.running) { const e = new Error('no copy job is running'); e.status = 409; throw e; }
  copyEngine.stop();
  return { ok: true };
}));
app.post('/api/stop/dedupe', wrap(req => {
  const upn = req.body && req.body.upn;
  if (upn) {
    if (!dedupeEngine.stop(upn)) { const e = new Error('no dedupe job is running for this mailbox'); e.status = 409; throw e; }
    return { ok: true };
  }
  if (!dedupeEngine.running) { const e = new Error('no dedupe job is running'); e.status = 409; throw e; }
  dedupeEngine.stop();
  return { ok: true };
}));
app.post('/api/stop/exo-export', wrap(() => {
  if (!exoExport.running) return { ok: true, alreadyStopped: true };
  exoExport.stop();
  log('info', '', 'EXO export stopped by user');
  return { ok: true };
}));
app.post('/api/setup/login', wrap(() => setup.startDeviceLogin()));
app.get('/api/setup/status', wrap(() => setup.status()));
app.post('/api/setup/archive', wrap(() => setup.grantArchive()));
app.post('/api/setup/disconnect', wrap(() => setup.disconnect()));
app.get('/api/logs', wrap(req => store.logTail(parseInt(req.query.n || '200', 10))));
app.delete('/api/logs', wrap(() => {
  const removed = store.clearAllEvents();
  return { ok: true, removed };
}));

// Server-Sent Events for live log + progress
app.get('/api/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  const onEvent = e => res.write(`event: log\ndata: ${JSON.stringify(e)}\n\n`);
  const onProgress = e => res.write(`event: progress\ndata: ${JSON.stringify(e)}\n\n`);
  bus.on('event', onEvent);
  bus.on('progress', onProgress);
  const hb = setInterval(() => res.write(': hb\n\n'), 15000);
  req.on('close', () => { bus.off('event', onEvent); bus.off('progress', onProgress); clearInterval(hb); });
});

// Dashboard: serve the built React app when present, else the bundled static UI
const reactDist = path.join(__dirname, 'web-react', 'dist');
const staticRoot = fs.existsSync(reactDist) ? reactDist : path.join(__dirname, 'web');
const indexHtml = path.join(staticRoot, 'index.html');
app.use(express.static(staticRoot));
app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api')) {
    if (fs.existsSync(indexHtml)) return res.sendFile(indexHtml);
    return res.status(503).send('Dashboard UI not built yet — run: npm run build:web');
  }
  next();
});

const port = cfg.port || 8080;
const host = cfg.host || '127.0.0.1'; // localhost only: this app handles a full copy of your tenant's mail
if (!['127.0.0.1', 'localhost', '::1'].includes(host) && cfg.allowRemote !== true) {
  console.error(`Refusing to bind to non-loopback host "${host}" — set "allowRemote": true in config.json to override (NOT recommended: the dashboard exposes mailbox content).`);
  process.exit(1);
}

// Auto-resume: on startup only mailboxes left 'syncing' (process died mid-run) are
// re-queued. The periodic sweep also picks up 'partial' (incomplete folders/pending
// items) and 'error' mailboxes, with per-mailbox exponential backoff (15/30/60/120 min),
// and is skipped entirely while a PST export runs or after a full manual stop — Stop
// means stop: the sweep stays off until the user starts a backup manually again.
const retryState = new Map(); // upn -> { fails, nextAt }
const BACKOFF_MAX_MIN = 120;
const SWEEP_MAX_FAILS = 5;
function incompleteMailboxes(startupOnly) {
  const partialClause = `(m.status = 'partial' AND (
         EXISTS(SELECT 1 FROM items i WHERE i.upn = m.upn AND i.status NOT IN ('done','deleted'))
         OR EXISTS(SELECT 1 FROM folders f WHERE f.upn = m.upn AND f.itemCount >
           (SELECT COUNT(*) FROM items i2 WHERE i2.upn = f.upn AND i2.scope = f.scope AND i2.folderId = f.folderId AND i2.status = 'done'))
       ))`;
  const where = startupOnly
    ? `m.status = 'syncing'`
    : `m.status IN ('syncing', 'error') OR ${partialClause}`;
  return store.db.prepare(`SELECT m.upn FROM mailboxes m WHERE ${where}`).all().map(r => r.upn);
}
function bumpRetry(upns) {
  for (const u of upns) {
    const st = retryState.get(u) || { fails: 0 };
    st.fails++;
    const delayMin = Math.min(15 * Math.pow(2, st.fails - 1), BACKOFF_MAX_MIN);
    retryState.set(u, { fails: st.fails, nextAt: Date.now() + delayMin * 60 * 1000 });
  }
}
function resumeIncomplete(reason, startupOnly) {
  // EXO export resume: independent of the backup engine — if chunks are left
  // over (server restart mid-export) and no export is running, continue.
  // Loop-free: runExport flips live.running synchronously, so later sweeps see
  // it running and skip; done chunks are filtered inside the orchestrator.
  // cfg.exoExportEnabled === false parks the automated API export (the API path
  // bills on standard-license tenants) — manual PST imports stay available.
  if (cfg.exoExportEnabled !== false && !autoResumeSuppressed && !exoExport.running && store.exoOpenChunks().length) {
    log('info', '', `auto-resume (${reason}): continuing EXO export (${store.exoOpenChunks().length} chunk(s) pending)`);
    exoExport.runExport({}).catch(e => log('error', '', 'auto-resume EXO export failed: ' + String(e.message || e)));
  }
  if (engine.running || pst.running || sizesRunning || scanRunning) return;
  if (autoResumeSuppressed) return; // manual stop: sweep stays off until a manual backup start
  let upns = incompleteMailboxes(!!startupOnly);
  if (!startupOnly) {
    const now = Date.now();
    upns = upns.filter(u => {
      const st = retryState.get(u);
      // Cap sweep attempts: after 5 failed resumes the mailbox needs manual attention.
      if (st && st.fails >= SWEEP_MAX_FAILS) {
        retryState.delete(u);
        store.patchMailboxFields(u, { status: 'failed-final', lastError: `auto-resume gave up after ${SWEEP_MAX_FAILS} attempts — run Backup manually` });
        log('error', u, `auto-resume gave up after ${SWEEP_MAX_FAILS} failed attempts — marked 'failed-final'`);
        return false;
      }
      return !st || st.nextAt <= now;
    });
  }
  if (!upns.length) return;
  // Replay each mailbox's last requested scope: an archive-only run resumes as
  // archive-only instead of silently widening into a full primary+archive backup.
  const archiveOnly = [], full = [];
  for (const u of upns) {
    (store.getMailbox(u)?.backupScope === 'archive' ? archiveOnly : full).push(u);
  }
  log('info', '', `auto-resume (${reason}): continuing backup for ${upns.length} incomplete mailbox(es): ${upns.slice(0, 5).join(', ')}${upns.length > 5 ? ' …' : ''}`);
  const onFail = group => e => { bumpRetry(group); log('error', '', 'auto-resume backup failed: ' + e.message); };
  const runFull = () => full.length
    ? engine.runBackup(null, full).then(() => { for (const u of full) retryState.delete(u); }).catch(onFail(full))
    : Promise.resolve();
  const p = archiveOnly.length
    ? engine.runBackup(null, archiveOnly, { scope: 'archive' }).then(() => { for (const u of archiveOnly) retryState.delete(u); }).catch(onFail(archiveOnly))
    : Promise.resolve();
  p.then(runFull);
}
if (cfg.autoResume !== false) {
  setTimeout(() => resumeIncomplete('startup', true), 5000);
  const sweepMin = cfg.autoResumeMinutes || 15;
  setInterval(() => resumeIncomplete('retry sweep', false), sweepMin * 60 * 1000).unref();
}

// New-mail check for completed mailboxes: a 'done' mailbox never auto-restarts
// blindly. On a slower interval we re-enumerate its folders and only launch an
// incremental backup when folder ids/counts changed; otherwise it stays 'done'.
async function newMailSweep() {
  if (engine.running || pst.running || sizesRunning || scanRunning) return;
  const doneUpns = store.db.prepare(`SELECT upn FROM mailboxes WHERE status='done'`).all().map(r => r.upn);
  for (const u of doneUpns) {
    try {
      if (await engine.hasNewItems(u)) {
        log('info', u, 'new or changed items detected — starting incremental backup');
        const scope = store.getMailbox(u)?.backupScope === 'archive' ? 'archive' : undefined;
        engine.runBackup(null, [u], scope ? { scope } : {})
          .catch(e => {
            // A manual/auto backup started between the check and this launch — not an error.
            if (/already running/i.test(e.message)) log('info', u, 'incremental backup skipped: another backup is running');
            else log('error', u, 'incremental backup failed: ' + e.message);
          });
        return; // one run at a time; remaining mailboxes are checked next sweep
      }
      log('info', u, 'new-mail check: no changes — stays done');
    } catch (e) {
      log('warn', u, 'new-mail check failed: ' + String(e.message || e).slice(0, 200));
    }
  }
}
if (cfg.newMailCheck !== false) {
  const checkMin = cfg.newMailCheckMinutes || 60;
  setInterval(newMailSweep, checkMin * 60 * 1000).unref();
}

const srv = app.listen(port, host, () => {
  try {
    fs.writeFileSync(path.join(cfg.dataDir, 'session-token'), sessionToken, { mode: 0o600 });
    console.log('Session token written to data/session-token (the dashboard fetches it via /session-token.js)');
  } catch (e) { console.error('could not write data/session-token:', e.message); }
  console.log(`M365-Sphere`);
  console.log(`Dashboard -> http://${host}:${port}`);
  console.log(`Data dir  -> ${cfg.dataDir}`);
  console.log(`PST output-> ${cfg.pstDir}`);
});
srv.on('error', e => {
  if (e.code === 'EADDRINUSE') {
    console.error(`Port ${port} is already in use.`);
    console.error(`If the Windows service is running, stop it first — console mode is required for PST export (Outlook COM cannot run from a service).`);
  } else {
    console.error(e);
  }
  process.exit(1);
});
