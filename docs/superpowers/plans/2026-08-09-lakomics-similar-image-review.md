# Lakomics Similar Image Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 완전 중복은 계속 차단하면서 시각적으로 비슷한 새 이미지를 검토 대기에 안전하게 보관하고, 사용자가 기존 유지·교체·둘 다 보관을 선택할 수 있게 한다.

**Architecture:** Rust `Library` Module이 64비트 difference hash, 후보 검색, 검토 상태, 파일 정리와 메타데이터 승계를 소유한다. React는 작은 Tauri Interface로 수집 결과, 검토 목록과 결정만 다루며 관리 경로·SQLite·지각 해시는 알지 않는다. 기존 `review` 자산 상태와 별도 `similarity_reviews` 상태를 사용해 앱 종료 뒤에도 검토와 정리를 재개한다.

**Tech Stack:** Windows, Tauri 2, Rust stable MSVC, rusqlite(SQLite bundled), image, React, TypeScript, Vite, Vitest, React Testing Library, 기존 Radix 기반 공통 UI

## Global Constraints

- `docs/superpowers/specs/2026-08-09-lakomics-similar-image-review-design.md`, `docs/adr/0007-exact-and-similar-duplicates.md`, `CONTEXT.md`의 용어와 상태 전이를 따른다.
- 사용자 원본은 모든 수집·검토 결정에서 유지하며 이동하거나 삭제하지 않는다.
- 완전 중복은 유사 이미지 검사보다 먼저 차단하고 기존 메타데이터를 자동 변경하지 않는다.
- 일반 자산 조회에는 `normal`만 나타나고 `review` 후보는 검토 화면에서만 보인다.
- UI에 내부 상대 경로, 내용 해시, 지각 해시, SQL 세부사항을 직렬화하지 않는다.
- 첫 버전은 64비트 difference hash와 Hamming distance 6만 사용한다. AI 임베딩, 보조 색상 해시와 사용자 조절 기준은 추가하지 않는다.
- 기존 자산 지각 해시는 50개씩 처리하고 실패는 공개 오류 코드로 표시해 무한 반복하지 않는다.
- 반복되는 간격·색상·모서리·그림자는 기존 디자인 토큰과 공통 UI를 사용한다.
- 새 Adapter, 상태 관리 라이브러리, 이미지 해시 dependency를 추가하지 않는다. 기존 `image` crate와 표준 `u64::count_ones`를 사용한다.
- 모든 동작 변경은 RED 실패를 먼저 확인한 뒤 최소 구현으로 GREEN을 만든다.
- 에이전트는 사용하지 않고 현재 세션에서 순서대로 실행한다.

## File Structure

- Create `app/src-tauri/migrations/0003_similarity_review.sql`: schema version 3, 지각 해시 열과 검토 행
- Create `app/src-tauri/src/library/similarity.rs`: 해시 생성, 기존 해시 채우기, 후보 검색, 목록과 결정의 Library Implementation
- Modify `app/src-tauri/src/library/ingestion.rs`: 완전 중복 뒤 유사 후보 판정과 review 등록
- Modify `app/src-tauri/src/library/models.rs`: Rust 요청·응답 모델
- Modify `app/src-tauri/src/library/db.rs`: version 0~3 마이그레이션과 사전 백업
- Modify `app/src-tauri/src/library/mod.rs`: similarity Module 연결과 재시작 정리
- Modify `app/src-tauri/src/library/trash.rs`: 소유권 검증된 관리 파일 정리 재사용
- Modify `app/src-tauri/src/library/error.rs`: 검토 상태·해시 인덱스 오류 코드
- Modify `app/src-tauri/src/commands.rs`, `app/src-tauri/src/lib.rs`, `app/src-tauri/src/media_protocol.rs`: Tauri 명령과 review 미디어 제공
- Modify `app/src-tauri/tests/foundation_flow.rs`: v2→v3 백업 마이그레이션 통합 검증
- Modify `app/src/library/types.ts`, `app/src/library/client.ts`: frontend `LibraryGateway` Interface
- Create `app/src/library/client.test.ts`: Tauri command 이름과 payload 계약 검증
- Modify `app/src/ingestion/useFileDrop.ts`, `app/src/ingestion/useFileDrop.test.ts`: 네 가지 수집 결과 집계
- Modify `app/src/ingestion/WorkTray.tsx`, `app/src/ingestion/WorkTray.test.tsx`: 완료 결과 요약·닫기·이동 동작
- Create `app/src/similarity/SimilarityReviewBrowser.tsx`, `app/src/similarity/SimilarityReviewBrowser.test.tsx`: 비교·결정 화면
- Create `app/src/similarity/useSimilarityIndex.ts`, `app/src/similarity/useSimilarityIndex.test.ts`: 50개 단위 기존 자산 해시 준비
- Create `app/src/assets/assetMetadata.ts`: Inspector와 유사 이미지 화면이 공유하는 크기·날짜·출처 표시
- Modify `app/src/assets/AssetInspector.tsx`: 공통 자산 정보 formatter 사용
- Modify `app/src/classification/ClassificationSidebar.tsx`, `app/src/classification/ClassificationSidebar.test.tsx`: 검토 대기 빠른 보기와 배지
- Modify `app/src/assets/AssetBrowser.tsx`, `app/src/assets/AssetBrowser.test.tsx`: 완전 중복 결과에서 기존 자산 열기
- Modify `app/src/app/App.tsx`, `app/src/app/App.test.tsx`: 화면 조립, 개수 갱신, drop 비활성화
- Modify `app/src/layout/StatusBar.tsx`, `app/src/layout/AppShell.test.tsx`: 인덱스 준비 진행 표시
- Modify `app/src/styles/global.css`, `app/src/styles/tokens.css`: 비교 화면과 결과 요약의 기존 토큰 기반 배치
- Modify `app/README.md`: 검토 흐름과 실제 검증 명령

---

### Task 1: Schema Version 3 and Rust Models

**Files:**
- Create: `app/src-tauri/migrations/0003_similarity_review.sql`
- Modify: `app/src-tauri/src/library/db.rs`
- Modify: `app/src-tauri/src/library/error.rs`
- Modify: `app/src-tauri/src/library/models.rs`
- Modify: `app/src-tauri/tests/foundation_flow.rs`

**Interfaces:**
- Consumes: schema v2 `assets`, `asset_classifications`, backup snapshot helpers
- Produces: `SCHEMA_VERSION = 3`, `perceptual_hash`, `perceptual_hash_error`, `similarity_reviews`, Rust review request/response types

- [x] **Step 1: Write RED migration tests**

Add integration tests that open a real v2 database, assert a pre-migration backup is created, and inspect the migrated schema through SQL behavior rather than source text.

