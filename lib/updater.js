// Self-updater: checks a public GitHub repo's latest Release, downloads the
// update package (a zip of the staged app tree built by build-installer.ps1),
// then hands off to scripts/update-apply.bat to swap files and relaunch.
// User data is never touched: the swap excludes data/, node_modules/,
// pst-export/, pst-import/ and config.json.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const EXIT_UPDATE = 42; // launcher batch loops exit on this code; the updater relaunches

// Release signing public key (ed25519, SPKI DER, base64url single line).
// The matching private key lives in installer/release-key.pem on the build
// machine (never committed — see scripts/sign-release.js).
// While this is 'REPLACE_ME', signature verification is SKIPPED (sha256
// sidecar is still enforced) so self-hosters keep working. Once a real key
// is pasted here, a missing or invalid <zip>.sig release asset FAILS the
// update — the sha256 sidecar alone is no longer trusted, since it ships
// from the same release as the zip.
const UPDATE_PUBKEY = 'MCowBQYDK2VwAyEAAFHp5ckKE-stS98it5xbn7iN4ZlwuBOHvVqaq3H_ZZg';

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
      const sigAsset = (j.assets || []).find(a => a.name === `${asset.name}.sig`);
      if (UPDATE_PUBKEY !== 'REPLACE_ME' && !sigAsset) throw new Error(`latest release is missing the signature ${asset.name}.sig — refusing to update without it`);
      const latest = { version, url: asset.browser_download_url, sha256Url: shaAsset.browser_download_url, sigUrl: sigAsset ? sigAsset.browser_download_url : null, notes: String(j.body || '').slice(0, 2000), publishedAt: j.published_at };
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
      if (!r.ok || !r.body) throw new Error(`download failed (HTTP ${r.status})`);
      await pipeline(Readable.fromWeb(r.body), fs.createWriteStream(zip));
      // Verify the zip against the release's sha256 sidecar (standard sha256sum
      // format: "<hex>  <filename>"). A mismatch or unreadable sidecar aborts.
      if (!latest.sha256Url) throw new Error('update has no integrity sidecar — re-run the update check');
      const sr = await fetch(latest.sha256Url, { headers: { 'User-Agent': 'M365-Sphere-Updater' }, redirect: 'follow', signal: AbortSignal.timeout(60000) });
      if (!sr.ok) throw new Error(`sha256 sidecar download failed (HTTP ${sr.status})`);
      const expected = (String(await sr.text()).trim().split(/\s+/)[0] || '').toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(expected)) throw new Error('sha256 sidecar is malformed');
      const hash = crypto.createHash('sha256');
      await pipeline(fs.createReadStream(zip), hash);
      const actual = hash.digest('hex');
      if (actual !== expected) throw new Error(`zip integrity check FAILED (expected ${expected.slice(0, 12)}…, got ${actual.slice(0, 12)}…) — refusing to apply`);
      // Signature check (ed25519): the .sig release asset is verified against
      // the embedded UPDATE_PUBKEY. Only the holder of the private key can
      // produce a valid release, so a compromised repo/token alone is not
      // enough to push a malicious zip. Skipped (with a warning) while the
      // placeholder key is in place.
      if (UPDATE_PUBKEY === 'REPLACE_ME') {
        this.log('warn', '', '[update] no UPDATE_PUBKEY embedded — signature verification SKIPPED (sha256 sidecar only)');
      } else {
        if (!latest.sigUrl) throw new Error('update has no signature — re-run the update check');
        const gr = await fetch(latest.sigUrl, { headers: { 'User-Agent': 'M365-Sphere-Updater' }, redirect: 'follow', signal: AbortSignal.timeout(60000) });
        if (!gr.ok) throw new Error(`signature download failed (HTTP ${gr.status})`);
        const sig = String(await gr.text()).trim();
        if (!/^[A-Za-z0-9_-]+$/.test(sig)) throw new Error('signature asset is malformed');
        const pub = crypto.createPublicKey({ key: Buffer.from(UPDATE_PUBKEY, 'base64url'), format: 'der', type: 'spki' });
        const ok = crypto.verify(null, fs.readFileSync(zip), pub, Buffer.from(sig, 'base64url'));
        if (!ok) throw new Error('zip signature check FAILED — refusing to apply');
      }
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
    // Spawn the bat directly (no `start`): `start "<title>" /min` tokenization
    // silently dropped the script on some systems. Detached + hidden is enough.
    const child = spawn('cmd.exe', ['/c', `"${bat}" "${path.join(this.workDir, 'stage')}" "${this.appRoot}"`], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    setTimeout(() => process.exit(EXIT_UPDATE), 800).unref();
  }
}

module.exports = { Updater };
