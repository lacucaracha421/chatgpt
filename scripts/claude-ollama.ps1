[CmdletBinding()]
param(
    [switch]$Check,
    [switch]$SmokeTest,
    [string]$Model = "glm-5.3-flash:cloud",
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$ClaudeArguments
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$ollamaApiUrl = "http://127.0.0.1:11434/api/version"

function Resolve-InstalledExecutable {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name,
        [Parameter(Mandatory = $true)]
        [string[]]$FallbackPaths
    )

    $command = Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($command) {
        return $command.Source
    }

    foreach ($path in $FallbackPaths) {
        if ($path -and (Test-Path -LiteralPath $path -PathType Leaf)) {
            return (Resolve-Path -LiteralPath $path).Path
        }
    }

    throw "$Name was not found. Install it and rerun this launcher."
}

function Get-OllamaApiVersion {
    try {
        $response = Invoke-RestMethod -Uri $ollamaApiUrl -TimeoutSec 1
        return [string]$response.version
    }
    catch {
        return $null
    }
}

function Wait-ForOllamaApi {
    param(
        [Parameter(Mandatory = $true)]
        [System.Diagnostics.Process]$ServerProcess
    )

    $deadline = [DateTime]::UtcNow.AddSeconds(20)
    do {
        if ($ServerProcess.HasExited) {
            throw "ollama serve exited before the API became ready. Open the Ollama app and try again."
        }

        $version = Get-OllamaApiVersion
        if ($version) {
            return $version
        }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $deadline)

    throw "Ollama did not become ready at $ollamaApiUrl within 20 seconds."
}

$claudeFallbacks = @()
if ($env:USERPROFILE) {
    $claudeFallbacks += Join-Path $env:USERPROFILE ".local\bin\claude.exe"
}
$ollamaFallbacks = @()
if ($env:LOCALAPPDATA) {
    $ollamaFallbacks += Join-Path $env:LOCALAPPDATA "Programs\Ollama\ollama.exe"
}

$claudePath = Resolve-InstalledExecutable -Name "claude" -FallbackPaths $claudeFallbacks
$ollamaPath = Resolve-InstalledExecutable -Name "ollama" -FallbackPaths $ollamaFallbacks

$pathSeparator = [System.IO.Path]::PathSeparator
$processPaths = @(
    Split-Path -Parent $claudePath
    Split-Path -Parent $ollamaPath
) | Select-Object -Unique
$env:PATH = (($processPaths + @($env:PATH)) -join $pathSeparator)

if ($Check) {
    Write-Output "Repository: $repositoryRoot"
    Write-Output "Claude Code: $claudePath"
    Write-Output "Ollama: $ollamaPath"
    Write-Output "Model: $Model"
    exit 0
}

$ollamaVersion = Get-OllamaApiVersion
if (-not $ollamaVersion) {
    Write-Output "Starting Ollama on 127.0.0.1:11434..."
    $serverProcess = Start-Process `
        -FilePath $ollamaPath `
        -ArgumentList "serve" `
        -WindowStyle Hidden `
        -PassThru
    $ollamaVersion = Wait-ForOllamaApi -ServerProcess $serverProcess
}
Write-Output "Ollama $ollamaVersion is ready."

$launchArguments = @("launch", "claude", "--model", $Model)
if ($SmokeTest) {
    $smokePrompt = @"
This is a read-only project configuration smoke test. Do not edit files, run mutating commands, or change external state.
Read the project memory and inspect the available project skills. Report concise evidence for all of these:
1. CLAUDE.md is loaded and imports AGENTS.md.
2. The using-superpowers gate is active.
3. Project skills include brainstorming, systematic-debugging, test-driven-development, and verification-before-completion.
4. State the repository verification rule in one sentence.
"@
    $launchArguments += @("--yes", "--", "-p", $smokePrompt)
}
else {
    $forwardedArguments = @($ClaudeArguments)
    if ($forwardedArguments.Count -gt 0 -and $forwardedArguments[0] -eq "--") {
        $forwardedArguments = @($forwardedArguments | Select-Object -Skip 1)
    }
    if ($forwardedArguments.Count -gt 0) {
        $launchArguments += "--"
        $launchArguments += $forwardedArguments
    }
}

Push-Location $repositoryRoot
try {
    & $ollamaPath @launchArguments
    $childExitCode = $LASTEXITCODE
}
finally {
    Pop-Location
}

exit $childExitCode
