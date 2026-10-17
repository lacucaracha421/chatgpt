$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$extension = Join-Path $repo "extension-list"
$publishRoot = Join-Path $env:LOCALAPPDATA "Lakomics\ExtensionDev"
$zip = Join-Path $publishRoot "latest.zip"
$port = 32147

Push-Location $extension
try {
    npm test
    if ($LASTEXITCODE -ne 0) { throw "Extension tests failed." }
} finally {
    Pop-Location
}

python (Join-Path $PSScriptRoot "build-extension-slim.py") --out $publishRoot
if ($LASTEXITCODE -ne 0) { throw "Slim extension packaging failed." }
$manifest = Get-Content (Join-Path $extension "manifest.json") -Raw | ConvertFrom-Json

$tailscaleIp = (& tailscale ip -4 | Select-Object -First 1).Trim()
if (-not $tailscaleIp) { throw "Tailscale IPv4 address not found." }

Get-CimInstance Win32_Process |
    Where-Object { $_.CommandLine -match "http\.server $port" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

$python = (Get-Command python).Source
Start-Process -FilePath $python -ArgumentList @(
    "-m", "http.server", "$port", "--bind", $tailscaleIp,
    "--directory", "`"$publishRoot`""
) -WindowStyle Hidden

Start-Sleep -Milliseconds 500
Write-Host "Published $($manifest.version): $zip"
Write-Host "Tablet URL: http://${tailscaleIp}:$port/latest.zip"
