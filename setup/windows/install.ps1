param(
    [string]$AppDir = 'C:\ERP\app',
    [string]$DataDir = 'C:\ERPData',
    [string]$HostName = $env:COMPUTERNAME.ToLowerInvariant(),
    [ValidateRange(1, 65535)][int]$HttpsPort = 443,
    [ValidateRange(1, 65535)][int]$HttpPort = 80,
    [ValidateRange(1, 65535)][int]$ApiPort = 3101,
    [string]$ExtraAddresses = '',
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
if (-not [Environment]::Is64BitOperatingSystem -or -not [Environment]::Is64BitProcess) {
    Fail 'The Windows setup requires a 64-bit PowerShell process on x64 Windows.'
}

function Invoke-CheckedCommand {
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
        Fail "$StepName failed with exit code $code."
    }
}

function Invoke-MariaDbSql {
    param(
        [Parameter(Mandatory = $true)][string]$ClientPath,
        [Parameter(Mandatory = $true)][string]$DefaultsFile,
        [Parameter(Mandatory = $true)][string]$Sql
    )
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = New-Object System.Diagnostics.ProcessStartInfo
    $process.StartInfo.FileName = $ClientPath
    $process.StartInfo.Arguments = "--defaults-extra-file=$(ConvertTo-WindowsArgument $DefaultsFile) --batch --skip-column-names"
    $process.StartInfo.UseShellExecute = $false
    $process.StartInfo.CreateNoWindow = $true
    $process.StartInfo.RedirectStandardInput = $true
    $process.StartInfo.RedirectStandardOutput = $true
    $process.StartInfo.RedirectStandardError = $true
    if (-not $process.Start()) {
        throw 'Could not start the MariaDB client.'
    }
    $process.StandardInput.WriteLine($Sql)
    $process.StandardInput.Close()
    $stdout = $process.StandardOutput.ReadToEnd()
    $null = $process.StandardError.ReadToEnd()
    $process.WaitForExit()
    $code = $process.ExitCode
    $process.Dispose()
    if ($code -ne 0) {
        throw 'MariaDB rejected the database setup SQL. Check the MariaDB service and installer flags.'
    }
    return $stdout
}

function ConvertTo-SqlLiteral {
    param([Parameter(Mandatory = $true)][string]$Value)
    $escaped = $Value.Replace('\', '\\').Replace("'", "''")
    return "'" + $escaped + "'"
}

function Get-PrivateIpv4Addresses {
    $items = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object {
            $_.AddressState -eq 'Preferred' -and
            $_.IPAddress -match '^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)' -and
            $_.IPAddress -notmatch '^169\.254\.'
        } |
        Select-Object -ExpandProperty IPAddress -Unique)
    return $items
}

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

function Get-UriPassword {
    param([Parameter(Mandatory = $true)][string]$DatabaseUrl)
    try {
        $uri = New-Object System.Uri($DatabaseUrl)
        $parts = $uri.UserInfo.Split(':', 2)
        if ($parts.Count -ne 2 -or -not $parts[1]) {
            throw 'missing password'
        }
        return [Uri]::UnescapeDataString($parts[1])
    } catch {
        Fail 'DATABASE_URL in the existing production .env must contain a user and password.'
    }
}

function Get-UriPort {
    param([Parameter(Mandatory = $true)][string]$DatabaseUrl)
    try {
        $port = (New-Object System.Uri($DatabaseUrl)).Port
        if ($port -lt 1) {
            return 3306
        }
        return $port
    } catch {
        Fail 'DATABASE_URL in the existing production .env is invalid.'
    }
}

function Set-MyIniValues {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$DataDirValue,
        [Parameter(Mandatory = $true)][int]$Port
    )
    $text = ''
    if (Test-Path -LiteralPath $Path) {
        $text = [IO.File]::ReadAllText($Path)
    }
    $updatedText = Update-MyIniText -Text $text -DataDirValue $DataDirValue -Port $Port
    $hasBom = $false
    if (Test-Path -LiteralPath $Path) {
        $bytes = [IO.File]::ReadAllBytes($Path)
        $hasBom = $bytes.Length -ge 3 -and $bytes[0] -eq 239 -and $bytes[1] -eq 187 -and $bytes[2] -eq 191
    }
    $changed = $hasBom -or -not (Test-Path -LiteralPath $Path) -or ([IO.File]::ReadAllText($Path) -ne $updatedText)
    if ($changed) {
        Write-Utf8NoBom -Path $Path -Text $updatedText
    }
    return $changed
}

function Get-CommandPath {
    param([Parameter(Mandatory = $true)][string[]]$Names)
    foreach ($name in $Names) {
        $command = Get-Command $name -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($command -and $command.Source) {
            return $command.Source
        }
        if ($command -and $command.Path) {
            return $command.Path
        }
    }
    return $null
}

function Install-GitIfMissing {
    if (Get-Command git.exe -ErrorAction SilentlyContinue) {
        return
    }
    $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
    if (-not $winget) {
        Fail 'Git is required. Install Git for Windows from https://git-scm.com/download/win, then run setup again.'
    }
    Write-Step 'Installing Git for Windows with winget'
    & $winget.Source install --id Git.Git -e --silent --accept-package-agreements --accept-source-agreements | Out-Host
    if ($LASTEXITCODE -ne 0) {
        Fail 'winget could not install Git. Install Git for Windows manually and run setup again.'
    }
    Update-ProcessPath
    if (-not (Get-Command git.exe -ErrorAction SilentlyContinue)) {
        Fail 'Git was installed but is not on PATH. Restart PowerShell and run setup again.'
    }
}

