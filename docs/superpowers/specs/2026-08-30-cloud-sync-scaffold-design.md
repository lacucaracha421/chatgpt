# Lakomics 클라우드 동기화 스캐폴드 설계

## 목적과 현재 결정

Lakomics는 로컬 라이브러리를 계속 권위 원본으로 사용한다. 클라우드는 사용자가 선택적으로 켤 수 있는 단방향 로컬 → 클라우드 복제 경로이며, 설정이 없거나 원격 시스템이 실패해도 로컬 수집과 열람은 유지되어야 한다.

장기적으로 클라우드를 권위 원본으로 전환할지는 이번 결정에 포함하지 않는다. 이번 구현은 나중의 전환을 가정해 로컬 동작을 약화하거나 추상화하지 않는다.

## 검토한 접근

### 선택: 라이브러리 SQLite의 transactional outbox

자산 레코드와 동기화 의도를 같은 SQLite 트랜잭션에서 기록한다. 트랜잭션이 성공하기 전에는 원격 작업이 존재하지 않고, 성공한 뒤에는 재시도 가능한 큐 레코드가 남는다. 큐 기록은 네트워크나 클라우드 설정을 읽지 않으므로 로컬 수집에 원격 의존성을 추가하지 않는다.

### 제외: 로컬 커밋 뒤 best-effort 큐 기록

로컬 성공과 큐 기록 사이에 프로세스가 중단되면 영구적으로 누락된 자산이 생길 수 있다. 오류를 호출자에게 반환하면 이미 성공한 로컬 커밋을 실패처럼 보이게 할 수 있어 선택하지 않는다.

### 제외: 별도 동기화 데이터베이스

라이브러리와 큐의 원자성을 잃고 백업·이동·복구 대상이 늘어난다. 기존 라이브러리 migration과 SQLite 잠금 Interface를 재사용하는 편이 더 작고 안전하다.

## Module과 seam

최상위 `cloud` Module을 `lib.rs`에 등록한다. 외부 seam은 당분간 만들지 않고, `Library`가 사용하는 crate 내부 Interface만 둔다.

- `cloud/models.rs`: 비밀값을 포함하지 않는 설정, 큐 레코드, 한 건의 업로드 준비 자료를 정의한다.
- `cloud/queue.rs`: 기존 `Library` SQLite 연결에서 큐를 생성하고 읽는다.
- `cloud/sync.rs`: 다음 자산 한 건을 조회해 안정적인 object key와 로컬 파일 위치를 조합한다. 네트워크 요청은 하지 않는다.
- `cloud/mod.rs`: 필요한 내부 Interface만 다시 노출한다.

실제 VPS 요청 형식이 정해지기 전에는 `client.rs`를 만들지 않는다. 하나뿐인 가상 Adapter나 빈 HTTP Interface를 미리 두지 않고, signed URL 계약이 생길 때 추가한다.

후속 마일스톤에서 실제 VPS 계약이 정해져 `client.rs`를 추가했다. 이 클라이언트는 Bearer 인증으로 presign을 요청하고, 반환된 header를 사용해 R2에 직접 파일을 PUT한 뒤 VPS에 자산 메타데이터를 등록한다. 자동 worker나 UI는 아직 추가하지 않는다.

## 설정과 자격 증명

`library_settings`에 다음 비밀이 아닌 값만 추가한다.

- `cloud_sync_enabled INTEGER NOT NULL DEFAULT 0`
- `cloud_api_base_url TEXT`

초기값은 비활성화이며, 설정이 없는 기존 라이브러리는 현재와 똑같이 동작한다. URL은 `http` 또는 `https`만 허용하고 사용자명·비밀번호가 포함된 URL은 거부한다.

R2 Access Key ID와 Secret Access Key는 데스크톱 설정에 포함하지 않는다. R2 자격 증명은 VPS가 소유하고, 데스크톱과 모바일은 장차 VPS가 발급한 signed URL만 사용한다. VPS 인증 토큰 형식이 정해지면 기존 Windows Credential Manager 구현에 별도 target으로 저장하며 SQLite나 저장소 파일에는 기록하지 않는다.

## migration과 큐 모델

