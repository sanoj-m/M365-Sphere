# One-time grants for the Graph eDiscovery export (replaces the retired
# New-ComplianceSearchAction -Export). Single admin sign-in does both:
#  1. Application permission eDiscovery.ReadWrite.All on Microsoft Graph for
#     the "M365 PST Backup" app (app-only case/search/export operations).
#  2. Delegated scope eDiscovery.Download.Read on the MicrosoftPurviewEDiscovery
#     resource (b26e684c-...) with tenant-wide consent, so a delegated token
#     can download export files without the interactive sign-in page.
$ErrorActionPreference = 'Stop'
$log = Join-Path $PSScriptRoot 'grant-ediscovery-graph.log'
"=== $(Get-Date -Format o) start ===" | Out-File $log
try {
  foreach ($modName in 'Microsoft.Graph.Applications', 'Microsoft.Graph.Identity.SignIns') {
    if (-not (Get-Module -ListAvailable $modName)) {
      "Installing $modName ..." | Out-File $log -Append
      Install-Module $modName -Scope CurrentUser -Force -AllowClobber
    }
    Import-Module $modName
  }
  "Opening sign-in window - please authenticate as a Global/Cloud admin..." | Out-File $log -Append
  Connect-MgGraph -Scopes 'Application.Read.All', 'AppRoleAssignment.ReadWrite.All', 'DelegatedPermissionGrant.ReadWrite.All' -NoWelcome

  $appId = 'YOUR-APP-CLIENT-ID'
  $sp = Get-MgServicePrincipal -Filter "appId eq '$appId'"
  "Service principal: $($sp.DisplayName)" | Out-File $log -Append

  # 1) eDiscovery.ReadWrite.All (application) on Microsoft Graph
  $graph = Get-MgServicePrincipal -Filter "appId eq '00000003-0000-0000-c000-000000000000'"
  $role = $graph.AppRoles | Where-Object { $_.Value -eq 'eDiscovery.ReadWrite.All' }
  $existing = Get-MgServicePrincipalAppRoleAssignment -ServicePrincipalId $sp.Id -All
  if ($existing | Where-Object { $_.AppRoleId -eq $role.Id }) {
    "eDiscovery.ReadWrite.All already granted." | Out-File $log -Append
  } else {
    New-MgServicePrincipalAppRoleAssignment -ServicePrincipalId $sp.Id -ResourceId $graph.Id -AppRoleId $role.Id -PrincipalId $sp.Id
    "Granted eDiscovery.ReadWrite.All (application) with admin consent." | Out-File $log -Append
  }

  # 2) eDiscovery.Download.Read (delegated) on MicrosoftPurviewEDiscovery
  $dlAppId = 'b26e684c-5068-4120-a679-64a5d2c909d9'
  $dlRes = Get-MgServicePrincipal -Filter "appId eq '$dlAppId'" -ErrorAction SilentlyContinue
  if (-not $dlRes) {
    $dlRes = New-MgServicePrincipal -AppId $dlAppId -DisplayName 'Microsoft Purview eDiscovery'
    "Provisioned MicrosoftPurviewEDiscovery service principal." | Out-File $log -Append
  }
  $grants = Get-MgOauth2PermissionGrant -All | Where-Object { $_.ClientId -eq $sp.Id -and $_.ResourceId -eq $dlRes.Id }
  if ($grants) {
    "eDiscovery.Download.Read consent already present." | Out-File $log -Append
  } else {
    New-MgOauth2PermissionGrant -ClientId $sp.Id -ResourceId $dlRes.Id -ConsentType 'AllPrincipals' -Scope 'eDiscovery.Download.Read'
    "Granted eDiscovery.Download.Read (delegated) with tenant-wide consent." | Out-File $log -Append
  }
  Disconnect-MgGraph | Out-Null
  "=== SUCCESS ===" | Out-File $log -Append
} catch {
  "=== FAILED: $($_.Exception.Message) ===" | Out-File $log -Append
  throw
}
