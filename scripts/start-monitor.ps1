$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$Port = 8787
$LogDir = Join-Path $Root "logs"
$LogFile = Join-Path $LogDir "gpt-monitor.log"

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Write-MonitorLog($Message) {
  try {
    $Message | Out-File -FilePath $LogFile -Append -Encoding utf8
  } catch {
    Write-Output $Message
  }
}

$listener = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
  Select-Object -First 1

if ($listener) {
  $stamp = Get-Date -Format o
  Write-MonitorLog "[$stamp] GPT Pro Monitor already listening on 127.0.0.1:$Port (PID $($listener.OwningProcess))."
  exit 0
}

Set-Location -LiteralPath $Root
$started = Get-Date -Format o
Write-MonitorLog "[$started] Starting GPT Pro Monitor from $Root."
npm start *>> $LogFile
