# Export a mailbox's .eml.gz store to split Unicode PST files via Outlook COM.
# Runs in the interactive session only (Outlook COM cannot run from a Windows service).
param(
  [Parameter(Mandatory = $true)][string]$Mailbox,
  [Parameter(Mandatory = $true)][string]$StoreRoot,   # <dataDir>\store
  [Parameter(Mandatory = $true)][string]$DataDir,
  [Parameter(Mandatory = $true)][string]$OutRoot,    # pst-export
  [int]$MaxSizeGB = 49,
  [string]$Stamp = (Get-Date -Format 'yyyyMMdd-HHmmss'),
  [string]$ResultPath = '',
  [string]$PlanPath = '',   # optional JSON: [{ name, folders: ["primary/Inbox/Project X", ...] }]
  [string]$ManifestPath = ''  # resume manifest: JSON array of already-exported relative file paths
)

$ErrorActionPreference = 'Continue'
$result = @{ mailbox = $Mailbox; startedAt = (Get-Date).ToString('o'); files = 0; moved = 0; failed = @(); psts = @() }

function DeGzip([string]$src, [string]$dst) {
  $fs = $null; $gs = $null; $out = $null
  try {
    $fs = [IO.File]::OpenRead($src)
    $gs = New-Object IO.Compression.GzipStream($fs, [IO.Compression.CompressionMode]::Decompress)
    $out = [IO.File]::Create($dst)
    $gs.CopyTo($out)
  } finally {
    # Dispose in reverse order so a mid-copy throw never leaves the temp file locked.
    if ($out) { $out.Dispose() }
    if ($gs) { $gs.Dispose() }
    if ($fs) { $fs.Dispose() }
  }
}

$mailboxDir = Join-Path $StoreRoot $Mailbox
$outDir = Join-Path $OutRoot $Mailbox
New-Item -ItemType Directory -Force $outDir | Out-Null

# Resume manifest: relative paths of items already exported by a previous run.
$script:exported = @{}
if ($ManifestPath -and (Test-Path -LiteralPath $ManifestPath)) {
  try {
    foreach ($e in @(Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json)) { $script:exported[[string]$e] = $true }
  } catch { Write-Warning "Could not read export manifest: $($_.Exception.Message)" }
}
function Save-Manifest {
  if (-not $ManifestPath) { return }
  try {
    New-Item -ItemType Directory -Force (Split-Path $ManifestPath) | Out-Null
    [IO.File]::WriteAllText($ManifestPath, (ConvertTo-Json -InputObject ([string[]]@($script:exported.Keys))))
  } catch { Write-Warning "Could not write export manifest: $($_.Exception.Message)" }
}