`0028_cloud_sync_queue.sql`을 추가하고 schema version을 28로 올린다. 기존 migration 절차대로 라이브러리 개방 시 사전 백업을 만든 뒤 하나의 SQLite 트랜잭션에서 적용한다.

`cloud_sync_queue`는 다음 필드를 가진다.

- `id TEXT PRIMARY KEY`: 큐 작업 UUID
- `entity_type TEXT`: 첫 단계에서는 `asset`
- `entity_id TEXT`: 안정적인 자산 UUID
- `operation TEXT`: 첫 단계에서는 `upsert`
- `status TEXT`: `pending`, `processing`, `synced`, `failed`
- `revision INTEGER`: 처음 수집한 자산은 1
- `retry_count INTEGER`: 0부터 시작
- `updated_at TEXT`: 마지막 상태 변경 시각
- `synced_at TEXT`: 성공 전에는 `NULL`
- `last_error TEXT`: 실패 원인의 로컬 기록, 초기에는 `NULL`

중복 작업을 막기 위해 `(entity_type, entity_id, operation, revision)`에 UNIQUE 제약을 둔다. 소비 순서는 `status`, `updated_at`, `id` 인덱스로 결정한다. 이번 단계에는 processing 전환, retry/backoff, 성공·실패 갱신을 넣지 않는다.

후속 마일스톤에서는 한 건을 SQLite 트랜잭션으로 `pending → processing` claim하고, 성공 시 `synced`, 실패 시 `retry_count`와 `last_error`를 기록한다. 재시도 가능한 실패는 `pending`, 영구 실패는 `failed`로 전환한다. 앱 시작 시 남아 있는 `processing`은 이전 프로세스에서 중단된 작업이므로 다시 `pending`으로 전환한다. 시간 기반 backoff는 아직 없다.

서버 계약 확정 후 network 오류, timeout, HTTP 429와 5xx만 `pending`으로 복구하도록 구체화했다. 비일시적 4xx와 로컬 파일 오류는 `failed`로 남긴다. `POST /v1/assets`는 동일 자산 ID에 대해 idempotent upsert이며, 다른 자산 ID의 object key 충돌은 409로 반환되어 재시도하지 않는다.

## 수집과 큐 기록 흐름

이미지와 비디오 수집은 현재처럼 PC에서 해시, 검사, 썸네일 또는 probe를 끝낸다. `register_asset`과 `register_video_asset`의 기존 SQLite 트랜잭션에 정상 자산의 `asset/upsert/revision 1` 큐 삽입만 추가한다.

유사 이미지 검토 중인 자산은 아직 수집 확정 상태가 아니므로 첫 단계에서 큐에 넣지 않는다. 향후 `keep_both` 또는 교체 결정을 처리하는 경로가 동기화 범위에 들어올 때 별도 revision을 기록한다.

SQLite 트랜잭션이 커밋되기 전에는 sync 실행을 시작하지 않는다. 자동 worker, 시작 시 자동 실행과 타이머는 아직 없다. 명시적인 한 건 sync 경로에서만 VPS 요청과 R2 업로드를 수행하므로 원격 실패가 로컬 자산 커밋을 되돌릴 경로는 생기지 않는다.

## 안정적인 object key

object key는 UUID 형식의 안정적인 자산 ID와 미디어 종류만 사용한다. Windows 절대 경로, 라이브러리 상대 경로, 제목, 원래 파일명은 사용하지 않는다.

- 이미지와 GIF 원본: `images/{asset_id}/original`
- 이미지와 GIF 썸네일: `thumbnails/{asset_id}.webp`
- 영상 원본: `videos/{asset_id}/original`

파일 확장자는 key에 의존하지 않고 향후 object metadata의 MIME type으로 전달한다. `work-artwork/`와 `backups/`는 해당 엔티티가 실제 동기화 범위에 들어올 때 같은 안정 ID 규칙으로 추가한다.

## 첫 마일스톤 Interface

첫 단계는 다음 동작만 제공한다.

1. 클라우드 설정을 저장하고 불러온다. 기본값은 비활성화다.
2. 성공한 정상 자산 수집과 함께 pending 큐 레코드를 만든다.
3. 큐 레코드를 ID로 불러오고 다음 pending 자산 한 건을 선택한다.
4. 선택한 자산에서 로컬 원본 경로와 path-independent object key를 가진 업로드 준비 자료를 만든다.

