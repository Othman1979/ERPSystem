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
    $arguments = @('dist/jobs/cli.js', $Job) + @($JobArguments)
    $argumentLine = ($arguments | ForEach-Object { ConvertTo-WindowsArgument "$_" }) -join ' '
    if ($Job -eq 'einvoice-send') {
        $result = Invoke-LoggedProcess -FilePath $NodeExe -ArgumentLine $argumentLine -WorkingDirectory $apiDir -LogPath $logPath -StdoutToLog $false -StderrToLog $true
        $exitCode = $result.ExitCode
        if ($exitCode -ne 0) {
            Add-LogLine -Path $logPath -Line ("{0:o} einvoice-send failed with exit code {1}" -f (Get-Date), $exitCode)
        }
    } else {
        $result = Invoke-LoggedProcess -FilePath $NodeExe -ArgumentLine $argumentLine -WorkingDirectory $apiDir -LogPath $logPath -StdoutToLog $true -StderrToLog $true
        $exitCode = $result.ExitCode
    }
} finally {
    $env:DATABASE_URL = $oldDatabaseUrl
    $env:DB_POOL_SIZE = $oldPoolSize
    Pop-Location
}
exit $exitCode
