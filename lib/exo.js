// Exchange Online PowerShell helper: authoritative mailbox sizes via
// Get-EXOMailboxStatistics (-Archive) + Get-Mailbox (AutoExpandingArchiveEnabled).
// This is the ONLY source that sees auto-expanding archive auxiliary storage —
// EWS/Graph only report the main archive partition.
// Auth: app-only access token (client credentials, same token as EWS) passed to
// Connect-ExchangeOnline -AccessToken — no interactive sign-in. Requires the app
// registration to have the Office 365 Exchange Online "Exchange.ManageAsApp"
// application permission (plus an admin role such as Exchange Administrator).
const { execFile, spawn } = require('child_process');

// TotalItemSize renders as "459.66 GB (493,632,879,001 bytes)" — or arrives as a
// plain number when the PowerShell side already called .Value.ToBytes().
function toBytes(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v;
  const s = String(v);
  const paren = s.match(/\(([\d,]+)\s*bytes?\)/i);
  if (paren) return parseInt(paren[1].replace(/,/g, ''), 10);
  const m = s.match(/^([\d.]+)\s*(KB|MB|GB|TB|B)?/i);
  if (!m) return null;
  const mult = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 }[(m[2] || 'B').toUpperCase()];
  return Math.round(parseFloat(m[1]) * mult);
}

const psq = s => `'${String(s).replace(/'/g, "''")}'`; // single-quote escape for PowerShell

function buildScript(upns, token, org) {
  const list = upns.map(psq).join(', ');
  return [
    `$ErrorActionPreference='Continue'`,
    // App-only only: module 3.10.x removed -Device, so there is no interactive
    // fallback. Fails with UnAuthorized until the app registration is granted
    // Exchange.ManageAsApp + an Exchange admin role on the service principal.
    `try { Connect-ExchangeOnline -AccessToken ${psq(token)} -Organization ${psq(org)} -ShowBanner:$false -ErrorAction Stop } catch { Write-Output ('FATAL: ' + $_.Exception.Message); exit 1 }`,
    `foreach ($u in @(${list})) {`,
    `  try {`,
    `    $mbx = Get-Mailbox -Identity $u -ErrorAction Stop`,
    `    $stat = Get-EXOMailboxStatistics -Identity $u -ErrorAction Stop`,
    `    $pb = [string]$stat.TotalItemSize`,
    `    $ab = $null; $ai = 0`,
    `    if ([string]$mbx.ArchiveStatus -eq 'Active') {`,
    `      $astat = Get-EXOMailboxStatistics -Identity $u -Archive -ErrorAction Stop`,
    `      $ab = [string]$astat.TotalItemSize`,
    `      $ai = $astat.ItemCount`,
    `    }`,
    `    $o = [ordered]@{ upn=$u; primaryBytes=$pb; primaryItems=$stat.ItemCount; archiveBytes=$ab; archiveItems=$ai; archiveStatus=[string]$mbx.ArchiveStatus; autoExpanding=[bool]$mbx.AutoExpandingArchiveEnabled }`,
    `    Write-Output ('STAT:' + (ConvertTo-Json $o -Compress))`,
    `  } catch { Write-Output ('STATERR:' + (ConvertTo-Json @{ upn=$u; error=$_.Exception.Message } -Compress)) }`,
    `}`,
    `Disconnect-ExchangeOnline -Confirm:$false -ErrorAction SilentlyContinue`
  ].join('; ');
}

class Exo {
  constructor({ cfg, log, bus, auth }) {
    this.cfg = cfg; this.log = log; this.bus = bus; this.auth = auth;
    this._child = null;
  }

  // Kill the running PowerShell child (Stop button).
  kill() {
    if (this._child) { try { this._child.kill(); } catch { } }
  }

