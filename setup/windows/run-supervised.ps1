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
        $process = New-Object System.Diagnostics.Process
        $process.StartInfo = New-Object System.Diagnostics.ProcessStartInfo
        $process.StartInfo.FileName = $Executable
        $process.StartInfo.Arguments = $ArgumentLine
        $process.StartInfo.WorkingDirectory = $WorkingDirectory
        $process.StartInfo.UseShellExecute = $false
        $process.StartInfo.CreateNoWindow = $true
        $process.StartInfo.RedirectStandardOutput = $true
        $process.StartInfo.RedirectStandardError = $true
        $queue = New-Object 'System.Collections.Concurrent.ConcurrentQueue[string]'
        $handler = [System.Diagnostics.DataReceivedEventHandler]{
            param($sourceProcess, $receivedEvent)
            if ($null -ne $receivedEvent.Data) {
                $queue.Enqueue(("{0:o} [{1}] {2}" -f [DateTime]::Now, $sourceProcess.Id, $receivedEvent.Data))
            }
        }
        $process.add_OutputDataReceived($handler)
        $process.add_ErrorDataReceived($handler)
        if (-not $process.Start()) {
            throw "Could not start $Executable."
        }
        $process.BeginOutputReadLine()
        $process.BeginErrorReadLine()
        while (-not $process.HasExited -or -not $queue.IsEmpty) {
            $line = $null
            while ($queue.TryDequeue([ref]$line)) {
                Add-LogLine -Path $LogPath -Line $line
                $line = $null
            }
            Start-Sleep -Milliseconds 200
        }
        $process.WaitForExit()
        $exitCode = $process.ExitCode
        $line = $null
        while ($queue.TryDequeue([ref]$line)) {
            Add-LogLine -Path $LogPath -Line $line
            $line = $null
        }
        $process.Dispose()
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
