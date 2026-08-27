# Architecture Decision Records

이 디렉터리는 Lakomics의 중요한 구조적 결정을 기록합니다. ADR은 삭제해서 역사를 지우기보다 상태를 명시해 보존합니다.

## 상태 읽는 법

- **Accepted**: 현재 설계 제약으로 사용합니다.
- **Superseded**: 후속 ADR이나 현재 reference로 대체된 역사 자료입니다. 현재 구조를 되돌리는 근거로 사용하지 않습니다.
- **Proposed**: 아직 확정되지 않은 제안입니다.

현재 구현 사실과 문서가 충돌하면 `docs/agents/domain.md`의 우선순위를 따릅니다. 오래된 ADR을 구현하기 전에 현재 `main`의 코드, migration, type/interface, `CONTEXT.md`를 확인합니다.

## Status index

| ADR | Status | Note |
| --- | --- | --- |
| 0001 Managed asset ingestion | Accepted | Media Vault가 자산 파일 생명주기를 소유하는 기본 원칙 |
| 0002 Windows first | Accepted | 현재 데스크톱 제품 기준 |
| 0003 Local first | Accepted | 로컬 라이브러리와 오프라인 사용 우선 |
| 0004 Tags and collections over folders | **Superseded** | ADR-0013이 현재 Classification 모델을 정의함 |
| 0005 Typed hierarchical tags | **Superseded** | hierarchy 취지는 유지되지만 다중 직접 membership은 ADR-0013으로 대체 |
| 0006 User-defined classification is not behavior | Accepted | 사용자 이름/위치로 기능 분기하지 않음 |
| 0007 Exact and similar duplicates | Accepted | exact duplicate와 similarity review를 구분 |
| 0008 Chromium-extension-first ingestion | Accepted | 확장 수집 경로의 기본 결정; 현재 bundled `extension/` 구현을 함께 확인 |
| 0009 Rewrite browser extension around a small interface | Accepted | 확장 내부 구현은 현재 코드가 source of truth |
| 0010 Progressive two-ring donut | Accepted | 현재 radial interaction의 역사/행동 원칙 |
| 0011 Library trash before file deletion | Accepted | 앱 휴지통을 거쳐 삭제 |
| 0012 Classification tree is primary navigation | Accepted | Asset Library 탐색 원칙; ADR-0013이 membership 경계를 명확히 함 |
| 0013 Classification tree + single direct membership | **Accepted** | 현재 Classification/Album/Collection 경계 |

새 ADR을 추가하거나 기존 결정을 대체할 때 이 인덱스와 해당 ADR의 `Status`/`Supersedes`/`Clarifies` 관계도 같이 갱신합니다.