```rust
#[test]
fn version_two_library_migrates_similarity_state_after_a_verified_backup() {
    let fixture = version_two_library();
    let library = Library::open(fixture.root()).unwrap();
    let connection = Connection::open(library.root().join("library.sqlite")).unwrap();

    assert_eq!(user_version(&library), 3);
    connection.execute(
        "UPDATE assets SET perceptual_hash = ?2 WHERE id = ?1",
        params!["asset-1", vec![0_u8; 8]],
    ).unwrap();
    connection.execute(
        "INSERT INTO similarity_reviews (
            id, existing_asset_id, candidate_asset_id, distance, status, created_at
         ) VALUES ('review-1', 'asset-1', 'asset-2', 2, 'open', '2026-08-09T00:00:00Z')",
        [],
    ).unwrap();
    assert_eq!(pre_migration_backups(library.root()).len(), 1);
}
```

Add a private `MigrationFixture { _temp: TempDir, root: PathBuf }` plus `version_two_library() -> MigrationFixture` in `foundation_flow.rs`. The helper creates the root and `library.sqlite`, applies `0001_initial.sql` and `0002_vault_safety.sql` directly with `rusqlite`, inserts `asset-1` and `asset-2` as normal image assets with distinct content hashes and relative paths, and exposes `root() -> &Path`. This makes the foreign-key insert above valid and ensures the test exercises the real v2-to-v3 path.

Add model serialization tests proving review payloads expose public asset information but no path or hash.

- [x] **Step 2: Run RED tests**

Run:

```powershell
cd app/src-tauri
cargo test version_two_library_migrates_similarity_state_after_a_verified_backup
cargo test similarity_review_serialization_omits_internal_hashes_and_paths
```

Expected: FAIL because schema version 3, columns, table and models do not exist.

- [x] **Step 3: Add migration and exact Rust types**

Create `0003_similarity_review.sql` with the following schema behavior:

```sql
ALTER TABLE assets ADD COLUMN perceptual_hash BLOB;
ALTER TABLE assets ADD COLUMN perceptual_hash_error TEXT;

CREATE TABLE similarity_reviews (
    id TEXT PRIMARY KEY NOT NULL,
    existing_asset_id TEXT REFERENCES assets(id) ON DELETE SET NULL,
    candidate_asset_id TEXT UNIQUE REFERENCES assets(id) ON DELETE SET NULL,
    distance INTEGER NOT NULL CHECK (distance BETWEEN 0 AND 64),
    status TEXT NOT NULL CHECK (status IN ('open', 'resolving', 'resolved')),
    decision TEXT CHECK (decision IN ('keep_existing', 'replace_existing', 'keep_both')),
    created_at TEXT NOT NULL,
    resolved_at TEXT,
    CHECK (
        (status = 'open' AND decision IS NULL AND resolved_at IS NULL AND existing_asset_id IS NOT NULL AND candidate_asset_id IS NOT NULL)
        OR (status = 'resolving' AND decision = 'keep_existing' AND resolved_at IS NULL AND existing_asset_id IS NOT NULL AND candidate_asset_id IS NOT NULL)
        OR (status = 'resolved' AND decision IS NOT NULL AND resolved_at IS NOT NULL)
    )
);

CREATE INDEX similarity_reviews_by_status
ON similarity_reviews(status, created_at, id);

PRAGMA user_version = 3;
```

Update `db.rs` so version 0 applies migrations 1→2→3, version 1 backs up once then applies 2→3, and version 2 backs up once then applies 3.

Add these exact public model shapes in `models.rs`:

```rust
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SimilarityDecision { KeepExisting, ReplaceExisting, KeepBoth }

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SimilarityDecisionRequest {
    pub review_id: String,
    pub decision: SimilarityDecision,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SimilarityReviewAsset {
    pub asset: AssetSummary,
    pub format: String,
    pub classifications: Vec<ClassificationEntry>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SimilarityReviewSummary {
    pub id: String,
    pub distance: u32,
    pub existing: SimilarityReviewAsset,
    pub candidate: SimilarityReviewAsset,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SimilarityReviewPage {
    pub items: Vec<SimilarityReviewSummary>,
    pub next_cursor: Option<AssetCursor>,
    pub total_count: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SimilarityIndexProgress {
    pub processed: u64,
    pub remaining: u64,
    pub failed: u64,
}
```

Extend `IngestOutcome` with `ReviewPending { review_id: String }` and add these exact outcome types without exposing paths or hashes:

```rust
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SimilarityDecisionStatus { Resolved }

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SimilarityDecisionOutcome {
    pub status: SimilarityDecisionStatus,
    pub next_review_id: Option<String>,
}
```

Add these exact `LibraryError` variants in `error.rs`; their display messages must not contain review IDs, paths, hashes or SQL:

```rust
InvalidPerceptualHash,
SimilarityReviewNotFound,
SimilarityReviewConflict,
```

- [x] **Step 4: Run GREEN migration tests**

Run:

```powershell
cargo test version_two_library_migrates_similarity_state_after_a_verified_backup
cargo test similarity_review_serialization_omits_internal_hashes_and_paths
cargo test open_creates_the_self_contained_library_layout_without_a_trash_directory
```

Expected: PASS; fresh databases and v1/v2 databases end at version 3 with one verified pre-migration backup for upgrades.

- [x] **Step 5: Commit Task 1**

```powershell
git add app/src-tauri/migrations/0003_similarity_review.sql app/src-tauri/src/library/db.rs app/src-tauri/src/library/error.rs app/src-tauri/src/library/models.rs app/src-tauri/tests/foundation_flow.rs
git commit -m "feat: add persistent similarity review schema"
```

---

### Task 2: Perceptual Hashing, Candidate Search, and Incremental Indexing

**Files:**
- Create: `app/src-tauri/src/library/similarity.rs`
- Modify: `app/src-tauri/src/library/mod.rs`

**Interfaces:**
- Consumes: `assets.perceptual_hash`, managed asset path resolver, existing `image` crate
- Produces: `Library::index_missing_similarity_hashes()`, internal `perceptual_hash`, `find_similar_asset`

- [x] **Step 1: Write RED hash behavior tests**

Use real generated images. Derive expected relationships by fixture construction, not by calling the hash helper in assertions.

