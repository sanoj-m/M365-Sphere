# One-time grant: add the "M365 PST Backup" app to an eDiscovery-capable role group.
# Requires an admin sign-in (interactive MFA). Safe to re-run.
$ErrorActionPreference = 'Stop'
$log = Join-Path $PSScriptRoot 'grant-ediscovery.log'
"=== $(Get-Date -Format o) start ===" | Out-File $log
try {
  $mod = Get-Module -ListAvailable ExchangeOnlineManagement | Sort-Object Version -Descending | Select-Object -First 1
  if (-not $mod) {
    "Installing ExchangeOnlineManagement module (current user)..." | Out-File $log -Append
    Install-Module ExchangeOnlineManagement -Scope CurrentUser -Force -AllowClobber
  } elseif ($mod.Version -lt [version]'3.2.0') {
    "Updating ExchangeOnlineManagement $($mod.Version) -> latest (needs -App support)..." | Out-File $log -Append
    Install-Module ExchangeOnlineManagement -Scope CurrentUser -Force -AllowClobber
  }
  Import-Module ExchangeOnlineManagement -Force
  "Opening sign-in window - please authenticate with an Exchange/Compliance admin account..." | Out-File $log -Append
  Connect-IPPSSession

  $all = Get-RoleGroup
  "All role groups: $(($all | ForEach-Object { $_.Name }) -join ' | ')" | Out-File $log -Append

  # Pick the best group: exact match first, then Data Investigator, then any eDiscovery group.
  $group = $all | Where-Object { $_.Name -eq 'eDiscovery Manager' }
  if (-not $group) { $group = $all | Where-Object { $_.Name -eq 'Data Investigator' } }
  if (-not $group) { $group = $all | Where-Object { $_.Name -like '*eDiscovery*' } | Select-Object -First 1 }
  if (-not $group) { throw "No eDiscovery-capable role group found in this tenant. Groups seen: $(($all.Name) -join ' | ')" }
  "Using role group: $($group.Name)" | Out-File $log -Append

  $appObjId = 'YOUR-ENTERPRISE-APP-OBJECT-ID' # enterprise application object id of 'M365 PST Backup'
  $appId = 'YOUR-APP-CLIENT-ID'     # application (client) id

  # Register the service principal in Exchange/Purview (one-time, idempotent).
  $sp = Get-ServicePrincipal -Identity $appObjId -ErrorAction SilentlyContinue
  if (-not $sp) {
    New-ServicePrincipal -AppId $appId -ObjectId $appObjId -DisplayName 'M365 PST Backup'
    "Registered service principal in Exchange/Purview." | Out-File $log -Append
  } else {
    "Service principal already registered." | Out-File $log -Append
  }

  $existing = Get-RoleGroupMember -Identity $group.Name
  if ($existing | Where-Object { $_.ObjectId -eq $appObjId }) {
    "Already a member - nothing to do." | Out-File $log -Append
  } else {
    Add-RoleGroupMember -Identity $group.Name -Member $appObjId
    "Added app to $($group.Name)." | Out-File $log -Append
  }
  $after = Get-RoleGroupMember -Identity $group.Name | ForEach-Object { "$($_.DisplayName) <$($_.ObjectId)>" }
  "Members now: $after" | Out-File $log -Append
  Disconnect-ExchangeOnline -Confirm:$false -ErrorAction SilentlyContinue
  "=== SUCCESS ===" | Out-File $log -Append
} catch {
  "=== FAILED: $($_.Exception.Message) ===" | Out-File $log -Append
  throw
}
