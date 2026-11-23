[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$script:ErpTaskPath = '\ERP Cloud\'
$script:Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Write-Step {
    param([Parameter(Mandatory = $true)][string]$Message)
    Write-Host "`n==> $Message" -ForegroundColor Cyan
}

function Fail {
    param([Parameter(Mandatory = $true)][string]$Message)
    Write-Error $Message
    throw $Message
}

function Test-IsAdministrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function ConvertTo-WindowsArgument {
    param([AllowEmptyString()][string]$Value)
    $builder = New-Object System.Text.StringBuilder
    [void]$builder.Append('"')
    $slashes = 0
    foreach ($character in $Value.ToCharArray()) {
        if ($character -eq '\') {
            $slashes++
        } elseif ($character -eq '"') {
            [void]$builder.Append(('\' * (($slashes * 2) + 1)))
            [void]$builder.Append('"')
            $slashes = 0
        } else {
            if ($slashes -gt 0) {
                [void]$builder.Append(('\' * $slashes))
                $slashes = 0
            }
            [void]$builder.Append($character)
        }
    }
    if ($slashes -gt 0) {
        [void]$builder.Append(('\' * ($slashes * 2)))
    }
    [void]$builder.Append('"')
    return $builder.ToString()
}

function Ensure-Administrator {
    param(
        [Parameter(Mandatory = $true)][string]$ScriptPath,
        [hashtable]$Parameters = @{}
    )
    if (Test-IsAdministrator) {
        return
    }
    $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $ScriptPath)
    foreach ($key in $Parameters.Keys) {
        $value = $Parameters[$key]
        if ($value -is [bool] -or $value -is [System.Management.Automation.SwitchParameter]) {
            if ($value) {
                $arguments += "-$key"
            }
        } elseif ($null -ne $value -and "$value" -ne '') {
            $arguments += "-$key"
            $arguments += "$value"
        }
    }
    $quoted = @($arguments | ForEach-Object { ConvertTo-WindowsArgument "$_" })
    $process = Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList ($quoted -join ' ') -PassThru
    $process.WaitForExit()
    exit $process.ExitCode
}

function Test-PortFree {
    param([Parameter(Mandatory = $true)][ValidateRange(1, 65535)][int]$Port)
    $addresses = @([System.Net.IPAddress]::Any)
    if ([System.Net.Sockets.Socket]::OSSupportsIPv6) {
        $addresses += [System.Net.IPAddress]::IPv6Any
    }
    foreach ($address in $addresses) {
        $listener = New-Object System.Net.Sockets.TcpListener($address, $Port)
        try {
            $listener.Start()
        } catch {
            return $false
        } finally {
            try {
                $listener.Stop()
            } catch {
            }
        }
    }
    return $true
}

function Get-PreferredPort {
    param(
        [Parameter(Mandatory = $true)][int]$PreferredPort,
        [Parameter(Mandatory = $true)][int[]]$FallbackPorts,
        [scriptblock]$PortTest = { param($candidate) Test-PortFree -Port $candidate }
    )
    if (& $PortTest $PreferredPort) {
        return $PreferredPort
    }
    foreach ($candidate in $FallbackPorts) {
        if (& $PortTest $candidate) {
            return $candidate
        }
    }
    Fail "No available port found after preferred port $PreferredPort."
}

function New-RandomSecret {
    param(
        [Parameter(Mandatory = $true)]
        [ValidateSet('Jwt', 'Base64', 'DatabasePassword')]
        [string]$Kind
    )
    if ($Kind -eq 'Jwt') {
        $bytes = New-Object byte[] 48
    } elseif ($Kind -eq 'Base64') {
        $bytes = New-Object byte[] 32
    } else {
        $bytes = New-Object byte[] 16
    }
    $generator = New-Object System.Security.Cryptography.RNGCryptoServiceProvider
    try {
        $generator.GetBytes($bytes)
    } finally {
        $generator.Dispose()
    }
    if ($Kind -eq 'DatabasePassword') {
        return [BitConverter]::ToString($bytes).Replace('-', '').ToLowerInvariant()
    }
    $value = [Convert]::ToBase64String($bytes)
    if ($Kind -eq 'Jwt') {
        return $value.TrimEnd('=').Replace('+', '-').Replace('/', '_')
    }
    return $value
}

function Write-Utf8NoBom {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Text
    )
    $parent = Split-Path -Parent $Path
    if ($parent -and -not (Test-Path -LiteralPath $parent)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }
    [IO.File]::WriteAllText($Path, $Text, $script:Utf8NoBom)
}

function Get-X509CertificateFromPem {
    param([Parameter(Mandatory = $true)][string]$Path)
    $text = [IO.File]::ReadAllText($Path)
    $match = [regex]::Match($text, '-----BEGIN CERTIFICATE-----(?<data>[\s\S]+?)-----END CERTIFICATE-----')
    if ($match.Success) {
        $base64 = $match.Groups['data'].Value -replace '\s', ''
        $bytes = [Convert]::FromBase64String($base64)
        return New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 -ArgumentList (,$bytes)
    }
    return New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($Path)
}

function Get-EnvValue {
    param(
        [Parameter(Mandatory = $true)][string]$Text,
        [Parameter(Mandatory = $true)][string]$Name
    )
    foreach ($line in ($Text -split "`r?`n")) {
        if ($line -match "^\s*$([regex]::Escape($Name))\s*=\s*(.*?)\s*$") {
            $value = $Matches[1]
            if ($value.Length -ge 2 -and (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'")))) {
                $value = $value.Substring(1, $value.Length - 2)
            }
            return $value
        }
    }
    return $null
}

function New-EnvFileText {
    param([Parameter(Mandatory = $true)][hashtable]$Values)
    $required = @(
        'NODE_ENV', 'DATABASE_URL', 'CORS_ORIGIN', 'JWT_ACCESS_SECRET',
        'EINVOICE_ENC_KEY', 'EINVOICE_WORKER', 'TRUST_PROXY', 'API_PORT',
        'WEB_DIST_DIR', 'STORAGE_DIR', 'BACKUP_DIR', 'ERROR_LOG_FILE',
        'MYSQLDUMP_PATH', 'MYSQL_PATH', 'BACKUP_VERIFY_DATABASE_URL',
        'BACKUP_ENCRYPTION_KEY', 'TENANCY_MODE'
    )
    foreach ($name in $required) {
        if (-not $Values.ContainsKey($name) -or $null -eq $Values[$name]) {
            throw "Missing required environment value: $name"
        }
    }
    $lines = New-Object System.Collections.Generic.List[string]
    foreach ($name in $required) {
        $value = [string]$Values[$name]
        if ($value -match '[\r\n]') {
            throw "Environment value contains a newline: $name"
        }
        $escaped = $value.Replace('\', '/').Replace('"', '\"')
        $lines.Add("$name=`"$escaped`"")
    }
    return ($lines -join "`r`n") + "`r`n"
}

function ConvertTo-CaddyPath {
    param([Parameter(Mandatory = $true)][string]$Path)
    $value = $Path.Replace('\', '/')
    if ($value -match '[\s#{}"]') {
        return '"' + $value.Replace('"', '\"') + '"'
    }
    return $value
}

function New-CaddyfileText {
    param(
        [Parameter(Mandatory = $true)][string]$HostName,
        [string[]]$ExtraAddresses = @(),
        [Parameter(Mandatory = $true)][int]$HttpsPort,
        [Parameter(Mandatory = $true)][int]$HttpPort,
        [Parameter(Mandatory = $true)][int]$ApiPort,
        [Parameter(Mandatory = $true)][string]$DataDir
    )
    $names = @($HostName) + @($ExtraAddresses)
    $names = @($names | ForEach-Object { "$_".Trim().ToLowerInvariant() } | Where-Object { $_ } | Select-Object -Unique)
    if ($names.Count -eq 0) {
        throw 'At least one Caddy site address is required.'
    }
    $httpsSites = @($names | ForEach-Object {
        if ($HttpsPort -eq 443) { "https://$_" } else { "https://$_`:$HttpsPort" }
    })
    $dataRoot = $DataDir.TrimEnd([char[]]@('\', '/'))
    if (-not $dataRoot) {
        $dataRoot = $DataDir
    }
    $storage = ConvertTo-CaddyPath ($dataRoot + '\caddy\data')
    $public = ConvertTo-CaddyPath ($dataRoot + '\caddy\public')
    $httpLines = New-Object System.Collections.Generic.List[string]
    foreach ($name in $names) {
        $site = if ($HttpPort -eq 80) { "http://$name" } else { "http://$name`:$HttpPort" }
        $target = if ($HttpsPort -eq 443) { "https://$name{uri}" } else { "https://$name`:$HttpsPort{uri}" }
        $httpLines.Add("$site {")
        $httpLines.Add('    handle /erp-ca.crt {')
        $httpLines.Add("        root * $public")
        $httpLines.Add('        file_server')
        $httpLines.Add('    }')
        $httpLines.Add('    handle {')
        $httpLines.Add("        redir $target 308")
        $httpLines.Add('    }')
        $httpLines.Add('}')
        $httpLines.Add('')
    }
    $httpText = $httpLines -join "`r`n"
    $lines = @(
        '{',
        '    local_certs',
        '    skip_install_trust',
        "    storage file_system $storage",
        '}',
        '',
        ($httpsSites -join ', '),
        '{',
        '    tls internal',
        "    reverse_proxy 127.0.0.1:$ApiPort",
        '}',
        '',
        $httpText,
        ''
    )
    return $lines -join "`r`n"
}

function Invoke-WebRequestContent {
    param([Parameter(Mandatory = $true)][string]$Uri)
    $response = Invoke-WebRequest -Uri $Uri -UseBasicParsing -Headers @{ 'User-Agent' = 'ERP-Cloud-Windows-Setup' }
    if ($response.Content -is [byte[]]) {
        return [Text.Encoding]::UTF8.GetString($response.Content)
    }
    return [string]$response.Content
}

function Get-Node24Metadata {
    $indexUrl = 'https://nodejs.org/dist/index.json'
    $index = Invoke-WebRequestContent -Uri $indexUrl | ConvertFrom-Json
    $release = @($index | Where-Object { $_.version -match '^v24\.' } | Select-Object -First 1)
    if ($release.Count -eq 0) {
        throw 'Node.js 24 release metadata was not found.'
    }
    $version = $release[0].version
    $base = "https://nodejs.org/dist/$version"
    $fileName = "node-$version-x64.msi"
    $checksumUrl = "$base/SHASUMS256.txt"
    $checksums = Invoke-WebRequestContent -Uri $checksumUrl
    $pattern = "(?m)^([0-9a-fA-F]{64})\s+\*?$([regex]::Escape($fileName))\s*$"
    $match = [regex]::Match($checksums, $pattern)
    if (-not $match.Success) {
        throw "No SHA-256 checksum found for $fileName."
    }
    return [pscustomobject]@{
        Version = $version
        FileName = $fileName
        Url = "$base/$fileName"
        ChecksumUrl = $checksumUrl
        Hash = $match.Groups[1].Value.ToLowerInvariant()
        HashAlgorithm = 'SHA256'
    }
}

function Get-MariaDB118Metadata {
    $json = Invoke-WebRequestContent -Uri 'https://downloads.mariadb.org/rest-api/mariadb/11.8/' | ConvertFrom-Json
    $releases = @($json.releases.PSObject.Properties)
    if ($releases.Count -eq 0) {
        throw 'MariaDB 11.8 release metadata did not contain releases.'
    }
    $release = $releases[0].Value
    $file = @($release.files | Where-Object { $_.file_name -match '-winx64\.msi$' } | Select-Object -First 1)
    if ($file.Count -eq 0 -or -not $file[0].checksum.sha256sum) {
        throw 'The first MariaDB 11.8 release did not include a checksummed x64 MSI.'
    }
    return [pscustomobject]@{
        Version = $releases[0].Name
        FileName = $file[0].file_name
        Url = $file[0].file_download_url -replace '^http:', 'https:'
        ChecksumUrl = $file[0].checksum_url -replace '^http:', 'https:'
        Hash = $file[0].checksum.sha256sum.ToLowerInvariant()
        HashAlgorithm = 'SHA256'
    }
}

function Get-CaddyMetadata {
    $version = '2.11.9'
    $fileName = "caddy_${version}_windows_amd64.zip"
    $releaseUrl = "https://github.com/caddyserver/caddy/releases/download/v$version"
    $checksumsName = "caddy_${version}_checksums.txt"
    $checksumUrl = "$releaseUrl/$checksumsName"
    $checksums = Invoke-WebRequestContent -Uri $checksumUrl
    $pattern = "(?m)^([0-9a-fA-F]{128})\s+\*?$([regex]::Escape($fileName))\s*$"
    $match = [regex]::Match($checksums, $pattern)
    if (-not $match.Success) {
        throw "No SHA-512 checksum found for $fileName in $checksumsName."
    }
    return [pscustomobject]@{
        Version = $version
        FileName = $fileName
        Url = "$releaseUrl/$fileName"
        ChecksumUrl = $checksumUrl
        Hash = $match.Groups[1].Value.ToLowerInvariant()
        HashAlgorithm = 'SHA512'
    }
}

function Save-VerifiedDownload {
    param(
        [Parameter(Mandatory = $true)][string]$Uri,
        [Parameter(Mandatory = $true)][string]$Hash,
        [Parameter(Mandatory = $true)][string]$Destination,
        [ValidateSet('SHA256', 'SHA512')][string]$HashAlgorithm = 'SHA256'
    )
    $expectedLength = if ($HashAlgorithm -eq 'SHA512') { 128 } else { 64 }
    if ($Hash.Length -ne $expectedLength -or $Hash -notmatch '^[0-9a-fA-F]+$') {
        throw "Invalid $HashAlgorithm value for download: $Uri"
    }
    $parent = Split-Path -Parent $Destination
    if ($parent -and -not (Test-Path -LiteralPath $parent)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }
    Invoke-WebRequest -Uri $Uri -UseBasicParsing -OutFile $Destination -Headers @{ 'User-Agent' = 'ERP-Cloud-Windows-Setup' }
    $actual = (Get-FileHash -LiteralPath $Destination -Algorithm $HashAlgorithm).Hash.ToLowerInvariant()
    if ($actual -ne $Hash.ToLowerInvariant()) {
        Remove-Item -LiteralPath $Destination -Force -ErrorAction SilentlyContinue
        throw "$HashAlgorithm verification failed for $Uri."
    }
    return $Destination
}

function Update-ProcessPath {
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = @($machine, $user | Where-Object { $_ }) -join ';'
}

function Set-RestrictedAcl {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) {
        throw "Cannot protect a missing path: $Path"
    }
    & icacls.exe $Path /inheritance:r /grant:r '*S-1-5-32-544:F' '*S-1-5-18:F' | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "icacls failed to restrict access to $Path."
    }
}

function Rotate-LogFile {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [long]$MaximumBytes = 10485760
    )
    if (Test-Path -LiteralPath $Path) {
        if ((Get-Item -LiteralPath $Path).Length -ge $MaximumBytes) {
            $previous = "$Path.1"
            Remove-Item -LiteralPath $previous -Force -ErrorAction SilentlyContinue
            Move-Item -LiteralPath $Path -Destination $previous -Force
        }
    }
}

function Add-LogLine {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Line
    )
    $parent = Split-Path -Parent $Path
    if ($parent -and -not (Test-Path -LiteralPath $parent)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }
    Rotate-LogFile -Path $Path
    [IO.File]::AppendAllText($Path, $Line + [Environment]::NewLine, $script:Utf8NoBom)
}

function Get-TaskXmlEscape {
    param([AllowEmptyString()][string]$Value)
    return [Security.SecurityElement]::Escape($Value)
}

function Ensure-ErpTaskFolder {
    $service = New-Object -ComObject Schedule.Service
    $service.Connect()
    try {
        $service.GetFolder('\ERP Cloud') | Out-Null
    } catch {
        $root = $service.GetFolder('\')
        $root.CreateFolder('ERP Cloud', $null) | Out-Null
    }
}

function Register-ErpScheduledTask {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$Command,
        [Parameter(Mandatory = $true)][string]$Arguments,
        [Parameter(Mandatory = $true)][string]$WorkingDirectory,
        [Parameter(Mandatory = $true)][string]$TriggerXml,
        [string]$Description = 'ERP Cloud scheduled task'
    )
    Ensure-ErpTaskFolder
    $commandXml = Get-TaskXmlEscape $Command
    $argumentsXml = Get-TaskXmlEscape $Arguments
    $directoryXml = Get-TaskXmlEscape $WorkingDirectory
    $descriptionXml = Get-TaskXmlEscape $Description
    $xml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>$descriptionXml</Description></RegistrationInfo>
  <Triggers>$TriggerXml</Triggers>
  <Principals><Principal id="Author"><UserId>S-1-5-18</UserId><LogonType>ServiceAccount</LogonType><RunLevel>HighestAvailable</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <Enabled>true</Enabled>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author"><Exec><Command>$commandXml</Command><Arguments>$argumentsXml</Arguments><WorkingDirectory>$directoryXml</WorkingDirectory></Exec></Actions>
</Task>
"@
    Register-ScheduledTask -TaskPath $script:ErpTaskPath -TaskName $Name -Xml $xml -Force | Out-Null
}

function New-TaskStartupTriggerXml {
    return '<BootTrigger><Enabled>true</Enabled><Delay>PT15S</Delay></BootTrigger>'
}

function New-TaskDailyTriggerXml {
    param([Parameter(Mandatory = $true)][string]$Time)
    $date = Get-Date -Format 'yyyy-MM-dd'
    return "<CalendarTrigger><StartBoundary>${date}T${Time}:00</StartBoundary><Enabled>true</Enabled><ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay></CalendarTrigger>"
}

function New-TaskRepeatedDailyTriggerXml {
    param(
        [Parameter(Mandatory = $true)][string]$Time,
        [Parameter(Mandatory = $true)][string]$Interval
    )
    $date = Get-Date -Format 'yyyy-MM-dd'
    return "<CalendarTrigger><Repetition><Interval>$Interval</Interval><Duration>P1D</Duration><StopAtDurationEnd>false</StopAtDurationEnd></Repetition><StartBoundary>${date}T${Time}:00</StartBoundary><Enabled>true</Enabled><ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay></CalendarTrigger>"
}

function New-TaskMonthlyTriggerXml {
    param(
        [Parameter(Mandatory = $true)][ValidateRange(1, 31)][int]$Day,
        [Parameter(Mandatory = $true)][string]$Time
    )
    $now = Get-Date
    $boundary = Get-Date -Year $now.Year -Month $now.Month -Day $Day -Hour ([int]$Time.Substring(0, 2)) -Minute ([int]$Time.Substring(3, 2)) -Second 0
    if ($boundary -lt $now) {
        $month = $now.AddMonths(1)
        $boundary = Get-Date -Year $month.Year -Month $month.Month -Day $Day -Hour ([int]$Time.Substring(0, 2)) -Minute ([int]$Time.Substring(3, 2)) -Second 0
    }
    $months = '<January/><February/><March/><April/><May/><June/><July/><August/><September/><October/><November/><December/>'
    $start = $boundary.ToString("yyyy-MM-dd'T'HH:mm:ss")
    return "<CalendarTrigger><StartBoundary>$start</StartBoundary><Enabled>true</Enabled><ScheduleByMonth><DaysOfMonth><Day>$Day</Day></DaysOfMonth><Months>$months</Months></ScheduleByMonth></CalendarTrigger>"
}

function Start-ErpTask {
    param([Parameter(Mandatory = $true)][string]$Name)
    Start-ScheduledTask -TaskPath $script:ErpTaskPath -TaskName $Name
}

function Stop-ErpTask {
    param([Parameter(Mandatory = $true)][string]$Name)
    try {
        Stop-ScheduledTask -TaskPath $script:ErpTaskPath -TaskName $Name -ErrorAction Stop
    } catch {
    }
}

function Set-ErpJobTasksEnabled {
    param([Parameter(Mandatory = $true)][bool]$Enabled)
    $tasks = Get-ScheduledTask -TaskPath $script:ErpTaskPath -ErrorAction SilentlyContinue |
        Where-Object { $_.TaskName -like 'Job-*' }
    foreach ($task in $tasks) {
        if ($Enabled) {
            Enable-ScheduledTask -TaskPath $script:ErpTaskPath -TaskName $task.TaskName | Out-Null
        } else {
            Disable-ScheduledTask -TaskPath $script:ErpTaskPath -TaskName $task.TaskName | Out-Null
            Stop-ErpTask -Name $task.TaskName
        }
    }
}

function Stop-ErpApp {
    param(
        [Parameter(Mandatory = $true)][string]$AppDir,
        [string]$TaskName = 'App'
    )
    Stop-ErpTask -Name $TaskName
    Start-Sleep -Seconds 2
    $root = [IO.Path]::GetFullPath($AppDir).TrimEnd('\')
    $processes = Get-CimInstance -ClassName Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue
    foreach ($process in $processes) {
        $commandLine = [string]$process.CommandLine
        if ($commandLine -and
            $commandLine.IndexOf($root, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
            $commandLine -match 'dist[\\/]+main\.js') {
            Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
        }
    }
}

function Stop-ErpCaddy {
    param(
        [Parameter(Mandatory = $true)][string]$DataDir,
        [string]$TaskName = 'Caddy'
    )
    Stop-ErpTask -Name $TaskName
    Start-Sleep -Seconds 2
    $config = [IO.Path]::GetFullPath((Join-Path $DataDir 'caddy\Caddyfile'))
    $processes = Get-CimInstance -ClassName Win32_Process -Filter "Name='caddy.exe'" -ErrorAction SilentlyContinue
    foreach ($process in $processes) {
        $commandLine = [string]$process.CommandLine
        if ($commandLine -and $commandLine.IndexOf($config, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
            Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
        }
    }
}
