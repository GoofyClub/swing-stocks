@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Control-Swing.ps1" %*
set "BOT_RESULT=%ERRORLEVEL%"
echo.
pause
exit /b %BOT_RESULT%
