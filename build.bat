@echo off
setlocal
rem Build the per-user installer artifact.
cd /d "%~dp0electron"
if not exist "node_modules\electron\dist\electron.exe" (
    call npm ci
    if errorlevel 1 exit /b 1
)
call npm run package
if errorlevel 1 (
    echo Build failed.
    exit /b 1
)
echo Built Electron artifacts in electron\release
