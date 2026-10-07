// Automated tenant setup: device-code admin sign-in, app registration, consent, secret, config.json.
const fs = require('fs');
const { execFile, spawn } = require('child_process');

// Microsoft first-party public client for Microsoft Graph PowerShell device logins;
// preauthorized for dynamic Graph scope consent (unlike the Azure PowerShell client).
const ARM_CLIENT_ID = '14d82eec-204b-4c2f-b7e8-296a70dab67e';
const SETUP_SCOPES = 'Application.ReadWrite.All AppRoleAssignment.ReadWrite.All Organization.Read.All';
const APP_NAME = 'M365-Sphere';

const GRAPH_APP_ID = '00000003-0000-0000-c000-000000000000';
const EXO_APP_ID = '00000002-0000-0ff1-ce00-000000000000';
const REQUIRED_ROLES = [
  { resourceAppId: GRAPH_APP_ID, id: 'df021288-bdef-4463-88db-98f22de89214', name: 'User.Read.All' },
  { resourceAppId: GRAPH_APP_ID, id: '810c84a8-4a9e-49e6-bf25-180f7b8c60be', name: 'Mail.Read' },
  { resourceAppId: EXO_APP_ID, id: 'dc50a0fb-09a3-484d-be87-e023b12c6440', name: 'full_access_as_app' }
];

class Setup {
  constructor({ cfg, log, configPath }) {
    this.cfg = cfg;
    this.log = log;
    this.configPath = configPath;
    this.state = 'idle'; // idle | pending | running | done | error
    this.message = '';
    this.device = null; // { userCode, verificationUri, expiresAt }
    this.archiveNote = null;
    this._poll = null;
  }

  status() {
    // After a restart (or any time setup was already completed), report the persisted
    // connection from config.json instead of asking to sign in again.
    if (this.state === 'idle' && this.cfg.clientId && !String(this.cfg.clientId).startsWith('your-')) {
      return {
        state: 'done',
        message: `Connected to tenant "${this.cfg.tenantName || this.cfg.tenantId}" (${this.cfg.clientId}).`,
        archiveNote: this.archiveNote || (this.cfg.archiveGranted
          ? { ok: true, text: 'Online archive access granted (ApplicationImpersonation assigned).' }
          : null)
      };
    }
    return {
      state: this.state, message: this.message, archiveNote: this.archiveNote,
      userCode: this.device && this.state === 'pending' ? this.device.userCode : undefined,
      verificationUri: this.device && this.state === 'pending' ? this.device.verificationUri : undefined,
      archiveSignIn: this.archiveSignIn || undefined
    };
  }

  _set(state, message) {
    this.state = state;
    this.message = message;
    if (message) this.log(state === 'error' ? 'error' : 'info', '', `[setup] ${message}`);
  }

