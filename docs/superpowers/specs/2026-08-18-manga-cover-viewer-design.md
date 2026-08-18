# 만화 표지 뷰어 — 컬렉션 오버레이 디자인

## 개요

구 프로그램(whatthe3)의 만화 표지 뷰어(`_MangaViewer`)를 현재 lakomics(Tauri/React) 아키텍처에 맞게 재구현한다. "책장에서 책이 다가와 펼쳐지는" 전시 감각을 디자인 원칙(DESIGN.md) 안에서 표현한다.

알라딘 API 연동(신간 체크, 미보유 권 계산)은 다음 단계로 미루고, 이번에는 뷰어 구조와 서지/권수 표시를 완성한다.

## 데이터 모델

### 스키마 변경

`library_settings` 테이블에 컬럼 1개:

```sql
ALTER TABLE library_settings ADD COLUMN collection_source_root TEXT;
```

`collections` 테이블에 컬럼 1개:

```sql
ALTER TABLE collections ADD COLUMN source_path TEXT;
```

### 경로 전략

- `collection_source_root` — 구성 가능한 루트 경로. 설정 UI에서 선택. 망가 폴더(`manga_root`)와 동일한 패턴.
- `source_path` — 루트 기준 **상대 경로만** 저장. 예: `comics/나루토`, `games/GAME_Elden Ring`.
- 절대 경로 하드코딩 금지. 폴더 이동 시 루트 설정만 변경하면 복구.
- 백엔드가 `collection_source_root + source_path + /covers/` 조합으로 파일 접근.

### 마이그레이션 수정

`import_book_collections(root)` 호출 시:
1. `root`를 `collection_source_root`로 `library_settings`에 저장
2. 각 폴더의 상대 경로를 `collections.source_path`에 저장 (예: `comics/나루토`)

### 새 Tauri 명령

| 명령 | 설명 |
|---|---|
| `get_collection_source_root()` | `library_settings.collection_source_root` 반환 |
| `set_collection_source_root(path)` | 루트 설정 + 디렉토리 생성 보장 |
| `list_collection_covers(collection_id)` | `collection_source_root + source_path + /covers/` 스캔 → 파일 경로 리스트 + 선반 분류 반환 |
| `get_collection_media(collection_id, file_path)` | 특정 표지 이미지 파일 스트림 반환 (기존 `open_manga_media` 패턴 재사용) |

### 선반 분류 로직

파일명에서 `vol_([0-9.]+)_` 패턴 추출 (구판 `_volRegex`와 동일):

- **선반 1**: 정수 버전 (`vol_1_`, `vol_2_`)
- **선반 2**: 소수점 .1 (`vol_1.1_`)
- **선반 3**: 소수점 .2 (`vol_1.2_`)
- **선반 4**: 버전 정보 없는 파일

각 선반 내에서 자연 정렬(natural sort).

### 기존 모델 변경

`CollectionSummary`에 `sourcePath: string | null` 필드 추가. 프론트엔드에서 컬렉션에 source_path가 있는지 판단.

## 표지 그리드 (책장)

### 컬렉션 브라우저 그리드 — 기존 유지

- `CollectionCard` (표지 2:3 + 타입 + 이름 + asset 수) 변경 없음
- 컬렉션 클릭 → `onViewChange({ kind: "collection", collectionId })` → 새 오버레이 뷰로 라우팅

### 오버레이 내부 썸네일 리스트 (하단 영역)

- `--color-bg` 배경, 상단과 1px `--color-border` 분리선
- 좌측: 4개 선반 버튼을 **2x2 그리드**로 배치 (compact 44x44, 선택 시 `--color-selected` 배경 + `--color-accent` 테두리)
- 우측: 반응형 그리드 (`auto-fill, minmax(80px, 1fr)`, gap 4px, 타일 radius 2px)
- 각 썸네일: 표지(0.7 비율) + 하단 vol.N 라벨 (11px muted)
- **책장 느낌**: 썸네일 아래 1px `--color-border` 선 + 미세 그림자 (`0 1px 2px rgba(0,0,0,0.3)`) — 표지의 물리감 표현, floating 요소가 아님
- 선택: inset outline (`--focus-width` `--color-accent`), hover scale 없음
- 일반 스크롤 (구판의 페이지네이션 방식 대신)

## 오버레이 (책이 다가와 펼쳐지는)

### 트리거

그리드에서 컬렉션 클릭 → 오버레이가 화면 전체를 덮음

### 전환 애니메이션

- 배경: `--color-bg`가 160ms fade-in으로 화면 덮음 (투명도 0 → 1)
- 표지: 클릭한 위치에서 중앙으로 160ms 이동 + 확대. `transform`으로 위치/크기 전환 후 정위치. 이후 cross-fade로 표지 교체.
- 닫기: 역방향, 160ms. ESC 또는 배경 클릭.
- DESIGN.md 준수: 80~160ms 범위, opacity 전환 우선, 장식용 entrance animation 없음.

### 오버레이 레이아웃 (전체 화면)

