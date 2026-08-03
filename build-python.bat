@echo off
rem Rollback build for the retained Python/PySide6 implementation.
cd /d "%~dp0"
.venv\Scripts\python.exe -m PyInstaller undertone.spec --noconfirm
if errorlevel 1 exit /b 1
echo Built rollback artifact dist\Undertone.exe
