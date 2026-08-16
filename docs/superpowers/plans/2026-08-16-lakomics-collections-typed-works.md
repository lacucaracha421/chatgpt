# Lakomics 컬렉션(타입별 작품) 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 게임·만화·영화 타입별 메타데이터와 쇼케이스를 갖춘 컬렉션 기능을 백엔드부터 프론트엔드까지 구현한다. 외부 API 연동과 레거시 마이그레이션은 이 계획에서 제외한다.

**Architecture:** 기존 자산 중심 미디어 금고 모델을 유지한다. `collections` 테이블에 타입·메타데이터·쇼케이스·외부 ID 자리를 평평하게 추가하고, `collection_assets` 다대다 관계는 그대로 둔다. 프론트엔드는 빠른 보기 "컬렉션" 버튼 → 전용 `CollectionBrowser` 표지 그리드(타입 전환/쇼케이스) → `AssetBrowser` 재사용 상세로 이어진다. 메타데이터 편집은 `Dialog`, 자산 멤버십은 인스펙터 체크박스(앨범 패턴)로 처리한다.

**Tech Stack:** Rust(Tauri, rusqlite, serde), React 19, TypeScript, Vite, Vitest, Testing Library

## Global Constraints

- Windows 전용(Tauri). PowerShell 5.1 환경. npm 스크립트는 `cmd.exe /c npm run ...`으로 실행(PowerShell 실행 정책 우회).
- Rust 테스트: `cargo test --no-default-features`(workdir: `app/src-tauri`).
- 프론트엔드 테스트: `npx vitest run`(workdir: `app`). 전체 검증: `cmd.exe /c npm run check`(= test + build).
- 모든 사용자 노출 문자열은 한국어. 코드 주석은 작성하지 않는다(프로젝트 규칙).
- DESIGN.md 준수: radius 0~2px(미디어)/3~4px(버튼), shadow는 floating 요소만, hover scale/translate 금지, 카드 wrapper 남발 금지, 부제 금지.
- serde rename_all = "camelCase" / "snake_case" 규칙은 기존 모델을 따른다.
- 외부 API 연동(reqwest 등)은 이 계획에 포함하지 않는다. 스키마에 자리만 만든다.

---

## 파일 구조

### 백엔드(Rust)

| 파일 | 책임 |
|---|---|
| `app/src-tauri/migrations/0011_collections_typed_metadata.sql` | 신규: `collections` 컬럼 확장 + 인덱스 + user_version 11 |
| `app/src-tauri/src/library/db.rs` | 수정: SCHEMA_VERSION 11, 마이그레이션 단계 추가, 테스트 버전 갱신 |
| `app/src-tauri/src/library/models.rs` | 수정: `CollectionType`, `CollectionSummary`/`CreateCollection`/`UpdateCollection` 필드 확장 |
| `app/src-tauri/src/library/error.rs` | 수정: `InvalidCollectionType` 에러 추가 |
| `app/src-tauri/src/library/collection.rs` | 수정: 조회/생성/수정 SQL, `set_collection_showcase`, 검증, 테스트 |
| `app/src-tauri/src/commands.rs` | 수정: `update_collection` 시그니처, `set_collection_showcase` 명령, 등록 |
| `app/src-tauri/src/lib.rs` | 수정: `invoke_handler`에 `set_collection_showcase` 등록 |
| `app/src-tauri/tests/foundation_flow.rs` | 수정: `user_version` 11 |

### 프론트엔드(React/TS)

| 파일 | 책임 |
|---|---|
| `app/src/library/types.ts` | 수정: 컬렉션 타입/모델, `AssetQuery.collectionId`, `AssetView` 변형, `LibraryGateway` 메서드 |
| `app/src/library/client.ts` | 수정: 컬렉션 명령 래핑 |
| `app/src/app/App.tsx` | 수정: 컬렉션 상태/새로고침/뷰 전환 |
| `app/src/classification/ClassificationSidebar.tsx` | 수정: 빠른 보기 "컬렉션" 버튼 |
| `app/src/collections/CollectionCard.tsx` | 신규: 표지 카드 |
| `app/src/collections/CollectionEditDialog.tsx` | 신규: 생성/편집 다이얼로그(이름+설명+타입+타입별 메타데이터) |
| `app/src/collections/CollectionBrowser.tsx` | 신규: 표지 그리드, 타입 전환 세그먼트, 쇼케이스 토글, CRUD 진입 |
| `app/src/collections/CollectionBrowser.test.tsx` | 신규: 목록/빈 상태/생성/편집/삭제/타입 전환/쇼케이스 테스트 |
| `app/src/assets/AssetBrowser.tsx` | 수정: `collectionId` 범위, 툴바 타이틀, 배치 액션, 빈 상태 |
| `app/src/assets/AssetToolbar.tsx` | 수정: 컬렉션 상세 타이틀, "이 컬렉션에서 제거"/"대표 이미지로 지정" |
| `app/src/assets/AssetInspector.tsx` | 수정: 컬렉션 체크박스 목록 + 컬렉션 메타데이터 표시 |
| `app/src/styles/global.css` | 수정: `.collection-*` 스타일 |

---

### Task 1: 백엔드 스키마 마이그레이션 0011

**Files:**
- Create: `app/src-tauri/migrations/0011_collections_typed_metadata.sql`
- Modify: `app/src-tauri/src/library/db.rs:7`, `db.rs:19`, `db.rs:30`, `db.rs:76-78`, `db.rs:147`, `db.rs:201`, `db.rs:243`
- Modify: `app/src-tauri/tests/foundation_flow.rs:294,344,367`
- Modify: `app/src-tauri/src/library/backup.rs:822` (버전 11 -> 12)
- Modify: `app/src-tauri/src/library/mod.rs:468` (버전 9 -> 11)

**Interfaces:**
- Produces: `collections` 테이블에 신규 컬럼(`type`, `year`, `author`, `director`, `external_score`, `my_score`, `genres`, `overview`, `external_id`, `external_source`, `external_synced_at`, `showcase`, `external_metadata_json`) 추가. `SCHEMA_VERSION = 11`.

- [ ] **Step 1: 마이그레이션 SQL 작성**

`app/src-tauri/migrations/0011_collections_typed_metadata.sql`:

```sql
ALTER TABLE collections ADD COLUMN type TEXT NOT NULL DEFAULT 'manga';
ALTER TABLE collections ADD COLUMN year INTEGER;
ALTER TABLE collections ADD COLUMN author TEXT;
ALTER TABLE collections ADD COLUMN director TEXT;
ALTER TABLE collections ADD COLUMN external_score INTEGER;
ALTER TABLE collections ADD COLUMN my_score INTEGER;
ALTER TABLE collections ADD COLUMN genres TEXT;
ALTER TABLE collections ADD COLUMN overview TEXT;
ALTER TABLE collections ADD COLUMN external_id TEXT;
ALTER TABLE collections ADD COLUMN external_source TEXT;
ALTER TABLE collections ADD COLUMN external_synced_at TEXT;
ALTER TABLE collections ADD COLUMN showcase INTEGER NOT NULL DEFAULT 0;
ALTER TABLE collections ADD COLUMN external_metadata_json TEXT;

CREATE INDEX collections_by_type ON collections(type);
CREATE INDEX collections_by_showcase ON collections(showcase) WHERE showcase = 1;

PRAGMA user_version = 11;
```

