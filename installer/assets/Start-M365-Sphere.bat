@echo off
rem M365-Sphere launcher: starts the server, opens the dashboard, and restarts
rem the server if it crashes. On first run the server starts unconfigured and
rem the dashboard walks you through connecting your tenant (one sign-in).
cd /d "%~dp0"

rem Open the dashboard shortly after the server starts listening.
start "" /min cmd /c "timeout /t 4 /nobreak >nul & start http://localhost:8080"

set restarts=0
:restart
node server.js
if %errorlevel%==42 (
  echo Server is applying an update - the updater will restart it shortly.
  exit /b 0
)
if %errorlevel%==0 set restarts=0
set /a restarts+=1
if %restarts% geq 10 (
  echo.
  echo Server exited %restarts% times in a row - not restarting. Check the logs in data\.
  pause
  exit /b 1
)
echo.
echo Server exited (code %errorlevel%). Restarting in 5 seconds... Ctrl+C to stop.
timeout /t 5 /nobreak >nul
goto restart
