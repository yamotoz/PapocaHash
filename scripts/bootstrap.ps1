$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
$runtimeRoot = Join-Path $projectRoot '.runtime'
New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null
$env:UV_PYTHON_INSTALL_DIR = Join-Path $runtimeRoot 'python'
$env:UV_PYTHON_BIN_DIR = Join-Path $runtimeRoot 'bin'
$env:UV_CACHE_DIR = Join-Path $runtimeRoot 'uv-cache'
$env:UV_NO_MANAGED_PYTHON = '0'
$env:UV_PYTHON_NO_REGISTRY = '1'
$env:CARGO_HOME = Join-Path $runtimeRoot 'cargo'
$env:CARGO_TARGET_DIR = Join-Path $projectRoot 'target'
$uvExe = Join-Path $runtimeRoot 'uv.exe'
if (!(Test-Path -LiteralPath $uvExe)) {
    Write-Host '[1/4] Obtendo o gerenciador Python local...' -ForegroundColor Cyan
    $archivePath = Join-Path $runtimeRoot 'uv.zip'
    Invoke-WebRequest 'https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-pc-windows-msvc.zip' -OutFile $archivePath
    Expand-Archive -LiteralPath $archivePath -DestinationPath $runtimeRoot -Force
}
Write-Host '[2/4] Preparando Python e dependências...' -ForegroundColor Cyan
if (Test-Path -LiteralPath 'uv.lock') { & $uvExe sync --frozen --managed-python } else { & $uvExe sync --managed-python }
if ($LASTEXITCODE -ne 0) { throw 'Não foi possível preparar o Python. Verifique a conexão com a internet.' }
Write-Host '[3/4] Compilando o motor Rust otimizado...' -ForegroundColor Cyan
& (Join-Path $PSScriptRoot 'rust.ps1') -Action build
Write-Host '[4/4] Preparando a wordlist de 1.000.000 de entradas...' -ForegroundColor Cyan
& '.venv/Scripts/python.exe' -m backend.dataset
if ($LASTEXITCODE -ne 0) { throw 'Não foi possível criar a wordlist.' }
Write-Host 'PapocaHash pronto. Abra index.html.' -ForegroundColor Green
