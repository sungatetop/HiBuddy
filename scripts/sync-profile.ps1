# Links every in-repo profile (profile/*/package.json) into the dsh home so
# `dsh --profile <name>` resolves it (the dsh CLI only boots profiles under
# $DSH_HOME/profiles/<name>).
# Idempotent: re-running prints the existing links.
#
# Usage:  pwsh scripts/sync-profile.ps1 [-DshHome <path>]
#         (DshHome defaults to $env:DSH_HOME, then ~/.dsh)
# Boot:   dsh --profile hibuddy --dump-config          # product (web) stack
#         dsh --profile hibuddy-smoke "<task>"         # headless one-shot smoke
param(
  [string]$DshHome = $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' })
)
$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$profilesDir = Join-Path $DshHome 'profiles'
New-Item -ItemType Directory -Force -Path $profilesDir | Out-Null

$profileDirs = Get-ChildItem (Join-Path $repoRoot 'profile') -Directory |
  Where-Object { Test-Path (Join-Path $_.FullName 'package.json') }
if ($profileDirs.Count -eq 0) {
  Write-Error "no profiles found under $repoRoot\profile (each needs a package.json)"
}

foreach ($dir in $profileDirs) {
  $target = Join-Path $profilesDir $dir.Name
  if (Test-Path $target) {
    $item = Get-Item $target -Force
    if ($item.LinkType -eq 'Junction') {
      Write-Host "already linked: $target -> $($item.Target)"
      continue
    }
    Write-Error "$target already exists and is not a junction. Remove it or point DSH_HOME elsewhere."
  }
  New-Item -ItemType Junction -Path $target -Target $dir.FullName | Out-Null
  Write-Host "linked: $target -> $($dir.FullName)"
}
Write-Host 'verify with: dsh --profile hibuddy --dump-config'