```rust
#[test]
fn resized_and_reencoded_image_is_nearer_than_an_unrelated_image() {
    let base = striped_fixture(900, 600, StripeDirection::Vertical);
    let resized_jpeg = jpeg_variant(&base, 450, 300, 70);
    let unrelated = striped_fixture(900, 600, StripeDirection::Horizontal);

    let base_hash = perceptual_hash(&base);
    let resized_hash = perceptual_hash(&resized_jpeg);
    let unrelated_hash = perceptual_hash(&unrelated);

    assert!(hamming_distance(base_hash, resized_hash) <= 6);
    assert!(hamming_distance(base_hash, unrelated_hash) > 6);
}

#[test]
fn candidate_search_uses_distance_then_collected_at_then_id() {
    let fixture = library_with_hashes([
        ("later", 0b0001_u64, "2026-08-09T01:00:00Z"),
        ("earlier-b", 0b0010_u64, "2026-08-09T00:00:00Z"),
        ("earlier-a", 0b0100_u64, "2026-08-09T00:00:00Z"),
    ]);
    assert_eq!(fixture.library.find_similar_asset(0).unwrap().unwrap().asset_id, "earlier-a");
}
```

Add a real-database indexing test with 51 unindexed rows, one broken managed file, and two calls. Assert exactly 50 rows are attempted on the first call, the second completes the remaining valid row, and the broken row gets a public error code instead of being selected forever.

Keep visual fixture helpers inside `similarity.rs`'s test module with these exact signatures:

```rust
#[derive(Clone, Copy)]
enum StripeDirection { Vertical, Horizontal }

fn striped_fixture(width: u32, height: u32, direction: StripeDirection) -> DynamicImage {
    DynamicImage::ImageRgb8(ImageBuffer::from_fn(width, height, |x, y| {
        let offset = match direction { StripeDirection::Vertical => x, StripeDirection::Horizontal => y };
        let light = (offset / 32) % 2 == 0;
        Rgb(if light { [240, 180, 30] } else { [20, 60, 180] })
    }))
}

fn jpeg_variant(source: &DynamicImage, width: u32, height: u32, quality: u8) -> DynamicImage {
    let resized = source.resize_exact(width, height, FilterType::Triangle);
    let mut bytes = Vec::new();
    JpegEncoder::new_with_quality(&mut bytes, quality).encode_image(&resized).unwrap();
    image::load_from_memory(&bytes).unwrap()
}
```

`library_with_hashes` is a private test helper that creates a real temporary `Library` and inserts the literal `(id, hash, collected_at)` rows supplied by the test. It must not call `find_similar_asset` or compute expected distances.

- [x] **Step 2: Run RED hash tests**

```powershell
cd app/src-tauri
cargo test similarity::tests --lib
```

Expected: FAIL because `similarity` module and methods are missing.

- [x] **Step 3: Implement the minimum hash Module**

Use no dependency beyond `image`:

```rust
const SIMILARITY_DISTANCE_MAX: u32 = 6;
const INDEX_BATCH_SIZE: u32 = 50;

fn perceptual_hash(image: &DynamicImage) -> u64 {
    let pixels = image
        .resize_exact(9, 8, image::imageops::FilterType::Triangle)
        .to_luma8();
    let mut hash = 0_u64;
    for y in 0..8 {
        for x in 0..8 {
            hash <<= 1;
            hash |= u64::from(pixels.get_pixel(x, y)[0] > pixels.get_pixel(x + 1, y)[0]);
        }
    }
    hash
}

fn hamming_distance(left: u64, right: u64) -> u32 {
    (left ^ right).count_ones()
}
```

Define the internal candidate and file adapter with these signatures:

```rust
#[derive(Debug, Clone, PartialEq, Eq)]
struct SimilarAssetCandidate {
    asset_id: String,
    distance: u32,
}

pub(crate) fn perceptual_hash_from_file(mut file: File) -> Result<u64, LibraryError> {
    file.seek(SeekFrom::Start(0)).map_err(|_| LibraryError::UnsupportedImage)?;
    let image = ImageReader::new(BufReader::new(file))
        .with_guessed_format()
        .map_err(|_| LibraryError::UnsupportedImage)?
        .decode()
        .map_err(|_| LibraryError::UnsupportedImage)?;
    Ok(perceptual_hash(&image))
}
```

Store hashes with `u64::to_be_bytes()` and reject BLOBs whose length is not 8. `find_similar_asset` reads only `normal` rows with a non-null hash, computes distance in Rust, filters at 6, and uses `(distance, collected_at, id)` ordering.

`index_missing_similarity_hashes()` selects at most 50 `normal` assets with both hash and error null, resolves and decodes managed originals inside Rust, and writes either the 8-byte hash or one of `media_not_found`, `unsafe_media_path`, `read_media_failed`, or `unsupported_image`. A database failure returns immediately instead of being stored as a per-asset media error. `processed` is the number attempted in this call, `remaining` is the current count with both columns null, and `failed` is the cumulative count with `perceptual_hash_error IS NOT NULL`; the 51-row test therefore observes `{ processed: 50, remaining: 1, failed: 1 }` then `{ processed: 1, remaining: 0, failed: 1 }`.

- [x] **Step 4: Verify GREEN and 50k search boundary**

```powershell
cargo test similarity::tests --lib
cargo test candidate_search_scans_fifty_thousand_hashes --release -- --ignored --nocapture
```

Expected: behavior tests PASS; the `#[test] #[ignore]` release measurement prints and asserts a duration below one second for one synthetic 50,000-row search.

- [x] **Step 5: Commit Task 2**

```powershell
git add app/src-tauri/src/library/similarity.rs app/src-tauri/src/library/mod.rs
git commit -m "feat: index perceptual hashes for similar images"
```

---

### Task 3: Ingestion Creates Review-Pending Assets

**Files:**
- Modify: `app/src-tauri/src/library/ingestion.rs`
- Modify: `app/src-tauri/src/library/similarity.rs`
- Test: `app/src-tauri/src/library/ingestion.rs`

**Interfaces:**
- Consumes: `perceptual_hash`, `find_similar_asset`, existing exact duplicate and pending-file safety flow
- Produces: `IngestOutcome::ReviewPending`, atomic `review` asset + `similarity_reviews` row

- [x] **Step 1: Write RED ingestion tests**

```rust
#[test]
fn similar_image_becomes_review_pending_without_entering_normal_queries() {
    let fixture = Fixture::new();
    let base = vertical_stripes(900, 600);
    let existing_path = fixture.write_png("existing.png", &base);
    let existing = match fixture.ingest(&existing_path, None, None) {
        IngestOutcome::Added { asset } => asset,
        other => panic!("expected added asset, got {other:?}"),
    };
    let variant_path = fixture.write_jpeg("variant.jpg", &base.resize_exact(450, 300, FilterType::Triangle), 70);
    let outcome = fixture.library.ingest_image(IngestImageRequest {
        source_path: variant_path,
        classification_id: Some(fixture.tag_id.clone()),
        source_url: Some("https://example.com/new".into()),
    }).unwrap();

    let review_id = match outcome {
        IngestOutcome::ReviewPending { review_id } => review_id,
        other => panic!("expected review pending, got {other:?}"),
    };
    let normal = fixture.all_assets();
    assert_eq!(normal.iter().map(|asset| asset.id.as_str()).collect::<Vec<_>>(), vec![existing.id]);
    assert_eq!(fixture.library.list_similarity_reviews(None, 20).unwrap().items[0].id, review_id);
}

#[test]
fn exact_duplicate_wins_before_similarity_and_does_not_create_review() {
    let fixture = Fixture::new();
    let path = fixture.write_png("same.png", &vertical_stripes(900, 600));
    let existing = match fixture.ingest(&path, None, None) {
        IngestOutcome::Added { asset } => asset,
        other => panic!("expected added asset, got {other:?}"),
    };
    let outcome = fixture.ingest(&path, None, None);
    assert_eq!(outcome, IngestOutcome::ExactDuplicate { existing_asset_id: existing.id });
    assert_eq!(fixture.library.list_similarity_reviews(None, 20).unwrap().total_count, 0);
}
```

