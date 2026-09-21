# Create an isolated twin Harness home for end-to-end mesh verification.
#
# The twin shares the real profile's node_modules through a directory junction
# (so nothing is downloaded twice) and starts from a copy of the real session
# store and workspace registry (so the plugin under test has genuine workspaces
# and conversations to list). The live `dsh web` process is never touched.
#
# Usage:  pwsh -File tools/make-twin-home.ps1 -Name a
param(
  [Parameter(Mandatory = $true)][string]$Name,
  [string]$Source = "$env:USERPROFILE\.dsh"
)
$ErrorActionPreference = 'Stop'
function Remove-Twin {
  param([string]$Path)
  if (-not (Test-Path $Path)) { return }
  $modules = Join-Path $Path 'profiles\web\node_modules'
  if (Test-Path $modules) {
    $item = Get-Item -LiteralPath $modules -Force
    if ($item.LinkType) {
      # The directory itself is a junction into the real profile. Unlink it and
      # STOP: enumerating it would list — and then delete — the real profile's
      # own package links. (That mistake removed this plugin's link once.)
      cmd /c rmdir "$modules" 2>$null | Out-Null
    } else {
      # A real directory holding one junction per package: unlink those, so a
      # recursive delete can never walk into the real profile.
      Get-ChildItem -LiteralPath $modules -Force | Where-Object { $_.LinkType } | ForEach-Object {
        cmd /c rmdir "$($_.FullName)" 2>$null | Out-Null
      }
    }
  }
  Remove-Item $Path -Recurse -Force -ErrorAction SilentlyContinue
}

$dest = "$env:USERPROFILE\.dsh-mesh-$Name"
if (Test-Path $dest) {
  Write-Host "removing previous twin at $dest"
  Remove-Twin -Path $dest
}
New-Item -ItemType Directory -Force "$dest\profiles\web" | Out-Null
New-Item -ItemType Directory -Force "$dest\profiles\web\patches" | Out-Null
New-Item -ItemType Directory -Force "$dest\storages" | Out-Null

foreach ($file in 'package.json', 'cordis.yml', 'cordis.patch.yml', 'pnpm-workspace.yaml', 'pnpm-lock.yaml') {
  Copy-Item (Join-Path $Source "profiles\web\$file") "$dest\profiles\web\" -Force
}
Copy-Item (Join-Path $Source 'sessions') "$dest\sessions" -Recurse -Force
if (Test-Path (Join-Path $Source 'storages\workspace.json')) {
  Copy-Item (Join-Path $Source 'storages\workspace.json') "$dest\storages\" -Force
}
foreach ($file in 'settings.yaml', '.credentials.yaml', '.anonymous-user-id') {
  if (Test-Path (Join-Path $Source $file)) { Copy-Item (Join-Path $Source $file) "$dest\" -Force }
}

# Mirror node_modules as a real directory holding one junction per top-level
# entry, rather than junctioning the directory itself. Pnpm's store is still
# shared (nothing is downloaded twice), but a twin can now have a package
# removed or replaced — which is exactly what the rollback path does — without
# touching the real profile.
$modules = "$dest\profiles\web\node_modules"
New-Item -ItemType Directory -Force $modules | Out-Null
$sourceModules = Join-Path $Source 'profiles\web\node_modules'
$linked = 0
Get-ChildItem -LiteralPath $sourceModules -Force | Where-Object { $_.Name -ne '.pnpm' } | ForEach-Object {
  $target = $_.FullName
  $link = Join-Path $modules $_.Name
  cmd /c mklink /J "$link" "$target" | Out-Null
  $linked += 1
}
Write-Host "linked $linked top-level packages into the twin"
Write-Host "twin home ready: $dest"
Write-Host "start it with:  `$env:DSH_HOME='$dest'; dsh web --port <port> --no-open"
