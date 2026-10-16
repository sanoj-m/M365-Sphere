# M365-Sphere watchdog: keeps `node server.js` alive.
# Checks every 30 s; if no node process with server.js in its command line
# exists, starts a fresh detached one (stdout/stderr -> data\server-out.log /
# server-err.log so fatal V8 errors (OOM etc.) leave evidence). Also watches
# API health: a process that is alive but not answering /api/status with the
# current session token for 3 consecutive checks is killed and restarted.
# Runs in the interactive user session (a Scheduled Task at logon) so Outlook
# COM / PST export keeps working — a real Windows service (Session 0) would
# break PST export.
#
# Deliberate stop: create an empty file data\watchdog.pause — the watchdog
# then leaves the server down. Delete the file to re-arm. To remove the
# watchdog entirely: Unregister-ScheduledTask -TaskName 'M365Sphere-Watchdog'.
# The task MUST be registered with -ExecutionTimeLimit 0 (the 72 h default
# silently kills this script) and battery flags disabled.

$dir = 'C:\Users\sanoj\Documents\m365-pst-backup'
$log = Join-Path $dir 'data\watchdog.log'
$pause = Join-Path $dir 'data\watchdog.pause'
$node = 'C:\Program Files\nodejs\node.exe'
$apiDown = 0

while ($true) {
  try {
    if (Test-Path $pause) { Start-Sleep -Seconds 30; continue }
    $running = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -like '*server.js*' }
    if (-not $running) {
      Add-Content $log "$(Get-Date -Format o) server.js not running — starting"
      Start-Process -FilePath $node -ArgumentList 'server.js' -WorkingDirectory $dir -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $dir 'data\server-out.log') -RedirectStandardError (Join-Path $dir 'data\server-err.log')
      $apiDown = 0
      continue
    }
    # Process alive — check the API answers with the current token.
    $ok = $false
    try {
      $token = (Get-Content (Join-Path $dir 'data\session-token') -Raw).Trim()
      $null = Invoke-RestMethod -Uri 'http://127.0.0.1:8080/api/status' -Headers @{ 'x-session-token' = $token } -TimeoutSec 15
      $ok = $true
    } catch { }
    if ($ok) { $apiDown = 0 }
    else {
      $apiDown++
      Add-Content $log "$(Get-Date -Format o) server.js alive but API not answering (strike $apiDown)"
      if ($apiDown -ge 3) {
        Add-Content $log "$(Get-Date -Format o) API wedged — restarting server.js"
        $running | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
        $apiDown = 0
      }
    }
  } catch {
    Add-Content $log "$(Get-Date -Format o) watchdog error: $($_.Exception.Message)"
  }
  Start-Sleep -Seconds 30
}
