Describe 'Invoke-ErpLegacyUpgradeCheck' {
    BeforeAll {
        $tokens = $null
        $errors = $null
        $install = [System.Management.Automation.Language.Parser]::ParseFile(
            (Join-Path $PSScriptRoot '..\install.ps1'), [ref]$tokens, [ref]$errors)
        $functions = $install.FindAll({
            param($node)
            $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
                $node.Name -in @('Invoke-ErpLegacyUpgradeCheck', 'Invoke-CheckedCommand', 'Get-CommandPath')
        }, $true)
        foreach ($definition in $functions) {
            . ([scriptblock]::Create($definition.Extent.Text))
        }
    }

    BeforeEach {
        $appDir = Join-Path $TestDrive 'app'
        $dataDir = Join-Path $TestDrive 'data'
        $envPath = Join-Path $appDir 'apps\api\.env'
        $buildPath = Join-Path $appDir 'apps\api\dist\jobs\cli.js'
        $dbPath = Join-Path $dataDir 'mariadb\my.ini'
        foreach ($path in @($envPath, $buildPath, $dbPath)) {
            New-Item -ItemType Directory -Path (Split-Path -Parent $path) -Force | Out-Null
            New-Item -ItemType File -Path $path -Force | Out-Null
        }
        Mock Get-CommandPath { $Names[0] }
        Mock Invoke-CheckedCommand {}
    }

    It 'backs up from the existing checkout before checking the old ledger' {
        $checks = New-Object 'System.Collections.Generic.List[string]'
        Mock Invoke-CheckedCommand {
            $checks.Add("$FilePath|${WorkingDirectory}|$($Arguments -join '|')")
        }
        Invoke-ErpLegacyUpgradeCheck -AppDir $appDir -DataDir $dataDir
        $runner = Join-Path $appDir 'setup\windows\run-job.ps1'
        $checks.Count | Should -Be 2
        $checks[0] | Should -Be "powershell.exe|$appDir|-NoProfile|-ExecutionPolicy|Bypass|-File|$runner|-Job|backup|-AppDir|$appDir|-DataDir|$dataDir|-NodeExe|node.exe"
        $checks[1] | Should -Be "pnpm.cmd|$appDir|--filter|api|ledger:check"
    }

    It 'skips checks when <Missing> is absent' -TestCases @(
        @{ Missing = 'apps\api\.env'; Root = 'app' }
        @{ Missing = 'apps\api\dist\jobs\cli.js'; Root = 'app' }
        @{ Missing = 'mariadb\my.ini'; Root = 'data' }
    ) {
        param($Missing, $Root)
        Remove-Item -LiteralPath (Join-Path (Join-Path $TestDrive $Root) $Missing)
        Invoke-ErpLegacyUpgradeCheck -AppDir $appDir -DataDir $dataDir
        Should -Invoke Invoke-CheckedCommand -Exactly 0
    }

    It 'propagates a backup failure without running the ledger check' {
        Mock Invoke-CheckedCommand { throw 'backup failed' } -ParameterFilter { $FilePath -eq 'powershell.exe' }
        { Invoke-ErpLegacyUpgradeCheck -AppDir $appDir -DataDir $dataDir } | Should -Throw 'backup failed'
        Should -Invoke Invoke-CheckedCommand -Exactly 0 -ParameterFilter { $FilePath -eq 'pnpm.cmd' }
    }

    It 'propagates a ledger failure' {
        Mock Invoke-CheckedCommand { throw 'ledger check failed' } -ParameterFilter { $FilePath -eq 'pnpm.cmd' }
        { Invoke-ErpLegacyUpgradeCheck -AppDir $appDir -DataDir $dataDir } | Should -Throw 'ledger check failed'
        Should -Invoke Invoke-CheckedCommand -Exactly 1 -ParameterFilter { $FilePath -eq 'powershell.exe' }
    }
}
