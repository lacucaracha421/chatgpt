$ErrorActionPreference = "Stop"

if (-not (Get-Command tailscale -ErrorAction SilentlyContinue)) {
    Write-Error "tailscale 명령을 찾지 못했습니다. Tailscale이 설치되어 있고 PATH에서 실행 가능한지 확인하세요."
}

$open = Test-NetConnection 127.0.0.1 -Port 32145 -InformationLevel Quiet
if (-not $open) {
    Write-Error "Lakomics API가 127.0.0.1:32145에서 응답하지 않습니다. Lakomics를 먼저 실행하세요."
}

Write-Host "Lakomics API 확인 완료. Tailscale Serve를 설정합니다."
tailscale serve --bg 32145
Write-Host ""
Write-Host "현재 Serve 상태:"
tailscale serve status
Write-Host ""
Write-Host "위 https://...ts.net 주소를 모바일 Lakomics Radial 설정에 입력하세요."
