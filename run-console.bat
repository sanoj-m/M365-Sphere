@echo off
cd /d "%~dp0"
set restarts=0
:restart
node server.js
rem A clean exit resets the backoff counter; only consecutive crashes count.
if %errorlevel%==0 set restarts=0
set /a restarts+=1
if %restarts% geq 10 (
  echo.
  echo Server exited %restarts% times in a row - not restarting. Check the logs in data\ and daemon\.
  pause
  exit /b 1
)
echo.
echo Server exited (code %errorlevel%). Restarting in 5 seconds... Ctrl+C to stop.
timeout /t 5 /nobreak >nul
goto restart
