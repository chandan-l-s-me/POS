# Shared by install.ps1, update.ps1 and uninstall.ps1. Dot-sourced.
# ASCII only: Windows PowerShell 5.1 reads script files without a BOM as ANSI.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Script:PackageRoot = Split-Path -Parent $PSScriptRoot
$Script:DefaultInstallDir = Join-Path $env:ProgramFiles 'VyaparaBilling'
$Script:UninstallKeyRoot = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall'

function Test-IsAdmin {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  return ([Security.Principal.WindowsPrincipal]$identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# Re-launch the calling script as administrator (one UAC prompt), passing on
# its parameters. Returns $true if the caller should stop here.
function Invoke-Elevated([string]$ScriptPath, [hashtable]$BoundParameters) {
  if (Test-IsAdmin) { return $false }
  $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$ScriptPath`"")
  foreach ($key in $BoundParameters.Keys) {
    $value = $BoundParameters[$key]
    if ($value -is [switch] -or $value -is [bool]) {
      if ($value) { $arguments += "-$key" }
    } else {
      $arguments += "-$key"
      $arguments += "`"$value`""
    }
  }
  try {
    $process = Start-Process -FilePath 'powershell.exe' -ArgumentList $arguments -Verb RunAs -Wait -PassThru
    exit $process.ExitCode
  } catch {
    Write-Host ''
    Write-Host 'Administrator permission is needed. Please run it again and choose Yes.' -ForegroundColor Red
    exit 1
  }
}

# Run a program and collect its output. Windows PowerShell 5.1 turns anything a
# program writes to stderr into a terminating error while ErrorActionPreference
# is Stop, even when the program succeeds - so judge by the exit code instead.
function Invoke-Native([string]$Exe, [string[]]$Arguments = @()) {
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $output = & $Exe @Arguments 2>&1 | ForEach-Object { "$_" }
    return [pscustomobject]@{ Code = $LASTEXITCODE; Output = ($output -join "`n") }
  } finally {
    $ErrorActionPreference = $previous
  }
}

# Mirror a program folder. Never deletes a database or the settings file,
# whatever ends up where.
function Copy-Folder([string]$From, [string]$To) {
  $result = Invoke-Native 'robocopy.exe' @($From, $To, '/MIR', '/XF', '*.db', '*.db-wal', '*.db-shm', '.env', '/NFL', '/NDL', '/NJH', '/NJS', '/NP')
  if ($result.Code -ge 8) { throw "Copying to $To failed (robocopy $($result.Code)): $($result.Output)" }
}

function Write-Step([string]$Text) { Write-Host ''; Write-Host "> $Text" -ForegroundColor Cyan }
function Write-Ok([string]$Text) { Write-Host "  OK  $Text" -ForegroundColor Green }
function Write-Note([string]$Text) { Write-Host "      $Text" }
function Write-Problem([string]$Text) { Write-Host "  !!  $Text" -ForegroundColor Red }

function Get-InstallInfo([string]$InstallDir) {
  $file = Join-Path $InstallDir 'install.json'
  if (-not (Test-Path $file)) { return $null }
  return Get-Content $file -Raw | ConvertFrom-Json
}

function Save-InstallInfo([string]$InstallDir, $Info) {
  $Info | ConvertTo-Json | Set-Content -Path (Join-Path $InstallDir 'install.json') -Encoding UTF8
}

function Get-PackageVersion([string]$Root) {
  return (Get-Content (Join-Path $Root 'app\VERSION') -Raw).Trim()
}

# Wait until the server answers. /api/settings without a sign-in answers 401:
# that proves the process is up and the app is wired, without a password.
function Wait-Healthy([int]$Port, [int]$Seconds = 60) {
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    try {
      Invoke-WebRequest "http://127.0.0.1:$Port/api/settings" -UseBasicParsing -TimeoutSec 3 | Out-Null
      return $true
    } catch {
      $response = $_.Exception.Response
      if ($response -and [int]$response.StatusCode -eq 401) { return $true }
    }
    Start-Sleep -Milliseconds 700
  }
  return $false
}

