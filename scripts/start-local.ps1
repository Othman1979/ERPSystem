<#
  Starts ERP Cloud on this computer:
    1. checks Node.js and pnpm;
    2. creates .env and apps\api\.env from the examples when missing;
    3. checks the database server, and starts XAMPP's MariaDB if it is installed and stopped;
    4. installs packages, creates the database, applies migrations and the base seed;
    5. starts the API (:3001) and the web app (:5173);
    6. loads the demo company the first time (or with -Demo) and opens the browser.

  Double-click start-local.bat, or run:
    powershell -ExecutionPolicy Bypass -File scripts\start-local.ps1 [-Demo] [-NoBrowser]
  Ctrl+C stops the API and the web app.
#>
param(
  # Load the demo company even when the database already existed.
  [switch]$Demo,
  # Don't open the browser.
  [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$webUrl = 'http://localhost:5173'
$healthUrl = 'http://localhost:3001/api/v1/health'
$script:dev = $null

function Step([string]$text) {
  Write-Host ''
  Write-Host "==> $text" -ForegroundColor Cyan
}

function Stop-Dev {
  if ($script:dev -and -not $script:dev.HasExited) {
    & taskkill.exe /PID $script:dev.Id /T /F | Out-Null
  }
}

function Fail([string]$text) {
  Stop-Dev
  Write-Host ''
  Write-Host "ERROR: $text" -ForegroundColor Red
  exit 1
}

function Test-Port([string]$hostName, [int]$port) {
  $targets = @($hostName)
  if ($hostName -eq 'localhost') { $targets = @('127.0.0.1', '::1') }
  foreach ($target in $targets) {
    $client = $null
    try {
      $ip = $null
      if ([System.Net.IPAddress]::TryParse($target, [ref]$ip)) {
        $client = New-Object System.Net.Sockets.TcpClient($ip.AddressFamily)
        $task = $client.ConnectAsync($ip, $port)
      } else {
        $client = New-Object System.Net.Sockets.TcpClient
        $task = $client.ConnectAsync($target, $port)
      }
      if ($task.Wait(1500) -and $client.Connected) { return $true }
    } catch {
      # refused or unreachable: try the next address
    } finally {
      if ($client) { $client.Dispose() }
    }
  }
  return $false
}

function Test-Url([string]$url) {
  try {
    return (Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 -Uri $url).StatusCode -eq 200
  } catch {
    return $false
  }
}

function Open-App {
  if (-not $NoBrowser) { Start-Process $webUrl }
}

function Get-PortOwner([int]$port) {
  $conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $conn) { return $null }
  return Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue
}

# ---------------------------------------------------------------- already running?
if ((Test-Url $healthUrl) -and (Test-Url $webUrl)) {
  Write-Host "ERP is already running at $webUrl"
  Open-App
  exit 0
}

# ---------------------------------------------------------------- Node.js and pnpm
Step 'Checking Node.js and pnpm'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Fail 'Node.js is not installed. Install Node.js 22.18 or newer from https://nodejs.org, then run this again.'
}
$nodeVersion = [version]((& node -v).Trim().TrimStart('v'))
if ($nodeVersion -lt [version]'22.18.0') {
  Fail "Node.js $nodeVersion is too old. Install Node.js 22.18 or newer from https://nodejs.org, then run this again."
}
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
  Write-Host 'pnpm was not found; enabling it with corepack...'
  & corepack enable
  if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
    Fail 'Could not enable pnpm. Run "npm install -g pnpm@10" once, then run this again.'
  }
}
Write-Host "Node.js $nodeVersion, pnpm $((& pnpm -v).Trim())"

# ---------------------------------------------------------------- settings
Step 'Preparing settings (.env files)'
foreach ($pair in @(@('.env.example', '.env'), @('apps\api\.env.example', 'apps\api\.env'))) {
  if (Test-Path $pair[1]) {
    Write-Host "$($pair[1]) exists"
  } else {
    Copy-Item $pair[0] $pair[1]
    Write-Host "created $($pair[1]) from $($pair[0])"
  }
}
$dbLine = Get-Content 'apps\api\.env' | Where-Object { $_ -match '^\s*DATABASE_URL\s*=' } | Select-Object -First 1
if (-not $dbLine) { Fail 'DATABASE_URL is missing in apps\api\.env.' }
$dbUrl = [uri](($dbLine -split '=', 2)[1].Trim().Trim('"').Trim("'"))
$dbHost = $dbUrl.Host
$dbPort = 3306
if ($dbUrl.Port -gt 0) { $dbPort = $dbUrl.Port }

