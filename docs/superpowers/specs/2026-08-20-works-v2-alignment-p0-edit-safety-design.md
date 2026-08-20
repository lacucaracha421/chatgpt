# Works v2 문서 정렬과 Collection 편집 안전성 설계

## 목적

`lakomics-codex-works-v2-package`의 최신 Works/Collection 결정을 현재 저장소의 도메인·디자인 문서에 반영하고, 일반 Collection 편집이 가져온 메타데이터와 provider identity를 지우는 P0 결함을 수정한다.

이번 변경은 다음 두 결과만 만든다.

1. 후속 Works 개발자가 handoff v2와 시각 프로토타입을 저장소 안에서 발견하고 기존 규칙과 함께 사용할 수 있다.
2. 제목, 설명, 유형, 타입별 사용자 편집 필드 또는 내 점수를 수정해도 편집 UI가 소유하지 않는 imported/provider 데이터가 유지된다.

다중 provider 스키마, 실제 provider 연동, WorkArtwork, Volume, Release Watch와 새로운 Works UI는 이번 변경에 포함하지 않는다.

## 확인된 현재 문제

패키지의 `codex-docs-alignment.patch`는 hunk 줄 범위가 없는 비표준 diff이므로 `git apply --check`에서 거부된다. 패치의 의미를 현재 파일에 수동 병합해야 한다.

현재 `CONTEXT.md`는 Showcase를 타입 혼합 자동 즐겨찾기 그리드로 정의하고 Collection마다 메타데이터 출처를 하나만 허용한다고 설명한다. 두 정의는 handoff v2의 최신 결정과 충돌한다.

현재 `CollectionEditDialog`는 화면에 없는 `genres`와 `overview`를 `null`로 만들어 전송한다. Rust의 `UpdateCollection`은 `external_id`와 `external_source`도 포함하며 업데이트 SQL이 이 필드들을 그대로 기록한다. 따라서 제목이나 점수만 편집해도 imported metadata와 provider identity가 지워질 수 있다.

## 문서 정렬

패키지에서 다음 파일을 내용 변경 없이 저장소로 가져온다.

- `docs/agents/lakomics-works-handoff-v2.md`
- `docs/prototypes/lakomics-works-v6-reference.html`

루트 문서는 패키지의 patch 의미를 현재 내용에 수동 병합한다.

- `AGENTS.md`: Works/Collection 변경 전 handoff와 프로토타입을 읽도록 진입점을 추가한다.
- `DESIGN.md`: 수집품을 집어 들거나 감상하는 의미가 있는 Works 오브젝트에만 제한된 motion 예외를 추가한다.
- `CONTEXT.md`: Showcase를 유형별 수동 전시와 순서 관리로 정의하고, Metadata Source를 한 Collection이 여러 provider 연결을 소유할 수 있는 개념으로 갱신한다.

패키지 루트의 `README-CODEX.md`, `COPY-INTO-REPO.ps1.txt`, 깨진 patch 파일은 저장소에 복사하지 않는다. 이들은 전달·적용 도구이고 장기 제품 문서가 아니다.

프로토타입 HTML은 시각·상호작용 참고 자료로만 보관한다. production React 구조로 복사하거나 런타임 자산으로 연결하지 않는다.

## Collection 업데이트 Interface

이번 P0 패치는 전면적인 nullable partial-update 프로토콜을 새로 만들지 않는다. 대신 현재 편집 UI가 소유하지 않는 imported/provider 필드를 일반 Collection 업데이트 Interface에서 제거한다.

일반 편집이 소유하는 필드는 다음과 같다.

- name
- description
- type
- year
- author
- director
- externalScore
- myScore

일반 편집이 소유하지 않는 필드는 다음과 같다.

- genres
- overview
- externalId
- externalSource
- externalSyncedAt
- externalMetadataJson

TypeScript `UpdateCollection`과 Rust `UpdateCollection`은 소유 필드만 노출한다. Rust SQL 역시 비소유 필드를 `SET` 절에서 제거한다. 보존 규칙을 backend Library Module 안에 두므로 현재 React 호출자뿐 아니라 이후의 모든 일반 업데이트 호출자가 같은 안전성을 얻는다.

`externalScore`는 이름과 달리 현재 게임 편집 UI에 노출된 기존 사용자 편집 필드이므로 이번 호환성 패치에서는 유지한다. provider/user ownership을 완전히 분리하는 작업은 다중 binding 모델과 함께 별도 설계한다.

## 데이터 흐름

1. 편집 대화상자는 기존 CollectionSummary에서 사용자 편집 필드만 초기화한다.
2. 저장 시 TypeScript `UpdateCollection`은 그 필드들만 gateway로 전달한다.
3. Tauri command가 동일한 Rust 요청 모델로 역직렬화한다.
4. Library Module은 입력을 정규화하고 소유 필드만 업데이트한다.
5. 기존 genres, overview, provider identity, sync timestamp, raw metadata JSON은 같은 행에 그대로 남는다.
6. 갱신된 CollectionSummary 전체를 반환해 화면 상태를 새 값으로 교체한다.

기존 validation, not-found, duplicate-name 오류 동작은 바꾸지 않는다.

## 테스트

Rust Library 회귀 테스트는 provider/imported 데이터가 들어 있는 Collection 행을 준비한 뒤 제목과 내 점수를 수정한다. 반환값과 DB 행에서 다음 값이 그대로인지 검증한다.

- genres
- overview
- external_id
- external_source
- external_synced_at
- external_metadata_json
- UI에 표시되지만 이번 편집에서 바꾸지 않은 다른 typed metadata

프론트 테스트는 편집 대화상자를 열어 저장하고, 제출 payload가 사용자 편집 필드만 포함하며 `genres`, `overview` 또는 provider identity를 보내지 않는지 검증한다.

변경 후 다음 검증을 실행한다.

- 관련 Rust 단위 테스트
- 관련 Vitest 테스트
- `cargo test`
- `npx tsc --noEmit`
- `npx vitest run`
- 문서 파일 존재 및 handoff 참조 경로 검사

## 후속 작업과 호환성

이 패치는 현재 단일 provider 열을 유지하면서 데이터 손실만 막는다. 이후 P1에서 여러 `ExternalBinding`을 도입할 때 provider 쓰기/refresh 전용 Interface를 일반 사용자 편집 Interface와 분리한다. 그 마이그레이션 전까지 일반 Collection 편집은 legacy provider 열을 읽어 표시할 수 있지만 수정하거나 삭제하지 않는다.

Showcase와 Metadata Source의 도메인 정의는 handoff v2를 따라 즉시 갱신하되, 현재 persistence가 아직 그 전체 동작을 제공한다고 주장하지 않는다. handoff 문서의 implementation order와 acceptance checklist가 후속 작업의 미구현 범위를 명시한다.
