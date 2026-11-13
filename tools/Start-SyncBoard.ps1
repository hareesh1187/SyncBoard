param([switch] $NoOpenBrowser, [switch] $LocalDevelopment)

$ErrorActionPreference = 'Stop'

$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$DataRoot = Join-Path $ProjectRoot 'data'
$LogPath = Join-Path $DataRoot 'launcher.log'
$PublicUrlPath = Join-Path $DataRoot 'public-url.txt'
$StdoutPath = Join-Path $DataRoot 'server.stdout.log'
$StderrPath = Join-Path $DataRoot 'server.stderr.log'
$DockerExe = 'C:\Program Files\Docker\Docker\resources\bin\docker.exe'
$DockerDesktopExe = 'C:\Program Files\Docker\Docker\Docker Desktop.exe'

New-Item -ItemType Directory -Force -Path $DataRoot | Out-Null

function Write-LauncherLog {
  param([Parameter(Mandatory)][string] $Message)
  Add-Content -LiteralPath $LogPath -Value "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $Message"
}

function Test-SyncBoardHealth {
  param([Parameter(Mandatory)][string] $BaseUri, [Parameter(Mandatory)][string] $Store)
  try {
    $health = Invoke-RestMethod -Uri "$BaseUri/api/health" -Method Get -TimeoutSec 2
    return [bool]($health.ok -and $health.store -eq $Store)
  } catch {
    return $false
  }
}

function Test-DockerEngine {
  if (-not (Test-Path -LiteralPath $DockerExe)) { return $false }
  try {
    $serverVersion = & $DockerExe info --format '{{.ServerVersion}}' 2>$null
    $dockerExit = $LASTEXITCODE
    return ($dockerExit -eq 0 -and -not [string]::IsNullOrWhiteSpace(($serverVersion -join ' ').Trim()))
  } catch {
    Write-LauncherLog "Docker engine check failed: $($_.Exception.Message)"
    return $false
  }
}

function Start-DockerStack {
  Write-LauncherLog 'Starting the Docker Compose stack.'
  Push-Location $ProjectRoot
  try {
    $composeOutput = & $DockerExe compose -f (Join-Path $ProjectRoot 'compose.yml') up -d --build 2>&1
    $composeExit = $LASTEXITCODE
    foreach ($line in $composeOutput) { Add-Content -LiteralPath $LogPath -Value $line }
  } catch {
    Write-LauncherLog "Docker Compose could not start: $($_.Exception.Message)"
    return $false
  } finally {
    Pop-Location
  }
  if ($composeExit -ne 0) {
    Write-LauncherLog "Docker Compose exited with code $composeExit."
    return $false
  }
  for ($attempt = 0; $attempt -lt 90; $attempt += 1) {
    if (Test-SyncBoardHealth -BaseUri 'http://127.0.0.1:8080' -Store 'redis') { return $true }
    Start-Sleep -Seconds 1
  }
  Write-LauncherLog 'Docker Compose started, but the gateway did not become healthy within 90 seconds.'
  return $false
}

