# Install ado-stack from GitHub Releases on Windows.
# Public repos: irm https://raw.githubusercontent.com/drrius/ado-stack/main/install.ps1 | iex
# Private repos: authenticate with GitHub CLI first, then run this script locally.
$ErrorActionPreference = "Stop"

$Repo = if ($env:ADO_STACK_GITHUB_REPO) { $env:ADO_STACK_GITHUB_REPO } else { "drrius/ado-stack" }
$Version = if ($env:ADO_STACK_VERSION) { $env:ADO_STACK_VERSION } else { "latest" }
$Prefix = if ($env:ADO_STACK_INSTALL_DIR) { $env:ADO_STACK_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA "ado-stack\bin" }

$Asset = "ado-stack-windows-x64.exe"
$Tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("ado-stack-" + [guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $Tmp | Out-Null

try {
  if ($Version -eq "latest") {
    $Base = "https://github.com/$Repo/releases/latest/download"
  } else {
    $Base = "https://github.com/$Repo/releases/download/$Version"
  }

  $AssetPath = Join-Path $Tmp $Asset
  $SumPath = Join-Path $Tmp "SHA256SUMS"
  $gh = Get-Command gh -ErrorAction SilentlyContinue
  if ($gh) {
    if ($Version -eq "latest") {
      & gh release download --repo $Repo --pattern $Asset --dir $Tmp
      & gh release download --repo $Repo --pattern SHA256SUMS --dir $Tmp
    } else {
      & gh release download $Version --repo $Repo --pattern $Asset --dir $Tmp
      & gh release download $Version --repo $Repo --pattern SHA256SUMS --dir $Tmp
    }
  } else {
    try {
      Invoke-WebRequest -Uri "$Base/$Asset" -OutFile $AssetPath -UseBasicParsing
      Invoke-WebRequest -Uri "$Base/SHA256SUMS" -OutFile $SumPath -UseBasicParsing
    } catch {
      Write-Error "Download failed. If $Repo is private, install GitHub CLI, run gh auth login, and retry."
      throw
    }
  }

  $Expected = (Get-Content $SumPath | Where-Object { $_ -match "\s$Asset$" } | ForEach-Object { ($_ -split "\s+")[0] } | Select-Object -First 1)
  if (-not $Expected) {
    throw "No SHA256 entry for $Asset"
  }
  $Actual = (Get-FileHash -Algorithm SHA256 -Path $AssetPath).Hash.ToLowerInvariant()
  if ($Expected.ToLowerInvariant() -ne $Actual) {
    throw "Checksum mismatch for $Asset. Expected $Expected, got $Actual"
  }

  New-Item -ItemType Directory -Path $Prefix -Force | Out-Null
  $Dest = Join-Path $Prefix "ado-stack.exe"
  Copy-Item -Force $AssetPath $Dest
  Write-Host "Installed $Dest"
  $PathParts = $env:Path -split ";"
  if ($PathParts -notcontains $Prefix) {
    Write-Host "Add $Prefix to PATH to run ado-stack from any prompt."
  }
} finally {
  Remove-Item -Recurse -Force $Tmp -ErrorAction SilentlyContinue
}
