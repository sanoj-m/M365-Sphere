# Watchdog: keeps M365-Sphere (server.js) running. Checks the API every 60s;
# if unreachable, restarts the server. Logs to data/watchdog.log.
# Started detached by the agent; survives until machine reboot or manual kill
# (Stop-Process on the powershell running watchdog.ps1).
$ErrorActionPreference = 'Continue'
$work = 'C:\Users\sanoj\Documents\m365-sphere'
$log = Join-Path $work 'data\watchdog.log'
function Log($msg) { "$(Get-Date -Format o) $msg" | Out-File $log -Append }

while ($true) {
  try {
    $tok = Get-Content (Join-Path $work 'data\session-token') -Raw -ErrorAction Stop
    $r = Invoke-WebRequest -Uri 'http://127.0.0.1:8080/api/status' -Headers @{ 'x-session-token' = $tok.Trim() } -TimeoutSec 10 -UseBasicParsing
    if ($r.StatusCode -ne 200) { throw "HTTP $($r.StatusCode)" }
  } catch {
    $running = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
      Where-Object { $_.CommandLine -like '*server.js*' -and $_.CommandLine -like '*m365-sphere*' -or $_.CommandLine -like '*server.js*' }
    if (-not $running) {
      Log "server.js not running (check failed: $($_.Exception.Message)) - starting"
      # Redirect via cmd append (>>) - Start-Process -RedirectStandardOutput fails
      # when the log file is already open by another process.
      Start-Process -FilePath 'cmd.exe' -ArgumentList '/c node server.js >> data\server-console.log 2>> data\server-error.log' `
        -WorkingDirectory $work -WindowStyle Hidden
    } else {
      Log "server process alive but API unreachable ($($_.Exception.Message)) - not touching it"
    }
  }
  Start-Sleep -Seconds 60
}
