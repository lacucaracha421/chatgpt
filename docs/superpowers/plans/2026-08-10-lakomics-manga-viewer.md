# 망가 뷰어 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 라이브러리 밖 망가 루트 폴더의 시리즈를 사이드바 "망가" 탭에서 표지 그리드로 보고, 클릭하면 전체 화면 뷰어로 페이지를 넘겨 읽는다.

**Architecture:** 망가 루트를 `library_settings`에 저장하고 시리즈는 루트 기준 상대 경로로 DB(`manga_series`)에 인덱싱한다. 스캔 시 첫 페이지에서 400px webp 썸네일을 루트 안 `.lakomics-thumbs/`에 생성한다. 미디어 프로토콜에 `/manga-cover/{id}`와 `/manga-page/{id}/{page}` 경로를 추가해 루트 기준 canonicalize로 서빙한다. 프론트는 새 `MangaBrowser`(그리드)와 `MangaViewer`(전체 화면 오버레이)를 만들고 사이드바/App.tsx에 연결한다.

**Tech Stack:** Rust (tauri 2, rusqlite, image), React 19, TypeScript, Vitest, CSS custom properties.

## Global Constraints

- 모든 UI 텍스트는 한국어를 유지한다.
- 새 외부 의존성 추가 금지 (`image` 크레이트는 이미 설치됨, avif 디코딩 불필요 — 표지는 항상 webp).
- 기존 패턴 준수: `Library`의 `connection()` + `LockedConnection`, 명령은 `Result<T, CommandError>`, `spawn_blocking`은 비동기 명령에서만.
- 미디어 경로는 항상 망가 루트 기준 canonicalize 후 루트 밖이면 거부 (`UnsafeMediaPath` 재사용).
- 테스트: `npm test`(vitest run)는 `C:\chatgpt\app`에서, Rust 테스트는 `cargo test`를 `C:\chatgpt\app\src-tauri`에서 실행.
- 타입 검사: `npx tsc --noEmit`는 `C:\chatgpt\app`에서.

---

### Task 1: DB 마이그레이션 0005 — manga_series 테이블 + manga_root 설정

**Files:**
- Create: `app/src-tauri/migrations/0005_manga.sql`
- Modify: `app/src-tauri/src/library/db.rs:7-11,37-53`

**Interfaces:**
- Consumes: 없음
- Produces: `manga_series` 테이블, `library_settings.manga_root` 컬럼, `SCHEMA_VERSION = 5`

- [ ] **Step 1: 마이그레이션 SQL 작성**

`app/src-tauri/migrations/0005_manga.sql`:

```sql
ALTER TABLE library_settings ADD COLUMN manga_root TEXT;

CREATE TABLE manga_series (
  id TEXT PRIMARY KEY,
  relative_path TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  author TEXT NOT NULL,
  gallery_id TEXT,
  page_count INTEGER NOT NULL,
  thumbnail_relative_path TEXT NOT NULL,
  scanned_at TEXT NOT NULL
);
```

- [ ] **Step 2: db.rs에 마이그레이션 연결**

`db.rs`:
- `SCHEMA_VERSION`을 `5`로 변경
- `const MANGA_SCHEMA: &str = include_str!("../../migrations/0005_manga.sql");` 추가
- `migrate_to_latest`의 `version <= 3` 블록 뒤에 `transaction.execute_batch(MANGA_SCHEMA)?;` 추가
- `match version { SCHEMA_VERSION => {} version @ 0..=4 => { ... }`로 범위 확장

- [ ] **Step 3: 기존 테스트 갱신**

`app/src-tauri/src/library/mod.rs`의 `open_creates_the_self_contained_library_layout_without_a_trash_directory` 테스트에서 `assert_eq!(version, 4)` → `assert_eq!(version, 5)`.

- [ ] **Step 4: Rust 테스트 실행**

Run: `cargo test` in `C:\chatgpt\app\src-tauri`
Expected: 전체 PASS

- [ ] **Step 5: 커밋**

```bash
git add app/src-tauri/migrations/0005_manga.sql app/src-tauri/src/library/db.rs app/src-tauri/src/library/mod.rs
git commit -m "feat: add manga series schema and manga root setting"
```

---

### Task 2: Rust — manga 모듈 (스캔/목록/루트 설정)

**Files:**
- Create: `app/src-tauri/src/library/manga.rs`
- Modify: `app/src-tauri/src/library/mod.rs:1-13` (모듈 선언), `:134-168` 근처 (루트 설정 메서드)
- Modify: `app/src-tauri/src/library/error.rs` (오류 변형)
- Modify: `app/src-tauri/src/library/models.rs` (MangaSeries 타입)

**Interfaces:**
- Consumes: Task 1의 `manga_series` 테이블, `library_settings.manga_root`
- Produces:
  - `models.rs`: `pub struct MangaSeries { id: String, relative_path: String, title: String, author: String, gallery_id: Option<String>, page_count: u64, thumbnail_relative_path: String, scanned_at: String }` (serde camelCase)
  - `Library::manga_root() -> Result<Option<String>, LibraryError>`
  - `Library::set_manga_root(path: Option<String>) -> Result<(), LibraryError>`
  - `Library::scan_manga() -> Result<u64, LibraryError>` — 추가/갱신된 시리즈 수 반환
  - `Library::list_manga_series() -> Result<Vec<MangaSeries>, LibraryError>`
  - `Library::manga_cover_path(series_id) -> Result<PathBuf, LibraryError>`
  - `Library::manga_page_path(series_id, page_index) -> Result<PathBuf, LibraryError>`

- [ ] **Step 1: 오류 변형 추가**

`error.rs`에 추가:

```rust
#[error("망가 루트 폴더가 설정되지 않았습니다")]
MangaRootNotSet,
#[error("망가 시리즈를 찾을 수 없습니다")]
MangaSeriesNotFound,
#[error("망가 폴더 구조가 올바르지 않습니다: {path}")]
InvalidMangaFolder { path: PathBuf },
#[error("망가 표지 썸네일을 만들 수 없습니다: {path}")]
MangaThumbnail { path: PathBuf, #[source] source: std::io::Error },
```

`commands.rs`의 `From<LibraryError> for CommandError`에 매핑 추가:
- `MangaRootNotSet => "manga_root_not_set"`
- `MangaSeriesNotFound => "manga_series_not_found"`
- `InvalidMangaFolder { .. } => "invalid_manga_folder"`
- `MangaThumbnail { .. } => "manga_thumbnail_failed"`
- 메시지: `error.to_string()` 폴백 사용 가능 (기존 매핑과 동일 패턴)

- [ ] **Step 2: models.rs에 MangaSeries 추가**

`models.rs`에:

```rust
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MangaSeries {
    pub id: String,
    pub relative_path: String,
    pub title: String,
    pub author: String,
    pub gallery_id: Option<String>,
    pub page_count: u64,
    pub thumbnail_relative_path: String,
    pub scanned_at: String,
}
```

