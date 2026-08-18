# 만화 표지 뷰어 — 컬렉션 오버레이 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 컬렉션 클릭 시 표지 갤러리 오버레이가 열리고, 서지 정보와 권수 현황을 표시하는 만화 표지 뷰어를 구현한다.

**Architecture:** `collections.source_path`(상대 경로) + `library_settings.collection_source_root`(구성 가능한 루트)로 표지 파일에 접근. 백엔드가 covers/ 디렉토리를 스캔하여 선반별 표지 목록을 반환하고, 미디어 프로토콜로 이미지를 서빙한다. 프론트엔드는 전체 화면 오버레이로 표지를 전시한다.

**Tech Stack:** Rust/Tauri(백엔드), React/TypeScript(프론트엔드), SQLite(데이터), CSS(tokens.css/global.css)

## Global Constraints

- DESIGN.md 준수: 타일 radius 0~2px, hover scale 금지, 장식용 gradient 금지, 80~160ms 애니메이션, accent는 selection/focus/drop target에만
- 절대 경로 하드코딩 금지 — `source_path`는 상대 경로만 저장
- `manga_root` 패턴과 동일한 아키텍처 (`library_settings` 컬럼 + get/set 명령)
- 토큰 사용: `--color-bg`, `--color-surface`, `--color-border`, `--color-accent`, `--space-*`, `--radius-tile` 등
- Windows 전용 (`compile_error!` already enforced)

---

## File Structure

### 백엔드 (Rust)

| 파일 | 책임 |
|---|---|
| `app/src-tauri/migrations/0012_collection_source.sql` (신규) | `library_settings.collection_source_root`, `collections.source_path` 스키마 추가 |
| `app/src-tauri/src/library/collection_source.rs` (신규) | covers/ 스캔, 선반 분류(`vol_N_M_`), 이미지 서빙, source_root get/set |
| `app/src-tauri/src/library/book_migration.rs` (수정) | 마이그레이션 시 상대 경로 저장 + 루트 설정 |
| `app/src-tauri/src/library/mod.rs` (수정) | `collection_source` 모듈 선언, `MediaVariant::CollectionCover` 추가, `resolve_media` 분기 |
| `app/src-tauri/src/library/models.rs` (수정) | `CollectionSummary`에 `source_path` 필드 추가, `CollectionCover` 구조체 추가 |
| `app/src-tauri/src/library/collection.rs` (수정) | `collection_from_row`에 `source_path` 매핑 추가, `COLLECTION_SUMMARY_SQL`에 `source_path` 컬럼 추가 |
| `app/src-tauri/src/library/error.rs` (수정) | `CollectionSourceRootNotSet`, `CollectionSourcePathNotSet` 에러 변형 추가 |
| `app/src-tauri/src/media_protocol.rs` (수정) | `collection-cover` 라우트 추가 |
| `app/src-tauri/src/commands.rs` (수정) | 4개 명령 추가: `get_collection_source_root`, `set_collection_source_root`, `list_collection_covers`, 커버 미디어는 프로토콜로 처리 |
| `app/src-tauri/src/lib.rs` (수정) | invoke_handler에 명령 등록 |

### 프론트엔드 (React/TS)

| 파일 | 책임 |
|---|---|
| `app/src/collections/CollectionOverlay.tsx` (신규) | 오버레이 메인 — 전체 화면 덮개, 상단 바, 3컬럼 본문, 하단 그리드 통합 |
| `app/src/collections/CollectionCoverGrid.tsx` (신규) | 하단 썸네일 그리드 + 2x2 선반 버튼 |
| `app/src/collections/CollectionInfoPanel.tsx` (신규) | 좌측 서지 영역 (작가/년도/장르/개요) |
| `app/src/collections/CollectionVolumePanel.tsx` (신규) | 우측 권수·신간 영역 (보유 권수 입력, 미보유) |
| `app/src/library/types.ts` (수정) | `CollectionSummary`에 `sourcePath` 추가, `CollectionCover` 타입 추가, Gateway 인터페이스에 메서드 추가 |
| `app/src/library/client.ts` (수정) | `listCollectionCovers`, `getCollectionSourceRoot`, `setCollectionSourceRoot` 추가 |
| `app/src/assets/mediaUrl.ts` (수정) | `collectionCoverUrl` 추가 |
| `app/src/app/App.tsx` (수정) | `view.kind === "collection"` 라우팅 → `CollectionOverlay` 렌더 |
| `app/src/settings/SettingsView.tsx` (수정) | "컬렉션 소스 폴더" 선택 UI 추가 |
| `app/src/styles/global.css` (수정) | 오버레이, 그리드, 패널, 선반 버튼 스타일 추가 |

---

### Task 1: 스키마 마이그레이션 — collection_source_root + source_path

**Files:**
- Create: `app/src-tauri/migrations/0012_collection_source.sql`
- Modify: `app/src-tauri/src/library/mod.rs` (db 모듈이 마이그레이션을 자동 실행하므로 추가 코드 불필요, 확인만)

**Interfaces:**
- Produces: `library_settings.collection_source_root TEXT` 컬럼, `collections.source_path TEXT` 컬럼

- [ ] **Step 1: 마이그레이션 파일 작성**

```sql
-- app/src-tauri/migrations/0012_collection_source.sql
ALTER TABLE library_settings ADD COLUMN collection_source_root TEXT;
ALTER TABLE collections ADD COLUMN source_path TEXT;

PRAGMA user_version = 12;
```

- [ ] **Step 2: 빌드 확인**

Run: `cd app/src-tauri && cargo check --message-format short`
Expected: 컴파일 성공 (마이그레이션은 db::open_database가 자동 실행)

- [ ] **Step 3: 기존 테스트 통과 확인**

Run: `cd app/src-tauri && cargo test --message-format short 2>&1 | findstr "test result"`
Expected: 모든 테스트 통과 (기존 collection_from_row가 source_path 컬럼을 아직 읽지 않으므로 영향 없음)

- [ ] **Step 4: 커밋**

```bash
git add app/src-tauri/migrations/0012_collection_source.sql
git commit -m "Add collection_source_root and source_path schema migration"
```

---

### Task 2: 에러 변형 추가

**Files:**
- Modify: `app/src-tauri/src/library/error.rs`

**Interfaces:**
- Produces: `LibraryError::CollectionSourceRootNotSet`, `LibraryError::CollectionSourcePathNotSet`

- [ ] **Step 1: 에러 변형 추가**

`error.rs`에서 `MangaRootNotSet` 변형 근처에 추가:

```rust
    #[error("컬렉션 소스 루트가 설정되지 않았습니다")]
    CollectionSourceRootNotSet,
    #[error("컬렉션에 소스 경로가 설정되지 않았습니다")]
    CollectionSourcePathNotSet,
```

`media_protocol.rs`의 에러 매치 패턴에도 추가해야 하므로, `media_protocol.rs`의 `match` 블록(`LibraryError::MediaNotFound | LibraryError::UnsafeMediaPath | LibraryError::MangaRootNotSet | LibraryError::MangaSeriesNotFound` 근처)에 새 변형들을 추가:

```rust
            | LibraryError::MediaNotFound
            | LibraryError::UnsafeMediaPath
            | LibraryError::MangaRootNotSet
            | LibraryError::MangaSeriesNotFound
            | LibraryError::CollectionSourceRootNotSet
            | LibraryError::CollectionSourcePathNotSet
```

- [ ] **Step 2: 빌드 확인**

Run: `cd app/src-tauri && cargo check --message-format short`
Expected: 컴파일 성공

- [ ] **Step 3: 커밋**

```bash
git add app/src-tauri/src/library/error.rs app/src-tauri/src/media_protocol.rs
git commit -m "Add collection source error variants"
```

---

### Task 3: CollectionSummary에 source_path 추가 + collection_from_row 수정