# ---------------------------------------------------------------- database server
Step "Checking the database server ($dbHost, port $dbPort)"
if (-not (Test-Port $dbHost $dbPort)) {
  $xampp = @('C:\xampp', 'D:\xampp') | Where-Object { Test-Path (Join-Path $_ 'mysql\bin\mysqld.exe') } | Select-Object -First 1
  if (-not $xampp -or $dbHost -notin @('localhost', '127.0.0.1')) {
    Fail "No database answers on $dbHost, port $dbPort. Start MariaDB or MySQL (XAMPP Control Panel > MySQL > Start), then run this again."
  }
  Write-Host "Starting MariaDB from $xampp ..."
  $myIni = Join-Path $xampp 'mysql\bin\my.ini'
  Start-Process -FilePath (Join-Path $xampp 'mysql\bin\mysqld.exe') -ArgumentList "--defaults-file=`"$myIni`"", '--standalone' -WorkingDirectory $xampp -WindowStyle Hidden
  $deadline = (Get-Date).AddSeconds(30)
  while (-not (Test-Port $dbHost $dbPort)) {
    if ((Get-Date) -gt $deadline) {
      Fail 'MariaDB did not start within 30 seconds. Start it from the XAMPP Control Panel, then run this again.'
    }
    Start-Sleep -Seconds 1
  }
}
Write-Host 'the database server is running'

# ---------------------------------------------------------------- packages and database
Step 'Installing packages (the first time takes a few minutes)'
& pnpm install --frozen-lockfile
if ($LASTEXITCODE -ne 0) { Fail 'pnpm install failed. See the messages above.' }

Step 'Preparing the database'
$created = & pnpm -C apps/api -s exec tsx scripts/create-db.mts
if ($LASTEXITCODE -ne 0) { Fail 'Could not create the database. Check DATABASE_URL in apps\api\.env.' }
$created | ForEach-Object { Write-Host $_ }
$fresh = [bool](@($created) -match ' created$')

& pnpm -C apps/api exec prisma migrate deploy
if ($LASTEXITCODE -ne 0) { Fail 'The database migrations failed. See the messages above.' }
# Older copies of prisma/seed.ts keep running after writing (the pool stays open): stop it once it reports success.
$seedOut = Join-Path $env:TEMP 'erp-start-seed.log'
$seedErr = Join-Path $env:TEMP 'erp-start-seed.err.log'
$seed = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', 'pnpm -C apps/api -s seed' -NoNewWindow -PassThru -RedirectStandardOutput $seedOut -RedirectStandardError $seedErr
$deadline = (Get-Date).AddMinutes(2)
while (-not $seed.HasExited) {
  if ((Test-Path $seedOut) -and (Select-String -Path $seedOut -Pattern 'seed complete' -SimpleMatch -Quiet)) { break }
  if ((Get-Date) -gt $deadline) { break }
  Start-Sleep -Milliseconds 500
}
if (-not $seed.HasExited) { & taskkill.exe /PID $seed.Id /T /F | Out-Null }
Get-Content $seedOut -ErrorAction SilentlyContinue | ForEach-Object { Write-Host $_ }
if (-not (Select-String -Path $seedOut -Pattern 'seed complete' -SimpleMatch -Quiet)) {
  Get-Content $seedErr -ErrorAction SilentlyContinue | ForEach-Object { Write-Host $_ }
  Fail 'The base data (plans, roles) could not be written. See the messages above.'
}

# ---------------------------------------------------------------- ports
foreach ($port in @(3001, 5173)) {
  $owner = Get-PortOwner $port
  if ($owner) {
    Write-Host ''
    Write-Host "Port $port is already used by $($owner.ProcessName) (process $($owner.Id)), probably an earlier start that is still open." -ForegroundColor Yellow
    $answer = Read-Host 'Stop it and continue? (y/n)'
    if ($answer -notmatch '^(y|yes)$') { Fail "Close the program that uses port $port, then run this again." }
    & taskkill.exe /PID $owner.Id /T /F | Out-Null
    Start-Sleep -Seconds 1
  }
}

# ---------------------------------------------------------------- start
Step 'Starting the API (port 3001) and the web app (port 5173). Press Ctrl+C to stop them.'
$script:dev = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', 'pnpm dev' -NoNewWindow -PassThru
$deadline = (Get-Date).AddMinutes(3)
while (-not (Test-Url $healthUrl)) {
  if ($script:dev.HasExited) { Fail 'The API or the web app stopped while starting. See the messages above.' }
  if ((Get-Date) -gt $deadline) { Fail 'The API did not answer within 3 minutes. See the messages above.' }
  Start-Sleep -Seconds 2
}
$deadline = (Get-Date).AddMinutes(1)
while (-not (Test-Url $webUrl)) {
  if ((Get-Date) -gt $deadline) { Fail 'The web app did not answer within a minute. See the messages above.' }
  Start-Sleep -Seconds 1
}

if ($Demo -or $fresh) {
  Step 'Loading the demo company'
  & pnpm -C apps/api -s demo:seed
  if ($LASTEXITCODE -ne 0) {
    Write-Host 'The demo data could not be loaded; the app still runs.' -ForegroundColor Yellow
  }
}

Write-Host ''
Write-Host "ERP is running at $webUrl" -ForegroundColor Green
Write-Host 'Demo sign-in (when the demo company is loaded): demo@erp.local / Demo12345'
Write-Host 'Press Ctrl+C to stop.'
Open-App
Wait-Process -Id $script:dev.Id
