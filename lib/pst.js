// PST export orchestrator: runs ps/Export-MailboxToPst.ps1 per mailbox in the
// interactive session (Outlook COM does not work from a Windows service / Session 0).
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { safeName } = require('./util');

class PstExporter {
  constructor({ cfg, store, log, bus }) {
    this.cfg = cfg; this.store = store; this.log = log; this.bus = bus;
    this.running = false;
    this._stop = false;
    this._child = null;
    this.current = null; // { upn, startedAt } while a mailbox is exporting
    this._out = ''; // tail of the current PowerShell child's output
  }

  detail() { return { running: this.running, current: this.current, jobId: this._jobId || null, out: this._out }; }

  stop() {
    if (!this.running) return;
    this._stop = true;
    if (this._child) { try { this._child.kill(); } catch { } }
    // Kill the whole tree: the PowerShell child plus the Outlook instance the
    // script spawned (recorded in owner.pid) — otherwise the orphaned Outlook
    // keeps running the export in the background with the PST files locked.
    try {
      const pidFile = this._jobDir && path.join(this._jobDir, 'owner.pid');
      if (pidFile && fs.existsSync(pidFile)) {
        const [psPid, olPid] = fs.readFileSync(pidFile, 'utf8').trim().split(/\s+/).filter(Boolean);
        const { execFile } = require('child_process');
        if (psPid) execFile('taskkill', ['/T', '/F', '/PID', psPid], () => { });
        if (olPid) execFile('taskkill', ['/F', '/PID', olPid], () => { });
      }
    } catch { }
    this.log('info', '', 'PST export stop requested');
  }

  validatePlan(upn, plan) {
    if (!Array.isArray(plan) || !plan.length) throw new Error('Invalid PST plan: plan must be a non-empty array of parts');
    const known = new Set(this.store.folderStats(upn).map(f => `${f.scope}/${f.path}`));
    const norm = plan.map((p, i) => ({
      name: (String((p && p.name) || '').trim()) || `part${i + 1}`,
      folders: (Array.isArray(p && p.folders) ? p.folders : []).map(f => String(f).replace(/\\/g, '/').replace(/\/+$/, ''))
    }));
    const errors = [];
    for (const p of norm)
      for (const f of p.folders)
        if (!known.has(f)) errors.push(`unknown folder "${f}" in part "${p.name}"`);
    // plan.json must carry on-disk paths: the store sanitizes each segment with
    // safeName() (forbidden chars → '_', 80-char cap), so a raw folder path would
    // miss its directory for names containing <>:"|?* etc.
    for (const p of norm) p.folders = p.folders.map(f => f.split('/').map(safeName).join('/'));
    for (let i = 0; i < norm.length; i++)
      for (const f of norm[i].folders)
        for (let j = 0; j < norm.length; j++) {
          if (i === j) continue;
          for (const g of norm[j].folders) {
            if (f === g) errors.push(`folder "${f}" assigned to both "${norm[i].name}" and "${norm[j].name}"`);
            else if (f.startsWith(g + '/')) errors.push(`folder "${f}" (part "${norm[i].name}") is inside "${g}" (part "${norm[j].name}")`);
            else if (g.startsWith(f + '/')) errors.push(`folder "${g}" (part "${norm[j].name}") is inside "${f}" (part "${norm[i].name}")`);
          }
        }
    if (errors.length) throw new Error('Invalid PST plan: ' + [...new Set(errors)].join('; '));
    return norm;
  }