**Files:**
- Modify: `app/src-tauri/src/library/models.rs`
- Modify: `app/src-tauri/src/library/collection.rs`

**Interfaces:**
- Produces: `CollectionSummary.source_path: Option<String>` — 프론트엔드와 백엔드 양쪽에서 사용

- [ ] **Step 1: models.rs에 필드 추가**

`CollectionSummary` 구조체에 `source_path` 필드 추가 (`updated_at` 뒤):

```rust
    pub created_at: String,
    pub updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_path: Option<String>,
```

- [ ] **Step 2: COLLECTION_SUMMARY_SQL에 컬럼 추가**

`collection.rs`의 `COLLECTION_SUMMARY_SQL` 상수에 `collection.source_path`를 SELECT에 추가. 기존 SQL 끝의 `collection.updated_at` 뒤에 추가:

```rust
const COLLECTION_SUMMARY_SQL: &str = "SELECT
    collection.id,
    collection.name,
    collection.description,
    collection.type,
    COALESCE(
        CASE WHEN EXISTS (
            SELECT 1 FROM collection_assets AS explicit_link
            JOIN assets AS explicit_asset ON explicit_asset.id = explicit_link.asset_id
            WHERE explicit_link.collection_id = collection.id
              AND explicit_link.asset_id = collection.cover_asset_id
              AND explicit_asset.status = 'normal'
        ) THEN collection.cover_asset_id END,
        (
            SELECT fallback_link.asset_id
            FROM collection_assets AS fallback_link
            JOIN assets AS fallback_asset ON fallback_asset.id = fallback_link.asset_id
            WHERE fallback_link.collection_id = collection.id
              AND fallback_asset.status = 'normal'
            ORDER BY fallback_link.added_at, fallback_link.asset_id
            LIMIT 1
        )
    ),
    (
        SELECT COUNT(*)
        FROM collection_assets AS count_link
        JOIN assets AS count_asset ON count_asset.id = count_link.asset_id
        WHERE count_link.collection_id = collection.id
          AND count_asset.status = 'normal'
    ),
    collection.year,
    collection.author,
    collection.director,
    collection.external_score,
    collection.my_score,
    collection.genres,
    collection.overview,
    collection.external_id,
    collection.external_source,
    collection.external_synced_at,
    collection.showcase,
    collection.created_at,
    collection.updated_at,
    collection.source_path
FROM collections AS collection";
```

- [ ] **Step 3: collection_from_row에 매핑 추가**

`collection_from_row` 함수에서 `updated_at` (인덱스 18) 뒤에 `source_path` (인덱스 19) 매핑 추가:

```rust
    Ok(CollectionSummary {
        id: row.get(0)?,
        name: row.get(1)?,
        description: row.get(2)?,
        collection_type,
        cover_asset_id: row.get(4)?,
        asset_count: u64::try_from(row.get::<_, i64>(5)?).unwrap_or(0),
        year: row.get(6)?,
        author: row.get(7)?,
        director: row.get(8)?,
        external_score: row.get(9)?,
        my_score: row.get(10)?,
        genres: row.get(11)?,
        overview: row.get(12)?,
        external_id: row.get(13)?,
        external_source: row.get(14)?,
        external_synced_at: row.get(15)?,
        showcase: showcase_int != 0,
        created_at: row.get(17)?,
        updated_at: row.get(18)?,
        source_path: row.get(19)?,
    })
```

- [ ] **Step 4: 기존 테스트의 CollectionSummary 초기화 수정**

`collection.rs` 테스트 코드에서 `CollectionSummary`를 생성하는 모든 곳에 `source_path: None` 추가. `collection.rs`에서 `CollectionSummary` 리터럴을 찾아 각각에 추가. (`assert_eq` 비교에서도 source_path가 포함되므로 양쪽에 필요)

테스트에서 `assert_eq!(created, expected)` 패턴을 사용하는 경우, `expected` 구조체에도 `source_path: None` 추가.

`collection.rs`의 `tests` 모듈에서 `CollectionSummary`를 직접 생성하는 모든 곳을 검색하여 `source_path: None` 추가. 일반적으로 `created`/`updated` 변수와 비교하는 `assert_eq!` 문에서는 DB에서 읽은 값(source_path 포함)과 비교하므로, expected 리터럴에 source_path를 추가해야 함.

주요 위치:
- `collection.rs` 테스트에서 `CollectionSummary { ... }` 리터럴 — `source_path: None` 추가
- `assert_eq!` 비교문 — 양쪽 모두 DB 기반 값이므로 자동 포함됨 (직접 리터럴 생성 시에만 추가)

- [ ] **Step 5: 빌드 및 테스트 확인**

Run: `cd app/src-tauri && cargo test --message-format short 2>&1 | findstr "test result"`
Expected: 모든 테스트 통과

- [ ] **Step 6: 커밋**

```bash
git add app/src-tauri/src/library/models.rs app/src-tauri/src/library/collection.rs
git commit -m "Add source_path to CollectionSummary and collection_from_row"
```

---

### Task 4: collection_source.rs 모듈 — source_root get/set + covers 스캔

**Files:**
- Create: `app/src-tauri/src/library/collection_source.rs`
- Modify: `app/src-tauri/src/library/mod.rs`

**Interfaces:**
- Consumes: `LibraryError`, `Library` (connection, root)
- Produces:
  - `Library::collection_source_root() -> Result<Option<String>, LibraryError>`
  - `Library::set_collection_source_root(path: Option<&str>) -> Result<(), LibraryError>`
  - `Library::list_collection_covers(collection_id: &str) -> Result<Vec<CollectionCover>, LibraryError>`
  - `Library::collection_cover_media(collection_id: &str, file_name: &str) -> Result<MediaResponse, LibraryError>`
  - `CollectionCover { file_name, shelf, volume_label }` 구조체

- [ ] **Step 1: collection_source.rs 작성**

