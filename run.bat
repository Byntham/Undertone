@echo off
setlocal
rem Build and launch the primary Electron desktop app without a console window.
cd /d "%~dp0electron"
if not exist "node_modules\electron\dist\electron.exe" (
    call npm ci
    if errorlevel 1 exit /b 1
    rem Electron 43 downloads its runtime lazily when the package is loaded.
    node -e "require('electron')"
    if errorlevel 1 exit /b 1
    if not exist "node_modules\electron\dist\electron.exe" (
        echo Electron runtime installation did not produce electron.exe. 1>&2
        exit /b 1
    )
)
call npm run build
if errorlevel 1 exit /b 1
set ELECTRON_RUN_AS_NODE=
start "" "%CD%\node_modules\electron\dist\electron.exe" "%CD%"
