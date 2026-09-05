# Architecture Decision Records

이 디렉터리는 Lakomics의 중요한 구조적 결정을 기록합니다. ADR은 삭제해서 역사를 지우기보다 상태를 명시해 보존합니다.

## 상태 읽는 법

- **Accepted**: 현재 설계 제약으로 사용합니다.
- **Superseded**: 후속 ADR이나 현재 reference로 대체된 역사 자료입니다. 현재 구조를 되돌리는 근거로 사용하지 않습니다.
- **Proposed**: 아직 확정되지 않은 제안입니다.

현재 구현 사실과 문서가 충돌하면 `docs/agents/domain.md`의 우선순위를 따릅니다. 오래된 ADR을 구현하기 전에 현재 checkout의 코드, migration, type/interface, `CONTEXT.md`를 확인합니다. `main`은 통합 기준이며 진행 중인 task의 변경을 대신하지 않습니다.

동일한 `0013` 번호를 가진 두 파일은 서로 다른 결정입니다. 기존 파일을 재번호화하지 않고 제목과 전체 경로로 구분합니다. 아래 상태는 결정의 적용 범위이며 모든 세부 동작의 구현/검증 완료를 뜻하지 않습니다.

## Status index

| ADR | Status | Note |
| --- | --- | --- |
| [0001 Managed asset ingestion](0001-managed-asset-ingestion.md) | Accepted | Media Vault가 자산 파일 생명주기를 소유하는 기본 원칙 |
| [0002 Windows first](0002-windows-first.md) | Accepted | 현재 데스크톱 제품 기준 |
| [0003 Local first](0003-local-first.md) | Accepted, clarified by ADR-0033 | 로컬 라이브러리와 오프라인 사용 우선 |
| [0004 Tags and collections over folders](0004-tags-and-collections-over-folders.md) | **Superseded** | ADR-0013이 현재 Classification 모델을 정의함 |
| [0005 Typed hierarchical tags](0005-typed-hierarchical-tags.md) | **Superseded** | hierarchy 취지는 유지되지만 다중 직접 membership은 ADR-0013으로 대체 |
| [0006 User-defined classification is not behavior](0006-user-defined-classification-is-not-behavior.md) | Accepted | 사용자 이름/위치로 기능 분기하지 않음 |
| [0007 Exact and similar duplicates](0007-exact-and-similar-duplicates.md) | Accepted | exact duplicate와 similarity review를 구분 |
| [0008 Chromium-extension-first ingestion](0008-chromium-extension-first-ingestion.md) | Accepted | 확장 수집 경로의 기본 결정; 현재 bundled `extension/` 구현을 함께 확인 |
| [0009 Rewrite browser extension around a small interface](0009-rewrite-browser-extension-around-a-small-interface.md) | Accepted | 확장 내부 구현은 현재 코드가 source of truth |
| [0010 Progressive two-ring donut](0010-progressive-two-ring-donut.md) | Accepted | 현재 radial interaction의 역사/행동 원칙 |
| [0011 Library trash before file deletion](0011-library-trash-before-file-deletion.md) | Accepted | 앱 휴지통을 거쳐 삭제 |
| [0012 Classification tree is primary navigation](0012-classification-tree-is-primary-navigation.md) | Accepted | Asset Library 탐색 원칙; ADR-0013이 membership 경계를 명확히 함 |
| [0013 Classification tree + single direct membership](0013-classification-tree-single-direct-membership.md) | **Accepted** | 현재 Classification/Album/Collection 경계 |
| [0013 자산 목록은 높이가 같은 행으로 배치한다](0013-justified-row-asset-gallery.md) | Accepted | 행 기반 갤러리; membership ADR-0013과 별개 |
| [0014 기존 Lakomics 데이터는 한 번 가져오고 형식 호환은 유지하지 않는다](0014-one-time-legacy-lakomics-import.md) | Accepted | 복사 기반 이전과 원본 보존; 기존 rollout을 재실행하는 지시가 아님 |
| [0015 이미지 5만 개와 영상 5천 개를 성능 목표로 삼는다](0015-fifty-thousand-images-five-thousand-videos.md) | Accepted, partly superseded | 규모 목표 유지; 영상 원본 접근 제한은 ADR-0025로 대체 |
| [0016 첫 버전은 영상을 관리하되 직접 재생하지 않는다](0016-manage-video-before-building-a-player.md) | Superseded by ADR-0025 | 외부 플레이어만 사용하던 초기 범위 |
| [0017 데스크톱 앱은 Tauri와 작은 Rust 핵심부로 만든다](0017-tauri-desktop-with-a-small-rust-core.md) | Accepted | Tauri/WebView2 + React/TypeScript + Rust 경계 |
| [0018 라이브러리는 SQLite와 일반 미디어 폴더로 구성한다](0018-self-contained-library-folder.md) | Accepted | SQLite와 미디어/백업 폴더 소유 경계 |
| [0019 자산 파일은 내용 해시로 이름을 정한다](0019-content-addressed-asset-files.md) | Accepted | 내용 해시 기반 저장과 사용자 파일명 메타데이터 분리 |
| [0020 확장 프로그램은 인증된 로컬 HTTP로 앱과 연결한다](0020-authenticated-loopback-extension-interface.md) | Accepted for direct PC transport | 선택적 Cloud 경로는 ADR-0033과 현재 X Collector reference를 함께 확인 |
| [0021 X를 우선하고 Pixiv를 보조하는 출처 어댑터를 만든다](0021-twitter-first-source-adapters.md) | Historical initial scope | 현재 지원 출처/메타데이터/수집 행동은 X Collector reference와 코드로 확인; Pixiv 구현 지시가 아님 |
| [0022 SQLite 메타데이터 백업을 자동으로 순환 보관한다](0022-rotating-sqlite-metadata-backups.md) | Accepted | 순환 백업 및 복구 전 보존 원칙 |
| [0023 백그라운드 작업은 중단 후 다시 이어갈 수 있어야 한다](0023-resumable-background-jobs.md) | Accepted | 중단 복구 및 파일/메타데이터 commit 안전성 |
| [0024 기존 공통 UI를 발전시키고 shadcn을 도입하지 않는다](0024-evolve-existing-ui-system-without-shadcn.md) | Accepted; icon detail updated | 기존 공통 UI/CSS 유지; 현재 아이콘 구현은 app/package.json의 Heroicons |
| [0025 영상은 원본을 우선 재생하고 필요할 때만 호환 재생본을 만든다](0025-original-first-video-playback.md) | Accepted | ADR-0016 및 ADR-0015의 원본 접근 제한 대체 |
| [0026 아이콘 버튼에 툴팁을 두지 않고 설정 보기의 버튼 설명으로 모은다](0026-icon-buttons-without-tooltips.md) | Accepted | 접근 가능한 이름을 유지하고 정적 버튼 설명 사용 |
| [0027 안전 설정을 설정 보기의 [안전] 섹션으로 통합한다](0027-safety-settings-in-settings-view.md) | Accepted | 안전 설정 통합; 현재 UI 구성은 구현과 함께 확인 |
| [0028 망가 시리즈는 라이브러리 밖 폴더를 참조한다](0028-manga-series-reference-external-folders.md) | Accepted for local manga folders | 외부 사용자 폴더 참조; 타입별 Works Collection과 구분 |
| [0029 분류 항목을 폴더처럼 조작하되 저장 위치로 만들지 않는다](0029-classification-folders-are-navigation.md) | Partly superseded by ADR-0030 | 다중 직접 소속/추가형 드롭은 대체; 파일 저장 경로와 분류의 분리는 유지 |
| [0030 일반 폴더는 단일 직접 소속, 앨범은 다중 수동 묶음으로 사용한다](0030-single-folder-and-manual-albums.md) | Accepted; clarified by ADR-0013/0031 | 단일 직접 분류와 수동 Album 유지; Works의 초기 미래형 표현은 역사 |
| [0031 컬렉션을 타입별 작품 모델로 재정의하고 외부 메타데이터를 연동한다](0031-collection-as-typed-work-model.md) | Accepted | 타입별 Works 경계; 초기 구현 순서는 완료 상태를 증명하지 않음 |
| [0032 Provider artwork stays outside the Asset Library](0032-provider-artwork-stays-out-of-the-asset-library.md) | Accepted | WorkArtwork와 사용자 Asset 생명주기 구분 |
| [0033 Local authority with optional cloud sync](0033-local-authority-with-optional-cloud-sync.md) | **Accepted** | 로컬 권위를 유지하며 선택적 단방향 클라우드 복제를 허용 |

새 ADR을 추가하거나 기존 결정을 대체할 때 이 인덱스와 해당 ADR의 `Status`/`Supersedes`/`Clarifies` 관계도 같이 갱신합니다.