Also assert a visually unrelated file still returns `Added`, and that a review candidate retains the requested classification and incoming source URL.

Add a private ingestion-test fixture with these operations only: `write_png(name: &str, image: &DynamicImage) -> PathBuf`, `write_jpeg(name: &str, image: &DynamicImage, quality: u8) -> PathBuf`, `ingest(path: &Path, classification_id: Option<String>, source_url: Option<String>) -> IngestOutcome`, and `all_assets() -> Vec<AssetSummary>`. The fixture uses a real temporary Library and real image files; it does not fake the hash or database. Define the image helper exactly as:

```rust
fn vertical_stripes(width: u32, height: u32) -> DynamicImage {
    DynamicImage::ImageRgb8(ImageBuffer::from_fn(width, height, |x, _| {
        let light = (x / 32) % 2 == 0;
        Rgb(if light { [240, 180, 30] } else { [20, 60, 180] })
    }))
}
```

- [x] **Step 2: Run RED ingestion tests**

```powershell
cargo test similar_image_becomes_review_pending_without_entering_normal_queries
cargo test exact_duplicate_wins_before_similarity_and_does_not_create_review
```

Expected: FAIL because ingestion does not calculate or persist perceptual hashes and the review listing method is absent.

- [x] **Step 3: Integrate similarity after exact duplicate detection**

Preserve this order in `ingest_image`:

```rust
let existing_asset_id = self.find_asset_by_hash(&content_hash)?;
if let Some(existing_asset_id) = existing_asset_id {
    return Ok(IngestOutcome::ExactDuplicate { existing_asset_id });
}

let perceptual_hash = perceptual_hash_from_file(pending.owned_file(&staging_path)?)?;
let similar = self.find_similar_asset(perceptual_hash)?;
```

Install the managed original and thumbnail with the existing `PendingFiles` guard. Replace the normal-only registration helper with one internal function that accepts a private `Registration::Normal` or `Registration::Review { existing_asset_id, distance, review_id }`; it inserts the asset, requested classification, perceptual hash, and optional review row in one transaction. Only call `pending.commit()` after that transaction succeeds.

- [x] **Step 4: Run GREEN ingestion suite**

```powershell
cargo test ingestion::tests --lib
cargo test --test foundation_flow
```

Expected: PASS including exact duplicate rollback, source preservation, classification validation and new review behavior.

- [x] **Step 5: Commit Task 3**

```powershell
git add app/src-tauri/src/library/ingestion.rs app/src-tauri/src/library/similarity.rs
git commit -m "feat: queue similar ingestions for review"
```

---

### Task 4: Review Listing and Three Atomic Decisions

**Files:**
- Modify: `app/src-tauri/src/library/similarity.rs`
- Modify: `app/src-tauri/src/library/trash.rs`
- Modify: `app/src-tauri/src/library/mod.rs`

**Interfaces:**
- Consumes: open `similarity_reviews`, asset classifications, favorite, trash retention policy, safe managed-file deletion
- Produces: `get_asset`, `list_similarity_reviews`, `decide_similarity_review`, startup cleanup for `resolving`

- [x] **Step 1: Write RED review listing and decision tests**

Use real Library state and files. Each test names one broken transition.

```rust
#[test]
fn replace_moves_existing_to_trash_and_transfers_classifications_and_favorite() {
    let fixture = review_fixture();
    fixture.library.set_asset_favorite(&fixture.existing_id, true).unwrap();
    fixture.library.patch_asset_classifications(AssetClassificationPatch {
        asset_ids: vec![fixture.existing_id.clone()],
        add_classification_ids: vec![fixture.old_tag.clone()],
        remove_classification_ids: vec![],
    }).unwrap();

    fixture.library.decide_similarity_review(SimilarityDecisionRequest {
        review_id: fixture.review_id.clone(),
        decision: SimilarityDecision::ReplaceExisting,
    }).unwrap();

    assert_eq!(fixture.status(&fixture.existing_id), "trash");
    assert_eq!(fixture.status(&fixture.candidate_id), "normal");
    assert!(fixture.asset(&fixture.candidate_id).favorite);
    let mut actual = fixture.classification_ids(&fixture.candidate_id);
    actual.sort();
    let mut expected = vec![fixture.old_tag.clone(), fixture.requested_tag.clone()];
    expected.sort();
    assert_eq!(actual, expected);
    assert_eq!(fixture.source_url(&fixture.candidate_id), Some("https://example.com/new".into()));
}

#[test]
fn keep_existing_resumes_file_cleanup_after_reopen() {
    let fixture = review_fixture_with_cleanup_hook();
    fixture.fail_after_marking_resolving();
    let error = fixture.library.decide_similarity_review(SimilarityDecisionRequest {
        review_id: fixture.review_id.clone(),
        decision: SimilarityDecision::KeepExisting,
    }).unwrap_err();
    assert!(matches!(error, LibraryError::WriteAsset { .. }));

    drop(fixture.library);
    let reopened = Library::open(&fixture.root).unwrap();
    assert!(!fixture.managed_asset_path.exists());
    assert_eq!(reopened.list_similarity_reviews(None, 20).unwrap().total_count, 0);
}
```

Add separate tests for `keep_existing` leaving the old asset unchanged, `keep_both` normalizing only the candidate, stable cursor pagination, same-decision idempotence, and different-decision rejection.

`review_fixture()` creates two real image files, ingests the first as a normal asset, ingests a resized/re-encoded copy as the review candidate, creates the old and requested classifications through public Library methods, and obtains the open review ID from `IngestOutcome::ReviewPending`. Its test-only SQL query helpers are limited to `status(id)`, `asset(id)`, `classification_ids(id)`, and `source_url(id)`. `review_fixture_with_cleanup_hook()` uses the existing ingestion/trash hook pattern under `#[cfg(test)]` to stop only after the review reaches `resolving`; no cleanup-only method is added to production `Library`.

