@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\bootstrap.ps1"
if errorlevel 1 exit /b 1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\rust.ps1" -Action test
if errorlevel 1 exit /b 1
"%~dp0.venv\Scripts\python.exe" -m pytest -q
if errorlevel 1 exit /b 1
echo Todos os testes passaram, incluindo as 12 buscas de 1 milhao.
pause
