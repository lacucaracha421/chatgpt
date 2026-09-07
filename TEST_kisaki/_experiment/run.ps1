param([switch]$Reanalyze, [int]$Port = 1439)
$ErrorActionPreference = 'Stop'
$pythonPath = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
if (!(Test-Path -LiteralPath $pythonPath)) { throw 'Missing experiment Python environment. See README.md.' }
if (!(Test-Path -LiteralPath (Join-Path $PSScriptRoot 'public\data.json'))) {
    & $pythonPath (Join-Path $PSScriptRoot 'analyze.py')
    if ($LASTEXITCODE -ne 0) { throw 'Analysis failed.' }
}
elseif ($Reanalyze) {
    & $pythonPath (Join-Path $PSScriptRoot 'incremental.py')
    if ($LASTEXITCODE -ne 0) { throw 'Append analysis failed. Existing data was retained.' }
}
Write-Host "Open http://127.0.0.1:$Port ; Ctrl+C to stop."
& $pythonPath (Join-Path $PSScriptRoot 'serve.py') --port $Port
exit $LASTEXITCODE