- [x] **Step 2: Run RED decision tests**

```powershell
cargo test similarity::tests::review --lib
```

Expected: FAIL because list and decision methods do not exist.

- [x] **Step 3: Implement listing with public-only review assets**

Validate page limits with the existing `1..=200` rule. Select open reviews by `(created_at, id)`, load each asset and its classifications inside Rust, derive format from `media_kind` and managed extension, and return no path/hash columns. Encode the cursor as `{ created_at, id }` JSON in `AssetCursor.token`.

Add `Library::get_asset(asset_id)` in the same Module. It returns the public summary for `normal` only and never serializes managed paths. Exact-duplicate UI uses it for normal assets; the review screen receives review candidates only through the review page Interface.

- [x] **Step 4: Implement the three decisions**

Acquire the existing `trash_lock` before loading a review and hold it through the decision's database and file work; this serializes decisions with purge/restore without adding another lock. Then use one decision path:

```rust
match request.decision {
    SimilarityDecision::KeepExisting => self.keep_existing_review(review)?,
    SimilarityDecision::ReplaceExisting => self.replace_existing_review(review)?,
    SimilarityDecision::KeepBoth => self.keep_both_review(review)?,
}
```

For replace, one transaction must:

1. verify review is open and both states are expected;
2. insert existing classifications onto candidate with `INSERT OR IGNORE`;
3. copy favorite from existing to candidate;
4. set existing to trash with current `trashed_at`;
5. set candidate to normal;
6. mark review resolved with decision and timestamp.

For keep both, set candidate normal and mark the review resolved in one transaction. For keep existing, mark review resolving, reuse a `pub(crate)` safe managed-file remover from `trash.rs`, then run one final transaction that first updates the review to `resolved` with `resolved_at` and then deletes the candidate asset. The `ON DELETE SET NULL` action clears `candidate_asset_id` after the row already satisfies the resolved-state CHECK constraint. `Library::open` calls a cleanup function that resumes `resolving + keep_existing` rows.

Before branching, handle prior state exactly: a resolved row with the same decision returns `SimilarityDecisionOutcome` without another mutation; a resolving `keep_existing` row resumes cleanup; a row carrying another decision returns `LibraryError::SimilarityReviewConflict`; a missing review ID returns `LibraryError::SimilarityReviewNotFound`.

- [x] **Step 5: Run GREEN decision and trash regression tests**

```powershell
cargo test similarity::tests --lib
cargo test trash::tests --lib
```

Expected: PASS; existing trash purge/restore behavior remains unchanged.

- [x] **Step 6: Commit Task 4**

```powershell
git add app/src-tauri/src/library/similarity.rs app/src-tauri/src/library/trash.rs app/src-tauri/src/library/mod.rs
git commit -m "feat: resolve similar image reviews safely"
```

---

### Task 5: Tauri Commands, Media Access, and Frontend Gateway

**Files:**
- Modify: `app/src-tauri/src/commands.rs`
- Modify: `app/src-tauri/src/lib.rs`
- Modify: `app/src-tauri/src/media_protocol.rs`
- Modify: `app/src/library/types.ts`
- Modify: `app/src/library/client.ts`
- Create: `app/src/library/client.test.ts`
- Modify: `app/src/app/App.test.tsx`

**Interfaces:**
- Consumes: Task 4 Library methods and models
- Produces: four Tauri commands and matching `LibraryGateway` methods; review asset media URLs

- [x] **Step 1: Write RED gateway contract tests**

Create `client.test.ts`, mock only `@tauri-apps/api/core`'s `invoke` export with `vi.fn()`, import `libraryGateway` after that mock, clear the mock before each test, and assert these exact command names and camelCase payloads:

```ts
await libraryGateway.indexMissingSimilarityHashes();
await libraryGateway.listSimilarityReviews({ after: null, limit: 20 });
await libraryGateway.decideSimilarityReview({ reviewId: "review-1", decision: "keep_both" });
await libraryGateway.getAsset("asset-1");

expect(invoke).toHaveBeenNthCalledWith(1, "index_missing_similarity_hashes");
expect(invoke).toHaveBeenNthCalledWith(2, "list_similarity_reviews", { after: null, limit: 20 });
expect(invoke).toHaveBeenNthCalledWith(3, "decide_similarity_review", {
  request: { reviewId: "review-1", decision: "keep_both" },
});
expect(invoke).toHaveBeenNthCalledWith(4, "get_asset", { assetId: "asset-1" });
```

Add a Rust media protocol test proving a review candidate thumbnail/asset is readable while a trash asset remains unavailable.

- [x] **Step 2: Run RED Interface tests**

```powershell
cd app
npm.cmd test -- src/library/client.test.ts
cd src-tauri
cargo test review_media_is_available_without_exposing_trash
```

Expected: FAIL because the commands, gateway methods and review media access do not exist.

- [x] **Step 3: Add commands and exact TypeScript types**

Register blocking Rust work with `spawn_blocking` for indexing and decisions. Listing and `get_asset` use synchronous commands under the existing database lock. Add these exact command shapes:

```rust
#[tauri::command]
pub async fn index_missing_similarity_hashes(
    state: State<'_, AppState>,
) -> Result<SimilarityIndexProgress, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || library.index_missing_similarity_hashes())
        .await
        .map_err(|_| background_task_error())?
        .map_err(CommandError::from)
}

#[tauri::command]
pub fn list_similarity_reviews(
    after: Option<AssetCursor>,
    limit: u32,
    state: State<'_, AppState>,
) -> Result<SimilarityReviewPage, CommandError> {
    current_required(state)?.list_similarity_reviews(after, limit).map_err(CommandError::from)
}

#[tauri::command]
pub async fn decide_similarity_review(
    request: SimilarityDecisionRequest,
    state: State<'_, AppState>,
) -> Result<SimilarityDecisionOutcome, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || library.decide_similarity_review(request))
        .await
        .map_err(|_| background_task_error())?
        .map_err(CommandError::from)
}

#[tauri::command]
pub fn get_asset(asset_id: String, state: State<'_, AppState>) -> Result<AssetSummary, CommandError> {
    current_required(state)?.get_asset(&asset_id).map_err(CommandError::from)
}
```

`background_task_error()` returns code `background_task_failed` and a path-free Korean retry message. Extend `CommandError::from` with `invalid_perceptual_hash`, `similarity_review_not_found`, and `similarity_review_conflict`, and register all four commands in `lib.rs`.

Add these TypeScript types:

```ts
export type SimilarityDecision = "keep_existing" | "replace_existing" | "keep_both";
export type SimilarityReviewAsset = {
  asset: AssetSummary;
  format: string;
  classifications: ClassificationEntry[];
};
export type SimilarityReviewSummary = {
  id: string;
  distance: number;
  existing: SimilarityReviewAsset;
  candidate: SimilarityReviewAsset;
};
export type SimilarityReviewPage = {
  items: SimilarityReviewSummary[];
  nextCursor: AssetCursor | null;
  totalCount: number;
};
export type SimilarityIndexProgress = { processed: number; remaining: number; failed: number };
export type SimilarityDecisionOutcome = { status: "resolved"; nextReviewId: string | null };
```

Extend `IngestOutcome` with `{ status: "review_pending"; reviewId: string }` and `LibraryGateway` with the four methods used in the RED test.

- [x] **Step 4: Allow media for normal or review only**

Change the internal media lookup predicate to `status IN ('normal', 'review')`. Keep public asset/trash listing rules unchanged. Test both asset and thumbnail variants.

- [x] **Step 5: Run GREEN Interface tests and build**

```powershell
cd app
npm.cmd test -- src/library/client.test.ts src/app/App.test.tsx
npm.cmd run build
cd src-tauri
cargo test review_media_is_available_without_exposing_trash
```

Expected: all listed tests and TypeScript/Vite build PASS.

- [x] **Step 6: Commit Task 5**

```powershell
git add app/src-tauri/src/commands.rs app/src-tauri/src/lib.rs app/src-tauri/src/media_protocol.rs app/src/library/types.ts app/src/library/client.ts app/src/library/client.test.ts app/src/app/App.test.tsx
git commit -m "feat: expose similar review commands to the UI"
```

---

### Task 6: Persistent In-Session Ingestion Result Summary

**Files:**
- Modify: `app/src/ingestion/useFileDrop.ts`
- Modify: `app/src/ingestion/useFileDrop.test.ts`
- Modify: `app/src/ingestion/WorkTray.tsx`
- Modify: `app/src/ingestion/WorkTray.test.tsx`
- Modify: `app/src/assets/AssetBrowser.tsx`
- Modify: `app/src/assets/AssetBrowser.test.tsx`
- Modify: `app/src/app/App.tsx`
- Modify: `app/src/app/App.test.tsx`

**Interfaces:**
- Consumes: three `IngestOutcome` statuses plus error, `getAsset`
- Produces: per-batch counters, completed result card, dismiss/retry/open-review/open-existing callbacks

- [x] **Step 1: Write RED aggregation tests**

```ts
it("keeps a completed batch with added, duplicate, review, and failure counts", async () => {
  const ingestImage = vi.fn()
    .mockResolvedValueOnce({ status: "added", asset: asset("added") })
    .mockResolvedValueOnce({ status: "exact_duplicate", existingAssetId: "existing" })
    .mockResolvedValueOnce({ status: "review_pending", reviewId: "review" })
    .mockRejectedValueOnce(new Error("unsupported"));
  const { result } = renderDropHook(ingestImage);

  drop(["C:\\in\\added.png", "C:\\in\\same.png", "C:\\in\\variant.jpg", "C:\\in\\bad.txt"]);

  await waitFor(() => expect(result.current.works[0].status).toBe("failed"));
  expect(result.current.works[0]).toMatchObject({
    added: 1,
    exactDuplicates: [{ fileName: "same.png", existingAssetId: "existing" }],
    reviewPending: [{ fileName: "variant.jpg", reviewId: "review" }],
    failures: [{ fileName: "bad.txt", message: expect.any(String) }],
  });
});
```

Add WorkTray behavior tests for a completed successful card remaining visible, dismiss removing it, review button callback, duplicate existing button callback, and failures retrying only failed paths. Assert visible filenames, not source paths.

- [x] **Step 2: Run RED result tests**

```powershell
npm.cmd test -- src/ingestion/useFileDrop.test.ts src/ingestion/WorkTray.test.tsx
```

Expected: FAIL because completed work is hidden and result counters/actions do not exist.

- [x] **Step 3: Extend the work state minimally**

Use this shape; keep failed source paths only in the hook's private retry context:

```ts
export type IngestionWork = {
  kind: "ingestion" | "drag_out";
  id: string;
  total: number;
  completed: number;
  added: number;
  exactDuplicates: Array<{ fileName: string; existingAssetId: string }>;
  reviewPending: Array<{ fileName: string; reviewId: string }>;
  failures: Array<{ fileName: string; message: string }>;
  status: "running" | "completed" | "failed";
};
```

Return `dismissWork(workId)` from `useFileDrop`. Do not emit one Toast per file; the batch card is the result surface. Keep subscription-level fatal errors as Toasts.

Replace the overloaded `onResult` option with these two callbacks so display and refresh responsibilities stay separate:

```ts
type UseFileDropOptions = {
  subscribe: DropSubscriber;
  enabled: boolean;
  classificationId: string | null;
  ingestImage: LibraryGateway["ingestImage"];
  onIngested(result: IngestOutcome): void;
  onFatalError(message: string): void;
};
```

Call `onIngested` after each successful backend result so `App` can refresh normal assets or the review count without showing a Toast. A per-file rejection updates only `failures`; only subscription setup/listener failures call `onFatalError` and reach the shared Toast.

- [x] **Step 4: Render shared result cards and existing asset opening**

`WorkTray` accepts:

```ts
type WorkTrayProps = {
  works: IngestionWork[];
  retryFailed(workId: string): void;
  dismissWork(workId: string): void;
  openReview(): void;
  openExisting(assetId: string): void;
};
```

Completed ingestion cards remain until dismissed; completed drag-out rows remain hidden. `openExisting` calls `gateway.getAsset`, switches to All Assets, and passes the returned `AssetSummary` to `AssetBrowser` as `requestedAsset`. `AssetBrowser` opens that asset in the existing viewer and clears the request on close without requiring it to be in the loaded page.

- [x] **Step 5: Run GREEN result and viewer tests**

```powershell
npm.cmd test -- src/ingestion/useFileDrop.test.ts src/ingestion/WorkTray.test.tsx src/assets/AssetBrowser.test.tsx src/app/App.test.tsx
npm.cmd run build
```

Expected: PASS; completed ingestion result remains, exact duplicate opens the real viewer, and drag-out behavior stays unchanged.

- [x] **Step 6: Commit Task 6**

```powershell
git add app/src/ingestion app/src/assets/AssetBrowser.tsx app/src/assets/AssetBrowser.test.tsx app/src/app/App.tsx app/src/app/App.test.tsx
git commit -m "feat: summarize completed image ingestions"
```

---

### Task 7: Review Queue Navigation and Comparison Screen