  async runExport(upn, plan) {
    if (this.running) throw new Error('already running');
    if (plan && !upn) throw new Error('Invalid PST plan: a plan can only be used with a single mailbox');
    // All preflight happens BEFORE running=true so a validation/disk failure
    // can never leave the exporter stuck in the running state.
    const planData = plan ? this.validatePlan(upn, plan) : null;
    const list = upn
      ? [this.store.getMailbox(upn)].filter(Boolean)
      : this.store.listMailboxes().filter(m => m.primaryBytes > 0 || m.archiveBytes > 0);
    this.sweepTempFiles();
    this.preflightDiskSpace(list);
    this.running = true; this._stop = false;
    const job = this.store.createJob('pst', list.length);
    this._jobId = job.id;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const ps1 = path.join(__dirname, '..', 'ps', 'Export-MailboxToPst.ps1');
    // Run detached: the export can take hours — the API returns the job id at
    // once and the UI tracks progress via pstStatus/jobs instead of a hung POST.
    (async () => {
      try {
        let done = 0;
        for (const m of list) {
          if (this._stop) break;
          this.store.patchMailboxFields(m.upn, { pstStatus: 'running' });
          this.log('info', m.upn, 'PST export started — Outlook runs hidden in the background (no window opens); watch Running tasks for progress');
          this.current = { upn: m.upn, startedAt: new Date().toISOString() };
          // Retry transient Outlook/hang failures per mailbox before giving up.
          const tries = Math.max(1, parseInt(this.cfg.pstRetryCount || '1', 10) || 1);
          let result = null;
          for (let attempt = 1; ; attempt++) {
            result = await this.exportOne(m.upn, ps1, stamp, planData);
            const failed = (result.failed || []).length;
            if (!failed || attempt >= tries || this._stop) break;
            this.log('warn', m.upn, `PST export attempt ${attempt}/${tries} had ${failed} failure(s) — retrying in 30s`);
            await new Promise(r => setTimeout(r, 30000));
            if (this._stop) break;
          }
          const failed = (result.failed || []).length;
          if (this._stop || (!result.moved && failed)) {
            // Stopped or nothing made it in — the PST is empty/partial garbage.
            for (const p of (result.psts || [])) { try { fs.rmSync(p, { force: true }); } catch { } }
          }
          const partCount = (result.parts || []).length;
          let status;
          if (this._stop) status = 'stopped';
          else if (failed) status = `failed: ${failed} item(s)`;
          else if (partCount) status = `done: ${(result.psts || []).length} PST file(s) in ${partCount} part(s)`;
          else status = `done: ${(result.psts || []).length} PST file(s)`;
          this.store.patchMailboxFields(m.upn, { pstStatus: status });
          this.log(failed ? 'warn' : 'info', m.upn, `PST export ${status}`);
          done++;
          this.store.updateJob(job.id, { done, detail: m.upn });
          this.bus.emit('progress', { done });
        }
        this.store.updateJob(job.id, { status: this._stop ? 'stopped' : 'done', finishedAt: new Date().toISOString() });
      } finally {
        this.running = false;
        this._child = null;
        this.current = null;
        this._jobId = null;
        this._jobDir = null;
      }
    })();
    return { jobId: job.id, total: list.length };
  }

  sweepTempFiles() {
    try {
      const tmp = process.env.TEMP || process.env.TMP;
      if (!tmp) return;
      let removed = 0;
      for (const e of fs.readdirSync(tmp)) {
        if (e.startsWith('m365pst-')) {
          try { fs.rmSync(path.join(tmp, e), { recursive: true, force: true }); removed++; } catch { }
        }
      }
      if (removed) this.log('info', '', `cleaned up ${removed} stale temp file(s) from %TEMP%`);
    } catch (e) {
      this.log('warn', '', 'temp sweep failed: ' + String(e.message || e));
    }
  }

  preflightDiskSpace(list) {
    if (typeof fs.statfsSync !== 'function') return;
    let free;
    try { free = fs.statfsSync(this.cfg.pstDir).bavail * fs.statfsSync(this.cfg.pstDir).bsize; }
    catch (e) { this.log('warn', '', 'could not check free disk space: ' + String(e.message || e)); return; }
    // rough estimate: compressed store bytes expand to PST; assume ~1.2x plus 1 GB headroom
    const estimate = list.reduce((n, m) => n + (m.primaryBytes || 0) + (m.archiveBytes || 0), 0) * 1.2 + 1024 * 1024 * 1024;
    if (free < estimate) {
      const gb = b => (b / (1024 * 1024 * 1024)).toFixed(1);
      throw new Error(`insufficient disk space on ${this.cfg.pstDir}: ~${gb(estimate)} GB needed for this export, only ${gb(free)} GB free`);
    }
  }

