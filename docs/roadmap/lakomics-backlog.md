# Lakomics Backlog

Living source of truth for Lakomics bugs, product work, cloud/mobile follow-ups, Collection/Works evolution, and long-term ideas.

The backlog was reconciled from the 2026-09-05 full repository audit and its document routing was refreshed on 2026-09-06 against:

- the real `C:\chatgpt` codebase and audited production-data findings;
- `docs/agents/mobile-consumption-ux.md`;
- `docs/agents/pc-design-reference.md`;
- `docs/agents/works-viewer-design.md`;
- current code, schemas, ADRs, `CONTEXT.md`, and `DESIGN.md`.

Current code and migrations remain authoritative for implemented behavior. Git history retains the old verbose completion notes; this file intentionally keeps completed work compact so stale historical text does not look executable.

2026-09-06 Collection follow-up: reconciled against commit `9a99ed5` and the
recorded checks from that implementation. This refresh covers Collection presentation,
ownership/release notifications, and the catalog bookmark filter fix; it is not a new
repository-wide or production-data audit. Unrelated Cloud/Mobile acceptance gates remain unchanged.

## Documentation reconciliation — 2026-09-09

Checked against source commit `0c61206`; no new tests, device inspection or production
audit were performed. Android source is 0.4.3 (14); its built artifact and remaining
install/native-reader gates are recorded under MOBILE-006 and in the Android README.
References to installed APK 0.3.3 in older entries are dated device evidence, not a
fresh inventory. CLOUD-006 is DONE; CHAR-UI-001 and Linux drag-out retain their native
acceptance limits. Existing item statuses below remain the owners of pending work.

## 현재 작업 요약 — 2026-09-09 사용자 확인 반영

이번 정리는 이 문서의 항목·실행 기록과 현재 대화의 사용자 확인을 대조한 것이다. 전체 코드·운영 상태를 새로 감사하거나 기존 네이티브 검증을 대신한 것은 아니다. 아래는 탐색용 요약이며 상세 요구와 완료 기준은 각 항목이 소유한다. 역사적 P0/P1/P2 배치는 현재 실행 우선순위 확정으로 해석하지 않는다.

| 영역 | 구현 후 확인 / 남은 보완 | 새 구현 / 보류 |
|---|---|---|
| 캐릭터 | CHAR-AUTO-001: 신규 이미지 자동 분류 속도 개선은 Linux 개발 앱 실사용 확인. 기존 이미지 첫 분석 성능·안전성 보완과 Windows 확인은 남음. CHAR-UI-001~006: 기존 UI 네이티브 확인, 004 전환 후 정리 추가 구현 | CHAR-UI-007 추가 참조 확인·제외, 008 일반 폴더로 전환, 009 표시용 캐릭터 그룹 |
| 통합 코드 리뷰 | REVIEW-20260909: A–H/I1 반영 후 남은 Windows·Android·실제 미디어 검증 | 구현 완료 배치를 처음부터 재실행하지 않음 |
| 클라우드·통계·Notes | CLOUD-UI-001, STATS-001A/B, NOTE-001B 네이티브 확인/남은 보완 | CLOUD-006와 NOTE-001A는 완료 |
| 개인 탐색·카탈로그 | 기존 카탈로그 주 경로 완료 | IDEA-001B 테마 확장, CATALOG-002B 선택적 공급자; IDEA-002 보류 |
| 유사 이미지·영상 | SIMILARITY-003 실제 영상 정확도 검증 | SIMILARITY-002B 기하 변형 후보; PERF-SIMILARITY는 측정 근거 전까지 보류 |
| 모바일 | MOBILE-001/002/004/006 기기·권한·Reader·성능 확인과 각 항목의 잔여 구현 | MOBILE-007 북마크 쓰기 → 008 갱신 요청; 003 삭제 프로토콜 보류 |
| Works / Collection | WORKS-001, LONG-001, LONG-002B 남은 기능/실제 미디어 확인 | LONG-004는 기존 화면에 통합; LONG-003 보안 설계 승인 전 보류 |

캐릭터 관련 다음 작업의 **제안 순서**: CHAR-UI-007 참조 확인·제외 → CHAR-UI-004 전환 후 정리와 CHAR-UI-008 역방향 전환을 함께 설계 → CHAR-UI-009 표시 그룹. 기존 이미지 첫 분석 성능 계측은 CHAR-AUTO-001에서 관리한다. 이 순서는 구현 착수 승인이나 다른 영역의 사용자 우선순위 변경을 뜻하지 않는다.

## Status legend

2026-09-07 refresh: reconciled current Mobile/extension work through `6524c4c`,
the Collection deployment/cover-repair evidence, and the user's confirmation that
extension 15.59 is activated and Arca downloads are faster. This is a documentation
refresh, not a new production audit or measured throughput benchmark.

- `IN PROGRESS`: currently being implemented
- `PARTIAL`: useful implementation exists, but a material acceptance condition is still missing
- `TODO`: planned executable work
- `PLANNED`: a written implementation plan exists; implementation has not started or is not yet authorized
- `VERIFY`: implementation exists but still needs explicit real-world verification
- `MERGE CANDIDATE`: real scope, but should be implemented as part of another listed batch rather than independently
- `HOLD`: intentionally deferred or gated long-term work
- `KEEP`: existing behavior is intentionally retained
- `DONE`: implemented and sufficiently verified
- `OBSOLETE`: superseded or incident-only work that should not be selected for implementation

## Repository-wide execution rules

- Preserve existing user data and provider bindings.
- Prefer additive, reversible changes over rewrites.
- Do not rerun the completed full Cloud Library backfill unless a separately approved recovery operation requires it.
- Do not replace `kdata.db` wholesale for catalog work.
- Do not use frontend-only filtering where count/pagination correctness belongs in the Rust/SQLite query boundary.
- Do not extend the browser-extension mobile prototype into the production Android architecture; native transport is the production destination.
- Do not build a second Collection renderer for Shelf/Display mode; it must consume the normal presentation contract.
- Do not copy GPL/AGPL reference source into Lakomics without an explicit license decision. Reimplement validated concepts.
- Before each implementation batch, re-check Git status/diff and establish ownership of concurrent working-tree changes.

---

# REVIEW-20260909 — 병렬 리뷰 통합 수정 계획

Status: `VERIFY` — 2026-09-09 A–H 코드 수정과 I1 권한 판단 보강 반영. 격리 회귀/브라우저 검증 완료; 네이티브·운영 검증과 Android 성능 측정은 아래 실행 기록에 남김.

## 2026-09-09 실행 기록

작업 기준은 위 HEAD의 Linux 체크아웃과 사용자 승인 계획이다. 운영 자료를 수정하지 않고 임시 라이브러리·서버 DB·브라우저 합성 이미지로 검증했다. 아래는 소스 반영 상태이며 Windows/Android 배포 완료를 뜻하지 않는다.

- **A:** 첫 rename 전 복원 의도를 파일에 기록·동기화하고, 시작 시 migration/아트워크 정리보다 먼저 중단 흔적을 검사한다. 자식 프로세스 강제 종료 4개 지점에서 일반 재개가 중단되고 DB 메타데이터와 `work-artwork/fixture/` 바이트가 보존되는 테스트를 포함해 backup 17개 통과. Windows WAL/파일 교체 네이티브 검증은 남아 있다.
- **B:** 로컬 미디어 처리 끝까지 permit을 보유한다(12개 요청, 최대 6개; remote 예외/오류 반환 검증). 자산 갱신은 현재 범위의 ID를 500개씩 재검증하여 250장 선택 범위를 보존하고 삭제/필터 이탈은 반영한다. 새 첫 페이지가 기존 범위와 완전히 겹치지 않을 때 `처음부터 보기`로 이동한다. 실제 대량 디코딩 중 입력 응답은 네이티브 확인 필요.
- **C:** unmatched 경쟁 결과의 근거도 자동 확정 전에 검증한다. 자산별 트랜잭션에서 현재 적격 캐릭터 목록을 다시 확인한다. 수동 검토는 사용된 근거의 유효성을 유지하면서 승인으로 새로 늘어난 레퍼런스를 허용한다. 조회 명령은 blocking worker로 옮기고 자동 판단의 DB 잠금을 자산 단위로 줄였다. 변경된 경쟁 근거/연속 승인 회귀 통과. 느린 해싱의 잠금 시간과 실제 입력 지연 측정은 남아 있다.
- **D:** 상단 다중 제외(한 번에 200장), 성공 안내 5초 숨김(오류 유지), 고정 상세 영역과 다중 승인/거절, 기존 폴더 등록을 반영했다. 폴더 등록은 직접 소속을 기본으로 하며 하위 포함·개수·기존 캐릭터 연결·기준/대표 선택을 확인하고 한 트랜잭션으로 관계를 만든다. 개수 변경/중복 이름 충돌은 재확인을 요구한다. CHAR-UI-002~006의 원래 요구사항은 아래 항목이 소유한다.
- **E:** 정확 중복의 review/trash/누락·변조 원본을 구분하고 정상 원본 확인 전에 ACK하지 않는다. 교체는 기존 직접 분류 하나를 유지하며 승격과 outbox는 원자적이다. 영속 cursor와 실패 유예로 앞선 25건 실패 뒤의 정상 항목에 도달한다. 미해결 review는 반복 폴링에서도 ACK하지 않고 명시적 Keep existing 완료 후 재다운로드 없이 ACK한다. capture/queue 70개, similarity 20개, 추가 반복 review 1개 및 서버 cursor 테스트 통과.
- **F:** 로컬 자산별 revision을 증가시키고 동시 전송을 직렬화한다. 서버 `prepare`의 `metadata_revision`과 commit의 `expected_revision`/`commit_id`로 CAS 및 동일 요청 재시도를 보장한다. 복원된 클라이언트도 새 prepare에서 서버 revision을 얻으므로 복원된 로컬 정수에 서버 권한을 맡기지 않는다. 늦은 이전 commit 거절, 새 commit 유지, 재시도·복원·legacy 거절을 격리 서버에서 검증했다.
- **G:** 모바일 Reader 응답을 화면/작품/provider/publication 소유권에 묶는다. PC 네이티브 검색은 SQLite progress callback으로 이전 PAGE/COUNT를 중단하고 최신 요청이 최대 4개 슬롯 중 빈 슬롯을 기다리게 한다. 만화 실패 페이지 재시도는 현재 위치를 유지하고 온라인 작품 주소를 기존 해석 경로로 갱신한다. 요청 실패 시 재시도 버튼은 유지된다.
- **H:** Windows 일반 영상 도구 실행도 기존 제한 runner(출력 상한, 30분 deadline, Windows job 회수)를 사용한다. Linux FFmpeg timeout/cancel 네이티브 테스트 1개 통과. Windows 실제 자식 프로세스 회수 및 긴 정상 영상 검증은 남아 있다.
- **I1:** Android tree 자산 접근 판단에서 표시용 캐시 대신 인증된 서버의 현재 폴더 ancestry/membership을 확인하도록 보강했다. 서버 테스트는 자산이 하위에서 부모 폴더로 이동하면 옛 하위 권한이 사라지고 부모 권한은 유지됨을 검증한다. 수신 앱의 영속 tree/document grant 재현 및 APK 컴파일은 Android SDK/JDK/adb·기기가 없어 미검증이다.
- **I2/H1 측정:** Linux Chrome 152 headless, React/Vite 개발 모드, 1440×900, 준비된 합성 SVG 썸네일, CPU throttling 없이 각 규모를 mount 후 60회 스크롤했다. React Profiler commit duration 중앙값/p95는 1천 **9.2/11.0 ms**, 1만 **11.1/13.6 ms**, 5만 **11.6/13.4 ms**. 렌더된 타일 52/58/58개, 관측 JS heap 19.1/16.0/23.5 MiB(강제 GC 없는 시점 값, retained memory 비교가 아님). 1만→5만에서 이 측정은 전체 배열 탐색을 지배적 병목으로 입증하지 않아 알고리즘 교체는 하지 않았다. release/native/cold I/O 결과가 아니며 Android 캐시 1천/1만 miss·잠금 측정(H2)은 기기 준비 후 진행한다.

검증 명령과 범위:

- `cargo test --lib -- --test-threads=1`: 전체 실행 811 passed, 2 failed, 21 ignored. 실패 원인은 revision=1 고정 큐 생성과 테스트 연결에만 붙은 TEMP trigger였으며 수정했다. 이후 영향 범위 `cloud::` 70 passed/1 ignored, backup 17 passed, similarity 20 passed/1 ignored, `character_` 19 passed/4 ignored, 반복 review 1 passed로 재검증했다. 전체 suite를 최종 재실행한 것으로 표기하지 않는다. Linux FFmpeg opt-in timeout/cancel 테스트도 별도로 통과했다.
- 데스크톱 변경 영역 6파일 125 tests 통과 후 후속 수정 영역 PageViewer/OnlineCatalogBrowser 58 tests, AssetBrowser/automation 61 tests 통과. 모바일 Catalog 13 tests 및 데스크톱/모바일 TypeScript 검사 통과.
- 격리 서버 `tests.test_capture_api tests.test_replication_api tests.test_mobile_library_api` 132 tests 및 추가 pending cursor 1 test 통과.
- 브라우저: 넓은 검토 화면에서 선택 전후 타일 x/width 동일, 2장 선택→일괄 승인, 760px에서 가로 넘침 없음. 폴더 등록에서 대상 18장·기준 5장·대표 1장 요청 확인, JS 예외 없음. agent-browser CLI와 headful 실행이 불가하여 설치된 Chrome headless CDP로 확인했다. 독립 리뷰 에이전트 없이 변경 범위 검토와 React 체크리스트를 인라인으로 수행했다.

2026-09-09 dev 사용 중 끊김 후속: 실제 캐릭터 Python worker CPU 약 225%(12 logical CPU 중 2.25코어)를 관측했다. 메인 스레드 5초 샘플은 모두 poll 대기였으므로 해당 샘플로 사용자 끊김을 재현한 것은 아니다. 코드에서 남아 있던 캐릭터 조회/설정/레퍼런스/판단 이력/관계/상태/취소 명령과 자산 열람·노출 기록의 동기 잠금 대기를 blocking worker로 옮겼다. `cargo check --lib` 통과; dev 재빌드 후 실제 분석 중 조작 체감 확인은 남아 있다. 분석 모델·캐시 형식은 이 후속 수정 대상에 포함하지 않았다.

2026-09-09 동기화 문제 화면 후속: 진입 시 사용하는 클라우드 설정 조회와 설정/토큰 저장·삭제를 blocking worker로 옮겨 DB/자격 증명 대기가 GTK 메인 스레드를 막지 않게 했다. 실제 dev 로그에서 기존 8건이 revision 미지원 서버로 재시도 후 모두 실패하는 것을 확인했다. 구 서버 응답은 개별 자산 영구 실패 대신 현재 작업을 pending으로 되돌리고 복제를 paused로 전환하며 서버 업데이트 안내를 남긴다. 격리 8자산 테스트에서 4개 이하 prepare 후 중단·8개 pending·0개 failed를 확인했고 backfill 회귀 21개 통과, dev 재빌드/실행 완료. 서버 app.py 배포 후보 SHA-256 `d2740f972917306710e2c5c99412fc1c750d5f04234567e027b8167829eaaf08`; 기존 서버 검증 132개와 cursor 추가 1개 통과 결과를 재사용한다. 이 시점의 SSH 확인은 Tailscale 인증 대기였으며, 이후 인증·승인·배포 결과는 아래 운영 기록을 따른다.

2026-09-09 승인된 운영 반영 완료: Tailscale 인증 후 운영 `app.py`가 작업 기준 HEAD와 같은 SHA-256 `005b1156230d114ae1dc401c9d17ff1b5d2490f18deecf284f78065ed4e89715`임을 확인했다. `/home/linuxuser/lakomics-api/backups/review-revision-20260909/`에 코드 및 SQLite online backup(12,763,136 bytes, quick_check ok)을 만들었다. 검증된 후보를 원자 교체하고 `lakomics-api.service` 재시작 후 active/NRestarts=0, 배포 SHA 일치, revision 컬럼, DB quick_check, health 200을 확인했다. 인증된 pending cursor/분류/tree membership GET 200 및 무인증 401도 통과했다. 앱에서 기존 실패 8건 재시도와 동기화 계속을 실행했고 로컬 8건 synced, 서버 8건 committed 및 metadata_revision >= 1을 교차 검증했다. 잔여 pending 5건은 휴지통 이미지 4/영상 1로 전송 제외 상태이며 수정하지 않았다. 전체 라이브러리 시딩은 실행하지 않았다. 호환성 중단 뒤 사용할 `동기화 계속` 버튼과 정확한 일시정지 표기도 추가했으며 관련 UI 14 tests/TypeScript 통과, 실제 Linux 설정 화면 진입·버튼 실행 확인. Windows/Android의 나머지 게이트는 유지한다.

운영 반영 순서와 남은 게이트:

1. 서버 DB 백업 후 revision/CAS·pending cursor·tree membership API를 먼저 배포하고 격리 canary를 확인한다. 그 후 새 앱/Android를 반영한다. 구 서버는 revision을 반환하지 않으므로 새 앱은 명시적인 서버 업데이트 오류로 중단한다.
2. revision이 생긴 자산에 대한 구버전 클라이언트 commit은 409로 거절한다. 앱 롤백 시에도 서버 CAS guard는 유지해야 하며, 이를 제거하는 서버 롤백은 오래된 쓰기 보호를 잃는다. 최초 구현 검증 시점에는 운영 반영 전이었으며, 위 후속 기록에서 승인된 배포·백업·기존 실패 8건 재시도를 완료했다.
3. Windows/Linux Tauri의 실제 입력·디코딩·검토/등록과 Windows FFmpeg, Android 기기 권한 및 H2 성능 측정 후 해당 항목을 DONE으로 전환한다. 현재 코드/단위/브라우저 결과를 이 네이티브 게이트의 대체 증거로 사용하지 않는다.

## 기준과 완료 규칙

- 입력은 사용자가 전달한 정확성/코드 품질 리뷰(Q1–Q8, R1)와 성능/UX 리뷰(U1–U8, H1–H2)이다. 두 리뷰 모두 `0c61206218afaf9fe7775b241d49f98d7ae4e729` 기준의 정적 검토이며 실행 재현이나 새 성능 측정은 없다.
- 현재 계획 작성 HEAD는 `c3afe65ad54d680f6493714431744a1e8d332a0d`이며 이후 커밋 차이는 문서다. 기존 미커밋 CHAR-UI-002~006 기록을 보존한다. 각 배치 시작 시 실제 HEAD/작업 파일과 관련 코드를 다시 확인한다.
- Q3/U1은 동일 원인으로 통합한다. 총 결함 지적 15개, Android 권한 미확정 위험 1개, 성능 측정 가설 2개를 추적한다. 기존 캐릭터 UX 요청은 CHAR-UI-002~006의 요구사항을 참조하여 중복 관리하지 않는다.
- 각 결함은 먼저 최소 재현으로 성립 조건을 확인한다. 반례가 확인되면 근거를 기록해 수정 대상에서 제외한다. 해당 실패를 잡는 회귀 검증, 최소 수정, 영향받는 계약 검증 순서로 진행한다.
- 새 테스트는 아래의 현실적인 실패 시나리오를 기존 테스트 파일/fixture에 추가하는 범위로 제한한다. 광범위한 테스트·빌드를 모든 배치에 반복하지 않는다.
- 소스 수정 완료, 정적/단위 검증, 브라우저 검증, Windows/Linux/Android 네이티브 검증 및 운영 반영을 따로 보고한다. 필요한 네이티브 증거가 없으면 `VERIFY`로 남긴다.
- 운영 라이브러리 복구·자료 수정·재업로드, 배포·기기 설치 및 Git 쓰기는 별도 명시적 승인 범위다. 완료된 full backfill이나 카탈로그 DB 교체를 검증 수단으로 실행하지 않는다.

