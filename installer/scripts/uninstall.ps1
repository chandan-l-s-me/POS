# Remove Vyapara Billing from this computer. Run through "Uninstall Vyapara.bat"
# (in the installed folder, or from Settings > Apps).
#
# The shop's data - bills, customers, stock, backups - is KEPT unless
# -RemoveData is given and confirmed by typing DELETE. ASCII only (see common.ps1).

param(
  [string]$InstallDir,
  [switch]$RemoveData,
  [switch]$Quiet,
  [string]$LogFile
)

. (Join-Path $PSScriptRoot 'common.ps1')
if (Invoke-Elevated $PSCommandPath $PSBoundParameters) { return }
if (-not $InstallDir) {
  # Run from the installed copy: its own folder is the install folder.
  $InstallDir = if (Test-Path (Join-Path $PackageRoot 'install.json')) { $PackageRoot } else { $DefaultInstallDir }
}
if (-not $LogFile) { $LogFile = Join-Path $env:TEMP 'VyaparaBilling-uninstall.log' }
Start-Transcript -Path $LogFile -Force | Out-Null

$exitCode = 0
try {
  $info = Get-InstallInfo $InstallDir
  if (-not $info) { throw "Vyapara Billing is not installed in $InstallDir." }
  $serviceName = $info.serviceName
  Write-Host ''
  Write-Host "  Remove Vyapara Billing $($info.version)" -ForegroundColor White
  Write-Host '  ------------------------------------------'
  Write-Note "Program: $InstallDir"
  Write-Note "Shop data: $($info.dataDir) - $(if ($RemoveData) { 'WILL BE DELETED' } else { 'kept' })"

  if (-not $Quiet) {
    $answer = Read-Host '  Remove the program? (Y/N)'
    if ($answer -notmatch '^[Yy]') { throw 'Cancelled. Nothing was removed.' }
  }
  if ($RemoveData -and -not $Quiet) {
    $typed = Read-Host '  Type DELETE to also erase all bills, customers and backups'
    if ($typed -cne 'DELETE') { $RemoveData = $false; Write-Note 'Shop data will be kept.' }
  }

  Write-Step 'Stopping and removing the service'
  $serviceExe = Get-ServiceExe $InstallDir $serviceName
  if (Get-Service -Name $serviceName -ErrorAction SilentlyContinue) {
    Invoke-Native $serviceExe @('stop') | Out-Null
    Wait-ServiceState $serviceName 'Stopped' 60 | Out-Null
    Invoke-Native $serviceExe @('uninstall') | Out-Null
    if (-not (Wait-ServiceState $serviceName 'Missing' 30)) { Invoke-Native 'sc.exe' @('delete', $serviceName) | Out-Null }
  }
  Write-Ok 'Service removed'

  Write-Step 'Removing icons and the program entry'
  foreach ($path in (Get-ShortcutPaths $serviceName)) { if (Test-Path $path) { Remove-Item $path -Force } }
  $key = Join-Path $UninstallKeyRoot $serviceName
  if (Test-Path $key) { Remove-Item $key -Recurse -Force }
  Write-Ok 'Removed'

  if ($RemoveData) {
    Write-Step 'Erasing shop data'
    Remove-Item $info.dataDir -Recurse -Force
    Write-Ok "Deleted $($info.dataDir)"
  }

  Write-Step 'Removing the program files'
  # This script may be running from inside the folder; finish the removal
  # a few seconds after this window closes.
  $here = (Resolve-Path $InstallDir).Path
  $inside = $PSScriptRoot.StartsWith($here, [StringComparison]::OrdinalIgnoreCase)
  if ($inside) {
    Start-Process -FilePath 'cmd.exe' -ArgumentList "/c timeout /t 4 /nobreak >nul & rmdir /s /q `"$here`"" -WindowStyle Hidden
    Write-Ok 'Program folder will be removed when this window closes'
  } else {
    Remove-Item $here -Recurse -Force
    Write-Ok 'Program folder removed'
  }

  Write-Host ''
  Write-Host '  Vyapara Billing has been removed.' -ForegroundColor Green
  if (-not $RemoveData) { Write-Host "  The shop's data is still in $($info.dataDir). Installing again will use it." }
} catch {
  $exitCode = 1
  Write-Host ''
  Write-Problem $_.Exception.Message
} finally {
  Stop-Transcript | Out-Null
}
Pause-IfInteractive -Quiet:$Quiet
exit $exitCode
