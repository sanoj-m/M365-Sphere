# One-time: grant tenant-wide admin consent for the Exchange.ManageAsApp
# application permission on the "M365 PST Backup" app (via Microsoft Graph).
# Requires a Global/Cloud admin sign-in (interactive consent prompt).
$ErrorActionPreference = 'Stop'
$log = Join-Path $PSScriptRoot 'grant-appperm.log'
"=== $(Get-Date -Format o) start ===" | Out-File $log
try {
  if (-not (Get-Module -ListAvailable Microsoft.Graph.Applications)) {
    "Installing Microsoft Graph PowerShell modules (current user)..." | Out-File $log -Append
    Install-Module Microsoft.Graph.Applications -Scope CurrentUser -Force -AllowClobber
  }
  Import-Module Microsoft.Graph.Applications
  "Opening sign-in window - please authenticate as a Global/Cloud admin and accept the Graph permission prompt..." | Out-File $log -Append
  Connect-MgGraph -Scopes 'Application.Read.All', 'AppRoleAssignment.ReadWrite.All' -NoWelcome

  $appId = 'YOUR-APP-CLIENT-ID'
  $sp = Get-MgServicePrincipal -Filter "appId eq '$appId'"
  "Service principal: $($sp.DisplayName) ($($sp.Id))" | Out-File $log -Append

  $exo = Get-MgServicePrincipal -Filter "appId eq '00000002-0000-0ff1-ce00-000000000000'" # Office 365 Exchange Online
  $role = $exo.AppRoles | Where-Object { $_.Value -eq 'Exchange.ManageAsApp' }
  "Exchange.ManageAsApp role id: $($role.Id)" | Out-File $log -Append

  $assignments = Get-MgServicePrincipalAppRoleAssignment -ServicePrincipalId $sp.Id -All
  if ($assignments | Where-Object { $_.AppRoleId -eq $role.Id }) {
    "Exchange.ManageAsApp already granted and consented - nothing to do." | Out-File $log -Append
  } else {
    New-MgServicePrincipalAppRoleAssignment -ServicePrincipalId $sp.Id -ResourceId $exo.Id -AppRoleId $role.Id -PrincipalId $sp.Id
    "Granted Exchange.ManageAsApp with tenant-wide admin consent." | Out-File $log -Append
  }
  Disconnect-MgGraph | Out-Null
  "=== SUCCESS ===" | Out-File $log -Append
} catch {
  "=== FAILED: $($_.Exception.Message) ===" | Out-File $log -Append
  throw
}
