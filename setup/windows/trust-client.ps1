param(
    [string]$Server = '',
    [ValidateRange(1, 65535)][int]$HttpPort = 80,
    [ValidateRange(1, 65535)][int]$HttpsPort = 443
)

. (Join-Path $PSScriptRoot 'lib\common.ps1')
$ErrorActionPreference = 'Stop'

if (-not $Server) {
    $Server = Read-Host 'Enter the ERP Cloud server host name or LAN address'
}
$Server = $Server.Trim().TrimEnd('/')
if ($Server -match '^https?://') {
    $Server = $Server -replace '^https?://', ''
}
if ($Server -match '^([^/:]+):(\d+)$') {
    $hostName = $Matches[1]
    $HttpPort = [int]$Matches[2]
} elseif ($Server -match '^[^/:]+$') {
    $hostName = $Server
} else {
    Fail 'Use a host name or IPv4 address, optionally followed by the HTTP port.'
}
if ($hostName -notmatch '^[A-Za-z0-9][A-Za-z0-9.-]*$') {
    Fail 'The server must be a host name or IPv4 address.'
}
$downloadUrl = "http://$hostName"
if ($HttpPort -ne 80) {
    $downloadUrl += ":$HttpPort"
}
$downloadUrl += '/erp-ca.crt'
$caPath = Join-Path $env:TEMP ("erp-ca-" + [guid]::NewGuid().ToString('N') + '.crt')
Write-Step "Downloading the server CA from $downloadUrl"
Invoke-WebRequest -Uri $downloadUrl -UseBasicParsing -OutFile $caPath
$certificate = Get-X509CertificateFromPem -Path $caPath
$sha = [Security.Cryptography.SHA256]::Create()
try {
    $fingerprint = [BitConverter]::ToString($sha.ComputeHash($certificate.RawData)).Replace('-', '')
} finally {
    $sha.Dispose()
}
Write-Host "Downloaded certificate SHA-256 fingerprint: $fingerprint"
$answer = Read-Host 'Compare this fingerprint with CA_SHA256 in the server INSTALL-INFO.txt. Match? (y/N)'
if ($answer.ToLowerInvariant() -ne 'y') {
    Remove-Item -LiteralPath $caPath -Force -ErrorAction SilentlyContinue
    Fail 'Certificate was not imported because the fingerprint was not confirmed.'
}
$existing = Get-ChildItem Cert:\CurrentUser\Root | Where-Object { $_.Thumbprint -eq $certificate.Thumbprint } | Select-Object -First 1
if (-not $existing) {
    $certificateDer = Join-Path $env:TEMP ("erp-ca-" + [guid]::NewGuid().ToString('N') + '.cer')
    try {
        [IO.File]::WriteAllBytes($certificateDer, $certificate.RawData)
        Import-Certificate -FilePath $certificateDer -CertStoreLocation 'Cert:\CurrentUser\Root' | Out-Null
    } finally {
        Remove-Item -LiteralPath $certificateDer -Force -ErrorAction SilentlyContinue
    }
}
$url = "https://$hostName"
if ($HttpsPort -ne 443) {
    $url += ":$HttpsPort"
}
$shortcut = Join-Path ([Environment]::GetFolderPath('DesktopDirectory')) 'ERP Cloud.url'
Write-Utf8NoBom -Path $shortcut -Text "[InternetShortcut]`r`nURL=$url`r`n"
Remove-Item -LiteralPath $caPath -Force -ErrorAction SilentlyContinue
Write-Host "ERP Cloud is ready: $url"
Write-Host 'Firefox may require importing the CA in Firefox certificate settings as well.'
