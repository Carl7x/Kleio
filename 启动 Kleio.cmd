@echo off
cd /d "%~dp0"
node scripts\runtime.mjs start
if errorlevel 1 pause