  async _ensureModule() {
    const hasModule = await new Promise(res => execFile('powershell.exe', ['-NoProfile', '-Command',
      'if (Get-Module -ListAvailable ExchangeOnlineManagement) { "YES" } else { "NO" }'], { timeout: 60000 },
      (e, out) => res((out || '').trim() === 'YES')));
    if (hasModule) return;
    this.log('info', '', '[exo] installing ExchangeOnlineManagement module (current user)…');
    const installed = await new Promise(res => execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
      `try { [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; Install-PackageProvider -Name NuGet -MinimumVersion 2.8.5.201 -Force -Scope CurrentUser -ErrorAction Stop | Out-Null; Install-Module ExchangeOnlineManagement -Scope CurrentUser -Force -AllowClobber -ErrorAction Stop; "YES" } catch { "NO: " + $_.Exception.Message }`],
      { timeout: 300000 }, (e, out) => res((out || '').trim())));
    if (!installed.startsWith('YES')) throw new Error('ExchangeOnlineManagement install failed: ' + installed.replace(/^NO:\s*/, ''));
  }

  // Fetch mailbox stats for all upns in ONE PowerShell process.
  // onSignIn is legacy (kept for API compatibility): app-only auth never prompts.
  // Resolves { stats: {upn: {...}}, errors: {upn: msg} }.
  async mailboxStats(upns, onSignIn) {
    await this._ensureModule();
    // App-only token for outlook.office365.com — same credential the EWS client
    // uses; Connect-ExchangeOnline -AccessToken turns it into an EXO session.
    const token = await this.auth.ewsToken();
    const org = this.cfg.tenantName || this.cfg.tenantId;
    const timeoutMs = this.cfg.exoTimeoutMs || 600000;
    return new Promise((resolve, reject) => {
      const child = spawn('powershell.exe', ['-NoProfile', '-Command', buildScript(upns, token, org)], { stdio: ['ignore', 'pipe', 'pipe'] });
      this._child = child;
      const stats = {}, errors = {};
      let settled = false;
      const finish = (fn, val) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this._child = null;
        if (onSignIn) onSignIn(null);
        fn(val);
      };
      const timer = setTimeout(() => {
        try { child.kill(); } catch { }
        finish(reject, new Error(`EXO stats timed out after ${Math.round(timeoutMs / 60000)} min (cfg.exoTimeoutMs)`));
      }, timeoutMs);
      let buf = '';
      const onData = d => {
        buf += d.toString();
        // Device sign-in code: "enter the code ABCD12345 to authenticate"
        const m = buf.match(/enter the code\s+([A-Z0-9]+)\s+to authenticate/i) || buf.match(/code[:\s]+([A-Z0-9]{9})\b/i);
        if (m && onSignIn) onSignIn({ code: m[1], url: 'https://microsoft.com/devicelogin' });
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (line.startsWith('STAT:')) {
            try {
              const j = JSON.parse(line.slice(5));
              stats[j.upn] = {
                primaryBytes: toBytes(j.primaryBytes),
                primaryItems: j.primaryItems || 0,
                archiveBytes: toBytes(j.archiveBytes),
                archiveItems: j.archiveItems || 0,
                archiveStatus: j.archiveStatus || '',
                autoExpanding: !!j.autoExpanding
              };
            } catch { /* malformed line — skip */ }
          } else if (line.startsWith('STATERR:')) {
            try { const j = JSON.parse(line.slice(8)); errors[j.upn] = String(j.error || 'unknown').replace(/\0/g, '').trim().slice(0, 400); } catch { }
          } else if (line.startsWith('FATAL:')) {
            let msg = line.slice(6).trim();
            if (/unauthor/i.test(msg)) {
              msg += ' — the app registration needs the Office 365 Exchange Online application permission "Exchange.ManageAsApp" (admin-consented) and an Exchange admin role (e.g. Exchange Administrator) on the service principal for unattended EXO access';
            }
            finish(reject, new Error(msg));
            return;
          }
        }
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.on('close', () => {
        // Sign-in completed (or failed) — clear the sign-in prompt either way.
        if (onSignIn) onSignIn(null);
        const missing = upns.filter(u => !stats[u] && !errors[u]);
        for (const u of missing) errors[u] = 'no result returned by Exchange Online PowerShell';
        finish(resolve, { stats, errors });
      });
      child.on('error', e => finish(reject, e));
    });
  }
}

module.exports = { Exo, toBytes };
