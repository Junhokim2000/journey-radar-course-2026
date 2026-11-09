@echo off
cd /d "%~dp0"
set "FLIGHT_SHARE_LAN=1"
node server.mjs
pause
