@echo off
cd /d "%~dp0"
REM Start: new instance auto-stops old one via /api/ping check (only our service); if port taken by others, server exits friendly via EADDRINUSE.
REM Custom port: set PORT env first (browser URL uses it, else 3000, e.g. set PORT=4000 ^& node server.js).
if defined PORT (set "OPENPORT=%PORT%") else (set "OPENPORT=3000")
start "" cmd /c "timeout /t 4 /nobreak >nul & start "" http://127.0.0.1:%OPENPORT%""
echo Starting netease-music-service (old instance will be stopped automatically)...
echo To stop: double-click the "stop service" bat, or just close this window.
node server.js
pause