function Ensure-AppClone {
    param(
        [Parameter(Mandatory = $true)][string]$SourceRoot,
        [Parameter(Mandatory = $true)][string]$Destination
    )
    Install-GitIfMissing
    $origin = (& git -C $SourceRoot remote get-url origin).Trim()
    if ($LASTEXITCODE -ne 0 -or -not $origin) {
        Fail 'Could not read origin from the setup repository.'
    }
    if (-not (Test-Path -LiteralPath (Join-Path $Destination '.git'))) {
        if ((Test-Path -LiteralPath $Destination) -and (Get-ChildItem -LiteralPath $Destination -Force | Select-Object -First 1)) {
            Fail "AppDir exists but is not a Git clone: $Destination"
        }
        Write-Step "Cloning the dedicated server copy to $Destination"
        & git clone $SourceRoot $Destination | Out-Host
        if ($LASTEXITCODE -ne 0) {
            Fail "Could not clone the setup repository into $Destination."
        }
    }
    & git -C $Destination remote set-url origin $origin | Out-Host
    if ($LASTEXITCODE -ne 0) {
        Fail 'Could not configure the server clone origin.'
    }
    & git -C $Destination pull --ff-only origin main | Out-Host
    if ($LASTEXITCODE -ne 0) {
        Write-Warning 'Could not fast-forward the server clone from origin/main; continuing with its current commit.'
    }
}

function Ensure-Node24 {
    $node = Get-CommandPath @('node.exe', 'node')
    $needInstall = $true
    if ($node) {
        $versionText = (& $node -v).Trim().TrimStart('v')
        try {
            $version = [version]$versionText
            $needInstall = $version.Major -ne 24
        } catch {
            $needInstall = $true
        }
    }
    if ($needInstall) {
        Write-Step 'Resolving and installing Node.js 24'
        $metadata = Get-Node24Metadata
        $msi = Join-Path $DataDir "downloads\$($metadata.FileName)"
        Save-VerifiedDownload -Uri $metadata.Url -Hash $metadata.Hash -Destination $msi -HashAlgorithm $metadata.HashAlgorithm | Out-Null
        $process = Start-Process -FilePath 'msiexec.exe' -ArgumentList @('/i', (ConvertTo-WindowsArgument $msi), '/qn', '/norestart') -Wait -PassThru
        if ($process.ExitCode -ne 0 -and $process.ExitCode -ne 3010) {
            Fail "Node.js MSI installation failed with exit code $($process.ExitCode)."
        }
        Update-ProcessPath
    }
    $node = Get-CommandPath @('node.exe', 'node')
    if (-not $node) {
        Fail 'Node.js is not available on PATH after installation.'
    }
    $installed = (& $node -v).Trim().TrimStart('v')
    if (([version]$installed).Major -ne 24) {
        Fail "Node.js $installed is installed. Install Node.js 24 LTS."
    }
    $corepack = Get-CommandPath @('corepack.cmd', 'corepack')
    if (-not $corepack) {
        $npm = Get-CommandPath @('npm.cmd', 'npm')
        if (-not $npm) {
            Fail 'Corepack is missing and npm was not found.'
        }
        Invoke-CheckedCommand -FilePath $npm -Arguments @('install', '--global', 'corepack') -WorkingDirectory $DataDir -StepName 'Installing Corepack'
        Update-ProcessPath
        $corepack = Get-CommandPath @('corepack.cmd', 'corepack')
    }
    if (-not $corepack) {
        Fail 'Corepack was not found after installation.'
    }
    Invoke-CheckedCommand -FilePath $corepack -Arguments @('enable') -WorkingDirectory $DataDir -StepName 'Enabling Corepack'
    Invoke-CheckedCommand -FilePath $corepack -Arguments @('prepare', 'pnpm@10.18.0', '--activate') -WorkingDirectory $DataDir -StepName 'Activating pnpm 10.18.0'
    return $node
}

function Ensure-MariaDbBinaries {
    param([Parameter(Mandatory = $true)][string]$MariaBin)
    $server = Join-Path $MariaBin 'mariadbd.exe'
    if (Test-Path -LiteralPath $server) {
        return
    }
    Write-Step 'Resolving and installing MariaDB 11.8 binaries'
    $metadata = Get-MariaDB118Metadata
    $msi = Join-Path $DataDir "downloads\$($metadata.FileName)"
    Save-VerifiedDownload -Uri $metadata.Url -Hash $metadata.Hash -Destination $msi -HashAlgorithm $metadata.HashAlgorithm | Out-Null
    $installDir = Split-Path -Parent $MariaBin
    $arguments = @(
        '/i',
        (ConvertTo-WindowsArgument $msi),
        '/qn',
        '/norestart',
        "INSTALLDIR=$(ConvertTo-WindowsArgument $installDir)",
        'ADDLOCAL=MYSQLSERVER,Client,SharedLibraries'
    )
    $process = Start-Process -FilePath 'msiexec.exe' -ArgumentList $arguments -Wait -PassThru
    if ($process.ExitCode -ne 0 -and $process.ExitCode -ne 3010) {
        Fail "MariaDB MSI installation failed with exit code $($process.ExitCode)."
    }
    Update-ProcessPath
    if (-not (Test-Path -LiteralPath $server)) {
        Fail "MariaDB binaries were not found at $server after installation."
    }
}