```rust
use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::OptionalExtension;
use serde::Serialize;

use super::error::LibraryError;
use super::manga::list_page_files;
use super::models::CollectionCover;
use super::{Library, MediaResponse};

const COVERS_DIR: &str = "covers";
const IMAGE_EXTENSIONS: &[&str] = &["jpg", "jpeg", "png", "webp", "bmp", "tiff", "jfif", "gif"];

pub(crate) fn collection_source_root(
    connection: &rusqlite::Connection,
) -> Result<Option<String>, LibraryError> {
    let value = connection
        .query_row(
            "SELECT collection_source_root FROM library_settings WHERE singleton = 1",
            [],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten();
    Ok(value)
}

pub(crate) fn set_collection_source_root(
    connection: &rusqlite::Connection,
    path: Option<&str>,
) -> Result<(), LibraryError> {
    connection.execute(
        "UPDATE library_settings SET collection_source_root = ?1 WHERE singleton = 1",
        [path],
    )?;
    if let Some(root) = path {
        let root_path = PathBuf::from(root);
        fs::create_dir_all(&root_path).map_err(|source| LibraryError::CreateDirectory {
            path: root_path.clone(),
            source,
        })?;
    }
    Ok(())
}

fn vol_regex() -> regex::Regex {
    regex::Regex::new(r"vol_([0-9.]+)_").unwrap()
}

fn classify_shelf(file_name: &str, regex: &regex::Regex) -> (u8, String) {
    let lower = file_name.to_lowercase();
    if let Some(caps) = regex.captures(&lower) {
        let ver = caps.get(1).map(|m| m.as_str()).unwrap_or("");
        let shelf = if ver.contains('.') {
            let decimal = ver.split('.').last().unwrap_or("");
            match decimal {
                "1" => 2,
                "2" => 3,
                _ => 4,
            }
        } else {
            1
        };
        let label = if ver.is_empty() { String::new() } else { format!("vol.{ver}") };
        (shelf, label)
    } else {
        (4, String::new())
    }
}

fn natural_compare(a: &str, b: &str) -> std::cmp::Ordering {
    let a_lower = a.to_lowercase();
    let b_lower = b.to_lowercase();
    natural_sort::natural_compare(&a_lower, &b_lower)
}

impl Library {
    pub fn collection_source_root(&self) -> Result<Option<String>, LibraryError> {
        let connection = self.connection()?;
        collection_source_root(&connection)
    }

    pub fn set_collection_source_root(&self, path: Option<&str>) -> Result<(), LibraryError> {
        let connection = self.connection()?;
        set_collection_source_root(&connection, path)
    }

    pub fn list_collection_covers(&self, collection_id: &str) -> Result<Vec<CollectionCover>, LibraryError> {
        let connection = self.connection()?;
        let root = collection_source_root(&connection)?
            .ok_or(LibraryError::CollectionSourceRootNotSet)?;
        let source_path: Option<String> = connection
            .query_row(
                "SELECT source_path FROM collections WHERE id = ?1",
                [collection_id],
                |row| row.get(0),
            )
            .optional()?
            .ok_or(LibraryError::CollectionNotFound)?;
        let source_path = source_path.ok_or(LibraryError::CollectionSourcePathNotSet)?;
        let covers_dir = Path::new(&root).join(&source_path).join(COVERS_DIR);
        if !covers_dir.is_dir() {
            return Ok(Vec::new());
        }
        let regex = vol_regex();
        let mut covers: Vec<CollectionCover> = fs::read_dir(&covers_dir)
            .map_err(|source| LibraryError::ReadMedia {
                path: covers_dir.clone(),
                source,
            })?
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.file_type().map(|ft| ft.is_file()).unwrap_or(false))
            .filter(|entry| {
                let name = entry.file_name().to_string_lossy().to_lowercase();
                IMAGE_EXTENSIONS.iter().any(|ext| name.ends_with(&format!(".{ext}")))
            })
            .map(|entry| {
                let file_name = entry.file_name().to_string_lossy().into_owned();
                let (shelf, volume_label) = classify_shelf(&file_name, &regex);
                CollectionCover {
                    file_name,
                    shelf,
                    volume_label,
                }
            })
            .collect();
        covers.sort_by(|a, b| {
            let shelf_cmp = a.shelf.cmp(&b.shelf);
            if shelf_cmp != std::cmp::Ordering::Equal {
                return shelf_cmp;
            }
            natural_compare(&a.file_name, &b.file_name)
        });
        Ok(covers)
    }

    pub fn collection_cover_media(
        &self,
        collection_id: &str,
        file_name: &str,
    ) -> Result<MediaResponse, LibraryError> {
        let connection = self.connection()?;
        let root = collection_source_root(&connection)?
            .ok_or(LibraryError::CollectionSourceRootNotSet)?;
        let source_path: Option<String> = connection
            .query_row(
                "SELECT source_path FROM collections WHERE id = ?1",
                [collection_id],
                |row| row.get(0),
            )
            .optional()?
            .ok_or(LibraryError::CollectionNotFound)?;
        let source_path = source_path.ok_or(LibraryError::CollectionSourcePathNotSet)?;
        let source_root = Path::new(&root);
        let file_path = source_root.join(&source_path).join(COVERS_DIR).join(file_name);
        self.open_manga_media(source_root, file_path)
    }
}
```

**참고:** `natural_sort` 크레이트가 `Cargo.toml`에 있는지 확인. 없으면 `natural_compare` 대신 간단한 토큰 기반 비교 구현. `list_page_files`는 이미 존재하는 유틸리티이므로 import에서 제거 가능 (사용하지 않으면).

- [ ] **Step 2: models.rs에 CollectionCover 구조체 추가**

`models.rs`에 `CollectionCover` 구조체 추가 (`CollectionSummary` 뒤):

```rust
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionCover {
    pub file_name: String,
    pub shelf: u8,
    pub volume_label: String,
}
```

- [ ] **Step 3: mod.rs에 모듈 선언 추가**

`mod.rs`의 모듈 선언부에 `collection_source` 추가:

```rust
mod collection_source;
```

`pub mod`가 아닌 `mod`로 선언 (Library impl을 통해 노출).

`MediaResponse`가 `mod.rs`에 정의되어 있으므로 `use super::{Library, MediaResponse}`로 접근 가능.

- [ ] **Step 4: natural_sort 크레이트 확인**

`Cargo.toml`에서 `natural_sort` 또는 유사 크레이트 확인. 없으면 `natural_compare` 함수를 직접 구현:

```rust
fn natural_compare(a: &str, b: &str) -> std::cmp::Ordering {
    // 간단한 자연 정렬: 숫자 부분을 수치로 비교
    let mut a_chars = a.chars().peekable();
    let mut b_chars = b.chars().peekable();
    loop {
        match (a_chars.peek(), b_chars.peek()) {
            (None, None) => return std::cmp::Ordering::Equal,
            (None, _) => return std::cmp::Ordering::Less,
            (_, None) => return std::cmp::Ordering::Greater,
            (Some(&ac), Some(&bc)) => {
                if ac.is_ascii_digit() && bc.is_ascii_digit() {
                    let a_num: String = a_chars.by_ref().take_while(|c| c.is_ascii_digit()).collect();
                    let b_num: String = b_chars.by_ref().take_while(|c| c.is_ascii_digit()).collect();
                    let a_val: u64 = a_num.parse().unwrap_or(0);
                    let b_val: u64 = b_num.parse().unwrap_or(0);
                    match a_val.cmp(&b_val) {
                        std::cmp::Ordering::Equal => continue,
                        ord => return ord,
                    }
                } else {
                    match ac.cmp(&bc) {
                        std::cmp::Ordering::Equal => {
                            a_chars.next();
                            b_chars.next();
                        }
                        ord => return ord,
                    }
                }
            }
        }
    }
}
```

이 경우 `collection_source.rs`에서 `natural_compare` 로컬 함수를 사용하고 `natural_sort` import 제거.

- [ ] **Step 5: open_manga_media 가시성 확인**

`mod.rs`의 `open_manga_media`가 `fn`(private)으로 선언되어 있으므로 `pub(crate)`로 변경:

```rust
    pub(crate) fn open_manga_media(
```

- [ ] **Step 6: 단위 테스트 작성**

