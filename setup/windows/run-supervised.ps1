param(
    [Parameter(Mandatory = $true)][string]$Executable,
    [string]$ArgumentLine = '',
    [Parameter(Mandatory = $true)][string]$WorkingDirectory,
    [Parameter(Mandatory = $true)][string]$LogPath
)

. (Join-Path $PSScriptRoot 'lib\common.ps1')

$delay = 5
while ($true) {
    $startedAt = Get-Date
    try {
        if (-not (Test-Path -LiteralPath $Executable)) {
            throw "Executable not found: $Executable"
        }
        if (-not (Test-Path -LiteralPath $WorkingDirectory)) {
            throw "Working directory not found: $WorkingDirectory"
        }
        Rotate-LogFile -Path $LogPath
        Add-LogLine -Path $LogPath -Line ("{0:o} starting {1}" -f (Get-Date), $Executable)
        $result = Invoke-LoggedProcess -FilePath $Executable -ArgumentLine $ArgumentLine -WorkingDirectory $WorkingDirectory -LogPath $LogPath -StdoutToLog $true -StderrToLog $true
        $exitCode = $result.ExitCode
        Add-LogLine -Path $LogPath -Line ("{0:o} exited with code {1}" -f (Get-Date), $exitCode)
        if (((Get-Date) - $startedAt).TotalSeconds -ge 300) {
            $delay = 5
        }
    } catch {
        Add-LogLine -Path $LogPath -Line ("{0:o} supervisor error: {1}" -f (Get-Date), $_.Exception.Message)
    }
    Start-Sleep -Seconds $delay
    $delay = [Math]::Min(60, $delay * 2)
}
