# Lakomics PDQ Similarity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Lakomics' 64-bit dHash similarity review trigger with a strict, quality-gated 256-bit PDQ fingerprint while preserving exact-duplicate behavior and historical reviews.

**Architecture:** A single internal `image_fingerprint` Module owns PDQ calculation, byte representation, Hamming distance, and aspect-ratio compatibility. Existing ingestion and similarity Modules continue to own orchestration and SQLite access; a v25 migration reuses the hash BLOB, adds quality, and labels review history by fingerprint kind.

**Tech Stack:** Rust 2021, `pdqhash = "=0.1.1"`, `image 0.25`, rusqlite/SQLite, Tauri 2, Windows MSVC.

## Global Constraints

- Use only original-orientation 256-bit PDQ; do not generate dihedral hashes.
- Use `PDQ_QUALITY_MIN = 50`, `PDQ_DISTANCE_MAX = 20`, `ASPECT_RATIO_MAX_FACTOR = 1.15`, and `INDEX_BATCH_SIZE = 50`.
- Include `media_kind IN ('image', 'gif')`; exclude `video` from fingerprint generation, candidate search, remaining counts, and failure counts.
- Keep exact SHA-256 duplicate detection before PDQ.
- Preserve all historical review rows and the global `candidate_asset_id TEXT UNIQUE` constraint.
- Keep candidate selection ordered by distance, then `collected_at`, then asset ID.
- Do not add ANN, user-tunable thresholds, model files, parallel queues, or frontend changes.
- Do not write to or migrate `C:\New_lakomics_assets`; the only permitted operation is an explicitly read-only audit.
- Do not commit or push without separate user authorization.

---

### Task 1: Prove the PDQ dependency and internal fingerprint boundary

**Files:**
- Modify: `app/src-tauri/Cargo.toml`
- Modify: `app/src-tauri/Cargo.lock`
- Modify: `app/src-tauri/src/library/mod.rs`
- Create: `app/src-tauri/src/library/image_fingerprint.rs`

**Interfaces:**
- Consumes: `pdqhash::generate_pdq(&pdqhash::image::DynamicImage) -> Option<([u8; 32], f32)>` through a private `image 0.25` to `image 0.23` conversion.
- Produces: `ImageFingerprint { bytes: [u8; 32], cropped_bytes: [u8; 32], quality: u8 }`, `fingerprint`, `hamming_distance`, and `dimensions_are_compatible` for Tasks 3-4.

- [ ] **Step 1: Add failing unit tests for the desired boundary**

```rust
#[test]
fn fingerprint_returns_pdq_bytes_and_quality() {
    let image = detailed_fixture(640, 480);
    let result = fingerprint(&image).unwrap();
    assert_eq!(result.bytes.len(), 32);
    assert!(result.quality <= 100);
    assert_eq!(hamming_distance(&result.bytes, &result.bytes), 0);
}

#[test]
fn hamming_distance_counts_all_256_bits() {
    assert_eq!(hamming_distance(&[0; 32], &[u8::MAX; 32]), 256);
}

#[test]
fn aspect_ratio_uses_the_strict_factor() {
    assert!(dimensions_are_compatible((1000, 1000), (1150, 1000)));
    assert!(!dimensions_are_compatible((1000, 1000), (1151, 1000)));
}
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `cargo test image_fingerprint --lib`

Expected: FAIL because the new functions do not yet satisfy the assertions.

- [ ] **Step 3: Add the pinned dependency and minimal implementation**

```toml
pdqhash = "=0.1.1"
```

```rust
pub(crate) fn fingerprint(image: &DynamicImage) -> Result<ImageFingerprint, LibraryError> {
    let rgba = image.to_rgba8();
    let compatible = pdqhash::image::RgbaImage::from_raw(
        rgba.width(), rgba.height(), rgba.into_raw()
    ).ok_or(LibraryError::UnsupportedImage)?;
    let (bytes, quality) = pdqhash::generate_pdq(
        &pdqhash::image::DynamicImage::ImageRgba8(compatible)
    ).ok_or(LibraryError::UnsupportedImage)?;
    Ok(ImageFingerprint { bytes, quality: (quality * 100.0).round() as u8 })
}

pub(crate) fn hamming_distance(left: &[u8; 32], right: &[u8; 32]) -> u32 {
    left.iter().zip(right).map(|(a, b)| (a ^ b).count_ones()).sum()
}
```

Implement `dimensions_are_compatible` by cross-multiplying normalized width/height ratios as `f64`; return `false` for zero dimensions.

- [ ] **Step 4: Run focused tests and the Windows dependency gate**

Run: `cargo test image_fingerprint --lib`

Expected: all `image_fingerprint` tests PASS.

Run: `cargo build --release --lib`

Expected: PASS without a C++ or bindgen step. If the pure Rust dependency cannot build in the supported environment, stop before Task 2 and record the concrete failure.

---

### Task 2: Measure the real-library quality distribution without writes

**Files:**
- Create: `app/src-tauri/examples/pdq_similarity_audit.rs`

**Interfaces:**
- Consumes: a library root path argument and its `library.sqlite` opened with `SQLITE_OPEN_READ_ONLY`.
- Produces: counts for eligible assets, successful fingerprints, failures, quality buckets, quality below 50, and historical `keep_both` pair distances.

- [ ] **Step 1: Add failing tests for audit bucketing and path eligibility**

```rust
#[test]
fn quality_buckets_cover_zero_through_one_hundred() {
    assert_eq!(quality_bucket(0), "0-9");
    assert_eq!(quality_bucket(50), "50-59");
    assert_eq!(quality_bucket(100), "100");
}

