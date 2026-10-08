@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\bootstrap.ps1"
if errorlevel 1 (
  echo.
  echo O preparo falhou. Confira a mensagem acima e tente novamente.
  pause
  exit /b 1
)
"%~dp0.venv\Scripts\python.exe" -m backend.server
if errorlevel 1 pause
