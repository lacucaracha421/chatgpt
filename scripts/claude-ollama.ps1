[CmdletBinding()]
param(
    [string]$Model = "glm-5.3-flash:cloud"
)

$ErrorActionPreference = "Stop"

$repositoryRoot = "C:\chatgpt"
$ollamaApiUrl = "http://127.0.0.1:11434/api/version"

function Test-Ollama {
    try {
        $response = Invoke-RestMethod `
            -Uri $ollamaApiUrl `
            -TimeoutSec 2

        return $response.version
    }
    catch {
        return $null
    }
}

# Ollama 실행 파일 찾기
$ollama = Get-Command ollama -ErrorAction SilentlyContinue

if (-not $ollama) {
    $fallback = "$env:LOCALAPPDATA\Programs\Ollama\ollama.exe"

    if (Test-Path $fallback) {
        $ollamaPath = $fallback
    }
    else {
        throw "Ollama를 찾을 수 없사와요."
    }
}
else {
    $ollamaPath = $ollama.Source
}

# Ollama 서버 상태 확인
$version = Test-Ollama

if (-not $version) {
    Write-Host "Ollama 서버를 시작하사와요..."

    Start-Process `
        -FilePath $ollamaPath `
        -ArgumentList "serve" `
        -WindowStyle Hidden

    for ($i = 0; $i -lt 40; $i++) {
        Start-Sleep -Milliseconds 500
        $version = Test-Ollama

        if ($version) {
            break
        }
    }
}

if (-not $version) {
    throw "Ollama 서버가 시작되지 않았사와요."
}

Write-Host "Ollama $version 준비 완료."
Write-Host "Claude Code 실행: $Model"
Write-Host ""

if (-not (Test-Path $repositoryRoot)) {
    throw "저장소 경로를 찾을 수 없사와요: $repositoryRoot"
}

Set-Location $repositoryRoot

& $ollamaPath launch claude --model $Model

exit $LASTEXITCODE