## 배치와 기본 실행 순서

기본 순서는 **A → B → C → D → E → F → G → H → I**다. 이는 이번 수정 작업의 순서이며 다른 제품 기능의 완료 상태를 변경하지 않는다. 각 배치는 아래 게이트를 충족한 후 완료 처리한다.

### A — 중단된 복원에서 DB와 아트워크 보존 (Q1)

- 소유 경로: `library/backup.rs`, `library/mod.rs`, `library/db.rs`, `library/work_artwork.rs`.
- 첫 rename 전 durable 복원 의도를 남기고, 라이브러리 시작 시 DB 생성·migration·파일 정리보다 먼저 복구 상태를 판별한다. 완전한 DB를 결정할 수 없으면 복구 오류로 중단하며 원본·임시 DB·아트워크를 보존한다.
- 복원 직전/첫 rename 뒤/교체 뒤/정리 전 강제 종료를 각각 다룬다. Windows/Linux의 파일 교체와 SQLite WAL/SHM 수명까지 포함한다.
- 게이트: 합성 라이브러리의 자식 프로세스를 지정 지점에서 종료 후 일반 `Library::open()`으로 재개한다. 빈 DB가 조용히 생성되지 않고, 메타데이터와 WorkArtwork 바이트가 보존되며 정상 복원·재시도도 통과해야 한다.

### B — 미디어 실행 상한과 자산 탐색 맥락 보존 (Q3/U1, U2)

- 소유 경로: `media_protocol.rs`, `AssetBrowser.tsx` 및 관련 테스트.
- 로컬 미디어 permit을 응답 처리 완료까지 보유하고 remote 예외를 유지한다. 목록 갱신에서는 첫 페이지 포함 여부와 선택/뷰어 자산의 유효성을 분리하며 현재 탐색 범위를 보존한다.
- 게이트 1: 제어 가능한 미디어 작업 12개에서 처리 구간 동시 실행이 최대 6개이며 오류·조기 반환 후에도 슬롯이 반환된다.
- 게이트 2: 자산 250개 이상에서 뒤쪽 자산을 선택·열고 수집/백그라운드 갱신을 발생시켜 선택·뷰어·기준 자산을 보존한다. 실제 삭제·필터 이탈은 정상 반영하고 무제한 전체 목록 재조회로 해결하지 않는다.
- 두 수정은 독립적으로 검증한다. 시각 확인은 브라우저로, 실제 디코딩·입력 응답은 Windows/Linux 네이티브로 구분한다.

### C — 캐릭터 근거·연속 검토·잠금 경계 정리 (Q7, U3, CHAR-UI-006)

- 소유 경로: `library/characters.rs`, `library/character_scan.rs`, `commands/characters.rs`, 자산 조회 명령, 캐릭터 UI/API.
- 자동 확정 전 accepted 결과뿐 아니라 unmatched/경쟁 결과의 전체 recognition context를 검증한다. 경쟁 캐릭터의 추가 레퍼런스가 바뀐 오래된 결과는 자동 확정이나 시리즈 이동에 사용할 수 없다.
- 수동 검토는 분석 당시의 유효한 근거 snapshot으로 이어갈 수 있게 하고, 승인으로 추가된 레퍼런스는 다음 분석에 반영하는 방향으로 설계한다. 근거 삭제·변조·명시적 기준 교체·승인 취소 등 실질적 무효화는 계속 차단한다. 수동 검토와 자동 확정의 유효성 정책을 명시해 검사를 일괄 완화하지 않는다.
- 먼저 느린 파일 읽기를 제어하는 fixture와 잠금 보유/대기 시간으로 차단 경로를 확인한다. 공용 DB 잠금을 기다리는 조회는 메인 스레드를 막지 않게 하고, 판단 적용의 잠금 범위를 줄인다. 잠금 밖 해싱을 도입할 경우 커밋 시 자료 revision과 파일 identity를 다시 확인하여 검사 후 변경 경쟁을 막는다.
- 게이트: A 추천/B 불일치 이후 B 레퍼런스 추가 시 옛 자동 배치가 무효이며 폴더도 이동하지 않는다. 신선한 서로 다른 인물 영역의 다중 캐릭터 확정은 유지한다. 연속 승인·거절과 실제 기준 변경 안내가 구분되고, 느린 검증 중 조회/입력 대기가 네이티브 이벤트 처리를 막지 않아야 한다.

### D — 캐릭터 화면과 기존 폴더 연결 (CHAR-UI-002~005)

- C의 판단 계약을 먼저 확정하고 기존 `SeriesBrowser`, `CharacterLab`, 공통 toolbar/panel/gallery를 재사용한다.
- D1: CHAR-UI-002 상단 고정 제외·일괄 제외, CHAR-UI-003 완료 안내 자동 숨김, CHAR-UI-005 상세 패널로 인한 그리드 밀림 및 다중 승인·거절을 처리한다.
- D2: CHAR-UI-004 기존 분류 폴더를 캐릭터로 등록한다. 시리즈·이름·대상 범위·개수를 확인하고 대표/기준 이미지를 기존 갤러리에서 선택한다. 파일·분류·다른 캐릭터 관계를 보존하며 반복 실행 시 중복 관계를 만들지 않는다.
- 게이트: 넓고 좁은 창에서 선택/스크롤을 유지한 패널 전환, 다중 판단 후 목록 갱신, 처리 불가 항목 안내, 안내 타이머 교체/해제를 확인한다. 기존 폴더 등록은 합성 자료로 직접/하위 범위와 기존 캐릭터 연결 충돌을 검증한다. 실제 사용자 폴더에 일괄 적용하는 것은 별도 작업이다.

### E — 수집 상태·유사 이미지 전환·수신 진행 보장 (Q2, Q4, Q5, Q8, U5)

- 소유 경로: `library/ingestion.rs`, `library/similarity.rs`, `cloud/captures.rs`, 필요한 capture client/server 계약 및 해당 테스트.
- E1: 해시 일치의 normal/review/trash/원본 누락 상태를 구분한다. 열린 review에는 review 결과와 관계를 유지하고, trash는 명시적 복원 경로를 제공한다. 정상 원본 확인 또는 안전한 복구 없이 완료/ACK하지 않는다.
- E2: 유사 이미지 교체의 단일 직접 분류 규칙을 적용하고, Keep both/Replace의 normal 승격·검토 완료·replication outbox 삽입을 같은 트랜잭션으로 처리한다. 결정 재실행의 멱등성을 보존한다.
- E3: 이미 수집한 항목의 ACK 재시도도 항목별 실패 경계 안으로 넣는다. 반복 실패 항목에는 재시도 유예와 공정한 순회를 제공하고, 정상 후속 항목을 처리할 수 있도록 서버 목록 제한/커서까지 확인한다.
- 게이트: 동일 유사 capture를 두 번 폴링해도 미해결 상태에서는 ACK하지 않는다. Keep existing/Keep both/Replace 및 거절/삭제 후 terminal ACK 정책을 확인한다. trash/원본 누락 재수집을 검사한다. 서로 다른 분류의 교체 후 직접 소속이 최대 하나이고, 승격 시 큐가 존재하며 rollback/재실행이 안전해야 한다. ACK 실패 A 다음 정상 B, 영구 실패 25건 다음 정상 1건도 제한된 폴링 횟수 안에 처리한다.
- 과거 다중 분류/누락 outbox는 별도 읽기 전용 진단 대상으로 둔다. 발견 즉시 unique 제약이나 전체 재업로드를 적용하지 않는다.

### F — 클라우드 자산 revision 순서 보장 (Q6)

- 소유 경로: 로컬 mutation/outbox, `cloud/backfill.rs`, replication client DTO 및 `server/lakomics-api` 자산 commit 계약.
- E의 상태 전환 계약 위에서 자산별 작업 직렬화/병합과 서버의 오래된 generation/revision 거절을 함께 설계한다. timeout 뒤 늦게 도착하는 요청, 재시작, DB 복원, 구버전 클라이언트 호환을 포함한다.
- 게이트: R1 전송을 지연하고 R2를 먼저 반영한 뒤 R1을 해제해도 서버는 R2를 유지한다. timeout·재시작·복원 이후에도 같은 보장이 성립하고 로컬 synced 상태가 서버 결과와 일치한다.
- 먼저 격리 서버/임시 DB로 검증한다. 실제 배포는 호환성·백업·되돌리기 계획이 준비된 후 별도 승인으로 진행한다. 앱 코드 수정만으로 운영 문제가 해소되었다고 보고하지 않는다.

### G — 카탈로그 요청 소유권과 페이지 재시도 (U4, U6, U7)

- 소유 경로: `app/mobile-client/Catalog.tsx`, `CatalogReader.tsx`, PC `OnlineCatalogBrowser.tsx`, `PageViewer.tsx`, 카탈로그 명령/query 경계.
- G1: 작품·검색·화면 활성 상태 변경 시 Reader 요청 취소 및 generation 무효화; 응답의 작품/provider/publication identity와 제목을 함께 관리한다.
- G2: 이전 네이티브 검색/COUNT를 취소할 수 있게 하고 최신 대기 요청이 결국 처리되도록 한다. 기존 작업 상한은 유지하며 슬롯 부족을 데이터 오류와 구분한다.
- G3: 실패한 만화 페이지만 재시도하고 위치·포커스를 유지한다. 만료 URL은 필요한 경우 기존 해석 경로로 갱신한다.
- 게이트: 지연된 A 읽기 응답이 B 상세/다른 탭에서 뷰어를 열지 않는다. COUNT 네 개가 막힌 상태의 다섯 번째 최신 검색이 수동 재입력 없이 처리되고 표시 조건과 결과가 일치한다. 첫 페이지 요청 실패 후 뷰어를 닫지 않고 복구된다. PC/Android 각각 해당 런타임 증거를 확보한다.

### H — Windows 영상 준비의 timeout/취소 (U8)

- 소유 경로: `library/video_media.rs`, 프로세스 실행 경계와 영상 준비 테스트.
- 기존 제한 실행 방식을 활용해 일반 영상 작업에도 종료 기한·취소·자식 프로세스 종료 및 회수를 적용한다. 기한 값은 작업 특성과 기존 Linux 정책을 확인해 소유 모듈에서 정한다.
- 게이트: 종료하지 않는 합성 프로세스가 기한 뒤 회수되고 해당 영상은 실패로 전환되며 다음 영상이 처리된다. 정상 긴 영상과 취소도 확인한다. Windows 네이티브 실행 증거가 없으면 완료 대신 `VERIFY`로 남긴다.

### I — Android 권한 재현 및 성능 측정 (R1, H1, H2)

- I1: 격리된 수신 앱에서 폴더 A의 영속 tree grant를 얻고 자산을 B로 이동한 후 옛 URI 접근을 시험한다. 별도 document grant를 구분한다. 재현되면 현재 membership/revision을 검증하는 권한 판단으로 수정한다. 보안 문제로 확인되면 남은 편의 기능보다 우선 처리한다.
- I2: 준비된 썸네일과 동일 화면에서 masonry 누적 1천/1만/5만 항목의 스크롤·React commit·메모리를 측정한다. Android는 캐시 1천/1만 파일에서 네트워크 변수를 통제해 miss 처리와 잠금 보유 시간을 비교한다.
- 게이트: 장치·빌드·자료 규모·cold/warm 조건과 측정 방법을 기록한다. 비용이 확인된 경우에만 범위 검색 인덱스나 캐시 정리 방식 개선을 선택한다. 미측정 가설을 확정 병목으로 승격하지 않는다.
- 리뷰의 선택적 UX 제안인 뷰어의 전체 결과 연속 탐색은 이번 결함 수정에서 보류한다. 현재 로드 범위 계약을 바꾸는 별도 제품 결정이다.

## 채택한 정책

- **유사 이미지 교체 위치:** 기존 이미지의 직접 분류를 유지하고, 기존 이미지가 미분류이면 후보의 요청 분류를 유지한다. 직접 분류가 이미 여러 개이면 조용히 하나를 선택하지 않고 거절한다. 기존 여러 소속 자료의 정리 규칙은 별도로 정한다.
- **완료 안내:** 5초 후 자동 숨김을 적용한다. 새 안내가 오면 타이머를 교체하고 진행 중 상태·조치가 필요한 오류에는 같은 자동 숨김을 적용하지 않는다.
- **기존 캐릭터 폴더 등록:** 직접 소속을 기본으로 하고 하위폴더 포함은 대상 수와 함께 명시적으로 선택한다. 기존 캐릭터가 있으면 새 중복 생성 대신 연결 대상을 선택한다.
- **DB 복원 후 replication revision:** 단순 증가 정수만으로 복원/구버전 요청을 처리하지 않는다. 서버 revision CAS와 자산별 로컬 직렬화를 사용하며 호환 전환은 위 F 실행 기록을 따른다.

## 리뷰 항목 대응표

| 원본 리뷰 | 작업 |
| --- | --- |
| Q1 | A |
| Q2, Q4, Q5, Q8 | E |
| Q3 / U1 (중복) | B |
| Q6 | F |
| Q7 / U3 | C |
| U2 | B |
| U4, U6, U7 | G |
| U5 | E |
| U8 | H |
| R1, H1, H2 | I |
| CHAR-UI-002~005 / CHAR-UI-006 | D / C |

---

# P0 — correctness and operational truth

## CLOUD-006 — Full library cloud replication for mobile

Status: `DONE` — user accepted closure on 2026-09-06.

The major feature is implemented and already proved against the real library:

- prepare -> upload -> commit replication exists;
- retries, reconciliation, incremental replication, mobile APIs, and media tickets exist;
- the completed real-library backfill must not be rerun by default;
- Galaxy Tab browsing from the server replica has been verified.

Accepted closure criteria (user confirmation; no new operational run in this update):

- a paused supervisor must never start a new queued replica cycle;
- the current pause guard and regression test must be executed and verified in the real app;
- an in-flight cycle may finish, but no next cycle may begin while paused;
- paused state must survive restart with pending work unchanged;
- Resume must process the existing queued work once without reseeding/full backfill.

The repository-audit candidate `CLOUD-008` is absorbed into this item. Do not create a second long-lived Cloud pause feature after this closes.

Acceptance:

- focused supervisor timer/control-state tests pass;
- real pause -> wait -> restart -> resume passes with a queued item;
- idle incremental replication still works automatically;
- user confirmation closes this item; do not rerun the full backfill.

## BUG-013 — Asset viewer opens are never recorded

Status: `DONE`
Original scheduling note (completed): P1 correctness prerequisite after CLOUD-006 closure.

Original pre-fix audit evidence (not current behavior):

- `recordAssetOpened` exists through gateway, Tauri, Rust, schema, and tests;
- production viewer code has no caller;
- the audited live `asset_activity` rows had exposure history but zero recorded opens.

Original goal (implemented session semantics are recorded below):

- record one open per active asset transition in the full Asset Viewer;
- count initial viewer entry and next/previous/sibling navigation;
- do not count hover, selection, thumbnail visibility, preload, or Inspector-only interaction;
- deduplicate StrictMode/rerenders within one uninterrupted viewer session;
- close/reopen of the same asset is a new deliberate open;
- telemetry failure must never block viewer rendering.

No migration is required. Do not fabricate historical open data.

Implemented evidence:

- the full Asset Viewer records initial entry and active-asset navigation through the existing activity gateway;
- a viewer-session asset-ID set prevents rerender/StrictMode duplicates and resets on close;
- rejected or synchronously failing telemetry is isolated from viewer rendering;
- focused frontend coverage includes selection/non-viewer exclusion, previous/next and source-group navigation, close/reopen, StrictMode, and telemetry failure.

This is a prerequisite for activity-based `STATS-001B` and `IDEA-001` scoring.

## CLOUD-UI-001 — Durable Cloud status, diagnostics, and problem surface

Status: `VERIFY`

Already present:

- Cloud enablement/base URL/token status;
- connection test;
- manual inbound sync;
- recovery/backfill controls;
- transient manual result summaries.

Implemented status boundary (schema v38 onward, retained and extended):

- durable last attempt;
- durable last success independent of later failure;
- sanitized last error;
- persisted last processed summary;
- current combined actionable problem count;
- conditional `동기화 문제 N` navigation into the existing Cloud Settings/recovery surface.

2026-09-06 implementation: the existing `cloud_activity` persistence already records
attempt/success/error/processed summaries per direction and metadata publishing. The
new sidebar indicator consumes the existing supervisor event stream, with one initial
read and no additional timer. It counts current failed queue items plus independent
capture/metadata errors; a replication error is not added again when failed assets
already represent it. Settings explains that count and links to existing recovery
controls. Public queue errors are fixed messages and resolved queue entries no longer
appear as current errors. Native acceptance of this new indicator remains separate
from the user-accepted CLOUD-006 pause behavior.

Verification: focused UI status/count/navigation tests and the Rust queue-error
redaction/resolution test passed. The new indicator has not been exercised in the
native app; use existing data/status and do not seed a new backfill for verification.

Direction:

- extend the existing local settings/status boundary rather than create a second diagnostics service;
- persist only sanitized public errors, never tokens, signed URLs, object keys, or local paths;
- reuse the existing supervisor polling cadence rather than add another timer.

Prerequisite satisfied: CLOUD-006 pause semantics are DONE. Remaining verification belongs to this indicator, not a new full backfill.

---

# P1 — Online Manga Catalog lane

## CATALOG-002A — Provider-aware identity contract

Parent item: legacy `CATALOG-002`
Status: `DONE`

Goal:

- make every public catalog identity explicitly `(provider, provider_work_id)` before persistent grouping or a second provider;
- keep the existing VCK/kHentai catalog database and numeric IDs unchanged internally;
- preserve existing bookmarks and reading progress, which are already provider-namespaced;
- legacy state without provider defaults to kHentai;
- do not introduce a generic plugin system.

This is the prerequisite for provider-safe groups and Heliotrope coexistence.

Completed evidence (2026-09-05):

- public Rust/TypeScript catalog work, detail, gallery, bookmark, progress, command, and thumbnail contracts now carry `(provider, providerWorkId)` explicitly;
- legacy search payloads without `provider` deserialize as `kHentai`, while the existing numeric VCK database IDs and provider-namespaced bookmark/progress rows remain unchanged;
- React keys and pending/open state use a composite provider-qualified key, with regression coverage proving equal provider work IDs do not collide;
- the `heliotrope` namespace is recognized for durable identity isolation, but search/detail/read paths fail closed without enabling Heliotrope network integration or migration.

## CATALOG-003 — Independent Japanese-language source

Status: `DONE`

Implemented and fixture-verified:

- typed Korean/Japanese ingestion on the existing authenticated VPS transport, with Korean legacy default and a Japanese response acknowledgement;
- provider/language-qualified `CrawlState` checkpoints and status, Korean legacy migration, independent resumable cursors, and a zero-boundary Japanese initial pass;
- atomic work/tag/checkpoint page commits, low-ID Japanese upserts, replay/rollback coverage, and canonical cross-language membership preservation;
- separate Settings progress/error/recovery, Japanese-only checkpoint reset, bounded manual initial pages, and automatic incremental updates only after initial completion;
- Korean default browsing and existing search/visibility/performance behavior preserved; no schema/index change or catalog replacement.

