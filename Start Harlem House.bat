@echo off
rem Starts the Harlem House demo site and opens it in your default browser.
cd /d "%~dp0"
start "Harlem House server" cmd /k node ".claude\preview-server.cjs"
timeout /t 1 >nul
start "" http://localhost:4321
