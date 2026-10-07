param([string]$Token, [string]$Org, [string]$Upn)
$ErrorActionPreference = 'Continue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$ProgressPreference = 'SilentlyContinue'
Write-Output ("ORG=" + $Org)
Write-Output ("MODULE=" + (Get-Module -ListAvailable ExchangeOnlineManagement | Sort-Object Version -Descending | Select-Object -First 1).Version)
$connectArgs = @{ Organization = $Org; AccessToken = $Token; EnableSearchOnlySession = $true; ErrorAction = 'Stop' }
if ($Upn) { $connectArgs.UserPrincipalName = $Upn }
try {
  Connect-IPPSSession @connectArgs
  Write-Output "CONNECT=OK"
} catch {
  Write-Output ("CONNECT=FATAL " + $_.Exception.Message)
  exit 1
}
$sn = 'mb365-probe-smoke'
try { Get-ComplianceSearchAction -Identity ($sn + '_Export') -ErrorAction SilentlyContinue | Remove-ComplianceSearchAction -Confirm:$false -ErrorAction SilentlyContinue } catch {}
try { Get-ComplianceSearch -Identity $sn -ErrorAction SilentlyContinue | Remove-ComplianceSearch -Confirm:$false -ErrorAction SilentlyContinue } catch {}
try {
  New-ComplianceSearch -Name $sn -ExchangeLocation 'it@example.com' -ContentMatchQuery 'sent>=2026-09-01' -ErrorAction Stop | Out-Null
  Start-ComplianceSearch -Identity $sn -ErrorAction Stop
  Write-Output "SEARCH=STARTED"
  Start-Sleep -Seconds 20
  $s = Get-ComplianceSearch -Identity $sn
  Write-Output ("SEARCH=STATUS " + $s.Status + " ITEMS=" + $s.Items)
} catch {
  Write-Output "SEARCH=FAILED"
  $e = $_.Exception
  while ($e) { Write-Output ("EXC: " + $e.GetType().FullName + " | " + $e.Message); $e = $e.InnerException }
}
try { Get-ComplianceSearch -Identity $sn -ErrorAction SilentlyContinue | Remove-ComplianceSearch -Confirm:$false -ErrorAction SilentlyContinue } catch {}
Disconnect-ExchangeOnline -Confirm:$false -ErrorAction SilentlyContinue
Write-Output "DONE"