function Ensure-MariaDbInstance {
    param(
        [Parameter(Mandatory = $true)][string]$MariaBin,
        [int]$RequestedPort
    )
    $client = Join-Path $MariaBin 'mariadb.exe'
    if (-not (Test-Path -LiteralPath $client)) {
        $client = Join-Path $MariaBin 'mysql.exe'
    }
    $dump = Join-Path $MariaBin 'mariadb-dump.exe'
    if (-not (Test-Path -LiteralPath $dump)) {
        $dump = Join-Path $MariaBin 'mysqldump.exe'
    }
    if (-not (Test-Path -LiteralPath $client) -or -not (Test-Path -LiteralPath $dump)) {
        Fail "MariaDB client tools were not found in $MariaBin."
    }
    $service = Get-Service -Name 'ERP-MariaDB' -ErrorAction SilentlyContinue
    $rootSecretPath = Join-Path $DataDir 'secrets\mariadb-root.txt'
    $dbData = Join-Path $DataDir 'mariadb'
    $myIni = Join-Path $dbData 'my.ini'
    if (-not $service) {
        if (Test-Path -LiteralPath $dbData) {
            Fail "MariaDB data directory exists without the ERP-MariaDB service: $dbData. Inspect it before retrying."
        }
        if ($RequestedPort -gt 0) {
            $port = $RequestedPort
            if (-not (Test-PortFree -Port $port)) {
                Fail "MariaDB port $port is already in use."
            }
        } else {
            $port = Get-PreferredPort -PreferredPort 3306 -FallbackPorts @(3307, 3308, 3309, 3310)
        }
        $rootPassword = New-RandomSecret -Kind DatabasePassword
        Write-Utf8NoBom -Path $rootSecretPath -Text ($rootPassword + "`r`n")
        Set-RestrictedAcl -Path $rootSecretPath
        $initialize = Join-Path $MariaBin 'mariadb-install-db.exe'
        if (-not (Test-Path -LiteralPath $initialize)) {
            Fail "MariaDB initializer not found: $initialize. Confirm the MSI feature selection on Windows."
        }
        Write-Step 'Initializing the ERP-MariaDB instance'
        $arguments = @(
            "--datadir=$(ConvertTo-WindowsArgument $dbData)",
            '--service=ERP-MariaDB',
            "--port=$port",
            "--password=$rootPassword"
        )
        $process = Start-Process -FilePath $initialize -ArgumentList $arguments -Wait -PassThru -NoNewWindow
        if ($process.ExitCode -ne 0) {
            Fail "MariaDB instance initialization failed with exit code $($process.ExitCode). Confirm the installer flags on Windows."
        }
        $service = Get-Service -Name 'ERP-MariaDB' -ErrorAction SilentlyContinue
        if (-not $service) {
            Fail 'MariaDB initialization completed without creating the ERP-MariaDB service.'
        }
    } else {
        if (-not (Test-Path -LiteralPath $rootSecretPath)) {
            Fail "The ERP-MariaDB service exists but its root password file is missing: $rootSecretPath"
        }
        $rootPassword = ([IO.File]::ReadAllText($rootSecretPath)).Trim()
        if (-not $rootPassword) {
            Fail "MariaDB root password file is empty: $rootSecretPath"
        }
        $iniPort = 0
        if (Test-Path -LiteralPath $myIni) {
            $iniPort = Get-MariaDbIniPort -Text ([IO.File]::ReadAllText($myIni))
        }
        $port = $iniPort
        if ($port -le 0) {
            $port = $RequestedPort
        }
        if ($port -le 0) {
            $port = 3306
        }
    }
    Set-RestrictedAcl -Path $rootSecretPath
    $iniChanged = Set-MyIniValues -Path $myIni -DataDirValue $dbData -Port $port
    Set-Service -Name 'ERP-MariaDB' -StartupType Automatic | Out-Null
    $service = Get-Service -Name 'ERP-MariaDB'
    if ($iniChanged -and $service.Status -eq 'Running') {
        Restart-Service -Name 'ERP-MariaDB' -Force | Out-Null
    } elseif ($service.Status -ne 'Running') {
        Start-Service -Name 'ERP-MariaDB' | Out-Null
    }
    $deadline = (Get-Date).AddSeconds(60)
    do {
        Start-Sleep -Seconds 2
        $service = Get-Service -Name 'ERP-MariaDB'
        if ($service.Status -eq 'Running') {
            break
        }
    } while ((Get-Date) -lt $deadline)
    if ($service.Status -ne 'Running') {
        Fail 'ERP-MariaDB did not enter the Running state.'
    }
    return [pscustomobject]@{
        ClientPath = $client
        DumpPath = $dump
        Port = $port
        RootPassword = $rootPassword
    }
}

function Set-UpDatabases {
    param(
        [Parameter(Mandatory = $true)][string]$MariaClient,
        [Parameter(Mandatory = $true)][string]$RootPassword,
        [Parameter(Mandatory = $true)][int]$Port,
        [Parameter(Mandatory = $true)][string]$DatabasePassword
    )
    $defaultsFile = Join-Path $DataDir 'secrets\mariadb-client.cnf'
    $clientConfig = "[client]`r`nuser=root`r`npassword=$RootPassword`r`nhost=127.0.0.1`r`nport=$Port`r`nprotocol=tcp`r`n"
    Write-Utf8NoBom -Path $defaultsFile -Text $clientConfig
    Set-RestrictedAcl -Path $defaultsFile
    try {
        $passwordLiteral = ConvertTo-SqlLiteral $DatabasePassword
        $sql = @"
CREATE DATABASE IF NOT EXISTS erp CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE DATABASE IF NOT EXISTS erp_restore CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS 'erp'@'localhost' IDENTIFIED BY $passwordLiteral;
ALTER USER 'erp'@'localhost' IDENTIFIED BY $passwordLiteral;
CREATE USER IF NOT EXISTS 'erp'@'127.0.0.1' IDENTIFIED BY $passwordLiteral;
ALTER USER 'erp'@'127.0.0.1' IDENTIFIED BY $passwordLiteral;
GRANT ALL PRIVILEGES ON erp.* TO 'erp'@'localhost';
GRANT ALL PRIVILEGES ON erp_restore.* TO 'erp'@'localhost';
GRANT ALL PRIVILEGES ON erp.* TO 'erp'@'127.0.0.1';
GRANT ALL PRIVILEGES ON erp_restore.* TO 'erp'@'127.0.0.1';
FLUSH PRIVILEGES;
"@
        Invoke-MariaDbSql -ClientPath $MariaClient -DefaultsFile $defaultsFile -Sql $sql | Out-Null
    } finally {
        Remove-Item -LiteralPath $defaultsFile -Force -ErrorAction SilentlyContinue
    }
}

