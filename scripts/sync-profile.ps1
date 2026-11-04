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
    } else {
      Write-Error "$target already exists and is not a junction. Remove it or point DSH_HOME elsewhere."
    }
  } else {
    New-Item -ItemType Junction -Path $target -Target $dir.FullName | Out-Null
    Write-Host "linked: $target -> $($dir.FullName)"
  }

  # pnpm links workspace deps as RELATIVE symlinks (..\..\..\packages\x) and so does
  # the plugin manager for registry deps (..\..\..\.pnpm\<pkg>@ver\...). Inside the
  # junction view ($DSH_HOME\profiles\<name>) those relatives resolve against the dsh
  # home and break imports at boot (S6-3: a UI-installed third-party plugin, e.g.
  # dsh-plugin-whale-pet, hit ERR_MODULE_NOT_FOUND on every restart — the plugin
  # manager's top-level node_modules link was NOT covered by the scoped-only fix).
  # Rewrite every relative symlink under node_modules (top level and @scope/ dirs)
  # to an absolute one so both views resolve; node_modules is gitignored, so this
  # stays machine-local. Run this after installing or removing plugins via the UI.
  $scopedDir = Join-Path $dir.FullName 'node_modules'
  $linkDirs = @($scopedDir) + (
    Get-ChildItem $scopedDir -Directory -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -like '@*' } | ForEach-Object { $_.FullName }
  )
  foreach ($linkDir in $linkDirs) {
    foreach ($link in Get-ChildItem $linkDir -ErrorAction SilentlyContinue) {
      $item = Get-Item $link.FullName -Force
      if ($item.LinkType -ne 'SymbolicLink') { continue }
      # .Target can arrive as a string[] (Windows PowerShell 5.1); take the first.
      $targetSpec = @($item.Target)[0]
      if ($targetSpec -match '^[A-Za-z]:[\\/]') { continue }
      $resolvedTarget = [System.IO.Path]::GetFullPath((Join-Path $linkDir $targetSpec))
      if ($resolvedTarget.StartsWith($repoRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        $item.Delete()
        # Junction, not SymbolicLink: junctions need no elevation, which the
        # sandboxed shell does not have, and the target is a directory anyway.
        New-Item -ItemType Junction -Path $item.FullName -Target $resolvedTarget | Out-Null
        Write-Host "absolutized: $($item.FullName) -> $resolvedTarget"
      }
    }
  }
}
Write-Host 'verify with: dsh --profile hibuddy --dump-config'
