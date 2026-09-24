<#
.SYNOPSIS
Restart the Harness web app so a profile plugin change takes effect, verify the
plugin actually loaded, and roll the plugin back automatically if it did not.

.DESCRIPTION
Profile plugins are loaded by the host process, so installing one has no effect
until `dsh web` restarts. This script does that restart safely:

  1. verifies what is running now (and, with -Verify, changes nothing),
  2. stops the process listening on the port,
  3. starts a fresh detached `dsh web`,
  4. probes the plugin's own route until it answers — a route that returns 405
     means the plugin did NOT load, because that is what the SPA fallback
     answers for an unclaimed path,
  5. on failure, removes the plugin from the profile, restarts again, and leaves
     a log explaining what happened.

Run it from a normal terminal, NOT from inside the Harness GUI: the restart
kills the process tree the GUI runs in, so a script launched from that process
would be killed mid-rollback.

.PARAMETER Verify
Only probe the running instance. Changes nothing, exits 0 when the plugin's
route is live and 1 when it is not.

.PARAMETER Rollback
Remove the plugin from the profile, restart, and verify the plain GUI is back.

.EXAMPLE
pwsh -File .\tools\activate.ps1
.EXAMPLE
pwsh -File .\tools\activate.ps1 -Verify -Port 3080
#>
param(
  [int]$Port = 3080,
  [string]$Profile = 'web',
  [string]$PluginName = 'dsh-remote-mesh',
  [string]$Route = '/remote-workspaces',
  [int]$TimeoutSec = 120,
  [switch]$Verify,
  [switch]$Rollback
)

$ErrorActionPreference = 'Stop'
$script:logFile = Join-Path $PSScriptRoot 'activate.log'

function Write-Log {
  param([string]$Message)
  $line = "{0} {1}" -f (Get-Date -Format 'yyyy-MM-ddTHH:mm:ss'), $Message
  Write-Host $line
  Add-Content -LiteralPath $script:logFile -Value $line -Encoding UTF8
}

function Write-TextFile {
  param([string]$Path, [string]$Text)
  # Must not add a BOM: Node's JSON.parse rejects it.
  [System.IO.File]::WriteAllText($Path, $Text, (New-Object System.Text.UTF8Encoding($false)))
}

function Get-DshHome {
  if ($env:DSH_HOME -and $env:DSH_HOME.Trim() -ne '') { return $env:DSH_HOME.Trim() }
  return (Join-Path $env:USERPROFILE '.dsh')
}

function Get-ProfileDir {
  return (Join-Path (Get-DshHome) "profiles\$Profile")
}

function Resolve-DshBin {
  $roots = @()
  try { $roots += (npm root -g) } catch { }
  $roots += (Join-Path $env:APPDATA 'npm\node_modules')
  $roots += (Join-Path $env:ProgramFiles 'nodejs\node_modules')
  foreach ($root in $roots) {
    if (-not $root) { continue }
    $candidate = Join-Path $root '@deepseek-ai\dsh\lib\bin.js'
    if (Test-Path $candidate) { return $candidate }
  }
  throw "cannot find @deepseek-ai/dsh/lib/bin.js; looked in: $($roots -join ', ')"
}

# Returns 'live' | 'missing' | 'down'
function Test-PluginRoute {
  param([int]$TargetPort)
  $url = "http://127.0.0.1:$TargetPort$Route/state"
  $body = '{"type":"client-request","rpcId":"probe","method":"state","payload":{}}'
  try {
    $response = Invoke-WebRequest -Uri $url -Method POST -Body $body -ContentType 'application/json' -UseBasicParsing -TimeoutSec 10
    # Any real answer (200 with the token, 401 without) means the route is ours.
    if ($response.StatusCode -eq 200 -or $response.StatusCode -eq 401) { return 'live' }
    return 'missing'
  } catch {
    $resp = $_.Exception.Response
    if ($resp) {
      $code = [int]$resp.StatusCode
      if ($code -eq 401 -or $code -eq 403) { return 'live' }
      if ($code -eq 405) { return 'missing' }
      return "http-$code"
    }
    return 'down'
  }
}

