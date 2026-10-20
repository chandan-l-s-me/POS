# Install Vyapara Billing on this computer. Run through "Install Vyapara.bat".
#
# Afterwards the server is a Windows service: it starts with the computer,
# restarts itself if it stops, and needs no one signed in. The shop opens the
# "Vyapara Billing" icon on the desktop. ASCII only (see common.ps1).
#
# Every question can be answered with a parameter instead, for unattended
# installs and testing:
#   -ShopName -ShopPhone -AdminPassword -BackupCopyDir -Port -InstallDir
#   -DataDir -ServiceName -Quiet -NoShortcuts -NoLaunch -LogFile

param(
  [string]$InstallDir,
  [string]$DataDir = 'C:\VyaparaData',
  [int]$Port = 3000,
  [string]$ServiceName = 'VyaparaBilling',
  [string]$ShopName,
  [string]$ShopPhone,
  [string]$AdminPassword,
  [string]$BackupCopyDir,
  [switch]$Quiet,
  [switch]$NoShortcuts,
  [switch]$NoLaunch,
  [string]$LogFile
)

. (Join-Path $PSScriptRoot 'common.ps1')
if (Invoke-Elevated $PSCommandPath $PSBoundParameters) { return }
if (-not $InstallDir) { $InstallDir = $DefaultInstallDir }
if (-not $LogFile) { $LogFile = Join-Path $env:TEMP 'VyaparaBilling-install.log' }
Start-Transcript -Path $LogFile -Force | Out-Null

$exitCode = 0
$createdService = $false
try {
  $version = Get-PackageVersion $PackageRoot
  Write-Host ''
  Write-Host "  Vyapara Billing $version - installation" -ForegroundColor White
  Write-Host '  ------------------------------------------'

  # --- Checks -----------------------------------------------------------------
  Write-Step 'Checking this computer'
  if (-not [Environment]::Is64BitOperatingSystem) { throw 'This needs 64-bit Windows.' }
  foreach ($required in @('app\server.mjs', 'app\dist\index.html', 'node\node.exe', 'service\VyaparaBilling.exe')) {
    if (-not (Test-Path (Join-Path $PackageRoot $required))) { throw "The package is incomplete: $required is missing. Unzip the whole folder and run it again." }
  }
  if (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) {
    throw "Vyapara Billing is already installed here. To install a new version, use 'Update Vyapara.bat'."
  }
  if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
    throw "Port $Port is already in use by another program. Run the installer with -Port and a free number (for example 3010)."
  }
  Write-Ok "Windows 64-bit, port $Port free"

  # --- Questions --------------------------------------------------------------
  $dbFile = Join-Path $DataDir 'pos.db'
  $existingData = Test-Path $dbFile
  if ($existingData) {
    Write-Step "Existing shop data found in $DataDir"
    Write-Note 'It will be kept and used: bills, customers, stock and accounts stay as they are.'
    Write-Note 'Sign in with the admin password you already have.'
  } else {
    Write-Step 'A few questions'
    while (-not $ShopName -and -not $Quiet) { $ShopName = (Read-Host '  Shop name (as printed on bills)').Trim() }
    if (-not $Quiet -and -not $PSBoundParameters.ContainsKey('ShopPhone')) { $ShopPhone = (Read-Host '  Shop phone (optional, press Enter to skip)').Trim() }

    if (-not $AdminPassword) {
      if ($Quiet) { throw 'An admin password is required (-AdminPassword).' }
      Write-Note 'Choose the admin password: at least 10 characters, with a letter and a number.'
      while ($true) {
        $first = ConvertFrom-SecureText (Read-Host '  Admin password' -AsSecureString)
        $problem = Test-AdminPassword $first
        if ($problem) { Write-Problem $problem; continue }
        $second = ConvertFrom-SecureText (Read-Host '  Type it again' -AsSecureString)
        if ($first -ne $second) { Write-Problem 'The two did not match. Try again.'; continue }
        $AdminPassword = $first
        break
      }
    } else {
      $problem = Test-AdminPassword $AdminPassword
      if ($problem) { throw "Admin password: $problem" }
    }

    if (-not $Quiet -and -not $PSBoundParameters.ContainsKey('BackupCopyDir')) {
      Write-Note 'Backups are taken every day. A second copy on a USB drive or in a OneDrive /'
      Write-Note 'Google Drive folder protects the shop if this computer fails.'
      $BackupCopyDir = (Read-Host '  Folder for a second copy (optional, press Enter to skip)').Trim().Trim('"')
    }
  }
  if ($BackupCopyDir) {
    New-Item -ItemType Directory -Force -Path $BackupCopyDir | Out-Null
    Write-Ok "Backups will also be copied to $BackupCopyDir"
  }

  # --- Files ------------------------------------------------------------------
  Write-Step "Copying the program to $InstallDir"
  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
  foreach ($folder in @('app', 'node', 'service', 'scripts')) {
    Copy-Folder (Join-Path $PackageRoot $folder) (Join-Path $InstallDir $folder)
  }
  foreach ($file in @('Update Vyapara.bat', 'Uninstall Vyapara.bat', 'README.txt')) {
    Copy-Item (Join-Path $PackageRoot $file) (Join-Path $InstallDir $file) -Force
  }
  Write-Ok 'Program files copied'

  Write-Step "Preparing the data folder $DataDir"
  foreach ($folder in @($DataDir, (Join-Path $DataDir 'backups'), (Join-Path $DataDir 'logs'))) {
    New-Item -ItemType Directory -Force -Path $folder | Out-Null
  }
  Protect-Path $DataDir
  Write-Ok 'Only Windows administrators and the service can open it'

  # --- Settings (.env) --------------------------------------------------------
  Write-Step 'Writing the settings'
  $envFile = Join-Path $InstallDir 'app\.env'
  $lines = @(
    '# Written by the Vyapara Billing installer. Keep this file private.',
    "JWT_SECRET=`"$(New-Secret 32)`"",
    'NODE_ENV="production"',
    'HOST="127.0.0.1"',
    "PORT=`"$Port`"",
    # Single quotes: dotenv reads them literally, so a folder such as C:\new
    # is not turned into "C:" + a line break.
    "DB_PATH='$dbFile'",
    "BACKUP_DIR='$(Join-Path $DataDir 'backups')'",
    "BACKUP_COPY_DIR='$BackupCopyDir'",
    'AUTO_BACKUP_HOURS="24"',
    'BACKUP_KEEP_DAYS="30"',
    'AUDIT_LOG_RETENTION_DAYS="400"'
  )
  # Used once, when the server creates the admin on an empty database; removed below.
  if (-not $existingData) { $lines += "ADMIN_INITIAL_PASSWORD=$(Format-EnvValue $AdminPassword)" }
  Set-Content -Path $envFile -Value $lines -Encoding ASCII
  Protect-File $envFile
  Write-Ok 'Settings written with a new secret key'

  # --- Service ----------------------------------------------------------------
  Write-Step 'Registering the Windows service'
  $serviceExe = Get-ServiceExe $InstallDir $ServiceName
  if ($ServiceName -ne 'VyaparaBilling') {
    Move-Item (Join-Path $InstallDir 'service\VyaparaBilling.exe') $serviceExe -Force
  }
  $displayName = if ($ServiceName -eq 'VyaparaBilling') { 'Vyapara Billing' } else { "Vyapara Billing ($ServiceName)" }
  $xml = @"
