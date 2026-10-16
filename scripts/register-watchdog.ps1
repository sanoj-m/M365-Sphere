# Registers the M365-Sphere watchdog as a Scheduled Task (AtLogon, interactive
# session). ExecutionTimeLimit MUST be 0 — the schtasks default of 72 h kills
# the watchdog script silently three days after logon (root cause of the
# 2026-10-12 watchdog death). Battery flags off so laptops are covered.
# Run elevated or as the user: powershell -ExecutionPolicy Bypass -File scripts\register-watchdog.ps1
$task = 'M365Sphere-Watchdog'
$ps = "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe"
$script = 'C:\Users\sanoj\Documents\m365-pst-backup\scripts\watchdog.ps1'

$action = New-ScheduledTaskAction -Execute $ps -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -MultipleInstances IgnoreNew -StartWhenAvailable
Register-ScheduledTask -TaskName $task -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Write-Output "Registered $task (unlimited runtime, battery-proof). Starting it now…"
Start-ScheduledTask -TaskName $task