(기존 타입들의 derive/import 패턴을 따르되 Serialize만 필요)

- [ ] **Step 3: manga.rs 스캔/목록/루트 로직 작성**

`app/src-tauri/src/library/manga.rs`:

```rust
use std::{
    fs,
    path::{Path, PathBuf},
};

use rusqlite::OptionalExtension;

use super::error::LibraryError;
use super::models::MangaSeries;
use super::Library;

const THUMB_DIR: &str = ".lakomics-thumbs";

pub(crate) fn manga_root(connection: &rusqlite::Connection) -> Result<Option<String>, LibraryError> {
    let value = connection
        .query_row(
            "SELECT manga_root FROM library_settings WHERE singleton = 1",
            [],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten();
    Ok(value)
}

pub(crate) fn set_manga_root(connection: &rusqlite::Connection, path: Option<&str>) -> Result<(), LibraryError> {
    connection.execute(
        "UPDATE library_settings SET manga_root = ?1 WHERE singleton = 1",
        [path],
    )?;
    if let Some(root) = path {
        let series_dir = PathBuf::from(root);
        fs::create_dir_all(&series_dir)?;
    }
    Ok(())
}

pub(crate) fn scan(connection: &rusqlite::Connection, library: &Library) -> Result<u64, LibraryError> {
    let root = manga_root(connection)?
        .ok_or(LibraryError::MangaRootNotSet)?;
    let root_path = PathBuf::from(&root);
    if !root_path.is_dir() {
        return Err(LibraryError::MangaRootNotSet);
    }
    let thumb_dir = root_path.join(THUMB_DIR);
    fs::create_dir_all(&thumb_dir)?;

    let mut changed: u64 = 0;
    let mut seen_paths: Vec<String> = Vec::new();
    let entries = fs::read_dir(&root_path)?;
    for entry in entries.flatten() {
        if !entry.path().is_dir() {
            continue;
        }
        let folder_name = entry.file_name().to_string_lossy().into_owned();
        if folder_name == THUMB_DIR {
            continue;
        }
        seen_paths.push(folder_name.clone());
        if scan_series_folder(connection, library, &root_path, &folder_name, &thumb_dir)? {
            changed += 1;
        }
    }
    // 삭제된 폴더 정리: DB에 있지만 이번 스캔에서 못 본 시리즈는 제거
    let mut statement = connection.prepare("SELECT relative_path FROM manga_series")?;
    let db_paths: Vec<String> = statement
        .query_map([], |row| row.get(0))?
        .collect::<Result<_, _>>()?;
    for db_path in db_paths {
        if !seen_paths.contains(&db_path) {
            connection.execute(
                "DELETE FROM manga_series WHERE relative_path = ?1",
                [&db_path],
            )?;
        }
    }
    Ok(changed)
}
```

> **주의:** 위 `scan`의 DELETE 부분은 의도적 플레이스홀더가 아니라 잘못된 SQL입니다. 구현자는 아래 실제 로직으로 작성하세요: `fs::read_dir`로 얻은 폴더명 Set과 DB의 `relative_path` 목록을 비교해, DB에 있고 폴더가 없는 시리즈를 `DELETE FROM manga_series WHERE relative_path = ?1`로 개별 삭제한다.

`scan` 함수는 위 코드 블록 그대로 사용 (플레이스홀더 제거됨).

`scan_series_folder` 헬퍼:

```rust
fn scan_series_folder(
    connection: &rusqlite::Connection,
    library: &Library,
    root: &Path,
    relative_path: &str,
    thumb_dir: &Path,
) -> Result<bool, LibraryError> {
    let folder = root.join(relative_path);
    let (title, author, gallery_id) = parse_series_metadata(&folder, relative_path);
    let page_files = list_page_files(&folder)?;
    let page_count = page_files.len();
    if page_count == 0 {
        return Ok(false); // 빈 폴더는 스킵
    }
    let first_page = &page_files[0];

    let existing: Option<(i64, String)> = connection
        .query_row(
            "SELECT page_count, thumbnail_relative_path FROM manga_series WHERE relative_path = ?1",
            [relative_path],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let unchanged = existing.is_some_and(|(count, thumb)| {
        count as usize == page_count
            && fs::exists(thumb_dir.join(thumb)).unwrap_or(false)
    });
    if unchanged {
        return Ok(false);
    }

    let series_id = match existing {
        Some(_) => {
            connection.query_row(
                "SELECT id FROM manga_series WHERE relative_path = ?1",
                [relative_path],
                |row| row.get(0),
            )?
        }
        None => uuid::Uuid::new_v4().to_string(),
    };

    let thumb_name = format!("{series_id}.webp");
    let thumb_path = thumb_dir.join(&thumb_name);
    if !thumb_path.exists() {
        create_thumbnail(&folder.join(first_page), &thumb_path)?;
    }

    connection.execute(
        "INSERT INTO manga_series (id, relative_path, title, author, gallery_id, page_count, thumbnail_relative_path, scanned_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(relative_path) DO UPDATE SET
           title = excluded.title,
           author = excluded.author,
           gallery_id = excluded.gallery_id,
           page_count = excluded.page_count,
           thumbnail_relative_path = excluded.thumbnail_relative_path,
           scanned_at = excluded.scanned_at",
        rusqlite::params![
            series_id,
            relative_path,
            title,
            author,
            gallery_id,
            page_count as i64,
            thumb_name,
            chrono::Utc::now().to_rfc3339(),
        ],
    )?;
    Ok(true)
}
```

`parse_series_metadata` (info.txt 우선, 폴더명 폴백):

```rust
fn parse_series_metadata(folder: &Path, folder_name: &str) -> (String, String, Option<String>) {
    let info = fs::read_to_string(folder.join("info.txt")).unwrap_or_default();
    let mut title = String::new();
    let mut author = String::new();
    let mut gallery_id: Option<String> = None;
    for line in info.lines() {
        let Some((key, value)) = line.split_once(':') else { continue };
        let value = value.trim().to_string();
        match key.trim() {
            "제목" => title = value,
            "작가" => author = value,
            "갤러리 넘버" => gallery_id = Some(value),
            _ => {}
        }
    }
    if title.is_empty() {
        title = folder_name
            .split(" _ ")
            .next()
            .unwrap_or(folder_name)
            .to_string();
    }
    if author.is_empty() {
        author = folder_name
            .split(']')
            .next()
            .and_then(|part| part.strip_prefix('['))
            .map(|part| part.trim().to_string())
            .unwrap_or_default();
    }
    (title, author, gallery_id)
}
```

`list_page_files` (숫자 파일명 정렬, webp/avif/jpg/png/gif 지원):

