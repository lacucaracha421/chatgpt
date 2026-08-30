$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$extension = Join-Path $repo "extension"
$publishRoot = Join-Path $env:LOCALAPPDATA "Lakomics\ExtensionDev"
$stage = Join-Path $publishRoot "unpacked"
$zip = Join-Path $publishRoot "latest.zip"
$port = 32147

Push-Location $extension
try {
    npm test
    if ($LASTEXITCODE -ne 0) { throw "Extension tests failed." }
} finally {
    Pop-Location
}

Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
New-Item $stage -ItemType Directory -Force | Out-Null
Copy-Item (Join-Path $extension "manifest.json") $stage
Copy-Item (Join-Path $extension "src") $stage -Recurse
Copy-Item (Join-Path $extension "options") $stage -Recurse
Copy-Item (Join-Path $extension "icons") $stage -Recurse

Remove-Item $zip -Force -ErrorAction SilentlyContinue
python (Join-Path $PSScriptRoot "pack-extension-zip.py") $stage $zip
if ($LASTEXITCODE -ne 0) { throw "Extension ZIP packaging failed." }
$manifest = Get-Content (Join-Path $extension "manifest.json") -Raw | ConvertFrom-Json
$manifest.version_name | Set-Content (Join-Path $publishRoot "version.txt") -Encoding utf8

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
Write-Host "Published $($manifest.version_name): $zip"
Write-Host "Tablet URL: http://${tailscaleIp}:$port/latest.zip"
