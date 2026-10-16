@echo off
chcp 65001 >nul
set PYTHONUTF8=1
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\launcher.ps1"
if errorlevel 1 pause
