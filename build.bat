@echo off
rem Build dist\Undertone.exe with PyInstaller using the project venv.
cd /d "%~dp0"
.venv\Scripts\python.exe -m PyInstaller undertone.spec --noconfirm
if errorlevel 1 (
    echo Build failed.
    exit /b 1
)
echo Built dist\Undertone.exe
