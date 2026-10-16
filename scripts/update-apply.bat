@echo off
rem M365-Sphere update applier. Spawned detached by lib/updater.js after the
rem server has been asked to exit (code 42).
rem   %1 = staging dir (new files)   %2 = app root
rem ALLOW-LIST mirror: only the entries below are synced from staging.
rem Everything else in the app dir (data\, node_modules\, docs\, .agents\,
rem config.json, Uninstall.exe, *.log, …) is never touched.
rem On any failure the existing install is relaunched so the app is never
rem left down, and the script exits nonzero.
setlocal
set "stage=%~1"
set "app=%~2"
if "%stage%"=="" exit /b 1
if "%app%"=="" exit /b 1
cd /d "%app%"
if not exist "%app%\data" mkdir "%app%\data"
set "FAILED="

rem Wait for the running server to exit (max ~60 s).
for /l %%i in (1,1,30) do (
  powershell -NoProfile -Command "if (Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*server.js*' }) { exit 1 } else { exit 0 }"
  if not errorlevel 1 goto serverdown
  timeout /t 2 /nobreak >nul
)
:serverdown

rem Remember whether dependencies changed (checked BEFORE the swap).
set "NEEDNPM="
fc /b "%stage%\package-lock.json" "%app%\package-lock.json" >nul 2>&1 || set NEEDNPM=1

rem Allow-listed directories: mirrored (/MIR) only if present in staging.
for %%D in (lib web ps scripts installer) do (
  if exist "%stage%\%%D" (
    robocopy "%stage%\%%D" "%app%\%%D" /MIR /NFL /NDL /NJH /NJS >nul
    if errorlevel 8 (
      echo [%date% %time%] [update] robocopy %%D FAILED >> "%app%\data\update-apply.log"
      set FAILED=1
    )
  )
)
if exist "%stage%\web-react\dist" (
  if not exist "%app%\web-react" mkdir "%app%\web-react"
  robocopy "%stage%\web-react\dist" "%app%\web-react\dist" /MIR /NFL /NDL /NJH /NJS >nul
  if errorlevel 8 (
    echo [%date% %time%] [update] robocopy web-react\dist FAILED >> "%app%\data\update-apply.log"
    set FAILED=1
  )
)

rem Allow-listed files: plain copy, only if present in staging.
for %%F in (server.js package.json package-lock.json config.example.json README.md AGENTS.md install.bat install.ps1 run-console.bat install-service.js uninstall-service.js) do (
  if exist "%stage%\%%F" (
    robocopy "%stage%" "%app%" "%%F" /NFL /NDL /NJH /NJS >nul
    if errorlevel 8 (
      echo [%date% %time%] [update] copy %%F FAILED >> "%app%\data\update-apply.log"
      set FAILED=1
    )
  )
)

if not defined FAILED if defined NEEDNPM (
  for /f "delims=" %%N in ('where node 2^>nul') do set "NODEDIR=%%~dpN"
  if not defined NODEDIR (
    echo [%date% %time%] [update] npm install skipped - node not on PATH >> "%app%\data\update-apply.log"
    set FAILED=1
  ) else (
    echo [%date% %time%] [update] package-lock changed - running npm install >> "%app%\data\update-apply.log"
    "%NODEDIR%npm.cmd" install --omit=dev --no-audit --no-fund --ignore-scripts >> "%app%\data\update-apply.log" 2>&1
    if errorlevel 1 (
      echo [%date% %time%] [update] npm install FAILED - aborting apply, relaunching existing install >> "%app%\data\update-apply.log"
      set FAILED=1
    )
  )
)

if defined FAILED (
  echo [%date% %time%] [update] update FAILED - relaunching existing install >> "%app%\data\update-apply.log"
) else (
  echo [%date% %time%] update applied >> "%app%\data\update-apply.log"
)
if exist "%app%\Start-M365-Sphere.bat" (
  start "" /min cmd /c ""%app%\Start-M365-Sphere.bat""
) else (
  start "" /min cmd /c "cd /d "%app%" && node server.js"
)
if defined FAILED exit /b 1
exit /b 0
