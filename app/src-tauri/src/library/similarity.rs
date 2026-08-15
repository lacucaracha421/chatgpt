use std::{
    fs::File,
    io::{BufReader, Seek, SeekFrom},
    path::Path,
};

use image::{DynamicImage, ImageReader};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use super::{
    classification::classifications_for_asset,
    error::LibraryError,
    models::{
        AssetCursor, AssetSummary, SimilarityDecision, SimilarityDecisionRequest,
        SimilarityIndexProgress, SimilarityReviewAsset, SimilarityReviewPage,
        SimilarityReviewSummary,
    },
    query::asset_summary_from_row,
    Library, MediaVariant,
};

const SIMILARITY_DISTANCE_MAX: u32 = 6;
const INDEX_BATCH_SIZE: u32 = 50;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SimilarAssetCandidate {
    pub(crate) asset_id: String,
    pub(crate) distance: u32,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ReviewCursor {
    created_at: String,
    id: String,
}

struct OpenReviewRow {
    id: String,
    existing_asset_id: String,
    candidate_asset_id: String,
    distance: u32,
    created_at: String,
}

struct StoredReview {
    existing_asset_id: Option<String>,
    candidate_asset_id: Option<String>,
    status: String,
    decision: Option<String>,
}

impl Library {
    pub fn list_similarity_reviews(
        &self,
        after: Option<AssetCursor>,
        limit: u32,
    ) -> Result<SimilarityReviewPage, LibraryError> {
        if !(1..=200).contains(&limit) {
            return Err(LibraryError::InvalidAssetPageLimit);
        }
        let cursor = decode_review_cursor(after)?;
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        let total_count: i64 = transaction.query_row(
            "SELECT COUNT(*) FROM similarity_reviews WHERE status = 'open'",
            [],
            |row| row.get(0),
        )?;
        let (created_at, id) = cursor
            .as_ref()
            .map(|cursor| (Some(cursor.created_at.as_str()), Some(cursor.id.as_str())))
            .unwrap_or((None, None));
        let mut statement = transaction.prepare(
            "SELECT id, existing_asset_id, candidate_asset_id, distance, created_at
             FROM similarity_reviews
             WHERE status = 'open'
               AND (?1 IS NULL OR created_at > ?1 OR (created_at = ?1 AND id > ?2))
             ORDER BY created_at, id
             LIMIT ?3",
        )?;
        let rows = statement
            .query_map(params![created_at, id, i64::from(limit) + 1], |row| {
                Ok(OpenReviewRow {
                    id: row.get(0)?,
                    existing_asset_id: row.get(1)?,
                    candidate_asset_id: row.get(2)?,
                    distance: row.get(3)?,
                    created_at: row.get(4)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        drop(statement);

        let has_more = rows.len() > limit as usize;
        let rows = rows.into_iter().take(limit as usize).collect::<Vec<_>>();
        let next_cursor = has_more.then(|| {
            let row = rows.last().expect("a page with more rows contains one row");
            AssetCursor {
                token: serde_json::to_string(&ReviewCursor {
                    created_at: row.created_at.clone(),
                    id: row.id.clone(),
                })
                .expect("review cursor serializes"),
            }
        });
        let items = rows
            .into_iter()
            .map(|row| {
                Ok(SimilarityReviewSummary {
                    id: row.id,
                    distance: row.distance,
                    existing: load_review_asset(&transaction, &row.existing_asset_id, "normal")?,
                    candidate: load_review_asset(&transaction, &row.candidate_asset_id, "review")?,
                })
            })
            .collect::<Result<Vec<_>, LibraryError>>()?;
        transaction.commit()?;
        Ok(SimilarityReviewPage {
            items,
            next_cursor,
            total_count: u64::try_from(total_count).unwrap_or(0),
        })
    }

    pub fn get_asset(&self, asset_id: &str) -> Result<AssetSummary, LibraryError> {
        let connection = self.connection()?;
        load_asset_summary(&connection, asset_id, "normal")
    }

    pub fn decide_similarity_review(
        &self,
        request: SimilarityDecisionRequest,
    ) -> Result<(), LibraryError> {
        let _trash_guard = self
            .trash_lock
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let review = self.load_stored_review(&request.review_id)?;
        let requested = decision_name(request.decision);
        match review.status.as_str() {
            "resolved" if review.decision.as_deref() == Some(requested) => {
                return Ok(());
            }
            "resolved" => return Err(LibraryError::SimilarityReviewConflict),
            "resolving"
                if review.decision.as_deref() == Some("keep_existing")
                    && request.decision == SimilarityDecision::KeepExisting =>
            {
                self.finish_keep_existing(&request.review_id, &review)?;
            }
            "resolving" => return Err(LibraryError::SimilarityReviewConflict),
            "open" => match request.decision {
                SimilarityDecision::KeepExisting => {
                    self.begin_keep_existing(&request.review_id, &review)?;
                    run_after_review_resolving_hook()?;
                    self.finish_keep_existing(&request.review_id, &review)?;
                }
                SimilarityDecision::ReplaceExisting => {
                    self.resolve_replace_existing(&request.review_id, &review)?;
                }
                SimilarityDecision::KeepBoth => {
                    self.resolve_keep_both(&request.review_id, &review)?;
                }
            },
            _ => return Err(LibraryError::SimilarityReviewConflict),
        }
        Ok(())
    }

    pub(crate) fn cleanup_resolving_similarity_reviews(&self) -> Result<(), LibraryError> {
        let _trash_guard = self
            .trash_lock
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let review_ids = {
            let connection = self.connection()?;
            let review_ids = connection
                .prepare(
                    "SELECT id FROM similarity_reviews
                     WHERE status = 'resolving' AND decision = 'keep_existing'
                     ORDER BY created_at, id",
                )?
                .query_map([], |row| row.get(0))?
                .collect::<Result<Vec<String>, _>>()?;
            review_ids
        };
        for review_id in review_ids {
            let review = self.load_stored_review(&review_id)?;
            self.finish_keep_existing(&review_id, &review)?;
        }
        Ok(())
    }

    fn load_stored_review(&self, review_id: &str) -> Result<StoredReview, LibraryError> {
        self.connection()?
            .query_row(
                "SELECT existing_asset_id, candidate_asset_id, status, decision
                 FROM similarity_reviews WHERE id = ?1",
                [review_id],
                |row| {
                    Ok(StoredReview {
                        existing_asset_id: row.get(0)?,
                        candidate_asset_id: row.get(1)?,
                        status: row.get(2)?,
                        decision: row.get(3)?,
                    })
                },
            )
            .optional()?
            .ok_or(LibraryError::SimilarityReviewNotFound)
    }

    fn resolve_replace_existing(
        &self,
        review_id: &str,
        review: &StoredReview,
    ) -> Result<(), LibraryError> {
        let (existing_id, candidate_id) = open_review_asset_ids(review)?;
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        verify_asset_status(&transaction, existing_id, "normal")?;
        verify_asset_status(&transaction, candidate_id, "review")?;
        transaction.execute(
            "INSERT OR IGNORE INTO asset_classifications (asset_id, classification_id)
             SELECT ?2, classification_id FROM asset_classifications WHERE asset_id = ?1",
            params![existing_id, candidate_id],
        )?;
        transaction.execute(
            "UPDATE assets SET favorite = (SELECT favorite FROM assets WHERE id = ?1)
             WHERE id = ?2 AND status = 'review'",
            params![existing_id, candidate_id],
        )?;
        transaction.execute(
            "UPDATE assets SET status = 'trash', trashed_at = ?2 WHERE id = ?1 AND status = 'normal'",
            params![existing_id, chrono::Utc::now().to_rfc3339()],
        )?;
        transaction.execute(
            "UPDATE assets SET status = 'normal', trashed_at = NULL WHERE id = ?1 AND status = 'review'",
            [candidate_id],
        )?;
        resolve_review(&transaction, review_id, "replace_existing")?;
        transaction.commit()?;
        Ok(())
    }

    fn resolve_keep_both(
        &self,
        review_id: &str,
        review: &StoredReview,
    ) -> Result<(), LibraryError> {
        let (existing_id, candidate_id) = open_review_asset_ids(review)?;
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        verify_asset_status(&transaction, existing_id, "normal")?;
        verify_asset_status(&transaction, candidate_id, "review")?;
        transaction.execute(
            "UPDATE assets SET status = 'normal', trashed_at = NULL WHERE id = ?1 AND status = 'review'",
            [candidate_id],
        )?;
        resolve_review(&transaction, review_id, "keep_both")?;
        transaction.commit()?;
        Ok(())
    }

    fn begin_keep_existing(
        &self,
        review_id: &str,
        review: &StoredReview,
    ) -> Result<(), LibraryError> {
        let (existing_id, candidate_id) = open_review_asset_ids(review)?;
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        verify_asset_status(&transaction, existing_id, "normal")?;
        verify_asset_status(&transaction, candidate_id, "review")?;
        let changed = transaction.execute(
            "UPDATE similarity_reviews
             SET status = 'resolving', decision = 'keep_existing'
             WHERE id = ?1 AND status = 'open'",
            [review_id],
        )?;
        if changed != 1 {
            return Err(LibraryError::SimilarityReviewConflict);
        }
        transaction.commit()?;
        Ok(())
    }

    fn finish_keep_existing(
        &self,
        review_id: &str,
        review: &StoredReview,
    ) -> Result<(), LibraryError> {
        let candidate_id = review
            .candidate_asset_id
            .as_deref()
            .ok_or(LibraryError::SimilarityReviewConflict)?;
        let (relative_path, thumbnail_relative_path): (String, String) = self
            .connection()?
            .query_row(
                "SELECT relative_path, thumbnail_relative_path
                 FROM assets WHERE id = ?1 AND status = 'review'",
                [candidate_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?
            .ok_or(LibraryError::SimilarityReviewConflict)?;
        self.remove_review_candidate_files(&relative_path, &thumbnail_relative_path)?;

        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        resolve_review(&transaction, review_id, "keep_existing")?;
        transaction.execute(
            "DELETE FROM assets WHERE id = ?1 AND status = 'review'",
            [candidate_id],
        )?;
        transaction.commit()?;
        Ok(())
    }

    #[cfg(windows)]
    fn remove_review_candidate_files(
        &self,
        relative_path: &str,
        thumbnail_relative_path: &str,
    ) -> Result<(), LibraryError> {
        self.remove_managed_files(relative_path, thumbnail_relative_path)
            .map_err(|()| LibraryError::WriteAsset {
                path: self.root().to_path_buf(),
                source: std::io::Error::other("managed review file cleanup failed"),
            })
    }

    #[cfg(not(windows))]
    fn remove_review_candidate_files(
        &self,
        _relative_path: &str,
        _thumbnail_relative_path: &str,
    ) -> Result<(), LibraryError> {
        Err(LibraryError::UnsupportedManagedFileDeletion)
    }

    pub fn index_missing_similarity_hashes(&self) -> Result<SimilarityIndexProgress, LibraryError> {
        let asset_ids = {
            let connection = self.connection()?;
            let mut statement = connection.prepare(
                "SELECT id
                 FROM assets
                 WHERE status = 'normal'
                   AND perceptual_hash IS NULL
                   AND perceptual_hash_error IS NULL
                 ORDER BY collected_at, id
                 LIMIT ?1",
            )?;
            let ids = statement
                .query_map([INDEX_BATCH_SIZE], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            ids
        };

        for asset_id in &asset_ids {
            let result = self
                .resolve_media(asset_id, MediaVariant::Asset)
                .and_then(|media| perceptual_hash_from_file(media.file));
            let connection = self.connection()?;
            match result {
                Ok(hash) => {
                    connection.execute(
                        "UPDATE assets
                         SET perceptual_hash = ?2
                         WHERE id = ?1 AND status = 'normal'",
                        params![asset_id, hash.to_be_bytes()],
                    )?;
                }
                Err(error) => {
                    let code = similarity_index_error_code(&error).ok_or(error)?;
                    connection.execute(
                        "UPDATE assets
                         SET perceptual_hash_error = ?2
                         WHERE id = ?1 AND status = 'normal'",
                        params![asset_id, code],
                    )?;
                }
            }
        }

        let connection = self.connection()?;
        let (remaining, failed): (i64, i64) = connection.query_row(
            "SELECT
                COALESCE(SUM(CASE WHEN perceptual_hash IS NULL AND perceptual_hash_error IS NULL THEN 1 ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN perceptual_hash_error IS NOT NULL THEN 1 ELSE 0 END), 0)
             FROM assets
             WHERE status = 'normal'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        Ok(SimilarityIndexProgress {
            remaining: remaining as u64,
            failed: failed as u64,
        })
    }

    pub(crate) fn find_similar_asset(
        &self,
        target_hash: u64,
    ) -> Result<Option<SimilarAssetCandidate>, LibraryError> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT id, perceptual_hash
             FROM assets
             WHERE status = 'normal' AND perceptual_hash IS NOT NULL
             ORDER BY collected_at, id",
        )?;
        let rows = statement.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Vec<u8>>(1)?))
        })?;
        let mut best: Option<SimilarAssetCandidate> = None;
        for row in rows {
            let (asset_id, bytes) = row?;
            let bytes: [u8; 8] = bytes
                .try_into()
                .map_err(|_| LibraryError::InvalidPerceptualHash)?;
            let distance = hamming_distance(target_hash, u64::from_be_bytes(bytes));
            if distance <= SIMILARITY_DISTANCE_MAX
                && best
                    .as_ref()
                    .is_none_or(|candidate| distance < candidate.distance)
            {
                best = Some(SimilarAssetCandidate { asset_id, distance });
            }
        }
        Ok(best)
    }
}

fn decode_review_cursor(after: Option<AssetCursor>) -> Result<Option<ReviewCursor>, LibraryError> {
    after
        .map(|cursor| {
            serde_json::from_str(&cursor.token).map_err(|_| LibraryError::InvalidAssetCursor)
        })
        .transpose()
}

fn load_review_asset(
    connection: &Connection,
    asset_id: &str,
    expected_status: &str,
) -> Result<SimilarityReviewAsset, LibraryError> {
    let asset = load_asset_summary(connection, asset_id, expected_status)?;
    let format = Path::new(&asset.relative_path)
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| match extension.to_ascii_uppercase().as_str() {
            "JPG" => "JPEG".to_owned(),
            other => other.to_owned(),
        })
        .unwrap_or_else(|| "IMAGE".to_owned());
    let classifications = classifications_for_asset(connection, asset_id)?;
    Ok(SimilarityReviewAsset {
        asset,
        format,
        classifications,
    })
}

fn load_asset_summary(
    connection: &Connection,
    asset_id: &str,
    expected_status: &str,
) -> Result<AssetSummary, LibraryError> {
    connection
        .query_row(
            "SELECT asset.id, asset.title, asset.original_name, asset.relative_path,
                    asset.thumbnail_relative_path, asset.byte_size, asset.width, asset.height,
                    asset.collected_at, asset.favorite, asset.source_url, asset.media_kind,
                    video.duration_ms, video.preparation_state, video.scrub_frame_count,
                    asset.source_published_at, asset.creator_name, asset.creator_handle,
                    asset.creator_url, asset.import_source, asset.import_batch_id,
                    asset.original_modified_at
             FROM assets AS asset
             LEFT JOIN video_assets AS video ON video.asset_id = asset.id
             WHERE asset.id = ?1 AND asset.status = ?2",
            params![asset_id, expected_status],
            asset_summary_from_row,
        )
        .optional()?
        .ok_or(LibraryError::AssetNotFound)
}

fn decision_name(decision: SimilarityDecision) -> &'static str {
    match decision {
        SimilarityDecision::KeepExisting => "keep_existing",
        SimilarityDecision::ReplaceExisting => "replace_existing",
        SimilarityDecision::KeepBoth => "keep_both",
    }
}

fn open_review_asset_ids(review: &StoredReview) -> Result<(&str, &str), LibraryError> {
    match (
        review.existing_asset_id.as_deref(),
        review.candidate_asset_id.as_deref(),
    ) {
        (Some(existing_id), Some(candidate_id)) => Ok((existing_id, candidate_id)),
        _ => Err(LibraryError::SimilarityReviewConflict),
    }
}

fn verify_asset_status(
    connection: &Connection,
    asset_id: &str,
    expected_status: &str,
) -> Result<(), LibraryError> {
    let matches: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM assets WHERE id = ?1 AND status = ?2)",
        params![asset_id, expected_status],
        |row| row.get(0),
    )?;
    if matches {
        Ok(())
    } else {
        Err(LibraryError::SimilarityReviewConflict)
    }
}

