$ErrorActionPreference = "Stop"

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$appRoot = Join-Path $repositoryRoot "app"

Push-Location $appRoot
try {
    npm.cmd run tauri -- build --debug
}
finally {
    Pop-Location
}
