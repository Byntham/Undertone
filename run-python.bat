@echo off
rem Rollback launcher for the retained Python/PySide6 implementation.
start "" "%~dp0.venv\Scripts\pythonw.exe" "%~dp0main.py"
