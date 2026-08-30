# CLOUD-004 조사 핸드오프 문서

> 날짜: 2026-08-31
> 브랜치: `fix/cloud-capture-video-server` (main `5c496d3`에서 분기, 진행 중)
> 상태: **VPS 원인 확정 완료, 확장 진단 기능 구현 중간, 테스트/커밋 전**

---

## 1. 작업 배경 (CLOUD-004)

- 증상: X 영상을 확장으로 저장하면 로컬 다운로드만 되고 VPS Capture/R2에 안 남는다.
- 이미지는 정상 동작 중, 영상만 실패.
- 목표: fallback 제거/timeout 증가가 아니라 실제 실패 원인을 찾아 수정.

## 2. 확정된 조사 결과 (VPS 실측, read-only)

SSH 접근 성공: `linuxuser@100.76.119.29` (`laku-tokyo`, Vultr VPS, tailnet 내부).
production dir `~/lakomics-api`, 서비스는 systemd 유닛 `lakomics-api.service` (uvicorn, 포트 32146).

| 조사 항목 | 결과 |
|---|---|
| 배포 코드 == GitHub main | **동일** (`app.py`, `capture_store.py` 라인엔딩 정규화 후 byte-identical) |
| 배포 openapi | `media_type` enum `["image","video"]`, 라우트 7개 모두 존재 → video 지원 배포 완료 상태 |
| VPS 로그 (journalctl `_COMM=uvicorn`) | POST `/v1/captures` 전부 **200 OK 13건 + 401 1건(내 진단 프로브)**. video 관련 400/502/422/예외 스택트레이스 **0건** |
| captures DB | 총 14 row, **전부 image/pending**. video row **0건** |
| R2 (`videos/inbox/`) | 객체 **0건**. `images/inbox/` 는 정상 존재 |
| 태블릿 상태 | `100.68.153.44`에서 17:44 UTC(=KST 02:44)에 이미지 저장 200 OK — **태블릿 collector는 살아있고 이미지는 정상 도달 중** |
| 확장 버전 | 태블릿 설치본 alpha.15.30, repo는 15.34이나 collector 로직은 동일 커밋(b177c5a) 계열 — 숨은 수정 없음 |

### 핵심 추론 (근거 기반)

> **video POST가 배포 VPS `/v1/captures`에 도달조차 하지 않았다.**

- 도달했으면 uvicorn이 어떤 상태(400/502/200)든 반드시 로그 남김 — 0건.
- 성공했으면 DB row + R2 object가 남음 — 0건.
- 로컬 다운로드는 성공함 → `resolveXVideoPayload`(syndication)는 성공해서 `mediaUrl`이 확보된 상태.
- 태블릿에서 같은 시점 이미지는 VPS에 도달성 공 → 네트워크/토큰 문제와 무관.

남은 후보 (전부 client-side, VPS 흔적이 없어서 실험으로만 판별 가능):
1. 태블릿에서 `saveMedia`가 `captureWithCollector` 이전에 폴백한 케이스 (saveMode/classificationSource/local tree 분기)
2. video POST fetch가 실패했으나 폴백 코드가 UI에 일반문구로만 표시되어 구분 불가
3. 서버 도달했으나 로그 라인이 아직 안 찍힌 초장기 영상(현시점 미완료) — 기상 이론으로 배제 어려움

**서버 5가지 제약(https allowlist / follow_redirects=False / 정확히 video/mp4 / read 60s / 512MiB)은
설계 문서(`docs/superpowers/specs/2026-08-31-vps-capture-video-design.md`)상 명시적 의도이며,
**VPS 로그에 흔적이 아예 없어 이 중 어느 것도 원인으로 확정할 증거가 없음.** 임의 수정 금지가 맞음.

## 3. 이번 브랜치에서 이미 한 일 (미커밋)

- `extension/src/background.js` + 재생성된 `background-worker.js`:
  - `COLLECTOR_FALLBACK_DIAGNOSTICS_KEY` 상수 추가 (`lakomicsCollectorFallbackDiagnostics`, 최대 20개)
  - `recordCollectorFallback(code, mediaType, response)` 신설 — 폴백 순간 code/httpStatus/detail을 chrome.storage에 보존 (토큰·URL·payload는 기록하지 않음)
  - `captureWithCollector`의 4개 실패 지점(not_configured / media_unsupported / !response.ok / malformed success)마다 진단 기록 호출 추가
  - `handleMessage`에 `collector:diagnostics` 조회 핸들러 추가 (마지막 20건 반환)
