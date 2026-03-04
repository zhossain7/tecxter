param(
  [string]$Destination = "tools\tectonic",
  [switch]$FromPathOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Write-Info {
  param([string]$Message)
  Write-Host "[tectonic-setup] $Message"
}

function Resolve-RepoRoot {
  if ($PSScriptRoot) {
    return (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
  }

  if ($PSCommandPath) {
    $scriptDir = Split-Path -Parent $PSCommandPath
    return (Resolve-Path (Join-Path $scriptDir "..")).Path
  }

  throw "Unable to resolve repository root. Run this script from the project folder."
}

function Ensure-EmptyDir {
  param([string]$Path)
  if (Test-Path $Path) {
    Remove-Item -Path $Path -Recurse -Force
  }
  New-Item -Path $Path -ItemType Directory -Force | Out-Null
}

function Copy-EngineFolder {
  param(
    [string]$ExePath,
    [string]$DestDir
  )
  $srcDir = Split-Path -Parent $ExePath
  Ensure-EmptyDir -Path $DestDir
  Copy-Item -Path (Join-Path $srcDir "*") -Destination $DestDir -Recurse -Force
  if (-not (Test-Path (Join-Path $DestDir "tectonic.exe"))) {
    throw "tectonic.exe was not copied correctly."
  }
  Write-Info "Bundled tectonic in: $DestDir"
}

$repoRoot = Resolve-RepoRoot
$destDir = Join-Path $repoRoot $Destination

Write-Info "Target bundle folder: $destDir"

$fromPath = Get-Command tectonic -ErrorAction SilentlyContinue
if ($fromPath) {
  Write-Info "Found tectonic on PATH: $($fromPath.Source)"
  Copy-EngineFolder -ExePath $fromPath.Source -DestDir $destDir
  Write-Info "Done."
  exit 0
}

if ($FromPathOnly) {
  throw "tectonic was not found in PATH and -FromPathOnly was set."
}

Write-Info "tectonic not found in PATH. Downloading latest release from GitHub..."

$releaseApi = "https://api.github.com/repos/tectonic-typesetting/tectonic/releases/latest"
$headers = @{ "User-Agent" = "TeXStudioLocal-setup-script" }
$release = Invoke-RestMethod -Uri $releaseApi -Headers $headers

$asset = $release.assets |
  Where-Object { $_.name -match "x86_64-pc-windows-msvc\.zip$" } |
  Select-Object -First 1

if (-not $asset) {
  throw "Could not find a Windows x64 release asset in latest tectonic release."
}

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("tectonic_bundle_" + [Guid]::NewGuid().ToString("N"))
New-Item -Path $tempRoot -ItemType Directory -Force | Out-Null

try {
  $zipPath = Join-Path $tempRoot $asset.name
  $extractDir = Join-Path $tempRoot "extract"

  Write-Info "Downloading: $($asset.browser_download_url)"
  Invoke-WebRequest -Uri $asset.browser_download_url -Headers $headers -OutFile $zipPath

  Write-Info "Extracting archive..."
  Expand-Archive -Path $zipPath -DestinationPath $extractDir -Force

  $exe = Get-ChildItem -Path $extractDir -Recurse -Filter "tectonic.exe" | Select-Object -First 1
  if (-not $exe) {
    throw "tectonic.exe not found in downloaded archive."
  }

  Copy-EngineFolder -ExePath $exe.FullName -DestDir $destDir
  Write-Info "Done."
}
finally {
  if (Test-Path $tempRoot) {
    Remove-Item -Path $tempRoot -Recurse -Force
  }
}
