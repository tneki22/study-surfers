@echo off
chcp 65001 >nul
set PYTHONUTF8=1
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\build-desktop.ps1" %*
if errorlevel 1 (
    pause
    exit /b 1
)
pause