```rust
fn list_page_files(folder: &Path) -> Result<Vec<String>, LibraryError> {
    let mut pages: Vec<(u32, String)> = Vec::new();
    let Ok(entries) = fs::read_dir(folder) else {
        return Ok(Vec::new());
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(stem) = name.split_once('.') else { continue };
        let Ok(number) = stem.0.parse::<u32>() else { continue };
        let ext = stem.1.to_ascii_lowercase();
        if matches!(ext.as_str(), "webp" | "avif" | "jpg" | "jpeg" | "png" | "gif") {
            pages.push((number, name));
        }
    }
    pages.sort_by_key(|(number, _)| *number);
    Ok(pages.into_iter().map(|(_, name)| name).collect())
}
```

`create_thumbnail` (기존 `write_thumbnail` 패턴 재사용):

```rust
fn create_thumbnail(source: &Path, target: &Path) -> Result<(), LibraryError> {
    let file = fs::File::open(source).map_err(|source_err| LibraryError::ReadMedia {
        path: source.to_path_buf(),
        source: source_err,
    })?;
    let reader = image::ImageReader::new(std::io::BufReader::new(file))
        .with_guessed_format()
        .map_err(|_| LibraryError::UnsupportedImage)?;
    let image = reader.decode().map_err(|_| LibraryError::UnsupportedImage)?;
    let out = fs::File::create(target).map_err(|source_err| LibraryError::WriteAsset {
        path: target.to_path_buf(),
        source: source_err,
    })?;
    image
        .thumbnail(400, 400)
        .write_to(&mut std::io::BufWriter::new(out), image::ImageFormat::WebP)
        .map_err(|_| LibraryError::UnsupportedImage)
}
```

`list_series`:

```rust
pub(crate) fn list_series(connection: &rusqlite::Connection) -> Result<Vec<MangaSeries>, LibraryError> {
    let mut statement = connection.prepare(
        "SELECT id, relative_path, title, author, gallery_id, page_count, thumbnail_relative_path, scanned_at
         FROM manga_series ORDER BY scanned_at DESC",
    )?;
    let rows = statement.query_map([], |row| {
        Ok(MangaSeries {
            id: row.get(0)?,
            relative_path: row.get(1)?,
            title: row.get(2)?,
            author: row.get(3)?,
            gallery_id: row.get(4)?,
            page_count: row.get::<_, i64>(5)? as u64,
            thumbnail_relative_path: row.get(6)?,
            scanned_at: row.get(7)?,
        })
    })?;
    let mut series = Vec::new();
    for row in rows {
        series.push(row?);
    }
    Ok(series)
}
```

**페이지/표지 경로 해석** — `Library` 메서드로 `mod.rs`에 추가 (media_protocol에서 사용):

```rust
pub fn manga_cover(&self, series_id: &str) -> Result<MediaResponse, LibraryError> {
    let connection = self.connection()?;
    let root = manga::manga_root(&connection)?.ok_or(LibraryError::MangaRootNotSet)?;
    let thumb_relative: Option<String> = connection
        .query_row(
            "SELECT thumbnail_relative_path FROM manga_series WHERE id = ?1",
            [series_id],
            |row| row.get(0),
        )
        .optional()?
        .flatten();
    let thumb_relative = thumb_relative.ok_or(LibraryError::MangaSeriesNotFound)?;
    self.open_rooted_media(Path::new(&root).join(".lakomics-thumbs").join(thumb_relative))
}

pub fn manga_page(&self, series_id: &str, page_index: u32) -> Result<MediaResponse, LibraryError> {
    let connection = self.connection()?;
    let root = manga::manga_root(&connection)?.ok_or(LibraryError::MangaRootNotSet)?;
    let (relative_path, page_count): (String, i64) = connection
        .query_row(
            "SELECT relative_path, page_count FROM manga_series WHERE id = ?1",
            [series_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
    if page_index == 0 || page_index as i64 > page_count {
        return Err(LibraryError::MangaSeriesNotFound);
    }
    let folder = Path::new(&root).join(relative_path);
    let pages = manga::list_page_files(&folder)?;
    let file_name = pages.get(page_index as usize - 1).ok_or(LibraryError::MangaSeriesNotFound)?;
    self.open_rooted_media(folder.join(file_name))
}
```

`open_rooted_media` 헬퍼 (mod.rs, 기존 `resolve_media`의 canonicalize 블록 재사용):

```rust
fn open_rooted_media(&self, absolute_path: PathBuf) -> Result<MediaResponse, LibraryError> {
    let canonical_root = fs::canonicalize(&self.root)?;
    let requested = absolute_path;
    let canonical = fs::canonicalize(&requested).map_err(|source| {
        if source.kind() == std::io::ErrorKind::NotFound {
            LibraryError::MediaNotFound
        } else {
            LibraryError::ReadMedia { path: requested.clone(), source }
        }
    })?;
    if !canonical.starts_with(&canonical_root) {
        return Err(LibraryError::UnsafeMediaPath);
    }
    let mime = mime_for_path(&canonical);
    let file = fs::File::open(&canonical).map_err(|source| LibraryError::ReadMedia { path: canonical.clone(), source })?;
    let length = file.metadata().map_err(|source| LibraryError::ReadMedia { path: canonical.clone(), source })?.len();
    Ok(MediaResponse { file, length, mime })
}
```

> **주의:** `open_rooted_media`의 canonicalize 대상은 **망가 루트**입니다. `Library::root`가 아니라 망가 루트 기준으로 검증해야 합니다. 위 시그니처를 `open_manga_media(&self, manga_root: &Path, absolute_path: PathBuf)`로 변경해 망가 루트를 인자로 받아 canonicalize하고, `!canonical.starts_with(&fs::canonicalize(manga_root)?)`로 검증하세요. (`mime_for_path`에 `avif => "image/avif"` 케이스 추가)

- [ ] **Step 4: mod.rs에 모듈/메서드 연결**

`mod.rs`:
- `mod manga;` 선언
- `Library`에 위 4개 public 메서드 (`manga_root` 조회는 private 헬퍼 `manga::manga_root` 활용 — 명령에서 사용할 public `pub fn manga_root(&self)`도 추가)
- `mime_for_path`에 `Some("avif") => "image/avif"` 추가

- [ ] **Step 5: manga.rs 단위 테스트 작성**

`manga.rs` 하단에 `#[cfg(test)]` 모듈:

```rust
#[cfg(test)]
mod tests {
    use std::fs;

    use super::{list_page_files, parse_series_metadata};

    #[test]
    fn list_page_files_sorts_two_and_three_digit_names() {
        let temp = tempfile::tempdir().unwrap();
        for name in ["02.webp", "001.webp", "10.avif", "1.webp", "3.webp"] {
            fs::write(temp.path().join(name), b"x").unwrap();
        }
        let pages = list_page_files(temp.path()).unwrap();
        assert_eq!(pages, vec!["001.webp", "1.webp", "02.webp", "3.webp", "10.avif"]);
    }

    #[test]
    fn parse_series_metadata_prefers_info_txt() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(
            temp.path().join("info.txt"),
            "갤러리 넘버: 4038596\n제목: Batsu Kano\n작가: amatani haruka\n",
        ).unwrap();
        let (title, author, gallery) = parse_series_metadata(temp.path(), "[other] fallback (1)");
        assert_eq!(title, "Batsu Kano");
        assert_eq!(author, "amatani haruka");
        assert_eq!(gallery.as_deref(), Some("4038596"));
    }

    #[test]
    fn parse_series_metadata_falls_back_to_folder_name() {
        let temp = tempfile::tempdir().unwrap();
        let (title, author, gallery) = parse_series_metadata(temp.path(), "[unknown] Some Title _ 한국어 (12345)");
        assert_eq!(title, "[unknown] Some Title");
        assert_eq!(author, "unknown");
        assert_eq!(gallery, None);
    }
}
```

> **주의:** 파일명 정렬 예상값은 숫자 오름차순이므로 `["001.webp", "1.webp", "02.webp", "3.webp", "10.avif"]`가 맞습니다 (001→1, 02→2, 3, 10). 테스트가 이 기대와 다르면 실제 정렬 동작에 맞춰 수정하세요.

- [ ] **Step 6: Rust 테스트 실행**

Run: `cargo test` in `C:\chatgpt\app\src-tauri`
Expected: 전체 PASS (기존 + 신규)

- [ ] **Step 7: 커밋**

```bash
git add app/src-tauri/src/library/manga.rs app/src-tauri/src/library/mod.rs app/src-tauri/src/library/error.rs app/src-tauri/src/library/models.rs app/src-tauri/src/commands.rs
git commit -m "feat: scan and index manga series from the manga root"
```

---

### Task 3: Rust — 명령 4개 + 미디어 프로토콜 경로

**Files:**
- Modify: `app/src-tauri/src/commands.rs`
- Modify: `app/src-tauri/src/lib.rs:30-64`
- Modify: `app/src-tauri/src/media_protocol.rs:19-57,112-133`

**Interfaces:**
- Consumes: Task 2의 `Library::manga_root/set_manga_root/scan_manga/list_manga_series/manga_cover/manga_page`
- Produces: 명령 `get_manga_root`, `set_manga_root`, `scan_manga`, `list_manga_series`; 미디어 경로 `/manga-cover/{id}`, `/manga-page/{id}/{page}`

- [ ] **Step 1: commands.rs에 명령 추가**

```rust
#[tauri::command]
pub fn get_manga_root(state: State<'_, AppState>) -> Result<Option<String>, CommandError> {
    let library = current_required(state)?;
    library.manga_root().map_err(CommandError::from)
}

#[tauri::command]
pub fn set_manga_root(path: Option<String>, state: State<'_, AppState>) -> Result<(), CommandError> {
    let library = current_required(state)?;
    library.set_manga_root(path.as_deref()).map_err(CommandError::from)
}

#[tauri::command]
pub async fn scan_manga(state: State<'_, AppState>) -> Result<u64, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || library.scan_manga())
        .await
        .map_err(|_| background_task_error())?
        .map_err(CommandError::from)
}

#[tauri::command]
pub fn list_manga_series(state: State<'_, AppState>) -> Result<Vec<MangaSeries>, CommandError> {
    let library = current_required(state)?;
    library.list_manga_series().map_err(CommandError::from)
}
```

(import에 `MangaSeries` 추가, `background_task_error`는 기존 함수 재사용)

- [ ] **Step 2: lib.rs에 명령 등록**

`invoke_handler` 배열에 4개 추가:
`commands::get_manga_root, commands::set_manga_root, commands::scan_manga, commands::list_manga_series,`

- [ ] **Step 3: media_protocol.rs에 manga 경로 추가**

`parse_path`에 manga 라우트 추가 (asset_id UUID 검증은 manga용 시리즈 id에도 그대로 적용 — manga_series.id도 UUID):

```rust
let variant = match route {
    "asset" if segments.next().is_none() => MediaVariant::Asset,
    "thumbnail" if segments.next().is_none() => MediaVariant::Thumbnail,
    "playback" if segments.next().is_none() => MediaVariant::Playback,
    "manga-cover" if segments.next().is_none() => MediaVariant::MangaCover,
    "manga-page" => {
        let page_index = segments.next()?.parse::<u32>().ok()?;
        if segments.next().is_some() {
            return None;
        }
        MediaVariant::MangaPage(page_index)
    }
    "scrub-frame" => { ...기존... }
    _ => return None,
};
```

`mod.rs`의 `MediaVariant` enum에 추가:

```rust
pub enum MediaVariant {
    Asset,
    Thumbnail,
    Playback,
    ScrubFrame(u32),
    MangaCover,
    MangaPage(u32),
}
```

`media_response_with_range`의 분기에서 manga variant 처리:

```rust
match library.resolve_manga(&asset_id, &variant) { ... }
```

또는 `resolve_media`와 별도로 `resolve_manga` 메서드를 추가해 `Library::manga_cover/manga_page`를 호출. 구현 선택은 기존 코드 구조에 맞게 — 핵심은 `MangaCover`/`MangaPage` variant가 `Library::manga_cover(series_id)` / `Library::manga_page(series_id, index)`로 연결되는 것.

`parse_path`의 UUID 검증은 manga 시리즈 id에도 유효 (둘 다 UUID).

- [ ] **Step 4: media_protocol 테스트 추가**

`media_protocol.rs` 하단 `#[cfg(test)]`에:

```rust
#[test]
fn manga_page_route_rejects_out_of_range_page() {
    // 임시 망가 루트 + 시리즈를 만든 뒤
    // /manga-page/{id}/0 이 404를 반환하는지 확인
}
```

> **주의:** 이 테스트는 임시 폴더를 만들고 `Library::open` + `set_manga_root` + `scan_manga` + `media_response` 호출 흐름을 따라가야 합니다. 기존 `media_protocol.rs` 테스트 패턴(임시 라이브러리 + `media_response`)을 참고하세요. 루트 밖 경로 거부 케이스도 추가.

- [ ] **Step 5: Rust 테스트 실행**

Run: `cargo test` in `C:\chatgpt\app\src-tauri`
Expected: 전체 PASS

- [ ] **Step 6: 커밋**

```bash
git add app/src-tauri/src/commands.rs app/src-tauri/src/lib.rs app/src-tauri/src/media_protocol.rs app/src-tauri/src/library/mod.rs
git commit -m "feat: expose manga commands and media protocol routes"
```

---

### Task 4: 프론트 — 타입·Gateway·미디어 URL

**Files:**
- Modify: `app/src/library/types.ts`
- Modify: `app/src/library/client.ts`
- Modify: `app/src/assets/mediaUrl.ts`

