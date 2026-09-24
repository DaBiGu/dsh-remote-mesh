<#
.SYNOPSIS
Register (or remove) the scheduled tasks that keep the mesh reachable.

.DESCRIPTION
For remote work to be possible at all, the machine you want to reach has to have
its Harness web app running. This script registers two Windows scheduled tasks:

  dsh-web         starts `dsh web` at logon for the current user
  dsh-mesh-relay  starts the mesh relay at boot (run this one ON THE SERVER)

The relay secret is written to `relay-secret.txt` next to the relay and read by a
generated `run-relay.cmd`, so the secret never appears in the task definition.

Run this in an elevated PowerShell to register the relay task; the `dsh-web`
task does not need elevation.

.EXAMPLE
pwsh -File .\tools\install-autostart.ps1 -What dsh-web -Port 3080
.EXAMPLE
pwsh -File .\tools\install-autostart.ps1 -What mesh-relay -RelayDir C:\dsh-remote-mesh
.EXAMPLE
pwsh -File .\tools\install-autostart.ps1 -What both -Remove
.EXAMPLE
pwsh -File .\tools\install-autostart.ps1 -What mesh-relay -Remove -PurgeSecret
#>
param(
  [ValidateSet('dsh-web', 'mesh-relay', 'both')]
  [string]$What = 'dsh-web',
  [int]$Port = 3080,
  [string]$Profile = 'web',
  [int]$RelayPort = 8787,
  [string]$RelayDir = 'C:\dsh-remote-mesh',
  [string]$RelaySecret = '',
  [switch]$Remove,
  # With -Remove: also delete relay-secret.txt (kept by default, because every
  # other machine has that value in its plugin settings).
  [switch]$PurgeSecret
)

$ErrorActionPreference = 'Stop'

function Write-TextFile {
  param([string]$Path, [string]$Text)
  [System.IO.File]::WriteAllText($Path, $Text, (New-Object System.Text.UTF8Encoding($false)))
}

function Test-IsElevated {
  try {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  } catch {
    return $false
  }
}

function Resolve-DshBin {
  $roots = @()
  try { $roots += (npm root -g) } catch { }
  $roots += (Join-Path $env:APPDATA 'npm\node_modules')
  foreach ($root in $roots) {
    if (-not $root) { continue }
    $candidate = Join-Path $root '@deepseek-ai\dsh\lib\bin.js'
    if (Test-Path $candidate) { return $candidate }
  }
  throw 'cannot find @deepseek-ai/dsh/lib/bin.js'
}

function Install-DshWebTask {
  $bin = Resolve-DshBin
  $action = New-ScheduledTaskAction -Execute 'node' -Argument "`"$bin`" --profile $Profile --port $Port --no-open"
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
  Register-ScheduledTask -TaskName 'dsh-web' -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
  Write-Host "registered dsh-web: node `"$bin`" --profile $Profile --port $Port --no-open (at logon)"
}

function Install-RelayTask {
  if (-not (Test-Path (Join-Path $RelayDir 'bin\mesh-relay.mjs'))) {
    throw "$RelayDir\bin\mesh-relay.mjs not found; copy the dsh-remote-mesh folder there first"
  }
  $secret = $RelaySecret
  if (-not $secret) {
    $existing = Join-Path $RelayDir 'relay-secret.txt'
    if (Test-Path $existing) {
      $secret = ([System.IO.File]::ReadAllText($existing)).Trim()
      Write-Host "reusing the existing relay secret in $existing"
    } else {
      $secret = & node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
      Write-Host "generated a new relay secret"
    }
  }
  $secretFile = Join-Path $RelayDir 'relay-secret.txt'
  Write-TextFile -Path $secretFile -Text $secret
  # Lock the secret down to this account and SYSTEM.
  & icacls $secretFile /inheritance:r /grant:r "$($env:USERNAME):(R)" 'SYSTEM:(R)' | Out-Null
  $launcher = Join-Path $RelayDir 'run-relay.cmd'
  Write-TextFile -Path $launcher -Text @"
@echo off
set /p MESH_RELAY_SECRET=<"%~dp0relay-secret.txt"
node "%~dp0bin\mesh-relay.mjs" --port $RelayPort --host 127.0.0.1
"@
  Write-Host "wrote $launcher and $secretFile"

  # The task runs as SYSTEM, so registering it needs an elevated shell. Say so
  # instead of surfacing a raw access-denied, and leave the operator with the
  # exact command to finish the job by hand.
  if (-not (Test-IsElevated)) {
    Write-Host ''
    Write-Host 'NOT REGISTERED: a task that runs as SYSTEM needs an elevated PowerShell.' -ForegroundColor Yellow
    Write-Host '  Open PowerShell as Administrator and re-run the same command, or start the'
    Write-Host '  relay yourself (it is the same command the task would run):'
    Write-Host "    $launcher"
    Write-Host ''
    Write-Host 'Everything else is ready: the secret file, its ACL, and the launcher above.'
    exit 1
  }

  $action = New-ScheduledTaskAction -Execute $launcher -WorkingDirectory $RelayDir
  $trigger = New-ScheduledTaskTrigger -AtStartup
  $settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
  $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  Register-ScheduledTask -TaskName 'dsh-mesh-relay' -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
  Write-Host "registered dsh-mesh-relay: $launcher (at startup, as SYSTEM)"
  Write-Host ''
  Write-Host 'Put this same secret in the plugin settings on every machine:'
  Write-Host "  $secret"
}

function Remove-Tasks {
  foreach ($name in 'dsh-web', 'dsh-mesh-relay') {
    if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
      Unregister-ScheduledTask -TaskName $name -Confirm:$false
      Write-Host "removed task $name"
    } else {
      Write-Host "task $name was not registered"
    }
  }
  # The launcher holds no secret of its own (it reads relay-secret.txt), so it is
  # always safe to drop. Deleting the *secret* is a different matter: every other
  # machine has that value in its plugin settings, so it is kept unless asked for.
  $launcher = Join-Path $RelayDir 'run-relay.cmd'
  if (Test-Path $launcher) {
    Remove-Item -LiteralPath $launcher -Force
    Write-Host "removed $launcher"
  }
  $secretFile = Join-Path $RelayDir 'relay-secret.txt'
  if (-not (Test-Path $secretFile)) { return }
  if (-not $PurgeSecret) {
    Write-Host ''
    Write-Host "kept $secretFile -- every other machine still needs that secret."
    Write-Host 'To delete it as well, re-run with -PurgeSecret.'
    return
  }
  # The install step gave this file an ACL that grants read only (no delete) to
  # this account, so a plain Remove-Item fails with access denied. Restore
  # inheritance first: that is also what makes the removal actually work when
  # the file is owned by this account.
  & icacls $secretFile /reset 2>&1 | Out-Null
  try {
    Remove-Item -LiteralPath $secretFile -Force -ErrorAction Stop
    Write-Host "purged $secretFile -- generate a new secret on the next install"
  } catch {
    Write-Host "could not delete ${secretFile}: $($_.Exception.Message)" -ForegroundColor Yellow
    Write-Host '  Run an elevated PowerShell, or delete it by hand, to finish.'
    exit 1
  }
}

if ($Remove) {
  Remove-Tasks
  exit 0
}

if ($What -eq 'dsh-web' -or $What -eq 'both') { Install-DshWebTask }
if ($What -eq 'mesh-relay' -or $What -eq 'both') { Install-RelayTask }