**Files:**
- Create: `app/src/similarity/SimilarityReviewBrowser.tsx`
- Create: `app/src/similarity/SimilarityReviewBrowser.test.tsx`
- Create: `app/src/assets/assetMetadata.ts`
- Modify: `app/src/assets/AssetInspector.tsx`
- Modify: `app/src/classification/ClassificationSidebar.tsx`
- Modify: `app/src/classification/ClassificationSidebar.test.tsx`
- Modify: `app/src/library/types.ts`
- Modify: `app/src/app/App.tsx`
- Modify: `app/src/app/App.test.tsx`
- Modify: `app/src/styles/global.css`
- Modify: `app/src/styles/tokens.css`

**Interfaces:**
- Consumes: `listSimilarityReviews`, `decideSimilarityReview`, `assetUrl`, existing `Button`, `EmptyState`, `Toast`
- Produces: `AssetView { kind: "similarity_review" }`, sidebar count, accessible comparison workflow

- [x] **Step 1: Write RED comparison behavior tests**

```tsx
it("shows both public assets and advances after a successful decision", async () => {
  const gateway = reviewGateway();
  gateway.listSimilarityReviews
    .mockResolvedValueOnce(reviewPage([review("review-1")], 2))
    .mockResolvedValueOnce(reviewPage([review("review-2")], 1));
  render(<SimilarityReviewBrowser gateway={gateway} onCountChange={vi.fn()} onClose={vi.fn()} />);

  expect(await screen.findByRole("heading", { name: "유사 이미지 검토" })).toBeInTheDocument();
  expect(screen.getByRole("img", { name: "기존 이미지" })).toHaveAttribute("src", assetUrl("existing"));
  expect(screen.getByRole("img", { name: "새 이미지" })).toHaveAttribute("src", assetUrl("candidate"));
  expect(screen.getByText("1920 × 1080")).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "둘 다 보관" }));
  expect(gateway.decideSimilarityReview).toHaveBeenCalledWith({ reviewId: "review-1", decision: "keep_both" });
  await waitFor(() => expect(gateway.listSimilarityReviews).toHaveBeenCalledTimes(2));
  expect(await screen.findByText("candidate-review-2.png")).toBeInTheDocument();
});
```

`reviewGateway()` returns the existing complete `Mocked<LibraryGateway>` test double with `listSimilarityReviews` and `decideSimilarityReview` exposed as Vitest mocks; the decision mock resolves `{ status: "resolved", nextReviewId: "review-2" }`. `review(id)` returns two fully populated public assets with IDs `existing-${id}` and `candidate-${id}`, and candidate original name `candidate-${id}.png`. `reviewPage(items, totalCount)` returns `{ items, totalCount, nextCursor: null }`. No fixture contains relative paths or hashes.

Add tests for failure retaining the current pair, buttons disabled while pending, Escape calling `onClose` without a decision, last item empty state, and 960px layout class. Sidebar tests assert a stable `검토 대기` button and a badge with accessible name `검토 대기 12개`.

- [x] **Step 2: Run RED review UI tests**

```powershell
npm.cmd test -- src/similarity/SimilarityReviewBrowser.test.tsx src/classification/ClassificationSidebar.test.tsx src/app/App.test.tsx
```

Expected: FAIL because the view, component and sidebar entry do not exist.

- [x] **Step 3: Build the comparison screen from existing UI primitives**

`SimilarityReviewBrowser` loads one open item with `limit: 1`, remembers the initial total for `현재 / 전체`, and reloads after decisions. Render the two sides with one small internal function, not two components with duplicated markup:

```tsx
function ReviewAssetPanel({ side, reviewAsset }: {
  side: "기존 이미지" | "새 이미지";
  reviewAsset: SimilarityReviewAsset;
}) {
  const { asset, format, classifications } = reviewAsset;
  return <section className="similarity-review__asset" aria-label={side}>
    <img src={assetUrl(asset.id)} alt={side} />
    <dl>
      <div><dt>해상도</dt><dd>{asset.width} × {asset.height}</dd></div>
      <div><dt>파일 크기</dt><dd>{formatBytes(asset.byteSize)}</dd></div>
      <div><dt>형식</dt><dd>{format}</dd></div>
      <div><dt>출처</dt><dd>{sourceLabel(asset.sourceUrl)}</dd></div>
      <div><dt>가져온 날짜</dt><dd>{localDate(asset.collectedAt)}</dd></div>
      <div><dt>분류</dt><dd>{classifications.map((entry) => entry.name).join(", ") || "미분류"}</dd></div>
    </dl>
  </section>;
}
```

`AssetInspector` is already a second consumer, so create the shared formatter Module below and import it from both screens:

```ts
export function formatBytes(value: number): string {
  return value < 1024 ? `${value} B` : `${(value / 1024).toFixed(value % 1024 === 0 ? 0 : 1)} KB`;
}

export function sourceLabel(sourceUrl: string | null): string {
  if (!sourceUrl) return "—";
  try {
    const url = new URL(sourceUrl);
    return `${url.hostname}${url.pathname}`;
  } catch {
    return sourceUrl;
  }
}

export function localDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleDateString();
}
```

- [x] **Step 4: Wire navigation, count, and drop rules**

Add `{ kind: "similarity_review" }` to `AssetView`. `ClassificationSidebar` receives `reviewCount`. `App` fetches count with `listSimilarityReviews({ after: null, limit: 1 })` on library open and after review-pending ingestion/decisions. In the content switch, render Trash, SimilarityReviewBrowser, or AssetBrowser. Disable external drop while the review view is active.

- [x] **Step 5: Add token-based responsive styles**

Use a two-column grid above 1100px and one column below it:

```css
.similarity-review__comparison {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-3);
}

@media (max-width: 1100px) {
  .similarity-review__comparison { grid-template-columns: minmax(0, 1fr); }
}
```

Reuse `--toolbar-height`, `--color-surface-elevated`, `--color-border`, `--radius-sm`, `--shadow-floating` and existing button variants. Do not add a second dialog/menu implementation.

- [x] **Step 6: Run GREEN UI tests and build**

```powershell
npm.cmd test -- src/similarity/SimilarityReviewBrowser.test.tsx src/classification/ClassificationSidebar.test.tsx src/app/App.test.tsx
npm.cmd run build
```

Expected: PASS with keyboard names, focus behavior and responsive class contract.

- [x] **Step 7: Commit Task 7**

```powershell
git add app/src/similarity/SimilarityReviewBrowser.tsx app/src/similarity/SimilarityReviewBrowser.test.tsx app/src/assets/assetMetadata.ts app/src/assets/AssetInspector.tsx app/src/classification app/src/library/types.ts app/src/app/App.tsx app/src/app/App.test.tsx app/src/styles
git commit -m "feat: review similar images side by side"
```

---

### Task 8: Background Index Status, Full Regression, and Windows Acceptance

