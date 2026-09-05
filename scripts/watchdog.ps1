$ErrorActionPreference = 'Continue'
$projectDir = Split-Path -Parent $PSScriptRoot
$nodeExecutable = 'C:\Program Files\nodejs\node.exe'
$logDir = Join-Path $projectDir 'logs'
$watchdogLog = Join-Path $logDir 'watchdog.log'
$standardLog = Join-Path $logDir 'runtime.stdout.log'
$errorLog = Join-Path $logDir 'runtime.stderr.log'
$mutexCreated = $false
$watchdogMutex = [System.Threading.Mutex]::new($true, 'Local\CryptoSignalPauloMoreiraWatchdog', [ref]$mutexCreated)

if (-not $mutexCreated) { exit 0 }
New-Item -ItemType Directory -Path $logDir -Force | Out-Null

try {
    while ($true) {
        Add-Content -LiteralPath $watchdogLog -Encoding utf8 -Value "[$(Get-Date -Format o)] Iniciando motor de sinais."
        $engineProcess = Start-Process -FilePath $nodeExecutable -ArgumentList 'server/index.js' -WorkingDirectory $projectDir -WindowStyle Hidden -RedirectStandardOutput $standardLog -RedirectStandardError $errorLog -Wait -PassThru
        Add-Content -LiteralPath $watchdogLog -Encoding utf8 -Value "[$(Get-Date -Format o)] Processo encerrado com exit code $($engineProcess.ExitCode). Reiniciando em 5 segundos."
        Start-Sleep -Seconds 5
    }
} finally {
    $watchdogMutex.ReleaseMutex()
    $watchdogMutex.Dispose()
}
