$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$serverScript = Join-Path $PSScriptRoot "lan-update-server.mjs"
$logDir = Join-Path $projectRoot "logs"
if (!(Test-Path $logDir)) {
  New-Item -ItemType Directory -Path $logDir | Out-Null
}
$logFile = Join-Path $logDir "lan-update-server.log"

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) {
  throw "Node.js not found in PATH."
}

Push-Location $projectRoot
try {
  & $node $serverScript *>> $logFile
} finally {
  Pop-Location
}