try {
  # Attach to a running Outlook if present; otherwise we start (and later close) our own.
  $owned = $false
  try { $outlook = [Runtime.InteropServices.Marshal]::GetActiveObject('Outlook.Application'); Write-Output 'outlook: attached to the running instance' }
  catch { $outlook = New-Object -ComObject Outlook.Application; $owned = $true; Write-Output 'outlook: started a hidden background instance' }
  $ns = $outlook.GetNamespace('MAPI')
  Write-Output ('outlook: MAPI session ready — profile user: ' + $ns.CurrentUser.Name)

  # Record process ids so a Stop can kill the whole tree — child.kill() on the
  # PowerShell process alone leaves the COM Outlook instance (and its PST file
  # locks) alive, which made stopped exports appear to "come back".
  if ($ResultPath) {
    $olPid = $null
    if ($owned) {
      try { $olPid = (Get-Process OUTLOOK -ErrorAction SilentlyContinue | Sort-Object StartTime -Descending | Select-Object -First 1).Id } catch {}
    }
    try { [IO.File]::WriteAllText((Join-Path (Split-Path $ResultPath -Parent) 'owner.pid'), ($PID, $olPid -join ' ').Trim()) } catch {}
  }

  $part = 0
  $currentPst = $null
  $root = $null
  $nameBase = $null        # set per plan part; $null = whole-mailbox mode (part001, ...)
  $splitIdx = 0            # continuation index within the current part (0 = first file)
  $currentPartRes = $null  # per-part result bucket when a plan is used

  function Open-NextPart {
    if ($script:nameBase) {
      $suffix = if ($script:splitIdx -gt 0) { '-part{0:D3}' -f ($script:splitIdx + 1) } else { '' }
      $name = $script:nameBase + $suffix
    } else {
      $script:part++
      $name = 'part{0:D3}' -f $script:part
    }
    $p = Join-Path $outDir ("{0}-{1}-{2}.pst" -f $Mailbox, $Stamp, $name)
    Write-Output ("pst: creating " + $p)
    if (Test-Path $p) { $script:ns.AddStore($p) } else { $script:ns.AddStoreEx($p, 3) }  # 3 = olStoreUnicode
    Write-Output 'pst: store attached'
    $script:currentPst = $p
    $script:result.psts += $p
    if ($script:currentPartRes) { $script:currentPartRes.psts += $p }
    $storeObj = $null
    foreach ($s in $script:ns.Stores) { if ($s.FilePath -eq $p) { $storeObj = $s; break } }
    if (-not $storeObj) { throw "Could not open newly created PST: $p" }
    $script:root = $storeObj.GetRootFolder()
  }

  function Close-CurrentPart {
    if (-not $script:currentPst) { return }
    foreach ($s in @($script:ns.Stores)) {
      if ($s.FilePath -eq $script:currentPst) {
        $rf = $s.GetRootFolder()
        $script:ns.RemoveStore($rf)
        [void][Runtime.InteropServices.Marshal]::ReleaseComObject($rf)
        [void][Runtime.InteropServices.Marshal]::ReleaseComObject($s)
        break
      }
    }
    $script:currentPst = $null; $script:root = $null
  }

  function Get-TargetFolder([string]$relPath) {
    # relPath: <scope>/<folder...>/<file>.eml.gz ; scope segment selects the PST root target
    $segs = $relPath -split '\\'
    $scope = $segs[0]
    $folder = $script:root
    $names = @()
    if ($scope -ieq 'archive') { $names += 'Online Archive' }
    if ($segs.Count -gt 2) { $names += $segs[1..($segs.Count - 2)] }
    foreach ($n in $names) {
      $next = $null
      foreach ($f in $folder.Folders) { if ($f.Name -eq $n) { $next = $f; break } }
      if (-not $next) { $next = $folder.Folders.Add($n) }
      $folder = $next
    }
    return $folder
  }

  function Export-One($f, $partRes) {
    $rel = $f.FullName.Substring($mailboxDir.Length + 1)
    $tmp = Join-Path $env:TEMP ("m365pst-" + [guid]::NewGuid().ToString() + ".eml")
    $item = $null
    try {
      DeGzip $f.FullName $tmp
      $item = $ns.OpenSharedItem($tmp)
      $target = Get-TargetFolder $rel
      $movedItem = $item.Move($target)
      [void][Runtime.InteropServices.Marshal]::ReleaseComObject($movedItem)
      $result.moved++
      if ($partRes) { $partRes.moved++ }
      $script:exported[$rel] = $true
      if ($result.moved % 25 -eq 0) { Save-Manifest }
      [void][Runtime.InteropServices.Marshal]::ReleaseComObject($target)
    }
    catch {
      $entry = @{ file = $rel; error = $_.Exception.Message }
      $result.failed += $entry
      if ($partRes) { $partRes.failed += $entry }
    }
    finally {
      if ($item) { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($item) }
      Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
    }
    $result.files++
    if ($result.files % 50 -eq 0) { Write-Output ("progress: {0} processed, {1} exported, {2} failed" -f $result.files, $result.moved, @($result.failed).Count) }
    # auto-split when current PST exceeds the cap (continuation files get -part002, -part003, ... suffixes in plan mode)
    if ($script:currentPst -and (Get-Item -LiteralPath $script:currentPst).Length -gt ($MaxSizeGB * 1GB)) {
      Close-CurrentPart
      $script:splitIdx++
      Open-NextPart
    }
  }

  function Select-PartFiles($allFiles, $prefixes) {
    # segment-boundary aware prefix match on the file's folder directory (relative to mailboxDir)
    $picked = @()
    foreach ($f in $allFiles) {
      $dirRel = $f.DirectoryName.Substring($mailboxDir.Length + 1)
      foreach ($px in $prefixes) {
        if ($dirRel -ieq $px -or $dirRel.StartsWith($px + '\', [StringComparison]::OrdinalIgnoreCase)) { $picked += $f; break }
      }
    }
    return $picked
  }

  $plan = $null
  if ($PlanPath -and (Test-Path -LiteralPath $PlanPath)) {
    $plan = @(Get-Content -LiteralPath $PlanPath -Raw | ConvertFrom-Json)
  }

  # With a plan, enumerate only the planned folders' directories — exporting one
  # folder must not scan the whole mailbox store first.
  if ($plan -and $plan.Count -gt 0) {
    $allFiles = @()
    $seenDirs = @{}
    foreach ($partDef in $plan) {
      foreach ($fold in $partDef.folders) {
        $dir = Join-Path $mailboxDir (([string]$fold) -replace '/', '\')
        if ($seenDirs.ContainsKey($dir)) { continue }
        $seenDirs[$dir] = $true
        if (Test-Path -LiteralPath $dir) {
          Write-Output ("scan: " + $fold)
          $allFiles += @(Get-ChildItem -LiteralPath $dir -Recurse -Filter '*.eml.gz' -ErrorAction SilentlyContinue)
        } else {
          Write-Warning "planned folder not on disk: $fold"
        }
      }
    }
  } else {
    $allFiles = Get-ChildItem -LiteralPath $mailboxDir -Recurse -Filter '*.eml.gz' -ErrorAction SilentlyContinue
  }
  Write-Output ("scan: {0} item(s) to process" -f @($allFiles).Count)
  if ($script:exported.Count -gt 0) {
    $before = @($allFiles).Count
    $allFiles = @($allFiles | Where-Object { -not $script:exported.ContainsKey($_.FullName.Substring($mailboxDir.Length + 1)) })
    Write-Output ("resume: skipping {0} already-exported item(s)" -f ($before - @($allFiles).Count))
  }

  if ($plan -and $plan.Count -gt 0) {
    $result.parts = @()
    foreach ($partDef in $plan) {
      $partRes = @{ name = [string]$partDef.name; psts = @(); moved = 0; failed = @() }
      $prefixes = @($partDef.folders | ForEach-Object { (([string]$_) -replace '/', '\').TrimEnd('\') })
      $files = Select-PartFiles $allFiles $prefixes
      $script:nameBase = ([string]$partDef.name) -replace '[\\/:*?"<>|]', '-'
      if (-not $script:nameBase) { $script:nameBase = 'part' }
      $script:splitIdx = 0
      $script:currentPartRes = $partRes
      Open-NextPart
      foreach ($f in $files) { Export-One $f $partRes }
      Close-CurrentPart   # folders never span parts: each part gets its own PST file(s)
      $script:currentPartRes = $null
      $script:nameBase = $null
      $result.parts += $partRes
    }
  } else {
    Open-NextPart
    foreach ($f in $allFiles) { Export-One $f $null }
    Close-CurrentPart
  }

  Save-Manifest
  if ($owned) { $outlook.Quit() }
}
catch {
  $result.failed += @{ file = '(export)'; error = $_.Exception.Message }
}
finally {
  $result.finishedAt = (Get-Date).ToString('o')
  if (-not $ResultPath) { $ResultPath = Join-Path $outDir 'result.json' }
  New-Item -ItemType Directory -Force (Split-Path $ResultPath) | Out-Null
  $result | ConvertTo-Json -Depth 6 | Out-File -Encoding utf8 $ResultPath
}

Write-Output ($result | ConvertTo-Json -Depth 6 -Compress)