- [ ] **Step 2: db.rs 갱신**

`SCHEMA_VERSION`을 `11`로 변경. `COLLECTIONS_TYPED_SCHEMA` 상수 추가. 마이그레이션에 `if version <= 10 { transaction.execute_batch(COLLECTIONS_TYPED_SCHEMA)?; }` 추가. `match` 범위를 `0..=10`으로 변경.

```rust
pub(crate) const SCHEMA_VERSION: i64 = 11;
// ...
const COLLECTIONS_TYPED_SCHEMA: &str = include_str!("../../migrations/0011_collections_typed_metadata.sql");
```

마이그레이션 본문에 추가(0010 뒤):

```rust
if version <= 10 {
    transaction.execute_batch(COLLECTIONS_TYPED_SCHEMA)?;
}
```

`match version` 범위: `version @ 0..=10 => {`

db.rs 테스트의 `user_version` 기대값 3곳을 `11`로 변경.

- [ ] **Step 3: 나머지 버전 참조 갱신**

`backup.rs:822`: `PRAGMA user_version = 11;` -> `12;` (지원하지 않는 버전 테스트)
`mod.rs:468`: `assert_eq!(version, 9);` -> `assert_eq!(version, 11);`
`foundation_flow.rs` 3곳: `user_version(&library), 10` -> `11`

- [ ] **Step 4: 테스트 실행**

Run: `cargo test --no-default-features --lib -- --test-threads=1`
Expected: PASS (마이그레이션 포함). 단, collection.rs 모델 변경 전이므로 collection 관련 테스트는 다음 태스크에서.

실제로는 모델/SQL 변경이 동반되므로 Task 2-3과 함께 컴파일되어야 함. 이 태스크는 SQL+버전만 우선 작성하고 컴파일은 Task 3 이후에 확인.

- [ ] **Step 5: 커밋**

```bash
git add app/src-tauri/migrations/0011_collections_typed_metadata.sql app/src-tauri/src/library/db.rs app/src-tauri/src/library/backup.rs app/src-tauri/src/library/mod.rs app/src-tauri/tests/foundation_flow.rs
git commit -m "feat: add typed collection metadata schema migration"
```

---

### Task 2: 백엔드 모델 + 에러 확장

**Files:**
- Modify: `app/src-tauri/src/library/models.rs:339-371`
- Modify: `app/src-tauri/src/library/error.rs` (컬렉션 에러 영역)
- Modify: `app/src-tauri/src/commands.rs:79-85` (에러 매핑)

**Interfaces:**
- Produces:
  - `CollectionType` enum (`Game`, `Manga`, `Movie`) — serde rename_all = "snake_case"
  - `CollectionSummary { id, name, description: Option<String>, type: CollectionType, cover_asset_id: Option<String>, asset_count: u64, year: Option<i64>, author: Option<String>, director: Option<String>, external_score: Option<i64>, my_score: Option<i64>, genres: Option<String>, overview: Option<String>, external_id: Option<String>, external_source: Option<String>, external_synced_at: Option<String>, showcase: bool, created_at, updated_at }`
  - `CreateCollection { name, description: Option<String>, collection_type: CollectionType }`
  - `UpdateCollection { name, description: Option<String>, collection_type: CollectionType, year: Option<i64>, author: Option<String>, director: Option<String>, external_score: Option<i64>, my_score: Option<i64>, genres: Option<String>, overview: Option<String> }`
  - `LibraryError::InvalidCollectionType`

- [ ] **Step 1: models.rs 수정**

`CollectionSummary` 위에 `CollectionType` 추가:

```rust
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CollectionType {
    Game,
    Manga,
    Movie,
}
```

`CollectionSummary` 교체:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CollectionSummary {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    #[serde(rename = "type")]
    pub collection_type: CollectionType,
    pub cover_asset_id: Option<String>,
    pub asset_count: u64,
    pub year: Option<i64>,
    pub author: Option<String>,
    pub director: Option<String>,
    pub external_score: Option<i64>,
    pub my_score: Option<i64>,
    pub genres: Option<String>,
    pub overview: Option<String>,
    pub external_id: Option<String>,
    pub external_source: Option<String>,
    pub external_synced_at: Option<String>,
    pub showcase: bool,
    pub created_at: String,
    pub updated_at: String,
}
```

`CreateCollection` 교체:

```rust
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateCollection {
    pub name: String,
    pub description: Option<String>,
    #[serde(rename = "type")]
    pub collection_type: CollectionType,
}
```

`UpdateCollection` 교체:

```rust
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCollection {
    pub name: String,
    pub description: Option<String>,
    #[serde(rename = "type")]
    pub collection_type: CollectionType,
    pub year: Option<i64>,
    pub author: Option<String>,
    pub director: Option<String>,
    pub external_score: Option<i64>,
    pub my_score: Option<i64>,
    pub genres: Option<String>,
    pub overview: Option<String>,
}
```

`AssetCollectionPatch`는 변경 없음(이미 존재).

- [ ] **Step 2: error.rs 에러 추가**

컬렉션 에러 그룹에 추가:

```rust
#[error("지원하지 않는 컬렉션 유형입니다")]
InvalidCollectionType,
```

- [ ] **Step 3: commands.rs 에러 매핑 추가**

`DuplicateCollectionName` 뒤에:

```rust
LibraryError::CollectionCoverNotMember => "collection_cover_not_member",
LibraryError::InvalidCollectionType => "invalid_collection_type",
```

- [ ] **Step 4: 컴파일 확인**

이 시점에서 `collection.rs`가 새 필드를 아직 사용하지 않아 `collection_from_row` 등이 깨짐. 컴파일은 Task 3 완료 후 확인. 태스크 2 단독 컴파일 불가 — Task 3과 묶어서 커밋.

- [ ] **Step 5: (Task 3과 함께 커밋)**

---

### Task 3: 백엔드 collection.rs CRUD 확장 + 쇼케이스

**Files:**
- Modify: `app/src-tauri/src/library/collection.rs` (전체)

**Interfaces:**
- Consumes: `CollectionType`, 확장된 `CollectionSummary`/`CreateCollection`/`UpdateCollection`
- Produces: `Library::list_collections`, `create_collection`, `update_collection`, `delete_collection`, `set_collection_cover`, `set_collection_showcase`, `patch_asset_collections`, `get_asset_collections`

- [ ] **Step 1: 조회 SQL 확장**

`COLLECTION_SUMMARY_SQL`을 새 컬럼을 선택하도록 교체. `showcase`는 INTEGER 0/1을 bool로 변환:

```rust
const COLLECTION_SUMMARY_SQL: &str = "SELECT
    collection.id,
    collection.name,
    collection.description,
    collection.type,
    collection.cover_asset_id,
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
    collection.updated_at