**Files:**
- Create: `app/src/similarity/useSimilarityIndex.ts`
- Create: `app/src/similarity/useSimilarityIndex.test.ts`
- Modify: `app/src/layout/StatusBar.tsx`
- Modify: `app/src/layout/AppShell.test.tsx`
- Modify: `app/src/app/App.tsx`
- Modify: `app/src/app/App.test.tsx`
- Modify: `app/README.md`
- Modify: `docs/superpowers/plans/2026-08-09-lakomics-similar-image-review.md`
- Create local evidence: `.acceptance/similarity-result.png`, `.acceptance/similarity-review-normal.png`, `.acceptance/similarity-review-narrow.png`

**Interfaces:**
- Consumes: `indexMissingSimilarityHashes`, Task 7 screen, temporary test library
- Produces: non-blocking index loop, visible progress/failure status, automated and native evidence

- [x] **Step 1: Write RED indexing hook tests**

```ts
it("runs one library-owned batch at a time until no hashes remain", async () => {
  vi.useFakeTimers();
  const index = vi.fn()
    .mockResolvedValueOnce({ processed: 50, remaining: 1, failed: 1 })
    .mockResolvedValueOnce({ processed: 1, remaining: 0, failed: 1 });
  const { result } = renderHook(() => useSimilarityIndex(index));

  await waitFor(() => expect(index).toHaveBeenCalledTimes(1));
  await vi.runOnlyPendingTimersAsync();
  await waitFor(() => expect(index).toHaveBeenCalledTimes(2));
  expect(result.current).toEqual({ running: false, remaining: 0, failed: 1 });
});
```

Add unmount cancellation, one-call-at-a-time, and failure-stops-with-public-message tests. Add StatusBar rendering tests for `유사 이미지 준비 중: 51개 남음` and `해시 생성 실패 2개`.

- [x] **Step 2: Run RED indexing tests**

```powershell
npm.cmd test -- src/similarity/useSimilarityIndex.test.ts src/layout/AppShell.test.tsx src/app/App.test.tsx
```

Expected: FAIL because the hook and status props do not exist.

- [x] **Step 3: Implement a minimal cancellable loop**

The hook calls the zero-argument library method, schedules the next batch with `window.setTimeout(run, 0)` only when `remaining > 0`, and clears the timer/unmount flag on cleanup. Do not use Web Workers, a job library or persisted frontend state; the database null/error columns already provide restart state.

Pass `{ running, remaining, failed }` to `StatusBar`. Ingestion remains enabled while indexing and the status text explains that only prepared existing assets participate in similarity checks.

- [x] **Step 4: Run complete automated verification**

```powershell
cd C:\chatgpt\.worktrees\daily-use-ui\app
npm.cmd run check
cd src-tauri
cargo fmt --all --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test
cargo test candidate_search_scans_fifty_thousand_hashes --release -- --ignored --nocapture
cd ..
npm.cmd run tauri build -- --debug --no-bundle
```

Expected: every command exits 0, all frontend/Rust tests pass, the 50k search reports under one second, and `src-tauri/target/debug/lakomics.exe` exists.

- [ ] **Step 5: Run actual Windows acceptance**

Use `C:\Users\namwoojun\Desktop\test` when no library is registered. Create external test inputs outside the library: one base image, a resized/re-encoded variant, one exact copy, and one unrelated image. Verify:

1. a four-file drop finishes without pausing;
2. result counts are two added (base and unrelated), one exact duplicate, one review pending, with no source deletion;
3. exact duplicate opens its existing asset;
4. sidebar review count matches the queue;
5. normal and 960×650 review layouts have no horizontal clipping;
6. keep existing removes only the managed candidate;
7. replace trashes existing and transfers classifications/favorite while retaining candidate source/date;
8. keep both leaves two normal assets;
9. closing and reopening preserves unresolved reviews;

The interrupted `resolving` cleanup path is covered by Task 4's automated reopen test; do not add a production acceptance hook just to force it through the packaged app.

Save the three named screenshots without overwriting previous acceptance files.

Evidence note (2026-08-09): the real Windows app verified queue count, both responsive layouts, all three decisions, source preservation, and unresolved-review restart persistence. The four outcomes, continuous multi-file processing, and exact-duplicate open action passed frontend integration tests and were reproduced with the same files through the real `Library` layer. Step 5 remains unchecked because the available Windows controller cannot drag across two separate application windows.

- [x] **Step 6: Update README and verification evidence**

Document the four result counters, review entry, three decisions, temporary library rule, automated counts, performance result, screenshot names and external-source preservation. Mark this plan's checkboxes only with observed evidence.

- [x] **Step 7: Present actual screenshots for visual approval**

Show the result summary, normal comparison and narrow comparison. UI completion requires explicit user approval; requested visual changes rerun affected frontend tests and the real screenshot check.

- [x] **Step 8: Commit Task 8 after approval**

```powershell
git add app/src/similarity/useSimilarityIndex.ts app/src/similarity/useSimilarityIndex.test.ts app/src/layout/StatusBar.tsx app/src/layout/AppShell.test.tsx app/src/app/App.tsx app/src/app/App.test.tsx app/README.md docs/superpowers/plans/2026-08-09-lakomics-similar-image-review.md
git add .acceptance/similarity-result.png .acceptance/similarity-review-normal.png .acceptance/similarity-review-narrow.png
git commit -m "docs: record similar image review acceptance"
```

## Plan Self-Review

- Spec coverage: 지각 해시, 점진 인덱스, 완전 중복 우선, review 영속화, 네 가지 결과, 세 가지 결정, 메타데이터 승계, 재시작 정리, 5만 개 성능과 실제 Windows 검증이 Tasks 1~8에 연결되어 있다.
- Scope: 휴지통 완전 중복 복원, 누락 자산 복구, 일반 수집 작업 재개, 확장 프로그램, 영상, 작품·컬렉션 자체는 포함하지 않는다.
- Type consistency: Rust와 TypeScript의 `SimilarityDecision`, `SimilarityReviewPage`, `SimilarityIndexProgress`, `review_pending` 이름과 camelCase/snake_case 변환이 Tasks 1·5·7에서 일치한다.
- State transitions: open→resolved는 replace/both 한 트랜잭션, open→resolving→resolved는 keep existing의 재개 가능한 파일 정리 경로로만 사용한다.
- Module depth: React는 네 개의 Gateway 호출만 알고 해시·경로·SQL은 `library/similarity.rs` 뒤에 남는다.
- Minimality: 기존 `image`, `AssetView`, `WorkTray`, media URL, 공통 UI와 디자인 토큰을 확장하며 새 dependency, 상태 라이브러리, Adapter나 설정 화면을 만들지 않는다.
- Test integrity: 테스트는 실제 SQLite·파일·React 결과를 확인하고 source-text 정규식이나 mock 존재 자체를 성공 조건으로 사용하지 않는다.
