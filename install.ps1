[CmdletBinding()]
param(
  [string]$Version = $env:LINEAR_VERSION,
  [string]$InstallDir = $env:LINEAR_INSTALL_DIR,
  [switch]$AddToPath
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Repository = "qwrobins/linearctl"
$Artifact = "linearctl-windows-x64.exe"
$BinaryName = "linearctl.exe"

function Resolve-LinearVersion {
  param([string]$RequestedVersion)

  if (-not [string]::IsNullOrWhiteSpace($RequestedVersion)) {
    if ($RequestedVersion -notmatch '^v[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$') {
      throw "Version must use the form vX.Y.Z or vX.Y.Z-suffix."
    }
    return $RequestedVersion
  }

  $release = Invoke-RestMethod `
    -Headers @{ "User-Agent" = "linearctl-installer" } `
    -Uri "https://api.github.com/repos/$Repository/releases/latest"
  if ([string]::IsNullOrWhiteSpace($release.tag_name)) {
    throw "Could not determine the latest linearctl release."
  }
  return [string]$release.tag_name
}

function Resolve-InstallDirectory {
  param([string]$RequestedDirectory)

  if ([string]::IsNullOrWhiteSpace($RequestedDirectory)) {
    if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
      throw "LOCALAPPDATA is not set; pass -InstallDir or set LINEAR_INSTALL_DIR."
    }
    return Join-Path $env:LOCALAPPDATA "Programs\linearctl\bin"
  }

  if ([System.IO.Path]::IsPathRooted($RequestedDirectory)) {
    return [System.IO.Path]::GetFullPath($RequestedDirectory)
  }
  return [System.IO.Path]::GetFullPath((Join-Path (Get-Location) $RequestedDirectory))
}

function Get-ExpectedChecksum {
  param(
    [string]$ChecksumsFile,
    [string]$ArtifactName
  )

  $escapedName = [regex]::Escape($ArtifactName)
  $line = Get-Content -LiteralPath $ChecksumsFile |
    Where-Object { $_ -match "^(?<hash>[0-9A-Fa-f]{64})\s+\*?$escapedName$" } |
    Select-Object -First 1
  if ($null -eq $line) {
    throw "checksums.txt does not contain an entry for $ArtifactName."
  }

  [void]($line -match '^(?<hash>[0-9A-Fa-f]{64})')
  return $Matches.hash.ToUpperInvariant()
}

function Add-InstallDirectoryToUserPath {
  param([string]$Directory)

  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  $entries = @($userPath -split ';' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
  if ($entries | Where-Object { $_.TrimEnd('\') -ieq $Directory.TrimEnd('\') }) {
    return
  }

  $updated = if ([string]::IsNullOrWhiteSpace($userPath)) {
    $Directory
  } else {
    "$userPath;$Directory"
  }
  [Environment]::SetEnvironmentVariable("Path", $updated, "User")
  $env:Path = "$Directory;$env:Path"
  Write-Host "Added $Directory to the user PATH. Open a new terminal to inherit it."
}

if (-not [System.Runtime.InteropServices.RuntimeInformation]::IsOSPlatform(
  [System.Runtime.InteropServices.OSPlatform]::Windows
)) {
  throw "This installer must run on Windows."
}

if ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne
    [System.Runtime.InteropServices.Architecture]::X64) {
  throw "This release currently supports Windows x64 only."
}

$resolvedVersion = Resolve-LinearVersion $Version
if ($resolvedVersion -notmatch '^v[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$') {
  throw "The resolved release tag is not a valid linearctl version."
}
$resolvedInstallDir = Resolve-InstallDirectory $InstallDir
$baseUrl = "https://github.com/$Repository/releases/download/$resolvedVersion"
$temporaryDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ("linearctl-install-" + [guid]::NewGuid())
$downloadedBinary = Join-Path $temporaryDirectory $Artifact
$checksumsFile = Join-Path $temporaryDirectory "checksums.txt"
$stagedBinary = Join-Path $resolvedInstallDir (".$BinaryName." + [guid]::NewGuid() + ".tmp")
$targetBinary = Join-Path $resolvedInstallDir $BinaryName

try {
  New-Item -ItemType Directory -Path $temporaryDirectory -Force | Out-Null
  New-Item -ItemType Directory -Path $resolvedInstallDir -Force | Out-Null

  Write-Host "Downloading linearctl $resolvedVersion for Windows x64..."
  Invoke-WebRequest -UseBasicParsing -Uri "$baseUrl/$Artifact" -OutFile $downloadedBinary
  Invoke-WebRequest -UseBasicParsing -Uri "$baseUrl/checksums.txt" -OutFile $checksumsFile

  $expected = Get-ExpectedChecksum $checksumsFile $Artifact
  $actual = (Get-FileHash -LiteralPath $downloadedBinary -Algorithm SHA256).Hash.ToUpperInvariant()
  if ($actual -ne $expected) {
    throw "Checksum mismatch for $Artifact. Expected $expected but received $actual."
  }
  Write-Host "Checksum verified."

  Copy-Item -LiteralPath $downloadedBinary -Destination $stagedBinary
  Move-Item -LiteralPath $stagedBinary -Destination $targetBinary -Force
  Write-Host "Installed linearctl to $targetBinary"

  if ($AddToPath) {
    Add-InstallDirectoryToUserPath $resolvedInstallDir
  } elseif (-not (($env:Path -split ';') | Where-Object {
    $_.TrimEnd('\') -ieq $resolvedInstallDir.TrimEnd('\')
  })) {
    Write-Host ""
    Write-Host "$resolvedInstallDir is not in this terminal's PATH."
    Write-Host "Rerun with -AddToPath, or add the directory to your user PATH and open a new terminal."
  }

  Write-Host ""
  Write-Host "Update agent skills to match this version:"
  Write-Host "  linearctl skills install"
} finally {
  if (Test-Path -LiteralPath $stagedBinary) {
    Remove-Item -LiteralPath $stagedBinary -Force
  }
  if (Test-Path -LiteralPath $temporaryDirectory) {
    Remove-Item -LiteralPath $temporaryDirectory -Recurse -Force
  }
}
