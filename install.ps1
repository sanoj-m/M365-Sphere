# M365-Sphere — one-click install (run as Administrator; install.bat self-elevates).
# Restores a checkpoint -> ensures Node.js -> installs deps -> builds the dashboard
# -> writes config.json -> registers the Windows service.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

function Info($m) { Write-Host "[install] $m" -ForegroundColor Cyan }

# --- admin check ---
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { Write-Host 'Please run install.bat (it elevates automatically) or run this script as Administrator.' -ForegroundColor Red; exit 1 }

# --- restore point (best effort) ---
Info 'creating system restore point (best effort)…'
try { Checkpoint-Computer -Description 'M365-Sphere install' -RestorePointType APPLICATION_INSTALL -ErrorAction Stop }
catch { Write-Host "[install] restore point skipped: $($_.Exception.Message)" -ForegroundColor DarkYellow }

# --- Node.js ---
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Info 'Node.js not found — installing via winget…'
  winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}
Info ("node " + (node -v))

# --- dependencies + frontend build ---
Info 'installing backend dependencies…'
npm install --no-audit --no-fund
Info 'building React dashboard…'
npm run build:web

# --- config.json ---
if (-not (Test-Path config.json)) {
  Info 'config.json not found — please enter your Entra app registration values.'
  $tenantId = Read-Host 'Tenant ID (GUID)'
  $clientId = Read-Host 'Application (client) ID (GUID)'
  $clientSecret = Read-Host 'Client secret value'
  $cfg = Get-Content config.example.json -Raw | ConvertFrom-Json
  $cfg.tenantId = $tenantId
  $cfg.clientId = $clientId
  $cfg.clientSecret = $clientSecret
  $cfg | ConvertTo-Json | Out-File -Encoding utf8 config.json
  Info 'config.json written.'
} else { Info 'config.json already exists — leaving it untouched.' }

# --- Windows service ---
$installService = Read-Host 'Register and start the Windows service now? (y/N)'
if ($installService -ieq 'y') {
  npm run install-service
  Info 'service registered.'
} else {
  Info "skipped. Run it later with: npm run install-service  (or use run-console.bat for PST export)"
}

Info 'done. Dashboard: http://localhost:8080'