`collection_source.rs` 끝에 테스트 모듈 추가:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_integer_volume_to_shelf_1() {
        let regex = vol_regex();
        let (shelf, label) = classify_shelf("vol_1_001.webp", &regex);
        assert_eq!(shelf, 1);
        assert_eq!(label, "vol.1");
    }

    #[test]
    fn classifies_decimal_1_to_shelf_2() {
        let regex = vol_regex();
        let (shelf, label) = classify_shelf("vol_1.1_001.webp", &regex);
        assert_eq!(shelf, 2);
        assert_eq!(label, "vol.1.1");
    }

    #[test]
    fn classifies_decimal_2_to_shelf_3() {
        let regex = vol_regex();
        let (shelf, label) = classify_shelf("vol_1.2_001.webp", &regex);
        assert_eq!(shelf, 3);
        assert_eq!(label, "vol.1.2");
    }

    #[test]
    fn classifies_no_version_to_shelf_4() {
        let regex = vol_regex();
        let (shelf, label) = classify_shelf("thumbnail.webp", &regex);
        assert_eq!(shelf, 4);
        assert_eq!(label, "");
    }

    #[test]
    fn natural_compare_sorts_numbers_correctly() {
        let mut items = vec!["vol_10_", "vol_2_", "vol_1_"];
        items.sort_by(|a, b| natural_compare(a, b));
        assert_eq!(items, vec!["vol_1_", "vol_2_", "vol_10_"]);
    }
}
```

- [ ] **Step 7: 빌드 및 테스트 확인**

Run: `cd app/src-tauri && cargo test --message-format short collection_source 2>&1 | findstr "test result"`
Expected: 5개 테스트 통과

- [ ] **Step 8: 커밋**

```bash
git add app/src-tauri/src/library/collection_source.rs app/src-tauri/src/library/models.rs app/src-tauri/src/library/mod.rs
git commit -m "Add collection_source module for cover scanning and media serving"
```

---

### Task 5: MediaVariant::CollectionCover 추가 + 미디어 프로토콜 라우트

**Files:**
- Modify: `app/src-tauri/src/library/mod.rs`
- Modify: `app/src-tauri/src/media_protocol.rs`

**Interfaces:**
- Consumes: `Library::collection_cover_media`
- Produces: `MediaVariant::CollectionCover(String)` — file_name을 들고 다님
- Produces: 미디어 프로토콜 라우트 `collection-cover/{collection_id}/{file_name}`

- [ ] **Step 1: MediaVariant에 CollectionCover 추가**

`mod.rs`의 `MediaVariant` enum에 추가:

```rust
#[derive(Debug, Clone, Copy)]
pub enum MediaVariant {
    Asset,
    Thumbnail,
    Playback,
    ScrubFrame(u32),
    MangaCover,
    MangaPage(u32),
    CollectionCover,
}
```

**참고:** `CollectionCover`는 file_name을 별도로 전달해야 하므로, `resolve_media` 시그니처 변경 대신 프로토콜에서 직접 `collection_cover_media`를 호출하는 방식으로 처리. `MediaVariant::CollectionCover`는 프로토콜 매칭용으로만 사용하고, `resolve_media`에서는 `unreachable!()`로 처리.

- [ ] **Step 2: resolve_media에 CollectionCover 분기 추가**

`mod.rs`의 `resolve_media` 함수에서 `MangaCover | MangaPage` 분기 근처에 추가:

```rust
            MediaVariant::MangaCover | MediaVariant::MangaPage(_) | MediaVariant::CollectionCover => unreachable!(),
```

기존 `MediaVariant::MangaCover | MediaVariant::MangaPage(_) => unreachable!()` 라인을 위와 같이 수정.

- [ ] **Step 3: media_protocol.rs에 라우트 추가**

`media_protocol.rs`의 `parse_path` 함수를 수정하여 `collection-cover` 라우트를 처리. 기존 `parse_path`는 `(MediaVariant, String)`을 반환하지만, `CollectionCover`는 file_name이 추가로 필요하므로 반환 타입을 변경해야 함.

`parse_path` 반환 타입을 `Option<(MediaVariant, String, Option<String>)>`로 변경 (세 번째 값은 file_name):

```rust
fn parse_path(path: &str) -> Option<(MediaVariant, String, Option<String>)> {
    let mut segments = path.strip_prefix('/')?.split('/');
    let route = segments.next()?;
    let asset_id = percent_decode(segments.next()?)?;
    if uuid::Uuid::parse_str(&asset_id).is_err() {
        return None;
    }
    let (variant, file_name) = match route {
        "asset" if segments.next().is_none() => (MediaVariant::Asset, None),
        "thumbnail" if segments.next().is_none() => (MediaVariant::Thumbnail, None),
        "playback" if segments.next().is_none() => (MediaVariant::Playback, None),
        "manga-cover" if segments.next().is_none() => (MediaVariant::MangaCover, None),
        "manga-page" => {
            let page_index = segments.next()?.parse::<u32>().ok()?;
            if segments.next().is_some() {
                return None;
            }
            (MediaVariant::MangaPage(page_index), None)
        }
        "collection-cover" => {
            let file_name = percent_decode(segments.next()?)?;
            if segments.next().is_some() {
                return None;
            }
            (MediaVariant::CollectionCover, Some(file_name))
        }
        "scrub-frame" => {
            let frame_index = segments.next()?.parse::<u32>().ok()?;
            if segments.next().is_some() {
                return None;
            }
            (MediaVariant::ScrubFrame(frame_index), None)
        }
        _ => return None,
    };
    Some((variant, asset_id, file_name))
}
```

- [ ] **Step 4: media_response_with_range에서 CollectionCover 처리**

`media_protocol.rs`의 `media_response_with_range` 함수에서 `parse_path` 호출부와 `resolve_media` 호출부 수정:

```rust
pub(crate) fn media_response_with_range(
    library: Option<&Library>,
    method: &Method,
    path: &str,
    range_header: Option<&str>,
) -> Response<Vec<u8>> {
    if method != Method::GET {
        return method_not_allowed();
    }
    let Some((variant, asset_id, file_name)) = parse_path(path) else {
        return not_found();
    };
    let Some(library) = library else {
        return service_unavailable();
    };
    match variant {
        MediaVariant::CollectionCover => {
            let file_name = file_name.unwrap_or_default();
            match library.collection_cover_media(&asset_id, &file_name) {
                Ok(media) => {
                    // CollectionCover는 Range를 지원하지 않고 전체 파일을 반환
                    let mut bytes = Vec::new();
                    if media.file.read_to_end(&mut bytes).is_err() {
                        return internal_server_error();
                    }
                    Response::builder()
                        .status(StatusCode::OK)
                        .header(CONTENT_TYPE, media.mime)
                        .header(CONTENT_LENGTH, media.length.to_string())
                        .body(bytes)
                        .expect("static media response is valid")
                }
                Err(
                    LibraryError::MediaNotFound
                    | LibraryError::UnsafeMediaPath
                    | LibraryError::MangaRootNotSet
                    | LibraryError::MangaSeriesNotFound
                    | LibraryError::CollectionSourceRootNotSet
                    | LibraryError::CollectionSourcePathNotSet
                    | LibraryError::CollectionNotFound,
                ) => not_found(),
                Err(_) => internal_server_error(),
            }
        }
        _ => {
            match library.resolve_media(&asset_id, variant) {
                Ok(media) if matches!(variant, MediaVariant::Playback) => {
                    playback_response(media, range_header)
                }
                Ok(mut media) => {
                    let mut bytes = Vec::new();
                    if media.file.read_to_end(&mut bytes).is_err() {
                        return internal_server_error();
                    }
                    Response::builder()
                        .status(StatusCode::OK)
                        .header(CONTENT_TYPE, media.mime)
                        .header(CONTENT_LENGTH, media.length.to_string())
                        .body(bytes)
                        .expect("static media response is valid")
                }
                Err(
                    LibraryError::MediaNotFound
                    | LibraryError::UnsafeMediaPath
                    | LibraryError::MangaRootNotSet
                    | LibraryError::MangaSeriesNotFound
                    | LibraryError::CollectionSourceRootNotSet
                    | LibraryError::CollectionSourcePathNotSet
                    | LibraryError::CollectionNotFound,
                ) => not_found(),
                Err(_) => internal_server_error(),
            }
        }
    }
}
```

- [ ] **Step 5: media_protocol.rs 테스트의 parse_path 호출부 수정**

`media_protocol.rs` 테스트에서 `parse_path`를 호출하는 모든 곳의 반환값 언박싱 수정 (세 번째 값 추가):

기존 테스트에서 `parse_path`를 직접 호출하는 경우, 패턴 매칭을 `let (variant, id, _) = parse_path(...).unwrap()`로 수정.

`media_response` 호출은 변경 없음 (내부적으로 parse_path 사용).

- [ ] **Step 6: 빌드 및 테스트 확인**

Run: `cd app/src-tauri && cargo test --message-format short 2>&1 | findstr "test result"`
Expected: 모든 테스트 통과

- [ ] **Step 7: 커밋**

```bash
git add app/src-tauri/src/library/mod.rs app/src-tauri/src/media_protocol.rs
git commit -m "Add CollectionCover media variant and protocol route"
```

---

### Task 6: Tauri 명령 등록 — source_root get/set + list_collection_covers

**Files:**
- Modify: `app/src-tauri/src/commands.rs`
- Modify: `app/src-tauri/src/lib.rs`

**Interfaces:**
- Produces: `get_collection_source_root`, `set_collection_source_root`, `list_collection_covers` Tauri 명령

- [ ] **Step 1: commands.rs에 명령 추가**

`commands.rs`의 `list_manga_series` 명령 근처에 추가. import에 `CollectionCover` 추가:

```rust
use crate::library::{
    book_migration::{BookImportPlan, BookMigrationReport},
    collection_source,
    error::LibraryError,
    metadata_import::{self, MetadataImportPlan},
    models::{
        AlbumEntry, AssetAlbumPatch, AssetCollectionPatch, AssetCursor, AssetMetadataPatch,
        AssetPage, AssetQuery, AssetSummary, ClassificationEntry, CollectionCover,
        CollectionSummary, CreateAlbum, CreateClassification, CreateCollection,
        IngestMediaRequest, IngestOutcome, LibrarySummary, MangaSeries, MetadataBackup,
        PurgeSummary, SetAssetClassification, SimilarityDecisionRequest, SimilarityIndexProgress,
        SimilarityReviewPage, TrashPage, TrashPolicy, UpdateCollection, VideoPreparationProgress,
    },
    Library,
};
```

명령 함수 추가 (`import_book_collections` 뒤):

```rust
#[tauri::command]
pub fn get_collection_source_root(
    state: State<'_, AppState>,
) -> Result<Option<String>, CommandError> {
    let library = current_required(state)?;
    library
        .collection_source_root()
        .map_err(CommandError::from)
}

