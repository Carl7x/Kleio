@echo off
cd /d "%~dp0"
node scripts\native-web.mjs
if errorlevel 1 pause
