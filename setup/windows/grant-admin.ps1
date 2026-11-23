param(
    [Parameter(Mandatory = $true, Position = 0)][string]$Email,
    [string]$AppDir = '',
    [string]$DataDir = 'C:\ERPData',
    [switch]$PauseAtEnd
)

. (Join-Path $PSScriptRoot 'lib\common.ps1')
$ErrorActionPreference = 'Stop'
$forwarded = @{ Email = $Email; AppDir = $AppDir; DataDir = $DataDir; PauseAtEnd = $PauseAtEnd }
Ensure-Administrator -ScriptPath $PSCommandPath -Parameters $forwarded

try {
$infoPath = Join-Path $DataDir 'INSTALL-INFO.txt'
if (-not $AppDir -and (Test-Path -LiteralPath $infoPath)) {
    foreach ($line in (Get-Content -LiteralPath $infoPath)) {
        if ($line -match '^AppDir=(.*)$') {
            $AppDir = $Matches[1]
            break
        }
    }
}
if (-not $AppDir) {
    $AppDir = 'C:\ERP\app'
}
$apiDir = Join-Path $AppDir 'apps\api'
$node = Get-Command 'node.exe' -ErrorAction SilentlyContinue
if ($node) {
    $nodePath = $node.Source
} else {
    $nodePath = Join-Path $env:ProgramFiles 'nodejs\node.exe'
}
if (-not (Test-Path -LiteralPath $nodePath)) {
    Fail "Node.js executable was not found: $nodePath"
}
if (-not (Test-Path -LiteralPath (Join-Path $apiDir '.env'))) {
    Fail "Production environment file was not found in $apiDir."
}
Push-Location $apiDir
try {
    & $nodePath 'dist/jobs/cli.js' 'grant-platform-admin' $Email
    if ($LASTEXITCODE -ne 0) {
        Fail "grant-platform-admin failed with exit code $LASTEXITCODE."
    }
} finally {
    Pop-Location
}
} finally {
    if ($PauseAtEnd) {
        Read-Host 'Press Enter to close' | Out-Null
    }
}
