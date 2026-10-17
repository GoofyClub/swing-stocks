@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install-Swing.ps1"
set "Swing_RESULT=%ERRORLEVEL%"
echo.
if not "%Swing_RESULT%"=="0" echo Setup needs attention. Read the message above, then run this file again.
pause
exit /b %Swing_RESULT%