- 문법 검증 통과(`node --check`), 리빌드 스크립트 실행 완료, 기존 확장 테스트 63/63 통과 확인.

## 4. 앞으로 해야 할 것

### 4.1 content.js — 폴백 코드별 구체 메시지 (미구현)
`feedbackFor()`에서 `response.status === "downloaded" && response.fallbackCode`일 때 항상
"Lakomics 연결 불가 · 기기에 저장됨"만 보여줌. 이를 code별로 분기:
- `collector_unauthorized` → "서버 토큰이 일치하지 않습니다 · 기기에 저장됨"
- `collector_timeout` → "서버 응답 대기 시간 초과 · 기기에 저장됨"
- `collector_request_failed` → "서버 요청 실패 · 기기에 저장됨"
- `collector_offline` 등 나머지는 기존 문구 유지
(사용자 요구사항 6: "왜 fallback됐는지 error code가 보존되는지" 충족)

### 4.2 options.js — 최근 fallback 진단 표시 (선택 권고)
`collector:diagnostics` 메시지를 호출해 Collector 설정 하단에 최근 폴백 원인/시각 표시하면
진단 경험이 크게 좋아짐. 범위 조절 시 4.1만으로도 최소 요구는 충족됨.

### 4.3 서버 진단 로깅 (미구현, 권고)
`server/lakomics-api/app.py` `create_capture`에서 400/502 반환 시 `detail` 코드와
`media_type`을 stderr로 로그 남기기(토큰·전체 URL 미출력). 지금은 uvicorn status line만 남음.
다음에 실패가 서버에 도달하는 일이 생기면 바로 원인 특정 가능.

### 4.4 테스트 (요구사항 A/B 중 아직 미작성)
- 확장: 폴백 시 diagnostics 저장 검증, 코드별 toast 메시지 검증, timeout-confirm duplicate 방지(기존 테스트 존재), image 회귀
- 서버: 기존 24개 테스트 모두 통과 상태(`python -m unittest tests.test_capture_api`).
  A 시리즈의 "invalid host 거부/크기 거부/R2 실패 정리"는 이미 기존 테스트가 커버.
  새로 추가할 것은 4.3 로깅 검증 하나면 충분.
- 실행 커맨드: `node --test tests/*.test.mjs` (extension), `python -m unittest` (server)

### 4.5 실환경 검증 (사용자 협조 필요)
실제 실패했던 영상으로 태블릿에서 저장 1회 → VPS 로그로 POST 도달 여부 즉시 판별.
- 로그에 흔적이 생기면 → 서버 처리 문제, detail로 원인 확정
- 여전히 흔적 없음 → 100% client-side(pre-POST) 문제 → 4.1 진단 UI로 다시 저장 시도하면 code가 태블릿에 남음

### 4.6 Git (할 일)
- 커밋/푸시/머지 **전부 하지 말 것** (사용자 지시: 구현/검증 전 금지)
- 커밋 대상 파일: `extension/src/background.js`, `extension/src/background-worker.js`,
  `extension/src/content.js`(수정 시) — `server/` 수정 시 서버 파일도 stage
- 커밋 후 최신 main rebase → `origin/main...HEAD` diff로 6파일 외 0건 검증 → merge/push는 별도 승인

## 5. 절대 하지 말 것 (사용자 지시)

- CLOUD-001 batch drain / `cloud_sync_queue` 변경
- `C:\New_lakomics_assets` write
- `follow_redirects=True`나 timeout 증가로 우회
- production 임의 deploy / code 수정 전 commit-push-merge

## 6. VPS 접근 정보 (다음 세션용)