function Show-LogTail([string]$DataDir, [string]$ServiceName) {
  $logs = Join-Path $DataDir 'logs'
  foreach ($name in @("$ServiceName.err.log", "$ServiceName.out.log", "$ServiceName.wrapper.log")) {
    $file = Join-Path $logs $name
    if (Test-Path $file) {
      # Best effort: a log that cannot be read must not hide the real problem.
      try {
        Write-Host "  --- last lines of $name ---"
        Get-Content $file -Tail 15 -ErrorAction Stop | ForEach-Object { Write-Host "  $_" }
      } catch {
        Write-Host "  (could not read $file : $($_.Exception.Message))"
      }
    }
  }
}

function Get-ServiceExe([string]$InstallDir, [string]$ServiceName) {
  return Join-Path $InstallDir "service\$ServiceName.exe"
}

function Wait-ServiceState([string]$ServiceName, [string]$State, [int]$Seconds = 30) {
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    $service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($service -and $service.Status -eq $State) { return $true }
    if (-not $service -and $State -eq 'Missing') { return $true }
    Start-Sleep -Milliseconds 500
  }
  return $false
}

# Only SYSTEM and Administrators may read or change the shop's data and
# settings: they hold customer details, GSTINs and the sign-in signing key.
function Protect-Path([string]$Path) {
  # The folder gets explicit rights that its contents inherit; everything
  # already inside is reset to inherit them. Granting the folder-style (OI)(CI)
  # rights to each file with /T left existing files - the database, the logs -
  # with no usable rights at all on a reinstall, so not even the service could
  # open them.
  $result = Invoke-Native 'icacls.exe' @($Path, '/inheritance:r', '/grant:r', '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F', '/C', '/Q')
  if ($result.Code -ne 0) { throw "Could not set permissions on ${Path}: $($result.Output)" }
  if (Get-ChildItem -LiteralPath $Path -Force -ErrorAction SilentlyContinue) {
    $result = Invoke-Native 'icacls.exe' @((Join-Path $Path '*'), '/reset', '/T', '/C', '/Q')
    if ($result.Code -ne 0) { throw "Could not reset permissions inside ${Path}: $($result.Output)" }
  }
}

function Protect-File([string]$Path) {
  $result = Invoke-Native 'icacls.exe' @($Path, '/inheritance:r', '/grant:r', '*S-1-5-18:F', '*S-1-5-32-544:F', '/C', '/Q')
  if ($result.Code -ne 0) { throw "Could not set permissions on ${Path}: $($result.Output)" }
}

# The same rules the server applies, so the installer can say so up front.
function Test-AdminPassword([string]$Password) {
  if ($Password.Length -lt 10) { return 'Use at least 10 characters.' }
  if ($Password.Length -gt 200) { return 'Use at most 200 characters.' }
  if ($Password -notmatch '[A-Za-z]' -or $Password -notmatch '[0-9]') { return 'Use at least one letter and one number.' }
  if (@('DemoAdmin2026', 'DemoPriya2026', 'DemoArun2026') -contains $Password) { return 'That is a published demo password. Choose another.' }
  return $null
}

# A value for .env, quoted so dotenv reads it back exactly: single quotes are
# literal; a value that itself contains one goes in double quotes instead.
function Format-EnvValue([string]$Value) {
  if ($Value -notmatch "'") { return "'$Value'" }
  if ($Value -notmatch '"' -and $Value -notmatch '\\n') { return "`"$Value`"" }
  throw 'Please avoid using both kinds of quote mark in the password.'
}

function ConvertFrom-SecureText([Security.SecureString]$Secure) {
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secure)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
}

function New-Secret([int]$Bytes = 32) {
  $buffer = New-Object byte[] $Bytes
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($buffer)
  return -join ($buffer | ForEach-Object { $_.ToString('x2') })
}

function Find-Browser {
  foreach ($candidate in @(
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe"
  )) {
    if ($candidate -and (Test-Path $candidate)) { return $candidate }
  }
  return $null
}

function Get-ShortcutPaths([string]$ServiceName) {
  $label = if ($ServiceName -eq 'VyaparaBilling') { 'Vyapara Billing' } else { "Vyapara Billing ($ServiceName)" }
  $desktop = [Environment]::GetFolderPath('CommonDesktopDirectory')
  $menu = [Environment]::GetFolderPath('CommonPrograms')
  return @((Join-Path $desktop "$label.lnk"), (Join-Path $menu "$label.lnk"))
}

function Pause-IfInteractive([switch]$Quiet) {
  if (-not $Quiet) {
    Write-Host ''
    Read-Host 'Press Enter to close this window' | Out-Null
  }
}