#[test]
fn eligible_media_includes_gif_but_not_video() {
    assert!(eligible_media("image"));
    assert!(eligible_media("gif"));
    assert!(!eligible_media("video"));
}
```

- [ ] **Step 2: Run the example tests and verify RED**

Run: `cargo test --example pdq_similarity_audit`

Expected: FAIL because the audit helpers do not exist.

- [ ] **Step 3: Implement the read-only audit**

Open SQLite with only `OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX`. Query `status = 'normal' AND media_kind IN ('image', 'gif')`, open each `relative_path` read-only, decode it, convert it inside the audit, and call `pdqhash::generate_pdq`. Query resolved `keep_both` reviews by joining their existing and candidate assets, compute distance and aspect compatibility, and print one line per pair. Do not call `Library::open`, create directories, execute SQL, or update the database.

- [ ] **Step 4: Verify the audit helper and run it against the active library**

Run: `cargo test --example pdq_similarity_audit`

Expected: PASS.

Run: `cargo run --release --example pdq_similarity_audit -- C:\New_lakomics_assets`

Expected: report-only output. If quality below 50 exceeds 5%, pause before Task 3 and review representative low-quality images; never lower the threshold automatically.

---

### Task 3: Add the v25 schema migration with history preservation

**Files:**
- Create: `app/src-tauri/migrations/0025_pdq_similarity.sql`
- Modify: `app/src-tauri/src/library/db.rs`

**Interfaces:**
- Produces: nullable `assets.perceptual_hash_quality`, 0..256 review distance, and `similarity_reviews.fingerprint_kind` with old rows marked `dhash-v1`.

- [ ] **Step 1: Add a failing v24-to-v25 migration test**

Create a v24 fixture containing normal image/GIF/video rows plus open and resolved reviews. Assert after opening that:

```rust
assert_eq!(user_version, 25);
assert_eq!(preserved_reviews, 2);
assert_eq!(historical_kinds, vec!["dhash-v1", "dhash-v1"]);
assert_eq!(non_null_hashes, 0);
assert_eq!(non_null_hash_errors, 0);
assert!(duplicate_candidate_insert.is_err());
```

Also run `PRAGMA foreign_key_check` and assert it returns no rows.

- [ ] **Step 2: Run the migration test and verify RED**

Run: `cargo test migrates_v24_similarity_state_to_pdq_v25 --lib`

Expected: FAIL because schema version 25 and the new columns do not exist.

- [ ] **Step 3: Implement the migration and register it**

The SQL must add:

```sql
ALTER TABLE assets ADD COLUMN perceptual_hash_quality INTEGER
    CHECK (perceptual_hash_quality IS NULL OR perceptual_hash_quality BETWEEN 0 AND 100);