```
┌──────────────────────────────────────────────────┐
│  [← 닫기]   나루토                    [편집] [⋯]  │  상단 바 (40px, --color-toolbar)
├──────────┬───────────────────────┬───────────────┤
│          │                       │               │
│  서지    │      큰 표지           │  권수·신간    │
│  정보    │      (2:3 비율)        │  정보         │
│          │                       │               │
│  작가    │                       │  보유: 12권   │
│  출판    │                       │  최신: 72권   │
│  장르    │                       │  미보유: 3    │
│  개요    │                       │  ───────────  │
│          │                       │  출간예정      │
│          │                       │  (다음 단계)   │
│          │                       │               │
├──────────┴───────────────────────┴───────────────┤
│  [1][2]    ┌──┐┌──┐┌──┐┌──┐┌──┐┌──┐            │  썸네일 그리드 (하단)
│  [3][4]    │  ││  ││  ││  ││  ││  │            │
│            └──┘└──┘└──┘└──┘└──┘└──┘            │
└──────────────────────────────────────────────────┘
```

### 좌측 서지 영역 (280px 고정)

- 작가, 출판년도, 장르, 개요를 compact property row로 (DESIGN.md Inspector 원칙)
- 개요는 11px muted, 3줄까지 보이고 "더 보기" 가능
- 값이 없으면 해당 행 숨김

### 중앙 표지

- 선택한 표지를 2:3 비율로 크게 표시
- 높이는 available height의 60%, 중앙 정렬
- 표지 교체 시 160ms cross-fade

### 우측 권수·신간 영역 (280px 고정)

- "보유 권수" — 편집 가능한 숫자 입력 (구판의 currentVolume)
- "최신 출간" — 알라딘 연동 후 표시, 지금은 "—" (다음 단계)
- "미보유" — 개수만 표시, 클릭 시 목록 펼침 (다음 단계)
- "출간예정" — 알라딘 연동 후 표시, 지금은 숨김

### 하단 썸네일 그리드

- 섹션 "표지 그리드"에서 정의한 책장 그리드
- 상단 본문 영역과 1px `--color-border` 분리선
- 높이: available height의 35%

## 컴포넌트 구조

### 새 파일

| 파일 | 설명 |
|---|---|
| `src/collections/CollectionOverlay.tsx` | 오버레이 메인. 전체 화면 덮개, 상단 바, 3컬럼 본문, 하단 그리드 통합 |
| `src/collections/CollectionCoverGrid.tsx` | 하단 썸네일 그리드 + 2x2 선반 버튼 |
| `src/collections/CollectionInfoPanel.tsx` | 좌측 서지 영역 (작가/년도/장르/개요 property row) |
| `src/collections/CollectionVolumePanel.tsx` | 우측 권수·신간 영역 (보유 권수 입력, 미보유, 출간예정) |

### 기존 파일 수정

| 파일 | 변경 |
|---|---|
| `App.tsx` | `view.kind === "collection"` 라우팅 추가 → `CollectionOverlay` 렌더 |
| `types.ts` | `CollectionSummary`에 `sourcePath` 추가, `CollectionCover` 타입 추가 |
| `client.ts` | `listCollectionCovers`, `getCollectionSourceRoot`, `setCollectionSourceRoot` 추가 |
| `CollectionCard.tsx` | 변경 없음 |
| `CollectionBrowser.tsx` | 변경 없음 (클릭 시 기존 라우팅 유지) |
| `SettingsView.tsx` | "컬렉션 소스 폴더" 선택 UI 추가 (망가 폴더와 동일 패턴) |

### 백엔드

| 파일 | 변경 |
|---|---|
| 마이그레이션 (`0012_*.sql`) | `library_settings.collection_source_root`, `collections.source_path` 추가 |
| `book_migration.rs` | 마이그레이션 시 상대 경로 저장 + 루트 설정 |
| `library/collection_source.rs` (신규) | covers/ 스캔, 이미지 서빙, 선반 분류 |
| `commands.rs` / `lib.rs` | 4개 명령 등록 |
| `models.rs` | `CollectionSummary`에 `source_path` 필드 추가 |

### 데이터 흐름

```
컬렉션 클릭 → App에서 CollectionOverlay 렌더
  → listCollectionCovers(collectionId) 호출
  → 백엔드: collection_source_root + source_path + /covers/ 스캔
  → 파일명에서 vol_N_M_ 파싱 → 선반 분류 + 자연 정렬
  → 표지 리스트 반환 → 그리드 렌더링
  → 썸네일 클릭 → 중앙 표지 교체 (cross-fade)
  → ESC/배경 클릭 → 오버레이 닫기
```

## 다음 단계 (별도 구현)

- 알라딘 TTB API 연동 — 신간 체크, 미보유 권 계산, 출간예정 표시
- 알라딘 TTB Key 설정 UI
- 권수 파싱 유틸리티 (`MangaVolumeParser` 포팅)
- 신간 알림 토글 + 백그라운드 모니터링