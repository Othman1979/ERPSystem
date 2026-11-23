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