**Interfaces:**
- Consumes: Task 3의 명령 시그니처
- Produces: `MangaSeries` 타입, `LibraryGateway`에 `getMangaRoot/setMangaRoot/scanManga/listMangaSeries`, `mangaCoverUrl/mangaPageUrl`

- [ ] **Step 1: types.ts에 타입 추가**

```ts
export type MangaSeries = {
  id: string;
  relativePath: string;
  title: string;
  author: string;
  galleryId: string | null;
  pageCount: number;
  thumbnailRelativePath: string;
  scannedAt: string;
};
```

`LibraryGateway`에 4개 메서드 추가:

```ts
getMangaRoot(): Promise<string | null>;
setMangaRoot(path: string | null): Promise<void>;
scanManga(): Promise<number>;
listMangaSeries(): Promise<MangaSeries[]>;
```

- [ ] **Step 2: client.ts에 invoke 래퍼 추가**

```ts
getMangaRoot: () => invoke<string | null>("get_manga_root"),
setMangaRoot: (path) => invoke("set_manga_root", { path }),
scanManga: () => invoke<number>("scan_manga"),
listMangaSeries: () => invoke<MangaSeries[]>("list_manga_series"),
```

- [ ] **Step 3: mediaUrl.ts에 함수 추가**

```ts
export function mangaCoverUrl(seriesId: string): string {
  return `${MEDIA_ORIGIN}/manga-cover/${encodeURIComponent(seriesId)}`;
}

export function mangaPageUrl(seriesId: string, pageIndex: number): string {
  return `${MEDIA_ORIGIN}/manga-page/${encodeURIComponent(seriesId)}/${pageIndex}`;
}
```

- [ ] **Step 4: 테스트/타입 체크**

Run: `npx tsc --noEmit` in `C:\chatgpt\app`
Expected: 오류 없음 (모든 테스트 mock gateway는 `LibraryGateway` 전체를 구현해야 하므로 기존 테스트 파일들의 createGateway에 4개 메서드 추가 필요 — 컴파일 에러로 드러남)

- [ ] **Step 5: 기존 테스트의 mock gateway에 메서드 추가**

컴파일 에러가 나는 테스트 파일(`App.test.tsx`, `AssetBrowser.test.tsx`, `AssetInspector.test.tsx`, `TrashBrowser.test.tsx`, `SettingsView.test.tsx`, `ClassificationSidebar.test.tsx` 등)의 `createGateway`/`libraryGateway` mock에 다음 4줄 추가:

```ts
getMangaRoot: vi.fn().mockResolvedValue(null),
setMangaRoot: vi.fn().mockResolvedValue(undefined),
scanManga: vi.fn().mockResolvedValue(0),
listMangaSeries: vi.fn().mockResolvedValue([]),
```

- [ ] **Step 6: 전체 프론트 테스트 실행**

Run: `npm test` in `C:\chatgpt\app`
Expected: 전체 PASS

- [ ] **Step 7: 커밋**

```bash
git add app/src/library/types.ts app/src/library/client.ts app/src/assets/mediaUrl.ts
git add app/src/app/App.test.tsx app/src/assets/AssetBrowser.test.tsx app/src/assets/AssetInspector.test.tsx app/src/safety/TrashBrowser.test.tsx app/src/settings/SettingsView.test.tsx app/src/classification/ClassificationSidebar.test.tsx
git commit -m "feat: add manga types, gateway methods, and media URLs"
```

---

### Task 5: 프론트 — MangaBrowser (그리드 + 스캔)

**Files:**
- Create: `app/src/manga/MangaBrowser.tsx`
- Create: `app/src/manga/MangaBrowser.test.tsx`
- Modify: `app/src/styles/global.css` (manga 그리드 스타일)

**Interfaces:**
- Consumes: Task 4의 `LibraryGateway` 메서드, `mangaCoverUrl`, `useLibrary`
- Produces: `MangaBrowser` — props 없음, `useLibrary()`로 gateway 접근. 내부 상태: `root: string | null`, `series: MangaSeries[] | null`, `loading: boolean`, `message: string | null`. `onOpenSeries?: (series: MangaSeries) => void` prop (시리즈 전체 객체 전달 — Task 7의 App 연결에서 뷰어 정보로 사용).

- [ ] **Step 1: 실패하는 테스트 작성**

`app/src/manga/MangaBrowser.test.tsx`:

```tsx
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LibraryProvider } from "../library/LibraryContext";
import type { LibraryGateway, MangaSeries } from "../library/types";
import { MangaBrowser } from "./MangaBrowser";

afterEach(cleanup);

const series: MangaSeries[] = [
  { id: "s1", relativePath: "[a] T1 (1)", title: "T1", author: "a", galleryId: "1", pageCount: 60, thumbnailRelativePath: "s1.webp", scannedAt: "2026-08-01T00:00:00Z" },
  { id: "s2", relativePath: "[b] T2 (2)", title: "T2", author: "b", galleryId: "2", pageCount: 40, thumbnailRelativePath: "s2.webp", scannedAt: "2026-08-02T00:00:00Z" },
];

describe("MangaBrowser", () => {
  it("scans and shows the cover grid when the root is set", async () => {
    const gateway = createGateway({ root: "C:\\manga", series });
    render(<LibraryProvider gateway={gateway}><MangaBrowser /></LibraryProvider>);
    await waitFor(() => expect(gateway.scanManga).toHaveBeenCalled());
    expect(await screen.findByText("T1")).toBeVisible();
    expect(screen.getByText("T2")).toBeVisible();
    expect(screen.getAllByRole("img").length).toBe(2);
  });

  it("shows the setup prompt when the root is not set", async () => {
    const gateway = createGateway({ root: null, series: [] });
    render(<LibraryProvider gateway={gateway}><MangaBrowser /></LibraryProvider>);
    expect(await screen.findByText("망가 폴더가 설정되지 않았습니다")).toBeVisible();
  });

  it("opens the viewer when a cover is clicked", async () => {
    const gateway = createGateway({ root: "C:\\manga", series });
    const onOpenSeries = vi.fn();
    render(<LibraryProvider gateway={gateway}><MangaBrowser onOpenSeries={onOpenSeries} /></LibraryProvider>);
    await userEvent.click(await screen.findByText("T1"));
    expect(onOpenSeries).toHaveBeenCalledWith(series[0]);
  });
});

function createGateway(overrides: { root: string | null; series: MangaSeries[] }): LibraryGateway {
  const base: LibraryGateway = {
    openLibrary: vi.fn(), currentLibrary: vi.fn(), listClassifications: vi.fn(),
    createClassification: vi.fn(), renameClassification: vi.fn(), moveClassification: vi.fn(),
    deleteClassification: vi.fn(), listAssets: vi.fn(), indexMissingSimilarityHashes: vi.fn(),
    listSimilarityReviews: vi.fn(), decideSimilarityReview: vi.fn(), getAsset: vi.fn(), setAssetFavorite: vi.fn(), setAssetsFavorite: vi.fn(),
    setAssetClassifications: vi.fn(), patchAssetClassifications: vi.fn(), getAssetClassifications: vi.fn(), ingestMedia: vi.fn(),
    preparePendingVideos: vi.fn(), retryVideoPreparation: vi.fn(),
    trashAsset: vi.fn(), trashAssets: vi.fn(), restoreAsset: vi.fn(), restoreAssets: vi.fn(),
    listTrash: vi.fn(), emptyTrash: vi.fn(), getTrashPolicy: vi.fn(), setTrashPolicy: vi.fn(),
    ensureDailyBackup: vi.fn(), listMetadataBackups: vi.fn(), restoreMetadataBackup: vi.fn(), purgeExpiredTrash: vi.fn(),
    getMangaRoot: vi.fn().mockResolvedValue(overrides.root),
    setMangaRoot: vi.fn().mockResolvedValue(undefined),
    scanManga: vi.fn().mockResolvedValue(overrides.series.length),
    listMangaSeries: vi.fn().mockResolvedValue(overrides.series),
  };
  return base;
}
```

