# Remote Lakomics setup (Tailscale Serve)

alpha.11은 PC Lakomics의 HTTP API를 LAN 전체에 열지 않습니다. Lakomics는 계속 `127.0.0.1:32145`에서만 대기하고, Tailscale Serve가 tailnet 안에서 HTTPS reverse proxy를 제공합니다.

## PC

Lakomics를 먼저 실행하고 PowerShell에서 포트를 확인합니다.

```powershell
Test-NetConnection 127.0.0.1 -Port 32145
```

`TcpTestSucceeded : True`면 다음을 실행합니다.

```powershell
tailscale serve --bg 32145
tailscale serve status
```

출력되는 `https://...ts.net` 주소를 복사합니다. `--bg` 설정은 Tailscale이 재시작되어도 유지되는 방식입니다.

원격 공개를 끄려면:

```powershell
tailscale serve reset
```

## Galaxy Tab / Titanium

1. Lakomics Radial 설정을 엽니다.
2. `저장 방식`은 `자동` 또는 `PC · Lakomics 앱으로만 수집`을 사용합니다.
3. PC Lakomics의 32자리 연결 키를 `Lakomics 연결`에 입력합니다.
4. `Remote Lakomics · Tailscale`에서 원격 연결을 켭니다.
5. PC에서 복사한 `https://...ts.net` 주소를 입력합니다.
6. `저장하고 원격 연결 테스트`를 누릅니다.
7. 성공 후 X 탭을 새로고침합니다.

Remote가 활성화되면 분류 목록과 수집 요청 모두 PC Lakomics로 전송됩니다. `자동` 모드에서 PC가 오프라인이면 모바일 로컬 분류 + 직접 다운로드로 fallback합니다.

## alpha.11 범위

- Remote PC의 실제 classification tree를 읽습니다.
- 이미지/영상 ingestion도 동일 Remote endpoint로 전송할 수 있습니다.
- PC 확장 프로그램의 `chrome.storage.local`에만 존재하는 슬롯 배치와 pinned 순서는 아직 서버 동기화 대상이 아닙니다. 같은 태그 트리를 사용하지만 모바일의 슬롯 배치는 모바일 저장소에 남습니다.
