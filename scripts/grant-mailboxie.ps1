# One-time grants for the Graph Mailbox Import/Export APIs (archive backup path).
# Read/export ONLY - least privilege for backup; no import/write permission is
# granted here (restore would need MailboxItem.ImportExport.All, deliberately
# not requested). Grants three APPLICATION roles on Microsoft Graph for the
# "M365-Sphere" app:
#   MailboxFolder.Read.All  - archive folder enumeration + delta
#   MailboxItem.Read.All    - archive item enumeration + delta
#   MailboxItem.Export.All  - read-only full-fidelity export (exportItems)
$ErrorActionPreference = 'Stop'
$log = Join-Path $PSScriptRoot 'grant-mailboxie.log'
"=== $(Get-Date -Format o) start ===" | Out-File $log
try {
  foreach ($modName in 'Microsoft.Graph.Applications') {
    if (-not (Get-Module -ListAvailable $modName)) {
      "Installing $modName ..." | Out-File $log -Append
      Install-Module $modName -Scope CurrentUser -Force -AllowClobber
    }
    Import-Module $modName
  }
  "Opening sign-in window - please authenticate as a Global/Cloud admin..." | Out-File $log -Append
  Connect-MgGraph -Scopes 'Application.Read.All', 'AppRoleAssignment.ReadWrite.All' -NoWelcome

  $appId = 'YOUR-APP-CLIENT-ID'
  $sp = Get-MgServicePrincipal -Filter "appId eq '$appId'"
  "Service principal: $($sp.DisplayName)" | Out-File $log -Append

  $graph = Get-MgServicePrincipal -Filter "appId eq '00000003-0000-0000-c000-000000000000'"
  $existing = Get-MgServicePrincipalAppRoleAssignment -ServicePrincipalId $sp.Id -All
  foreach ($roleValue in 'MailboxFolder.Read.All', 'MailboxItem.Read.All', 'MailboxItem.Export.All') {
    $role = $graph.AppRoles | Where-Object { $_.Value -eq $roleValue }
    if (-not $role) { "Role $roleValue not found on Microsoft Graph (API may have moved) - skipping." | Out-File $log -Append; continue }
    if ($existing | Where-Object { $_.AppRoleId -eq $role.Id }) {
      "$roleValue already granted." | Out-File $log -Append
    } else {
      New-MgServicePrincipalAppRoleAssignment -ServicePrincipalId $sp.Id -ResourceId $graph.Id -AppRoleId $role.Id -PrincipalId $sp.Id
      "Granted $roleValue (application) with admin consent." | Out-File $log -Append
    }
  }
  Disconnect-MgGraph | Out-Null
  "=== SUCCESS ===" | Out-File $log -Append
} catch {
  "=== FAILED: $($_.Exception.Message) ===" | Out-File $log -Append
  throw
}
