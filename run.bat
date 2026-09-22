@echo off
:loop
cls
echo Starting bot...
node bot.js
echo.
echo Bot exited (code %errorlevel%) — restarting in 5 seconds...
timeout /t 5 /nobreak >nul
goto loop