업로드 준비 자료는 테스트 가능한 sync seam이지만 네트워크 전송 Interface는 아니다.

## 오류와 호환성

- 클라우드 설정이 비활성화여도 큐 의도는 로컬에 보존한다. 나중에 활성화하면 누락 없이 처리할 수 있다.
- 클라우드 설정 부재, 자격 증명 부재, VPS 중단은 수집 코드에서 검사하지 않는다.
- 큐 작업 생성은 자산 등록과 같은 로컬 DB 커밋의 일부다. DB 자체가 실패하면 기존 수집 실패 처리와 파일 정리가 그대로 적용된다.
- 운영 라이브러리 `C:\New_lakomics_assets`는 구현과 검증 중 열거나 변경하지 않는다. 모든 migration 및 수집 검증은 임시 라이브러리에서 수행한다.

## 검증

1. v27 임시 DB가 v28로 migration되고 기본 클라우드 설정과 큐 제약이 생기는 실패 테스트를 먼저 작성한다.
2. 정상 이미지 수집이 pending 작업 하나를 원자적으로 만드는 실패 테스트를 작성한다.
3. 유사 이미지 검토 대상과 완전 중복은 새 큐 작업을 만들지 않는지 확인한다.
4. 다음 작업 준비 결과의 object key가 제목·원래 이름·로컬 경로와 무관하고 자산 UUID만 사용하는지 확인한다.
5. 가장 작은 관련 Rust 테스트부터 실행하고, 변경된 crate의 컴파일 위험이 남을 때만 `cargo test --lib`로 확장한다.

## 후속: 클라우드 캡처 수신함 (원격 → 로컬)

이 스캐폴드는 방향 A(로컬 → 클라우드)만 담았다. 이후 마일스톤에서 X 확장 → VPS Capture API → R2로 적재된 pending capture를 PC가 가져오는 반대 방향이 추가됐다(방향 B).

- **개념 분리**: outbound `cloud_sync_queue`(`pending/processing/synced/failed`)와 inbound 캡처 수신함은 별개다. inbound는 `cloud_capture_imports` 테이블(마이그레이션 0029, `imported`/`acknowledged`)로 추적한다. 두 개념은 테이블·상태·재시도 정책을 공유하지 않는다.
- **수집은 캐논 경로 하나**: 받은 파일은 `assets/.staging`에 캡처 ID·MIME에서 만든 안전한 이름으로 내려받고, `Library::ingest_media`에 `ImportSource::BrowserExtension`으로 넣는다. 해시 중복 판정, 썸네일, 유사 검토 등 기존 수집 동작이 그대로 권위를 가진다.
- **ack 순서**: 로컬 수집 확정(Added 또는 ExactDuplicate) → `cloud_capture_imports`에 `imported` 기록 → 원격 acknowledge → 기록을 `acknowledged`로 갱신. ack 실패는 로컬을 되돌리지 않고, 다음 폴이 imported 기록을 보고 ack만 재시도한다.
- **skip 정책**: 목록 파싱은 관대하게(serde default) 받고, 개별 기록의 형식 오류·미디어 종류 불명·다운로드 실패·수집 실패는 그 캡처만 건너뛴다. 한 건의 고장이 이후 캡처를 막지 않는다. 원격은 실패 건을 pending으로 유지해 재시도한다.
- **ReviewPending은 확정이 아니다**: 유사 이미지 검토 대기가 된 캡처는 imported로 만들지 않고 다음 폴에서 다시 시도한다.
- **폴링**: `run_due_cloud_capture_sync` 명령을 프론트가 시작 직후 1회, 이후 5분 간격 실행(겹침 없음). 네트워크 오류는 무시하고 다음 폴에서 재시도한다.
- **계약 갭(해소 시 갱신 필요)**: 이 저장소에 VPS Capture API 서버 구현이 없어 라우트와 스키마는 이 저장소의 `/v1` 계약 스타일(presign/assets, Bearer 토큰)에 맞춘 최소 가정이다. 확정된 서버 계약이 정해지면 `cloud/client.rs`의 캡처 메서드와 `capture_tests`를 그 계약으로 갱신한다.
