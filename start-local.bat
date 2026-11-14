@echo off
rem Starts ERP Cloud on this computer (see scripts\start-local.ps1). Ctrl+C stops it.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-local.ps1" %*
pause
