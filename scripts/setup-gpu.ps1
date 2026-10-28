param([switch]$Auto)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
$runtimeRoot = Join-Path $projectRoot '.runtime'
New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null
$archivePath = Join-Path $runtimeRoot 'hashcat-7.1.2.7z'
$binaryPath = Join-Path $runtimeRoot 'hashcat-7.1.2/hashcat.exe'
if ($Auto) {
    $gpuDetected = $false
    try {
        if (Get-Command nvidia-smi -ErrorAction SilentlyContinue) {
            $gpuDetected = @(& nvidia-smi -L 2>$null).Count -gt 0 -and $LASTEXITCODE -eq 0
        }
    } catch { }
    if (!$gpuDetected) {
        try {
            $gpuDetected = @(Get-CimInstance Win32_VideoController -ErrorAction Stop | Where-Object { $_.Name -match 'NVIDIA|Radeon|AMD|Intel Arc' }).Count -gt 0
        } catch { }
    }
    if (!$gpuDetected) {
        Write-Host 'GPU compativel nao detectada; iniciando apenas os motores CPU.' -ForegroundColor DarkGray
        return
    }
    if ((Test-Path -LiteralPath $binaryPath) -and (Test-Path -LiteralPath (Join-Path $runtimeRoot 'gpu-validation.json'))) {
        Write-Host 'Hashcat ja preparado e validado. GPU pronta para o servidor.' -ForegroundColor Green
        return
    }
}
if (!(Test-Path -LiteralPath $binaryPath)) {
    if (!(Test-Path -LiteralPath $archivePath) -or (Get-Item -LiteralPath $archivePath).Length -eq 0) {
        Write-Host 'Obtendo Hashcat 7.1.2 do site oficial...' -ForegroundColor Cyan
        Invoke-WebRequest 'https://hashcat.net/files/hashcat-7.1.2.7z' -OutFile $archivePath -UseBasicParsing
    }
    # Conferir todos os destinos antes de extrair dentro do projeto.
    $archiveEntries = & tar -tf $archivePath
    if ($LASTEXITCODE -ne 0) { throw 'Nao foi possivel ler o pacote. Baixe hashcat-7.1.2.7z novamente do site oficial.' }
    $safeRoot = [IO.Path]::GetFullPath($runtimeRoot) + [IO.Path]::DirectorySeparatorChar
    foreach ($entry in $archiveEntries) {
        $destination = [IO.Path]::GetFullPath((Join-Path $runtimeRoot $entry))
        if (!$destination.StartsWith($safeRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'O arquivo contem um destino fora do projeto.' }
    }
    & tar -xf $archivePath -C $runtimeRoot
    if ($LASTEXITCODE -ne 0) { throw 'A extracao falhou. Extraia o pacote oficial na pasta .runtime do projeto.' }
}
if (!(Test-Path -LiteralPath $binaryPath)) { throw 'hashcat.exe nao encontrado no pacote extraido.' }
if (!(Test-Path -LiteralPath '.venv/Scripts/python.exe')) { throw 'Execute server.bat primeiro para preparar o Python local.' }
Write-Host 'Validando os quatro hashes na GPU OpenCL...' -ForegroundColor Cyan
& '.venv/Scripts/python.exe' -m scripts.validate_gpu
if ($LASTEXITCODE -ne 0) { throw 'A validacao GPU falhou; confira o driver e os detalhes acima. O motor CPU continua disponivel.' }
Write-Host 'GPU validada. Reinicie server.bat e selecione GPU na janela de execucao.' -ForegroundColor Green
