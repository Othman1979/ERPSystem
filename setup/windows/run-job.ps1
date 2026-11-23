param(
    [Parameter(Mandatory = $true)][ValidateSet('tenant-status', 'einvoice-send', 'backup', 'error-digest', 'stock-verify', 'purge-expired', 'integrity-check', 'backup-verify')][string]$Job,
    [string]$AppDir = 'C:\ERP\app',
    [string]$DataDir = 'C:\ERPData',
    [string]$NodeExe = 'C:\Program Files\nodejs\node.exe',
    [string[]]$JobArguments = @()
)

. (Join-Path $PSScriptRoot 'lib\common.ps1')

$apiDir = Join-Path $AppDir 'apps\api'
$logPath = Join-Path $DataDir 'logs\jobs.log'
if (-not (Test-Path -LiteralPath $NodeExe)) {
    Fail "Node.js executable not found: $NodeExe"
}
if (-not (Test-Path -LiteralPath $apiDir)) {
    Fail "API directory not found: $apiDir"
}
if (-not (Test-Path -LiteralPath (Join-Path $apiDir '.env'))) {
    Fail "Production environment file not found: $(Join-Path $apiDir '.env')"
}
New-Item -ItemType Directory -Path (Split-Path -Parent $logPath) -Force | Out-Null

Push-Location $apiDir
$oldDatabaseUrl = $env:DATABASE_URL
$oldPoolSize = $env:DB_POOL_SIZE
$env:DATABASE_URL = $null
$env:DB_POOL_SIZE = '2'
try {
    Rotate-LogFile -Path $logPath
    if ($Job -eq 'einvoice-send') {
        & $NodeExe 'dist/jobs/cli.js' $Job @JobArguments 2>> $logPath | Out-Null
        $exitCode = $LASTEXITCODE
        if ($exitCode -ne 0) {
            Add-LogLine -Path $logPath -Line ("{0:o} einvoice-send failed with exit code {1}" -f (Get-Date), $exitCode)
        }
    } else {
        & $NodeExe 'dist/jobs/cli.js' $Job @JobArguments 2>&1 |
            ForEach-Object { Add-LogLine -Path $logPath -Line ("{0:o} {1}" -f (Get-Date), "$_") }
        $exitCode = $LASTEXITCODE
    }
} finally {
    $env:DATABASE_URL = $oldDatabaseUrl
    $env:DB_POOL_SIZE = $oldPoolSize
    Pop-Location
}
exit $exitCode
