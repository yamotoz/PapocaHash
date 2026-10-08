@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\setup-gpu.ps1"
if errorlevel 1 (
  echo.
  echo O preparo GPU falhou. Confira a mensagem acima.
  pause
  exit /b 1
)
pause
