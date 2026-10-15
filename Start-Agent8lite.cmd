@echo off
setlocal DisableDelayedExpansion
title Agent8lite - Setup and Start
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\bootstrap\windows.ps1"
set "bootstrapExit=%ERRORLEVEL%"
if not "%bootstrapExit%"=="0" (
  echo.
  echo Setup did not finish. Read the message above, then click this file again.
  pause
)
exit /b %bootstrapExit%
