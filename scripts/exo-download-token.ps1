# Visible helper: device-code flow for the eDiscovery DOWNLOAD token.
# Sign in at https://login.microsoft.com/device within 15 minutes of the code appearing.
$env:Path = "C:\Program Files\nodejs;$env:Path"
Set-Location 'C:\Users\sanoj\Documents\m365-sphere'
node scripts\exo-delegate-token.js "b26e684c-5068-4120-a679-64a5d2c909d9/.default offline_access" "data\exo-download-refresh-token.json"
Write-Host ''
Write-Host '----------------------------------------'
if ($LASTEXITCODE -eq 0) { Write-Host 'TOKEN SAVED - you can close this window.' -ForegroundColor Green }
else { Write-Host 'NOT completed (expired or declined). Close and re-run scripts\exo-download-token.ps1 for a new code.' -ForegroundColor Yellow }
Write-Host '----------------------------------------'
