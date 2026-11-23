BeforeAll {
    . (Join-Path $PSScriptRoot '..\lib\common.ps1')

    $script:RequiredEnvironmentNames = @(
        'NODE_ENV', 'DATABASE_URL', 'CORS_ORIGIN', 'JWT_ACCESS_SECRET',
        'EINVOICE_ENC_KEY', 'EINVOICE_WORKER', 'TRUST_PROXY', 'API_PORT',
        'WEB_DIST_DIR', 'STORAGE_DIR', 'BACKUP_DIR', 'ERROR_LOG_FILE',
        'MYSQLDUMP_PATH', 'MYSQL_PATH', 'BACKUP_VERIFY_DATABASE_URL',
        'BACKUP_ENCRYPTION_KEY', 'TENANCY_MODE'
    )
    $script:TestEnvironment = @{
        NODE_ENV = 'production'
        DATABASE_URL = 'mysql://erp:0123456789abcdef0123456789abcdef@127.0.0.1:3307/erp'
        CORS_ORIGIN = 'https://erp-server'
        JWT_ACCESS_SECRET = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-_'
        EINVOICE_ENC_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='
        EINVOICE_WORKER = 'off'
        TRUST_PROXY = 'loopback'
        API_PORT = '3101'
        WEB_DIST_DIR = 'C:\ERP\app\apps\web\dist'
        STORAGE_DIR = 'C:\ERPData\storage'
        BACKUP_DIR = 'C:\ERPData\backups'
        ERROR_LOG_FILE = 'C:\ERPData\logs\errors-fallback.log'
        MYSQLDUMP_PATH = 'C:\Program Files\MariaDB 11.8\bin\mariadb-dump.exe'
        MYSQL_PATH = 'C:\Program Files\MariaDB 11.8\bin\mariadb.exe'
        BACKUP_VERIFY_DATABASE_URL = 'mysql://erp:0123456789abcdef0123456789abcdef@127.0.0.1:3307/erp_restore'
        BACKUP_ENCRYPTION_KEY = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB='
        TENANCY_MODE = 'shared'
    }
}

Describe 'New-EnvFileText' {
    It 'writes every required production key' {
        $text = New-EnvFileText -Values $script:TestEnvironment
        foreach ($name in $script:RequiredEnvironmentNames) {
            $text | Should -Match "(?m)^$name="
        }
    }

    It 'writes UTF-8 without a BOM' {
        $text = New-EnvFileText -Values $script:TestEnvironment
        $path = Join-Path $TestDrive 'production.env'
        Write-Utf8NoBom -Path $path -Text $text
        $bytes = [IO.File]::ReadAllBytes($path)
        [BitConverter]::ToString($bytes[0..2]) | Should -Not -Be 'EF-BB-BF'
    }

    It 'preserves a default HTTPS origin without an explicit port' {
        $values = @{} + $script:TestEnvironment
        $values.CORS_ORIGIN = 'https://erp-server'
        New-EnvFileText -Values $values | Should -Match '(?m)^CORS_ORIGIN="https://erp-server"\r?$'
    }

    It 'preserves a non-default HTTPS port' {
        $values = @{} + $script:TestEnvironment
        $values.CORS_ORIGIN = 'https://erp-server:8443'
        New-EnvFileText -Values $values | Should -Match '(?m)^CORS_ORIGIN="https://erp-server:8443"\r?$'
    }
}

Describe 'New-CaddyfileText' {
    It 'renders HTTPS and HTTP sites, ports, proxy, and persistent storage' {
        $text = New-CaddyfileText -HostName 'erp-server' -ExtraAddresses @('192.168.1.20') -HttpsPort 8443 -HttpPort 8080 -ApiPort 3101 -DataDir 'C:\ERP Data'
        $text | Should -Match 'https://erp-server:8443, https://192\.168\.1\.20:8443'
        $text | Should -Match 'http://erp-server:8080 \{'
        $text | Should -Match 'http://192\.168\.1\.20:8080 \{'
        $text | Should -Match 'reverse_proxy 127\.0\.0\.1:3101'
        $text | Should -Match 'storage file_system "C:/ERP Data/caddy/data"'
        $text | Should -Match '(?m)^    http_port 8080\r?$'
        $text | Should -Match '(?m)^    https_port 8443\r?$'
        $text | Should -Match '(?m)^    auto_https disable_redirects\r?$'
        $text | Should -Match '(?m)^    admin off\r?$'
        $text | Should -Match 'root \* "C:/ERP Data/caddy/public"'
        $text | Should -Match 'redir https://erp-server:8443\{uri\} 308'
        $text | Should -Not -Match 'C:\\ERP'
    }

    It 'omits default HTTPS and HTTP ports' {
        $text = New-CaddyfileText -HostName 'erp-server' -HttpsPort 443 -HttpPort 80 -ApiPort 3101 -DataDir 'C:\ERPData'
        $text | Should -Match 'https://erp-server'
        $text | Should -Match 'http://erp-server'
        $text | Should -Not -Match 'https://erp-server:443'
        $text | Should -Not -Match 'http://erp-server:80'
        $text | Should -Match 'redir https://erp-server\{uri\} 308'
    }
}

Describe 'New-RandomSecret' {
    It 'creates a 48-byte base64url JWT secret' {
        $secret = New-RandomSecret -Kind Jwt
        $secret.Length | Should -Be 64
        $secret | Should -Match '^[A-Za-z0-9_-]+$'
    }

    It 'creates base64-encoded 32-byte encryption keys' {
        $secret = New-RandomSecret -Kind Base64
        [Convert]::FromBase64String($secret).Length | Should -Be 32
    }

    It 'creates a 32-character hexadecimal database password' {
        $secret = New-RandomSecret -Kind DatabasePassword
        $secret.Length | Should -Be 32
        $secret | Should -Match '^[0-9a-f]{32}$'
    }
}

