// One-off: per-project sizes (FolderAndSubfolderSize) under "13 Projects - closed"
// for a mailbox, via EXO Get-MailboxFolderStatistics. Prints STAT:<json> lines.
// Usage: node scripts/exo-folder-sizes.js <upn> [pathPrefix]
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { Auth } = require('../lib/auth');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
const upn = process.argv[2];
const prefix = process.argv[3] || '13 Projects - closed';
if (!upn) { console.error('usage: node scripts/exo-folder-sizes.js <upn> [pathPrefix]'); process.exit(1); }

const psq = s => `'${String(s).replace(/'/g, "''")}'`;

(async () => {
  const auth = new Auth(cfg);
  const token = await auth.ewsToken();
  const org = cfg.tenantName || cfg.tenantId;
  const script = [
    `try { Connect-ExchangeOnline -AccessToken ${psq(token)} -Organization ${psq(org)} -ShowBanner:$false -ErrorAction Stop } catch { Write-Output ('FATAL: ' + $_.Exception.Message); exit 1 }`,
    `$f = Get-MailboxFolderStatistics -Identity ${psq(upn)} -ErrorAction Stop | Where-Object { $_.FolderPath -like '/${prefix}/*' }`,
    `foreach ($x in $f) { Write-Output ('STAT:' + (ConvertTo-Json @{ path=$x.FolderPath; size=[string]$x.FolderAndSubfolderSize; items=$x.ItemsInFolderAndSubfolders } -Compress)) }`,
    `Disconnect-ExchangeOnline -Confirm:$false -ErrorAction SilentlyContinue`
  ].join('; ');
  const child = spawn('powershell.exe', ['-NoProfile', '-Command', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', d => process.stdout.write(d));
  child.stderr.on('data', d => process.stderr.write(d));
  child.on('close', c => process.exit(c));
})().catch(e => { console.error(e); process.exit(1); });