  exportOne(upn, ps1, stamp, plan) {
    return new Promise(resolve => {
      const safe = safeName(upn);
      const jobsDir = path.join(this.cfg.dataDir, 'pstjobs', `${safe}_${stamp}`);
      this._jobDir = jobsDir;
      fs.mkdirSync(jobsDir, { recursive: true });
      const resultPath = path.join(jobsDir, 'result.json');
      // Legacy base64url filenames exceed MAX_PATH (>260 chars) — PowerShell
      // 5.1 cannot open or even enumerate them. subst the store to a drive
      // letter for the export duration so the script sees short paths.
      const storeRoot = path.join(this.cfg.dataDir, 'store');
      let storeDrive = null;
      for (const d of ['M', 'X', 'Y', 'Z', 'P']) {
        try { require('child_process').execFileSync('subst', [`${d}:`, storeRoot]); storeDrive = d; break; } catch { }
      }
      const effectiveStore = storeDrive ? `${storeDrive}:\\` : storeRoot;
      if (!storeDrive) this.log('warn', upn, 'could not subst store to a drive letter — files with paths >260 chars will fail');
      const unsubst = () => { if (storeDrive) { try { require('child_process').execFileSync('subst', [`${storeDrive}:`, '/D']); } catch { } storeDrive = null; } };
      const args = [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps1,
        '-Mailbox', safe,
        '-StoreRoot', effectiveStore,
        '-DataDir', this.cfg.dataDir,
        '-OutRoot', this.cfg.pstDir,
        '-MaxSizeGB', String(this.cfg.maxPstSizeGB || 49),
        '-Stamp', stamp,
        '-ResultPath', resultPath,
        '-ManifestPath', path.join(this.cfg.pstDir, safe, '.export-manifest.json')
      ];
      if (plan) {
        const planPath = path.join(jobsDir, 'plan.json');
        fs.writeFileSync(planPath, JSON.stringify(plan, null, 2));
        args.push('-PlanPath', planPath);
      }
      // cfg.pstVisible: show the PowerShell window (and any Outlook prompts)
      // for debugging profile/security-prompt hangs.
      this._child = spawn('powershell.exe', args, { windowsHide: !this.cfg.pstVisible });
      // Inactivity watchdog: a hung Outlook COM call produces no output — kill
      // the child after cfg.pstTimeoutMs (default 10 min) of silence.
      const idleMs = this.cfg.pstTimeoutMs || 10 * 60 * 1000;
      let idle = null;
      const bumpIdle = () => {
        if (idle) clearTimeout(idle);
        idle = setTimeout(() => {
          out += `\n[killed: no output for ${Math.round(idleMs / 60000)} min — possible Outlook hang]\n`;
          try { if (this._child) this._child.kill(); } catch { }
        }, idleMs);
        if (idle.unref) idle.unref();
      };
      let out = '';
      bumpIdle();
      const onData = d => { out += d; this._out = out.slice(-2000); bumpIdle(); };
      this._child.stdout.on('data', onData);
      this._child.stderr.on('data', onData);
      this._child.on('close', code => {
        if (idle) clearTimeout(idle);
        this._child = null;
        unsubst();
        try { fs.rmSync(path.join(jobsDir, 'owner.pid'), { force: true }); } catch { }
        let result = null;
        try { result = JSON.parse(fs.readFileSync(resultPath, 'utf8')); } catch { }
        if (!result) {
          result = { mailbox: upn, moved: 0, failed: [{ file: '(export)', error: `PowerShell exited with code ${code}: ${out.slice(-800)}` }], psts: [] };
        }
        this._out = out.slice(-2000);
        resolve(result);
      });
      this._child.on('error', e => {
        if (idle) clearTimeout(idle);
        this._child = null;
        unsubst();
        this._out = out.slice(-2000);
        resolve({ mailbox: upn, moved: 0, failed: [{ file: '(export)', error: String(e.message) }], psts: [] });
      });
    });
  }
}

module.exports = { PstExporter };
