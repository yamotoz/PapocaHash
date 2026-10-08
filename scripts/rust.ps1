param([ValidateSet('build', 'test')][string]$Action = 'build')
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
$env:CARGO_HOME = Join-Path $projectRoot '.runtime/cargo'
$env:CARGO_TARGET_DIR = Join-Path $projectRoot 'target'
$cargoCommand = Get-Command cargo -ErrorAction SilentlyContinue
if (!$cargoCommand) { throw 'Rust ausente. Instale o toolchain stable-x86_64-pc-windows-gnu pelo rustup.' }

# Build e testes compartilham cache, destino e a configuracao GNU do projeto.
$cargoArguments = @($Action, '--release', '--manifest-path', 'rust-engine/Cargo.toml')
if (Test-Path -LiteralPath 'rust-engine/Cargo.lock') { $cargoArguments += '--locked' }
& $cargoCommand.Source @cargoArguments
if ($LASTEXITCODE -ne 0) { throw "Rust ($Action) falhou; confira os detalhes acima." }
