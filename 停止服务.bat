@echo off
cd /d "%~dp0"
REM Stop: only kills verified own service via /api/ping; port taken by others is left alone.
REM Custom port: node stop.js ^<port^> (defaults to server PORT or 3000).
echo Stopping netease-music-service...
node stop.js
pause
