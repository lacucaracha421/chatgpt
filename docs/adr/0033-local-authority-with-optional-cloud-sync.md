# 로컬 권위를 유지하며 선택적 클라우드 복제를 허용한다

Status: Accepted

Clarifies: ADR-0003 Local first

Lakomics의 로컬 라이브러리는 계속 권위 원본이며 계정, 네트워크 또는 클라우드 설정 없이 수집하고 열람할 수 있어야 한다. 사용자가 선택하면 성공한 로컬 커밋을 출발점으로 단방향 로컬 → 클라우드 복제를 수행할 수 있다. 클라우드 실패는 이미 성공한 로컬 변경을 되돌리지 않으며 동기화 작업은 영속 큐에서 비동기·재시도 가능하게 처리한다.

미디어 해시, 썸네일과 WebP 생성, 영상 probe와 transcoding은 PC에서 수행한다. VPS는 API, 메타데이터, 인증, 동기화 상태와 signed URL 발급을 담당하고, 비공개 Cloudflare R2 bucket은 미디어 object를 보관한다. R2 자격 증명은 데스크톱이나 저장소에 두지 않는다.

이 결정은 ADR-0003의 로컬 우선 원칙을 유지하면서 자체 클라우드 동기화를 제공하지 않는다는 초기 범위 제한만 갱신한다. 클라우드를 장기적인 권위 원본으로 전환할지는 결정하지 않는다.

VPS의 `POST /v1/assets`는 동일 자산 ID에 대해 `ON CONFLICT(id) DO UPDATE` 방식의 idempotent upsert를 보장한다. 따라서 자산 등록 응답이 유실돼도 동일 요청을 안전하게 다시 보낼 수 있다. 다른 자산 ID가 이미 사용 중인 object key를 등록하면 의도적으로 409를 반환하며, 클라이언트는 이를 `failed`로 기록하고 반복 재시도하지 않는다.


동기화에는 두 방향이 있고 로컬 라이브러리는 항상 권위 원본이다.

**A. 로컬 캐논 라이브러리 → 클라우드 복제**: `cloud_sync_queue`의 transactional outbox가 로컬 커밋을 출발점으로 자산 원본과 메타데이터를 VPS/R2로 복제한다.

**B. 원격 캡처 수신함 → 로컬 수집**: X 확장 → VPS Capture API → R2로 적재된 pending capture를 PC Lakomics가 주기적으로 폴링해 내려받고, 기존 캐논 수집 경로(`Library::ingest_media`)로 로컬 자산을 만든 뒤에만 원격 캡처를 imported로 표시한다. inbound 상태는 `cloud_capture_imports` 테이블로 추적하며 outbound `cloud_sync_queue`와 테이블·상태 기계가 완전히 분리된다. 로컬 수집이 성공하면 ack 실패 여부와 무관하게 재시도 시 exact duplicate 판정으로 중복 자산 없이 acknowledge만 다시 시도한다. 수집 실패, 검토 대기(ReviewPending)는 imported로 만들지 않는다.

R2 자격 증명은 이 방향에서도 데스크톱이 가지지 않는다. 캡처 미디어 다운로드는 VPS가 발급한 signed download URL로만 수행한다.
