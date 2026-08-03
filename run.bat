@echo off
setlocal
rem Build and launch the primary Electron desktop app without a console window.
cd /d "%~dp0electron"
if not exist "node_modules\electron\dist\electron.exe" (
    call npm ci
    if errorlevel 1 exit /b 1
)
call npm run build
if errorlevel 1 exit /b 1
set ELECTRON_RUN_AS_NODE=
start "" "%CD%\node_modules\electron\dist\electron.exe" "%CD%"