#[tauri::command]
pub fn set_collection_source_root(
    path: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    let library = current_required(state)?;
    library
        .set_collection_source_root(path.as_deref())
        .map_err(CommandError::from)
}

#[tauri::command]
pub fn list_collection_covers(
    collection_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<CollectionCover>, CommandError> {
    let library = current_required(state)?;
    library
        .list_collection_covers(&collection_id)
        .map_err(CommandError::from)
}
```

- [ ] **Step 2: lib.rs invoke_handler에 등록**

`lib.rs`의 `generate_handler!` 매크로에 추가 (`import_book_collections` 뒤):

```rust
            commands::import_book_collections,
            commands::get_collection_source_root,
            commands::set_collection_source_root,
            commands::list_collection_covers,
```

- [ ] **Step 3: 빌드 확인**

Run: `cd app/src-tauri && cargo check --message-format short`
Expected: 컴파일 성공

- [ ] **Step 4: 커밋**

```bash
git add app/src-tauri/src/commands.rs app/src-tauri/src/lib.rs
git commit -m "Add Tauri commands for collection source root and cover listing"
```

---

### Task 7: book_migration.rs 수정 — 상대 경로 저장 + 루트 설정

**Files:**
- Modify: `app/src-tauri/src/library/book_migration.rs`

**Interfaces:**
- Consumes: `collection_source::set_collection_source_root`
- Produces: 마이그레이션 시 `source_path` 컬럼에 상대 경로 저장, `collection_source_root` 설정

- [ ] **Step 1: import_book_collections에서 source_path 저장 + 루트 설정**

`book_migration.rs`의 `inspect_book_import`에서 `BookImportEntry`에 `relative_path` 필드를 추가하고, `import_book_collections`에서 INSERT 시 `source_path`에 저장 + `collection_source_root` 설정.

`BookImportEntry` 구조체에 필드 추가:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookImportEntry {
    pub folder: String,
    pub relative_path: String,
    pub collection_type: CollectionType,
    pub name: String,
    pub year: Option<i64>,
    pub author: Option<String>,
    pub director: Option<String>,
    pub my_score: Option<i64>,
    pub genres: Option<String>,
    pub overview: Option<String>,
    pub external_id: Option<String>,
    pub external_source: Option<String>,
}
```

`inspect_book_import`에서 entry 생성 시 `relative_path` 설정:

```rust
                    entries.push(BookImportEntry {
                        folder: folder_name.clone(),
                        relative_path: relative_path_for(&root_path, &entry.path()),
                        collection_type: parsed.collection_type,
                        name: parsed.name,
                        year: parsed.year,
                        author: parsed.author,
                        director: parsed.director,
                        my_score: parsed.my_score,
                        genres: parsed.genres,
                        overview: parsed.overview,
                        external_id: parsed.external_id,
                        external_source: parsed.external_source,
                    });
```

`relative_path_for` 헬퍼 함수 추가:

```rust
fn relative_path_for(root: &Path, folder: &Path) -> String {
    folder
        .strip_prefix(root)
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| folder.to_string_lossy().into_owned())
}
```

`import_book_collections`에서 `collection_source_root` 설정 + INSERT에 `source_path` 추가:

```rust
    pub fn import_book_collections(&self, root: &str) -> Result<BookMigrationReport, LibraryError> {
        let plan = self.inspect_book_import(root)?;
        let connection = self.connection()?;
        // Set collection_source_root
        set_collection_source_root(&connection, Some(root))?;
        let mut report = BookMigrationReport {
            scanned: plan.entries.len() as u64 + plan.skipped.len() as u64,
            created: 0,
            updated: 0,
            skipped: plan.skipped.len() as u64,
            errors: plan.skipped,
        };
        for entry in plan.entries {
            match upsert_collection(&connection, &entry) {
                Ok(true) => report.created += 1,
                Ok(false) => report.updated += 1,
                Err(message) => report.errors.push(BookMigrationError {
                    folder: entry.folder,
                    message,
                }),
            }
        }
        Ok(report)
    }
```

`upsert_collection`의 INSERT SQL에 `source_path` 추가:

```rust
fn upsert_collection(
    connection: &rusqlite::Connection,
    entry: &BookImportEntry,
) -> Result<bool, String> {
    let name = normalized_name(entry.name.clone()).map_err(|e| e.to_string())?;
    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();
    let type_str = collection_type_str(entry.collection_type);
    let external_synced_at: Option<String> = if entry.external_id.is_some() {
        Some(now.clone())
    } else {
        None
    };
    connection
        .execute(
            "INSERT INTO collections (
                id, name, description, type, cover_asset_id,
                year, author, director, external_score, my_score,
                genres, overview, external_id, external_source, external_synced_at,
                showcase, external_metadata_json, created_at, updated_at, source_path
             ) VALUES (?1, ?2, NULL, ?3, NULL,
                ?4, ?5, ?6, NULL, ?7,
                ?8, ?9, ?10, ?11, ?12,
                0, NULL, ?13, ?13, ?14)",
            params![
                id,
                name,
                type_str,
                entry.year,
                entry.author,
                entry.director,
                entry.my_score,
                entry.genres,
                entry.overview,
                entry.external_id,
                entry.external_source,
                external_synced_at,
                now,
                entry.relative_path
            ],
        )
        .map_err(|e| map_duplicate_name_err(e, &entry.name))?;
    let _ = collection_by_id(connection, &id).map_err(|e| e.to_string())?;
    Ok(true)
}
```

import에 `set_collection_source_root` 추가:

```rust
use super::collection::{collection_by_id, collection_type_str, normalized_name};
use super::collection_source::set_collection_source_root;
use super::error::LibraryError;
use super::models::CollectionType;
use super::Library;
```

- [ ] **Step 2: 빌드 및 테스트 확인**

Run: `cd app/src-tauri && cargo test --message-format short 2>&1 | findstr "test result"`
Expected: 모든 테스트 통과

- [ ] **Step 3: 커밋**

```bash
git add app/src-tauri/src/library/book_migration.rs
git commit -m "Store relative source_path and set collection_source_root during migration"
```

---

### Task 8: 프론트엔드 타입 + gateway client + mediaUrl

**Files:**
- Modify: `app/src/library/types.ts`
- Modify: `app/src/library/client.ts`
- Modify: `app/src/assets/mediaUrl.ts`

**Interfaces:**
- Produces: `CollectionSummary.sourcePath`, `CollectionCover` 타입, Gateway 메서드 3개, `collectionCoverUrl` 함수

- [ ] **Step 1: types.ts에 타입 추가**

`CollectionSummary`에 `sourcePath` 추가:

```typescript
export type CollectionSummary = {
  id: string;
  name: string;
  description: string | null;
  type: CollectionType;
  coverAssetId: string | null;
  assetCount: number;
  year: number | null;
  author: string | null;
  director: string | null;
  externalScore: number | null;
  myScore: number | null;
  genres: string | null;
  overview: string | null;
  externalId: string | null;
  externalSource: string | null;
  externalSyncedAt: string | null;
  showcase: boolean;
  createdAt: string;
  updatedAt: string;
  sourcePath?: string | null;
};
```

`CollectionCover` 타입 추가 (파일 끝, `BookMigrationReport` 뒤):

```typescript
export type CollectionCover = {
  fileName: string;
  shelf: number;
  volumeLabel: string;
};
```

`LibraryGateway` 인터페이스에 메서드 추가 (`importBookCollections` 뒤):

```typescript
  importBookCollections(root: string): Promise<BookMigrationReport>;
  getCollectionSourceRoot(): Promise<string | null>;
  setCollectionSourceRoot(path: string | null): Promise<void>;
  listCollectionCovers(collectionId: string): Promise<CollectionCover[]>;
```

- [ ] **Step 2: client.ts에 구현 추가**

import에 `CollectionCover` 추가:

```typescript
import type {
  AlbumEntry,
  AssetAlbumPatch,
  AssetCollectionPatch,
  AssetMetadataPatch,
  AssetPage,
  AssetQuery,
  AssetSummary,
  ClassificationEntry,
  CollectionCover,
  CollectionSummary,
  ...
```

구현 추가 (`importBookCollections` 뒤):

```typescript
  importBookCollections: (root) => invoke<BookMigrationReport>("import_book_collections", { root }),
  getCollectionSourceRoot: () => invoke<string | null>("get_collection_source_root"),
  setCollectionSourceRoot: (path) => invoke("set_collection_source_root", { path }),
  listCollectionCovers: (collectionId) => invoke<CollectionCover[]>("list_collection_covers", { collectionId }),
```

- [ ] **Step 3: mediaUrl.ts에 collectionCoverUrl 추가**

```typescript
export function collectionCoverUrl(collectionId: string, fileName: string): string {
  return `${MEDIA_ORIGIN}/collection-cover/${encodeURIComponent(collectionId)}/${encodeURIComponent(fileName)}`;
}
```

- [ ] **Step 4: 타입체크 확인**

Run: `cd app && npx tsc --noEmit`
Expected: 에러 없음 (테스트 mock에 새 메서드 추가 필요할 수 있음)

- [ ] **Step 5: 테스트 mock에 새 메서드 추가**

모든 `*.test.tsx`에서 `retryVideoPreparation: vi.fn()` 패턴에 이어 새 메서드 추가. 이전과 동일한 node 스크립트 패턴 사용:

```bash
cd app/src && node -e "const fs=require('fs');const path=require('path');const files=['app/App.test.tsx','assets/AssetBrowser.test.tsx','classification/ClassificationSidebar.test.tsx','collections/CollectionBrowser.test.tsx','library/LibraryContext.test.tsx','library/LibrarySetup.test.tsx','manga/MangaBrowser.test.tsx','safety/TrashBrowser.test.tsx','settings/SettingsView.test.tsx','similarity/SimilarityReviewBrowser.test.tsx'];for(const f of files){const p=path.join(process.cwd(),f);let c=fs.readFileSync(p,'utf8');if(c.includes('listCollectionCovers')){console.log('skip',f);continue;}const m=c.match(/importBookCollections:\s*vi\.fn\(\)/);if(!m){console.log('no match',f);continue;}const repl=m[0]+', getCollectionSourceRoot: vi.fn(), setCollectionSourceRoot: vi.fn(), listCollectionCovers: vi.fn()';c=c.replace(m[0],repl);fs.writeFileSync(p,c,'utf8');console.log('patched',f);}"
```

- [ ] **Step 6: 타입체크 + 테스트 확인**

Run: `cd app && npx tsc --noEmit && npx vitest run --reporter=dot 2>&1 | tail -5`
Expected: 에러 없음, 모든 테스트 통과

- [ ] **Step 7: 커밋**

```bash
git add app/src/library/types.ts app/src/library/client.ts app/src/assets/mediaUrl.ts
git add app/src/**/*.test.tsx
git commit -m "Add frontend types, gateway methods, and mediaUrl for collection covers"
```

---

### Task 9: App.tsx 라우팅 — collection 뷰 → CollectionOverlay

**Files:**
- Modify: `app/src/app/App.tsx`

**Interfaces:**
- Consumes: `CollectionOverlay` 컴포넌트 (Task 10에서 생성), `view.kind === "collection"` (이미 타입에 존재)
- Produces: 컬렉션 클릭 시 오버레이 렌더

- [ ] **Step 1: CollectionOverlay import 추가**

`App.tsx` 상단의 import부에 추가:

```typescript
import { CollectionOverlay } from "../collections/CollectionOverlay";
```

- [ ] **Step 2: collection 라우팅 추가**

`App.tsx`의 뷰 라우팅에서 `view.kind === "collections"` 분기 앞에 `collection` (단수) 분기 추가:

```tsx
                ) : view.kind === "collection" ? (
                  <CollectionOverlay
                    collectionId={view.collectionId}
                    collections={collections}
                    onExit={() => setView({ kind: "collections", typeFilter: null, showcase: false })}
                    onChanged={refreshCollections}
                  />
                ) : view.kind === "collections" ? (
```

- [ ] **Step 3: 타입체크 확인 (CollectionOverlay가 아직 없으므로 에러 예상)**

Run: `cd app && npx tsc --noEmit 2>&1 | head -5`
Expected: `CollectionOverlay` 모듈을 찾을 수 없다는 에러 (Task 10에서 해결)

- [ ] **Step 4: 커밋 (Task 10과 함께 커밋)**

이 단계는 Task 10 완성 후 함께 커밋.

---

### Task 10: CollectionOverlay + 하위 컴포넌트 + 스타일

**Files:**
- Create: `app/src/collections/CollectionOverlay.tsx`
- Create: `app/src/collections/CollectionCoverGrid.tsx`
- Create: `app/src/collections/CollectionInfoPanel.tsx`
- Create: `app/src/collections/CollectionVolumePanel.tsx`
- Modify: `app/src/styles/global.css`

**Interfaces:**
- Consumes: `CollectionSummary`, `CollectionCover`, `collectionCoverUrl`, `useLibrary`, `listCollectionCovers`
- Produces: 전체 화면 오버레이 뷰

- [ ] **Step 1: CollectionInfoPanel.tsx 작성**

```tsx
import type { CollectionSummary } from "../library/types";

export function CollectionInfoPanel({ collection }: { collection: CollectionSummary }) {
  const rows: Array<[string, string | null]> = [
    ["작가", collection.author],
    ["출판", collection.year ? String(collection.year) : null],
    ["감독", collection.director],
    ["장르", collection.genres],
  ];
  return (
    <aside className="collection-overlay__info">
      <dl className="collection-overlay__info-rows">
        {rows
          .filter(([, value]) => value != null && value !== "")
          .map(([label, value]) => (
            <div key={label} className="collection-overlay__info-row">
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
      </dl>
      {collection.overview && (
        <div className="collection-overlay__overview">
          <p>{collection.overview}</p>
        </div>
      )}
    </aside>
  );
}
```

- [ ] **Step 2: CollectionVolumePanel.tsx 작성**

```tsx
import { useState } from "react";
import type { CollectionSummary } from "../library/types";

export function CollectionVolumePanel({
  collection,
  coverCount,
}: {
  collection: CollectionSummary;
  coverCount: number;
}) {
  const [volume, setVolume] = useState<string>("");
  return (
    <aside className="collection-overlay__volume">
      <div className="collection-overlay__volume-row">
        <span className="collection-overlay__volume-label">표지</span>
        <span className="collection-overlay__volume-value">{coverCount}장</span>
      </div>
      <div className="collection-overlay__volume-row">
        <span className="collection-overlay__volume-label">보유 권수</span>
        <input
          className="collection-overlay__volume-input"
          type="number"
          min={0}
          value={volume}
          placeholder="—"
          onChange={(e) => setVolume(e.target.value)}
        />
      </div>
    </aside>
  );
}
```

- [ ] **Step 3: CollectionCoverGrid.tsx 작성**

```tsx
import { collectionCoverUrl } from "../assets/mediaUrl";
import type { CollectionCover } from "../library/types";

const SHELF_LABELS = ["1", "2", "3", "4"] as const;

export function CollectionCoverGrid({
  collectionId,
  covers,
  selectedFileName,
  onSelect,
}: {
  collectionId: string;
  covers: CollectionCover[];
  selectedFileName: string | null;
  onSelect: (fileName: string) => void;
}) {
  const [selectedShelf, setSelectedShelf] = useState<number | null>(null);
  const filtered = selectedShelf != null ? covers.filter((c) => c.shelf === selectedShelf) : covers;
  return (
    <div className="collection-overlay__grid-area">
      <div className="collection-overlay__shelves">
        {SHELF_LABELS.map((label, i) => {
          const shelf = i + 1;
          return (
            <button
              key={shelf}
              type="button"
              className="collection-overlay__shelf-button"
              aria-pressed={selectedShelf === shelf}
              onClick={() => setSelectedShelf(selectedShelf === shelf ? null : shelf)}
            >
              {label}
            </button>
          );
        })}
      </div>
      <div className="collection-overlay__cover-grid">
        {filtered.map((cover) => (
          <button
            key={cover.fileName}
            type="button"
            className="collection-overlay__cover-tile"
            aria-pressed={selectedFileName === cover.fileName}
            onClick={() => onSelect(cover.fileName)}
          >
            <img
              src={collectionCoverUrl(collectionId, cover.fileName)}
              alt={cover.volumeLabel || cover.fileName}
              loading="lazy"
              draggable={false}
            />
            {cover.volumeLabel && (
              <span className="collection-overlay__cover-label">{cover.volumeLabel}</span>
            )}
          </button>
        ))}
        {filtered.length === 0 && (
          <span className="collection-overlay__cover-empty">이 선반에 표지가 없습니다</span>
        )}
      </div>
    </div>
  );
}
```

**참고:** `useState` import 필요: `import { useState } from "react";`

- [ ] **Step 4: CollectionOverlay.tsx 작성**

```tsx
import { useEffect, useState } from "react";
import { collectionCoverUrl } from "../assets/mediaUrl";
import { useLibrary } from "../library/LibraryContext";
import { commandErrorMessage } from "../library/errorMessage";
import type { CollectionCover, CollectionSummary } from "../library/types";
import { ViewToolbar } from "../layout/ViewToolbar";
import { Button } from "../shared/ui/Button";
import { Skeleton } from "../shared/ui/Skeleton";
import { Toast } from "../shared/ui/Toast";
import { useAutoDismiss } from "../shared/ui/useAutoDismiss";
import { CollectionCoverGrid } from "./CollectionCoverGrid";
import { CollectionInfoPanel } from "./CollectionInfoPanel";
import { CollectionVolumePanel } from "./CollectionVolumePanel";

type CollectionOverlayProps = {
  collectionId: string;
  collections: CollectionSummary[];
  onExit: () => void;
  onChanged: () => Promise<void>;
};

export function CollectionOverlay({ collectionId, collections, onExit }: CollectionOverlayProps) {
  const { gateway } = useLibrary();
  const collection = collections.find((c) => c.id === collectionId) ?? null;
  const [covers, setCovers] = useState<CollectionCover[] | null>(null);
  const [selectedFileName, setSelectedFileName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useAutoDismiss(error, setError);

  useEffect(() => {
    let active = true;
    void gateway
      .listCollectionCovers(collectionId)
      .then((list) => {
        if (!active) return;
        setCovers(list);
        if (list.length > 0) setSelectedFileName(list[0].fileName);
      })
      .catch((e) => {
        if (active) setError(commandErrorMessage(e, "표지를 불러오지 못했습니다."));
      });
    return () => {
      active = false;
    };
  }, [gateway, collectionId]);

  useEffect(() => {
    if (error == null) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onExit();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [error, onExit]);

  if (!collection) {
    return (
      <div className="collection-overlay" role="dialog" aria-label="컬렉션">
        <ViewToolbar title="컬렉션" onExit={onExit} />
        <div className="collection-overlay__body">
          <p>컬렉션을 찾을 수 없습니다.</p>
        </div>
      </div>
    );
  }

  return (
    <div
      className="collection-overlay"
      role="dialog"
      aria-label={collection.name}
      onKeyDown={(e) => {
        if (e.key === "Escape") onExit();
      }}
    >
      <ViewToolbar title={collection.name} onExit={onExit} />
      {error && <Toast onDismiss={() => setError(null)}>{error}</Toast>}
      <div className="collection-overlay__body">
        <CollectionInfoPanel collection={collection} />
        <div className="collection-overlay__hero">
          {selectedFileName ? (
            <img
              key={selectedFileName}
              src={collectionCoverUrl(collectionId, selectedFileName)}
              alt={collection.name}
              draggable={false}
            />
          ) : covers === null ? (
            <Skeleton className="collection-overlay__hero-skeleton" label="표지를 불러오는 중" />
          ) : (
            <span className="collection-overlay__hero-empty">표지가 없습니다</span>
          )}
        </div>
        <CollectionVolumePanel collection={collection} coverCount={covers?.length ?? 0} />
      </div>
      <CollectionCoverGrid
        collectionId={collectionId}
        covers={covers ?? []}
        selectedFileName={selectedFileName}
        onSelect={setSelectedFileName}
      />
    </div>
  );
}
```

- [ ] **Step 5: global.css에 스타일 추가**

`global.css` 끝에 추가:

```css
/* Collection Overlay */
.collection-overlay {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--color-bg);
}

.collection-overlay__body {
  display: grid;
  grid-template-columns: 280px 1fr 280px;
  gap: var(--space-4);
  flex: 1;
  min-height: 0;
  padding: var(--space-3) var(--space-4);
  overflow: hidden;
}

/* Info Panel (left) */
.collection-overlay__info {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  min-width: 0;
  overflow-y: auto;
}

.collection-overlay__info-rows {
  display: flex;
  flex-direction: column;
  gap: var(--space-compact);
  margin: 0;
}

.collection-overlay__info-row {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.collection-overlay__info-row dt {
  color: var(--color-muted);
  font-size: var(--text-xs);
}

.collection-overlay__info-row dd {
  color: var(--color-text);
  font-size: var(--text-md);
  margin: 0;
}

.collection-overlay__overview {
  border-top: var(--border-width) solid var(--color-border);
  padding-top: var(--space-3);
}

.collection-overlay__overview p {
  color: var(--color-muted);
  font-size: var(--text-xs);
  line-height: 1.5;
  margin: 0;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

/* Hero (center) */
.collection-overlay__hero {
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 0;
  min-height: 0;
}

.collection-overlay__hero img {
  max-height: 100%;
  max-width: 100%;
  object-fit: contain;
  border-radius: var(--radius-tile);
  animation: collection-overlay-fade 160ms ease-out;
}

.collection-overlay__hero-skeleton {
  width: 240px;
  height: 360px;
}

.collection-overlay__hero-empty {
  color: var(--color-muted);
  font-size: var(--text-sm);
}

@keyframes collection-overlay-fade {
  from { opacity: 0; }
  to { opacity: 1; }
}

/* Volume Panel (right) */
.collection-overlay__volume {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  min-width: 0;
}

.collection-overlay__volume-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}

.collection-overlay__volume-label {
  color: var(--color-muted);
  font-size: var(--text-xs);
}

.collection-overlay__volume-value {
  color: var(--color-text);
  font-size: var(--text-md);
}

.collection-overlay__volume-input {
  width: 80px;
  height: var(--control-height-sm);
  padding: 0 var(--space-2);
  color: var(--color-text);
  background: var(--color-surface);
  border: var(--border-width) solid var(--color-border);
  border-radius: var(--radius-sm);
  font-size: var(--text-sm);
}

.collection-overlay__volume-input:focus {
  outline: var(--focus-width) solid var(--color-accent);
  outline-offset: calc(var(--focus-width) * -1);
}

/* Cover Grid (bottom) */
.collection-overlay__grid-area {
  display: flex;
  gap: var(--space-3);
  border-top: var(--border-width) solid var(--color-border);
  padding: var(--space-3) var(--space-4);
  height: 35%;
  min-height: 120px;
  flex-shrink: 0;
}

.collection-overlay__shelves {
  display: grid;
  grid-template-columns: repeat(2, 44px);
  grid-template-rows: repeat(2, 44px);
  gap: var(--space-compact);
  flex-shrink: 0;
}

.collection-overlay__shelf-button {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-muted);
  background: transparent;
  border: var(--border-width) solid var(--color-border);
  border-radius: var(--radius-sm);
  cursor: pointer;
  font-size: var(--text-md);
  font-weight: 600;
}

.collection-overlay__shelf-button:hover {
  color: var(--color-text);
  background: var(--color-surface-hover);
}

.collection-overlay__shelf-button[aria-pressed="true"] {
  color: var(--color-text);
  background: var(--color-selected);
  border-color: var(--color-accent);
}

.collection-overlay__cover-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(80px, 1fr));
  gap: var(--space-1);
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  align-content: start;
}

.collection-overlay__cover-tile {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 0;
  background: transparent;
  border: 0;
  border-radius: var(--radius-tile);
  cursor: pointer;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
}

.collection-overlay__cover-tile img {
  display: block;
  width: 100%;
  aspect-ratio: 0.7;
  object-fit: cover;
  border-radius: var(--radius-tile);
}

.collection-overlay__cover-label {
  color: var(--color-muted);
  font-size: var(--text-xs);
  text-align: center;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.collection-overlay__cover-tile[aria-pressed="true"] img {
  outline: var(--focus-width) solid var(--color-accent);
  outline-offset: calc(var(--focus-width) * -1);
}

.collection-overlay__cover-empty {
  color: var(--color-muted);
  font-size: var(--text-sm);
  grid-column: 1 / -1;
}
```

- [ ] **Step 6: 타입체크 확인**

Run: `cd app && npx tsc --noEmit`
Expected: 에러 없음

- [ ] **Step 7: 테스트 확인**

Run: `cd app && npx vitest run --reporter=dot 2>&1 | tail -5`
Expected: 모든 테스트 통과

- [ ] **Step 8: App.tsx 변경사항과 함께 커밋**

```bash
git add app/src/collections/CollectionOverlay.tsx app/src/collections/CollectionCoverGrid.tsx app/src/collections/CollectionInfoPanel.tsx app/src/collections/CollectionVolumePanel.tsx app/src/styles/global.css app/src/app/App.tsx
git commit -m "Add collection overlay with cover gallery, info and volume panels"
```

---

### Task 11: SettingsView에 컬렉션 소스 폴더 선택 UI 추가

**Files:**
- Modify: `app/src/settings/SettingsView.tsx`

**Interfaces:**
- Consumes: `getCollectionSourceRoot`, `setCollectionSourceRoot` gateway 메서드
- Produces: 설정 UI에 "컬렉션 소스 폴더" 선택 항목

- [ ] **Step 1: 상태 및 핸들러 추가**

`SettingsView.tsx`에서 `bookImportRunning` 상태 근처에 추가:

```typescript
  const [collectionSourceRoot, setCollectionSourceRootState] = useState<string | null>(null);
  const [collectionSourceError, setCollectionSourceError] = useState<string | null>(null);
  useAutoDismiss(collectionSourceError, setCollectionSourceError);
```

`useEffect`에서 `gateway.getMangaRoot()` 호출 근처에 `getCollectionSourceRoot` 호출 추가:

```typescript
  useEffect(() => {
    let active = true;
    void gateway.getMangaRoot().then((root) => { if (active) setMangaRoot(root); });
    void gateway.getCollectionSourceRoot().then((root) => { if (active) setCollectionSourceRootState(root); });
    return () => { active = false; };
  }, [gateway]);
```

`chooseBookImportFolder` 근처에 `chooseCollectionSourceFolder` 핸들러 추가:

```typescript
  async function chooseCollectionSourceFolder() {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected !== "string") return;
    try {
      await gateway.setCollectionSourceRoot(selected);
      setCollectionSourceRootState(selected);
    } catch (error) {
      setCollectionSourceError(commandErrorMessage(error, "컬렉션 소스 폴더를 설정하지 못했습니다."));
    }
  }
```

- [ ] **Step 2: UI 항목 추가**

"컬렉션 가져오기" dl 아래에 새 dl 추가:

```tsx
        <dl className="settings-view__property">
          <dt>컬렉션 소스 폴더</dt>
          <dd className="settings-view__path">{collectionSourceRoot ?? "설정되지 않음"}</dd>
          <Button size="sm" onClick={() => void chooseCollectionSourceFolder()}>변경</Button>
          {collectionSourceError && <dd className="settings-view__row-message" role="alert">{collectionSourceError}</dd>}
        </dl>
```

- [ ] **Step 3: SettingsView 테스트의 property count 수정**

`SettingsView.test.tsx`에서 `settings-view__property` count를 4에서 5로 변경:

```typescript
  expect(container.querySelectorAll(".settings-view__property")).toHaveLength(5);
```

- [ ] **Step 4: 타입체크 + 테스트 확인**

Run: `cd app && npx tsc --noEmit && npx vitest run src/settings/SettingsView.test.tsx --reporter=dot 2>&1 | tail -5`
Expected: 에러 없음, 테스트 통과

- [ ] **Step 5: 커밋**

```bash
git add app/src/settings/SettingsView.tsx app/src/settings/SettingsView.test.tsx
git commit -m "Add collection source folder picker to settings"
```

---

### Task 12: 전체 빌드 및 통합 테스트

**Files:**
- None (검증만)

- [ ] **Step 1: 백엔드 전체 테스트**

Run: `cd app/src-tauri && cargo test --message-format short 2>&1 | findstr "test result"`
Expected: 모든 테스트 통과

- [ ] **Step 2: 프론트엔드 타입체크**

Run: `cd app && npx tsc --noEmit`
Expected: 에러 없음

- [ ] **Step 3: 프론트엔드 전체 테스트**

Run: `cd app && npx vitest run --reporter=dot 2>&1 | tail -5`
Expected: 모든 테스트 통과

- [ ] **Step 4: 수동 확인 (dev 모드 실행)**

"Lakomics Live Dev" 단축아이콘 실행 → 앱 시작 후:
1. 설정에서 "컬렉션 소스 폴더"를 `C:\lakomics\book`으로 설정
2. 설정에서 "컬렉션 가져오기"로 `C:\lakomics\book` 선택 → 마이그레이션 실행
3. 컬렉션 브라우저에서 만화 컬렉션 클릭 → 오버레이 열림
4. 표지가 중앙에 표시, 하단 그리드에 썸네일, 좌측 서지 정보, 우측 권수
5. 선반 버튼 클릭 → 표지 필터링
6. 썸네일 클릭 → 중앙 표지 교체
7. ESC → 오버레이 닫기

- [ ] **Step 5: 최종 커밋 (변경사항이 있으면)**

```bash
git add -A
git commit -m "Final integration verification for manga cover viewer"
```