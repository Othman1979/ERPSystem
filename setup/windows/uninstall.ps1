param(
    [string]$AppDir = 'C:\ERP\app',
    [string]$DataDir = 'C:\ERPData',
    [switch]$RemoveDatabaseService,
    [switch]$PauseAtEnd
)

. (Join-Path $PSScriptRoot 'lib\common.ps1')
$ErrorActionPreference = 'Stop'
$forwarded = @{}
foreach ($key in $PSBoundParameters.Keys) {
    $forwarded[$key] = $PSBoundParameters[$key]
}
Ensure-Administrator -ScriptPath $PSCommandPath -Parameters $forwarded

try {
$infoPath = Join-Path $DataDir 'INSTALL-INFO.txt'
if (Test-Path -LiteralPath $infoPath) {
    foreach ($line in (Get-Content -LiteralPath $infoPath)) {
        if ($line -match '^AppDir=(.*)$' -and $AppDir -eq 'C:\ERP\app') {
            $AppDir = $Matches[1]
        }
        if ($line -match '^DataDir=(.*)$' -and $DataDir -eq 'C:\ERPData') {
            $DataDir = $Matches[1]
        }
    }
}

Write-Step 'Stopping ERP Cloud scheduled tasks'
try {
    Stop-ErpApp -AppDir $AppDir
} catch {
}
Stop-ErpCaddy -DataDir $DataDir
$tasks = Get-ScheduledTask -TaskPath '\ERP Cloud\' -ErrorAction SilentlyContinue
foreach ($task in $tasks) {
    Stop-ErpTask -Name $task.TaskName
    Unregister-ScheduledTask -TaskPath '\ERP Cloud\' -TaskName $task.TaskName -Confirm:$false -ErrorAction SilentlyContinue | Out-Null
}

Write-Step 'Removing ERP Cloud firewall rules and shortcuts'
Remove-NetFirewallRule -DisplayName 'ERP Cloud HTTPS' -ErrorAction SilentlyContinue
Remove-NetFirewallRule -DisplayName 'ERP Cloud HTTP' -ErrorAction SilentlyContinue
Remove-NetFirewallRule -DisplayName 'ERP Cloud API (block LAN)' -ErrorAction SilentlyContinue
$publicShortcut = Join-Path ([Environment]::GetFolderPath('CommonDesktopDirectory')) 'ERP Cloud.url'
Remove-Item -LiteralPath $publicShortcut -Force -ErrorAction SilentlyContinue

$rootCa = Join-Path $DataDir 'caddy\data\pki\authorities\local\root.crt'
if (Test-Path -LiteralPath $rootCa) {
    $certificate = Get-X509CertificateFromPem -Path $rootCa
    Get-ChildItem Cert:\LocalMachine\Root |
        Where-Object { $_.Thumbprint -eq $certificate.Thumbprint } |
        Remove-Item -ErrorAction SilentlyContinue
    Get-ChildItem Cert:\CurrentUser\Root |
        Where-Object { $_.Thumbprint -eq $certificate.Thumbprint } |
        Remove-Item -ErrorAction SilentlyContinue
}

if ($RemoveDatabaseService) {
    $service = Get-Service -Name 'ERP-MariaDB' -ErrorAction SilentlyContinue
    if ($service) {
        if ($service.Status -ne 'Stopped') {
            Stop-Service -Name 'ERP-MariaDB' -Force
        }
        & sc.exe delete ERP-MariaDB | Out-Null
        if ($LASTEXITCODE -ne 0) {
            Write-Warning 'Could not delete the ERP-MariaDB service. The data directory was preserved.'
        }
    }
}

Write-Host 'ERP Cloud tasks, firewall rules, shortcut, and local CA trust were removed.'
Write-Host "AppDir was not deleted: $AppDir"
Write-Host "DataDir was not deleted: $DataDir"
if ($RemoveDatabaseService) {
    Write-Host 'ERP-MariaDB service removal was requested; its data directory remains in DataDir.'
}
} finally {
    if ($PauseAtEnd) {
        Read-Host 'Press Enter to close' | Out-Null
    }
}
