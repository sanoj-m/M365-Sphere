# M365-Sphere watchdog: keeps `node server.js` alive.
# Checks every 30 s; if no node process with server.js in its command line
# exists, starts a fresh detached one. Runs in the interactive user session
# (a Scheduled Task at logon) so Outlook COM / PST export keeps working —
# a real Windows service (Session 0) would break PST export.
#
# Deliberate stop: create an empty file data\watchdog.pause — the watchdog
# then leaves the server down. Delete the file to re-arm. To remove the
# watchdog entirely: Unregister-ScheduledTask -TaskName 'M365Sphere-Watchdog'.

$dir = 'C:\Users\sanoj\Documents\m365-pst-backup'
$log = Join-Path $dir 'data\watchdog.log'
$pause = Join-Path $dir 'data\watchdog.pause'
$node = 'C:\Program Files\nodejs\node.exe'

while ($true) {
  try {
    if (Test-Path $pause) { Start-Sleep -Seconds 30; continue }
    $running = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -like '*server.js*' }
    if (-not $running) {
      Add-Content $log "$(Get-Date -Format o) server.js not running — starting"
      Start-Process -FilePath $node -ArgumentList 'server.js' -WorkingDirectory $dir -WindowStyle Hidden
    }
  } catch {
    Add-Content $log "$(Get-Date -Format o) watchdog error: $($_.Exception.Message)"
  }
  Start-Sleep -Seconds 30
}
