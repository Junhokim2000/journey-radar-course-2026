@echo off
setlocal
cd /d "%~dp0"
set "NODE_EXE=node"
where node >nul 2>nul
if errorlevel 1 set "NODE_EXE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
"%NODE_EXE%" --test test/core.test.mjs test/credentials.test.mjs test/homepage-monitoring.test.mjs test/destinations.test.mjs test/auth.test.mjs test/design.test.mjs test/notifications.test.mjs test/comparison.test.mjs
echo Browser tests use isolated temporary accounts and databases.
"%NODE_EXE%" --test test/browser.test.mjs
pause
