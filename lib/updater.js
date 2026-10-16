// Self-updater: checks a public GitHub repo's latest Release, downloads the
// update package (a zip of the staged app tree built by build-installer.ps1),
// then hands off to scripts/update-apply.bat to swap files and relaunch.
// User data is never touched: the swap excludes data/, node_modules/,
// pst-export/, pst-import/ and config.json.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');

const EXIT_UPDATE = 42; // launcher batch loops exit on this code; the updater relaunches

function parseVer(v) { return String(v || '').trim().replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0); }
function newerThan(a, b) {
  const x = parseVer(a), y = parseVer(b);
  for (let i = 0; i < 3; i++) { if (x[i] !== y[i]) return x[i] > y[i]; }
  return false;
}

class Updater {
  constructor({ cfg, log, appRoot }) {
    this.cfg = cfg;
    this.log = log;
    this.appRoot = appRoot;
    try { this.current = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8')).version || '0.0.0'; }
    catch { this.current = '0.0.0'; }
    this.workDir = path.join(cfg.dataDir, 'update');
    this.state = {
      enabled: !!cfg.updateRepo,
      repo: cfg.updateRepo || null,
      current: this.current,
      status: 'idle', // idle | checking | available | downloading | ready | applying | error | uptodate
      lastCheck: null, latest: null, error: null
    };
  }

  _set(patch, logLine) {
    Object.assign(this.state, patch);
    if (logLine) this.log(this.state.status === 'error' ? 'error' : 'info', '', `[update] ${logLine}`);
  }

  async check() {
    if (!this.state.enabled) return this.state;
    this._set({ status: 'checking', error: null });
    try {
      const r = await fetch(`https://api.github.com/repos/${this.cfg.updateRepo}/releases/latest`, {
        headers: { 'User-Agent': 'M365-Sphere-Updater', Accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(30000)
      });
      if (r.status === 404) { this._set({ status: 'idle', lastCheck: Date.now(), latest: null }); return this.state; } // no releases yet
      const j = await r.json();
      if (!r.ok) throw new Error(`GitHub API HTTP ${r.status}: ${j.message || 'unknown'}`);
      const version = String(j.tag_name || '').replace(/^v/i, '');
      const asset = (j.assets || []).find(a => /update.*\.zip$/i.test(a.name)) || (j.assets || []).find(a => /\.zip$/i.test(a.name));
      if (!version || !asset) throw new Error('latest release has no version tag or zip asset');
      // Integrity: the release MUST carry a sha256 sidecar for the zip.
      const shaAsset = (j.assets || []).find(a => a.name === `${asset.name}.sha256`);
      if (!shaAsset) throw new Error(`latest release is missing the integrity sidecar ${asset.name}.sha256 — refusing to update without it`);
      const latest = { version, url: asset.browser_download_url, sha256Url: shaAsset.browser_download_url, notes: String(j.body || '').slice(0, 2000), publishedAt: j.published_at };
      if (newerThan(version, this.current)) {
        this._set({ status: 'available', lastCheck: Date.now(), latest }, `update available: v${version} (current v${this.current})`);
      } else {
        this._set({ status: 'uptodate', lastCheck: Date.now(), latest: null });
      }
    } catch (e) {
      this._set({ status: 'error', lastCheck: Date.now(), error: String(e.message || e).slice(0, 300) }, `update check failed: ${e.message || e}`);
    }
    return this.state;
  }

  async download() {
    const { latest } = this.state;
    if (!latest) throw new Error('no update available — run a check first');
    this._set({ status: 'downloading' }, `downloading v${latest.version}…`);
    try {
      fs.rmSync(this.workDir, { recursive: true, force: true });
      fs.mkdirSync(this.workDir, { recursive: true });
      const zip = path.join(this.workDir, 'update.zip');
      const r = await fetch(latest.url, { headers: { 'User-Agent': 'M365-Sphere-Updater' }, redirect: 'follow', signal: AbortSignal.timeout(10 * 60 * 1000) });
      if (!r.ok) throw new Error(`download failed (HTTP ${r.status})`);
      fs.writeFileSync(zip, Buffer.from(await r.arrayBuffer()));
      // Verify the zip against the release's sha256 sidecar (standard sha256sum
      // format: "<hex>  <filename>"). A mismatch or unreadable sidecar aborts.
      if (!latest.sha256Url) throw new Error('update has no integrity sidecar — re-run the update check');
      const sr = await fetch(latest.sha256Url, { headers: { 'User-Agent': 'M365-Sphere-Updater' }, redirect: 'follow', signal: AbortSignal.timeout(60000) });
      if (!sr.ok) throw new Error(`sha256 sidecar download failed (HTTP ${sr.status})`);
      const expected = (String(await sr.text()).trim().split(/\s+/)[0] || '').toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(expected)) throw new Error('sha256 sidecar is malformed');
      const actual = crypto.createHash('sha256').update(fs.readFileSync(zip)).digest('hex');
      if (actual !== expected) throw new Error(`zip integrity check FAILED (expected ${expected.slice(0, 12)}…, got ${actual.slice(0, 12)}…) — refusing to apply`);
      const stage = path.join(this.workDir, 'stage');
      await new Promise((res, rej) => execFile('powershell.exe', ['-NoProfile', '-Command',
        `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${stage}' -Force`], { timeout: 120000 },
        e => e ? rej(e) : res()));
      // A zip built from installer\stage contains the app tree at its root.
      for (const req of ['server.js', 'package.json', 'lib']) {
        if (!fs.existsSync(path.join(stage, req))) throw new Error(`update package is invalid (missing ${req})`);
      }
      this._set({ status: 'ready' }, `v${latest.version} downloaded and verified — ready to apply`);
    } catch (e) {
      this._set({ status: 'error', error: String(e.message || e).slice(0, 300) }, `update download failed: ${e.message || e}`);
      throw e;
    }
    return this.state;
  }

  // Spawns the detached swap script and exits the process shortly after. The
  // caller must have already sent the HTTP response.
  apply() {
    if (this.state.status !== 'ready') throw new Error('update not downloaded yet');
    const bat = path.join(this.appRoot, 'scripts', 'update-apply.bat');
    if (!fs.existsSync(bat)) throw new Error('scripts/update-apply.bat is missing');
    this._set({ status: 'applying' }, `applying v${this.state.latest.version} — restarting…`);
    const child = spawn('cmd.exe', ['/c', 'start', '"M365-Sphere update" /min', bat, path.join(this.workDir, 'stage'), this.appRoot], { detached: true, stdio: 'ignore' });
    child.unref();
    setTimeout(() => process.exit(EXIT_UPDATE), 800).unref();
  }
}

module.exports = { Updater };