```

Recreate `similarity_reviews` with `distance BETWEEN 0 AND 256`, `fingerprint_kind TEXT NOT NULL`, the existing status/decision CHECK, both `ON DELETE SET NULL` foreign keys, and `candidate_asset_id TEXT UNIQUE`. Copy all old rows with `'dhash-v1'`, drop the old table, rename the replacement, recreate `similarity_reviews_by_status`, clear all three fingerprint columns, and set `PRAGMA user_version = 25`. Update `SCHEMA_VERSION`, the migration include list, and the migration dispatcher in `db.rs`.

- [ ] **Step 4: Run migration tests and verify GREEN**

Run: `cargo test migrates_v24_similarity_state_to_pdq_v25 --lib`

Expected: PASS.

Run: `cargo test library::db::tests --lib`

Expected: all database migration tests PASS.

---

### Task 4: Replace runtime dHash orchestration with strict PDQ policy

**Files:**
- Modify: `app/src-tauri/src/library/ingestion.rs`
- Modify: `app/src-tauri/src/library/similarity.rs`

**Interfaces:**
- Consumes: `ImageFingerprint` and helpers from Task 1 plus the v25 columns from Task 3.
- Produces: quality/aspect-gated candidate selection, PDQ persistence, image/GIF-only background indexing, and `pdq-v1` review rows.

- [ ] **Step 1: Add failing candidate-policy tests**

Add tests proving these independent behaviors:

```rust
// A target or candidate below quality 50 yields no candidate.
// A factor greater than 1.15 yields no candidate even at distance 0.
// A 20-bit distance matches and a 21-bit distance does not.
// Equal distance preserves collected_at then ID ordering.
// A malformed non-64-byte stored fingerprint bundle returns InvalidPerceptualHash.
```

Use literal 32-byte hashes combined into 64-byte stored bundles and hand-set quality/dimensions so the tests do not mirror production calculations.

- [ ] **Step 2: Run the policy tests and verify RED**

Run: `cargo test pdq_candidate --lib`

Expected: FAIL under the existing 8-byte dHash implementation.

- [ ] **Step 3: Implement candidate search and persistence**

Change `find_similar_asset` to accept `&ImageFingerprint` and `(u32, u32)`. Query `id, perceptual_hash, perceptual_hash_quality, width, height` from normal `image`/`gif` rows with quality at least 50. Validate exactly 64 bytes, apply aspect compatibility before Hamming distance, accept at most 20, and preserve SQL ordering with replacement only on strictly smaller distance.

Change ingestion to decode once for fingerprint generation, store the concatenated 64-byte whole/central-crop bundle and minimum quality, and insert `fingerprint_kind = 'pdq-v1'` for new reviews. Compare all four whole/crop combinations and keep their minimum distance. Keep SHA-256 exact duplicate detection before image decoding and preserve legacy-import similarity bypass. A valid image smaller than PDQ's 5-pixel minimum must still ingest successfully without an immediate similarity candidate.

- [ ] **Step 4: Add failing background-index tests**

Create normal image, GIF, and video fixtures with missing hashes. Assert one indexing run fingerprints image/GIF, leaves video untouched, and reports remaining/failed counts only for image/GIF. Add a low-quality fixture and assert its hash and quality are stored without creating a review.

- [ ] **Step 5: Run background-index tests and verify RED**

Run: `cargo test pdq_index --lib`

Expected: FAIL because the existing indexer includes video and stores only 8-byte hashes.

- [ ] **Step 6: Implement image/GIF-only indexing and progress counts**

Use `status = 'normal' AND media_kind IN ('image', 'gif')` consistently in selection, updates, remaining counts, failure counts, and candidate search. Persist `perceptual_hash` and `perceptual_hash_quality` together on success and keep existing stable error-code mapping on failure.

- [ ] **Step 7: Add transformation regression tests**

Generate deterministic detailed fixtures and assert resize, JPEG 70, PNG/WebP conversion, 5% crop, and a small corner watermark remain within distance 20. Assert a deterministic dHash-collision-style negative pair exceeds 20 and a flat fixture has quality below 50.

- [ ] **Step 8: Run the targeted similarity and ingestion suites**

Run: `cargo test similarity --lib`

Expected: all non-ignored similarity tests PASS.

Run: `cargo test ingestion --lib`

Expected: all ingestion tests PASS.

---

### Task 5: Record licenses and the active-library safety boundary

**Files:**
- Modify: `AGENTS.md`
- Create: `app/src-tauri/licenses/pdqhash-Apache-2.0.txt`
- Modify: `app/src-tauri/tauri.conf.json`

**Interfaces:**
- Produces: packaged attribution for the linked dependency and durable agent rules preventing accidental writes to the wrong library.

- [ ] **Step 1: Copy exact upstream license texts**

Copy the `pdqhash` Apache-2.0 text from the pinned crate without paraphrasing. Add `licenses/*` as a Tauri resource mapped to `licenses/`.

- [ ] **Step 2: Add the operational boundary to `AGENTS.md`**

Record `C:\New_lakomics_assets` as the active library, forbid inferring another `library.sqlite` as active, exclude `C:\Users\namwoojun\Desktop\새 폴더 (2)` unless explicitly requested, permit read-only analysis, and require separate approval for writes or migrations. State that application behavior must never branch on these paths.

- [ ] **Step 3: Verify configuration syntax**

Run: `cargo metadata --no-deps --format-version 1`

Expected: valid JSON and exit code 0.

---

### Task 6: Performance and final verification

**Files:**
- Modify: `app/src-tauri/src/library/similarity.rs` only if the existing ignored performance test needs 64-byte fingerprint bundles and quality/dimension columns.

**Interfaces:**
- Produces: fresh evidence for correctness, migration safety, throughput, and release compatibility.

- [ ] **Step 1: Update and run the ignored 50,000-candidate test**

Populate 50,000 literal 64-byte whole/crop fingerprint bundles with quality 100 and compatible dimensions. Run:

`cargo test candidate_search_scans_fifty_thousand_hashes --release --lib -- --ignored --nocapture`

Expected: PASS and measured search duration below one second.

- [ ] **Step 2: Run the complete Rust library suite**

Run: `cargo test --lib`

Expected: all non-ignored tests PASS.

- [ ] **Step 3: Run the Windows release build**

Run: `cargo build --release --lib`

Expected: exit code 0.

- [ ] **Step 4: Re-run the read-only real-library audit**

Run: `cargo run --release --example pdq_similarity_audit -- C:\New_lakomics_assets`

Expected: the database modification timestamp and hash remain unchanged; all four preserved `keep_both` false-positive pairs exceed the accepted policy or fail the aspect gate.

- [ ] **Step 5: Inspect the final diff**

Run: `git diff --check` and `git status --short`

Expected: no whitespace errors, no build outputs, no user assets, and only planned source/docs/config/license changes.
