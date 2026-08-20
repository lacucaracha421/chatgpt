# Works v2 P1 Work/provider 소유권 모델 설계

## 목적

Works v2 handoff의 P1을 구현할 수 있도록 Collection과 provider 사이의 소유권을 분리한다. 한 Collection은 여러 provider에 연결될 수 있어야 하고, provider 새로고침은 사용자가 보고 편집하는 로컬 작품 정보를 자동으로 덮어쓰지 않아야 한다.

이 저장소는 제품 언어로 `Work`를 사용하지만 현재 persistence와 코드에서는 호환성을 위해 `Collection` 이름을 유지한다. 별도의 Work 엔티티는 만들지 않는다.

## 현재 문제

현재 `collections` 행은 다음 책임을 동시에 가진다.

- 사용자가 보는 로컬 작품 정보
- 단일 provider의 `external_id`와 `external_source`
- 단일 동기화 시각
- provider 원본 JSON

이 구조는 MangaDex와 Aladin처럼 역할이 다른 provider를 한 만화에 함께 연결할 수 없다. 레거시 `info.txt` 가져오기도 Steam과 IGDB ID가 모두 있어도 우선순위가 높은 하나만 남긴다. provider 원본과 로컬 작품 정보가 같은 행에 섞여 있어 향후 새로고침의 쓰기 범위도 불명확하다.

## 검토한 접근

### 1. 로컬 작품 정보 우선 — 선택

`collections`는 로컬 작품 정보의 최종 소유자이고, ExternalBinding은 provider identity와 snapshot만 소유한다. 새로고침은 snapshot만 바꾸며, 로컬 작품 정보 반영은 최초 provider 기반 생성이나 사용자의 명시적 적용에서만 일어난다.

provider가 사용자 수정을 덮을 수 없고 별도의 필드별 override 상태가 필요하지 않다. Works v2의 local-first 원칙과 현재 단계에 가장 잘 맞는다.

### 2. 수정하지 않은 필드 자동 갱신

각 필드가 사용자 수정인지 provider 값인지 기록하고, 여러 provider가 같은 필드를 제공할 때 우선순위를 결정해야 한다. 자동 갱신은 편리하지만 P1부터 override mask와 merge 규칙이 필요하다.

### 3. 필드별 출처 레코드

제목, 연도, 장르 같은 값을 출처별 레코드로 분해하고 읽을 때 유효값을 합성한다. 가장 유연하지만 조회와 편집 Interface가 크게 복잡해지고 현재 요구보다 앞서간다.

## 소유권 결정

### Collection

Collection 행은 사용자가 보는 로컬 작품 레코드다. 제목, 설명, 유형, 연도, 작가·감독, 점수, 장르, 개요와 현재의 Asset 기반 대표 표지를 소유한다.

provider에서 처음 가져온 값도 Collection에 적용된 순간부터 로컬 값이다. 이후 provider snapshot이 바뀌어도 자동으로 바뀌지 않는다. 사용자가 `provider 정보 적용` 같은 명시적 동작을 수행할 때만 선택된 로컬 필드를 다시 쓴다.

이 규칙에서는 별도의 user override 테이블이 필요 없다. 모든 Collection 필드가 이미 로컬 권위값이기 때문이다. 자동 갱신이 실제 요구가 될 때에만 override provenance를 추가한다.

### ExternalBinding

ExternalBinding은 Collection과 provider의 외부 레코드를 잇는 연결이다. 다음 정보만 소유한다.

```text
collection_id
provider
external_id
provider_data_json
last_synced_at
created_at
updated_at
```

`provider_data_json`은 마지막으로 성공적으로 받아 저장한 provider snapshot이다. 원본 형태를 보존하는 불투명 JSON 문자열이며 일반 Collection 편집 Interface에 노출하지 않는다. 외부 identity만 알고 아직 snapshot이 없는 binding에서는 null일 수 있다. `last_synced_at`은 identity 또는 snapshot을 마지막으로 성공적으로 동기화한 시각이다. 단순 확인 시각, 동기화 활성화 설정, provider별 설정은 실제 Release Watch나 background sync가 생길 때 추가한다.

한 Collection에는 provider별 ExternalBinding이 최대 하나 존재한다. 따라서 `(collection_id, provider)`가 identity이며 별도의 추측성 UUID는 만들지 않는다. 같은 provider의 외부 ID를 바꾸는 것은 그 binding의 갱신이고, 다른 provider를 연결하는 것은 새 binding의 추가다. 서로 다른 Collection이 같은 외부 ID를 참조하는 것은 DB에서 금지하지 않는다.

### WorkArtwork

WorkArtwork는 provider 또는 로컬 source에서 얻어 Work를 표현하는 이미지다. Asset Library의 수집 자산이 아니며, 사용자가 명시적으로 Asset으로 가져오기 전에는 `assets` 테이블이나 자산 그리드에 나타나지 않는다.

향후 파일은 self-contained Library 내부의 `work-artwork/` 아래에서 artwork cache Module이 관리한다. DB 레코드는 provider image identity, kind, 상대 경로, 크기, 언어, 정렬과 선택 상태를 소유한다. 실제 table, 다운로드 원자성, 삭제 복구와 media route는 첫 번째 실제 소비자인 P2 MangaDex 흐름에서 함께 설계·구현한다. P1은 사용하지 않는 디렉터리나 빈 table을 미리 만들지 않는다.

## 스키마와 마이그레이션

스키마 v13에 `collection_external_bindings`를 추가한다.

```text
collection_external_bindings
- collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE
- provider TEXT NOT NULL
- external_id TEXT NOT NULL
- provider_data_json TEXT
- last_synced_at TEXT
- created_at TEXT NOT NULL
- updated_at TEXT NOT NULL
- PRIMARY KEY (collection_id, provider)
```

