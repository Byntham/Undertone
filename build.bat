@echo off
setlocal
rem Build the per-user installer artifact.
cd /d "%~dp0electron"
call npm ci
if errorlevel 1 exit /b 1
call npm run package
if errorlevel 1 (
    echo Build failed.
    exit /b 1
)
echo Built Electron artifacts in electron\release