- SSH: `ssh linuxuser@100.76.119.29` — 키 기반, BatchMode 동작 확인됨
- 서비스: `systemctl status lakomics-api`(시스템 유닛), uvicorn PID 기준 journalctl `_COMM=uvicorn --since '...'`
- DB: `~/lakomics-api/data/lakomics.sqlite3`, SQLite `captures` 테이블
- R2: 서버 `.env` 기준 boto3로 `list_objects_v2(Prefix='videos/inbox/')` (python은 `~/lakomics-api/.venv/bin/python`, python-dotenv 필요)
- VPS 시간대는 UTC(현재 17:46 UTC = KST 02:46). 로그 시간 필터 시 KST-9h 주의
- SSH 키: `C:/Users/Laku.LAKU/.ssh/id_ed25519` 가 linuxuser에 authorization 되어 동작함(이 세션에서 확인)

## 7. 최종 보고용 임시 결론 (확정 시 갱신)

- **root cause (현 확정 가능한 수준)**: video 저장 요청이 배포 VPS에 도달하지 않음(코드/DB/R2/logs 3중 증거). 서버 5가지 제약은 결백. 클라이언트 측 어느 분기에서 폴백됐는지는 4.1 UI로만 판별 가능
- **GitHub vs 배포 차이**: 없음 (byte-equal)
- **확장 HTTP status/error**: 도달하지 않아 응답 없음(단서: 도달 실패 원인이 확장 로컬 진단에만 남음)
- **CLOUD-003 필요 여부**: 판단 불가 — 서버 장기 처리 흔적(긴 POST)이 아예 없어 timeout race 자체가 아직 재현되지 않음. CLOUD-004 종료 후 재평가
## 8. ChatGPT continuation (2026-08-31)

추가 코드 조사에서 `saveMedia()`의 실제 pre-POST 우회 분기를 찾음.

- 기존 순서: `saveMode === "download" || classificationSource === "local"`이면 즉시 browser download.
- 따라서 Collector가 enabled이고 video를 지원해도, radial이 로컬 fallback classification tree를 사용한 순간 Collector POST 자체가 호출되지 않음.
- 이는 현재 문서의 "Collector enabled + supported media이면 direct PC보다 먼저 시도" 규칙과 불일치하며, VPS에 video POST 흔적이 0건인 실측과도 일치함.

적용한 수정:
- 명시적 `saveMode === "download"`만 Collector를 의도적으로 우회.
- Collector enabled + supported media이면 classification source가 `local`이어도 Collector를 먼저 시도.
- Collector가 비활성/미지원일 때만 기존 local-classification browser download 유지.
- 기존 fallback 진단 저장과 content.js 코드별 메시지 유지.
- `background-worker.js` 재생성 완료.

검증:
- local classification + video + Collector enabled → `/v1/captures` 호출, 로컬 download 0건 신규 테스트 추가.
- fallback diagnostics/status/detail 및 toast 메시지 테스트 추가.
- `node --check` 통과.
- 전체 extension tests: 153/153 통과.
- `git diff --check`: whitespace error 없음(autocrlf 안내만 존재).

남은 최종 확인:
- 태블릿에 이 브랜치 확장을 설치/새로고침하고 실제 X 영상 1개 저장.
- VPS `/v1/captures` POST 및 `videos/inbox/` 객체 생성 여부를 확인해야 root cause를 실환경에서 최종 확정할 수 있음.

## 9. Real-device confirmation (2026-08-31)

- 사용자가 태블릿/Titanium에서 수정본으로 실제 X 영상 저장을 재시험했고, 기존처럼 로컬 다운로드로만 빠지지 않고 정상 동작하는 것으로 확인함.
- 이 결과는 `classificationSource === "local"` 선행 browser-download 분기가 실제 CLOUD-004 원인이었다는 코드 분석과 일치함.
- 따라서 현재 root cause는 **local fallback classification 사용 시 Collector보다 browser download가 먼저 실행되던 client-side pre-POST routing bug**로 판단한다.
- 서버의 video fetch 제한/timeout/content-type/R2 로직을 변경할 필요는 현재 확인되지 않았다.
- 마지막 VPS DB/R2 재확인을 시도했으나 이 ChatGPT Desktop Commander 세션에서는 SSH가 exit 255로 종료되어 내부 확인을 반복하지 못했다. Tailscale/22번 포트 자체는 reachable이었다.
- 코드 회귀 검증은 extension 전체 153/153 통과 상태다.