function Get-ListenerPids {
  param([int]$TargetPort)
  $pids = @()
  try {
    $pids += (Get-NetTCPConnection -State Listen -LocalPort $TargetPort -ErrorAction Stop | Select-Object -ExpandProperty OwningProcess)
  } catch {
    try { $pids += (Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -eq $TargetPort } | Select-Object -ExpandProperty OwningProcess) } catch { }
  }
  return ($pids | Where-Object { $_ } | Sort-Object -Unique)
}

function Remove-PluginFromProfile {
  $dir = Get-ProfileDir
  $packageFile = Join-Path $dir 'package.json'
  if (-not (Test-Path $packageFile)) { throw "no profile package.json at $packageFile" }
  $backup = "$packageFile.bak-$(Get-Date -Format 'yyyyMMddHHmmss')"
  Copy-Item -LiteralPath $packageFile -Destination $backup -Force
  Write-Log "backed up profile package.json to $backup"
  $text = [System.IO.File]::ReadAllText($packageFile)
  $json = $text | ConvertFrom-Json
  if ($json.dsh -and $json.dsh.profile -and $json.dsh.profile.bundles) {
    $json.dsh.profile.bundles = @($json.dsh.profile.bundles | Where-Object { $_ -ne $PluginName })
  }
  if ($json.dependencies -and ($json.dependencies.PSObject.Properties.Name -contains $PluginName)) {
    $json.dependencies.PSObject.Properties.Remove($PluginName)
  }
  Write-TextFile -Path $packageFile -Text ($json | ConvertTo-Json -Depth 12)
  $link = Join-Path $dir "node_modules\$PluginName"
  if (Test-Path $link) {
    cmd /c rmdir "$link" 2>$null | Out-Null
    Write-Log "removed $link"
  }
  Write-Log "removed $PluginName from the $Profile profile"
}

function Stop-Instance {
  param([int]$TargetPort)
  $pids = Get-ListenerPids -TargetPort $TargetPort
  if (-not $pids) { Write-Log "nothing is listening on $TargetPort"; return }
  foreach ($procId in $pids) {
    $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
    Write-Log "stopping PID $procId ($($proc.ProcessName)) on port $TargetPort"
    Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
  }
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 250
    if (-not (Get-ListenerPids -TargetPort $TargetPort)) { return }
  }
  Write-Log "WARNING: port $TargetPort still has a listener"
}

