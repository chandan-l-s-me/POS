# Update an installed Vyapara Billing to the version in this package.
# Run through "Update Vyapara.bat" from the NEW package's folder.
#
# Bills, customers, stock, accounts and settings are never touched: they live
# in the data folder and the app's .env, which are carried over. The database
# is backed up first, and if the new version does not start, the old one is put
# back. ASCII only (see common.ps1).

param(
  [string]$InstallDir,
  [switch]$Quiet,
  [string]$LogFile
)

. (Join-Path $PSScriptRoot 'common.ps1')
if (Invoke-Elevated $PSCommandPath $PSBoundParameters) { return }
if (-not $InstallDir) { $InstallDir = $DefaultInstallDir }
if (-not $LogFile) { $LogFile = Join-Path $env:TEMP 'VyaparaBilling-update.log' }
Start-Transcript -Path $LogFile -Force | Out-Null

$exitCode = 0
$movedAside = $false
try {
  $info = Get-InstallInfo $InstallDir
  if (-not $info) { throw "Vyapara Billing is not installed in $InstallDir. Use 'Install Vyapara.bat' first." }
  if ((Resolve-Path $PackageRoot).Path -eq (Resolve-Path $InstallDir).Path) {
    throw 'Run Update Vyapara.bat from the folder of the NEW version you downloaded, not from the installed copy.'
  }
  $newVersion = Get-PackageVersion $PackageRoot
  $serviceName = $info.serviceName
  $serviceExe = Get-ServiceExe $InstallDir $serviceName
  $port = [int]$info.port
  Write-Host ''
  Write-Host "  Vyapara Billing update: $($info.version) -> $newVersion" -ForegroundColor White
  Write-Host '  ------------------------------------------'

  if (-not $Quiet) {
    Write-Note 'The app will be unavailable for about a minute. Finish any bill in progress first.'
    $answer = Read-Host '  Continue? (Y/N)'
    if ($answer -notmatch '^[Yy]') { throw 'Update cancelled.' }
  }

  # --- Backup first -----------------------------------------------------------
  Write-Step 'Backing up the shop data'
  $dbFile = Join-Path $info.dataDir 'pos.db'
  $stamp = Get-Date -Format 'yyyy-MM-dd_HH-mm-ss'
  $backup = Join-Path $info.dataDir "backups\before-update-$($info.version)-$stamp.db"
  $result = Invoke-Native (Join-Path $InstallDir 'node\node.exe') @((Join-Path $InstallDir 'app\tools\backup.mjs'), $dbFile, $backup)
  if ($result.Code -ne 0) { throw "The backup failed, so nothing was changed: $($result.Output)" }
  Write-Ok "Backup saved: $backup"

  # --- Swap -------------------------------------------------------------------
  Write-Step 'Stopping the app'
  Invoke-Native $serviceExe @('stop') | Out-Null
  if (-not (Wait-ServiceState $serviceName 'Stopped' 60)) { throw 'The service did not stop.' }
  Write-Ok 'Stopped'

  Write-Step 'Installing the new version'
  foreach ($folder in @('app', 'node')) {
    $current = Join-Path $InstallDir $folder
    $previous = "$current.previous"
    if (Test-Path $previous) { Remove-Item $previous -Recurse -Force }
    Rename-Item $current $previous
  }
  $movedAside = $true
  foreach ($folder in @('app', 'node', 'scripts')) {
    Copy-Folder (Join-Path $PackageRoot $folder) (Join-Path $InstallDir $folder)
  }
  # The shop's settings carry over unchanged.
  Copy-Item (Join-Path $InstallDir 'app.previous\.env') (Join-Path $InstallDir 'app\.env') -Force
  Protect-File (Join-Path $InstallDir 'app\.env')
  Copy-Item (Join-Path $PackageRoot 'service\VyaparaBilling.exe') $serviceExe -Force
  foreach ($file in @('Update Vyapara.bat', 'Uninstall Vyapara.bat', 'README.txt')) {
    Copy-Item (Join-Path $PackageRoot $file) (Join-Path $InstallDir $file) -Force
  }
  Write-Ok "Version $newVersion copied"

  Write-Step 'Starting the app'
  Invoke-Native $serviceExe @('start') | Out-Null
  if (-not (Wait-Healthy $port 90)) {
    Show-LogTail $info.dataDir $serviceName
    throw 'The new version did not start.'
  }
  Write-Ok 'Running'

  foreach ($folder in @('app', 'node')) { Remove-Item (Join-Path $InstallDir "$folder.previous") -Recurse -Force }
  $info.version = $newVersion
  $info | Add-Member -NotePropertyName updatedAt -NotePropertyValue (Get-Date).ToString('s') -Force
  Save-InstallInfo $InstallDir $info
  $key = Join-Path $UninstallKeyRoot $serviceName
  if (Test-Path $key) { Set-ItemProperty $key DisplayVersion $newVersion }

  Write-Host ''
  Write-Host "  Updated to $newVersion. All shop data is as it was." -ForegroundColor Green
} catch {
  $exitCode = 1
  Write-Host ''
  Write-Problem "Update stopped: $($_.Exception.Message)"
  if ($movedAside) {
    Write-Step 'Putting the previous version back'
    try {
      Invoke-Native $serviceExe @('stop') | Out-Null
      Wait-ServiceState $serviceName 'Stopped' 30 | Out-Null
      foreach ($folder in @('app', 'node')) {
        $current = Join-Path $InstallDir $folder
        if (Test-Path "$current.previous") {
          if (Test-Path $current) { Remove-Item $current -Recurse -Force }
          Rename-Item "$current.previous" $current
        }
      }
      Invoke-Native $serviceExe @('start') | Out-Null
      if (Wait-Healthy $port 90) { Write-Ok 'The previous version is running again. Nothing was lost.' }
      else { Write-Problem 'The previous version did not start either. Contact support with the log below.' }
    } catch {
      Write-Problem "Could not restore automatically: $($_.Exception.Message)"
    }
  }
  Write-Note "A record of this attempt is in $LogFile"
} finally {
  Stop-Transcript | Out-Null
}
Pause-IfInteractive -Quiet:$Quiet
exit $exitCode