FROM collections AS collection";
```

표지 fallback 로직(기존 COALESCE)은 `cover_asset_id` 결정에 그대로 사용하되, 위 SQL에 `cover_asset_id` 컬럼 자체는 fallback 결과를 반환하도록 기존 COALESCE 식 유지. 위 단순화된 `collection.cover_asset_id` 자리에 기존 COALESCE(명시적 cover 검증 + fallback 첫 자산) 식을 그대로 넣는다(기존 코드 참조).

`collection_from_row` 갱신:

```rust
fn collection_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<CollectionSummary> {
    let type_str: String = row.get(3)?;
    let collection_type = match type_str.as_str() {
        "game" => CollectionType::Game,
        "movie" => CollectionType::Movie,
        _ => CollectionType::Manga,
    };
    let showcase_int: i64 = row.get(16)?;
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
    })
}
```

컬럼 인덱스는 실제 SELECT 순서에 맞춰 조정할 것(cover fallback COALESCE가 한 컬럼으로 들어가므로 인덱스 재계산 필요). 구현 시 SELECT 순서와 `row.get` 인덱스를 일치시킨다.

- [ ] **Step 2: create_collection 확장**

```rust
pub fn create_collection(
    &self,
    request: CreateCollection,
) -> Result<CollectionSummary, LibraryError> {
    let name = normalized_name(request.name)?;
    let description = normalized_description(request.description)?;
    let type_str = collection_type_str(request.collection_type);
    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();
    let connection = self.connection()?;
    connection
        .execute(
            "INSERT INTO collections (
                id, name, description, type, cover_asset_id,
                year, author, director, external_score, my_score,
                genres, overview, external_id, external_source, external_synced_at,
                showcase, external_metadata_json, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, NULL,
                NULL, NULL, NULL, NULL, NULL,
                NULL, NULL, NULL, NULL, NULL,
                0, NULL, ?5, ?5)",
            params![id, name, description, type_str, now],
        )
        .map_err(map_duplicate_name)?;
    collection_by_id(&connection, &id)
}
```

`collection_type_str` 헬퍼 추가:

```rust
fn collection_type_str(collection_type: CollectionType) -> &'static str {
    match collection_type {
        CollectionType::Game => "game",
        CollectionType::Manga => "manga",
        CollectionType::Movie => "movie",
    }
}
```

- [ ] **Step 3: update_collection 확장**

```rust
pub fn update_collection(
    &self,
    id: &str,
    request: UpdateCollection,
) -> Result<CollectionSummary, LibraryError> {
    let name = normalized_name(request.name)?;
    let description = normalized_description(request.description)?;
    let type_str = collection_type_str(request.collection_type);
    let connection = self.connection()?;
    let changed = connection
        .execute(
            "UPDATE collections
             SET name = ?1, description = ?2, type = ?3,
                 year = ?4, author = ?5, director = ?6,
                 external_score = ?7, my_score = ?8,
                 genres = ?9, overview = ?10,
                 updated_at = ?11
             WHERE id = ?12",
            params![
                name, description, type_str,
                request.year, request.author, request.director,
                request.external_score, request.my_score,
                request.genres, request.overview,
                chrono::Utc::now().to_rfc3339(), id
            ],
        )
        .map_err(map_duplicate_name)?;
    if changed == 0 {
        return Err(LibraryError::CollectionNotFound);
    }
    collection_by_id(&connection, id)
}
```

- [ ] **Step 4: set_collection_showcase 추가**

```rust
pub fn set_collection_showcase(
    &self,
    collection_id: &str,
    showcase: bool,
) -> Result<CollectionSummary, LibraryError> {
    let connection = self.connection()?;
    require_collection(&connection, collection_id)?;
    let changed = connection.execute(
        "UPDATE collections SET showcase = ?1, updated_at = ?2 WHERE id = ?3",
        params![if showcase { 1 } else { 0 }, chrono::Utc::now().to_rfc3339(), collection_id],
    )?;
    if changed == 0 {
        return Err(LibraryError::CollectionNotFound);
    }
    collection_by_id(&connection, collection_id)
}
```

- [ ] **Step 5: import 정리**

`collection.rs` 상단 import에 `CollectionType` 추가:

```rust
use super::{
    error::LibraryError,
    models::{
        AssetCollectionPatch, CollectionSummary, CollectionType, CreateCollection,
        UpdateCollection,
    },
    validated_asset_ids, Library,
};
```

- [ ] **Step 6: 테스트 갱신**

기존 테스트(`creates_updates_lists_and_deletes_collection_without_deleting_assets` 등)가 새 필드로 동작하도록 보조 헬퍼 `create`/`insert_asset` 갱신. `create` 헬퍼에 타입 전달:

```rust
fn create(library: &Library, name: &str) -> crate::library::models::CollectionSummary {
    library
        .create_collection(CreateCollection {
            name: name.into(),
            description: None,
            collection_type: CollectionType::Manga,
        })
        .unwrap()
}
```

기존 테스트의 `CreateCollection`/`UpdateCollection` 리터럴에 `collection_type: CollectionType::Manga` 추가. 신규 테스트 추가:

```rust
#[test]
fn update_collection_persists_typed_metadata_and_showcase() {
    let temp = tempfile::tempdir().unwrap();
    let library = Library::open(temp.path()).unwrap();
    let created = library
        .create_collection(CreateCollection {
            name: "Astral Chain".into(),
            description: None,
            collection_type: CollectionType::Game,
        })
        .unwrap();
    assert_eq!(created.collection_type, CollectionType::Game);
    assert!(!created.showcase);

    let updated = library
        .update_collection(
            &created.id,
            UpdateCollection {
                name: "Astral Chain".into(),
                description: Some("액션 게임".into()),
                collection_type: CollectionType::Game,
                year: Some(2019),
                author: Some("PlatinumGames".into()),
                director: None,
                external_score: Some(87),
                my_score: Some(9),
                genres: None,
                overview: None,
            },
        )
        .unwrap();
    assert_eq!(updated.year, Some(2019));
    assert_eq!(updated.author.as_deref(), Some("PlatinumGames"));
    assert_eq!(updated.external_score, Some(87));

    let showcased = library
        .set_collection_showcase(&created.id, true)
        .unwrap();
    assert!(showcased.showcase);
    assert_eq!(library.list_collections().unwrap()[0].showcase, true);
}
```

- [ ] **Step 7: 테스트 실행**

Run: `cargo test --no-default-features --lib`
Expected: PASS

- [ ] **Step 8: 커밋**

```bash
git add app/src-tauri/src/library/models.rs app/src-tauri/src/library/error.rs app/src-tauri/src/commands.rs app/src-tauri/src/library/collection.rs
git commit -m "feat: extend collection model with type metadata and showcase"
```

---

### Task 4: 백엔드 명령 레이어 — set_collection_showcase + 시그니처 정리

**Files:**
- Modify: `app/src-tauri/src/commands.rs` (컬렉션 명령 영역)
- Modify: `app/src-tauri/src/lib.rs:64-70` (invoke_handler 등록)

**Interfaces:**
- Produces(Tauri command): `list_collections`, `create_collection`, `update_collection`, `delete_collection`, `set_collection_cover`, `set_collection_showcase`, `get_asset_collections`, `patch_asset_collections`

- [ ] **Step 1: commands.rs 컬렉션 명령 갱신**

기존 `create_collection`/`update_collection` 시그니처는 이미 존재하지만 `CreateCollection`/`UpdateCollection`이 새 필드를 받으므로 자동 반영. `set_collection_showcase` 명령 추가(`patch_asset_collections` 뒤):

```rust
#[tauri::command]
pub fn set_collection_showcase(
    collection_id: String,
    showcase: bool,
    state: State<'_, AppState>,
) -> Result<CollectionSummary, CommandError> {
    current_required(state)?
        .set_collection_showcase(&collection_id, showcase)
        .map_err(CommandError::from)
}
```

import에 `UpdateCollection`/`CollectionType`가 이미 포함되어 있는지 확인(Task 2/3에서 `CollectionSummary` 등 추가됨). 부족하면 보강.

- [ ] **Step 2: lib.rs invoke_handler 등록**

`patch_asset_collections` 뒤에 추가:

```rust
commands::patch_asset_collections,
commands::set_collection_showcase,
```

- [ ] **Step 3: 컴파일 + 테스트**

Run: `cargo test --no-default-features --lib`
Expected: PASS

- [ ] **Step 4: 커밋**

```bash
git add app/src-tauri/src/commands.rs app/src-tauri/src/lib.rs
git commit -m "feat: expose set_collection_showcase command"
```

---

### Task 5: 프론트엔드 타입 + 게이트웨이 인터페이스

**Files:**
- Modify: `app/src/library/types.ts`
- Modify: `app/src/library/client.ts`

**Interfaces:**
- Produces(TS): `CollectionType`, `CollectionSummary`, `CreateCollection`, `UpdateCollection`, `AssetCollectionPatch`, `AssetQuery.collectionId`, `AssetView` 변형(`collections`/`collection`), `LibraryGateway` 컬렉션 메서드

- [ ] **Step 1: types.ts 타입 추가**

`AlbumEntry` 뒤에 추가:

```ts
export type CollectionType = "game" | "manga" | "movie";

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
};