  async startDeviceLogin() {
    if (this.state === 'pending' || this.state === 'running') throw new Error('setup already running');
    const body = new URLSearchParams({ client_id: ARM_CLIENT_ID, scope: SETUP_SCOPES });
    const r = await fetch('https://login.microsoftonline.com/organizations/oauth2/v2.0/devicecode', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
      signal: AbortSignal.timeout(this.cfg.httpTimeoutMs || 120000)
    });
    const j = await r.json();
    if (!r.ok) throw new Error(`device code request failed (HTTP ${r.status}): ${j.error_description || j.error}`);
    this.device = {
      userCode: j.user_code,
      verificationUri: j.verification_uri || 'https://microsoft.com/devicelogin',
      deviceCode: j.device_code,
      interval: (j.interval || 5) * 1000,
      expiresAt: Date.now() + (j.expires_in || 900) * 1000
    };
    this._set('pending', `Sign in at ${this.device.verificationUri} with code ${this.device.userCode}`);
    this._pollTokens();
    return this.status();
  }

  _pollTokens() {
    clearTimeout(this._poll);
    const tick = async () => {
      if (!this.device || this.state !== 'pending') return;
      if (Date.now() > this.device.expiresAt) {
        this.device = null;
        return this._set('error', 'Sign-in code expired — click Sign in again.');
      }
      const body = new URLSearchParams({
        client_id: ARM_CLIENT_ID,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: this.device.deviceCode
      });
      try {
        const r = await fetch('https://login.microsoftonline.com/organizations/oauth2/v2.0/token', {
          method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
          signal: AbortSignal.timeout(this.cfg.httpTimeoutMs || 120000)
        });
        const j = await r.json();
        if (r.ok && j.access_token) {
          const token = j.access_token;
          this.device = null;
          this.provision(token).catch(e => this._set('error', String(e.message || e)));
          return;
        }
        if (j.error === 'authorization_pending') {
          this._poll = setTimeout(tick, this.device.interval);
          return;
        }
        if (j.error === 'slow_down') {
          this.device.interval += 5000;
          this._poll = setTimeout(tick, this.device.interval);
          return;
        }
        this.device = null;
        this._set('error', `sign-in failed: ${j.error_description || j.error}`);
      } catch (e) {
        this._poll = setTimeout(tick, this.device ? this.device.interval : 5000);
      }
    };
    this._poll = setTimeout(tick, this.device.interval);
  }

  async _graph(token, method, path, body) {
    const r = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(this.cfg.httpTimeoutMs || 120000)
    });
    const text = await r.text();
    let j = null;
    try { j = text ? JSON.parse(text) : null; } catch { }
    if (!r.ok) {
      const msg = (j && j.error && (j.error.message || j.error.code)) || text.slice(0, 300);
      const err = new Error(`Graph ${method} ${path} failed (HTTP ${r.status}): ${msg}`);
      err.status = r.status;
      throw err;
    }
    return j;
  }

  async provision(token) {
    this._set('running', 'Sign-in OK — reading tenant…');
    const orgs = await this._graph(token, 'GET', '/organization?$select=id,displayName');
    const org = orgs && orgs.value && orgs.value[0];
    if (!org) throw new Error('could not read tenant (organization) info');
    this._set('running', `Tenant: ${org.displayName} (${org.id}) — resolving permissions…`);

    // Resolve role IDs by value on each resource SP (GUIDs are not identical in every cloud/tenant).
    const resolved = [];
    for (const resourceAppId of [GRAPH_APP_ID, EXO_APP_ID]) {
      const rsps = await this._graph(token, 'GET', `/servicePrincipals?$filter=appId eq '${resourceAppId}'&$select=id,appRoles`);
      const rsp = rsps.value && rsps.value[0];
      if (!rsp) throw new Error(`resource service principal for ${resourceAppId} not found in tenant`);
      for (const role of REQUIRED_ROLES.filter(r => r.resourceAppId === resourceAppId)) {
        const match = (rsp.appRoles || []).find(a => a.value === role.name && a.isEnabled !== false);
        if (!match) throw new Error(`permission "${role.name}" not found on resource ${resourceAppId} in this tenant`);
        resolved.push({ resourceSpId: rsp.id, resourceAppId, roleId: match.id, name: role.name });
      }
    }

    const requiredResourceAccess = [
      { resourceAppId: GRAPH_APP_ID, resourceAccess: resolved.filter(r => r.resourceAppId === GRAPH_APP_ID).map(r => ({ id: r.roleId, type: 'Role' })) },
      { resourceAppId: EXO_APP_ID, resourceAccess: resolved.filter(r => r.resourceAppId === EXO_APP_ID).map(r => ({ id: r.roleId, type: 'Role' })) }
    ];

    let app = null;
    const found = await this._graph(token, 'GET', `/applications?$filter=displayName eq '${APP_NAME}'&$select=id,appId,displayName`);
    if (found.value && found.value.length) {
      app = found.value[0];
      await this._graph(token, 'PATCH', `/applications/${app.id}`, { requiredResourceAccess });
      this._set('running', `Reusing existing app registration ${app.appId} — granting consent…`);
    } else {
      app = await this._graph(token, 'POST', '/applications', {
        displayName: APP_NAME, signInAudience: 'AzureADMyOrg', requiredResourceAccess
      });
      this._set('running', `Created app registration ${app.appId} — granting consent…`);
    }

    let sp;
    const sps = await this._graph(token, 'GET', `/servicePrincipals?$filter=appId eq '${app.appId}'&$select=id`);
    if (sps.value && sps.value.length) {
      sp = sps.value[0];
    } else {
      sp = await this._graph(token, 'POST', '/servicePrincipals', { appId: app.appId });
    }

    for (const role of resolved) {
      try {
        await this._graph(token, 'POST', `/servicePrincipals/${sp.id}/appRoleAssignments`, {
          principalId: sp.id, resourceId: role.resourceSpId, appRoleId: role.roleId
        });
        this.log('info', '', `[setup] consented ${role.name}`);
      } catch (e) {
        if (e.status === 409 || /already exists/i.test(e.message)) {
          this.log('info', '', `[setup] ${role.name} already consented`);
        } else throw e;
      }
    }

    this._set('running', 'Creating client secret…');
    const pw = await this._graph(token, 'POST', `/applications/${app.id}/addPassword`, { passwordCredential: { displayName: 'm365-sphere' } });
    if (!pw || !pw.secretText) throw new Error('addPassword returned no secret');

    const fileCfg = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
    fileCfg.tenantId = org.id;
    fileCfg.tenantName = org.displayName;
    fileCfg.clientId = app.appId;
    fileCfg.clientSecret = pw.secretText;
    fs.writeFileSync(this.configPath, JSON.stringify(fileCfg, null, 2) + '\n');
    this.cfg.tenantId = org.id;
    this.cfg.tenantName = org.displayName;
    this.cfg.clientId = app.appId;
    this.cfg.clientSecret = pw.secretText;
    this.log('info', '', '[setup] config.json written — connection ready');

    await this.grantArchive();

    // Persist the archive outcome so a restart still reports it correctly.
    try {
      const c = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
      c.archiveGranted = !!(this.archiveNote && this.archiveNote.ok);
      fs.writeFileSync(this.configPath, JSON.stringify(c, null, 2) + '\n');
      this.cfg.archiveGranted = c.archiveGranted;
    } catch { }

    if (this.state !== 'error') this._set('done', `Setup complete for tenant "${org.displayName}". You can now run Discover.`);
  }

  // Local disconnect: clears the stored tenant credentials from config.json and memory.
  // The app registration in Entra ID is left untouched (it is reused on the next sign-in).
  disconnect() {
    clearTimeout(this._poll);
    this.device = null;
    try {
      const c = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
      c.tenantId = '';
      c.tenantName = '';
      c.clientId = '';
      c.clientSecret = '';
      c.archiveGranted = false;
      fs.writeFileSync(this.configPath, JSON.stringify(c, null, 2) + '\n');
    } catch { }
    this.cfg.tenantId = '';
    this.cfg.tenantName = '';
    this.cfg.clientId = '';
    this.cfg.clientSecret = '';
    this.cfg.archiveGranted = false;
    this.archiveNote = null;
    this.archiveSignIn = null;
    this._set('idle', '');
    this.log('info', '', '[setup] tenant disconnected — credentials removed from config.json');
    return this.status();
  }

  _persistArchive(ok) {
    try {
      const c = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
      c.archiveGranted = ok;
      fs.writeFileSync(this.configPath, JSON.stringify(c, null, 2) + '\n');
      this.cfg.archiveGranted = ok;
    } catch { }
  }

  async grantArchive() {
    const clientId = this.cfg.clientId;
    const manual = 'Run manually in PowerShell:\nInstall-Module ExchangeOnlineManagement\nConnect-ExchangeOnline\nNew-ManagementRoleAssignment -App ' + clientId + ' -Role "ApplicationImpersonation"';
    const fail = (detail) => {
      this.archiveSignIn = null;
      this.archiveNote = { ok: false, text: 'Archive impersonation could not be granted automatically' + (detail ? ` (${detail})` : '') + '.\n\n' + manual };
      this.log('warn', '', '[setup] archive impersonation failed: ' + (detail || 'unknown'));
      this._persistArchive(false);
      return this.archiveNote;
    };
    const done = () => {
      this.archiveSignIn = null;
      this.archiveNote = { ok: true, text: 'Online archive access granted (ApplicationImpersonation assigned).' };
      this.log('info', '', '[setup] archive impersonation granted');
      this._persistArchive(true);
      return this.archiveNote;
    };
    try {
      const hasModule = await new Promise(res => execFile('powershell.exe', ['-NoProfile', '-Command',
        'if (Get-Module -ListAvailable ExchangeOnlineManagement) { "YES" } else { "NO" }'], { timeout: 60000 },
        (e, out) => res((out || '').trim() === 'YES')));

      if (!hasModule) {
        this.log('info', '', '[setup] installing ExchangeOnlineManagement module (current user)…');
        // -Force makes Install-Module accept the untrusted PSGallery for this call only —
        // the repository's InstallationPolicy is left untouched.
        const installed = await new Promise(res => execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
          `try { [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; Install-PackageProvider -Name NuGet -MinimumVersion 2.8.5.201 -Force -Scope CurrentUser -ErrorAction Stop | Out-Null; Install-Module ExchangeOnlineManagement -Scope CurrentUser -Force -AllowClobber -ErrorAction Stop; "YES" } catch { "NO: " + $_.Exception.Message }`],
          { timeout: 300000 }, (e, out) => res((out || '').trim())));
        if (!installed.startsWith('YES')) return fail('module install failed: ' + installed.replace(/^NO:\s*/, ''));
      }

      const ps = [
        `$ErrorActionPreference='Stop'`,
        `try {`,
        `  Connect-ExchangeOnline -Device -ShowBanner:$false`,
        `  try { New-ManagementRoleAssignment -App '${clientId}' -Role 'ApplicationImpersonation' -ErrorAction Stop | Out-Null; Write-Output 'GRANT_OK' }`,
        `  catch { if ($_.Exception.Message -match 'already exists|Conflict') { Write-Output 'GRANT_OK' } else { Write-Output ('GRANT_FAIL: ' + $_.Exception.Message) } }`,
        `} catch { Write-Output ('GRANT_FAIL: ' + $_.Exception.Message) }`
      ].join('; ');

      return await new Promise(resolve => {
        const child = spawn('powershell.exe', ['-NoProfile', '-Command', ps], { stdio: ['ignore', 'pipe', 'pipe'] });
        const timer = setTimeout(() => { try { child.kill(); } catch { } resolve(fail('timed out waiting for Exchange sign-in')); }, 300000);
        let buf = '';
        const onData = d => {
          buf += d.toString();
          const m = buf.match(/enter the code\s+([A-Z0-9]+)\s+to authenticate/i) || buf.match(/code[:\s]+([A-Z0-9]{9})\b/i);
          if (m && (!this.archiveSignIn || this.archiveSignIn.code !== m[1])) {
            this.archiveSignIn = { code: m[1], url: 'https://microsoft.com/devicelogin' };
            this.log('info', '', `[setup] Exchange Online sign-in requested — code ${m[1]} at microsoft.com/devicelogin`);
          }
        };
        child.stdout.on('data', onData);
        child.stderr.on('data', onData);
        child.on('close', () => {
          clearTimeout(timer);
          if (/GRANT_OK/.test(buf)) return resolve(done());
          const m = buf.match(/GRANT_FAIL:\s*(.+)/);
          resolve(fail(m ? m[1].trim().slice(0, 300) : null));
        });
        child.on('error', e => { clearTimeout(timer); resolve(fail(e.message)); });
      });
    } catch (e) {
      return fail(String(e.message || e).slice(0, 300));
    }
  }
}

module.exports = { Setup };