<service>
  <id>$ServiceName</id>
  <name>$displayName</name>
  <description>Vyapara Billing point of sale. Open http://127.0.0.1:$Port in a browser.</description>
  <executable>$(Join-Path $InstallDir 'node\node.exe')</executable>
  <arguments>server.mjs</arguments>
  <workingdirectory>$(Join-Path $InstallDir 'app')</workingdirectory>
  <startmode>Automatic</startmode>
  <onfailure action="restart" delay="5 sec"/>
  <onfailure action="restart" delay="10 sec"/>
  <onfailure action="restart" delay="30 sec"/>
  <resetfailure>1 hour</resetfailure>
  <stoptimeout>20 sec</stoptimeout>
  <logpath>$(Join-Path $DataDir 'logs')</logpath>
  <log mode="roll-by-size">
    <sizeThreshold>5120</sizeThreshold>
    <keepFiles>5</keepFiles>
  </log>
</service>
"@
  Set-Content -Path ([IO.Path]::ChangeExtension($serviceExe, '.xml')) -Value $xml -Encoding UTF8
  $result = Invoke-Native $serviceExe @('install')
  if ($result.Code -ne 0) { throw "The service could not be registered: $($result.Output)" }
  if (-not (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue)) { throw 'The service could not be registered.' }
  $createdService = $true
  # Restart on failure even when the process exits with an error code.
  Invoke-Native 'sc.exe' @('failureflag', $ServiceName, '1') | Out-Null
  Invoke-Native $serviceExe @('start') | Out-Null
  if (-not (Wait-Healthy $Port 90)) {
    Show-LogTail $DataDir $ServiceName
    throw 'The service started but the app did not answer. See the log lines above.'
  }
  Write-Ok "Service '$displayName' is running and starts with Windows"

  # --- First-run settings -----------------------------------------------------
  if (-not $existingData) {
    Write-Step 'Setting up the shop'
    $login = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$Port/api/auth/login" -ContentType 'application/json' -Body (@{ username = 'admin'; password = $AdminPassword } | ConvertTo-Json)
    $headers = @{ Authorization = "Bearer $($login.token)" }
    $settings = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/settings" -Headers $headers
    if ($ShopName) { $settings.shop_name = $ShopName }
    if ($ShopPhone) { $settings.shop_phone = $ShopPhone }
    $body = @{
      shop_name = $settings.shop_name; shop_address = $settings.shop_address; shop_phone = $settings.shop_phone
      shop_gstin = $settings.shop_gstin; bill_format = $settings.bill_format
      bill_header = $settings.bill_header; bill_footer = $settings.bill_footer
    } | ConvertTo-Json
    Invoke-RestMethod -Method Put -Uri "http://127.0.0.1:$Port/api/settings" -Headers $headers -ContentType 'application/json' -Body ([Text.Encoding]::UTF8.GetBytes($body)) | Out-Null
    # The admin exists now; the password should not stay in a file.
    (Get-Content $envFile) | Where-Object { $_ -notmatch '^ADMIN_INITIAL_PASSWORD=' } | Set-Content $envFile -Encoding ASCII
    Write-Ok "Admin account 'admin' created; shop name set"
  }

  # --- Record, shortcuts ------------------------------------------------------
  Save-InstallInfo $InstallDir ([ordered]@{
    version = $version; installDir = $InstallDir; dataDir = $DataDir; port = $Port
    serviceName = $ServiceName; installedAt = (Get-Date).ToString('s')
  })
  $key = Join-Path $UninstallKeyRoot $ServiceName
  New-Item -Path $key -Force | Out-Null
  Set-ItemProperty $key DisplayName $displayName
  Set-ItemProperty $key DisplayVersion $version
  Set-ItemProperty $key Publisher 'Vyapara Billing'
  Set-ItemProperty $key InstallLocation $InstallDir
  Set-ItemProperty $key UninstallString "`"$(Join-Path $InstallDir 'Uninstall Vyapara.bat')`""
  Set-ItemProperty $key NoModify 1 -Type DWord
  Set-ItemProperty $key NoRepair 1 -Type DWord

  $url = "http://127.0.0.1:$Port"
  if (-not $NoShortcuts) {
    Write-Step 'Adding the Vyapara Billing icon'
    $browser = Find-Browser
    $shell = New-Object -ComObject WScript.Shell
    foreach ($path in (Get-ShortcutPaths $ServiceName)) {
      New-Item -ItemType Directory -Force -Path (Split-Path $path) | Out-Null
      $link = $shell.CreateShortcut($path)
      if ($browser) {
        $link.TargetPath = $browser
        $link.Arguments = "--app=$url"
        $link.IconLocation = "$browser,0"
      } else {
        $link.TargetPath = $url
      }
      $link.Description = 'Open Vyapara Billing'
      $link.Save()
    }
    Write-Ok 'Desktop and Start menu icons added'
  }

  Write-Host ''
  Write-Host '  Vyapara Billing is installed.' -ForegroundColor Green
  Write-Host "  Open it from the desktop icon, or at $url"
  if (-not $existingData) { Write-Host "  Sign in as 'admin' with the password you chose." }
  Write-Host "  Shop data and backups: $DataDir"
  if (-not $NoLaunch) {
    $browser = Find-Browser
    if ($browser) { Start-Process $browser "--app=$url" } else { Start-Process $url }
  }
} catch {
  $exitCode = 1
  Write-Host ''
  Write-Problem "Installation stopped: $($_.Exception.Message)"
  if ($createdService) {
    # Leave nothing half-installed, so running the installer again starts clean.
    $serviceExe = Get-ServiceExe $InstallDir $ServiceName
    Invoke-Native $serviceExe @('stop') | Out-Null
    Wait-ServiceState $ServiceName 'Stopped' 30 | Out-Null
    Invoke-Native $serviceExe @('uninstall') | Out-Null
    Write-Note 'The partly installed service was removed. Shop data was not touched.'
  }
  Write-Note "A record of this attempt is in $LogFile"
} finally {
  Stop-Transcript | Out-Null
}
Pause-IfInteractive -Quiet:$Quiet
exit $exitCode
