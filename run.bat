@echo off
setlocal
rem Build and launch the primary Electron desktop app without a console window.
cd /d "%~dp0electron"
set "UNDERTONE_INSTALL_NEEDED="
call npm ls --depth=0 >nul 2>&1
if errorlevel 1 set "UNDERTONE_INSTALL_NEEDED=1"
if not exist "node_modules\electron\dist\electron.exe" set "UNDERTONE_INSTALL_NEEDED=1"
if defined UNDERTONE_INSTALL_NEEDED (
    call npm ci
    if errorlevel 1 exit /b 1
)
if not exist "node_modules\electron\dist\electron.exe" (
    call "node_modules\.bin\install-electron.cmd" --no
    if errorlevel 1 exit /b 1
)
if not exist "node_modules\electron\dist\electron.exe" (
    echo Electron runtime installation did not produce electron.exe. 1>&2
    exit /b 1
)
call npm run build
if errorlevel 1 exit /b 1
set ELECTRON_RUN_AS_NODE=
start "" "%CD%\node_modules\electron\dist\electron.exe" "%CD%"