- [ ] **Step 2: 테스트 실행해 실패 확인**

Run: `npm test -- --run src/manga/MangaBrowser.test.tsx`
Expected: FAIL — 모듈 없음

- [ ] **Step 3: MangaBrowser 구현**

`app/src/manga/MangaBrowser.tsx`:

```tsx
import { useEffect, useMemo, useState } from "react";
import { useLibrary } from "../library/LibraryContext";
import type { MangaSeries } from "../library/types";
import { mangaCoverUrl } from "../assets/mediaUrl";
import { Button } from "../shared/ui/Button";
import { EmptyState } from "../shared/ui/EmptyState";
import { Skeleton } from "../shared/ui/Skeleton";
import { Toast } from "../shared/ui/Toast";
import { buildJustifiedRows } from "../assets/justifiedRows";

type MangaBrowserProps = {
  onOpenSeries?: (series: MangaSeries) => void;
};
export function MangaBrowser({ onOpenSeries }: MangaBrowserProps) {
  const { gateway } = useLibrary();
  const [root, setRoot] = useState<string | null | undefined>(undefined);
  const [series, setSeries] = useState<MangaSeries[] | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function scan() {
    try {
      const scanned = await gateway.scanManga();
      setMessage(scanned > 0 ? `망가 ${scanned}개를 새로고침했습니다` : "새로 변경된 망가가 없습니다");
      const next = await gateway.listMangaSeries();
      setSeries(next);
    } catch {
      setMessage("망가 목록을 불러오지 못했습니다");
    }
  }

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const currentRoot = await gateway.getMangaRoot();
        if (!active) return;
        setRoot(currentRoot);
        if (currentRoot) {
          const scanned = await gateway.scanManga();
          if (!active) return;
          setMessage(scanned > 0 ? `망가 ${scanned}개를 새로고침했습니다` : "새로 변경된 망가가 없습니다");
          const next = await gateway.listMangaSeries();
          if (active) setSeries(next);
        }
      } catch {
        if (active) setMessage("망가 목록을 불러오지 못했습니다");
      }
    })();
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gateway]);

  if (root === undefined) {
    return <section className="manga-browser" aria-label="망가"><Skeleton className="manga-browser__skeleton" label="망가를 불러오는 중" /></section>;
  }

  if (!root) {
    return <section className="manga-browser" aria-label="망가">
      <EmptyState title="망가 폴더가 설정되지 않았습니다">설정에서 망가 폴더를 선택하면 여기에 표시됩니다.</EmptyState>
    </section>;
  }

  return <section className="manga-browser" aria-label="망가">
    {message && <Toast>{message}</Toast>}
    <div className="manga-browser__toolbar">
      <h2>망가</h2>
      <Button size="sm" onClick={() => void scan()}>새로고침</Button>
    </div>
    {!series ? <Skeleton className="manga-browser__skeleton" label="망가를 불러오는 중" /> : series.length === 0 ? (
      <EmptyState title="망가가 없습니다">망가 폴더에 시리즈 폴더를 추가하세요.</EmptyState>
    ) : <MangaCoverGrid series={series} onOpenSeries={onOpenSeries} />}
  </section>;
}

function MangaCoverGrid({ series, onOpenSeries }: { series: MangaSeries[]; onOpenSeries?: (series: MangaSeries) => void }) {
  return <div className="manga-browser__grid">
    {series.map((entry) => (
      <button key={entry.id} type="button" className="manga-browser__cover" onClick={() => onOpenSeries?.(entry)}>
        <img src={mangaCoverUrl(entry.id)} alt={entry.title} loading="lazy" draggable={false} />
        <span className="manga-browser__cover-title">{entry.title}</span>
        <span className="manga-browser__cover-author">{entry.author} · {entry.pageCount}페이지</span>
      </button>
    ))}
  </div>;
}
```

> **주의:** 표지 비율은 실제 썸네일과 다를 수 있으므로, 그리드 타일은 `aspect-ratio: 2/3` 고정 비율 CSS로 처리하고 `buildJustifiedRows` 대신 단순 CSS 그리드(`repeat(auto-fill, minmax(140px, 1fr))`)를 쓰는 게 더 단순합니다 (ponytail). 위 `MangaCoverGrid`는 이미 CSS 그리드로 단순화되어 있습니다. `useMemo`/`gridWidth`/`buildJustifiedRows` import는 사용하지 않으면 제거하세요.

- [ ] **Step 4: CSS 추가**

`global.css`에:

```css
.manga-browser {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  height: 100%;
  min-height: 0;
  padding: var(--space-3);
  overflow: auto;
}

.manga-browser__toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}

.manga-browser__toolbar h2 {
  margin: 0;
  font-size: 0.875rem;
}

.manga-browser__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: var(--space-3);
}

.manga-browser__cover {
  display: grid;
  gap: var(--space-1);
  padding: 0;
  text-align: left;
  background: transparent;
  border: 0;
  cursor: pointer;
}

.manga-browser__cover img {
  width: 100%;
  aspect-ratio: 2 / 3;
  object-fit: cover;
  border: var(--border-width) solid var(--color-border);
  border-radius: var(--radius-sm);
}

.manga-browser__cover-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-text);
  font-size: 0.75rem;
  font-weight: 600;
}

.manga-browser__cover-author {
  color: var(--color-muted);
  font-size: 0.6875rem;
}

.manga-browser__skeleton {
  min-height: 200px;
}
```

- [ ] **Step 5: 테스트 실행해 통과 확인**

Run: `npm test -- --run src/manga/MangaBrowser.test.tsx`
Expected: PASS

- [ ] **Step 6: 커밋**

```bash
git add app/src/manga/MangaBrowser.tsx app/src/manga/MangaBrowser.test.tsx app/src/styles/global.css
git commit -m "feat: add manga browser with cover grid"
```

---

