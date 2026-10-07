# Visible helper: runs the device-code flow and keeps the window open so the
# code is visible immediately. Sign in at https://login.microsoft.com/device
# within 15 minutes of this window appearing.
$env:Path = "C:\Program Files\nodejs;$env:Path"
Set-Location 'C:\Users\sanoj\Documents\m365-pst-backup'
node scripts\exo-delegate-token.js
Write-Host ''
Write-Host '----------------------------------------'
if ($LASTEXITCODE -eq 0) { Write-Host 'TOKEN SAVED - you can close this window.' -ForegroundColor Green }
else { Write-Host 'NOT completed (expired or declined). Close and re-run scripts\exo-delegate-token.ps1 for a new code.' -ForegroundColor Yellow }
Write-Host '----------------------------------------'
