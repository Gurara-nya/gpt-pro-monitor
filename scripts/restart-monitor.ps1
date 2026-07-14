[CmdletBinding()]
param(
  [ValidateRange(1, 65535)]
  [int]$Port = 8787,

  [ValidateRange(1, 300)]
  [int]$TimeoutSeconds = 30,

  [string]$TaskName = "GPT Pro Monitor"
)

$ErrorActionPreference = "Stop"
$Address = "127.0.0.1"

function Get-MonitorListener {
  Get-NetTCPConnection -LocalAddress $Address -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
    Select-Object -First 1
}

function Get-MonitorProcess($Listener) {
  if (-not $Listener) {
    return $null
  }

  $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($Listener.OwningProcess)" -ErrorAction SilentlyContinue
  if (-not $process) {
    return $null
  }

  if ($process.Name -ne "node.exe" -or $process.CommandLine -notmatch "(?i)(^|\s)server\.js(\s|$)") {
    throw "Port $Port is owned by an unexpected process (PID $($Listener.OwningProcess)); restart aborted."
  }

  return $process
}

function Wait-ForListener([bool]$Expected, [datetime]$Deadline) {
  do {
    $listener = Get-MonitorListener
    if ([bool]$listener -eq $Expected) {
      return $listener
    }
    Start-Sleep -Milliseconds 250
  } while ((Get-Date) -lt $Deadline)

  return Get-MonitorListener
}

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $task) {
  throw "Scheduled task '$TaskName' was not found. Configure GPT Monitor autostart first."
}

$oldListener = Get-MonitorListener
$oldProcessId = if ($oldListener) { [int]$oldListener.OwningProcess } else { 0 }

Write-Host "Stopping scheduled task '$TaskName'..."
Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue

$listener = Wait-ForListener -Expected $false -Deadline (Get-Date).AddSeconds(5)
if ($listener) {
  $process = Get-MonitorProcess $listener
  if ($process) {
    Write-Host "Stopping remaining monitor process (PID $($process.ProcessId))..."
    Stop-Process -Id $process.ProcessId -Force
  }
}

$listener = Wait-ForListener -Expected $false -Deadline (Get-Date).AddSeconds(5)
if ($listener) {
  throw "Port $Port did not stop listening."
}

Write-Host "Starting scheduled task '$TaskName'..."
Start-ScheduledTask -TaskName $TaskName

$listener = Wait-ForListener -Expected $true -Deadline (Get-Date).AddSeconds($TimeoutSeconds)
if (-not $listener) {
  $taskState = (Get-ScheduledTask -TaskName $TaskName).State
  $lastResult = (Get-ScheduledTaskInfo -TaskName $TaskName).LastTaskResult
  throw "GPT Monitor did not listen on ${Address}:$Port within $TimeoutSeconds seconds (task state: $taskState, result: $lastResult)."
}

$process = Get-MonitorProcess $listener
if (-not $process) {
  throw "GPT Monitor listener appeared, but its process could not be verified."
}

Write-Host "GPT Monitor is ready at http://${Address}:$Port (PID $($process.ProcessId), previous PID $oldProcessId)."