provider와 external ID의 공백 값은 허용하지 않는다. `(provider, external_id)` 조회용 index를 둔다. provider 문자열은 Library Module이 trim하고 소문자로 정규화한다. DB는 알려진 provider 목록을 CHECK로 고정하지 않아 이후 provider 추가가 schema migration을 요구하지 않게 한다.

마이그레이션은 기존 `external_source`와 `external_id`를 trim했을 때 둘 다 비어 있지 않은 Collection마다 binding 하나를 backfill한다. provider는 trim 후 소문자로 정규화하고 external ID는 trim한다. 기존 `external_metadata_json`과 `external_synced_at`도 같은 binding으로 복사한다.

P1부터 새 코드와 반환 모델은 legacy 단일-provider 컬럼을 source of truth로 사용하지 않는다. 다만 source 또는 ID 한쪽만 있는 손상·부분 데이터와 원본 JSON을 조용히 잃지 않도록 물리적 컬럼은 v13에서 바로 삭제하지 않는다. 레거시 읽기·쓰기가 완전히 제거되고 실제 데이터 검사가 가능한 호환성 정리 단계에서 삭제한다. 이 보존은 dual-write 허용이 아니다.

## Module과 Interface

SQLite 세부사항은 기존 Library Module 안에 둔다. ExternalBinding persistence는 Collection CRUD와 분리된 작은 Interface를 제공한다.

```text
list_collection_external_bindings(collection_id)
upsert_collection_external_binding(collection_id, binding)
```

upsert는 provider 정규화, Collection 존재 확인, 빈 ID 거부, snapshot과 동기화 시각의 원자적 저장을 내부에서 처리한다. P1에 실제 호출자가 없는 unlink, refresh scheduler, provider registry 또는 provider Adapter Interface는 만들지 않는다.

레거시 book migration은 같은 persistence 구현을 사용한다. `info.txt`에서 하나를 고르는 `pick_external_id`를 여러 알려진 ID를 반환하는 parsing으로 바꾸고, Steam과 IGDB처럼 함께 존재하는 모든 binding을 Collection 생성 transaction 안에서 저장한다.

P1에는 Tauri command, TypeScript gateway, React UI 또는 원격 provider 호출을 추가하지 않는다. 첫 네트워크 소비자인 P2가 필요한 최소 command와 provider seam을 정의한다.

## 데이터 흐름

### 레거시 가져오기

1. `info.txt`에서 로컬 작품 필드와 알려진 모든 provider ID를 읽는다.
2. 하나의 transaction에서 Collection을 만든다.
3. 각 provider ID를 ExternalBinding으로 upsert한다.
4. 어느 binding 저장이라도 실패하면 Collection 생성까지 rollback한다.

### 이후 provider 새로고침

P2 이후의 새로고침은 다음 규칙을 따른다.

1. provider Adapter가 원격 응답을 가져온다.
2. 응답이 유효할 때만 ExternalBinding snapshot과 `last_synced_at`을 함께 저장한다.
3. 기존 Collection 로컬 필드는 바꾸지 않는다.
4. 사용자가 provider 정보 적용을 선택하면 별도의 명시적 Collection update가 선택 필드만 쓴다.
5. 실패한 요청은 기존 snapshot과 로컬 작품 정보를 그대로 둔다.

## 오류와 안전성

- 없는 Collection에는 binding을 만들지 않는다.
- provider 또는 external ID가 비어 있으면 저장 전에 거부한다.
- provider snapshot은 새 값의 저장이 성공하기 전까지 기존 값을 유지한다.
- Collection 삭제는 foreign key cascade로 binding을 함께 삭제한다.
- 일반 Collection 편집은 binding table을 쓰지 않는다.
- migration은 완전한 legacy identity만 backfill하고, 불완전한 legacy 값은 컬럼 삭제로 유실하지 않는다.
- provider 네트워크 오류, rate limit, 재시도 정책은 P2 provider 흐름에서 다룬다.

## 테스트

P1은 다음을 검증한다.

- v12 DB의 단일 provider identity, raw JSON과 동기화 시각이 v13 binding으로 보존된다.
- source 또는 ID가 한쪽만 있는 legacy 데이터도 migration 뒤 원래 컬럼에 남는다.
- 한 Collection에 MangaDex와 Aladin binding을 동시에 저장하고 조회할 수 있다.
- 같은 provider upsert는 중복 행을 만들지 않고 external ID, snapshot과 시각을 갱신한다.
- 다른 Collection의 binding은 영향을 받지 않는다.
- Collection 삭제는 binding을 cascade 삭제한다.
- 일반 Collection 편집은 binding을 변경하지 않는다.
- Steam과 IGDB ID가 함께 있는 `info.txt`는 binding 두 개를 만든다.
- binding 저장 실패 시 레거시 Collection 가져오기 transaction 전체가 rollback된다.
- Rust 직렬화 모델과 TypeScript `CollectionSummary`에는 legacy 단일-provider 필드가 남지 않는다.

구현 후 관련 단위 테스트에 이어 전체 `cargo test`, `npx tsc --noEmit`, `npx vitest run`을 실행한다.

## 범위 밖

다음은 P1에서 구현하지 않는다.

- MangaDex 또는 다른 provider의 네트워크 호출
- provider 검색·선택 UI
- provider Adapter Interface의 추측성 공통화
- 자동 metadata merge와 필드별 override 추적
- WorkArtwork table, 다운로드와 media route
- Volume과 Aladin Release Watch
- Showcase와 production Works UI 변경

P1 완료 후 P2에서 MangaDex 검색, 상세 정보, cover artwork와 로컬 cache를 한 흐름으로 구현하면서 첫 provider seam과 WorkArtwork persistence를 실제 요구에 맞춰 추가한다.
