[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$installerPath = (Resolve-Path (Join-Path $PSScriptRoot "..\..\install.ps1")).Path
$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("linearctl-installer-test-" + [guid]::NewGuid())
$previousFixtureDirectory = $env:LINEARCTL_INSTALLER_TEST_FIXTURE_DIRECTORY

function Invoke-WebRequest {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)]
    [string]$Uri,

    [Parameter(Mandatory)]
    [string]$OutFile,

    [switch]$UseBasicParsing
  )

  $assetName = [System.IO.Path]::GetFileName(([uri]$Uri).AbsolutePath)
  $source = Join-Path $env:LINEARCTL_INSTALLER_TEST_FIXTURE_DIRECTORY $assetName
  if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
    throw "Unexpected installer download: $assetName"
  }
  Copy-Item -LiteralPath $source -Destination $OutFile
}

function Write-Checksum {
  param(
    [Parameter(Mandatory)]
    [string]$FixtureDirectory,

    [Parameter(Mandatory)]
    [string]$ArtifactName,

    [string]$Checksum
  )

  $artifactPath = Join-Path $FixtureDirectory $ArtifactName
  if ([string]::IsNullOrWhiteSpace($Checksum)) {
    $Checksum = (Get-FileHash -LiteralPath $artifactPath -Algorithm SHA256).Hash.ToLowerInvariant()
  }
  [System.IO.File]::WriteAllText(
    (Join-Path $FixtureDirectory "checksums.txt"),
    "$Checksum  $ArtifactName"
  )
}

function Invoke-Installer {
  param(
    [Parameter(Mandatory)]
    [string]$FixtureDirectory,

    [Parameter(Mandatory)]
    [string]$InstallDirectory
  )

  $env:LINEARCTL_INSTALLER_TEST_FIXTURE_DIRECTORY = $FixtureDirectory
  & $installerPath -Version v9.9.9 -InstallDir $InstallDirectory
}

function Assert-InstalledContent {
  param(
    [Parameter(Mandatory)]
    [string]$InstallDirectory,

    [Parameter(Mandatory)]
    [string]$Expected
  )

  $installedBinary = Join-Path $InstallDirectory "linearctl.exe"
  if (-not (Test-Path -LiteralPath $installedBinary -PathType Leaf)) {
    throw "Installer did not create $installedBinary"
  }

  $actual = [System.IO.File]::ReadAllText($installedBinary)
  if ($actual -cne $Expected) {
    throw "Installed content did not match the selected release artifact."
  }
}

try {
  New-Item -ItemType Directory -Path $testRoot | Out-Null

  $zipFixture = Join-Path $testRoot "zip-fixture"
  $zipSource = Join-Path $testRoot "zip-source"
  New-Item -ItemType Directory -Path $zipFixture, $zipSource | Out-Null
  $zipContent = "zip release payload"
  [System.IO.File]::WriteAllText((Join-Path $zipSource "linearctl.exe"), $zipContent)
  Compress-Archive `
    -LiteralPath (Join-Path $zipSource "linearctl.exe") `
    -DestinationPath (Join-Path $zipFixture "linearctl-windows-x64.zip")
  Write-Checksum $zipFixture "linearctl-windows-x64.zip"

  $zipInstall = Join-Path $testRoot "zip-install"
  Invoke-Installer $zipFixture $zipInstall
  Assert-InstalledContent $zipInstall $zipContent

  $legacyFixture = Join-Path $testRoot "legacy-fixture"
  New-Item -ItemType Directory -Path $legacyFixture | Out-Null
  $legacyContent = "legacy release payload"
  [System.IO.File]::WriteAllText(
    (Join-Path $legacyFixture "linearctl-windows-x64.exe"),
    $legacyContent
  )
  Write-Checksum $legacyFixture "linearctl-windows-x64.exe"

  $legacyInstall = Join-Path $testRoot "legacy-install"
  Invoke-Installer $legacyFixture $legacyInstall
  Assert-InstalledContent $legacyInstall $legacyContent

  $layoutFixture = Join-Path $testRoot "layout-fixture"
  New-Item -ItemType Directory -Path $layoutFixture | Out-Null
  [System.IO.File]::WriteAllText((Join-Path $layoutFixture "wrong-name.exe"), "wrong layout")
  Compress-Archive `
    -LiteralPath (Join-Path $layoutFixture "wrong-name.exe") `
    -DestinationPath (Join-Path $layoutFixture "linearctl-windows-x64.zip")
  Remove-Item -LiteralPath (Join-Path $layoutFixture "wrong-name.exe")
  Write-Checksum $layoutFixture "linearctl-windows-x64.zip"

  $layoutError = $null
  try {
    Invoke-Installer $layoutFixture (Join-Path $testRoot "layout-install")
  } catch {
    $layoutError = $_.Exception.Message
  }
  if ($layoutError -notlike "*does not contain linearctl.exe at the archive root*") {
    throw "Installer did not reject an invalid ZIP layout. Error: $layoutError"
  }

  $checksumFixture = Join-Path $testRoot "checksum-fixture"
  New-Item -ItemType Directory -Path $checksumFixture | Out-Null
  Copy-Item `
    -LiteralPath (Join-Path $zipFixture "linearctl-windows-x64.zip") `
    -Destination (Join-Path $checksumFixture "linearctl-windows-x64.zip")
  Write-Checksum $checksumFixture "linearctl-windows-x64.zip" ("0" * 64)

  $checksumError = $null
  try {
    Invoke-Installer $checksumFixture (Join-Path $testRoot "checksum-install")
  } catch {
    $checksumError = $_.Exception.Message
  }
  if ($checksumError -notlike "Checksum mismatch for linearctl-windows-x64.zip*") {
    throw "Installer did not reject a checksum mismatch. Error: $checksumError"
  }

  Write-Host "Windows installer integration tests passed."
} finally {
  $env:LINEARCTL_INSTALLER_TEST_FIXTURE_DIRECTORY = $previousFixtureDirectory
  if (Test-Path -LiteralPath $testRoot) {
    Remove-Item -LiteralPath $testRoot -Recurse -Force
  }
}
