@echo off
cd /d "%~dp0"
node scripts\cloud-web.mjs
if errorlevel 1 pause
