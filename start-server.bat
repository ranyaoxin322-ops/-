@echo off
title SmartPillbox Relay - do not close this window
cd /d "%~dp0server"
node server.js
echo.
echo [Server stopped] If this is unexpected, check the error above.
pause