Operational gate verified: the production VPS language contract and Japanese
acknowledgement passed. The bounded real-source canary passed with exactly two
pages / 100 Japanese works on a verified SQLite backup's disposable copy,
including ID 4169846 below the prior global/Korean maximum 4169932. Independent
checkpoint progression, reopen/resume, replay idempotence, unchanged Korean
state, and both language memberships on 16 overlapping works were verified.
Post-canary SQLite quick-check passed and the original catalog SHA-256 was
unchanged. No active-catalog ingestion or broad initial crawl was run.
See [catalog troubleshooting](../agents/catalog-troubleshooting.md#bounded-real-source-canary-deployment-gate)
for the exact procedure and retained-backup requirement before active-catalog mutation.

Prerequisite: CATALOG-002A.

## CATALOG-004 — Advanced VCK-style query language + result hydration fix

Status: `DONE`

Before this completed batch, the implementation supported plain title text and one exact `namespace:value` form. The implemented result is recorded below; this is not pending work.

Target grammar is deliberately bounded:

- plain and quoted title terms;
- `namespace:value`;
- unary `-` / `NOT`;
- explicit `AND` / `OR`;
- parentheses;
- implicit AND between adjacent primaries;
- `id:<value>`;
- `category:<alias-or-code>`;
- `uploader:<value>`;
- `pages`, `pages>`, `pages>=`, `pages<`, `pages<=`.

Implementation:

- small Rust tokenizer/parser/AST/compiler adjacent to the current catalog query code;
- precedence: NOT > AND/implicit AND > OR;
- bound parameters only; user values are never interpolated into SQL;
- keep provider, language, expunged, category policy, and blocked-tag policy outside user syntax as mandatory/default predicates;
- structured syntax errors must preserve the previous valid result set in the UI.

Performance scope folded into this item:

- replace current per-result artist/series `tags_for()` calls with one bounded bulk tag hydration query for the page;
- this absorbs the audit candidate `PERF-004`; do not create a separate performance project for the same query surface;
- measure before adding FTS5 or temporary hit tables.

Completed evidence (2026-09-05):

- a bounded Rust tokenizer/parser/AST/compiler now supports title and quoted terms, exact namespace predicates, unary negation, explicit and implicit Boolean operators, parentheses, typed ID/category/uploader predicates, and page-count comparisons with source-positioned syntax errors;
- every user value is compiled to a SQLite bound parameter, including escaped title wildcard patterns, while provider, optional language scope, bookmark scope, and mandatory expunged policy remain outside the user expression;
- result artist/series hydration is one bulk query for a non-empty page (zero for an empty page), replacing the former per-result `2N` lookup path with parity coverage through the 100-result page limit;
- the desktop keeps the previous valid result set when a structured `catalog_query_syntax` error arrives and still ignores stale search responses;
- the representative 100-result fixture query, including bulk hydration, measured approximately 5–6 ms in the recorded debug test runs; no FTS5 or temporary hit tables were added.

Prerequisite: CATALOG-002A. CATALOG-003 may proceed independently after that contract.

## CATALOG-005 + CATALOG-006 — Catalog visibility/block policy

Status: `DONE`
Completed as one implementation batch after CATALOG-004; the retained requirements below are not a new execution request.

One persistent policy must cover:

- hidden categories;
- exact blocked `(namespace, value)` tags;
- temporary `reveal blocked` override;
- one Settings management surface;
- identical predicates in result and count queries;
- future group representatives chosen only from visible members.

Persistence belongs in additive `library.sqlite` preference tables so existing metadata backup/restore protects it.

Do not implement either feature as post-pagination React filtering.

Completed evidence (2026-09-05):

- schema v34 adds global hidden-category and exact `(namespace, value)` blocked-tag preference tables in `library.sqlite`; a full v33 fixture migration preserves existing catalog bookmark data;
- one reusable Rust visibility predicate is composed into the shared result/count `WHERE` clause, while `revealBlocked` removes only that predicate and leaves provider, language, bookmark, expunged, and user-query constraints intact;
- Settings manages persistent categories and exact tags with load retry, and the catalog's temporary reveal control re-queries page zero without React post-pagination filtering; reopening the catalog reloads policy-filtered counts;
- verification passed 38 focused Rust tests, 77 focused frontend tests, all 682 frontend tests, TypeScript typecheck, and the production frontend build.

## CATALOG-007A — Strong-lineage duplicate groups

Parent item: legacy `CATALOG-007`
Status: `DONE`

Strong-lineage grouping is now end-to-end. Conservative provider-safe lineage
materialization, durable group handles/preferences, source-revision tracking, exact
group cardinality/pagination, six eagerly prepared default counts, bounded exact
COUNT routing, streamed grouped API delivery, lazy editions, and manual/automatic
representative selection are implemented. The earlier grouped COUNT blocker was
closed with real-data measurements and the final native Tauri acceptance passed on
an isolated library/profile: 105 fixture works produced exactly two cards (one
singleton plus one 104-edition lineage group), editions loaded 40 → 80 → 104, and a
manual representative persisted across dialog reopen before automatic selection was
restored. The active production library was not opened or migrated for this check.
See [final COUNT and native acceptance evidence](../operations/catalog-hybrid-count-gate.md);
the earlier [stopped performance gate](../operations/catalog-lineage-performance-gate.md)
is retained as historical evidence.

Goal:

- materialize only high-confidence provider-safe lineage groups first;
- result cardinality and pagination operate on groups/singletons, not raw rows folded in React;
- return representative + stable group ID + version count;
- every edition remains accessible;
- no provider work is deleted or irreversibly merged.

Representative ranking must consider:

- manual representative when present;
- preferred language;
- current visibility/block policy;
- completeness/thumb availability;
- deterministic lineage/current-edition signal;
- deterministic tie-break.

Prerequisites: CATALOG-002A, CATALOG-003, CATALOG-004, CATALOG-005/006.

## CATALOG-007B — Reviewed heuristic duplicate groups

Status: `DONE` — accepted by the user on 2026-09-06 after hands-on testing.
Implementation/native checks passed. The user explicitly waived the remaining
incident-audit gate; the unavailable pre-incident provider DB/checkpoint baseline
remains an evidence limitation, not a completion blocker. No recovery was performed.
Prerequisite: CATALOG-007A.

Implemented in the working tree:

- Schema **37** adds `online_catalog_review_candidates` (replaceable) and
  `online_catalog_review_decisions` (authoritative) in library.sqlite. Both use
  ordered pairs of existing kHentai provider-work anchors from 007A; no new UUID
  identity system, canonical provider writes, or foreign keys to replaceable data.
- Manual canary generation reads at most the latest **500 IDs** using the Works
  primary key. Eligible active works require an exact whitespace/case-normalized
  title or Japanese-title match of at least eight characters, shared exact
  artist/group tag, identical nonempty language sets, equal positive page counts,
  and equal known category. Punctuation, numbers and edition qualifiers remain.
  Title alone cannot create a candidate or a grouping relationship.
- 2026-09-06 extension: a Korean alternate title appended with ` | ` may be
  excluded from the comparison key while retaining bracketed identity qualifiers.
  Only these non-exact title matches permit a positive page-count difference of
  at most two pages and 10% of the shorter work. The review reason discloses the
  difference; this neither merges automatically nor selects a newer edition.
  Seven focused Rust review tests passed, including the 32/34-page example and
  exclusions for differing event/franchise/edition, language and larger page gaps.
- Each work has at most two title keys, each bucket at most **8** works; larger
  buckets are skipped. At most **3,500** pair examinations, **50** stored candidates,
  and **65** fetched creator/language tags per work (overflow is ineligible).
  Tag hydration uses the existing WorkId/Namespace primary key. Generation reports
  inspected works, comparisons and skipped buckets; it is absent from search SQL.
- The first canary permits at most **500 manual decisions**. Decisions are never
  removed to make room. Confirmation is accepted only for a current pending
  candidate; source revision, group generation and candidate algorithm must match.
  The request also carries a digest of the displayed evidence/context; regeneration
  in another window cannot make an old review screen authorize a replacement pair.
  False positive is permanent in this surface; split replaces a confirmation with
  a permanent veto. Neither veto can be undone through an ordinary confirm call.
- Rebuild applies confirmations above indivisible strong-lineage components,
  then uses existing oldest-handle reconciliation. A veto inside a transitive
  heuristic component quarantines that entire heuristic component; its strong
  components remain intact. Confirmations conflicting with a veto fail atomically.
  Existing strong lineage takes precedence when the source itself later proves
  a rejected pair is lineage-related; the veto remains stored, not deleted.
- Decisions do not depend on algorithm/source versions and keep dormant anchors.
  Candidate refresh cannot overwrite them. Historical handles resolve through
  existing anchors after confirm/split. Provider identities, bookmarks, reading
  progress and manual representative preferences retain their original scope.
- Review Dialog uses shared UI, shows both evidence works/current group UUIDs,
  titles, creators, pages, languages, category, reason and decision state. Opening
  lists only; generating and deciding require explicit actions. Metadata includes
  hidden works, as disclosed in the dialog. Save refreshes grouped search; pending
  candidates from a previous group generation become non-actionable.
- Review writes rebuild membership transactionally and invalidate prepared counts
  through generation; eager preparation refreshes counts afterward. Review can
  incur a full membership rebuild; no new discovery work is added to ordinary
  grouped COUNT/page queries. Whole-catalog review latency is not benchmarked.

Verified on 2026-09-05 (base/HEAD `5206961d44c3531228814bc96ee42c28880e3c16`):

- `cargo test --manifest-path src-tauri/Cargo.toml --lib catalog_ -- --nocapture`
  from app: **156 passed / 9 opt-in ignored**, exit 0. Includes grouped search,
  COUNT, lineage, schema preservation and bounded synthetic performance fixtures.
- Final expanded `--lib catalog_review -- --nocapture`: **6 passed**, exit 0.
  Covers title-only exclusion, multisignal candidates, source/version changes,
  reopen, veto regeneration suppression, indirect conflicts, stable handles,
  retained provider-work state, bounded discovery and v36→37 preservation.
- `npx vitest run src/manga/CatalogReviewDialog.test.tsx
  src/manga/OnlineCatalogBrowser.test.tsx src/library/client.test.ts`:
  **44 passed**, exit 0. `npx tsc --noEmit`: exit 0 after final frontend edits.
  After adding displayed-evidence concurrency tokens, the affected client/review
  subset passed **15 tests** and TypeScript returned exit 0 again.
- Corrected native acceptance used `npm run tauri -- dev --config <isolated.json>
  --no-watch`, a distinct app identifier, explicit fresh WebView2 dataDirectory,
  and a disposable six-work library. The blank setup page and fixture library
  path were verified before use. Actual WebView2/Tauri IPC and rendered UI showed
  5 groups before/after generation (2 candidates, 4 comparisons); confirm changed
  this to 4 groups/3 editions with the old public UUID. False positive persisted.
  Full restart after fixture source/derived-algorithm invalidation retained both
  decisions. Split returned 5 groups and the original 2-edition lineage; refresh
  and another full restart retained split/rejection with zero pending candidates.
  Native grouped page and exact COUNT both returned 5. The fixture has no catalog
  transport credentials, so unrelated updater failure is outside this acceptance.
  Final token-contract native check added two disposable works: a stale review
  token was rejected with 7 groups unchanged; valid confirm/split returned 6→7
  groups, while previous split/rejection decisions remained authoritative.
- Scoped critical self-review (not independent) checked automatic merge entry
  points, stale decisions, transitive vetoes, identity reconciliation, bounds,
  search coupling and provider scope. No cross-provider/Heliotrope code was added.
  `git diff --check` passed. Existing catalog acceptance-document edits and
  concurrently changed Phosphor prototype files were preserved outside this task.

**Production-boundary incident — not an authorized rollout:** the first native
launch relied on APPDATA/LOCALAPPDATA/WEBVIEW2_USER_DATA_FOLDER overrides, which
did not isolate the existing Tauri profile. It automatically opened
`C:\New_lakomics_assets`, migrated library.sqlite **36→37**, rebuilt group generation
**2→3**, and logged **6 automatic cloud-backfill commits** before the process was
stopped. Read-only comparison against the automatic pre-migration snapshot found
identical complete rows in group membership, handles, representative preferences,
bookmarks and reading progress; there are **zero manual review decisions** in the
production library. This does not establish absence of other startup/job side
effects. The preserved backup is
`C:\New_lakomics_assets\backups\pre-migration-20260905-092612-v36-165ef5b1-02d2-4488-af18-1f856a71d5aa.sqlite`.
No rollback or further production write was attempted. Recovery/disposition
requires separate explicit authority; this incident prevents an unconditional
DONE claim. Later isolated acceptance does not erase it. Test app processes were
stopped; Git writes and deployment were not performed.

**Production incident audit, 2026-09-05:** see the
[complete comparison, startup checklist and evidence limits](../operations/catalog-007b-incident-audit.md).
The exact comparison used the v36 backup named above against current
`C:\New_lakomics_assets\library.sqlite`; all SQL ran on disposable immutable copies.
The original DBs/sidecars and complete library file inventory remained unchanged
between the audit snapshot and final filesystem fence (09:53:46–10:04:31 UTC).

- Full keyed comparison of the 40→42 table union found **no deleted rows and no
  changed pre-existing user-domain rows**. Schema differences are exactly the two
  schema37 tables, both empty. Collections, classification definitions, ordering,
  favorites/personal metadata, trash, Revisit and library/cloud settings match.
- All 131,213 group members/handles, representative preferences (empty), 251
  bookmarks and 35 reading-progress rows match. Generation2→3 changes the grouping
  algorithm prefix, not provider revision. Six prepared counts retain their values;
  all context hashes and independent read-only COUNT results match.
- The six logged backfill commits were **six newly imported cloud captures**
  (three images, three videos), not old pending local uploads. Exactly six assets,
  six classification relations, six acknowledged receipts, six synced revision-1
  queue rows and three ready video records were added. All six originals match
  stored SHA-256/size. Preserve these results; rollback would discard acknowledged
  captures. Four older pending trash-asset queue rows remain unchanged.
- Startup recovery, ordering, artwork, similarity, backup scheduling, trash,
  release-watch, capture, video, replication, catalog preparation/update and view
  caches were traced. Surviving incident files comprise the six originals, three
  image thumbnails, 37 video derivatives, ten catalog thumbnails, two DB files and
  the migration backup. All 8,220 prior originals and referenced video/artwork files
  are present. Remote classification/saved-X snapshot publication is also invoked
  by capture polling; its outcome is not proven by the local log.
- Before/current library and current catalog copies passed full SQLite integrity
  and foreign-key checks; group-anchor/oldest-handle checks passed. No recovery was
  performed or indicated by these local results. Existing isolated native evidence
  remains applicable; this audit changed no implementation and did not relaunch.
- **Remaining evidence gap:** kdata.db mtime is inside the incident and its Korean
  attempt timestamp advanced. The unchanged provider revision, old crawl/progress
  timestamps and update transaction code support start/status-only writes. The
  retained backup contains no kdata.db, so exact source rows and Korean/Japanese
  checkpoint deltas cannot be proved. No source corruption was found. The user
  explicitly waived this audit gate on 2026-09-06 and accepted completion; no
  further baseline search is required for this item. A complete
  pre-incident filesystem manifest is also unavailable for transient/unreferenced
  files; all surviving incident-window files are accounted for.

Deferred: broader/fuzzy rules, whole-catalog discovery, negative-decision reversal,
more than 500 decisions, cross-provider/Heliotrope grouping, and production rollout.

## CATALOG-002B — Optional Heliotrope coexistence

Parent item: legacy `CATALOG-002`
Status: `TODO`

Goal:

- add Heliotrope as a disabled-by-default second metadata provider behind the authenticated Japanese VPS;
- keep a separate provider cache;
- preserve VCK/kHentai as the default/current provider;
- never assume Heliotrope metadata implies Lakomics can resolve/read pages;
- if no verified page resolver exists, reading stays unavailable for that provider;
- provider disable/cache clear must not remove user bookmarks/progress.

Prerequisites: CATALOG-002A and CATALOG-007A; preferably complete reviewed grouping behavior first.

---

# P2 — Personal library features

## CHAR-AUTO-001 — Native incremental character auto-tagging

- **Status:** `PARTIAL` — 2026-09-09 Linux 개발 앱에서 신규 이미지의 즉시 자동 분류와 속도 개선을 사용자가 확인했다. Native incremental owner는 구현됐고 renderer-driven automatic scans와 manual-scan automatic application은 비활성화됐다. 아래 성능·안전성 보완과 Windows 확인은 남아 있다.
- **Contract:** [Steady-state implementation review](../research/character-autotag-steady-state-review-20260909.md). Migrations 0050–0051 provide durable jobs/predictions, claim fencing, source/work generations, pause state, and bounded reconsideration cursors. Existing historical images are not automatically seeded.
- **Implemented:** native ingestion/classification/restore/similarity events enqueue jobs; target, series, hierarchy, manual learning and reference-source changes schedule bounded reconsideration of recorded unresolved work. One shared Python process serves manual and automatic work, retaining one query's features and up to 32 reference bundles. Complete candidate results publish atomically with conservative decisions, optional series move and job completion. Automatic decisions do not feed learned references or recursively enqueue their own moves.
- **Review behavior:** manual scans use the selected character; automatic completion does not start a scan or reset review selection. Durable evidence remains reviewable after restart, with explicit refresh for new results. Pause takes effect after the current image; transient failures retry up to three attempts and permanent failures remain visible in review.
- **Verification:** focused Rust character checks passed (43 tests), frontend review/automation checks passed (8 tests), and TypeScript passed. Four explicitly enabled native protocol tests cover shared process reuse, pause/resume, external reference replacement, and unchanged query/compare counts when same-scope history grows from 1k to 8k. Actual installed ONNX models produce identical legacy/resident-query results on synthetic temporary images, without repeated feature extraction. These are fixture/protocol checks, not a real-library latency benchmark.
- **사용자 확인 (2026-09-09):** 새 이미지가 들어오면 바로 분류되며 이전보다 빨라졌다고 확인했다. 이는 신규 이미지 자동 경로의 실사용 개선 증거이며 모든 검토/폴더 조작이나 Windows 동작의 완료 증거는 아니다.
- **첫 분석 관측 (2026-09-09):** 실행 중인 에이메스 수동 분석을 읽기 전용으로 관찰했을 때 약 20초에 비교 결과 9개와 특징 캐시 8개가 증가했다. 별도 20초 프로세스 표본에서 Python CPU 평균 545%였다. 설치된 런타임과 코드 모두 CPU 실행이며, 사용자 관측인 일부 장당 3~4초와 캐시 재사용 시 빠른 처리도 기록한다. 단일 실행 구간으로 전체 처리량이나 모델별 병목을 확정하지 않는다.
- **성능 후속:** 기존 이미지의 첫 분석에서 파일 검증·인물 검출·특징 추출·후보 비교 시간을 분리 계측한다. CPU 설정/영역 묶음 처리 개선은 결과에 따라 판단한다. GPU 지원은 현재 구현되지 않았으며 별도 호환성·결과 동등성·속도 검증이 필요하다. 신규 자동 경로의 개선을 전체 과거 이미지 첫 분석 성능 해결로 취급하지 않는다.
- **Remaining:** other native Linux interactions and Windows acceptance; representative cold/warm throughput and input-latency measurements; failed-job retry UX and old-evidence retention policy. Immutable snapshots plus final hash/identity fences protect inference, but Linux does not exclude an arbitrary external writer between the last identity check and SQLite commit; strict external-write exclusion remains open. Windows uses retained handles denying write/delete and still needs native validation. No production backfill was initiated.

## CHAR-UI-001 — Series / character navigation, registration, and review UX

Status: `VERIFY` — user approved implementation on 2026-09-08. Shared headers, in-gallery character registration, fixed-character review, and shared asset context menus are implemented. Windows/Linux native interaction acceptance remains pending.

### User requirements

1. **Ordinary folders:** remove the unconditional `캐릭터 검토` beside the folder name. Move `시리즈로 등록` into that header location, using a compact icon or similarly concise control instead of the separate content-area button.
2. **Series folders:** restore the series name in the header. Move character registration and hero-image controls into the same header; shorten labels or use icons. Match existing shared controls, icon style, spacing, and states. Compact the `수집 후 자동 분류` control at the far right, preferably an icon. Replace the character tile's `분석 준비됨` subtitle with a check mark beside its name; retain explanations for not-ready/inactive states.
3. **Character folders:** remove the `시리즈로` button and `캐릭터 에셋` heading. Put the character name in the header, with a small image count immediately beside it. Source clarification: the current `시리즈로` button navigates to the parent series; it does not promote a character into a series. The requested removal still stands; preserve a natural navigation route to the parent.
4. **Character registration / editing:** remove the `관련 폴더` UI. Select the representative thumbnail and reference images directly from the existing series asset gallery instead of a separate picker window. Reuse its `전체 보기` / `미분류만 보기` interaction. Other characters' assets must not appear in either picker, including when changing the gallery filter. Account for both other characters' confirmed assets and reference images; an existing character's own images remain available when editing that character.
5. **Review entry / left area:** expose analysis/review entry only inside a character folder. Fix the vertical/wrapped `시리즈 폴더` label. Fix the review context, character settings, and other character-specific information to the character from which review was opened; remove redundant series/character selection.
6. **Review right area:** fix the review target to the current character. Remove `선택 캐릭터 분석` and other redundant selection-oriented controls. The approved concise `분석` action retains the underlying analysis/retry capability.
7. **Review filters:** consolidate the excessive `추천`, `미확정`, `다중 후보`, etc. sections. The approved grouping uses two main views and compact additional filters, retaining unresolved work and failures.
8. **Image decisions:** show only the current character's decision in the selected image panel. Use `승인` / `거절`; do not list decision controls for every registered character.
9. **Context menus:** remove `캐릭터 검토` from asset-repository context menus. Restore normal context-menu behavior in registered series folders. Menu disappearance is user-reported; native reproduction and the exact affected surface (asset versus gallery background) remain to be checked during implementation.

### Existing behavior to preserve

- A confidently recognized image captured into a root category can be assigned to its series and character automatically.
- One physical image may appear in several recognized characters' folders. Unknown companions do not block a recognized character; ambiguous identities for the same person stay for review.
- `거절` applies to the current image/character pair, not every character in that image. Approving or rejecting here must preserve other characters' existing decisions and memberships.
- Manual series analysis remains scoped to that series; simplifying the visible review context must not remove competing-character checks needed for safe automatic decisions.
- Keep comparison checkpoints, resumability, and global background-work visibility when rearranging controls. Do not interpret UI-only requests as authorization to erase existing folder links, decision history, or recognition settings.
- Preserve Windows and Linux behavior and the existing asset-gallery/context-menu contracts. No Mobile redesign is included in this item.

### Accepted design direction

- Use the same compact location header for ordinary, series, and character folders. Show the current name on the left, context actions beside it, and automation state at the far right. Avoid creating an additional toolbar row. A breadcrumb or existing back navigation can replace the removed `시리즈로` button.
- Treat icon-only automation as a stateful control: distinguish on/off, running, and failure using shape/badge as well as color. Keep short tooltips and accessible names; do not hide failures behind a permanently indistinguishable icon. Global progress/pause remains available outside character folders, while review entry remains inside them.
- Define the name-adjacent check as **reference setup ready**, not **all images analyzed / all classifications correct**. This prevents an apparently completed check while background work remains.
- Use an in-place selection mode with `대표 이미지 선택` or `기준 이미지 선택 2/5`, plus `완료` and `취소`. Preserve the registration draft, gallery position, and prior filter on exit. Thumbnail selection is single-select; reference selection shows its existing required count. Other characters' assets remain excluded even under `전체 보기`; make that restricted selection scope clear.
- Make the review presentation character-specific while retaining internal comparisons against other plausible characters. A small read-only ambiguity reason may be useful, without exposing other characters' approval buttons.
- Start with two prominent review views, `검토 대기` and `확정`. Group recommendation/ambiguous-candidate work under review waiting; expose `전체`, `일치 없음`, `분석 필요`, `거절`, and failures through a compact filter or status entry. Failures must retain a visible count and retry route. These names and grouping were approved for this implementation.
- Remove the redundant word `선택 캐릭터`; retain a concise `분석` or `다시 분석` action for existing images, changed references, and failed work. Automatic classification alone is not a substitute for recovery controls.

### Acceptance checklist

- Verify ordinary folder, series folder, and character folder headers side by side, including long names and narrow window widths.
- Verify registration draft preservation, thumbnail single-selection, reference selection count, cancellation, and scrolling without opening a second picker window.
- Verify other characters' images cannot reappear through `전체 보기`, pagination, refresh, or a concurrent classification while selecting references/thumbnail.
- In a shared Towa/Noel image, review opened from Towa displays only Towa's decision controls and cannot remove Noel's membership.
- Check both asset and background context menus in ordinary, series, and character folders; preserve ordinary actions and multi-selection behavior.
- Check preparation, automation on/off, running, paused, failed, and completed states; distinguish reference readiness from analysis completion.

### Implementation evidence (2026-09-08)

- Existing ViewToolbar, anchored panel, buttons, Heroicons, design tokens, and date-grouped masonry gallery are reused. Ordinary-folder registration is contributed into the existing header; series/character names and actions share that header. Portrait tiles remain 3:4 with a 220px minimum column.
- Representative/reference selection uses the existing gallery with Done/Cancel, retained draft/filter/scroll state, and a restricted browse scope. SQL excludes other characters' confirmed/reference images before pagination, including unsaved characters and All mode. Strict saves revalidate eligibility inside the write transaction; existing stored folder links are preserved.
- Review entry is character-only; two main views plus compact filters, current-character approval/rejection, analysis/recovery, history, and close controls remain. Internal automatic competing-character comparisons and global automation status remain intact.
- Targeted frontend suite: 86 tests passed (characters, asset browser/toolbar, shared ViewToolbar); TypeScript checked. Character Rust suite: 27 passed, 4 pre-existing ignored tests. Additional targeted selection checks cover strict reference and thumbnail rejection without changing the previous references.
- Isolated browser fixture exercised series/character headers, registry-to-gallery selection and cancellation, fixed-character evidence, asset/background context menus, and automatic on/off. Layout inspected at 1280px and 900px, including long character names, using the real shared components and synthetic media; no production library writes were used for this verification.
- Linux dev app was rebuilt and relaunched through `npm run tauri -- dev` after verification. Remaining acceptance: native Windows/Linux titlebar/window controls, real media/drag-and-drop and production background running/paused/error states. Browser evidence and successful startup do not establish those native behaviors.

## CHAR-UI-002 — 캐릭터 폴더 제외 버튼 고정 및 다중 제외

Status: `VERIFY` — 2026-09-09 통합 계획 C/D에서 구현·격리 검증 반영. 네이티브 확인은 REVIEW-20260909 실행 기록 참조.

- 캐릭터 폴더의 `이 캐릭터에서 제외` 버튼을 섹션 상단바 쪽에 고정하여 갤러리를 스크롤해도 접근할 수 있게 한다.
- 이미지를 다중 선택한 뒤 선택한 이미지들을 현재 캐릭터에서 한 번에 제외할 수 있게 한다.
- 현재 `SeriesBrowser.tsx`에는 선택 ID 배열을 제외 API에 전달하는 경로가 있다. 기존 다중 선택/제외 동작을 확인하고, 상단 고정 액션에서 실제로 사용할 수 있도록 연결·검증한다.
- 제외는 현재 캐릭터와 선택 이미지의 관계에만 적용한다. 원본 자산과 다른 캐릭터의 소속은 보존하며 Windows/Linux 양쪽에서 확인한다.

### 추가 사용자 보고 — 선택 안내의 그리드 밀림 및 중복 (2026-09-09)

- **TODO / 재현 필요:** 캐릭터 폴더에서 이미지를 선택하면 `1장 선택`, `선택 해제` 영역이 새로 나타나 이미지 그리드를 아래로 밀어낸다. 상단바에도 `1장 선택`이 중복 표시된다.
- 사용자는 선택 안내를 오버레이로 바꾸는 방안을 제안했다. 우선 기존 상단바 한 곳에 선택 개수·선택 해제를 통합하고 높이를 유지하는 방향을 검토한다. 별도 오버레이가 필요하면 레이아웃 흐름에서 분리하되 이미지 클릭/스크롤을 가리지 않게 한다. 최종 배치는 아직 미확정이다.
- 선택 시작·추가·전체 해제 시 그리드 위치/스크롤이 변하지 않고 선택 개수는 한 곳에서 표시되는지 Windows/Linux에서 확인한다. CHAR-UI-005의 검토 상세 패널 문제와 구분한다.
- 이번 요청은 메모만이며 코드 변경이나 수정 완료를 의미하지 않는다.

### 추가 디자인 방향 — 캐릭터 폴더 상단바 정돈 (2026-09-09)

- **TODO / 아이디어 기록:** 사용자 제공 상단바 화면을 바탕으로 캐릭터 이름·이미지 수·검토·선택 작업의 우선순위를 정리한다. 코드 변경이나 최종 시각 디자인 확정은 아니다.
- 왼쪽은 `시리즈 › 캐릭터 이름 31장`으로 구성한다. 캐릭터 이름은 밝고 조금 굵게, 시리즈는 차분하게 표시하며 떨어져 있던 이미지 수는 이름 옆에 단위를 붙인다.
- 평소 오른쪽은 `검토 · 새로고침 · 더보기`로 간결하게 구성하고 비활성 제외 버튼은 숨긴다. 검토는 은은한 배경으로 강조하며, 대기 시 작은 호박색 점/배지를 제안한다. 대기 판정·접근성은 CHAR-UI-005의 검토 대기 표시 요구를 따른다.
- 선택 시 오른쪽을 `N장 선택 · 선택 해제 · 캐릭터에서 제외 · 더보기`로 전환하는 방향을 검토한다. 선택 개수 중복 표시는 없애고 상단바 높이를 고정해 그리드·스크롤을 밀지 않는다. 기존 상단 제외/다중 제외 요구를 이 영역에 통합한다.
- 정보·설정·일반 폴더로 전환 등 덜 쓰는 기능은 더보기 메뉴로 모은다. 일반 폴더 전환의 보존·확인 계약은 CHAR-UI-008이 소유한다.
- 기존 어두운 색조와 얇은 하단 구분선을 유지한다. 제외 액션은 중립색을 기본으로 하고 상호작용 시 경고색을 검토한다. 이름 왼쪽 약 24px 캐릭터 초상은 선택적인 장식 아이디어다.
- 좁은 창·긴 이름·큰 선택 개수에서도 창 제어 버튼과 충돌하지 않도록 반응형 배치를 확인한다. 기존 디자인 토큰과 공통 상단바를 재사용하며 정확한 크기·색·메뉴 구성은 구현 시 검증한다.

### 영상의 수동 캐릭터 지정 (2026-09-09)

Status: `VERIFY` — 영상도 분석 없이 캐릭터 폴더에 넣을 수 있도록 사용자 요청으로 수동 지정의 이미지 전용 제한을 수정했다.

- 시리즈 갤러리의 영상 선택 → 캐릭터 지정으로 연결하고, 캐릭터 갤러리에서 표시·열기·제외할 수 있게 한다. 현재 시리즈 범위 검증은 유지한다.
- 영상은 캐릭터 자동 분석, 기준 이미지, 추가 참조 대상으로 사용하지 않는다. 이번 변경은 영상 인물 인식이나 모든 드래그/외부 가져오기 경로의 신규 구현을 뜻하지 않는다.
- 격리 회귀 테스트는 영상 지정·갤러리 표시·제외, 시리즈 밖 지정 거절, 분석/참조/자동 큐 제외를 확인한다. 실제 영상 재생과 네이티브 Windows/Linux 상호작용은 별도 확인이 필요하다.

## CHAR-UI-003 — 하단 바 완료 안내 자동 숨김

Status: `VERIFY` — 2026-09-09 통합 계획 C/D에서 구현·격리 검증 반영. 네이티브 확인은 REVIEW-20260909 실행 기록 참조.

- 하단 바에 표시되는 `분석 완료` 같은 일시적인 안내/툴팁은 일정 시간이 지나면 자동으로 사라지게 한다.
- 성공 안내는 5초 후 숨기고, 진행 중 상태와 조치가 필요한 오류는 유지한다.

## CHAR-UI-004 — 기존 분류 폴더를 캐릭터로 등록

Status: `PARTIAL` — 기존 등록·일괄 연결은 구현·격리 검증됐고 네이티브 확인은 남아 있다. 아래 사용자 보고의 전환 후 중복 구조 정리는 추가 구현이 필요하다. 기존 검증은 REVIEW-20260909 실행 기록 참조.

- 사용자가 기존 일반 하위폴더(예: 시리즈 아래 `에이메스`)에 모아 둔 이미지를 새 캐릭터 체계로 연결할 수 있게 한다. 대상은 라이브러리의 기존 분류 폴더이며 외부 파일 폴더 가져오기와 구분한다.
- 기존 폴더에서 캐릭터 등록을 시작하고, 소속 시리즈·캐릭터 이름을 확인한 뒤 해당 이미지들을 캐릭터의 확정 이미지로 일괄 연결하는 흐름을 제공한다.
- 등록 시 기존 갤러리에서 대표 이미지와 기준 이미지 5장을 선택하고, 포함될 이미지 수를 확인할 수 있게 한다. 중첩 하위폴더 포함 범위와 이미 등록된 캐릭터에 연결하는 경우의 처리는 구현 시 명확히 정한다.
- 기존 자산과 분류 구조를 보존하고 파일 복사·이동이나 자산 중복 생성 없이 캐릭터 관계를 연결한다. 다른 캐릭터의 기존 소속과 판단 이력도 보존한다.
- 확정 이미지 일괄 등록만으로 모든 이미지를 추가 레퍼런스로 취급하지 않는다. 추가 레퍼런스는 기존 분석 근거 및 적격성 조건에 따라 처리한다.
- 구현 전에 기존 폴더 연결 계약과 등록 경로를 확인해 재사용하고 Windows/Linux 양쪽 동작을 검증한다. 이 기록은 운영 라이브러리 일괄 변경 실행 승인이 아니다.

### 추가 요구 — 기존 폴더 전환 후 중복 구조 정리 (2026-09-09)

Status: `TODO` — 요구사항 기록만 승인. 위 기존 등록 기능의 구현 기록과 구분한다.

- **사용자 보고:** 일반 캐릭터 이미지 폴더를 새 캐릭터 체계로 등록해도 기존 일반 폴더와 그 내용이 따로 남아 탐색이 혼란스럽다. 등록부터 기존 폴더 정리까지 이어지는 전환 흐름이 필요하다.
- 제안 흐름: 기존 폴더 선택 → 시리즈·캐릭터·기준 이미지 확인 → 기존 이미지 일괄 연결 또는 분석 후 검토 → 결과 확인 → 기존 일반 분류 정리. 사용자가 이미 정리한 폴더는 일괄 연결을 지원하고 불필요한 재분석을 강제하지 않는다.
- 원본 파일 복사나 자산 중복 생성 없이 기존 자산의 관계를 전환한다. 다른 캐릭터 연결은 보존한다.
- **미결정:** 기존 일반 폴더를 남기는 선택지/기본값, 시리즈로 분류를 옮기는 시점, 하위 폴더·비이미지·미승인 항목의 처리 범위. 등록에 성공했다는 이유만으로 남은 내용이 있는 폴더를 삭제하지 않는다. 기존 분류 보존 계약을 바꾸는 부분은 명시적인 전환 동작으로 설계한다.

## CHAR-UI-005 — 검토 화면 상세 패널의 그리드 밀림 및 다중 판단 수정

Status: `VERIFY` — 2026-09-09 통합 계획 C/D에서 구현·격리 검증 반영. 네이티브 확인은 REVIEW-20260909 실행 기록 참조.

- **사용자 보고:** 검토 화면에서 이미지를 선택하면 우측 상세 창이 열리면서 기존 좌측 이미지들을 밀어내고 그리드 배치가 망가진다. 패널을 열고 닫거나 선택 이미지를 바꿔도 그리드 배치와 스크롤·선택 맥락이 안정적으로 유지되도록 수정한다. 구체적인 패널 배치는 기존 공통 UI 및 PC 디자인 계약을 확인한 뒤 정한다.
- **사용자 보고:** 검토 화면에서 여러 이미지를 선택해 한 번에 승인하거나 거절할 수 없다. 다중 선택과 선택 개수 표시, 선택한 이미지에 대한 일괄 승인·거절을 제공한다.
- 판단은 검토를 연 현재 캐릭터와 선택한 이미지들에만 적용하고, 다른 캐릭터의 판단·소속과 원본 자산은 보존한다. 분석 근거가 오래되었거나 판단 불가능한 항목은 기존 검증을 유지하면서 처리 결과를 명확히 알린다.
- Windows/Linux에서 패널 열기·닫기, 창 너비 변경, 다중 선택 및 승인·거절 후 목록 갱신을 확인한다. 기존 선택·판단 API를 먼저 조사하고 사용자 보고와 실제 재현 결과를 구분한다.

### 추가 사용자 요구 — 캐릭터별 검토 대기 표시 (2026-09-09)

- **TODO:** 검토 대기 이미지가 있는 캐릭터 폴더는 해당 폴더 상단바의 `검토` 버튼에 느낌표·배지 등 눈에 띄는 표시를 제공한다. 표시 형태는 미확정이며, 검토 화면을 열기 전에 대기 여부를 알 수 있어야 한다.
- 현재 캐릭터의 실제 미해결 검토 항목을 기준으로 표시하고, 승인·거절 등으로 대기가 해소되면 갱신한다. 다른 캐릭터의 대기나 단순 분석 실행 중 상태를 검토 대기로 혼동하지 않는다.
- 아이콘만 사용하는 경우 접근 가능한 이름/설명으로 `검토 대기 있음`을 전달하고, 배지 출현으로 상단바나 그리드가 밀리지 않도록 한다.
- 코드 변경 없이 요구사항만 기록한다.

## CHAR-UI-006 — 검토 중 추가 레퍼런스 변경으로 인한 판단 중단 및 안내 개선

Status: `VERIFY` — 2026-09-09 통합 계획 C/D에서 구현·격리 검증 반영. 네이티브 확인은 REVIEW-20260909 실행 기록 참조.

- **사용자 보고:** 검토 도중 캐릭터 설정이 바뀌었다며 새로고침을 요구하는 안내가 반복된다.
- **코드에서 확인한 가능한 원인:** 수동 승인한 적격 이미지가 추가 레퍼런스로 등록되면, 기존 분석 결과의 `learnedReferences`와 현재 목록이 달라져 후속 승인·거절이 `Stale`로 거부될 수 있다. 사용자 사례의 정확한 발생 경로는 구현 시 재현·확인한다.
- 검토 중 승인으로 추가 레퍼런스가 늘어나더라도 연속 검토가 불필요하게 끊기지 않도록 한다. 분석에 사용한 기준 snapshot을 검토 동안 유지하고 새 레퍼런스를 다음 분석부터 적용하는 방향을 검토한다.
- 화면 새로고침으로 해결 가능한 상태와 재분석이 필요한 상태를 구분해 안내한다. 추가 레퍼런스 변경을 사용자가 캐릭터 설정을 직접 수정한 것처럼 표현하지 않는다.
- 기존 분석 근거의 삭제·내용 변경, 명시적인 기준 이미지 교체 및 승인 취소 등으로 판단 근거가 무효해진 경우의 보호는 유지한다. 단순히 `Stale` 검사를 제거하지 않는다.
- 연속 승인·거절, 다중 판단, 백그라운드 분석과의 동시 진행, 실제 기준 변경 시 복구 동작을 Windows/Linux에서 확인한다. CHAR-UI-005의 다중 승인·거절 흐름과 함께 검토한다.

## CHAR-UI-007 — 자동 선정된 추가 참조 확인 및 제외

Status: `TODO` — 2026-09-09 사용자 요구 기록. 코드 수정·운영 데이터 변경은 요청하지 않았다.

- 캐릭터별로 현재 어떤 이미지가 참조로 선정됐는지 확인하고, 잘못 선정된 이미지를 제외할 수 있어야 한다.
- 고정 기준 이미지 5장과 자동 선정되는 추가 참조를 구분해 썸네일·원본 접근을 제공한다. 선정 근거/출처 표시를 설계한다. 현재 추가 참조는 적격한 수동 승인 이미지에서 선정되며, 자동 확정만으로 추가 참조가 되는 것으로 표현하지 않는다.
- `추가 참조에서 제외`는 원본 삭제나 캐릭터 소속 해제와 구분한다. 제외한 이미지가 다음 선정에서 곧바로 다시 들어오지 않도록 제외 상태를 유지한다.
- 제외 후 해당 참조를 사용한 분석 근거의 유효성과 미해결 작업 재검토를 처리하되, 캐릭터 그룹 편집 같은 표시 변경과 혼동하지 않는다.

## CHAR-UI-008 — 캐릭터 삭제 시 같은 이름의 일반 폴더로 전환

Status: `TODO` — 2026-09-09 사용자 요구 기록. 원본을 그대로 남겨 두기만 하는 이전 제안보다 아래 전환 요구를 우선한다.

- 캐릭터 폴더를 없앨 때 그 내용물을 같은 이름의 일반 폴더에 모두 모아 보존한다. UI에서는 `일반 폴더로 전환` 등 실제 결과가 드러나는 명칭을 검토한다.
- 제안 위치는 해당 시리즈 아래이며, 확정 이미지와 기준·추가 참조가 빠지지 않도록 대상과 개수를 미리 보여준다. 원본 파일과 자산은 복제하지 않고 분류/관계를 변경한다.
- 일반 폴더 연결이 성공한 뒤 캐릭터 등록과 현재 캐릭터의 참조·연결을 정리한다. 다른 캐릭터의 연결은 보존한다. 중간 실패로 일부만 전환되지 않도록 원자성/복구를 설계한다.
- 사용자는 여러 차례 주의 안내를 원한다. 제안은 1차 전환 영향·대상 개수·보존 범위 안내, 2차 캐릭터 이름 입력 후 최종 확인의 두 단계다.
- **미결정:** 동일 이름의 일반 폴더가 이미 있을 때 합치기/이름 변경, 미확정 검토 후보 포함 여부, 공유 이미지의 분류 처리와 판단 이력 보존·정리 정책. 원본 보존과 모든 확정 내용물의 접근 가능성을 유지하며 구현 전에 확정한다.

## CHAR-UI-009 — 분류에 영향을 주지 않는 캐릭터 그룹

Status: `TODO` — 2026-09-09 사용자 동의한 방향 기록. 실제 시리즈 이동과 구분한다.

- **사용자 예시:** `버튜버` 시리즈 안의 `노엘`, `토와`를 `홀로라이브`라는 가벼운 표시용 그룹으로 감싼다. 두 캐릭터의 실제 소속 시리즈와 분석 범위는 계속 `버튜버`다.
- 그룹 생성·이름 변경·캐릭터 넣기/빼기·해제를 제공한다. 그룹을 열면 포함된 캐릭터 목록을 보여준다.
- 그룹 변경은 이미지 분류/원본 위치, 캐릭터의 시리즈 소속, 기준·추가 참조, 분석 캐시와 검토 근거에 영향을 주지 않는다. 재분석 예약이나 검토 무효화를 발생시키지 않는다.
- 그룹 삭제는 껍질만 제거하고 캐릭터를 시리즈 바로 아래로 돌려놓는다. CHAR-UI-008의 캐릭터 자체 삭제/일반 폴더 전환과 명확히 구별한다.
- 초기 방향은 같은 시리즈 내 한 단계 그룹이며 중첩 그룹·복수 그룹 소속은 범위에서 제외한다. 일반 분류 폴더와 혼동하지 않도록 `캐릭터 그룹`/`그룹으로 묶기` 등의 이름을 사용한다.
- **실제 시리즈 이동은 별도 미확정 사항:** 후보 범위, 참조 자격, 연결 이미지 분류, 여러 캐릭터 공유 이미지, 진행 중 분석/검토 무효화에 영향을 준다. 이번 그룹 요구를 실제 시리즈 이동 기능 구현 승인으로 해석하지 않는다.
- 위 전환·참조 관리·그룹 기능은 Windows/Linux에서 같은 의미로 동작하도록 설계한다. 이번 기록은 구현·마이그레이션·파일 이동·삭제·커밋·푸시 실행 승인이 아니다.

## NOTE-001A — Revision-safe server Notes foundation

Parent item: legacy `NOTE-001`
Status: `DONE` — encrypted API deployed; live HTTPS checks and verified SQLite backup completed.

Notes are a separate everyday text domain, not Asset metadata.

Initial server model:

- client-generated stable ID;
- versioned AES-256-GCM envelope; title/body and tombstone encrypted on PC;
- monotonically increasing revision;
- created/updated timestamps;
- tombstone deletion;
- cursor-paginated list;
- versioned JSON export/recovery.

Updates/deletes require expected revision and return conflict instead of last-write-wins.

Reuse the existing authenticated Cloud API and server SQLite patterns. Ensure server DB backup/recovery exists before real notes become relied upon.

2026-09-07 implementation: `server/lakomics-api/notes.py` provides authenticated paginated GET and revision-checked/idempotent PUT. Server tests cover authentication, vault separation, opaque storage, pagination and conflict retries. [ADR-0035](../adr/0035-encrypted-personal-notes.md) records the user's separate recovery-key decision. Deployment completed after user approval. Verified server backup: `/home/linuxuser/lakomics-api/backups/notes-20260907T084216Z/lakomics.sqlite3`. Live HTTPS encrypted PUT/GET/decryption, retry, stale revision 409, missing-auth 401, existing Collections and service health passed. The isolated test note was removed by exact vault/ID.

## NOTE-001B — Desktop Notes section

Status: `PARTIAL` — desktop implementation and isolated checks; native acceptance pending.
Prerequisite: NOTE-001A.

Add a dedicated sidebar destination and list/editor with explicit unsaved/saving/saved/error/conflict states.

A conflict must offer a safe decision such as reload server copy or duplicate the local draft as a new note. React must never receive/store the Cloud bearer token.

2026-09-07 implementation: Notes below Revisit, list/editor, title/body search, pin, immediate encrypted local autosave, trash/restore, sync status, conflict-copy recovery, recovery-key setup and encrypted file backup/import. Schema 43 stores ciphertext and durable pending state; key stays in Windows Credential Store. Rust fixture tests cover wrong keys/tamper, local CAS, conflict preservation, atomic backup recovery and two-device encrypted exchange. Frontend tests cover in-flight edits, stale sync, save retry, editor flows, setup, navigation and close guards. Browser checks use an isolated in-memory UI fixture. Remaining: real Windows credential/dialog/close behavior, active-library migration approval, server backup and live sync acceptance. Mobile Notes is outside this PC task.

2026-09-07 deployment checkpoint: actual Windows Credential Store persistence across Library reopen, wrong-key rejection and cleanup passed an opt-in native test using a temporary library. Live server checks passed after approval. The pre-existing dev watcher had already applied schema 43 before that approval; the earlier no-production-change claim was incorrect. Its automatic v42 backup `pre-migration-20260907-080946-v42-9246ca7d-c8cc-48d9-a93b-3ddbb7dd1d2b.sqlite` passed quick_check. Current-state backup `before-notes-deployment-20260907-174041.sqlite` also passed. Active schema 43 quick_check is ok, with zero user Notes. Latest dev app is running. Remaining native UI acceptance: user key setup, file dialogs and close-during-edit through the actual Tauri window; native UI automation was unavailable.

### 추가 사용자 보고 — 입력마다 동기화 상태 문구가 반복 변경됨 (2026-09-09)

- **TODO / 재현 필요:** 메모 편집 우측의 `동기화`, `PC에 저장된 동기화 대기` 문구가 한 글자를 입력할 때마다 빠르게 바뀌어 산만하다.
- 표시 위치·폭을 안정적으로 유지하고 입력 중 상태 문구 전환을 묶거나 지연하는 방안을 검토한다. 정확한 표시 문구·전환 간격은 구현 시 결정한다.
- 표시 안정화를 위해 로컬 자동 저장을 늦추거나 저장 전 완료로 표시하지 않는다. 로컬 저장과 서버 동기화의 실제 상태를 구분하고, 오류·충돌·지속적인 오프라인 대기는 인지 가능하게 유지한다.
- 연속 입력·입력 중단·동기화 완료·실패/재시도에서 문구 깜빡임과 레이아웃 변화를 확인한다. 코드 변경 없이 사용자 보고만 기록한다.

## STATS-001 — Personal statistics

Status: `PARTIAL`

Split into two truthful phases.

### STATS-001A — Inventory Statistics

Status: `VERIFY`
No activity prerequisite.

Use current authoritative data for bounded aggregates such as:

- media-kind totals;
- collected counts by local month;
- top creators;
- current direct classification counts;
- favorites;
- reliable original/derivative storage totals.

Aggregate in Rust/SQL, not React, and make metric definitions visible.

Implemented 2026-09-06: Management -> Statistics shows normal-Asset totals,
favorites/unclassified counts, Collection total, local collection-month buckets (24),
top creators/direct classifications (10), and recorded original bytes. Explicit
derivative measurement snapshots at most 10,000 registered paths, releases the DB
lock, and reports measured/missing/partial totals. No full filesystem scan on entry.

### STATS-001B — Activity Statistics

Status: `VERIFY`
Prerequisites: BUG-013 and STATS-001A.

Add only recorded-era activity views, for example:

- most-opened assets/Collections;
- long-unseen items;
- recent bounded daily patterns.

Record Collection opens with the same deliberate-session semantics used for Asset opens. If daily rollups are needed, use bounded aggregate rows rather than unbounded raw history.

Always show the telemetry start date. Never infer past opens from file dates or exposure counts.

Implemented 2026-09-06: most-opened Assets/Collections, Assets not opened for at least
30 days, and recorded daily opens. v42 adds Collection activity, a start timestamp and
bounded daily triggers (90 retained dates; 30 displayed); existing counters are never
backfilled into dates. Legacy Asset cumulative telemetry start remains explicitly
unknown. Collection recording uses a per-detail-session set and isolates failures.

Verification for A/B: four focused Rust tests and four frontend tests passed, including
migration without fabricated history, trash exclusion, direct counts, session replay,
and optional storage measurement/retry. TypeScript passed. On 2026-09-06 the user
authorized v42 application: SQLite backup `before-statistics-v42-20260906-212711.sqlite`
was retained, quick-check passed, and all 43 pre-existing tables retained identical
row counts and data hashes before app startup. Collection/daily history starts empty;
no historical activity was fabricated. Feature-level native/visual acceptance remains open.

## IDEA-001 — More varied Revisit mixes

Status: `PARTIAL` — IDEA-001A scoring/feedback/cooldown is implemented; IDEA-001B theme expansion remains.

The creator/date/surprise foundation now consumes BUG-013 deliberate opens and recorded exposures.
Mobile Home's classification/date/creator discovery improvements remain separate from the PC theme work below.

### IDEA-001A — Scoring, feedback, and cooldown correctness

Status: `DONE` (2026-09-08)
Prerequisite: BUG-013.

- version the daily slate algorithm;
- apply hard recent-exposure cooldown then explicit fallback tiers;
- use days since open/exposure, counts, collected age, favorite where available, and saved preference weights;
- add a small `덜 보기` feedback affordance;
- keep one deterministic complete slate transaction per local date/revision.

Implemented evidence: Revisit v2 applies a 14-day exposure / 30-day open strict cooldown with
3-day / 7-day fallback before an open fallback, then scores age since open/exposure, counts,
collected age and favorite state. Recommendation-type feedback reduces bundle frequency and
creator feedback down-ranks that creator, both clamped at -5. Creator bundles now contain one
creator rather than a mixed pool. Existing v1 daily bundle IDs are regenerated once into the v2
algorithm while same-day v2 slates remain deterministic. Rust Revisit tests pass 10/10, the full Revisit frontend passes 13/13, and TypeScript passes. No production library was opened for this work.

### IDEA-001B — Theme expansion

Status: `TODO`
Prerequisite: IDEA-001A.

Candidate themes:

- favorite-seeded discovery only when favorites provide real evidence;
- bounded period nostalgia;
- recently collected but rarely opened;
- favorite + discovery only when favorites exist;
- cross-classification discovery;
- bounded collection-session/source-group rediscovery where durable grouping exists;
- Collection-level high-rated discovery only where Collection scores actually exist.

A theme label must match its actual selection logic. Missing data should omit/fallback rather than fabricate meaning.

---

## IDEA-002 — Asset date timeline exploration

Status: `HOLD`

User decision (2026-09-06): defer changes to Asset Repository scrolling. Of the explored alternatives, the date timeline was the most appealing, but its fit with Lakomics remains uncertain; this is not an approved implementation direction.

- Revisit a compact date timeline showing daily asset counts and allowing direct date jumps for large libraries.
- Preserve date grouping and the time caption beneath each asset; account for both sparse days and days containing many assets.
- Evaluate compatibility with the restrained NieR:Automata-inspired UI and existing browsing workflow before adopting it.
- Screen-by-screen paging and calendar drill-down were comparison ideas, not accepted requirements. Do not assume the proposed paging/timeline combination was approved.
- Keep current scrolling behavior until the user resumes this discussion.

---

# Similarity / media identity lane

Czkawka is a design/reference source only. Keep Lakomics' existing PDQ-based fingerprint and review semantics; do not replace them with Czkawka's image hash stack wholesale. `czkawka_core` is MIT-licensed, but any code reuse still requires an explicit dependency/license decision.

## SIMILARITY-002A — EXIF orientation normalization before PDQ

Status: `DONE` (2026-09-08)

- normalize decoded image orientation from EXIF before generating the existing full + 5% crop PDQ fingerprints;
- preserve the current quality gate, distance threshold, crop tolerance, and Similarity Review decisions;
- add fixtures proving equivalent rotated-by-metadata images converge without increasing unrelated-image false positives.

Implemented evidence: the existing `image` decoder now applies EXIF orientation before PDQ and
new ingestion thumbnails use the same orientation. Display dimensions follow the oriented image.
Schema 47 clears only JPEG/JPEG-extension/WebP PDQ state so the existing bounded indexer lazily
recomputes old orientation-capable hashes instead of mixing old and new hash semantics; PNG/GIF
state is left alone. The actual EXIF-6 JPEG fixture converges at the existing PDQ <=20 threshold,
and the v46->v47 migration fixture passes. Quality 50, distance 20, 5% crop fingerprints and
Similarity Review decisions were not widened. The final Rust library regression is 774 passed / 0 failed / 18 explicit ignored. Czkawka remains a design/reference source only.

## SIMILARITY-002B — PDQ geometric-invariance candidates

Status: `TODO`
Prerequisite: SIMILARITY-002A.

- detect mirror/flip and 90/180/270-degree transformed reposts while keeping canonical stored fingerprints unchanged where practical;
- prefer query-time/incoming-image transform hashes first so the existing library does not require an unconditional full reindex;
- keep aspect/quality gates and run the existing PDQ minimum-distance check as final verification;
- benchmark false positives on real Lakomics artwork before widening default matching behavior.

## SIMILARITY-003 — Similar-video fingerprinting and review

Status: `PARTIAL` — the bounded implementation slice is complete: explicit 2–100-video
temporal PDQ analysis, durable pause/resume, separate normal-video pair decisions and the
existing review surface's video pane are integrated. Full Rust regression is 769/769 passed,
and explicit native FFmpeg re-encode/resolution plus timeout/cancellation checks pass.
`PARTIAL` is retained for the representative real-video positive/hard-negative accuracy gate
and production-library/native product acceptance. See
[execution evidence](../research/video-similarity-execution-plan-20260908.md).

- extend the existing FFmpeg/video preparation foundation with bounded temporal frame sampling;
- use duration/window gates before expensive comparison;
- detect re-encode/resolution variants and evaluate trimmed/subclip, letterbox/crop, and watermark cases;
- reuse the existing Similarity Review decision surface rather than creating a second duplicate workflow;
- treat audio fingerprinting as a later optional signal, not a first-pass dependency.

## PERF-SIMILARITY — Metric index / BK-tree gate

Status: `HOLD`

The current linear PDQ scan is retained. A recorded release benchmark scanned 50,000 candidate rows in about 41 ms, so a BK-tree or equivalent metric index is not justified yet.

Reopen only when representative 100k+ / 250k+ library benchmarks or measured ingestion latency show the candidate scan is a material bottleneck. If adopted, index both stored full/crop PDQ hashes and deduplicate asset IDs before the existing exact policy checks.

---

# Mobile lane — Galaxy Tab production client

The approved consumption specification is `docs/agents/mobile-consumption-ux.md`.

The current browser/mobile-extension prototype remains a verified behavioral reference, not the preferred production destination.

## MOBILE-001 — Direct authenticated native Android shell

Status: `PARTIAL`

The 2026-09-07 installed APK checkpoint, 0.3.3 (10), implements direct authenticated browsing, Keystore credentials,
lifecycle/back handling, pending Capture previews and a shared 1 GiB media cache with
usage/clear controls. Galaxy Tab browsing is in use; the earlier no-install checkpoint
is superseded. Remaining scope: Android system Share quick-save, optional extension
update management, and full provider/lifecycle acceptance. The extension's device-local
temporary save is implemented (EXT-006 below); it is not a general Android Share receiver.

Goal:

- establish the production Android client boundary without extension injection or `chrome.storage`;
- direct authenticated server client;
- Android secure token storage;
- classifications/assets/Revisit/media-ticket API parity sufficient for read-only browsing;
- reusable cache/auth/request-cancellation foundation for consumption UI and DocumentsProvider.
- an optional Extension Manager inside the same APK, while keeping the browser extension and Mobile library as independent runtimes;
- the manager may check versions, obtain a fixed-ID signed CRX, and hand the user into Titanium for install/update;
- signed-CRX adoption is gated by real Galaxy Tab verification: stable extension ID, update-over-existing behavior, browser restart, device reboot, and post-reboot usability;
- do not require a Titanium/Chromium rebuild, do not assume an external APK can call Chromium internal extension APIs, and do not assume silent install;
- retain unpacked SAF loading as a development/fallback route if the packed-extension gate fails.
- accept Android share intents for images/videos/screenshots so a system screenshot can be sent directly into Lakomics;
- provide a lightweight quick-save sheet with recent classifications plus permanent-save vs temporary/one-use storage choices;
- treat direct in-app screen capture (for example via MediaProjection) as an optional later enhancement; the first pass should rely on the system screenshot + Share flow.
- read-only access to server-stored pending Capture previews so a mobile client can show newly saved media while the desktop is offline;
- keep pending Capture identity/state separate from canonical Cloud Library Asset identity/state;
- reuse the existing authenticated pending-list/download boundary or a minimal mobile-safe adapter rather than exposing R2 object keys or credentials;
- define deterministic reconciliation after desktop processing so a pending Capture can disappear or be replaced when the canonical library result becomes observable.

Pending Capture visibility is a presentation/preview feature, not early admission into the canonical library. The local Lakomics library remains authoritative. The server must not promote a Capture into a canonical Asset merely so mobile can display it.

Do not change the stable browser X Collector merely to support the native client.

## MOBILE-004 — Approved portrait-first consumption UX

Status: `PARTIAL`
Installed Home/Library supports full-aspect justified rows, three densities, continuous
cursor loading, progressive media viewing and retained state. Continue/이어보기 and
the idle scroll-hint section were removed at user request; sidebar buttons lead the
Home/Library controls, and the native app hides system bars. Home adds visited/daily
classifications and date/creator Revisit groups. User device use and visual acceptance
are recorded; systematic cold/warm timing, large-video reliability and the complete
gesture/lifecycle matrix remain open. Do not restart the initial Home implementation.
Prerequisite for production integration: MOBILE-001. Pure layout/state algorithms may be developed/tested earlier.

Initial destinations:

- Home;
- Library.

Home order:

1. dominant canonical Recent gallery using `{type: "recent"}`;
2. visited classifications and daily classification covers;
3. secondary date/creator Revisit that must not delay first useful Recent paint.

Do not restore Continue/이어보기 cards without a new user request.

Gallery requirements:

- justified rows preserving every item’s full intrinsic aspect ratio;
- ragged final row allowed;
- video uses the same geometry with a clear marker;
- Large / Balanced / Compact target-row-height modes;
- density preference persisted on device;
- reflow should preserve the visual anchor where practical;
- bounded pagination/DOM.

State continuity:

- keep the previous useful grid until the new view’s first page commits;
- ignore stale/superseded requests;
- restore route/view, density, viewer sequence, and scroll position when returning;
- on foreground/visibility return, Home/Recent re-entry, or explicit refresh, silently refresh the first useful page instead of requiring a full page reload;
- reconcile changed server state in place so newly replicated canonical Assets appear without blanking the current grid or losing the visual anchor;
- portrait classification navigation is a drawer/sheet; landscape may use a persistent sidebar.

Pending Capture preview:

- Home/Recent may compose server-stored pending Captures with canonical Cloud Library results so media saved while the PC is offline becomes visible promptly;
- pending items must carry an explicit lightweight state such as `처리 대기` and must never count as canonical Asset/classification membership;
- ordering may use the server-received/capture time, but canonical Asset ordering remains authoritative once desktop ingestion finishes;
- after desktop processing, `Added` should converge to the canonical Asset without showing both copies;
- confirmed `ExactDuplicate` must not remain as a second pending tile once the existing canonical Asset is known;
- `ReviewPending` remains non-canonical and should be surfaced as review-needed or kept out of the ordinary canonical Recent stream until resolved;
- mobile does not independently reimplement the desktop duplicate/similarity decision; before desktop processing, a pending Capture may still later prove to be a duplicate.

Viewer requirements:

- image/video initially fit completely inside the usable Galaxy Tab viewport;
- contain/letterbox rather than crop;
- image pinch zoom only; pan only after zoom beyond fitted scale;
- fitted horizontal gesture belongs to previous/next;
- native video controls remain usable and do not trigger gallery swipes.

Progressive loading:

- reuse the already rendered thumbnail immediately;
- request original in the background;
- decode original before in-place replacement;
- never blank a useful thumbnail while loading;
- original failure leaves thumbnail/poster with non-destructive retry;
- preload at most previous and next image originals, deduplicated by asset/variant;
- do not preload neighboring video originals.

Remaining exclusions (Collections shipped separately in MOBILE-005):

- Online Manga Catalog;
- classification editing/bulk management;
- a third `display.webp` derivative;
- server/mobile write-back.

Device gate: pass all documented Galaxy Tab S11 portrait checks first, then landscape, and measure cold/warm first visual, original replacement, adjacent navigation, and video first frame before adding another derivative.

## MOBILE-002 — Read-only Android DocumentsProvider

Status: `PARTIAL`
The main APK now contains both read-only DocumentsProvider and API33+ CloudMediaProvider,
with classification folders/albums, stable identities, complete metadata snapshots,
cancellation and a shared 1 GiB cache. Selected file transfers are bounded to 512 MiB.
The old PoC remains installed separately; it is not the sole Picker implementation.
Full SAF grants/multi-select/recipient/cancellation and provider restart acceptance remain
open. A local temporary image was read successfully through the test recipient, but a
later real attachment Photo Picker showed an empty '이 기기에서' list despite existing
MediaStore files. Diagnose the launch/filter/provider difference; do not treat the test
recipient result as proof for every website. Samsung Gallery > albums > all did show
임시보관 with three files.
Prerequisite: MOBILE-001. May proceed in parallel with MOBILE-004 after the native cache/auth boundary is stable.

Initial boundary:

- one read-only Lakomics root in Android system file picker;
- classification folders;
- stable asset document IDs;
- cached cursor metadata;
- thumbnail support;
- short-lived on-demand media-ticket download to app cache;
- cancellation/cleanup and `notifyChange` after refresh;
- no rename/move/delete/upload-on-close in the first version.

## MOBILE-005 — Read-only Collections on Android

Status: `DONE` — deployed, source-cover repair verified and Galaxy Tab presentation
accepted by the user on 2026-09-07. All 340 Collections have primary cover references;
2,332 volume/edition covers are published. APK 0.3.2 removed cover effects/black boxes
and duplicate volume captions; the installed APK recorded on 2026-09-07 was 0.3.3. Manga Catalog remains
separate work under MOBILE-006/007/008.

Goal: PC-off Collection browsing, with PC owning metadata/artwork and Android viewing only. Keep game package/hero, manga volume shelf and movie poster/backdrop distinctions. Preserve IDs, editions and manual Showcase ordering; do not import provider artwork into Assets or expose provider configuration/local paths.

- [x] Server (`server/lakomics-api/mobile_collections.py`, registration in `app.py`, focused isolated-DB tests): authenticated immutable artwork preparation, atomic complete Collection snapshot publication with compare-and-swap revision, paginated type/search/Showcase list, detail and short-lived artwork tickets. Unpublished, empty and failed states must differ. Old snapshot remains readable after failed publication.
- [x] PC (`app/src-tauri/src/cloud/collections.rs`, cloud client/command registration and targeted fixture tests): side-effect-free snapshot extraction from existing committed rows; no provider fetch, migration or lazy volume/artwork import. Omit local paths/raw bindings. Explicit publication uploads content-addressed artwork first, then complete metadata; interruption cannot publish an incomplete snapshot. Make the operation callable through an explicit PC control, not a new automatic polling loop.
- [x] Android/React (`android` native read allowlist/shared media cache, `app/mobile-client/Collections.tsx` and owning navigation): library/type/Showcase browsing, retained list state, cover-led detail and edition-aware volume appreciation; read-only controls only. Reuse PC presentation primitives where their runtime is compatible, otherwise match the existing material/geometry without importing Tauri/provider code.
- [x] Isolated server/PC fixtures, mobile navigation tests, TypeScript/build and browser layouts passed. Explicitly authorized deployment/publication and subsequent Galaxy Tab cover/volume viewing and user polish acceptance completed. Detailed historical checkpoints follow; their earlier pending gates are superseded by the final source-cover/device evidence.

Contract v1: GET `/v1/collections` accepts `type=game|manga|movie`, `q`, `showcase`, `limit<=48`, opaque `cursor`; replies `{ready,revision,publishedAt,items,nextCursor}`. GET `/v1/collections/{id}` replies `{revision,item}`. Public item uses the existing camelCase CollectionSummary display fields (without sourcePath), and detail adds camelCase volumes plus artwork descriptors `{id,kind,selected,thumbnailAvailable,originalAvailable}`. POST `/v1/collections/{id}/artworks/{artworkId}/media-ticket` takes `{variant:thumbnail|original}` and returns the existing Ticket shape. PC-only POST `/v1/collections/artworks/prepare` takes `{sha256,sizeBytes,contentType}`, returns `{objectKey,uploadUrl,requiredHeaders}` (null URL on an existing exact object). PC-only PUT `/v1/collections/replica` takes `{version:1,baseRevision:null|string,collections:[...]}`; private artwork variants are `{sha256,sizeBytes,contentType,objectKey}` under `work-artwork/mobile/<sha256>`. Server validates referenced objects before atomic publication and rejects stale baseRevision. No Android access to prepare/publish routes.

Verification checkpoint: 81 server tests (including 12 Collection cases), PC publisher
fixtures, PC TypeScript, 45 mobile tests, mobile TypeScript/Vite and Android build
passed. Native policy/cache/transfer and packaged asset/signature checks passed.
Browser fixtures covered type/list/detail/volume navigation at tablet and phone widths.
Final integration review was inline, not independent.

Deployment/publication was explicitly approved and completed. The first snapshot's
cover omissions were repaired in the later source-cover publication below; do not
repeat the first publication or treat its earlier device-pending note as current.
The 2026-09-07 APK 0.3.3 checkpoint retains the PC icon and user-accepted plain-cover/volume polish.
Source-cover repair completed (2026-09-07): publication revision `3b640e2627ad526d7b3a8764bca87adc6cc4f04796a9373881d5c3910a196898`; 340 works, 2,803 artwork records, 5,588 unique blobs (4,204 uploaded in this repair), 2,332 volume/edition covers. Full comparison with the preceding replica confirmed 261 recovered primary covers, all 79 existing selected covers retained, and every existing volume ID/number/edition/label/release field retained. Every current work and volume has a thumbnail reference. Type pagination had 181 game, 147 manga and 12 movie records with no duplicate IDs; representative original and thumbnail downloads passed SHA-256 checks. Service active/running, NRestarts=0. Galaxy Tab SM-X730 running installed APK 0.3.1 was woken and refreshed: the game grid loaded covers and a previously missing manga (Prison School) displayed its primary cover and ordered 28-volume shelf. No APK rebuild/install was needed. The operation opened the source DB READ_ONLY and wrote previews only to TEMP. Prior replica backup: `/home/linuxuser/lakomics-api/backups/collections-before-source-20260907T053812Z.json`. An interrupted preparation attempt left its TEMP preview directory; manual cleanup was blocked by automatic approval policy, and no workaround deletion was attempted. The successful attempt retained normal TempDir lifecycle cleanup.

## MOBILE-006 — Shared Manga Catalog browsing

Status: `PARTIAL`; shared catalog browsing and the v2 performance/Reader server slice are
deployed. The current publication was upgraded in place to the v2 projection with unchanged
revision; production default search is now prepared server-side and the authenticated Reader
returns ordered validated page manifests. Android 0.4.3 uses a fullscreen one-page reader with
horizontal page navigation, screen-fit rendering, 1x–5x pinch zoom and bounded drag while
retaining device-local position, ±2 page prefetch, one-shot expired-manifest refresh and shared
native cover/page caching. Reader chrome appears only on a short tap. Selecting bookmark scope
forces Latest sort. Server evidence includes 16 Python catalog/replica tests, production-scale
timing and a real k-hentai/siam-cdn Reader canary. `PARTIAL` remains only for APK 0.4.3 Galaxy
Tab install and native reader/cold-warm acceptance.

User scope: PC-style catalog design with minimal editing. Search preserves provider/work
identity, language scope, blocked tags/categories and confirmed edition groups. The legacy
upstream proxy is not the shared search contract. Reader is read-only; offline full-gallery
download and cross-device reading progress remain deferred.

## MOBILE-007 — Catalog bookmark changes across devices

Status: `TODO`; follows the catalog read contract. Add/remove bookmarks from Android with stable `(provider, providerWorkId)` identity, idempotent operation IDs, durable retry and an explicit conflict rule. Preserve PC local authority from ADR-0033; define remote change receipt/PC application acknowledgements before enabling writes. Do not implement toggles that can invert twice after retries, or let a stale PC snapshot erase accepted mobile changes. Test offline/reconnect, duplicate requests, deletion tombstones and concurrent PC/mobile changes.

## MOBILE-008 — Catalog update requests and status

Status: `TODO`. Android can request a catalog DB refresh and see queued/running/completed/failed state, last successful update and errors while continuing to read the prior index. Bound and deduplicate jobs; persist crash/retry state. Resolve the relationship between the existing PC updater and server-side update worker before deployment, keeping the same catalog identity/grouping rules. The proposed target is server-side refresh available with PC off; if this needs a materially different authority/runtime arrangement, discuss that decision with the user. User data/bookmarks must survive catalog replacement. Operating a worker, deploying services and first production ingestion require explicit approval after implementation and isolated tests.

## MOBILE-003 — Safe global deletion / tombstone protocol

Status: `HOLD`
Risk: HIGH.
Prerequisite: native client plus explicit conflict/acknowledgement design; preferably after MOBILE-004/MOBILE-002 are stable read-only consumers.

Never propagate immediate deletion by default across PC, server, R2, mobile cache, and potentially offline clients.

Required concepts before implementation:

- tombstone;
- grace period;
- client acknowledgement/reconciliation;
- explicit purge;
- conflict/recovery behavior.

---

# Extension follow-up — 2026-09-07

## EXT-005 — Deep list navigation and folder ordering

Status: `DONE`

Window/list mode traverses the actual hierarchy beyond levels 2/3/4/5, with deeper
surfaces becoming darker. The save-check pop animation is removed. Settings embeds
the real list and supports hold/drag ordering within siblings, automatic persistence,
rollback on failure and keyboard ordering. Model/DOM/worker tests and browser checks
passed. Actual Galaxy Tab long-press reorder ergonomics remain a follow-up observation;
do not confuse the verified temporary-save long press with a full reorder device test.

## EXT-006 — Device-only temporary image saving

Status: `DONE` — core save and local album path verified; recipient compatibility is
tracked by MOBILE-002 rather than closed by this status.

The separate green root-list action opens APK 0.3.3, downloads directly and publishes
to `Pictures/Lakomics/임시보관/` without server upload. Real Titanium handoff, complete
MediaStore write and a test recipient's 30,320-byte read passed. Samsung Gallery's
all-albums view shows the folder; it need not appear among selected major albums.
The current implementation intentionally opens a save-progress Activity. Removing
that transition was discussed as a UX improvement, not implemented or committed.

## EXT-007 — Arca JPEG download URL optimization

Status: `DONE` — user confirmed extension 15.59 activation and improved speed.

Only `https://arca.live/` pages use the bounded JPEG optimization for both temporary
and permanent saves. Known positive width <=1280 keeps the selected JPEG URL without
forcing orig; explicit original requests, unknown/large widths and other formats
retain their prior handling. ArcaRefresher attribution/MIT notice is included.
34 focused URL/controller tests passed. User-observed improvement is not a numerical
throughput benchmark or proof of byte/quality equivalence for every source image.

## EXT-008 — First-open double activation

Status: `VERIFY` for the new list-only extension — the local `idle -> armed -> opening -> list-open` controller has focused coverage proving a first gesture cannot open twice and release during asynchronous opening does not cancel/retrigger it. Chromium/Titanium/Galaxy touch acceptance is still pending; the preserved legacy `extension/` is not modified by this fix.

Legacy user report: the first extension-window invocation could double-handle a touch/tap. The new list-only client replaces the radial/touch-held path with a one-open-per-pointer state machine; keep device acceptance focused on first invocation, release/click-through, cancellation and immediate reopen.

## EXT-009 — GIF saving failure

Status: `VERIFY` for the new list-only extension — GIF has an explicit `animated_gif` server/PC capture identity, URL/filename detection, server-only permanent-save semantics and Android temporary-intent eligibility. A Rust end-to-end fixture verified a real two-frame GIF reaches the Lakomics library as `MediaSummary::Gif` with byte-for-byte original content. Existing Android temporary storage already accepts `image/gif` and copies the original file; real Titanium/Galaxy permanent and temporary GIF acceptance remains pending. The preserved legacy `extension/` remains unchanged.

## EXT-010 — List-only slim extension and server-owned profile sync

Status: `IN PROGRESS` — 2026-09-09 local implementation now includes the separate `extension-list/` package, server-issued scoped pairing/profile sync, a local QR pairing surface plus scan-to-pair bridge for PC → Galaxy Tab setup, list-native ordering/pins, minimal invocation state machine, server-first capture, and explicit GIF transport into the PC library. Focused extension tests, TypeScript and Rust GIF ingestion tests pass locally. The server portion is deployed to `laku-tokyo`: production `app.py` SHA-256 `4428342f29fc2ea978f06fb903202f076a6b0dc12f8578f2bcefcff5e6f966dc`, `capture_store.py` SHA-256 `d465e14f3d5fefe637defa48f05ff26184ed5b33be812f647d1c7ffce66a31a3`; pre-deploy code plus a 12,804,096-byte SQLite online backup are retained under `backups/extension-list-20260909-1615/` with `quick_check=ok`. Post-restart service is active with `NRestarts=0`, raw and Tailscale HTTPS health return 200, 489/489 existing captures were preserved, GIF/profile schemas are active, and an HTTPS pairing -> bootstrap -> revoke canary passed without exposing credentials. The VPS candidate's full `tests.test_capture_api` suite passed 49 tests in the production venv. Chromium/Titanium/Galaxy device acceptance remains a separate gate, and the existing `extension/` remains unchanged.

### Product goal

Create a **separate list-only collector extension** while leaving the current `extension/` implementation intact as the working reference/fallback. The new extension is not a radial mode with the donut hidden: it is a clean client whose normal job is only to detect media, open the classification list, submit a save, and reflect Lakomics-owned state.

The normal setup experience is one step:

`Lakomics -> Copy extension pairing link -> paste once in the new extension -> connected`

After pairing, classifications, pinned destinations, list ordering and portable collector preferences converge automatically through the Lakomics server. There is no normal UI for separate PC connection keys, localhost/Tailscale selection, Cloud Collector setup, manual portable-backup push/restore, donut layout, secondary-ring visibility, or local fallback-tree editing.

### Non-goals and preservation rules

- Do not modify, slim, or migrate the existing `extension/` in place. Build the new implementation under a separate directory, working name `extension-list/`.
- Do not delete the old extension, its current manifest identity, its portable backup, or its existing direct-PC path during this work.
- Do not introduce a new frontend framework, build system, ANN/vector service, or general account system merely for this extension.
- Preserve current site/source support where it remains useful: X, ordinary HTTPS pages, Arca, DCInside, image/video detection, X metadata, saved-state marking, optional X auto-like, temporary Android image save, and X translation.
- Do not carry radial-only behavior forward for compatibility. Radial layout, gesture hit-testing, dwell, rings, slot pages, hidden-secondary presentation and local donut trees are intentionally retired from the new extension.
- The new extension and the old collector must not both be enabled for real interaction acceptance in the same browser profile because both can intercept the same media gesture. They may coexist as installed packages, but one collector is enabled at a time during acceptance.

### Source-of-truth model

The Lakomics server owns portable extension state. The new extension owns only credentials, device/browser capabilities, ephemeral caches, pending offline mutations and other device-specific state.

Server-owned state:

- canonical Lakomics classification snapshot and classification revision;
- pinned/favorite classification destinations and their order;
- per-parent list/sibling ordering;
- portable collector preferences such as X auto-like and X Translate enabled state;
- profile schema version, profile revision and update timestamp;
- optional future portable list presentation fields only when they are real user preferences.

Device-local state:

- scoped extension bearer token and paired server origin;
- browser permission state and feature capability detection;
- Android temporary-save intent/capability and other genuinely device-local browser capabilities;
- translation provider secrets/API keys; portable non-secret translation preferences may sync;
- validated cached profile/classification snapshots;
- bounded offline profile-patch outbox and transient diagnostics.

Do not store bearer tokens, pairing secrets or external provider API keys inside the server profile document.

### Pairing and authentication contract

Normal setup uses **one pairing URL/string**, not separate server/token fields. Lakomics creates a short-lived single-use pairing secret on the server and presents a fragment-bearing HTTPS pairing URL. Desktop renders that URL as a local QR as well as a copyable link; the Android/Titanium bridge can scan/open it and exchange the secret without a second connection setting.

Target flow:

1. Lakomics desktop, authenticated with the existing server/admin credential, requests a pairing secret.
2. Server stores only a bounded/hashed pairing record with a short expiry and single-use state.
3. User pastes the one pairing URL into the new extension.
4. Extension exchanges the secret for a **scoped extension client token** and bootstrap metadata.
5. Extension stores the resulting server origin + client token locally and discards the pairing secret.
6. The client token grants only the extension capabilities required by this plan: extension bootstrap/profile read-write, classification read, capture creation/status needed by save confirmation, and saved-media state read. It is not the server administration token.
7. Revocation is per extension client without rotating the server's desktop/admin credential.

For development/migration only, a hidden/manual base-URL + token path may exist if required. It is not the normal product UI or acceptance path.

Production pairing/server origins should be HTTPS. Localhost exceptions are development-only and must not silently broaden production origin validation.

### Versioned server profile API

Add a small server-owned extension profile rather than reusing the current encrypted `extension-backup` blob as the live state. The existing backup endpoint remains migration/recovery material only.

Preferred contract:

- `GET /v1/extension/bootstrap` — authenticated capability/bootstrap response containing API/profile/classification revisions and the current profile/classification payloads when practical.
- `GET /v1/extension/profile` — current profile plus revision/ETag.
- `PATCH /v1/extension/profile` — partial user mutation with expected revision/If-Match semantics.
- Existing or revised `GET /v1/classifications` — canonical classification snapshot with a stable revision/ETag.
- Capture/saved-state endpoints required by the unified save path below.

Profile v1 semantics should be small and explicit, for example:

```json
{
  "schemaVersion": 1,
  "revision": 12,
  "pinnedClassificationIds": ["..."],
  "listOrder": {
    "__root__": ["..."],
    "<parent-id>": ["..."]
  },
  "preferences": {
    "autoLikeOnSave": true,
    "xTranslateEnabled": true
  }
}
```

Do not copy current radial layout, secondary usage buckets, hidden secondary IDs, local radial tree, touch-persistent state, or menu-mode selection into profile v1.

### Profile synchronization and conflict contract

The list should be usable immediately from the last validated cache, then revalidate against the server without blocking the first-open UI on a network round trip.

- On service-worker startup and after pairing, load bootstrap/profile/classifications.
- On list open, render the validated local snapshot immediately and trigger a bounded freshness check if needed.
- Use revision/ETag conditional reads so unchanged profile/classification state is cheap.
- User edits are sent as **partial patches**, not whole-profile replacement. Reordering one folder patches only that parent order; pin edits patch only pinned state.
- On revision conflict, refetch the latest profile, replay the user's still-valid local field patch onto it, and retry once. A second conflict is surfaced rather than looping indefinitely.
- Offline profile edits enter a bounded local outbox, coalesced by logical field/key. They retry on startup/connectivity/future interaction and are removed only after server acknowledgement.
- Removed classification IDs are ignored when rendering stored order/pins. Newly added siblings appear after explicitly ordered siblings. Do not silently remap IDs by name in the steady-state protocol; any old-extension migration remapping is a one-time migration concern.
- A profile update received from another paired device becomes visible on the next bounded refresh without a manual push/restore action.

### Classification/list model — no radial dependency

Create a list-native classification model. `list-collector.js` must no longer call `LakomicsRadial`, consume radial pages, or treat radial placement as sibling ordering.

Required list behavior:

- canonical parent/child relationships come directly from the server classification entries;
- arbitrary depth remains supported;
- root view presents ordered pinned shortcuts first, followed by canonical root classifications;
- a pinned item is a shortcut, not a move: opening it follows its real canonical children/breadcrumb and saving to it uses its real classification ID;
- per-parent `listOrder` controls visible sibling ordering only;
- removed IDs disappear safely; new siblings append after ordered live IDs;
- folder click enters the folder; leaf click selects; right-swipe saves with a resisted commit gesture, left-swipe goes back, and current-folder save plus keyboard accessibility remain available;
- ordering editor operates on the same list-native model and automatically PATCHes the server profile.

The fixed `임시 저장` action remains an action, never a classification and never part of ordering/profile data.

### Minimal invocation/input state machine

Preserve the familiar invocation semantics initially — mouse drag threshold and touch long-press — but reimplement them only as a **list-open trigger**, not a radial gesture session.

Target state machine:

`idle -> armed(pointer) -> opening -> list-open -> closed`

- A pointer can transition to `opening` at most once.
- While `opening` or `list-open`, subsequent pointer/click events from the opening gesture cannot open or activate the list again.
- Release after the list opens does not select/save anything by itself.
- A single one-shot click/context suppression guard may protect the underlying page after an opening gesture; radial dwell, radial hit-test, touch-held selection, SVG coordinate transforms and click-shield layers are not carried over.
- Loading classifications/profile is coalesced so simultaneous first-open events share one promise rather than mounting twice.

This state machine is the primary redesign surface for EXT-008 (first-open double activation). Reproduce the old failure first, then add a focused regression for one mount/one activation from the first gesture.

### Unified permanent-save route

The new extension's normal permanent-save transport is the **paired Lakomics server**. Remove the user-facing PC/Cloud/Remote routing matrix from the new client.

Target flow:

`media candidate -> classification ID -> authenticated server capture -> server stores/fetches safely -> PC Cloud Capture consumer imports when available`

- X, Arca, DCInside and generic public HTTPS image/video captures should converge through one versioned server capture contract.
- Extend/generalize the current server capture API rather than reintroducing direct-PC routing inside the new extension.
- Known sources keep source-specific host validation where useful. Generic web capture must reuse equivalent public-URL/SSRF protections: HTTPS, no credentials, public address validation/revalidation, bounded redirects, bounded bytes/time, and no browser-cookie forwarding.
- Audio/files, login-protected URLs, blob/HLS/DASH and other unsupported media fail explicitly in the slim client rather than silently invoking Android/browser downloads.
- Default save policy for the slim client is server-only for supported permanent media. Timeout/transport ambiguity uses bounded server confirmation; a failed server save is reported as failure and does not fall back to `chrome.downloads`.
- Server timeout/failure confirmation must remain bounded so an ambiguous response is resolved without submitting or reporting a duplicate capture.
- Temporary Android save remains intentionally device-local and bypasses the permanent server capture path.

### GIF contract / EXT-009

GIF support is a release gate for the new client, not an optional follow-up.

- Reproduce current GIF failure for permanent save and Android temporary save separately.
- Preserve animated GIF bytes/animation semantics. Do not flatten GIF to PNG/WebP or silently label it as ordinary video merely to pass transport validation.
- The server capture contract must represent GIF/animated image identity explicitly enough for the PC importer to restore the correct Lakomics media kind/content type.
- Source detection must not misclassify an animated GIF as a static image when the original URL/content type proves GIF.
- Permanent GIF saves stay on the server capture path; Android temporary save must preserve the original GIF extension/content semantics.
- Android temporary save should publish a valid animated GIF to MediaStore when the source is a public supported GIF, or return an explicit unsupported result if the native receiver cannot yet preserve it; silent static conversion is not acceptable.

### Saved-state and X behavior

Retain useful X-only behavior without pulling old architecture back in:

- X saved-media badges/index should read a server-backed authoritative state or revisioned snapshot plus a short-lived local recent-save overlay.
- Successful permanent capture should mark the relevant X media locally immediately, then converge with server/PC saved state.
- X auto-like remains optional and profile-controlled; it runs only after a successful relevant save and must never like the wrong outer/quoted post.
- X Translate remains a standalone optional content feature. Sync only non-secret enable/model preferences that are truly portable; provider credentials remain device-local.

### New extension source shape

Target a smaller, explicit module graph under `extension-list/`. Exact filenames may adjust during implementation, but the dependency direction should resemble:

```text
extension-list/
  manifest.json
  src/
    background.js              # message router only
    api-client.js              # paired server auth/request/ETag
    profile-store.js           # cache, outbox, merge/retry
    classification-tree.js     # canonical tree + pins/order
    save-client.js             # server capture + bounded confirmation
    content.js                 # minimal invocation controller
    list-collector.js          # list UI only
    x-source.js / x-gallery.js
    forum-source.js
    x-translate.js
    defaults.js                # genuinely device-local defaults only
  options/
    options.html/css/js        # pairing, status, minimal device prefs
  tests/
```

Do not copy `gesture.js`, radial `layout.js`, donut SVG rendering, radial options editor, secondary presentation logic or local donut tree into the new implementation.

The old generated MV3 worker remains untouched. Give the new extension its own deterministic bundle/generation entry if Titanium/Chromium compatibility still requires the tracked worker-bundle pattern. Do not hand-edit generated workers.

Audit the current mobile bridge/library prototype files before copying them. Default to excluding functionality already owned by the native Android app unless the new collector directly needs it.

### Extension identity and side-by-side safety

The new extension uses a distinct manifest name/identity/storage namespace so the old package remains installable as fallback. Do not reuse the old direct-PC authorization assumption (`nclkmjmmlcdaeomgadndeangccfidfbk`) as the new extension's security boundary; server-issued scoped credentials replace it for the new path.

During development, do not treat simultaneous activation of both collectors on the same page as supported. Browser acceptance enables one collector at a time. A later explicit coexistence feature would require a separate arbitration design.

### Legacy-state migration

Migration is subordinate to the clean architecture.

- Do not let the new runtime depend on legacy radial/local-tree/portable-backup formats.
- If the existing server-side `extension-backup` can be safely decoded client-side using already available legacy credentials, offer a **one-time optional import** of portable values that map cleanly to profile v1: `listOrder`, pinned IDs, auto-like and translate-enabled state.
- Ignore radial placement, hidden-secondary state, usage buckets and local donut tree during migration.
- If safe automatic import is not possible, keep the old extension unchanged and allow the user to establish pins/order once in the new profile. Do not broaden credential exposure to make migration automatic.

### Offline and failure behavior

- Pairing requires a reachable server and succeeds atomically or leaves no half-configured credential state.
- Once paired, cached classifications/profile may open offline with a visible stale/offline indication only when useful; normal browsing should not block on network timeouts.
- Offline profile edits are queued/coalesced locally and later reconciled; they do not disappear on service-worker suspension.
- Permanent server save failure is explicit. Bounded confirmation distinguishes a lost response from a real failure; the slim client does not start an Android/browser download as a substitute.
- Corrupt/invalid cached profile/classification data is discarded and refetched, never trusted as authoritative state.
- Pair/client revocation produces a clear “pair again” state without deleting unrelated browser downloads or old-extension data.

### Security contract

- Extension client tokens are scoped, revocable and stored only in extension-local credential storage.
- Pairing secrets are single-use and short-lived; logs/errors never include the secret or bearer token.
- Server profile payloads contain no credentials.
- Server capture keeps strict SSRF/public-host protections and bounded downloads; generic HTTPS support is not permission to create an open proxy.
- Page content never receives server credentials. List UI remains isolated from tokens; service-worker/background code owns authenticated requests.
- Browser translation provider keys remain local and are not synchronized through Lakomics profile APIs.

### Implementation phases and gates

#### Phase A — Freeze baseline and create the clean sibling package

- Record current `extension/` manifest/version and focused tests as reference evidence.
- Create `extension-list/` with a distinct manifest identity; copy only still-required source detectors/behaviors.
- Establish list-native model tests before porting settings or server sync.
- Gate: old `extension/` source has no functional diff from this phase; new package loads independently with no radial modules.

#### Phase B — Server pairing, scoped auth and profile/classification bootstrap

- Add server pairing/client-token storage and bootstrap/profile revision contracts.
- Add extension API client, local validated cache and profile patch outbox.
- Gate: a fresh browser profile pastes one pairing link and receives classifications + profile without any second connection setting; revoke/re-pair and offline-cache behavior are covered.

#### Phase C — List-native collector and synchronized pins/order

- Remove every `LakomicsRadial` dependency from the new list model.
- Implement root pinned shortcuts, canonical deep navigation and per-parent ordering.
- Auto-PATCH pin/order edits to the server; conflict retry uses the field-level patch contract.
- Gate: two paired extension instances converge on pin/order changes without manual backup push/restore; deep folders and newly added/removed classifications remain correct.

#### Phase D — Minimal invocation controller / EXT-008

- Port media candidate detection to the new content controller.
- Implement the one-open-per-pointer state machine and focused first-open double-activation regression.
- Gate: first touch/mouse invocation mounts exactly one list and release/click-through cannot cause a second activation or accidental save.

#### Phase E — Unified server capture, GIF fix and saved-state convergence

- Generalize the server capture route for supported sources/media while preserving validation bounds.
- Implement server-only slim save client for supported permanent media with bounded confirmation and explicit failure.
- Fix GIF semantics end to end and refresh saved-media/X markers.
- Gate: X/static image, public GIF, video, Arca image, DCInside supported media and generic public HTTPS image each take the intended route; unsupported/private cases fail explicitly without browser download; GIF remains animated.

#### Phase F — Options/settings diet and feature audit

- Replace the 900-line current-style options surface with pairing status, disconnect/re-pair, server/profile sync status, and only genuinely device-local controls that still need user choice.
- Keep X Translate credentials/settings only to the extent the retained translate feature requires them.
- Audit mobile bridge/prototype/patch/release-note carry-over before inclusion; do not copy dead files for familiarity.
- Gate: a new user can configure the extension without understanding PC vs Cloud vs Tailscale vs backup vs radial concepts.

#### Phase G — Cross-device/native acceptance and cutover readiness

- Chromium desktop and Titanium Android: pair, open list, deep navigation, pin/order sync, save, restart/reopen, offline cache/recovery.
- Galaxy Tab: first-open touch regression, temporary image/GIF behavior, list reorder ergonomics.
- Windows/Linux Lakomics: server-published classifications and Cloud Capture import remain compatible; no direct-PC requirement exists for the new extension.
- Only after these gates may the user decide whether the new package replaces the old installed collector. Do not delete the old implementation as part of acceptance.

### Acceptance scenarios

1. **Fresh install:** only one pairing link is entered; no other endpoint/token/layout setup is required.
2. **Second device:** pairing immediately reproduces the same classification tree, pins and sibling order.
3. **Cross-device edit:** pin/reorder on device A appears on device B after bounded refresh; concurrent revision conflict does not lose an unrelated field edit.
4. **Offline open:** previously validated list opens without waiting through a dead-server timeout; stale state is not misrepresented as a fresh server read.
5. **Deep hierarchy:** 5+ levels navigate using canonical parent IDs with correct breadcrumb/back behavior.
6. **First-open input:** exactly one list mounts from the first gesture; release/tap does not double-open or auto-select.
7. **Permanent save:** supported media uses one server route and the classification ID remains intact through later PC import.
8. **GIF:** permanent and temporary GIF behavior is explicitly verified; animation is preserved where supported and never silently flattened.
9. **Server capture failure:** bounded confirmation prevents duplicate capture; a real failure stays a server failure and never produces a browser/Android download or a false “Lakomics saved” result.
10. **Profile persistence:** browser/service-worker restart does not lose acknowledged pin/order state or pending offline profile edits.
11. **Revocation:** a revoked extension client cannot read/write profile or create captures and is prompted to pair again.
12. **Old extension preservation:** existing `extension/` remains buildable/usable as the reference fallback and is not silently migrated or overwritten.

### Verification discipline

Start with focused module tests rather than repeatedly running the entire extension suite. New coverage should emphasize contracts the old radial tests cannot prove:

- pairing parser/exchange and credential non-leakage;
- profile revision conflict/rebase and offline outbox persistence;
- list-native canonical tree ordering/pins without `LakomicsRadial`;
- one-open-per-pointer controller behavior;
- server capture source/media validation, timeout confirmation and GIF handling;
- options fresh-install flow requiring only one pairing input;
- package/bundle parity for the new manifest worker.

Browser/device acceptance is required for pointer/touch behavior and Android intent handling; Node/jsdom tests are not substitutes for Titanium/Galaxy native behavior. Server endpoint tests use isolated test DB/storage and do not deploy or mutate production captures without separate approval.

### Exit criteria before implementation is called complete

The work is complete only when the new package can be installed on a clean browser profile, paired with one Lakomics-generated link, and used without radial/local-tree/PC-remote/backup configuration; portable list state syncs automatically; normal saves use the unified server route; EXT-008 and EXT-009 have reproductions plus passing fixes; and the old extension remains untouched and available as fallback.

---

# Works / Collection presentation lane

Current PC visual baseline: `docs/agents/pc-design-reference.md`.
Stable type-specific Works intent: `docs/agents/works-viewer-design.md`.

The central principle is a shared Lakomics shell with type-specific viewing grammar:

- Manga = volume-centered personal shelf;
- Game = hero/package-centered work exhibit;
- Video = poster-centered archive; series expand into seasons/episodes;
- Showcase = a higher-appreciation view using the same primitives, not a separate renderer.

Artwork > work identity > personal state > useful provider metadata > provider/maintenance controls.

## LONG-002A — Type-aware presentation foundation and normal Works visual pass

Parent item: legacy `LONG-002`
Status: `DONE` — user accepted the Collection finishing checks on 2026-09-06.
Legacy LONG-002 remains `PARTIAL` only for the separate later focused-cover/Display
scope. Normal type-specific presentation and its user visual acceptance are complete.

2026-09-05 first reskin slice: Quiet Archive typography/fallback and Works depth tokens,
flat Collection captions, Manga cover baselines/shared support lines and below-cover release
captions, conditional edition controls, and Game hero/package calibration are implemented.
Existing CollectionOverlay/CollectionCard/GameCollectionDetail tests: 51 passed; TypeScript
check passed. Isolated browser fixtures covered mixed cover ratios, 20 volumes, multiple/single
editions, long Korean/Japanese titles, keyboard focus, and sparse Game art at 960/800px widths.
Native Tauri visual acceptance for that first slice was unverified; no active production
library was opened or mutated for that check. The later implementation below supersedes
its pending Game composition and type-specific tile wording.

Implemented follow-up (2026-09-06, `9a99ed5`):

- Game case dimensions follow the cover aspect ratio with bounded scaling, preserving
  the full image without exposed empty case areas; Manga shelf content wraps within
  the available width; Film posters use a transparent surround.
- Artwork candidates and galleries preserve portrait images. Only the candidate image
  row scrolls horizontally; selection/navigation actions stay in the dialog width.
- IGDB hero choices include both artworks and screenshots, with smaller candidate
  thumbnails; TMDB candidate thumbnails are also smaller. Live provider latency is
  not guaranteed by these changes.
- Collection cover/artwork viewers consume Back before leaving the work detail.
- Work information, editions, ownership, release status and management controls use
  the existing sidebar. Detail views omit the redundant work-type navigation; the
  library retains it. The notification button shares the search/add centerline.
- Game/Manga/Film cards show release dates below creator/company, formatted `YY.M.D`
  with a full-year fallback. Film metadata selects the earliest available TMDB release
  date; this does not imply every previously saved work has been refreshed.
- Existing `CollectionCard`, physical cover and artwork gallery components provide
  the type-specific presentation; do not add a second renderer just to introduce the
  planned `WorkTile`/`ArtworkStrip` names.

Verification: focused frontend/Rust checks and TypeScript passed during implementation.
The latest spacing-only adjustment was not agent browser-tested. The user accepted
clipping, portrait artwork, sidebar density and Back behavior on 2026-09-06;
this is user acceptance, not a new automated/native test run. Film/Series expansion remains WORKS-001, and
complete-cover interaction remains LONG-002B.

Shared presentation primitives should remain lightweight and type-aware:

- type-aware `WorkTile`;
- thin book/package presentation primitive where reuse is real;
- `ArtworkStrip`;
- `RelatedWorksRail`;
- `MetadataLine`;
- a small `collectionType -> presentation preset` mapping.

Ordinary grids prefer DOM/CSS and bounded static rendering. The approved closed game case may keep the current bounded 2D projection/canvas path for edge quality; this is not permission to introduce Three.js/WebGL or continuous pointer tracking.

### LONG-002A.1 — Manga Shelf Grid quality baseline

Implemented baseline; use the retained criteria below for final visual acceptance.

Normal manga detail:

- replace independent `CollectionVolumeGrid` tiles with an open shelf presentation;
- shelf is only a horizontal support/contact cue, not simulated furniture;
- cover front remains roughly 90–95% of perceived object;
- minimal book/page-edge depth;
- shared baseline and subtle contact shadow;
- routine state moves below/around the cover rather than obscuring artwork;
- hide edition controls when only one edition exists;
- prefer meaningful edition names over numbered implementation drawers;
- clicking a volume prioritizes cover appreciation with ordered previous/next.

This manga shelf is part of the normal type-specific detail preset. It is **not** the later LONG-004 global Display/Shelf mode.

### LONG-002A.2 — Game Exhibit refinement

The hero/package composition and artwork improvements above are implemented. Use the
following criteria for final refinement, rather than restarting the visual pass:

- reduce excessive hero vertical dominance so lower content enters the viewport earlier;
- make hero, package, title, and identity one coherent composition;
- use compact sentence-like metadata instead of field-box rhythm;
- personal rating outranks provider state/external scores;
- `ArtworkStrip` adapts gracefully to 1, 2, 3, or many screenshots instead of leaving a dead lower half;
- move `작품 관리` toward quiet overflow chrome;
- richer IGDB data is added only when it becomes structural UI such as release history, franchise/related works, or useful artwork.

### LONG-002A.3 — Type-specific Collection library `WorkTile`

Preserve the current Chrome 03b contextual shell and its icon-first search/settings behavior; do not recreate the retired horizontal toolbar.

At a glance:

- Game reads as a shallow package collection;
- Manga reads as shallow books/shelf library;
- Video reads as a flat poster archive.

Reduce redundant body headings when the contextual index/current location already communicates Collection -> Library/Showcase -> type, allowing artwork to begin sooner.

Do not turn the normal library into a decorative showcase.

## WORKS-002 — Simple manga ownership and Korean release notifications

Status: `DONE` — user accepted the Collection finishing checks on 2026-09-06.

Implemented (2026-09-06, `9a99ed5`):

- One current-owned count per edition; saving N records ownership of volumes 1..N.
  Physical/digital choices are absent from the UI. Schema v41 retains compatible
  volume ownership storage; decreasing the count, including zero, is atomic.
- Show latest released volume, missing count and next scheduled volume/date.
  Upcoming volumes are excluded from missing count; unavailable dates stay unknown.
- Korean publication tracking uses the connected Kakao series and an enabled release
  subscription. App startup/hourly checks query works due after 24 hours; this is
  app-running polling, not an OS push notification service.
- New provider volumes (including scheduled ones), date changes and scheduled-to-released
  transitions create persistent events. Opening a work does not acknowledge them;
  explicit confirmation clears the selected events.
- A grid cover badge, total inbox count and in-app discovery message expose unread
  events. Badge numbers count events, not distinct new volumes or missing volumes.
- Ownership only changes the missing count; it does not suppress release events.

Verification already recorded: TypeScript, three focused frontend tests and four Rust
tracking tests passed. The authorized v40 -> v41 active-library migration passed
SQLite quick-check with existing collection, volume, bookmark and release-event rows
preserved. This is migration evidence, not proof of real future-provider detection.

The user accepted the remaining Collection finishing checks on 2026-09-06. No new
native/provider test was run to mark this status. No reseeding or production-data
mutation is authorized by this item.

Known boundaries: Kakao must publish the information; MangaDex-only connections cannot
detect Korean releases. Publisher changes may create a separate series and are deliberately
deferred by the user. Publisher-announcement crawling, OS notifications and off-app polling
are not implemented or implicitly approved follow-up scope.

## WORKS-001 — Video Works: film + series / TV animation

Status: `PARTIAL`

The Collection persistence type remains `movie`, while TMDB now supports both Film
and TV Series. Numeric movie bindings stay unchanged; TV uses `tv:ID`, so the same
numeric provider ID cannot collide across media types.

Film poster, artwork browsing, sidebar and earliest-release-date improvements shipped
in `9a99ed5`. The following 2026-09-06 TV extension is implemented in the working tree:

- Film/Series search selector with lightweight metadata/artwork preview;
- explicit apply/refresh caches all returned season/episode metadata and season posters
  in the existing binding/artwork lifecycle; no new TV schema or background polling;
- local season poster selector, selected-season summary, paged compact episode list
  (50 rows), air dates/runtimes/descriptions and aggregate cast;
- existing metadata overrides and chosen poster/backdrop survive refresh; existing
  movie imports remain compatible and cached series details reopen offline.

Verification: 20 focused TMDB Rust tests and 33 matched frontend tests passed;
TypeScript passed. Native API/import and user visual acceptance remain unverified.
Full explicit TV import/refresh still fetches season endpoints/posters sequentially;
preview and artwork replacement do not wait for the full episode sync.

Remaining broader scope: provider related-work rails and richer Film cast/release-history
presentation. Episode still grids are not part of the default compact presentation.

Structural distinction:

- Film: one work, poster/backdrop, runtime, release history, cast/staff, related works;
- Series: work -> seasons -> episodes, season posters, selected-season summary, compact episode list, aggregate cast/staff;
- animation vs live action is an attribute/filter/presentation nuance, not the main structural type split;
- TV anime therefore uses the Series structure, while anime films use Film.

Provider/API direction:

- extend TMDB integration to TV search/detail, seasons, episodes, season images, and appropriate credits/relations;
- preserve current provider ownership/refresh rules and local usability when the network fails;
- cache only data needed for normal browsing;
- external/provider score remains visually secondary to personal state.

Video visual grammar:

- shared backdrop + poster hero;
- Film content sequence: identity -> overview -> cast/staff -> artwork -> release history -> related works -> personal state;
- Series content sequence: identity -> season poster grid -> selected season/episodes -> cast/staff -> artwork -> related works -> personal state;
- default episode presentation is compact, not a giant still grid.

Data-model/type migration should be decided only when the concrete Film/Series contract requires it. Do not rename `movie` merely for cosmetic consistency.

Dependency: use LONG-002A primitives/presets for final presentation; provider/data work can be developed in a reviewable adjacent batch.

## LONG-001 — AV typed Collections, people relations, and full cover sets

Status: `PARTIAL` — the manual-first implementation slice is complete: local AV Collection
type, independent person identities with ordered performer/director relations, and manual
front/spine/back artwork selection are integrated. Backup/restore, ownership and full Rust
regression pass, and the bundled Tauri app builds/opens without the dev server. `PARTIAL` is
retained for native file-picker/subjective visual acceptance, production-library migration,
and the later external-provider portion of the broader LONG-001 scope. AV is
excluded before artwork collection from the current Mobile Collections replica;
it remains part of ordinary metadata recovery and is not an encrypted vault.

Extend the existing Collection work model rather than create a parallel work system.

Required foundation:

- AV Collection type;
- normalized people + Collection-person role/order relations;
- explicit front/spine/back artwork roles using the existing Collection-owned artwork lifecycle;
- front-only remains valid;
- full surfaces unlock richer focused presentation;
- provider import uses preview/apply and never silently overwrites manual intent;
- AV metadata is not coupled to acquisition/download or Private Vault.

Prerequisite for full-cover interaction: LONG-002A should establish the presentation contract first.

## LONG-002B — Focused complete-cover interaction

Status: `PARTIAL` — the focused interaction implementation is complete: front/spine/back
snap and original-image view use actual registered AV cover surfaces and the existing case
renderer. Keyboard, missing-surface and privacy behavior are covered by the green 893-test
frontend suite, and the bundled Tauri app starts successfully. `PARTIAL` is retained for
subjective native visual acceptance with real user cover media. Initial stops change immediately without free-angle rotation; missing
artwork is never synthesized. See [execution evidence](../research/av-covers-execution-plan-20260908.md).
Prerequisites: LONG-002A and truthful front/spine/back surfaces from LONG-001.

- activate side/back interaction only in focused/detail contexts;
- front remains default;
- snap to predictable front/side/back stops;
- keyboard and reduced-motion support;
- missing surfaces fall back to front-only/neutral thickness;
- never invent a fake illustrated spine from unrelated artwork.

## LONG-004 — Optional Display / Shelf mode

Status: `MERGE CANDIDATE`

This remains real product scope, but it must not own a separate rendering system.

Implement only after LONG-002A is stable, as an opt-in view consuming the same presets, artwork roles, filters, and Showcase membership/order.

Potential views remain:

- bookshelf;
- DVD/video shelf;
- game package display;
- showcase cabinet.

Rules:

- normal productive grid remains available/default unless the user chooses otherwise;
- front artwork stays recognizable; shelf realism never forces spine-only browsing;
- bounded/virtualized rendering for larger sets;
- only view-mode preference persists, not transient object rotation;
- no room, furniture, lamp, wall, window, or heavy material simulation.

## LONG-003 — Private Vault

Status: `HOLD`
Risk: CRITICAL/HIGH.

This is an encrypted private-media program, not an extension of normal Trash or AV metadata.

Do not put real user media into a Vault format until all of the following are independently resolved and tested:

1. threat model and leakage budget;
2. key lifecycle + user-held recovery path;
3. versioned authenticated-encryption/object format;
4. nonce/associated-data rules and known-answer/tamper tests;
5. wrong-key and corruption health behavior;
6. encrypted metadata/thumbnails and plaintext-cache rules;
7. interrupted copy/upload/atomic commit semantics;
8. independent security review.

Initial adoption is copy-in only; original normal media remains intact. Video authenticated chunks are a later phase after metadata/image recovery is proven.

---

# Reconciled legacy status index — audit baseline

The 2026-09-05 repository audit classified the original 55 backlog items as **38 DONE, 8 PARTIAL, 4 TODO, 3 MERGE CANDIDATE, 2 OBSOLETE**. The active items above replace stale verbose wording; this index preserves the audit result.

## DONE

2026-09-06 follow-up (outside the original 55-item audit counts): catalog bookmark
entry now starts in Latest instead of retaining a restrictive day ranking. The
reported disappearance was filter visibility, not deleted bookmarks; the recorded
read-only inspection found 253 bookmarks intact. Focused catalog tests passed.

- CLOUD-001 — Cloud Capture batch drain
- CLOUD-004 — X media Cloud/VPS routing failure fallback corrected
- CLOUD-002 — Cloud inbound app integration
- CLOUD-005 — PC-independent saved-X-media snapshot
- BUG-001 — Collection entry error toast
- BUG-002 — Manga list scan failure from unsupported thumbnail
- BUG-004 — Video preview preparation reliability
- BUG-005 — Historical manga Collection entry error no longer reproducible
- VERIFY-001 — X -> VPS -> PC E2E verification
- UI-004 — Transition/preview flashing
- UI-007 — Video viewer controls
- BUG-003 — X drag-save native selection highlight
- BUG-006 — Sidebar counts after drag/drop move
- BUG-007 — Same-scope mutation scroll preservation
- NAV-001 — Shared back navigation
- UX-009 — Loading/error/retry/tooltip consistency
- UI-006 — Easier asset selection clearing
- UI-005 — Collection cover aspect/crop handling
- UI-001 — Similarity Review placement
- BUG-008 — Catalog viewer page-edge focus highlight
- BUG-009 — Video preview/selection conflict
- BUG-010 — Impossible future catalog dates
- BUG-011 — Drag-out re-entry import overlay
- UI-010 — Richer video previews
- BUG-012 — Stable custom overlay gallery scrollbar
- CATALOG-001 — Fragile catalog transport moved behind Japanese VPS
- MANGA-001 — Orphaned local manga recovery foundation and targeted cleanup
- UI-009 — VCK-inspired manga reader parity
- CLOUD-007 — Replica work recovery after video poster preparation
- EXT-001 — Extension settings reorganization
- EXT-002 — **Cloud-first** extension save policy (`Cloud -> PC -> browser download` where supported)
- EXT-003 — Same-X-post media grouping
- EXT-004 — Adaptive/hidden secondary donut tags
- PERF-001 — Current cache/media optimization policy
- PERF-003 — Collection artwork fast path
- PERF-002 — Intended per-scope view-state preservation
- OPS-001 — Backup/migration/settings portability
- UI-008 — Top-bar rework

## PARTIAL / TODO / MERGE CANDIDATE

These are detailed in active sections above:

- CATALOG-002 — provider-key foundation DONE; optional Heliotrope remains `TODO`
- CLOUD-UI-001 — `VERIFY`
- NOTE-001 — NOTE-001A server `DONE`; NOTE-001B desktop `PARTIAL`
- STATS-001 — `PARTIAL` split inventory/activity
- IDEA-001 — `PARTIAL`; IDEA-001A `DONE`, IDEA-001B `TODO`
- LONG-001 — `PARTIAL` implementation complete; provider/native/product acceptance remains
- LONG-002 — LONG-002A `DONE`; LONG-002B `PARTIAL` only for native visual acceptance
- LONG-003 — `TODO` in audit, intentionally `HOLD` here until security gate is approved
- LONG-004 — `MERGE CANDIDATE` consuming LONG-002 renderer

Later completions superseding the audit: CLOUD-006, BUG-013, CATALOG-003/004/005/006,
CATALOG-007A/B, LONG-002A, WORKS-002, MOBILE-005 and EXT-005/006/007 are DONE.
MOBILE-001/002/004 remain PARTIAL for the specific remaining work in their sections.
MOBILE-006 has its read implementation complete and remains PARTIAL for rollout/device acceptance;
MOBILE-007/008 are the next catalog implementation sequence.

## OBSOLETE / incident-only

### UI-003 — Replace Asset Repository scrollbar with a native/standard scrollbar

Status: `OBSOLETE`

Superseded by the later runtime-verified BUG-012 solution: the accepted implementation is the custom overlay scrollbar with native scroll ownership and stable reserved range. Do not reintroduce the older native-only request.

### CLOUD-003 — Long-video asynchronous Capture handling

Status: `OBSOLETE`

No validated incident currently requires an async redesign. Keep the current bounded synchronous path and ambiguous-timeout confirmation behavior. Reopen only if a reproducible long-video timeout race produces real failures.

---

# Newly promoted scope from the reconciliation

The audit was read-only, so it recorded several candidates without mutating this backlog. This reconciliation promotes only independent, evidence-backed scope:

- BUG-013 — real Asset viewer open recording;
- MOBILE-001 — native authenticated Android shell;
- MOBILE-002 — read-only DocumentsProvider;
- MOBILE-003 — global deletion/tombstone protocol, held until safe;
- MOBILE-004 — approved Mobile consumption UX;
- WORKS-001 — Video Works Film/Series + TV animation expansion.

2026-09-07 user-promoted similarity follow-up:

- SIMILARITY-002A — EXIF orientation normalization before PDQ;
- SIMILARITY-002B — mirror/flip/rotation-aware PDQ candidate search;
- SIMILARITY-003 — similar-video fingerprinting on the existing FFmpeg foundation;
- PERF-SIMILARITY — BK-tree/metric-index optimization held behind measured scale/latency gates.

Candidates intentionally absorbed rather than added as standalone backlog:

- `CLOUD-008` -> CLOUD-006 pause closure;
- `PERF-004` -> CATALOG-004 query/hydration batch;
- `DOC-001` -> completed by this 2026-09-05 truth-alignment rewrite.

---

# Dependency-safe master execution roadmap

2026-09-09: REVIEW-20260909 records implemented remediation and its remaining acceptance gates. The current-work summary at the top includes the subsequent character requests. The product dependency map below remains applicable to its existing feature lanes and must not reschedule completed prerequisites.

This is a dependency map, not a list of unfinished tasks: consult each active item status above and skip completed work. Historical audit-index statuses do not supersede later completion evidence.

This is the authoritative dependency order, not a prohibition on parallel work in independent subsystems. In particular, Collection presentation and pure Mobile layout/state work may proceed in parallel once worktree ownership is clear.

Completed prerequisites: CLOUD-006, BUG-013, CATALOG-002A/003/004/005/006/007A/007B,
LONG-002A and WORKS-002. Do not schedule them again.

Remaining work, grouped by dependency rather than one mandatory serial queue:

1. **CLOUD-UI-001 and STATS-001A/B — native acceptance** of already implemented UI.
2. **IDEA-001B — Revisit theme expansion.** IDEA-001A scoring/cooldown/feedback is DONE.
3. **NOTE-001B — finish desktop Notes acceptance and documented remaining work.** NOTE-001A revision-safe server is DONE; do not reimplement it.
4. **CATALOG-002B — optional Heliotrope coexistence.** Not a prerequisite for the
   existing-provider Mobile catalog lane.
5. **WORKS-001 — remaining related-work/richer Film presentation.** TV/season/episode
   structure already exists; do not restart that foundation.
6. **LONG-001 / LONG-002B acceptance → LONG-004 — AV relations/cover roles and focused
   full-cover interaction are implemented; finish real-media/native acceptance before optional
   Display mode using the same renderer.**
7. **LONG-003 — HOLD:** threat model/format/recovery approval before encrypted
   metadata/images, recovery/key rotation and later video chunks.

## Separately promoted Similarity order

S1. **SIMILARITY-002A EXIF orientation normalization — DONE**
- schema 47 safely reindexes orientation-capable stored hashes; current PDQ and review thresholds are preserved.

S2. **SIMILARITY-002B geometric-invariance candidates**
- after S1; validate false positives on real artwork before enabling broadly.

S3. **SIMILARITY-003 similar-video fingerprinting — implementation complete / accuracy gate open**
- bounded analysis and Similarity Review integration are implemented; next work is representative
  real-video calibration/holdout validation rather than another architecture prototype.

S4. **PERF-SIMILARITY BK-tree / metric index**
- HOLD until measured 100k+ / 250k+ scale or ingestion latency justifies it.

## Separately promoted Mobile production order

M1. **MOBILE-002 recipient compatibility:** reproduce the real attachment Picker's
empty local folders; verify SAF grants, multi-select, cancellation and restart.

M2. **MOBILE-001/004 remaining shell/consumption work:** cold/warm media measurements,
large-video/retry behavior, full gesture/lifecycle checks, system Share quick-save and
optional extension update management. The installed app/Home/cache are not new work.

M3. **MOBILE-005 Collections — DONE.** Keep the deployed cover/volume implementation.

M4. **MOBILE-006 shared Manga Catalog reads — server/v2 deployed / device acceptance open:**
versioned replica, PC-style search/list/detail/bookmark filter, Reader endpoint, native cover/page
cache and v2 latency projection are deployed. The current publication was upgraded in place.
Next is APK 0.4.3 Galaxy Tab install plus reader interaction and cold/warm timing acceptance.

M5. **MOBILE-007 bookmark changes:** after read identity/revision contract, with
idempotent retries and PC receipt/conflict semantics.

M6. **MOBILE-008 DB refresh requests:** define PC/server updater responsibility;
implement durable jobs while the previous index stays readable.

M7. **MOBILE-003 global deletion — HOLD** until explicitly approved safe protocol.

## Parallelism note for the Collection lane

Remaining Works/Collection expansion has no blanket catalog/Notes dependency.
Use each item's actual prerequisites and preserve ownership of shared files.

The Manga Shelf Grid and Game/Film normal presentation baseline are implemented.
LONG-002A and WORKS-002 are user-accepted; do not restart the shelf reskin.
CLOUD-UI-001 and STATS-001A/B await native acceptance. WORKS-001 has the TV/season/episode
structure implemented, with related-work/richer Film surfaces still partial.
