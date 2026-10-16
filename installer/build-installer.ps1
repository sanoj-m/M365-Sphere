# Builds installer\M365Sphere-Setup.exe from the repo.
# Run from the repo root:  powershell -ExecutionPolicy Bypass -File installer\build-installer.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root

function Info($m) { Write-Host "[build] $m" -ForegroundColor Cyan }
function Die($m) { Write-Host "[build] ERROR: $m" -ForegroundColor Red; exit 1 }

# --- toolchain ---
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  $env:Path = "C:\Program Files\nodejs;$env:Path"
}
(Get-Command node -ErrorAction SilentlyContinue) | Out-Null
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Die 'node not found on PATH.' }
Info ("node " + (node -v))

$makensis = $null
foreach ($cand in @("$env:ProgramFiles (x86)\NSIS\makensis.exe", "${env:ProgramFiles(x86)}\NSIS\makensis.exe", "$env:ProgramFiles\NSIS\makensis.exe")) {
  if (Test-Path $cand) { $makensis = $cand; break }
}
if (-not $makensis -and (Get-Command makensis -ErrorAction SilentlyContinue)) { $makensis = 'makensis' }
if (-not $makensis) {
  Info 'makensis not found — installing NSIS via winget…'
  winget install -e --id NSIS.NSIS --accept-source-agreements --accept-package-agreements
  foreach ($cand in @("${env:ProgramFiles(x86)}\NSIS\makensis.exe", "$env:ProgramFiles\NSIS\makensis.exe")) {
    if (Test-Path $cand) { $makensis = $cand; break }
  }
}
if (-not $makensis) { Die 'makensis not found (install NSIS: winget install -e --id NSIS.NSIS).' }
Info "makensis: $makensis"

# --- 1) build the React dashboard ---
if (-not (Test-Path web-react\node_modules)) {
  Info 'installing web-react dependencies…'
  npm --prefix web-react install --no-audit --no-fund
  if ($LASTEXITCODE) { Die "npm --prefix web-react install failed ($LASTEXITCODE)." }
}
Info 'building web-react…'
npm --prefix web-react run build
if ($LASTEXITCODE) { Die "web-react build failed ($LASTEXITCODE)." }
if (-not (Test-Path web-react\dist\index.html)) { Die 'web-react\dist\index.html missing after build.' }

# --- 2) stage (clean each run) ---
$stage = Join-Path $root 'installer\stage'
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Path $stage | Out-Null

$excludeDirs = @(
  (Join-Path $root '.git'),
  (Join-Path $root '.kimi-code'),
  (Join-Path $root '.agents'),
  (Join-Path $root '.vscode'),
  (Join-Path $root 'node_modules'),
  (Join-Path $root 'data'),
  (Join-Path $root 'pst-export'),
  (Join-Path $root 'pst-import'),
  (Join-Path $root 'installer'),
  (Join-Path $root 'design-system'),
  (Join-Path $root 'docs'),
  (Join-Path $root 'web-react'),
  (Join-Path $root 'tools'),
  (Join-Path $root 'scripts')
)
$excludeFiles = @('config.json', 'backfill.err.log', 'backfill.log', '.gitignore', '*.log')

Info 'staging application files…'
& robocopy $root $stage /E /NFL /NDL /NJH /NJS /XD @excludeDirs /XF @excludeFiles | Out-Null
if ($LASTEXITCODE -gt 7) { Die "robocopy failed (exit $LASTEXITCODE)." }

# web UI: prebuilt dist only (no source, no node_modules)
& robocopy (Join-Path $root 'web-react\dist') (Join-Path $stage 'web-react\dist') /E /NFL /NDL /NJH /NJS | Out-Null
if ($LASTEXITCODE -gt 7) { Die "robocopy (web dist) failed (exit $LASTEXITCODE)." }

# runtime-relevant scripts only (excludes one-off probes/cleanups and *.log files)
$runtimeScripts = @(
  'pst-repair.js', 'pst-verify.js', 'repair-folder-ews.js', 'backfill-fts-meta.js',
  'dedupe-items.js', 'cleanup-local-dupes.js',
  'grant-mailboxie.ps1', 'grant-ediscovery-graph.ps1', 'grant-ediscovery.ps1',
  'exo-delegate-token.js', 'exo-delegate-token.ps1', 'exo-download-token.ps1',
  'watchdog.ps1', 'update-apply.bat'
)
New-Item -ItemType Directory -Path (Join-Path $stage 'scripts') -Force | Out-Null
foreach ($s in $runtimeScripts) {
  $src = Join-Path $root "scripts\$s"
  if (Test-Path $src) { Copy-Item $src (Join-Path $stage 'scripts') } else { Info "note: scripts\$s not found, skipped" }
}

# installer-provided launcher lands in the app root
Copy-Item (Join-Path $root 'installer\assets\*') $stage

# --- 3) sanity-check the stage: no secrets, no dev artifacts ---
foreach ($forbidden in @('config.json', 'data', 'node_modules', '.git', 'pst-export', 'pst-import', 'tools', 'design-system', 'docs', 'web-react\src', 'web-react\node_modules')) {
  if (Test-Path (Join-Path $stage $forbidden)) { Die "stage contains forbidden entry: $forbidden" }
}
foreach ($required in @('server.js', 'lib\engine.js', 'package.json', 'package-lock.json', 'config.example.json', 'README.md', 'web-react\dist\index.html', 'web\favicon.ico', 'Start-M365-Sphere.bat', 'scripts\pst-repair.js', 'scripts\update-apply.bat')) {
  if (-not (Test-Path (Join-Path $stage $required))) { Die "stage is missing required entry: $required" }
}
Info 'stage sanity checks passed.'

# --- 4) compile ---
$pkgVer = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
Info "compiling installer (version $pkgVer)…"
Push-Location (Join-Path $root 'installer')
try {
  & $makensis /V2 "/DAPPVER=$pkgVer" m365-sphere.nsi
  if ($LASTEXITCODE) { Die "makensis failed (exit $LASTEXITCODE)." }
} finally { Pop-Location }

$exe = Join-Path $root 'installer\M365Sphere-Setup.exe'
if (-not (Test-Path $exe)) { Die 'M365Sphere-Setup.exe was not produced.' }
$size = [math]::Round((Get-Item $exe).Length / 1MB, 2)
Info "done: installer\M365Sphere-Setup.exe ($size MB)"

# --- 5) update package: attach this zip to a public GitHub Release tagged
# v<package.json version> — running instances auto-update from it.
$zip = Join-Path $root 'installer\M365Sphere-update.zip'
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip -CompressionLevel Optimal
# sha256 sidecar (sha256sum format) — the updater refuses to apply a zip without it.
$hash = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
"$hash  M365Sphere-update.zip" | Set-Content -Path "$zip.sha256" -Encoding ascii -NoNewline
# ed25519 signature — the updater verifies it against the embedded UPDATE_PUBKEY.
if (Test-Path (Join-Path $root 'installer\release-key.pem')) {
  node (Join-Path $root 'scripts\sign-release.js') $zip
  if ($LASTEXITCODE) { Die "sign-release.js failed (exit $LASTEXITCODE)." }
  $attach = 'zip + .sha256 + .sig'
} else {
  Info 'installer\release-key.pem not found — update zip is NOT signed (run: node scripts\sign-release.js installer\M365Sphere-update.zip to generate a key and sign)'
  $attach = 'zip + .sha256'
}
$zsize = [math]::Round((Get-Item $zip).Length / 1MB, 2)
Info "done: installer\M365Sphere-update.zip ($zsize MB) - attach these to GitHub Release v$pkgVer : $attach"
