@echo off
rem M365-Sphere update applier. Spawned detached by lib/updater.js after the
rem server has been asked to exit (code 42).
rem   %1 = staging dir (new files)   %2 = app root
rem Swaps app files only: data\, node_modules\, pst-export\, pst-import\,
rem config.json, Uninstall.exe and *.log are never touched.
setlocal
set "stage=%~1"
set "app=%~2"
if "%stage%"=="" exit /b 1
if "%app%"=="" exit /b 1
cd /d "%app%"
if not exist "%app%\data" mkdir "%app%\data"

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

robocopy "%stage%" "%app%" /MIR /XD data node_modules pst-export pst-import tools .git /XF config.json Uninstall.exe *.log /NFL /NDL /NJH /NJS >nul
if errorlevel 8 (
  echo [update] robocopy failed >> "%app%\data\update-apply.log"
  exit /b 1
)

if defined NEEDNPM (
  for /f "delims=" %%N in ('where node 2^>nul') do set "NODEDIR=%%~dpN" & goto npm
  goto done
  :npm
  echo [update] package-lock changed - running npm install >> "%app%\data\update-apply.log"
  "%NODEDIR%npm.cmd" install --omit=dev --no-audit --no-fund --ignore-scripts >> "%app%\data\update-apply.log" 2>&1
)

:done
echo [%date% %time%] update applied >> "%app%\data\update-apply.log"
if exist "%app%\Start-M365-Sphere.bat" (
  start "" /min cmd /c ""%app%\Start-M365-Sphere.bat""
) else (
  start "" /min cmd /c "cd /d "%app%" && node server.js"
)
exit /b 0