Describe 'Get-PreferredPort' {
    It 'uses the first available fallback when the preferred port is busy' {
        $portTest = { param($candidate) return $candidate -eq 8444 }
        Get-PreferredPort -PreferredPort 443 -FallbackPorts @(8443, 8444, 8445) -PortTest $portTest | Should -Be 8444
    }

    It 'keeps the preferred port when it is available' {
        $portTest = { param($candidate) return $candidate -eq 443 }
        Get-PreferredPort -PreferredPort 443 -FallbackPorts @(8443) -PortTest $portTest | Should -Be 443
    }
}

Describe 'Resolve-InstallPort' {
    It 'uses an explicitly requested port when it is free' {
        $portTest = { param($candidate) return $candidate -eq 8443 }
        Resolve-InstallPort -Bound $true -Requested 8443 -Recorded 0 -Preferred 443 -Fallbacks @(8443, 8444) -PortTest $portTest | Should -Be 8443
    }

    It 'rejects a bound port when it is occupied by another service' {
        $portTest = { param($candidate) return $candidate -eq 0 }
        { Resolve-InstallPort -Bound $true -Requested 8443 -Recorded 0 -Preferred 443 -Fallbacks @(8444) -PortTest $portTest } | Should -Throw '*already in use*'
    }

    It 'allows the recorded port when the ERP service already holds it' {
        $portTest = { param($candidate) return $candidate -eq 0 }
        Resolve-InstallPort -Bound $true -Requested 8443 -Recorded 8443 -Preferred 443 -Fallbacks @(8444) -PortTest $portTest | Should -Be 8443
    }

    It 'prefers a recorded port when no parameter was bound' {
        $portTest = { param($candidate) return $candidate -eq 0 }
        Resolve-InstallPort -Bound $false -Requested 443 -Recorded 8443 -Preferred 443 -Fallbacks @(8444) -PortTest $portTest | Should -Be 8443
    }

    It 'auto-picks the first available fallback when there is no recorded port' {
        $portTest = { param($candidate) return $candidate -eq 8444 }
        Resolve-InstallPort -Bound $false -Requested 443 -Recorded 0 -Preferred 443 -Fallbacks @(8443, 8444) -PortTest $portTest | Should -Be 8444
    }
}

Describe 'Get-MariaDbIniPort' {
    It 'reads the last port from the mysqld section only' {
        $text = @'
[client]
port=3306
[mysqld]
port=3308
port=3309
[mysqldump]
port=3310
'@
        Get-MariaDbIniPort -Text $text | Should -Be 3309
    }

    It 'returns zero when the mysqld section has no port' {
        Get-MariaDbIniPort -Text "[client]`r`nport=3306`r`n[mysqld]`r`n" | Should -Be 0
    }
}

Describe 'Update-MyIniText' {
    It 'keeps a newline and blank line before the next section' {
        $text = "[mysqld]`r`nport=3306`r`n[client]`r`nport=3307`r`n"
        $updated = Update-MyIniText -Text $text -DataDirValue 'C:\ERPData\mariadb' -Port 3308
        $updated | Should -Match 'bind-address=127\.0\.0\.1\r\n\r\n\[client\]'
    }

    It 'ends the final mysqld section with a newline' {
        $updated = Update-MyIniText -Text '[mysqld]' -DataDirValue 'C:\ERPData\mariadb' -Port 3308
        $updated.EndsWith("`r`n") | Should -BeTrue
        $updated | Should -Match 'bind-address=127\.0\.0\.1\r\n$'
    }

    It 'adds mysqld when the file does not have that section' {
        $updated = Update-MyIniText -Text "[client]`r`nport=3306`r`n" -DataDirValue 'C:\ERPData\mariadb' -Port 3308
        $updated | Should -Match '\[client\]\r\nport=3306\r\n\r\n\[mysqld\]'
    }

    It 'replaces existing settings without duplicating keys' {
        $text = "[mysqld]`r`ndatadir=old`r\nport=3306`r\nport=3307`r\nbind-address=0.0.0.0`r\n"
        $updated = Update-MyIniText -Text $text -DataDirValue 'C:\ERPData\mariadb' -Port 3308
        ([regex]::Matches($updated, '(?im)^port=')).Count | Should -Be 1
        ([regex]::Matches($updated, '(?im)^datadir=')).Count | Should -Be 1
        ([regex]::Matches($updated, '(?im)^bind-address=')).Count | Should -Be 1
        $updated | Should -Match 'datadir=C:\\ERPData\\mariadb'
        $updated | Should -Match 'port=3308'
    }
}

Describe 'Native command output suppression' {
    It 'returns only the function value when a native command writes output' {
        function Invoke-TestNativeCommand {
            param(
                [Parameter(Mandatory = $true)][string]$FilePath,
                [string[]]$Arguments = @(),
                [Parameter(Mandatory = $true)][string]$Value
            )
            & $FilePath @Arguments | Out-Host
            if ($LASTEXITCODE -ne 0) {
                throw "Native command failed with exit code $LASTEXITCODE."
            }
            return $Value
        }

        if (Test-Path -LiteralPath '/bin/echo') {
            $result = @(Invoke-TestNativeCommand -FilePath '/bin/echo' -Arguments @('noise') -Value 'node.exe')
        } else {
            $result = @(Invoke-TestNativeCommand -FilePath $env:ComSpec -Arguments @('/c', 'echo noise') -Value 'node.exe')
        }
        $result.Count | Should -Be 1
        $result[0] | Should -BeExactly 'node.exe'
    }
}
