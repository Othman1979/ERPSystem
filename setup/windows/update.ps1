param(
    [string]$AppDir = 'C:\ERP\app',
    [string]$DataDir = 'C:\ERPData',
    [switch]$PauseAtEnd
)

. (Join-Path $PSScriptRoot 'lib\common.ps1')
$ErrorActionPreference = 'Stop'
$forwarded = @{}
foreach ($key in $PSBoundParameters.Keys) {
    $forwarded[$key] = $PSBoundParameters[$key]
}
Ensure-Administrator -ScriptPath $PSCommandPath -Parameters $forwarded

function Read-InstallInfo {
    param([string]$Path)
    $values = @{}
    if (Test-Path -LiteralPath $Path) {
        foreach ($line in (Get-Content -LiteralPath $Path)) {
            if ($line -match '^([A-Za-z0-9_]+)=(.*)$') {
                $values[$Matches[1]] = $Matches[2]
            }
        }
    }
    return $values
}

function Invoke-UpdateCommand {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$Arguments = @(),
        [Parameter(Mandatory = $true)][string]$WorkingDirectory,
        [Parameter(Mandatory = $true)][string]$StepName
    )
    Write-Step $StepName
    Push-Location $WorkingDirectory
    try {
        & $FilePath @Arguments | Out-Host
        $code = $LASTEXITCODE
    } finally {
        Pop-Location
    }
    if ($code -ne 0) {
        throw "$StepName failed with exit code $code."
    }
}

function Invoke-UpdateBackup {
    $runner = Join-Path $PSScriptRoot 'run-job.ps1'
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $runner -Job backup -AppDir $AppDir -DataDir $DataDir -NodeExe $nodeExe | Out-Host
    if ($LASTEXITCODE -ne 0) {
        throw "The pre-update backup failed with exit code $LASTEXITCODE."
    }
}

function Wait-ForHealth {
    param([Parameter(Mandatory = $true)][string]$Url)
    $deadline = (Get-Date).AddMinutes(3)
    while ((Get-Date) -lt $deadline) {
        try {
            $response = Invoke-WebRequest -Uri "$Url/api/v1/health" -UseBasicParsing -TimeoutSec 10
            if ($response.StatusCode -eq 200) {
                return
            }
        } catch {
        }
        Start-Sleep -Seconds 5
    }
    throw "Health check did not return HTTP 200 within three minutes: $Url"
}

try {
$info = Read-InstallInfo -Path (Join-Path $DataDir 'INSTALL-INFO.txt')
if ($AppDir -eq 'C:\ERP\app' -and $info.ContainsKey('AppDir')) {
    $AppDir = $info.AppDir
}
if ($DataDir -eq 'C:\ERPData' -and $info.ContainsKey('DataDir')) {
    $DataDir = $info.DataDir
}
$apiDir = Join-Path $AppDir 'apps\api'
$nodeExe = Join-Path $env:ProgramFiles 'nodejs\node.exe'
$pnpmExe = Get-Command 'pnpm.cmd' -ErrorAction SilentlyContinue
if (-not $pnpmExe) {
    $pnpmExe = Get-Command 'pnpm' -ErrorAction SilentlyContinue
}
if (-not $pnpmExe) {
    Fail 'pnpm is not available. Run install.bat or repair Corepack first.'
}
$pnpmPath = $pnpmExe.Source
if (-not $pnpmPath) {
    $pnpmPath = $pnpmExe.Path
}
if (-not (Test-Path -LiteralPath $nodeExe)) {
    $nodeCommand = Get-Command 'node.exe' -ErrorAction SilentlyContinue
    if ($nodeCommand) {
        $nodeExe = $nodeCommand.Source
    }
}
if (-not (Test-Path -LiteralPath $nodeExe)) {
    Fail 'Node.js 24 executable was not found.'
}
$previousCommit = (& git -C $AppDir rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0) {
    Fail "Could not read the current commit in $AppDir."
}
$url = $info.URL
if (-not $url) {
    Fail 'URL is missing from INSTALL-INFO.txt. Re-run install.bat first.'
}
$pullCompleted = $false
$appStopped = $false

try {
    Set-ErpJobTasksEnabled -Enabled $false
    Invoke-UpdateBackup
    Stop-ErpApp -AppDir $AppDir
    $appStopped = $true
    $env:DATABASE_URL = $null
    Invoke-UpdateCommand -FilePath $pnpmPath -Arguments @('--filter', 'api', 'ledger:check') -WorkingDirectory $AppDir -StepName 'Checking posted ledger data'
    Write-Step 'Fast-forwarding the server clone'
    & git -C $AppDir pull --ff-only | Out-Host
    if ($LASTEXITCODE -ne 0) {
        throw "git pull --ff-only failed with exit code $LASTEXITCODE."
    }
    $pullCompleted = $true
    Invoke-UpdateCommand -FilePath $pnpmPath -Arguments @('install', '--frozen-lockfile', '--prod=false') -WorkingDirectory $AppDir -StepName 'Installing dependencies'
    Invoke-UpdateCommand -FilePath $pnpmPath -Arguments @('--filter', 'api', 'exec', 'prisma', 'migrate', 'deploy') -WorkingDirectory $AppDir -StepName 'Applying database migrations'
    Invoke-UpdateCommand -FilePath $pnpmPath -Arguments @('--filter', 'api', 'prisma:generate') -WorkingDirectory $AppDir -StepName 'Generating Prisma client'
    Invoke-UpdateCommand -FilePath $pnpmPath -Arguments @('build') -WorkingDirectory $AppDir -StepName 'Building API and web'
    Start-ErpTask -Name 'App'
    $appStopped = $false
    Wait-ForHealth -Url $url
    $preflight = Invoke-LoggedProcess -FilePath $nodeExe -ArgumentLine 'dist/jobs/cli.js preflight' -WorkingDirectory $apiDir -EchoToHost
    $preflightCode = $preflight.ExitCode
    if ($preflightCode -ne 0) {
        throw "Preflight failed with exit code $preflightCode."
    }
    Set-ErpJobTasksEnabled -Enabled $true
    Write-Host 'Update completed. Scheduled jobs are enabled.'
} catch {
    Write-Host "Update failed: $($_.Exception.Message)" -ForegroundColor Red
    if ($pullCompleted) {
        if (-not $appStopped) {
            Stop-ErpApp -AppDir $AppDir
            $appStopped = $true
        }
        Write-Host 'Scheduled jobs remain disabled. Rollback guidance from deploy.md:'
        Write-Host "  git -C `"$AppDir`" checkout $previousCommit"
        Write-Host "  pnpm --filter api prisma:generate"
        Write-Host '  pnpm build'
        Write-Host '  Start the App scheduled task and run preflight.'
        Write-Host '  Migrations are not reversed. If the database schema changed, restore the pre-update backup.'
    } else {
        if ($appStopped) {
            try {
                Start-ErpTask -Name 'App'
            } catch {
            }
        }
        Set-ErpJobTasksEnabled -Enabled $true
        Write-Host 'The update failed before pulling new code; the App and scheduled jobs were re-enabled.'
    }
    throw
}
} finally {
    if ($PauseAtEnd) {
        Read-Host 'Press Enter to close' | Out-Null
    }
}