try {
  $launchUri = $null
  $publicUrl = $env:SYNCBOARD_PUBLIC_URL
  if (-not $publicUrl -and (Test-Path -LiteralPath $PublicUrlPath)) {
    $publicUrl = (Get-Content -LiteralPath $PublicUrlPath -Raw).Trim()
  }

  if ($publicUrl) {
    $publicUri = $null
    if (-not [Uri]::TryCreate($publicUrl, [UriKind]::Absolute, [ref]$publicUri) -or $publicUri.Scheme -ne 'https') {
      throw 'The public SyncBoard URL must be a valid HTTPS address. Check data\public-url.txt.'
    }
    $launchUri = "$($publicUri.GetLeftPart([UriPartial]::Authority))/?board=studio"
    Write-LauncherLog "Using the public SyncBoard deployment at $($publicUri.GetLeftPart([UriPartial]::Authority))."
  } elseif (-not $LocalDevelopment) {
    throw "SyncBoard has not been deployed publicly yet. Deploy the Render Blueprint, then save its HTTPS URL to $PublicUrlPath. See DEPLOYING.md for setup."
  }

  if ($LocalDevelopment -and -not $launchUri) {
    if (Test-SyncBoardHealth -BaseUri 'http://127.0.0.1:8080' -Store 'redis') {
      $launchUri = 'http://127.0.0.1:8080/?board=studio'
      Write-LauncherLog 'Using the healthy Docker-backed development board at port 8080.'
    } elseif (Test-DockerEngine) {
      if (Start-DockerStack) { $launchUri = 'http://127.0.0.1:8080/?board=studio' }
    } elseif (Test-SyncBoardHealth -BaseUri 'http://127.0.0.1:3000' -Store 'file') {
      $launchUri = 'http://127.0.0.1:3000/?board=studio'
      Write-LauncherLog 'Docker is unavailable; using the explicitly requested local development server.'
    } elseif (Test-Path -LiteralPath $DockerDesktopExe) {
      Write-LauncherLog 'No development backend is running. Starting Docker Desktop and waiting for its engine.'
      Start-Process -FilePath $DockerDesktopExe -WindowStyle Hidden | Out-Null
      for ($attempt = 0; $attempt -lt 24; $attempt += 1) {
        if (Test-DockerEngine) { break }
        Start-Sleep -Seconds 1
      }
      $engineReady = Test-DockerEngine
      if ($engineReady -and (Start-DockerStack)) { $launchUri = 'http://127.0.0.1:8080/?board=studio' }
    }

    if (-not $launchUri -and (Test-SyncBoardHealth -BaseUri 'http://127.0.0.1:3000' -Store 'file')) {
      $launchUri = 'http://127.0.0.1:3000/?board=studio'
      Write-LauncherLog 'Using the healthy local development server.'
    }

    if (-not $launchUri) {
      $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
      $node = Get-Command node.exe -ErrorAction SilentlyContinue
      if (-not $node) { throw 'Node.js is not installed. Install Node.js 20 or newer, then use -LocalDevelopment again.' }
      if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot 'node_modules\ws'))) {
        if (-not $npm) { throw 'npm is missing, so SyncBoard dependencies could not be installed.' }
        Write-LauncherLog 'Installing SyncBoard development dependencies.'
        Push-Location $ProjectRoot
        try {
          & $npm.Source install --no-audit --no-fund *>> $LogPath
          $installExit = $LASTEXITCODE
        } finally {
          Pop-Location
        }
        if ($installExit -ne 0) { throw "Dependency installation failed with exit code $installExit. See $LogPath." }
      }

      Write-LauncherLog 'Starting the local file-backed development server.'
      Start-Process -FilePath $node.Source -ArgumentList @('src/server.js') -WorkingDirectory $ProjectRoot -WindowStyle Hidden -RedirectStandardOutput $StdoutPath -RedirectStandardError $StderrPath | Out-Null
      for ($attempt = 0; $attempt -lt 25; $attempt += 1) {
        if (Test-SyncBoardHealth -BaseUri 'http://127.0.0.1:3000' -Store 'file') {
          $launchUri = 'http://127.0.0.1:3000/?board=studio'
          break
        }
        Start-Sleep -Seconds 1
      }
    }

    if (-not $launchUri) { throw "SyncBoard development server did not become healthy on port 3000. Check $StderrPath and $LogPath." }
  }

  $edgeCandidates = @()
  if ($env:ProgramFiles) { $edgeCandidates += (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe') }
  if (${env:ProgramFiles(x86)}) { $edgeCandidates += (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe') }
  $edgeCommand = Get-Command msedge.exe -ErrorAction SilentlyContinue
  if ($edgeCommand) { $edgeCandidates += $edgeCommand.Source }
  $edgeExe = $edgeCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1

  if (-not $NoOpenBrowser) {
    Write-LauncherLog "Opening $launchUri in Microsoft Edge."
    if ($edgeExe) {
      Start-Process -FilePath $edgeExe -ArgumentList @('--new-window', $launchUri) | Out-Null
    } else {
      Start-Process -FilePath "microsoft-edge:$launchUri" | Out-Null
    }
  } else {
    Write-LauncherLog "Backend is ready at $launchUri; browser launch was skipped by request."
  }
} catch {
  Write-LauncherLog "Launcher error: $($_.Exception.Message)"
  $dialog = New-Object -ComObject WScript.Shell
  $dialog.Popup("SyncBoard could not start.`n`n$($_.Exception.Message)", 0, 'SyncBoard', 16) | Out-Null
  exit 1
}