function Invoke-JobNow {
    param(
        [Parameter(Mandatory = $true)][string]$Job,
        [string[]]$JobArguments = @()
    )
    $runner = Join-Path $AppDir 'setup\windows\run-job.ps1'
    $runnerArguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $runner, '-Job', $Job, '-AppDir', $AppDir, '-DataDir', $DataDir, '-NodeExe', $nodeExe)
    if ($JobArguments.Count -gt 0) {
        $runnerArguments += '-JobArguments'
        $runnerArguments += $JobArguments
    }
    & powershell.exe @runnerArguments | Out-Host
    if ($LASTEXITCODE -ne 0) {
        Fail "The $Job job failed with exit code $LASTEXITCODE."
    }
    Write-Host "$Job completed successfully. See $(Join-Path $DataDir 'logs\jobs.log')."
}

try {
    Write-Step 'Preparing paths and reading any existing installation'
    foreach ($path in @($AppDir, $DataDir)) {
        if (-not (Test-Path -LiteralPath $path)) {
            New-Item -ItemType Directory -Path $path -Force | Out-Null
        }
    }
    $secretsDir = Join-Path $DataDir 'secrets'
    $logsDir = Join-Path $DataDir 'logs'
    $downloadsDir = Join-Path $DataDir 'downloads'
    Set-RestrictedAcl -Path $DataDir
    foreach ($path in @($secretsDir, $logsDir, $downloadsDir)) {
        New-Item -ItemType Directory -Path $path -Force | Out-Null
    }
    $installInfoPath = Join-Path $DataDir 'INSTALL-INFO.txt'
    $installInfo = Read-InstallInfo -Path $installInfoPath
    $envPath = Join-Path $AppDir 'apps\api\.env'
    $existingEnvText = $null
    if (Test-Path -LiteralPath $envPath) {
        $existingEnvText = [IO.File]::ReadAllText($envPath)
        $existingNodeEnv = Get-EnvValue -Text $existingEnvText -Name 'NODE_ENV'
        if ($existingNodeEnv -ne 'production') {
            Fail "Refusing to overwrite non-production environment file: $envPath. Use a separate server clone or back up the existing file."
        }
        foreach ($required in @(
            'DATABASE_URL', 'CORS_ORIGIN', 'JWT_ACCESS_SECRET', 'EINVOICE_ENC_KEY',
            'EINVOICE_WORKER', 'TRUST_PROXY', 'API_PORT', 'MYSQLDUMP_PATH', 'MYSQL_PATH',
            'BACKUP_ENCRYPTION_KEY', 'BACKUP_VERIFY_DATABASE_URL', 'TENANCY_MODE'
        )) {
            if (-not (Get-EnvValue -Text $existingEnvText -Name $required)) {
                Fail "Existing production .env is missing $required. Update it manually before rerunning setup."
            }
        }
        if ((Get-EnvValue -Text $existingEnvText -Name 'TENANCY_MODE') -ne 'shared') {
            Fail 'The existing production .env must use TENANCY_MODE=shared for this Windows setup.'
        }
        if ((Get-EnvValue -Text $existingEnvText -Name 'EINVOICE_WORKER') -ne 'off') {
            Fail 'The existing production .env must use EINVOICE_WORKER=off for this Windows setup.'
        }
        if ((Get-EnvValue -Text $existingEnvText -Name 'TRUST_PROXY') -ne 'loopback') {
            Fail 'The existing production .env must use TRUST_PROXY=loopback for this Windows setup.'
        }
        $existingDatabaseUrl = Get-EnvValue -Text $existingEnvText -Name 'DATABASE_URL'
        $existingRestoreUrl = Get-EnvValue -Text $existingEnvText -Name 'BACKUP_VERIFY_DATABASE_URL'
        try {
            $databaseUri = New-Object System.Uri($existingDatabaseUrl)
            $restoreUri = New-Object System.Uri($existingRestoreUrl)
        } catch {
            Fail 'The existing production .env database URLs are invalid.'
        }
        $databaseUser = [Uri]::UnescapeDataString($databaseUri.UserInfo.Split(':', 2)[0])
        if ($databaseUri.Scheme -ne 'mysql' -or
            $databaseUri.Host -notin @('127.0.0.1', 'localhost') -or
            $databaseUri.AbsolutePath.Trim('/') -ne 'erp' -or
            $databaseUser -ne 'erp') {
            Fail 'The existing DATABASE_URL must target the local erp database as user erp.'
        }
        if ($restoreUri.Scheme -ne 'mysql' -or
            $restoreUri.Host -ne $databaseUri.Host -or
            $restoreUri.Port -ne $databaseUri.Port -or
            $restoreUri.AbsolutePath.Trim('/') -ne 'erp_restore' -or
            $restoreUri.UserInfo -ne $databaseUri.UserInfo) {
            Fail 'The existing BACKUP_VERIFY_DATABASE_URL must target local erp_restore with the same credentials and port.'
        }
        $existingOrigin = Get-EnvValue -Text $existingEnvText -Name 'CORS_ORIGIN'
        try {
            $originUri = New-Object System.Uri($existingOrigin)
        } catch {
            Fail 'CORS_ORIGIN in the existing production .env is invalid.'
        }
        if ($originUri.Scheme -ne 'https' -or $originUri.AbsoluteUri.TrimEnd('/') -ne $existingOrigin) {
            Fail 'CORS_ORIGIN in the existing production .env must be an exact HTTPS origin.'
        }
        if ($PSBoundParameters.ContainsKey('HostName') -and $HostName.ToLowerInvariant() -ne $originUri.Host) {
            Fail 'The requested HostName differs from CORS_ORIGIN in the existing production .env.'
        }
        $HostName = $originUri.Host
        if ($PSBoundParameters.ContainsKey('HttpsPort') -and $HttpsPort -ne $originUri.Port) {
            Fail 'The requested HttpsPort differs from CORS_ORIGIN in the existing production .env.'
        }
        $HttpsPort = $originUri.Port
        $existingApiPort = Get-EnvValue -Text $existingEnvText -Name 'API_PORT'
        if (-not $existingApiPort) {
            Fail 'Existing production .env is missing API_PORT. Add it manually before rerunning setup.'
        }
        if ($existingApiPort -notmatch '^\d+$' -or [int]$existingApiPort -lt 1 -or [int]$existingApiPort -gt 65535) {
            Fail 'API_PORT in the existing production .env must be between 1 and 65535.'
        }
        if ($PSBoundParameters.ContainsKey('ApiPort') -and $ApiPort -ne [int]$existingApiPort) {
            Fail 'The requested ApiPort differs from API_PORT in the existing production .env.'
        }
        $ApiPort = [int]$existingApiPort
    }
    if (-not $PSBoundParameters.ContainsKey('HostName') -and $installInfo.ContainsKey('HostName')) {
        $HostName = $installInfo.HostName
    }
    $httpsBound = $PSBoundParameters.ContainsKey('HttpsPort')
    $recordedHttpsPort = if ($installInfo.ContainsKey('HttpsPort')) { [int]$installInfo.HttpsPort } else { 0 }
    $requestedHttpsPort = $HttpsPort
    if ($httpsBound) {
        $requestedHttpsPort = [int]$PSBoundParameters['HttpsPort']
    } elseif ($existingEnvText) {
        $requestedHttpsPort = $originUri.Port
        $recordedHttpsPort = $originUri.Port
    }
    $HttpsPort = Resolve-InstallPort -Bound $httpsBound -Requested $requestedHttpsPort -Recorded $recordedHttpsPort -Preferred 443 -Fallbacks @(8443, 8444, 8445)

    $httpBound = $PSBoundParameters.ContainsKey('HttpPort')
    $recordedHttpPort = if ($installInfo.ContainsKey('HttpPort')) { [int]$installInfo.HttpPort } else { 0 }
    $HttpPort = Resolve-InstallPort -Bound $httpBound -Requested $HttpPort -Recorded $recordedHttpPort -Preferred 80 -Fallbacks @(8080, 8081, 8082)
    if (-not $existingEnvText -and -not $PSBoundParameters.ContainsKey('ApiPort') -and $installInfo.ContainsKey('ApiPort')) {
        $ApiPort = [int]$installInfo.ApiPort
    }
    if ($HostName -notmatch '^[a-zA-Z0-9][a-zA-Z0-9.-]*$') {
        Fail "Invalid server host name: $HostName"
    }
    $HostName = $HostName.ToLowerInvariant()
    if ($ExtraAddresses) {
        $addresses = @($ExtraAddresses -split '[,;]' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    } elseif ($installInfo.ContainsKey('ExtraAddresses')) {
        $addresses = @($installInfo.ExtraAddresses -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    } else {
        $addresses = @(Get-PrivateIpv4Addresses)
    }
    foreach ($address in $addresses) {
        if ($address -notmatch '^(\d{1,3}\.){3}\d{1,3}$') {
            Fail "ExtraAddresses must contain IPv4 addresses only: $address"
        }
        foreach ($part in $address.Split('.')) {
            if ([int]$part -gt 255) {
                Fail "ExtraAddresses contains an invalid IPv4 address: $address"
            }
        }
    }
    $apiPortFree = Test-PortFree -Port $ApiPort
    $appTaskExists = Get-ScheduledTask -TaskPath '\ERP Cloud\' -TaskName 'App' -ErrorAction SilentlyContinue
    if (-not $apiPortFree -and (-not $appTaskExists -or $appTaskExists.State -ne 'Running')) {
        Fail "API port $ApiPort is already in use."
    }

    Write-Step 'Creating the separate server clone'
    $sourceRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
    Ensure-AppClone -SourceRoot $sourceRoot -Destination $AppDir

    Write-Step 'Installing Node.js 24 and pnpm'
    $nodeExe = Ensure-Node24
    $pnpmExe = Get-CommandPath @('pnpm.cmd', 'pnpm')
    if (-not $pnpmExe) {
        Fail 'pnpm was not found after enabling Corepack.'
    }

    Write-Step 'Preparing MariaDB 11.8'
    $mariaRoot = Join-Path $env:ProgramFiles 'MariaDB 11.8'
    $mariaBin = Join-Path $mariaRoot 'bin'
    Ensure-MariaDbBinaries -MariaBin $mariaBin
    $requestedDbPort = 0
    if ($existingEnvText) {
        $requestedDbPort = Get-UriPort -DatabaseUrl (Get-EnvValue -Text $existingEnvText -Name 'DATABASE_URL')
    } elseif ($installInfo.ContainsKey('DatabasePort')) {
        $requestedDbPort = [int]$installInfo.DatabasePort
    }
    $database = Ensure-MariaDbInstance -MariaBin $mariaBin -RequestedPort $requestedDbPort
    if ($existingEnvText) {
        $existingClientPath = Get-EnvValue -Text $existingEnvText -Name 'MYSQL_PATH'
        $existingDumpPath = Get-EnvValue -Text $existingEnvText -Name 'MYSQLDUMP_PATH'
        if (-not [string]::Equals([IO.Path]::GetFullPath($existingClientPath), [IO.Path]::GetFullPath($database.ClientPath), [StringComparison]::OrdinalIgnoreCase)) {
            Fail 'MYSQL_PATH in the existing production .env does not match the ERP MariaDB client. Update it manually before rerunning setup.'
        }
        if (-not [string]::Equals([IO.Path]::GetFullPath($existingDumpPath), [IO.Path]::GetFullPath($database.DumpPath), [StringComparison]::OrdinalIgnoreCase)) {
            Fail 'MYSQLDUMP_PATH in the existing production .env does not match the ERP MariaDB dump tool. Update it manually before rerunning setup.'
        }
    }
    $databasePassword = if ($existingEnvText) {
        Get-UriPassword -DatabaseUrl (Get-EnvValue -Text $existingEnvText -Name 'DATABASE_URL')
    } else {
        New-RandomSecret -Kind DatabasePassword
    }
    Set-UpDatabases -MariaClient $database.ClientPath -RootPassword $database.RootPassword -Port $database.Port -DatabasePassword $databasePassword

    if (-not $existingEnvText) {
        Write-Step 'Creating the production environment file'
        $jwt = New-RandomSecret -Kind Jwt
        $invoiceKey = New-RandomSecret -Kind Base64
        $backupKey = New-RandomSecret -Kind Base64
        $origin = "https://$HostName"
        if ($HttpsPort -ne 443) {
            $origin += ":$HttpsPort"
        }
        $databaseUrl = "mysql://erp:$databasePassword@127.0.0.1:$($database.Port)/erp"
        $restoreUrl = "mysql://erp:$databasePassword@127.0.0.1:$($database.Port)/erp_restore"
        $values = @{
            NODE_ENV = 'production'
            DATABASE_URL = $databaseUrl
            CORS_ORIGIN = $origin
            JWT_ACCESS_SECRET = $jwt
            EINVOICE_ENC_KEY = $invoiceKey
            EINVOICE_WORKER = 'off'
            TRUST_PROXY = 'loopback'
            API_PORT = "$ApiPort"
            WEB_DIST_DIR = (Join-Path $AppDir 'apps\web\dist')
            STORAGE_DIR = (Join-Path $DataDir 'storage')
            BACKUP_DIR = (Join-Path $DataDir 'backups')
            ERROR_LOG_FILE = (Join-Path $logsDir 'errors-fallback.log')
            MYSQLDUMP_PATH = $database.DumpPath
            MYSQL_PATH = $database.ClientPath
            BACKUP_VERIFY_DATABASE_URL = $restoreUrl
            BACKUP_ENCRYPTION_KEY = $backupKey
            TENANCY_MODE = 'shared'
        }
        $envText = New-EnvFileText -Values $values
        Write-Utf8NoBom -Path $envPath -Text $envText
    } else {
        $databaseUrl = Get-EnvValue -Text $existingEnvText -Name 'DATABASE_URL'
        $origin = Get-EnvValue -Text $existingEnvText -Name 'CORS_ORIGIN'
    }
    Set-RestrictedAcl -Path $envPath

    $keysPath = Join-Path $secretsDir 'KEYS-SAVE-OFFLINE.txt'
    if (-not (Test-Path -LiteralPath $keysPath)) {
        $finalEnvText = [IO.File]::ReadAllText($envPath)
        $keyLines = @(
            'Copy these values to a password manager and keep this file offline.',
            "DATABASE_URL=$(Get-EnvValue -Text $finalEnvText -Name 'DATABASE_URL')",
            "APP_DATABASE_PASSWORD=$databasePassword",
            "BACKUP_VERIFY_DATABASE_URL=$(Get-EnvValue -Text $finalEnvText -Name 'BACKUP_VERIFY_DATABASE_URL')",
            "JWT_ACCESS_SECRET=$(Get-EnvValue -Text $finalEnvText -Name 'JWT_ACCESS_SECRET')",
            "EINVOICE_ENC_KEY=$(Get-EnvValue -Text $finalEnvText -Name 'EINVOICE_ENC_KEY')",
            "BACKUP_ENCRYPTION_KEY=$(Get-EnvValue -Text $finalEnvText -Name 'BACKUP_ENCRYPTION_KEY')",
            "MARIADB_ROOT_PASSWORD=$($database.RootPassword)"
        )
        Write-Utf8NoBom -Path $keysPath -Text (($keyLines -join "`r`n") + "`r`n")
    }
    Set-RestrictedAcl -Path $keysPath

    Write-Step 'Building and deploying the application'
    if ($appTaskExists) {
        Stop-ErpApp -AppDir $AppDir
    }
    $env:DATABASE_URL = $null
    Invoke-CheckedCommand -FilePath $pnpmExe -Arguments @('install', '--frozen-lockfile', '--prod=false') -WorkingDirectory $AppDir -StepName 'Installing dependencies'
    Invoke-CheckedCommand -FilePath $pnpmExe -Arguments @('--filter', 'api', 'prisma:generate') -WorkingDirectory $AppDir -StepName 'Generating Prisma client'
    Invoke-CheckedCommand -FilePath $pnpmExe -Arguments @('build') -WorkingDirectory $AppDir -StepName 'Building API and web'
    Invoke-CheckedCommand -FilePath $pnpmExe -Arguments @('--filter', 'api', 'exec', 'prisma', 'migrate', 'deploy') -WorkingDirectory $AppDir -StepName 'Applying database migrations'
    Invoke-CheckedCommand -FilePath $pnpmExe -Arguments @('--filter', 'api', 'exec', 'prisma', 'db', 'seed') -WorkingDirectory $AppDir -StepName 'Seeding the database'

    $caddyDir = Join-Path $DataDir 'bin'
    $caddyPath = Join-Path $caddyDir 'caddy.exe'
    $caddyTaskExists = Get-ScheduledTask -TaskPath '\ERP Cloud\' -TaskName 'Caddy' -ErrorAction SilentlyContinue
    if ($caddyTaskExists) {
        Stop-ErpCaddy -DataDir $DataDir
    }
    $installCaddy = $true
    if (Test-Path -LiteralPath $caddyPath) {
        $caddyResult = Invoke-LoggedProcess -FilePath $caddyPath -ArgumentLine 'version' -WorkingDirectory $caddyDir
        $caddyVersion = @($caddyResult.StdoutLines | Select-Object -First 1)
        if ($caddyResult.ExitCode -eq 0 -and "$caddyVersion" -match '^v?2\.11\.9\b') {
            $installCaddy = $false
        }
    }
    if ($installCaddy) {
        Write-Step 'Resolving and installing pinned Caddy 2.11.9'
        $caddy = Get-CaddyMetadata
        $archive = Join-Path $downloadsDir $caddy.FileName
        Save-VerifiedDownload -Uri $caddy.Url -Hash $caddy.Hash -Destination $archive -HashAlgorithm $caddy.HashAlgorithm | Out-Null
        $extractDir = Join-Path $downloadsDir 'caddy-extract'
        Remove-Item -LiteralPath $extractDir -Recurse -Force -ErrorAction SilentlyContinue
        Expand-Archive -LiteralPath $archive -DestinationPath $extractDir -Force
        $extracted = Get-ChildItem -LiteralPath $extractDir -Filter 'caddy.exe' -Recurse | Select-Object -First 1
        if (-not $extracted) {
            Fail 'Caddy archive did not contain caddy.exe.'
        }
        New-Item -ItemType Directory -Path $caddyDir -Force | Out-Null
        Copy-Item -LiteralPath $extracted.FullName -Destination $caddyPath -Force
        Remove-Item -LiteralPath $extractDir -Recurse -Force -ErrorAction SilentlyContinue
    }
    $caddyConfigDir = Join-Path $DataDir 'caddy'
    $caddyPublic = Join-Path $caddyConfigDir 'public'
    $caddyFile = Join-Path $caddyConfigDir 'Caddyfile'
    New-Item -ItemType Directory -Path $caddyPublic -Force | Out-Null
    $caddyText = New-CaddyfileText -HostName $HostName -ExtraAddresses $addresses -HttpsPort $HttpsPort -HttpPort $HttpPort -ApiPort $ApiPort -DataDir $DataDir
    Write-Utf8NoBom -Path $caddyFile -Text $caddyText

    $powershellExe = Join-Path $PSHOME 'powershell.exe'
    $supervisor = Join-Path $AppDir 'setup\windows\run-supervised.ps1'
    $nodeScript = Join-Path $AppDir 'apps\api\dist\main.js'
    $nodeArgumentLine = '--max-old-space-size=512 ' + (ConvertTo-WindowsArgument $nodeScript)
    $appArguments = @(
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $supervisor,
        '-Executable', $nodeExe,
        '-ArgumentLine', $nodeArgumentLine,
        '-WorkingDirectory', (Join-Path $AppDir 'apps\api'),
        '-LogPath', (Join-Path $logsDir 'app.log')
    )
    $caddyArgumentLine = 'run --config ' + (ConvertTo-WindowsArgument $caddyFile)
    $caddyArguments = @(
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $supervisor,
        '-Executable', $caddyPath,
        '-ArgumentLine', $caddyArgumentLine,
        '-WorkingDirectory', $caddyConfigDir,
        '-LogPath', (Join-Path $logsDir 'caddy.log')
    )
    Register-ErpScheduledTask -Name 'App' -Command $powershellExe -Arguments (($appArguments | ForEach-Object { ConvertTo-WindowsArgument "$_" }) -join ' ') -WorkingDirectory $AppDir -TriggerXml (New-TaskStartupTriggerXml) -ExecutionTimeLimit 'PT0S' -Description 'ERP Cloud API and built web application'
    Register-ErpScheduledTask -Name 'Caddy' -Command $powershellExe -Arguments (($caddyArguments | ForEach-Object { ConvertTo-WindowsArgument "$_" }) -join ' ') -WorkingDirectory $DataDir -TriggerXml (New-TaskStartupTriggerXml) -ExecutionTimeLimit 'PT0S' -Description 'ERP Cloud internal HTTPS proxy'

    $jobScript = Join-Path $AppDir 'setup\windows\run-job.ps1'
    $jobSpecs = @(
        @{ Name = 'tenant-status'; Time = '00:30'; Trigger = 'daily'; Args = @() },
        @{ Name = 'einvoice-send'; Time = '00:00'; Trigger = 'minute'; Args = @() },
        @{ Name = 'backup'; Time = '02:15'; Trigger = 'daily'; Args = @() },
        @{ Name = 'error-digest'; Time = '00:05'; Trigger = 'hourly'; Args = @() },
        @{ Name = 'stock-verify'; Time = '03:15'; Trigger = 'daily'; Args = @() },
        @{ Name = 'purge-expired'; Time = '03:45'; Trigger = 'daily'; Args = @() },
        @{ Name = 'integrity-check'; Time = '04:30'; Trigger = 'monthly-1'; Args = @() },
        @{ Name = 'backup-verify'; Time = '05:00'; Trigger = 'monthly-2'; Args = @('latest') }
    )
    foreach ($spec in $jobSpecs) {
        if ($spec.Trigger -eq 'daily') {
            $trigger = New-TaskDailyTriggerXml -Time $spec.Time
        } elseif ($spec.Trigger -eq 'hourly') {
            $trigger = New-TaskRepeatedDailyTriggerXml -Time '00:05' -Interval 'PT1H'
        } elseif ($spec.Trigger -eq 'minute') {
            $trigger = New-TaskRepeatedDailyTriggerXml -Time '00:00' -Interval 'PT1M'
        } elseif ($spec.Trigger -eq 'monthly-1') {
            $trigger = New-TaskMonthlyTriggerXml -Day 1 -Time $spec.Time
        } else {
            $trigger = New-TaskMonthlyTriggerXml -Day 2 -Time $spec.Time
        }
        $jobArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $jobScript, '-Job', $spec.Name, '-AppDir', $AppDir, '-DataDir', $DataDir, '-NodeExe', $nodeExe)
        if ($spec.Args.Count -gt 0) {
            $jobArgs += '-JobArguments'
            $jobArgs += $spec.Args
        }
        $executionTimeLimit = 'PT1H'
        if ($spec.Name -eq 'einvoice-send') {
            $executionTimeLimit = 'PT15M'
        } elseif ($spec.Name -in @('backup', 'backup-verify', 'integrity-check')) {
            $executionTimeLimit = 'PT4H'
        }
        Register-ErpScheduledTask -Name "Job-$($spec.Name)" -Command $powershellExe -Arguments (($jobArgs | ForEach-Object { ConvertTo-WindowsArgument "$_" }) -join ' ') -WorkingDirectory (Join-Path $AppDir 'apps\api') -TriggerXml $trigger -ExecutionTimeLimit $executionTimeLimit -Description "ERP Cloud $($spec.Name) job"
    }

    Write-Step 'Opening private/domain firewall ports'
    foreach ($ruleName in @('ERP Cloud HTTPS', 'ERP Cloud HTTP')) {
        Remove-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
    }
    New-NetFirewallRule -DisplayName 'ERP Cloud HTTPS' -Direction Inbound -Action Allow -Protocol TCP -LocalPort $HttpsPort -Profile Private,Domain | Out-Null
    New-NetFirewallRule -DisplayName 'ERP Cloud HTTP' -Direction Inbound -Action Allow -Protocol TCP -LocalPort $HttpPort -Profile Private,Domain | Out-Null
    if (Get-NetConnectionProfile -ErrorAction SilentlyContinue | Where-Object { $_.NetworkCategory -eq 'Public' }) {
        Write-Warning 'The active network profile is Public. Windows Firewall rules are limited to Private and Domain networks; change the LAN profile before client access.'
    }

    Write-Step 'Starting the API and Caddy tasks'
    Start-ErpTask -Name 'App'
    Start-ErpTask -Name 'Caddy'
    $url = "https://$HostName"
    if ($HttpsPort -ne 443) {
        $url += ":$HttpsPort"
    }
    $rootCa = Join-Path $DataDir 'caddy\data\pki\authorities\local\root.crt'
    $caDeadline = (Get-Date).AddMinutes(2)
    while (-not (Test-Path -LiteralPath $rootCa) -and (Get-Date) -lt $caDeadline) {
        Start-Sleep -Seconds 2
    }
    if (-not (Test-Path -LiteralPath $rootCa)) {
        Fail "Caddy did not create its internal root CA at $rootCa. Check $($logsDir)\caddy.log."
    }
    $publicCa = Join-Path $caddyPublic 'erp-ca.crt'
    Copy-Item -LiteralPath $rootCa -Destination $publicCa -Force
    $certificate = Get-X509CertificateFromPem -Path $publicCa
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $fingerprint = [BitConverter]::ToString($sha.ComputeHash($certificate.RawData)).Replace('-', '')
    } finally {
        $sha.Dispose()
    }
    $store = Get-ChildItem Cert:\LocalMachine\Root | Where-Object { $_.Thumbprint -eq $certificate.Thumbprint } | Select-Object -First 1
    if (-not $store) {
        $certificateDer = Join-Path $env:TEMP ("erp-ca-" + [guid]::NewGuid().ToString('N') + '.cer')
        try {
            [IO.File]::WriteAllBytes($certificateDer, $certificate.RawData)
            Import-Certificate -FilePath $certificateDer -CertStoreLocation 'Cert:\LocalMachine\Root' | Out-Null
        } finally {
            Remove-Item -LiteralPath $certificateDer -Force -ErrorAction SilentlyContinue
        }
    }

    $caUrl = "http://$HostName"
    if ($HttpPort -ne 80) {
        $caUrl += ":$HttpPort"
    }
    $infoLines = @(
        "AppDir=$AppDir",
        "DataDir=$DataDir",
        "HostName=$HostName",
        "HttpsPort=$HttpsPort",
        "HttpPort=$HttpPort",
        "ApiPort=$ApiPort",
        "DatabasePort=$($database.Port)",
        "ExtraAddresses=$($addresses -join ',')",
        "URL=$url",
        "CA_URL=$caUrl/erp-ca.crt",
        "CA_SHA256=$fingerprint"
    )
    Write-Utf8NoBom -Path $installInfoPath -Text (($infoLines -join "`r`n") + "`r`n")

    Write-Step 'Waiting for the production health endpoint'
    $healthUrl = "$url/api/v1/health"
    $healthDeadline = (Get-Date).AddMinutes(3)
    $healthy = $false
    while ((Get-Date) -lt $healthDeadline) {
        try {
            $response = Invoke-WebRequest -Uri $healthUrl -UseBasicParsing -TimeoutSec 10
            if ($response.StatusCode -eq 200) {
                $healthy = $true
                break
            }
        } catch {
        }
        Start-Sleep -Seconds 5
    }
    if (-not $healthy) {
        Fail "Health check did not return HTTP 200 within three minutes: $healthUrl. Check app.log and caddy.log."
    }
    $preflight = Invoke-LoggedProcess -FilePath $nodeExe -ArgumentLine 'dist/jobs/cli.js preflight' -WorkingDirectory (Join-Path $AppDir 'apps\api') -EchoToHost
    $preflightCode = $preflight.ExitCode
    if ($preflightCode -ne 0) {
        Fail "Preflight failed with exit code $preflightCode. Review its output above."
    }
    Invoke-JobNow -Job 'backup'
    Invoke-JobNow -Job 'backup-verify' -JobArguments @('latest')

    $shortcut = Join-Path ([Environment]::GetFolderPath('CommonDesktopDirectory')) 'ERP Cloud.url'
    Write-Utf8NoBom -Path $shortcut -Text "[InternetShortcut]`r`nURL=$url`r`n"
    Write-Step 'Installation complete'
    Write-Host "URL: $url"
    Write-Host "Other PCs: run setup\windows\trust-client.bat -Server $HostName"
    Write-Host 'Register the owner account in the browser, then run setup\windows\grant-admin.bat <email>.'
    Write-Host "Offline key record: $keysPath"
    Write-Host "Copy KEYS-SAVE-OFFLINE.txt to a password manager, then keep backups off this PC."
    Write-Host "Install record: $installInfoPath"
    Write-Host "CA SHA-256: $fingerprint"
} catch {
    Write-Host "$($_.Exception.Message)" -ForegroundColor Red
    throw
}
} finally {
    if ($PauseAtEnd) {
        Read-Host 'Press Enter to close' | Out-Null
    }
}
