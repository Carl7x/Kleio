@echo off
cd /d "%~dp0"
node scripts/cloud-web.mjs --public
if errorlevel 1 pause