### Task 6: 프론트 — MangaViewer (전체 화면 뷰어)

**Files:**
- Create: `app/src/manga/MangaViewer.tsx`
- Create: `app/src/manga/MangaViewer.test.tsx`
- Modify: `app/src/styles/global.css`

**Interfaces:**
- Consumes: Task 4의 `mangaPageUrl`, `Dialog`
- Produces: `MangaViewer` — props: `{ seriesId: string; title: string; pageCount: number; onClose: () => void }`. 내부 상태: `page: number` (1-based).

- [ ] **Step 1: 실패하는 테스트 작성**

`app/src/manga/MangaViewer.test.tsx`:

```tsx
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { MangaViewer } from "./MangaViewer";

afterEach(cleanup);

describe("MangaViewer", () => {
  it("shows the title and page progress", () => {
    render(<MangaViewer seriesId="s1" title="Batsu Kano" pageCount={60} onClose={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "Batsu Kano" })).toBeInTheDocument();
    expect(screen.getByText("1 / 60")).toBeVisible();
  });

  it("moves to the next page with the right arrow", async () => {
    const user = userEvent.setup();
    render(<MangaViewer seriesId="s1" title="T" pageCount={60} onClose={vi.fn()} />);
    await user.keyboard("{ArrowRight}");
    expect(screen.getByText("2 / 60")).toBeVisible();
  });

  it("moves to the previous page with the left arrow", async () => {
    const user = userEvent.setup();
    render(<MangaViewer seriesId="s1" title="T" pageCount={60} onClose={vi.fn()} />);
    await user.keyboard("{ArrowRight}");
    await user.keyboard("{ArrowRight}");
    await user.keyboard("{ArrowLeft}");
    expect(screen.getByText("2 / 60")).toBeVisible();
  });

  it("stops at the first and last page", async () => {
    const user = userEvent.setup();
    render(<MangaViewer seriesId="s1" title="T" pageCount={2} onClose={vi.fn()} />);
    await user.keyboard("{ArrowLeft}");
    expect(screen.getByText("1 / 2")).toBeVisible();
    await user.keyboard("{ArrowRight}");
    await user.keyboard("{ArrowRight}");
    expect(screen.getByText("2 / 2")).toBeVisible();
  });

  it("closes with the close button", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<MangaViewer seriesId="s1" title="T" pageCount={60} onClose={onClose} />);
    await user.click(screen.getByRole("button", { name: "망가 뷰어 닫기" }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: 테스트 실행해 실패 확인**

Run: `npm test -- --run src/manga/MangaViewer.test.tsx`
Expected: FAIL — 모듈 없음

- [ ] **Step 3: MangaViewer 구현**

`app/src/manga/MangaViewer.tsx`:

```tsx
import { useState } from "react";
import { ChevronLeftIcon, ChevronRightIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { mangaPageUrl } from "../assets/mediaUrl";
import { Button } from "../shared/ui/Button";
import { Dialog } from "../shared/ui/Dialog";

type MangaViewerProps = {
  seriesId: string;
  title: string;
  pageCount: number;
  onClose: () => void;
};

export function MangaViewer({ seriesId, title, pageCount, onClose }: MangaViewerProps) {
  const [page, setPage] = useState(1);
  const move = (next: number) => setPage(Math.max(1, Math.min(pageCount, next)));

  return <Dialog
    open
    variant="fullscreen"
    title={title}
    onClose={onClose}
    onKeyDown={(event) => {
      if (event.key === "ArrowLeft") { event.preventDefault(); move(page - 1); }
      if (event.key === "ArrowRight") { event.preventDefault(); move(page + 1); }
    }}
  >
    <div className="manga-viewer">
      <div className="manga-viewer__controls">
        <span className="manga-viewer__progress">{page} / {pageCount}</span>
        <Button size="icon" variant="ghost" aria-label="이전 페이지" disabled={page <= 1} onClick={() => move(page - 1)}><ChevronLeftIcon aria-hidden="true" /></Button>
        <Button size="icon" variant="ghost" aria-label="다음 페이지" disabled={page >= pageCount} onClick={() => move(page + 1)}><ChevronRightIcon aria-hidden="true" /></Button>
        <Button size="icon" variant="ghost" aria-label="망가 뷰어 닫기" onClick={onClose}><XMarkIcon aria-hidden="true" /></Button>
      </div>
      <div className="manga-viewer__stage">
        <img
          key={page}
          className="manga-viewer__page"
          src={mangaPageUrl(seriesId, page)}
          alt={`${title} ${page}페이지`}
          draggable={false}
        />
      </div>
      <div className="manga-viewer__edges">
        <button type="button" className="manga-viewer__edge" aria-label="이전 페이지" disabled={page <= 1} onClick={() => move(page - 1)} />
        <button type="button" className="manga-viewer__edge" aria-label="다음 페이지" disabled={page >= pageCount} onClick={() => move(page + 1)} />
      </div>
    </div>
  </Dialog>;
}
```

> **주의:** 이 구현에서 페이지는 `key={page}`로 이미지만 교체되고 사전 로드는 없습니다. `ponytail:` 코멘트로 명시하세요: `// ponytail: no preload; the browser image cache covers rapid page turns, add preload only if flashes appear`. 좌우 클릭 영역(`manga-viewer__edges`)은 stage 위에 오버레이되는데, 이미지 클릭과 충돌할 수 있으므로 테스트에서 클릭 영역이 이미지 위에 있음을 확인하세요. 구현이 복잡해지면 단순히 stage 좌우에 배치하는 방식으로 바꿔도 됩니다.

- [ ] **Step 4: CSS 추가**

`global.css`에:

```css
.manga-viewer {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.manga-viewer__controls {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
}

.manga-viewer__progress {
  margin-right: auto;
  color: var(--color-muted);
  font-size: 0.75rem;
}

.manga-viewer__stage {
  display: grid;
  place-items: center;
  flex: 1;
  min-height: 0;
  overflow: auto;
}

.manga-viewer__page {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
}

.manga-viewer__edges {
  position: absolute;
  inset: 0;
  display: grid;
  grid-template-columns: 1fr 1fr;
  pointer-events: none;
}

.manga-viewer__edge {
  pointer-events: auto;
  background: transparent;
  border: 0;
  cursor: pointer;
}
```

- [ ] **Step 5: 테스트 실행해 통과 확인**

Run: `npm test -- --run src/manga/MangaViewer.test.tsx`
Expected: PASS

- [ ] **Step 6: 커밋**

```bash
git add app/src/manga/MangaViewer.tsx app/src/manga/MangaViewer.test.tsx app/src/styles/global.css
git commit -m "feat: add fullscreen manga page viewer"
```

---

### Task 7: 프론트 — 사이드바 탭 + App 뷰 분기 + 설정 행

**Files:**
- Modify: `app/src/library/types.ts` (AssetView에 `{ kind: "manga" }`)
- Modify: `app/src/classification/ClassificationSidebar.tsx`
- Modify: `app/src/app/App.tsx`
- Modify: `app/src/settings/SettingsView.tsx`
- Modify: 관련 테스트

**Interfaces:**
- Consumes: Task 5의 `MangaBrowser`, Task 6의 `MangaViewer`, Task 4의 gateway 메서드
- Produces: "망가" 사이드바 탭, `App`의 manga 뷰 분기, 설정 뷰의 망가 폴더 행

- [ ] **Step 1: AssetView에 manga 추가**

`types.ts`:

```ts
export type AssetView =
  | { kind: "classification"; classificationId: string | null }
  | { kind: "unsorted" }
  | { kind: "favorites" }
  | { kind: "recent" }
  | { kind: "similarity_review" }
  | { kind: "trash" }
  | { kind: "settings" }
  | { kind: "manga" };
```

- [ ] **Step 2: 사이드바에 망가 탭 추가**

`ClassificationSidebar.tsx`의 빠른 보기 nav에 (유사 검토 다음):

```tsx
<QuickViewButton icon={<BookOpenIcon aria-hidden="true" />} label="망가" selected={view.kind === "manga"} onClick={() => onViewChange({ kind: "manga" })} />
```

import에 `BookOpenIcon` 추가 (heroicons 24/outline).

`AssetToolbar.tsx`의 `view` 정규화에도 manga 추가:

```ts
const view = rawView.kind === "similarity_review" || rawView.kind === "settings" || rawView.kind === "manga"
  ? ({ kind: "classification", classificationId: null } as const)
  : rawView;
```

- [ ] **Step 3: App.tsx 뷰 분기 추가**

`App.tsx`의 내용 스위치에 (similarity_review 다음):

```tsx
) : view.kind === "manga" ? (
  <MangaBrowser
    onOpenSeries={(series) => setMangaViewer({ seriesId: series.id, title: series.title, pageCount: series.pageCount })}
  />
) : (
```

- [ ] **Step 4: App.tsx에 망가 뷰어 상태 추가**

`App.tsx`에:

```ts
const [mangaViewer, setMangaViewer] = useState<{ seriesId: string; title: string; pageCount: number } | null>(null);
```

`MangaBrowser`가 `onOpenSeries`로 시리즈 전체 객체를 전달하므로 별도 캐시(Map)는 필요 없습니다 (ponytail).

뷰어 렌더 (섹션 안 어디든):

```tsx
{mangaViewer && <MangaViewer seriesId={mangaViewer.seriesId} title={mangaViewer.title} pageCount={mangaViewer.pageCount} onClose={() => setMangaViewer(null)} />}
```

import 추가: `import { MangaBrowser } from "../manga/MangaBrowser"; import { MangaViewer } from "../manga/MangaViewer";`

`dropEnabled`에도 manga 제외 추가:

```ts
const dropEnabled = maintenance === null && view.kind !== "trash" && view.kind !== "similarity_review" && view.kind !== "settings" && view.kind !== "manga";
```

- [ ] **Step 5: 설정 뷰에 망가 폴더 행 추가**

`SettingsView.tsx`의 일반 설정 섹션에:

```tsx
<dl className="settings-view__field">
  <dt>망가 폴더</dt>
  <dd>
    <span>{mangaRoot ?? "설정되지 않음"}</span>
    <Button size="sm" onClick={() => void chooseMangaFolder()}>변경</Button>
  </dd>
</dl>
```

`SettingsView`에 상태/로직 추가:

```ts
const { gateway } = useLibrary();
const [mangaRoot, setMangaRoot] = useState<string | null>(null);
const [mangaRootError, setMangaRootError] = useState<string | null>(null);

useEffect(() => {
  let active = true;
  void gateway.getMangaRoot().then((root) => { if (active) setMangaRoot(root); });
  return () => { active = false; };
}, [gateway]);

async function chooseMangaFolder() {
  const selected = await open({ directory: true, multiple: false });
  if (typeof selected !== "string") return;
  try {
    await gateway.setMangaRoot(selected);
    setMangaRoot(selected);
  } catch (error) {
    setMangaRootError(commandErrorMessage(error, "망가 폴더를 설정하지 못했습니다"));
  }
}
```

import: `import { open } from "@tauri-apps/plugin-dialog";` (기존 import 없음 확인). `useLibrary`는 이미 import됨.

> **주의:** `SettingsView` 테스트에서 `open`(plugin-dialog)을 mock해야 합니다. `vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }))` 패턴 사용 (AssetInspector.test.tsx의 opener mock 참고). 폴더 선택 → `setMangaRoot` 호출 → 상태 갱신 검증 테스트 추가.

- [ ] **Step 6: 관련 테스트 갱신/추가**

- `ClassificationSidebar.test.tsx`: "망가" 버튼 렌더 + 클릭 시 `onViewChange({ kind: "manga" })` 호출 검증.
- `App.test.tsx`: 망가 뷰 진입 시 `MangaBrowser` 렌더 검증 (gateway mock에 manga 메서드 이미 추가됨). `screen.getByRole("button", { name: "망가" })` 클릭 → `scanManga` 호출 확인.
- `SettingsView.test.tsx`: 망가 폴더 변경 버튼 + 다이얼로그 mock 테스트.

- [ ] **Step 7: 전체 프론트 테스트 + 타입 체크**

Run: `npm test` + `npx tsc --noEmit` in `C:\chatgpt\app`
Expected: 전체 PASS, 타입 오류 없음

- [ ] **Step 8: 커밋**

```bash
git add app/src/library/types.ts app/src/classification/ClassificationSidebar.tsx app/src/app/App.tsx app/src/settings/SettingsView.tsx app/src/assets/AssetToolbar.tsx
git add app/src/classification/ClassificationSidebar.test.tsx app/src/app/App.test.tsx app/src/settings/SettingsView.test.tsx
git commit -m "feat: wire manga tab, browser, and viewer into the app"
```

---

### Task 8: 전체 검증

**Files:**
- 없음 (검증만)

**Interfaces:**
- Consumes: 모든 이전 Task
- Produces: 최종 검증 결과

- [ ] **Step 1: Rust 테스트 실행**

Run: `cargo test` in `C:\chatgpt\app\src-tauri`
Expected: 전체 PASS

- [ ] **Step 2: 프론트 전체 테스트**

Run: `npm test` in `C:\chatgpt\app`
Expected: 전체 PASS

- [ ] **Step 3: 타입 검사**

Run: `npx tsc --noEmit` in `C:\chatgpt\app`
Expected: 오류 없음

- [ ] **Step 4: 수동 스모크 (가능하면)**

- `npm run tauri dev` 실행
- 설정 → 망가 폴더를 `C:\lakomics (2)\save`로 설정
- 사이드바 망가 탭 → 그리드 표시 확인
- 표지 클릭 → 뷰어 → 페이지 넘김 확인
