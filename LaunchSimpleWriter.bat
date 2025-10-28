@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>&1
if %errorlevel% neq 0 (
  echo Node.js is required to run SimpleWriter.
  echo Download it from https://nodejs.org/ and try again.
  pause
  exit /b 1
)
set PORT=5173
echo Starting SimpleWriter on http://localhost:%PORT%
start "SimpleWriter Server" cmd /k "cd /d \"%~dp0\" && node server.js"
rem give the server a moment before opening the browser
ping 127.0.0.1 -n 2 >nul
start "" http://localhost:%PORT%
endlocal
