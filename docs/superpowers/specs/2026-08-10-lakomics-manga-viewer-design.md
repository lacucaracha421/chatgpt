# 망가 뷰어 설계

날짜: 2026-08-10

상태: 사용자 확인 완료 (그릴 세션 종료)

## 목적

라이브러리 밖에 있는 망가 컬렉션 폴더(망가 루트)를 앱에서 감상한다. 사이드바에 "망가" 탭을 만들고, 표지 그리드에서 시리즈를 고른 뒤 전체 화면 뷰어로 페이지를 넘겨 읽는다.

## 배경

- 사용자는 doujinshi 컬렉션을 외부 폴더(`C:\lakomics (2)\save`)에 보관한다.
- 컬렉션 구조: 시리즈 폴더 = `[작가] 제목 _ 한국어제목 (갤러리ID)\` 안에 페이지 이미지(webp 90%, avif 8%, 첫 페이지는 항상 webp) + `info.txt`(갤러리 넘버/제목/작가/그룹/타입/태그/언어).
- 규모: 수백 개 시리즈 × 평균 60페이지.
- 표지 = 첫 페이지 (별도 커버 파일 없음).

## 결정 사항

1. **외부 참조**: 망가 루트 폴더를 설정으로 저장하고 시리즈를 읽기 전용으로 참조한다 (ADR-0028). 파일을 복사하지 않는다.
2. **경로 식별**: 시리즈는 망가 루트 기준 **상대 경로**로 식별한다. 갤러리 ID는 메타데이터일 뿐 키가 아니다.
3. **표지 썸네일**: 첫 페이지에서 400px webp 썸네일을 생성해 루트 안 `.lakomics-thumbs/`에 캐시한다 (수백 개 원본 로드는 무거우므로).
4. **뷰어는 원본 서빙**: 페이지는 원본 파일을 그대로 서빙한다 (WebView2가 avif 포함 디코딩 가능).
5. **정렬**: 폴더 수정시간 최신순.
6. **루트 변경**: 설정 변경 시 확인 후 기존 레코드 삭제 + 재스캔.

## 아키텍처

### 데이터 모델 (마이그레이션 0005)

**`manga_series`** 테이블:

| 컬럼 | 타입 | 비고 |
|---|---|---|
| id | TEXT PK | uuid |
| relative_path | TEXT UNIQUE | 망가 루트 기준 상대 경로 |
| title | TEXT | info.txt 제목, 없으면 폴더명 파싱 |
| author | TEXT | info.txt 작가, 없으면 폴더명 파싱 |
| gallery_id | TEXT NULL | info.txt 갤러리 넘버 |
| page_count | INTEGER | 페이지 이미지 수 |
| thumbnail_relative_path | TEXT | `.lakomics-thumbs/` 내 경로 |
| scanned_at | TEXT | 스캔 시각 ISO |

**`library_settings`**에 `manga_root` 컬럼 추가 (기존 싱글톤 행).

### Rust 명령

| 명령 | 역할 |
|---|---|
| `get_manga_root` | 현재 망가 루트 조회 (null 가능) |
| `set_manga_root(path)` | 루트 설정 + 기존 레코드 삭제 |
| `scan_manga` | 루트 스캔: 폴더 열거 → info.txt/폴더명 파싱 → 썸네일 생성 → DB 갱신 (추가/삭제/변경) |
| `list_manga_series` | 시리즈 목록 (수정시간 최신순) |

스캔은 `spawn_blocking`으로 실행 (기존 ingest 패턴).

### 미디어 프로토콜 경로

`media_protocol.rs`에 추가:

- `/manga-cover/{seriesId}` — 썸네일 서빙
- `/manga-page/{seriesId}/{pageIndex}` — 원본 페이지 서빙 (pageIndex는 1-based, 파일명 숫자 순서)

해석 시 망가 루트 기준 canonicalize + 루트 밖 경로 거부 (기존 `UnsafeMediaPath` 패턴). `mime_for_path`에 avif 추가.

### 프론트엔드

- `AssetView` union에 `{ kind: "manga" }` 추가.
- 사이드바 빠른 보기에 "망가" 탭 추가 (북 아이콘).
- `App.tsx` 뷰 스위치에 `MangaBrowser` 분기.
- `LibraryGateway`에 4개 명령 추가 + `client.ts` invoke 래퍼.

**`MangaBrowser`** (신규, `app/src/manga/MangaBrowser.tsx`):
- 진입 시 `scan_manga` + `list_manga_series` (스켈레톤 + 완료 토스트).
- 루트 미설정: EmptyState + "망가 폴더 설정" 버튼 (폴더 선택 다이얼로그).
- 표지 그리드: 표지 + 제목 + 작가, 수정시간 최신순, 클릭 시 뷰어.

**`MangaViewer`** (신규, `app/src/manga/MangaViewer.tsx`):
- 전체 화면 오버레이. 헤더에 제목 + 진행률(3/60) + 닫기.
- ←/→ 키, 좌우 클릭 영역으로 페이지 넘김, Esc/닫기로 종료.
- 현재 + 다음 1페이지 사전 로드, 세로 높이 맞춤 표시.

### 그리드 구현

- 기존 `buildJustifiedRows` + `useVirtualizer` 재사용하되 타일은 새로 작성 (`MangaTile`).
- `AssetGallery`는 `AssetSummary`에 결합돼 있어 재사용하지 않음 (implementation.md 규칙: 두 번째 사용처 전에 공통화 금지).

## 데이터 흐름

1. 망가 탭 진입 → `scan_manga` (스캔) → `list_manga_series` → 그리드.
2. 표지 클릭 → `MangaViewer` 오픈 → `/manga-page/...` 로드.
3. 페이지 넘김 → 다음 페이지 사전 로드.

## 오류 처리

- 루트 미설정 → EmptyState + 설정 버튼.
- 루트 폴더 삭제/이동 → 스캔 실패 토스트 + 이전 목록 유지.
- 개별 페이지 404 → 뷰어에 "페이지를 불러오지 못했습니다" 표시, 이전/다음 이동 가능.

## 테스트

- `manga_series` 스캔 로직 단위 테스트 (임시 폴더에 시리즈 생성 → 스캔 → 메타데이터 검증).
- 경로 파싱 (info.txt 우선, 폴더명 폴백).
- 페이지 순서 정렬 (2자리/3자리 혼합).
- MangaBrowser: 미설정 EmptyState, 스캔 후 그리드 렌더.
- MangaViewer: 키보드/클릭 페이지 넘김, Esc 종료, 진행률 표시.
- 미디어 프로토콜: 루트 밖 경로 거부.

## 변경 파일

| 파일 | 작업 |
|---|---|
| `app/src-tauri/migrations/0005_manga.sql` | 신규 |
| `app/src-tauri/src/library/manga.rs` | 신규: 스캔/목록/루트 로직 |
| `app/src-tauri/src/library/mod.rs` | manga 모듈 연결, 루트 설정 |
| `app/src-tauri/src/library/db.rs` | SCHEMA_VERSION 5 |
| `app/src-tauri/src/library/error.rs` | Manga 오류 변형 |
| `app/src-tauri/src/commands.rs` | 4개 명령 |
| `app/src-tauri/src/lib.rs` | 명령 등록 |
| `app/src-tauri/src/media_protocol.rs` | manga 경로 2개 |
| `app/src/library/types.ts` | AssetView, Gateway, 타입 |
| `app/src/library/client.ts` | invoke 래퍼 |
| `app/src/classification/ClassificationSidebar.tsx` | 망가 탭 |
| `app/src/app/App.tsx` | 뷰 분기, drop 비활성 |
| `app/src/manga/MangaBrowser.tsx` | 신규 |
| `app/src/manga/MangaViewer.tsx` | 신규 |
| `app/src/settings/SettingsView.tsx` | 망가 폴더 설정 행 |
| 테스트 파일들 | 각 컴포넌트 |

## 제외 (YAGNI)

- 검색/필터 (수백 개 규모에 스크롤로 충분)
- 확대/축소
- 세로 연속 스크롤 모드
- 읽음/북마크 진행률 저장
- avif → webp 변환 (뷰어는 원본 서빙으로 충분)
