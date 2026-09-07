param(
    [int]$Port = 1441,
    [double]$Score = 0.30,
    [double]$Nms = 0.45,
    [double]$Margin = 0.18,
    [int]$MaxBoxes = 8,
    [switch]$ServeOnly
)
$ErrorActionPreference = 'Stop'
$pythonPath = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
if (!(Test-Path -LiteralPath $pythonPath)) {
    throw 'Missing experiment Python environment. See README.md.'
}
if (!$ServeOnly) {
    & $pythonPath (Join-Path $PSScriptRoot 'crop_ccip.py') `
        --score $Score --nms $Nms --margin $Margin --max-boxes $MaxBoxes
    if ($LASTEXITCODE -ne 0) { throw 'Crop experiment failed.' }
}
if (!(Test-Path -LiteralPath (Join-Path $PSScriptRoot 'public\crop-data.json'))) {
    throw 'Missing crop-data.json. Run without -ServeOnly first.'
}
Write-Host "Open http://127.0.0.1:$Port/crop-report.html ; Ctrl+C to stop."
& $pythonPath (Join-Path $PSScriptRoot 'serve.py') --port $Port
exit $LASTEXITCODE