fn resolve_review(
    connection: &Connection,
    review_id: &str,
    decision: &str,
) -> Result<(), LibraryError> {
    let changed = connection.execute(
        "UPDATE similarity_reviews
         SET status = 'resolved', decision = ?2, resolved_at = ?3
         WHERE id = ?1 AND status IN ('open', 'resolving')",
        params![review_id, decision, chrono::Utc::now().to_rfc3339()],
    )?;
    if changed == 1 {
        Ok(())
    } else {
        Err(LibraryError::SimilarityReviewConflict)
    }
}

#[cfg(test)]
type AfterReviewResolvingHook = Box<dyn FnOnce() -> Result<(), LibraryError>>;

#[cfg(test)]
thread_local! {
    static AFTER_REVIEW_RESOLVING_HOOK: std::cell::RefCell<Option<AfterReviewResolvingHook>> =
        const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
fn set_after_review_resolving_hook(hook: impl FnOnce() -> Result<(), LibraryError> + 'static) {
    AFTER_REVIEW_RESOLVING_HOOK.with(|stored| *stored.borrow_mut() = Some(Box::new(hook)));
}

#[cfg(test)]
fn run_after_review_resolving_hook() -> Result<(), LibraryError> {
    AFTER_REVIEW_RESOLVING_HOOK.with(|stored| {
        let hook = stored.borrow_mut().take();
        hook.map_or(Ok(()), |hook| hook())
    })
}

#[cfg(not(test))]
fn run_after_review_resolving_hook() -> Result<(), LibraryError> {
    Ok(())
}

pub(crate) fn perceptual_hash_from_file(mut file: File) -> Result<u64, LibraryError> {
    file.seek(SeekFrom::Start(0))
        .map_err(|_| LibraryError::UnsupportedImage)?;
    let image = ImageReader::new(BufReader::new(file))
        .with_guessed_format()
        .map_err(|_| LibraryError::UnsupportedImage)?
        .decode()
        .map_err(|_| LibraryError::UnsupportedImage)?;
    Ok(perceptual_hash(&image))
}

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

fn similarity_index_error_code(error: &LibraryError) -> Option<&'static str> {
    match error {
        LibraryError::AssetNotFound | LibraryError::MediaNotFound => Some("media_not_found"),
        LibraryError::UnsafeMediaPath => Some("unsafe_media_path"),
        LibraryError::ReadMedia { .. } => Some("read_media_failed"),
        LibraryError::UnsupportedImage => Some("unsupported_image"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use std::{fs, path::PathBuf, time::Instant};

    use image::{
        codecs::jpeg::JpegEncoder, imageops::FilterType, DynamicImage, ImageBuffer, Rgb, RgbImage,
    };
    use rusqlite::params;
    use tempfile::TempDir;

    use super::super::{
        error::LibraryError,
        models::{
            AssetCursor, ClassificationKind, CreateClassification, ImportSource, IngestMediaRequest,
            IngestOutcome, SimilarityDecision, SimilarityDecisionRequest,
        },
        Library,
    };
    use super::{hamming_distance, perceptual_hash, set_after_review_resolving_hook};

    #[derive(Clone, Copy)]
    enum StripeDirection {
        Vertical,
        Horizontal,
    }

    struct TestLibrary {
        _temp: TempDir,
        library: Library,
    }

    struct ReviewFixture {
        _temp: TempDir,
        library: Library,
        input: PathBuf,
        existing_id: String,
        candidate_id: String,
        review_id: String,
        old_tag: String,
        requested_tag: String,
        candidate_asset_path: PathBuf,
        candidate_thumbnail_path: PathBuf,
    }

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
        let fixture = library_with_hashes(&[
            ("later", 0b0001_u64, "2026-08-09T01:00:00Z"),
            ("earlier-b", 0b0010_u64, "2026-08-09T00:00:00Z"),
            ("earlier-a", 0b0100_u64, "2026-08-09T00:00:00Z"),
        ]);

        assert_eq!(
            fixture
                .library
                .find_similar_asset(0)
                .unwrap()
                .unwrap()
                .asset_id,
            "earlier-a"
        );
    }

    #[test]
    fn candidate_search_rejects_a_hash_blob_with_the_wrong_length() {
        let fixture = library_with_hashes(&[]);
        insert_asset(
            &fixture.library,
            "broken",
            "2026-08-09T00:00:00Z",
            Some(&[0; 7]),
        );

        let error = fixture.library.find_similar_asset(0).unwrap_err();

        assert!(matches!(error, LibraryError::InvalidPerceptualHash));
    }

    #[test]
    fn indexing_attempts_fifty_assets_and_records_media_failures_once() {
        let fixture = library_with_unindexed_assets(51);

        let first = fixture.library.index_missing_similarity_hashes().unwrap();
        let second = fixture.library.index_missing_similarity_hashes().unwrap();

        assert_eq!((first.remaining, first.failed), (1, 1));
        assert_eq!((second.remaining, second.failed), (0, 1));
        let error: String = fixture
            .library
            .connection()
            .unwrap()
            .query_row(
                "SELECT perceptual_hash_error FROM assets WHERE id = 'asset-000'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(error, "media_not_found");
    }

    #[test]
    fn indexing_an_empty_library_returns_zero_counts() {
        let fixture = library_with_hashes(&[]);

        let progress = fixture.library.index_missing_similarity_hashes().unwrap();

        assert_eq!((progress.remaining, progress.failed), (0, 0));
    }

    #[test]
    fn review_listing_returns_public_assets_and_stable_cursor_pages() {
        let fixture = review_fixture();
        fixture.add_horizontal_review();

        let first = fixture.library.list_similarity_reviews(None, 1).unwrap();
        let second = fixture
            .library
            .list_similarity_reviews(first.next_cursor.clone(), 1)
            .unwrap();

        assert_eq!(first.total_count, 2);
        assert_eq!(first.items.len(), 1);
        assert_eq!(second.items.len(), 1);
        assert_ne!(first.items[0].id, second.items[0].id);
        assert!(first.next_cursor.is_some());
        assert!(second.next_cursor.is_none());
        for review in first.items.iter().chain(&second.items) {
            assert!(!review.existing.format.is_empty());
            assert!(!review.candidate.format.is_empty());
            assert!(!review.existing.asset.original_name.is_empty());
            assert!(!review.candidate.asset.original_name.is_empty());
        }
        assert!(matches!(
            fixture.library.list_similarity_reviews(None, 0),
            Err(LibraryError::InvalidAssetPageLimit)
        ));
        assert!(matches!(
            fixture.library.list_similarity_reviews(
                Some(AssetCursor {
                    token: "not-a-review-cursor".into()
                }),
                20
            ),
            Err(LibraryError::InvalidAssetCursor)
        ));
    }

    #[test]
    fn get_asset_returns_normal_assets_but_not_review_candidates() {
        let fixture = review_fixture();

        assert_eq!(
            fixture.library.get_asset(&fixture.existing_id).unwrap().id,
            fixture.existing_id
        );
        assert!(matches!(
            fixture.library.get_asset(&fixture.candidate_id),
            Err(LibraryError::AssetNotFound)
        ));
    }

    #[test]
    fn replace_moves_existing_to_trash_and_transfers_classifications_and_favorite() {
        let fixture = review_fixture();
        fixture
            .library
            .set_asset_favorite(&fixture.existing_id, true)
            .unwrap();

        fixture
            .library
            .decide_similarity_review(SimilarityDecisionRequest {
                review_id: fixture.review_id.clone(),
                decision: SimilarityDecision::ReplaceExisting,
            })
            .unwrap();

        assert_eq!(fixture.status(&fixture.existing_id), "trash");
        assert_eq!(fixture.status(&fixture.candidate_id), "normal");
        assert!(fixture.favorite(&fixture.candidate_id));
        let mut actual = fixture.classification_ids(&fixture.candidate_id);
        actual.sort();
        let mut expected = vec![fixture.old_tag.clone(), fixture.requested_tag.clone()];
        expected.sort();
        assert_eq!(actual, expected);
        assert_eq!(
            fixture.source_url(&fixture.candidate_id),
            Some("https://example.com/new".into())
        );
    }

    #[test]
    fn keep_both_normalizes_only_the_candidate_and_is_idempotent() {
        let fixture = review_fixture();

        fixture
            .library
            .decide_similarity_review(SimilarityDecisionRequest {
                review_id: fixture.review_id.clone(),
                decision: SimilarityDecision::KeepBoth,
            })
            .unwrap();
        fixture
            .library
            .decide_similarity_review(SimilarityDecisionRequest {
                review_id: fixture.review_id.clone(),
                decision: SimilarityDecision::KeepBoth,
            })
            .unwrap();
        assert_eq!(fixture.status(&fixture.existing_id), "normal");
        assert_eq!(fixture.status(&fixture.candidate_id), "normal");
        assert_eq!(fixture.normal_ids().len(), 2);
        let conflict = fixture
            .library
            .decide_similarity_review(SimilarityDecisionRequest {
                review_id: fixture.review_id.clone(),
                decision: SimilarityDecision::ReplaceExisting,
            })
            .unwrap_err();
        assert!(matches!(conflict, LibraryError::SimilarityReviewConflict));
        assert!(matches!(
            fixture
                .library
                .decide_similarity_review(SimilarityDecisionRequest {
                    review_id: "missing-review".into(),
                    decision: SimilarityDecision::KeepBoth,
                }),
            Err(LibraryError::SimilarityReviewNotFound)
        ));
    }

    #[test]
    fn keep_existing_removes_only_the_managed_candidate() {
        let fixture = review_fixture();

        fixture
            .library
            .decide_similarity_review(SimilarityDecisionRequest {
                review_id: fixture.review_id.clone(),
                decision: SimilarityDecision::KeepExisting,
            })
            .unwrap();

        assert_eq!(fixture.status(&fixture.existing_id), "normal");
        assert!(!fixture.asset_exists(&fixture.candidate_id));
        assert!(!fixture.candidate_asset_path.exists());
        assert!(!fixture.candidate_thumbnail_path.exists());
        assert_eq!(
            fixture
                .library
                .list_similarity_reviews(None, 20)
                .unwrap()
                .total_count,
            0
        );
    }

    #[test]
    fn keep_existing_resumes_file_cleanup_after_reopen() {
        let fixture = review_fixture();
        set_after_review_resolving_hook(|| {
            Err(LibraryError::WriteAsset {
                path: PathBuf::from("simulated"),
                source: std::io::Error::other("simulated interruption"),
            })
        });
        let error = fixture
            .library
            .decide_similarity_review(SimilarityDecisionRequest {
                review_id: fixture.review_id.clone(),
                decision: SimilarityDecision::KeepExisting,
            })
            .unwrap_err();
        assert!(matches!(error, LibraryError::WriteAsset { .. }));

        let root = fixture.library.root().to_path_buf();
        drop(fixture.library);
        let reopened = Library::open(&root).unwrap();

        assert!(!fixture.candidate_asset_path.exists());
        assert!(!fixture.candidate_thumbnail_path.exists());
        assert_eq!(
            reopened
                .list_similarity_reviews(None, 20)
                .unwrap()
                .total_count,
            0
        );
    }

    #[test]
    #[ignore]
    fn candidate_search_scans_fifty_thousand_hashes() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        {
            let mut connection = library.connection().unwrap();
            let transaction = connection.transaction().unwrap();
            for index in 0..50_000_u64 {
                let id = format!("asset-{index:05}");
                let hash = index.rotate_left(17).to_be_bytes();
                transaction
                    .execute(
                        "INSERT INTO assets (
                            id, content_hash, media_kind, original_name, relative_path,
                            thumbnail_relative_path, byte_size, width, height, collected_at,
                            perceptual_hash
                         ) VALUES (?1, ?1, 'image', ?1, ?2, ?3, 1, 1, 1,
                            '2026-08-09T00:00:00Z', ?4)",
                        params![
                            id,
                            format!("assets/{id}.png"),
                            format!("thumbnails/{id}.webp"),
                            hash
                        ],
                    )
                    .unwrap();
            }
            transaction.commit().unwrap();
        }

        let started = Instant::now();
        let candidate = library.find_similar_asset(0).unwrap();
        let elapsed = started.elapsed();

        assert_eq!(candidate.unwrap().asset_id, "asset-00000");
        eprintln!("50k similarity scan: {elapsed:?}");
        assert!(elapsed.as_secs_f64() < 1.0);
    }

    fn striped_fixture(width: u32, height: u32, direction: StripeDirection) -> DynamicImage {
        DynamicImage::ImageRgb8(ImageBuffer::from_fn(width, height, |x, y| {
            let offset = match direction {
                StripeDirection::Vertical => x,
                StripeDirection::Horizontal => y,
            };
            let light = (offset / 32) % 2 == 0;
            Rgb(if light { [240, 180, 30] } else { [20, 60, 180] })
        }))
    }

    fn jpeg_variant(source: &DynamicImage, width: u32, height: u32, quality: u8) -> DynamicImage {
        let resized = source.resize_exact(width, height, FilterType::Triangle);
        let mut bytes = Vec::new();
        JpegEncoder::new_with_quality(&mut bytes, quality)
            .encode_image(&resized)
            .unwrap();
        image::load_from_memory(&bytes).unwrap()
    }

    impl ReviewFixture {
        fn add_horizontal_review(&self) {
            let base = striped_fixture(900, 600, StripeDirection::Horizontal);
            let existing_path = self.input.join("horizontal-existing.png");
            base.save(&existing_path).unwrap();
            assert!(matches!(
                self.library
                    .ingest_media(IngestMediaRequest {
                        source_path: existing_path,
                        classification_id: None,
                        source_url: None,
                        collected_at: None,
                        replace_duplicate_metadata: false,
                        source_published_at: None,
                        creator_name: None,
                        creator_handle: None,
                        creator_url: None,
                        import_source: ImportSource::Direct,
                        import_batch_id: "00000000-0000-4000-8000-000000000002".into(),
                    })
                    .unwrap(),
                IngestOutcome::Added { .. }
            ));
            let variant_path = self.input.join("horizontal-variant.jpg");
            jpeg_variant(&base, 450, 300, 70)
                .save(&variant_path)
                .unwrap();
            assert!(matches!(
                self.library
                    .ingest_media(IngestMediaRequest {
                        source_path: variant_path,
                        classification_id: None,
                        source_url: None,
                        collected_at: None,
                        replace_duplicate_metadata: false,
                        source_published_at: None,
                        creator_name: None,
                        creator_handle: None,
                        creator_url: None,
                        import_source: ImportSource::Direct,
                        import_batch_id: "00000000-0000-4000-8000-000000000002".into(),
                    })
                    .unwrap(),
                IngestOutcome::ReviewPending { .. }
            ));
        }

        fn status(&self, asset_id: &str) -> String {
            self.library
                .connection()
                .unwrap()
                .query_row(
                    "SELECT status FROM assets WHERE id = ?1",
                    [asset_id],
                    |row| row.get(0),
                )
                .unwrap()
        }

        fn favorite(&self, asset_id: &str) -> bool {
            self.library
                .connection()
                .unwrap()
                .query_row(
                    "SELECT favorite FROM assets WHERE id = ?1",
                    [asset_id],
                    |row| row.get(0),
                )
                .unwrap()
        }

        fn classification_ids(&self, asset_id: &str) -> Vec<String> {
            self.library
                .get_asset_classifications(asset_id)
                .unwrap()
                .into_iter()
                .map(|entry| entry.id)
                .collect()
        }

        fn source_url(&self, asset_id: &str) -> Option<String> {
            self.library
                .connection()
                .unwrap()
                .query_row(
                    "SELECT source_url FROM assets WHERE id = ?1",
                    [asset_id],
                    |row| row.get(0),
                )
                .unwrap()
        }

        fn normal_ids(&self) -> Vec<String> {
            let connection = self.library.connection().unwrap();
            let mut statement = connection
                .prepare("SELECT id FROM assets WHERE status = 'normal' ORDER BY id")
                .unwrap();
            statement
                .query_map([], |row| row.get(0))
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap()
        }

        fn asset_exists(&self, asset_id: &str) -> bool {
            self.library
                .connection()
                .unwrap()
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM assets WHERE id = ?1)",
                    [asset_id],
                    |row| row.get(0),
                )
                .unwrap()
        }
    }

    fn review_fixture() -> ReviewFixture {
        let temp = tempfile::tempdir().unwrap();
        let input = temp.path().join("input");
        fs::create_dir(&input).unwrap();
        let library = Library::open(temp.path().join("library")).unwrap();
        let old_tag = library
            .create_classification(CreateClassification {
                kind: ClassificationKind::Root,
                name: "기존 분류".into(),
                parent_id: None,
            })
            .unwrap()
            .id;
        let requested_tag = library
            .create_classification(CreateClassification {
                kind: ClassificationKind::Root,
                name: "새 분류".into(),
                parent_id: None,
            })
            .unwrap()
            .id;
        let base = striped_fixture(900, 600, StripeDirection::Vertical);
        let existing_source = input.join("existing.png");
        base.save(&existing_source).unwrap();
        let existing_id = match library
            .ingest_media(IngestMediaRequest {
                source_path: existing_source,
                classification_id: Some(old_tag.clone()),
                source_url: Some("https://example.com/old".into()),
                collected_at: None,
                replace_duplicate_metadata: false,
                source_published_at: None,
                creator_name: None,
                creator_handle: None,
                creator_url: None,
                import_source: ImportSource::Direct,
                import_batch_id: "00000000-0000-4000-8000-000000000002".into(),
            })
            .unwrap()
        {
            IngestOutcome::Added { asset } => asset.id,
            other => panic!("expected normal existing asset, got {other:?}"),
        };
        let candidate_source = input.join("candidate.jpg");
        jpeg_variant(&base, 450, 300, 70)
            .save(&candidate_source)
            .unwrap();
        let review_id = match library
            .ingest_media(IngestMediaRequest {
                source_path: candidate_source,
                classification_id: Some(requested_tag.clone()),
                source_url: Some("https://example.com/new".into()),
                collected_at: None,
                replace_duplicate_metadata: false,
                source_published_at: None,
                creator_name: None,
                creator_handle: None,
                creator_url: None,
                import_source: ImportSource::Direct,
                import_batch_id: "00000000-0000-4000-8000-000000000002".into(),
            })
            .unwrap()
        {
            IngestOutcome::ReviewPending { review_id } => review_id,
            other => panic!("expected review candidate, got {other:?}"),
        };
        let (candidate_id, relative_path, thumbnail_relative_path): (String, String, String) =
            library
                .connection()
                .unwrap()
                .query_row(
                    "SELECT assets.id, assets.relative_path, assets.thumbnail_relative_path
                     FROM similarity_reviews
                     JOIN assets ON assets.id = similarity_reviews.candidate_asset_id
                     WHERE similarity_reviews.id = ?1",
                    [&review_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .unwrap();
        let candidate_asset_path = library.root().join(relative_path);
        let candidate_thumbnail_path = library.root().join(thumbnail_relative_path);
        ReviewFixture {
            _temp: temp,
            library,
            input,
            existing_id,
            candidate_id,
            review_id,
            old_tag,
            requested_tag,
            candidate_asset_path,
            candidate_thumbnail_path,
        }
    }

    fn library_with_hashes(rows: &[(&str, u64, &str)]) -> TestLibrary {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        for (id, hash, collected_at) in rows {
            insert_asset(&library, id, collected_at, Some(&hash.to_be_bytes()));
        }
        TestLibrary {
            _temp: temp,
            library,
        }
    }

    fn library_with_unindexed_assets(count: usize) -> TestLibrary {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        for index in 0..count {
            let id = format!("asset-{index:03}");
            insert_asset(&library, &id, "2026-08-09T00:00:00Z", None);
            if index != 0 {
                let path = library.root().join(format!("assets/{id}.png"));
                fs::create_dir_all(path.parent().unwrap()).unwrap();
                RgbImage::from_pixel(12, 8, Rgb([index as u8, 80, 120]))
                    .save(&path)
                    .unwrap();
            }
        }
        TestLibrary {
            _temp: temp,
            library,
        }
    }

    fn insert_asset(library: &Library, id: &str, collected_at: &str, hash: Option<&[u8]>) {
        library
            .connection()
            .unwrap()
            .execute(
                "INSERT INTO assets (
                    id, content_hash, media_kind, original_name, relative_path,
                    thumbnail_relative_path, byte_size, width, height, collected_at,
                    perceptual_hash
                 ) VALUES (?1, ?1, 'image', ?1, ?2, ?3, 1, 1, 1, ?4, ?5)",
                params![
                    id,
                    format!("assets/{id}.png"),
                    format!("thumbnails/{id}.webp"),
                    collected_at,
                    hash,
                ],
            )
            .unwrap();
    }
}