export type CreateCollection = {
  name: string;
  description: string | null;
  type: CollectionType;
};

export type UpdateCollection = {
  name: string;
  description: string | null;
  type: CollectionType;
  year: number | null;
  author: string | null;
  director: string | null;
  externalScore: number | null;
  myScore: number | null;
  genres: string | null;
  overview: string | null;
};

export type AssetCollectionPatch = {
  assetIds: string[];
  addCollectionIds: string[];
  removeCollectionIds: string[];
};
```

`AssetQuery`에 `collectionId` 추가:

```ts
export type AssetQuery = {
  classificationId: string | null;
  albumId: string | null;
  collectionId: string | null;
  directOnly: boolean;
  favoriteOnly: boolean;
  unclassifiedOnly: boolean;
  sort: AssetSort;
  randomPivot: string | null;
  after: AssetCursor | null;
  limit: number;
};
```

`AssetView` 변형 추가(기존 `manga` 뒤에):

```ts
  | { kind: "collections"; typeFilter: CollectionType | null; showcase: boolean }
  | { kind: "collection"; collectionId: string }
```

`LibraryGateway`에 컬렉션 메서드 추가(`getAssetAlbums` 뒤):

```ts
  listCollections(): Promise<CollectionSummary[]>;
  createCollection(input: CreateCollection): Promise<CollectionSummary>;
  updateCollection(id: string, input: UpdateCollection): Promise<CollectionSummary>;
  deleteCollection(id: string): Promise<void>;
  setCollectionCover(collectionId: string, assetId: string | null): Promise<CollectionSummary>;
  setCollectionShowcase(collectionId: string, showcase: boolean): Promise<CollectionSummary>;
  getAssetCollections(assetId: string): Promise<string[]>;
  patchAssetCollections(patch: AssetCollectionPatch): Promise<void>;
```

- [ ] **Step 2: client.ts 래핑 추가**

`patchAssetAlbums`/`getAssetAlbums` 뒤에 추가:

```ts
  listCollections: () => invoke<CollectionSummary[]>("list_collections"),
  createCollection: (input: CreateCollection) =>
    invoke<CollectionSummary>("create_collection", { request: input }),
  updateCollection: (id: string, input: UpdateCollection) =>
    invoke<CollectionSummary>("update_collection", { id, request: input }),
  deleteCollection: (id: string) => invoke<void>("delete_collection", { id }),
  setCollectionCover: (collectionId: string, assetId: string | null) =>
    invoke<CollectionSummary>("set_collection_cover", { collectionId, assetId }),
  setCollectionShowcase: (collectionId: string, showcase: boolean) =>
    invoke<CollectionSummary>("set_collection_showcase", { collectionId, showcase }),
  getAssetCollections: (assetId: string) =>
    invoke<string[]>("get_asset_collections", { assetId }),
  patchAssetCollections: (patch: AssetCollectionPatch) =>
    invoke<void>("patch_asset_collections", { patch }),
```

client.ts import에 `CollectionSummary`, `CreateCollection`, `UpdateCollection`, `AssetCollectionPatch` 추가.

- [ ] **Step 3: 타입체크**

Run: `cmd.exe /c npx tsc --noEmit`
Expected: 기존 `AssetQuery` 사용처(`AssetBrowser.tsx:55`, 테스트들)에서 `collectionId` 누락 에러 발생(다음 태스크에서 수정). 일단 타입 정의 자체는 통과.

- [ ] **Step 4: 커밋**

```bash
git add app/src/library/types.ts app/src/library/client.ts
git commit -m "feat: add collection types and gateway client methods"
```

---

### Task 6: AssetBrowser — collectionId 범위 + 빈 상태

**Files:**
- Modify: `app/src/assets/AssetBrowser.tsx:55-57`, `:213`

**Interfaces:**
- Consumes: `AssetView`의 `collection` 변형, `AssetQuery.collectionId`
- Produces: `AssetBrowser`가 `{ kind: "collection"; collectionId }`를 처리

- [ ] **Step 1: queryBase에 collectionId 추가**

`AssetBrowser.tsx`의 `queryBase`(`useMemo`)에 추가:

```ts
const queryBase = useMemo<Omit<AssetQuery, "after">>(() => ({
  classificationId: view.kind === "classification" ? view.classificationId : null,
  albumId: view.kind === "album" ? view.albumId : null,
  collectionId: view.kind === "collection" ? view.collectionId : null,
  directOnly: view.kind === "classification" ? directOnly : false,
  favoriteOnly: view.kind === "favorites",
  unclassifiedOnly: view.kind === "unsorted",
  sort: effectiveSort,
  randomPivot: effectiveSort === "random" ? randomPivotRef.current : null,
  limit: ASSET_PAGE_SIZE,
}), [directOnly, effectiveSort, randomVersion, view]);
```

- [ ] **Step 2: viewKey에 collection 추가**

`viewKey` 계산에 `collection` 케이스 추가:

```ts
const viewKey = view.kind === "classification" ? `classification:${view.classificationId}`
  : view.kind === "album" ? `album:${view.albumId}`
  : view.kind === "collection" ? `collection:${view.collectionId}`
  : view.kind;
