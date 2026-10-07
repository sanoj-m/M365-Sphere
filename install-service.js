// Registers the app as a Windows service (auto-start with the PC).
// NOTE: Outlook COM automation (PST export) does not work from Session 0.
// Use the service for API/backup/verify; run PST export in console mode (npm start).
//
// Service account: by default the service runs as LocalSystem. To use a dedicated
// service account instead, set "svcUser" (DOMAIN\\user or user@domain) and
// "svcPassword" in config.json — or the M365_SVC_USER / M365_SVC_PASSWORD env vars.
// The account needs: log-on-as-service right, read/write on the install folder and
// dataDir/pstDir, and (for PST export in console mode) is irrelevant there anyway.
const path = require('path');
const fs = require('fs');
const Service = require('node-windows').Service;

let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')); } catch { }
const svcUser = process.env.M365_SVC_USER || cfg.svcUser;
const svcPassword = process.env.M365_SVC_PASSWORD || cfg.svcPassword;

const opts = {
  name: 'M365 PST Backup',
  description: 'Microsoft 365 mailbox backup service with web dashboard (localhost:8080)',
  script: path.join(__dirname, 'server.js'),
  workingDirectory: __dirname,
  env: [{ name: 'NODE_ENV', value: 'production' }],
  wait: 2,
  grow: 0.5
};
if (svcUser && svcPassword) {
  opts.logOnAs = { account: svcUser, password: svcPassword };
  console.log(`Service will run as "${svcUser}".`);
} else {
  console.warn('WARNING: no svcUser/svcPassword configured — the service will run as LocalSystem.');
  console.warn('  LocalSystem can read every file on this machine. Set "svcUser"/"svcPassword" in');
  console.warn('  config.json (or M365_SVC_USER / M365_SVC_PASSWORD env vars) to use a dedicated account.');
}
const svc = new Service(opts);
svc.on('install', () => { svc.start(); console.log('Service installed and started.'); });
svc.on('alreadyinstalled', () => console.log('Service already installed.'));
svc.on('error', e => console.error(e));
svc.install();
