@echo off
rem Launch Undertone using the project's virtualenv, without a console window.
start "" "%~dp0.venv\Scripts\pythonw.exe" "%~dp0main.py"