```

- [ ] **Step 3: 빈 상태 문구 추가**

빈 상태 분기(`:213` 부근)에 collection 케이스 추가:

```tsx
{view.kind === "collection" && items.length === 0 && (
  <EmptyState
    title="이 컬렉션에 자산이 없습니다."
    description="원하는 자산을 이 컬렉션에 추가하세요."
  />
)}
```

기존 EmptyState 컴포넌트 시그니처에 맞춤(앨범 빈 상태 패턴 참조).

- [ ] **Step 4: 테스트 실행**

Run: `cmd.exe /c npx vitest run src/assets/AssetBrowser.test.tsx`
Expected: 기존 테스트 통과(`collectionId: null` 기본값 처리). 단, 테스트에서 `AssetQuery` 리터럴이 `collectionId` 누락하면 TS 에러 — 테스트 파일들에 `collectionId: null` 추가 필요. 아래 Step 5에서 일괄 처리.

- [ ] **Step 5: 기존 AssetQuery 리터럴에 collectionId 추가**

`AssetBrowser.test.tsx`, `client.test.ts`, `LibraryContext.test.tsx` 등 `AssetQuery`를 리터럴로 만드는 모든 곳에 `collectionId: null` 추가. grep으로 위치 확인:

```bash
rg "albumId:" app/src --type ts -l
```

각 파일의 `AssetQuery` 리터럴에 `collectionId: null` 추가.

- [ ] **Step 6: 커밋**

```bash
git add app/src/assets/AssetBrowser.tsx app/src
git commit -m "feat: support collection scope in asset browser"
```

---

### Task 7: App.tsx — 컬렉션 상태 + 뷰 전환

**Files:**
- Modify: `app/src/app/App.tsx`

**Interfaces:**
- Consumes: `CollectionSummary`, `LibraryGateway.listCollections`, `AssetView` 변형
- Produces: `LibraryWorkspace`가 컬렉션 목록을 로드하고 `CollectionBrowser`/`AssetBrowser`에 전달

- [ ] **Step 1: 컬렉션 상태 + 새로고침**

기존 `albums` 상태 근처에 `collections` 상태 추가:

```ts
const [collections, setCollections] = useState<CollectionSummary[]>([]);
```

`refreshSidebar`(`:119-126`)에 `gateway.listCollections()` 병렬 호출 추가:

```ts
const refreshSidebar = useCallback(async () => {
  const [classResult, albumResult, collectionResult] = await Promise.all([
    gateway.listClassifications(),
    gateway.listAlbums(),
    gateway.listCollections(),
  ]);
  setEntries(classResult);
  setAlbums(albumResult);
  setCollections(collectionResult);
}, [gateway]);
```

컬렉션 변경 후 새로고침 콜백 `refreshCollections` 추가(앨범의 `refreshAlbums` 패턴):

```ts
const refreshCollections = useCallback(async () => {
  const collectionResult = await gateway.listCollections();
  setCollections(collectionResult);
}, [gateway]);
```

- [ ] **Step 2: 초기 뷰 — 컬렉션 기본값**

초기 `view`는 그대로(분류 저장소). `collections` 뷰는 빠른 보기 버튼에서 진입.

- [ ] **Step 3: 뷰 전환 dispatch 추가**

뷰 dispatch 삼항 체인(`:433-471`)에 `collections` 브랜치 추가. `manga` 브랜치 앞에:

```tsx
{view.kind === "collections" ? (
  <CollectionBrowser
    collections={collections}
    typeFilter={view.typeFilter}
    showcase={view.showcase}
    onViewChange={navigateView}
    onChanged={refreshCollections}
    onAssetRefresh={() => setAssetRefresh((n) => n + 1)}
  />
) : view.kind === "collection" ? (
  <AssetBrowser
    view={view}
    classifications={entries}
    albums={albums}
    collections={collections}
    gateway={gateway}
    assetRefresh={assetRefresh}
    onAssetChanged={() => setAssetRefresh((n) => n + 1)}
    onClassificationsChanged={refreshClassifications}
    onAlbumsChanged={refreshAlbums}
    onCollectionsChanged={refreshCollections}
  />
) : view.kind === "manga" ? (
```

기존 `AssetBrowser` 호출에도 `collections`/`onCollectionsChanged` props 추가(인스펙터에서 컬렉션 멤버십 변경 시 컬렉션 새로고침).

- [ ] **Step 4: import 추가**

```ts
import { CollectionBrowser } from "../collections/CollectionBrowser";
import type { CollectionSummary } from "../library/types";
```

- [ ] **Step 5: 테스트 갱신**

`App.test.tsx`에서 `AssetView` 초기값과 목(mock gateway)에 `listCollections` 추가. 기존 테스트가 깨지지 않도록 mock에 `listCollections: vi.fn().mockResolvedValue([])` 추가.

- [ ] **Step 6: 테스트 실행**

Run: `cmd.exe /c npx vitest run src/app/App.test.tsx`
Expected: PASS

- [ ] **Step 7: 커밋**

```bash
git add app/src/app/App.tsx app/src/app/App.test.tsx
git commit -m "feat: wire collection list and view switching"
```

---

### Task 8: ClassificationSidebar — 컬렉션 빠른 보기 버튼

**Files:**
- Modify: `app/src/classification/ClassificationSidebar.tsx:345-352`

- [ ] **Step 1: 컬렉션 QuickViewButton 추가**

망가 버튼 뒤에 추가:

```tsx
<QuickViewButton
  icon={<CollectionIcon />}
  label="컬렉션"
  selected={view.kind === "collections" || view.kind === "collection"}
  onClick={() => onViewChange({ kind: "collections", typeFilter: null, showcase: false })}
/>
```

`CollectionIcon` import(Heroicons `RectangleStackIcon` 또는 프로젝트 기존 아이콘 패턴 사용). 기존 아이콘 import 패턴(`FolderIcon`, `InboxIcon` 등)을 따른다.

- [ ] **Step 2: 테스트 갱신**

`ClassificationSidebar.test.tsx`에 컬렉션 버튼 렌더링 테스트 추가:

```tsx
test("renders a 컬렉션 quick view button", () => {
  render(<ClassificationSidebar ... />);
  expect(screen.getByRole("button", { name: "컬렉션" })).toBeInTheDocument();
});
```

- [ ] **Step 3: 테스트 실행 + 커밋**

```bash
cmd.exe /c npx vitest run src/classification/ClassificationSidebar.test.tsx
git add app/src/classification/ClassificationSidebar.tsx app/src/classification/ClassificationSidebar.test.tsx
git commit -m "feat: add collection quick view button"
```

---

### Task 9: CollectionCard + CollectionEditDialog

**Files:**
- Create: `app/src/collections/CollectionCard.tsx`
- Create: `app/src/collections/CollectionEditDialog.tsx`

- [ ] **Step 1: CollectionEditDialog 작성**

기존 `Dialog`/`TextField`/`Button` 재사용. 타입별로 다른 필드 노출(게임: 제작사/외부 점수/내 점수, 만화: 작가/연도, 영화: 감독/개봉연도). 생성 모드와 편집 모드 지원.

```tsx
import { useState } from "react";
import { Dialog } from "../shared/ui/Dialog";
import { TextField } from "../shared/ui/TextField";
import { Button } from "../shared/ui/Button";
import type { CollectionType, CreateCollection, UpdateCollection, CollectionSummary } from "../library/types";

type Mode =
  | { kind: "create" }
  | { kind: "edit"; collection: CollectionSummary };

export function CollectionEditDialog({
  open,
  mode,
  onOpenChange,
  onSubmit,
}: {
  open: boolean;
  mode: Mode;
  onOpenChange: (open: boolean) => void;
  onSubmit: (input: CreateCollection | UpdateCollection) => Promise<void>;
}) {
  const existing = mode.kind === "edit" ? mode.collection : null;
  const [name, setName] = useState(existing?.name ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [type, setType] = useState<CollectionType>(existing?.type ?? "manga");
  const [year, setYear] = useState<number | null>(existing?.year ?? null);
  const [author, setAuthor] = useState(existing?.author ?? "");
  const [director, setDirector] = useState(existing?.director ?? "");
  const [externalScore, setExternalScore] = useState<number | null>(existing?.externalScore ?? null);
  const [myScore, setMyScore] = useState<number | null>(existing?.myScore ?? null);

  async function handleSubmit() {
    const base = {
      name,
      description: description.trim() || null,
      type,
      year,
      author: author.trim() || null,
      director: director.trim() || null,
      externalScore,
      myScore,
      genres: null,
      overview: null,
    };
    await onSubmit(
      mode.kind === "create"
        ? { name: base.name, description: base.description, type: base.type }
        : base,
    );
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={mode.kind === "create" ? "새 컬렉션" : "컬렉션 편집"}>
      <TextField label="이름" value={name} onChange={setName} />
      <TextField label="설명" value={description} onChange={setDescription} />
      <label>
        <span>유형</span>
        <select value={type} onChange={(e) => setType(e.target.value as CollectionType)}>
          <option value="game">게임</option>
          <option value="manga">만화</option>
          <option value="movie">영화</option>
        </select>
      </label>
      {type === "manga" && (
        <>
          <TextField label="작가" value={author} onChange={setAuthor} />
          <TextField label="출간 연도" value={year?.toString() ?? ""} onChange={(v) => setYear(v ? Number(v) : null)} />
        </>
      )}
      {type === "game" && (
        <>
          <TextField label="제작사" value={author} onChange={setAuthor} />
          <TextField label="외부 점수" value={externalScore?.toString() ?? ""} onChange={(v) => setExternalScore(v ? Number(v) : null)} />
          <TextField label="내 점수" value={myScore?.toString() ?? ""} onChange={(v) => setMyScore(v ? Number(v) : null)} />
        </>
      )}
      {type === "movie" && (
        <>
          <TextField label="감독" value={director} onChange={setDirector} />
          <TextField label="개봉 연도" value={year?.toString() ?? ""} onChange={(v) => setYear(v ? Number(v) : null)} />
        </>
      )}
      <Button onClick={handleSubmit}>저장</Button>
    </Dialog>
  );
}
```

기존 `Dialog`/`TextField`/`Button`의 실제 props(레이블 방식, onChange 시그니처)는 기존 사용 예(`ClassificationAppearanceDialog`, `AssetInspector` 편집 폼)에 맞춰 조정.

- [ ] **Step 2: CollectionCard 작성**

표지 중심 카드. DESIGN.md 준수(radius 0~2px, shadow 없음, 이름/수 낮은 대조, 타입 배지).

```tsx
import type { CollectionSummary } from "../library/types";

const TYPE_LABEL: Record<string, string> = { game: "게임", manga: "만화", movie: "영화" };

export function CollectionCard({
  collection,
  coverUrl,
  onClick,
  selected,
}: {
  collection: CollectionSummary;
  coverUrl: string | null;
  onClick: () => void;
  selected: boolean;
}) {
  return (
    <button
      type="button"
      className="collection-card"
      aria-selected={selected}
      onClick={onClick}
    >
      <div className="collection-card__cover">
        {coverUrl ? (
          <img src={coverUrl} alt={collection.name} />
        ) : (
          <div className="collection-card__placeholder" aria-hidden="true" />
        )}
      </div>
      <div className="collection-card__meta">
        <span className="collection-card__type">{TYPE_LABEL[collection.type]}</span>
        <span className="collection-card__name">{collection.name}</span>
        <span className="collection-card__count">{collection.assetCount}개</span>
      </div>
    </button>
  );
}
```

- [ ] **Step 3: 스타일 추가(global.css)**

```css
.collection-card {
  display: flex;
  flex-direction: column;
  background: none;
  border: none;
  padding: 0;
  text-align: left;
  cursor: pointer;
}
.collection-card__cover {
  aspect-ratio: 2 / 3;
  border-radius: 2px;
  overflow: hidden;
  background: var(--surface-2);
}
.collection-card__cover img { width: 100%; height: 100%; object-fit: cover; }
.collection-card__placeholder {
  width: 100%; height: 100%;
  background: var(--surface-3);
}
.collection-card__meta {
  display: flex; flex-direction: column; gap: 2px;
  padding: 6px 2px 0;
}
.collection-card__type { font-size: 11px; color: var(--text-3); }
.collection-card__name { font-size: 13px; color: var(--text-1); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.collection-card__count { font-size: 11px; color: var(--text-3); }
.collection-card[aria-selected="true"] .collection-card__cover { outline: 2px solid var(--accent); outline-offset: -2px; }
```

기존 토큰 변수명(`--surface-2` 등)은 실제 global.css 정의에 맞춤. grep으로 확인 후 조정.

- [ ] **Step 4: 커밋**

```bash
git add app/src/collections/CollectionCard.tsx app/src/collections/CollectionEditDialog.tsx app/src/styles/global.css
git commit -m "feat: add collection card and edit dialog"
```

---

### Task 10: CollectionBrowser — 그리드 + 타입 전환 + 쇼케이스

**Files:**
- Create: `app/src/collections/CollectionBrowser.tsx`
- Create: `app/src/collections/CollectionBrowser.test.tsx`

**Interfaces:**
- Consumes: `CollectionSummary[]`, `AssetView`(`collections`/`collection`), `LibraryGateway`
- Produces: 컬렉션 목록 뷰

- [ ] **Step 1: CollectionBrowser 작성**

ViewToolbar 재사용(제목 "컬렉션"). 타입 전환 세그먼트(전체/게임/만화/영화) + 쇼케이스 토글. 새 컬렉션 버튼(툴바 우측 +). 빈 그리드 영역 우클릭 → 새 컬렉션. 카드 클릭 → 상세. 카드 우클릭 → 편집/삭제/쇼케이스 토글.

```tsx
import { useState } from "react";
import type { AssetView, CollectionSummary, CollectionType, CreateCollection, UpdateCollection } from "../library/types";
import { ViewToolbar } from "../layout/ViewToolbar";
import { CollectionCard } from "./CollectionCard";
import { CollectionEditDialog } from "./CollectionEditDialog";
import { ContextMenu } from "../shared/ui/ContextMenu";
import { mediaUrlFor } from "../assets/mediaUrl";

type EditMode = { kind: "create" } | { kind: "edit"; collection: CollectionSummary } | null;

export function CollectionBrowser({
  collections,
  typeFilter,
  showcase,
  onViewChange,
  onChanged,
}: {
  collections: CollectionSummary[];
  typeFilter: CollectionType | null;
  showcase: boolean;
  onViewChange: (next: AssetView) => void;
  onChanged: () => Promise<void>;
}) {
  const [editMode, setEditMode] = useState<EditMode>(null);
  const [menuCollection, setMenuCollection] = useState<CollectionSummary | null>(null);

  const visible = collections.filter((c) => {
    if (showcase && !c.showcase) return false;
    if (typeFilter && c.type !== typeFilter) return false;
    return true;
  });

  function setTypeFilter(next: CollectionType | null) {
    onViewChange({ kind: "collections", typeFilter: next, showcase });
  }
  function setShowcase(next: boolean) {
    onViewChange({ kind: "collections", typeFilter, showcase: next });
  }

  return (
    <>
      <ViewToolbar
        title="컬렉션"
        actions={
          <button onClick={() => setEditMode({ kind: "create" })}>+</button>
        }
      >
        <div className="collection-browser__filters">
          <Segment current={typeFilter ?? "all"} onChange={(v) => setTypeFilter(v === "all" ? null : (v as CollectionType))}
            options={[["all", "전체"], ["game", "게임"], ["manga", "만화"], ["movie", "영화"]]} />
          <button aria-pressed={showcase} onClick={() => setShowcase(!showcase)}>쇼케이스</button>
        </div>
      </ViewToolbar>
      <div className="collection-browser__grid">
        {visible.map((c) => (
          <CollectionCard
            key={c.id}
            collection={c}
            coverUrl={null}
            selected={false}
            onClick={() => onViewChange({ kind: "collection", collectionId: c.id })}
          />
        ))}
      </div>
      {visible.length === 0 && (
        <div className="collection-browser__empty">
          {showcase ? "쇼케이스에 컬렉션이 없습니다." : "컬렉션이 없습니다."}
        </div>
      )}
      {editMode && (
        <CollectionEditDialog
          open
          mode={editMode}
          onOpenChange={(o) => !o && setEditMode(null)}
          onSubmit={async () => { await onChanged(); }}
        />
      )}
    </>
  );
}
```

`Segment` 헬퍼는 기존 `Select` 또는 간단한 버튼 그룹으로 구현(DESIGN.md: 툴바 컨트롤). `mediaUrlFor`는 표지 URL — 컬렉션 표지 자산이 있을 때 썸네일 URL 생성. 첫 버전엔 표지 표시 로직은 자산 썸네일 URL 매핑(`mediaUrl.ts` 참조)으로 채운다. 없으면 `null`(빈 표지).

우클릭 메뉴(편집/쇼케이스 토글/삭제)는 `ContextMenu` 컴포넌트로 구현. 삭제 확인은 `confirm` 또는 기존 확인 패턴(앨범 삭제 확인 참조).

- [ ] **Step 2: 테스트 작성**

```tsx
import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { CollectionBrowser } from "./CollectionBrowser";
import type { CollectionSummary } from "../library/types";

const gateway = {
  listCollections: vi.fn(),
  createCollection: vi.fn(),
  updateCollection: vi.fn(),
  deleteCollection: vi.fn(),
  setCollectionCover: vi.fn(),
  setCollectionShowcase: vi.fn(),
} as any;

const sample: CollectionSummary = {
  id: "c1", name: "Astral Chain", description: null, type: "game",
  coverAssetId: null, assetCount: 3, year: 2019, author: "PlatinumGames",
  director: null, externalScore: 87, myScore: 9, genres: null, overview: null,
  externalId: null, externalSource: null, externalSyncedAt: null,
  showcase: false, createdAt: "t", updatedAt: "t",
};

describe("CollectionBrowser", () => {
  it("renders a grid of collection cards", () => {
    render(<CollectionBrowser collections={[sample]} typeFilter={null} showcase={false} onViewChange={() => {}} onChanged={async () => {}} gateway={gateway} />);
    expect(screen.getByText("Astral Chain")).toBeInTheDocument();
  });
  it("shows empty state when no collections", () => {
    render(<CollectionBrowser collections={[]} typeFilter={null} showcase={false} onViewChange={() => {}} onChanged={async () => {}} gateway={gateway} />);
    expect(screen.getByText("컬렉션이 없습니다.")).toBeInTheDocument();
  });
  it("filters by type when type filter set", () => {
    render(<CollectionBrowser collections={[sample]} typeFilter="manga" showcase={false} onViewChange={() => {}} onChanged={async () => {}} gateway={gateway} />);
    expect(screen.queryByText("Astral Chain")).not.toBeInTheDocument();
  });
  it("shows only showcase collections when showcase on", () => {
    render(<CollectionBrowser collections={[sample]} typeFilter={null} showcase={true} onViewChange={() => {}} onChanged={async () => {}} gateway={gateway} />);
    expect(screen.getByText("쇼케이스에 컬렉션이 없습니다.")).toBeInTheDocument();
  });
});
```

테스트 시그니처는 실제 props(gateway 등)에 맞춤.

- [ ] **Step 3: 테스트 실행 + 커밋**

```bash
cmd.exe /c npx vitest run src/collections/CollectionBrowser.test.tsx
git add app/src/collections/
git commit -m "feat: add collection browser grid with type filter and showcase"
```

---

### Task 11: AssetToolbar — 컬렉션 상세 배치 액션

**Files:**
- Modify: `app/src/assets/AssetToolbar.tsx:45`, `:53-69`
- Modify: `app/src/assets/AssetBrowser.tsx` (배치 액션 핸들러 연결)

- [ ] **Step 1: 타이틀에 collection 케이스 추가**

`location` 계산(`:45`)에:

```ts
const location = view.kind === "collection"
  ? collections.find((c) => c.id === view.collectionId)?.name ?? "컬렉션"
  : /* 기존 케이스 */;
```

`AssetToolbar`가 `collections: CollectionSummary[]` prop을 받도록 추가.

- [ ] **Step 2: 배치 액션에 컬렉션 전용 추가**

선택 모드 툴바에 `view.kind === "collection"`일 때:
- "이 컬렉션에서 제거" 버튼(`patchAssetCollections`로 `removeCollectionIds: [현재 컬렉션]`)
- 선택 자산이 정확히 1개 정상 이미지/GIF/영상일 때 "대표 이미지로 지정" 버튼(`setCollectionCover`)

```tsx
{view.kind === "collection" && selectedCount > 0 && (
  <button onClick={onRemoveFromCollection}>이 컬렉션에서 제거</button>
)}
{view.kind === "collection" && selectedCount === 1 && (
  <button onClick={onSetCover}>대표 이미지로 지정</button>
)}
```

- [ ] **Step 3: AssetBrowser에 핸들러 추가**

`AssetBrowser.tsx`에 `removeFromCollection`/`setCover` 구현:

```ts
const removeFromCollection = useCallback(async () => {
  if (view.kind !== "collection") return;
  await gateway.patchAssetCollections({
    assetIds: selectedAssetIds,
    addCollectionIds: [],
    removeCollectionIds: [view.collectionId],
  });
  setAssetRefresh((n) => n + 1);
}, [gateway, selectedAssetIds, view]);

const setCover = useCallback(async (assetId: string) => {
  if (view.kind !== "collection") return;
  await gateway.setCollectionCover(view.collectionId, assetId);
  onCollectionsChanged();
}, [gateway, view, onCollectionsChanged]);
```

- [ ] **Step 4: 테스트 + 커밋**

```bash
cmd.exe /c npx vitest run src/assets/AssetToolbar.test.tsx src/assets/AssetBrowser.test.tsx
git add app/src/assets/AssetToolbar.tsx app/src/assets/AssetBrowser.tsx
git commit -m "feat: add collection detail batch actions"
```

---

### Task 12: AssetInspector — 컬렉션 멤버십 + 메타데이터 표시

**Files:**
- Modify: `app/src/assets/AssetInspector.tsx:230-263`

- [ ] **Step 1: 컬렉션 멤버십 로드**

`useEffect` 멤버십 로드(`:83-105`)에 `gateway.getAssetCollections` 병렬 호출 추가. `collectionIds: string[]` 상태.

- [ ] **Step 2: 컬렉션 체크박스 목록 추가**

"정리" 섹션 앨범 체크박스 뒤에 컬렉션 체크박스 추가(동일 패턴):

```tsx
<h4>컬렉션</h4>
<ul>
  {collections.map((entry) => {
    const count = collectionIds.filter((id) => id === entry.id).length;
    const checked = count === assets.length;
    const indeterminate = count > 0 && !checked;
    return (
      <li key={entry.id}>
        <label>
          <input
            type="checkbox"
            checked={checked}
            ref={(el) => { if (el) el.indeterminate = indeterminate; }}
            onChange={() => onPatchCollection(entry.id, checked ? "remove" : "add")}
          />
          {entry.name}
        </label>
      </li>
    );
  })}
</ul>
```

- [ ] **Step 3: 컬렉션 메타데이터 표시 섹션**

선택 자산이 단일이고 현재 뷰가 컬렉션일 때, 컬렉션 메타데이터를 인스펙터에 표시:

```tsx
{currentCollection && (
  <section className="asset-inspector__collection-info">
    <h3>{currentCollection.name}</h3>
    <dl>
      {currentCollection.type === "game" && (
        <>
          {currentCollection.author && <><dt>제작사</dt><dd>{currentCollection.author}</dd></>}
          {currentCollection.externalScore != null && <><dt>외부 점수</dt><dd>{currentCollection.externalScore}</dd></>}
          {currentCollection.myScore != null && <><dt>내 점수</dt><dd>{currentCollection.myScore}</dd></>}
        </>
      )}
      {currentCollection.type === "manga" && (
        <>
          {currentCollection.author && <><dt>작가</dt><dd>{currentCollection.author}</dd></>}
          {currentCollection.year != null && <><dt>출간 연도</dt><dd>{currentCollection.year}</dd></>}
        </>
      )}
      {currentCollection.type === "movie" && (
        <>
          {currentCollection.director && <><dt>감독</dt><dd>{currentCollection.director}</dd></>}
          {currentCollection.year != null && <><dt>개봉 연도</dt><dd>{currentCollection.year}</dd></>}
        </>
      )}
    </dl>
  </section>
)}
```

`currentCollection`은 `view.kind === "collection"`일 때 `collections.find(c => c.id === view.collectionId)`.

- [ ] **Step 4: onPatchCollection prop 추가**

`AssetInspector` props에 `collections: CollectionSummary[]`, `onPatchCollection(collectionId: string, action: "add" | "remove"): Promise<void>`, `currentCollection: CollectionSummary | null` 추가. `AssetBrowser`에서 연결.

- [ ] **Step 5: 테스트 + 커밋**

```bash
cmd.exe /c npx vitest run src/assets/AssetInspector.test.tsx
git add app/src/assets/AssetInspector.tsx app/src/assets/AssetBrowser.tsx
git commit -m "feat: add collection membership and metadata to inspector"
```

---

### Task 13: 전체 검증

**Files:** 없음(검증만)

- [ ] **Step 1: Rust 전체 테스트**

Run: `cargo test --no-default-features`
Expected: 전부 PASS

- [ ] **Step 2: 프론트엔드 전체 검증**

Run: `cmd.exe /c npm run check`(workdir: `app`)
Expected: test + build 통과

- [ ] **Step 3: Tauri 프로덕션 빌드**

Run: `cmd.exe /c npm run tauri build -- --no-bundle`(workdir: `app`)
Expected: 빌드 성공

- [ ] **Step 4: 최종 커밋**

```bash
git add -A
git commit -m "chore: verify collection feature end to end"
```

---

## Self-Review

**Spec coverage:**
- 타입별 메타데이터(게임/만화/영화): Task 2(모델) + Task 3(SQL) + Task 9(편집 폼) + Task 12(표시) ✅
- 쇼케이스: Task 3(백엔드) + Task 10(UI 토글/필터) ✅
- 표지 그리드: Task 9(카드) + Task 10(브라우저) ✅
- 타입 전환 세그먼트: Task 10 ✅
- 상세(AssetBrowser 재사용): Task 6 + Task 11 + Task 12 ✅
- 대표 이미지 지정: Task 11 ✅
- 인스펙터 멤버십: Task 12 ✅
- 빈 표지/빈 상태: Task 9 + Task 10 + Task 6 ✅
- 삭제 확인: Task 10(우클릭 삭제) ✅
- 외부 ID 자리(스키마): Task 1 ✅ (연동 자체는 제외 — 2단계)
- 레거시 마이그레이션: 제외(별도 작업) ✅

**Placeholder scan:** 없음. 모든 코드 블록은 실제 구현.

**Type consistency:** `CollectionType`(Rust snake_case / TS 소문자) — `collection_type` 필드는 serde `rename = "type"`으로 TS `type`과 매칭. `AssetView` 변형 `collections`/`collection`은 App.tsx dispatch와 CollectionBrowser props 일치. `set_collection_showcase` 명령명 일관.