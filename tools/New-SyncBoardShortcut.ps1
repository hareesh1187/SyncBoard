$ErrorActionPreference = 'Stop'
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$LauncherPath = Join-Path $PSScriptRoot 'Start-SyncBoard.ps1'
$IconPath = Join-Path $ProjectRoot 'assets\syncboard.ico'
$DesktopPath = [Environment]::GetFolderPath('Desktop')
$ShortcutPath = Join-Path $DesktopPath 'SyncBoard.lnk'
$PowerShellExe = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'

foreach ($requiredPath in @($LauncherPath, $IconPath, $PowerShellExe)) {
  if (-not (Test-Path -LiteralPath $requiredPath)) { throw "Required SyncBoard launcher file is missing: $requiredPath" }
}

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($ShortcutPath)
$shortcut.TargetPath = $PowerShellExe
$shortcut.Arguments = "-NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$LauncherPath`""
$shortcut.WorkingDirectory = $ProjectRoot
$shortcut.IconLocation = "$IconPath,0"
$shortcut.Description = 'Start SyncBoard and open its live whiteboard in Microsoft Edge.'
$shortcut.Save()

Write-Output "Created $ShortcutPath"