function Start-Instance {
  param([int]$TargetPort, [string]$DshBin)
  $out = Join-Path $PSScriptRoot "dsh-web-$TargetPort.out.log"
  $err = Join-Path $PSScriptRoot "dsh-web-$TargetPort.err.log"
  Write-Log "starting: node $DshBin --profile $Profile --port $TargetPort --no-open"
  # A process created through WMI does NOT inherit this shell's environment, so
  # every fact the Harness depends on is passed explicitly. Node is invoked by
  # absolute path for the same reason: PATH comes from the service environment.
  # (Getting this wrong once launched a second instance against the wrong
  # harness home — hence the explicit DSH_HOME.)
  $nodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
  if (-not $nodeExe) { $nodeExe = 'node' }
  # ($HOME is a read-only PowerShell automatic variable, hence the longer name.)
  $dshHomeValue = Get-DshHome
  $inner = "set `"DSH_HOME=$dshHomeValue`" && `"$nodeExe`" `"$DshBin`" --profile $Profile --port $TargetPort --no-open > `"$out`" 2> `"$err`""
  # Deliberately detached, twice over: a child of this console dies when the
  # terminal is closed (Windows sends CTRL_CLOSE to everything attached to it),
  # and a child of whatever job launched this script dies with that job.
  # Win32_Process.Create parents the new process to WMI, so the Harness outlives
  # both the terminal and the caller.
  $detached = $false
  try {
    $created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create `
      -Arguments @{ CommandLine = "cmd.exe /c $inner" } -ErrorAction Stop
    if ($created.ReturnValue -eq 0) {
      Write-Log "launched detached as pid $($created.ProcessId)"
      $detached = $true
    } else {
      Write-Log "detached launch returned code $($created.ReturnValue); falling back"
    }
  } catch {
    Write-Log "detached launch unavailable ($($_.Exception.Message)); falling back to Start-Process"
  }
  if (-not $detached) {
    Start-Process -FilePath $nodeExe `
      -ArgumentList @($DshBin, '--profile', $Profile, '--port', "$TargetPort", '--no-open') `
      -WindowStyle Hidden -RedirectStandardOutput $out -RedirectStandardError $err | Out-Null
  }
  return @{ stdout = $out; stderr = $err }
}

function Wait-ForRoute {
  param([int]$TargetPort, [int]$Seconds, [switch]$AnyResponse)
  $deadline = (Get-Date).AddSeconds($Seconds)
  $last = 'down'
  while ((Get-Date) -lt $deadline) {
    $last = Test-PluginRoute -TargetPort $TargetPort
    if ($last -eq 'live') { return $last }
    if ($AnyResponse -and $last -eq 'missing') { return 'up-without-plugin' }
    Start-Sleep -Seconds 2
  }
  return $last
}

# ---------------------------------------------------------------- verify only
if ($Verify) {
  $state = Test-PluginRoute -TargetPort $Port
  Write-Host "port $Port plugin route: $state"
  if ($state -eq 'live') { exit 0 }
  exit 1
}

Write-Log "=== activate $PluginName on profile '$Profile', port $Port ==="
$DshBin = Resolve-DshBin

if ($Rollback) {
  Remove-PluginFromProfile
  Stop-Instance -TargetPort $Port
  Start-Instance -TargetPort $Port -DshBin $DshBin | Out-Null
  $state = Wait-ForRoute -TargetPort $Port -Seconds $TimeoutSec -AnyResponse
  Write-Log "after rollback, GUI response: $state"
  if ($state -eq 'up-without-plugin' -or $state -eq 'live') {
    Write-Log 'rollback complete: the GUI is serving again without the plugin'
    exit 0
  }
  Write-Log 'rollback FAILED: the GUI did not come back; check dsh-web-*.err.log'
  exit 2
}

$before = Test-PluginRoute -TargetPort $Port
Write-Log "before: plugin route is '$before'"

Stop-Instance -TargetPort $Port
$logs = Start-Instance -TargetPort $Port -DshBin $DshBin
$state = Wait-ForRoute -TargetPort $Port -Seconds $TimeoutSec

if ($state -eq 'live') {
  Write-Log "OK: $PluginName is loaded and answering on http://127.0.0.1:$Port$Route/"
  Write-Log 'open the GUI and look for the remote-workspaces entry in the sidebar'
  exit 0
}

Write-Log "FAILED: after ${TimeoutSec}s the plugin route is '$state'"
if (Test-Path $logs.stderr) {
  Write-Log '--- last lines of the host stderr ---'
  Get-Content -LiteralPath $logs.stderr -Tail 40 | ForEach-Object { Write-Log $_ }
}
Write-Log 'rolling the plugin back so the GUI keeps working'
Remove-PluginFromProfile
Stop-Instance -TargetPort $Port
Start-Instance -TargetPort $Port -DshBin $DshBin | Out-Null
$after = Wait-ForRoute -TargetPort $Port -Seconds $TimeoutSec -AnyResponse
Write-Log "after rollback the GUI answers: $after"
if ($after -eq 'up-without-plugin' -or $after -eq 'live') {
  Write-Log 'the GUI is serving again without the plugin; fix the plugin and re-run this script'
  exit 3
}
Write-Log 'the GUI did not come back even after the rollback; see dsh-web-*.err.log'
exit 4
