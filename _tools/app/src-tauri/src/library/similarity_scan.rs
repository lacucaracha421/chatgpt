use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};

use super::{
    error::LibraryError,
    image_fingerprint::{dimensions_are_compatible, minimum_distance, ImageFingerprint},
    models::ImageSimilarityScan,
    similarity::{PDQ_DISTANCE_MAX, PDQ_QUALITY_MIN},
    Library,
};

#[cfg(not(test))]
const PAIRS_PER_BATCH: usize = 100_000;
#[cfg(test)]
const PAIRS_PER_BATCH: usize = 2;
const MATCHES_PER_BATCH: usize = 128;
/// Queued Assets one automatic comparison pass handles.
const AUTO_ASSETS_PER_BATCH: usize = 16;
/// Review pairs one newly materialized Asset may open, closest first.
const AUTO_MATCHES_PER_ASSET: usize = 16;
static SCAN_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

struct ScanAsset {
    id: String,
    content_hash: String,
    fingerprint: ImageFingerprint,
    dimensions: (u32, u32),
}

impl Library {
    pub fn get_image_similarity_scan(&self) -> Result<Option<ImageSimilarityScan>, LibraryError> {
        let connection = self.connection()?;
        scan_progress(&connection)
    }

    pub fn start_image_similarity_scan(&self) -> Result<ImageSimilarityScan, LibraryError> {
        let _guard = SCAN_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some(scan) = scan_progress(&transaction)? {
            if !scan.completed {
                return Ok(scan);
            }
        }
        transaction.execute("DELETE FROM image_similarity_scan_assets", [])?;
        // Freeze eligible fingerprints, not original media. New arrivals/prepared hashes
        // belong to the next explicit scan; restarting never changes this scan's input.
        transaction.execute(
            "INSERT INTO image_similarity_scan_assets
             (position, asset_id, content_hash, fingerprint, quality, width, height)
             SELECT row_number() OVER (ORDER BY collected_at, id) - 1,
                    id, content_hash, perceptual_hash, perceptual_hash_quality, width, height
             FROM assets WHERE status = 'normal' AND media_kind IN ('image', 'gif')
               AND length(perceptual_hash) = 64 AND perceptual_hash_quality >= ?1
               AND width > 0 AND height > 0",
            [PDQ_QUALITY_MIN],
        )?;
        transaction.execute(
            "INSERT OR REPLACE INTO image_similarity_scan
             (singleton, id, total_assets, skipped_assets, completed)
             SELECT 1, ?1, count(*),
                    (SELECT count(*) FROM assets WHERE status = 'normal' AND media_kind IN ('image', 'gif')) - count(*),
                    count(*) < 2
             FROM image_similarity_scan_assets",
            [uuid::Uuid::new_v4().to_string()],
        )?;
        let scan = scan_progress(&transaction)?.ok_or(LibraryError::SimilarityReviewConflict)?;
        transaction.commit()?;
        Ok(scan)
    }

    pub fn run_image_similarity_scan_batch(
        &self,
        scan_id: &str,
    ) -> Result<ImageSimilarityScan, LibraryError> {
        let _guard = SCAN_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let (left, right, assets) = {
            let connection = self.connection()?;
            let scan = scan_progress(&connection)?.ok_or(LibraryError::SimilarityReviewConflict)?;
            if scan.id != scan_id {
                return Err(LibraryError::SimilarityReviewConflict);
            }
            if scan.completed {
                return Ok(scan);
            }
            let (left, right): (i64, i64) = connection.query_row(
                "SELECT left_position, right_position FROM image_similarity_scan WHERE singleton = 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            (left, right, load_snapshot(&connection)?)
        };
        let mut left = usize::try_from(left).map_err(|_| LibraryError::SimilarityReviewConflict)?;
        let mut right =
            usize::try_from(right).map_err(|_| LibraryError::SimilarityReviewConflict)?;
        let mut compared = 0;
        let mut matches = Vec::new();
        // Release the library database lock during CPU work so normal browsing and
        // ingestion can continue, then revalidate each matched input before publication.
        while left + 1 < assets.len()
            && compared < PAIRS_PER_BATCH
            && matches.len() < MATCHES_PER_BATCH
        {
            let a = &assets[left];
            let b = &assets[right];
            if dimensions_are_compatible(a.dimensions, b.dimensions) {
                let distance = minimum_distance(&a.fingerprint, &b.fingerprint);
                if distance <= PDQ_DISTANCE_MAX {
                    matches.push((left, right, distance));
                }
            }
            compared += 1;
            right += 1;
            if right == assets.len() {
                left += 1;
                right = left + 1;
            }
        }
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut created = 0;
        let now = chrono::Utc::now().to_rfc3339();
        for (a, b, distance) in matches {
            if insert_historical_review(&transaction, &assets[a], &assets[b], distance, &now)? {
                created += 1;
            }
        }
        transaction.execute(
            "UPDATE image_similarity_scan SET left_position = ?1, right_position = ?2,
             compared_pairs = compared_pairs + ?3, reviews_created = reviews_created + ?4,
             completed = ?5 WHERE singleton = 1 AND id = ?6",
            params![
                i64::try_from(left).map_err(|_| LibraryError::SimilarityReviewConflict)?,
                i64::try_from(right).map_err(|_| LibraryError::SimilarityReviewConflict)?,
                i64::try_from(compared).map_err(|_| LibraryError::SimilarityReviewConflict)?,
                created,
                left + 1 >= assets.len(),
                scan_id
            ],
        )?;
        let progress =
            scan_progress(&transaction)?.ok_or(LibraryError::SimilarityReviewConflict)?;
        transaction.commit()?;
        Ok(progress)
    }
}

impl Library {
    /// Automatic comparison of newly materialized Assets (user decision 2).
    ///
    /// Server-created Assets (mobile saves, cloud captures, another PC's uploads) skip the
    /// similarity check at ingestion. Migration 0094 queues each one when its original bytes
    /// land here (`asset_authority_state.materialization` turns `complete`). This pass is run
    /// by the background `similarity` publication lane on every tick (at most every ten
    /// seconds, never on the UI thread) and handles up to [`AUTO_ASSETS_PER_BATCH`] queued
    /// Assets:
    ///
    /// * a missing PDQ hash is computed through the lazy indexing path (one decode each);
    /// * each Asset is compared with every hashed library image using the explicit scan's
    ///   gates (quality, aspect, distance), with the CPU work outside the database lock;
    /// * matches become `historical` review pairs (the library image as `existing`, the new
    ///   one as `candidate`) under the same dedupe rule as the scan, closest first and at most
    ///   [`AUTO_MATCHES_PER_ASSET`] per Asset. Inputs are revalidated before insertion.
    ///
    /// Processed Assets leave the queue, including ones that cannot be compared (video, trash,
    /// low-quality or undecodable images). Returns the number of pairs created.
    pub(crate) fn run_similarity_auto_compare_batch(&self) -> Result<u64, LibraryError> {
        let queued: Vec<String> = {
            let connection = self.connection()?;
            let mut statement = connection.prepare(
                "SELECT asset_id FROM similarity_auto_compare_queue
                 ORDER BY queued_at, asset_id LIMIT ?1",
            )?;
            let ids = statement
                .query_map([AUTO_ASSETS_PER_BATCH as i64], |row| row.get(0))?
                .collect::<Result<Vec<_>, _>>()?;
            ids
        };
        if queued.is_empty() {
            return Ok(0);
        }
        for asset_id in &queued {
            self.ensure_similarity_hash(asset_id)?;
        }
        let _guard = SCAN_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let library = {
            let connection = self.connection()?;
            load_comparable(&connection)?
        };
        let mut matches = Vec::new();
        for target in library.iter().filter(|asset| queued.contains(&asset.id)) {
            let mut found: Vec<(u32, &ScanAsset)> = library
                .iter()
                .filter(|other| other.id != target.id)
                .filter(|other| dimensions_are_compatible(target.dimensions, other.dimensions))
                .filter_map(|other| {
                    let distance = minimum_distance(&target.fingerprint, &other.fingerprint);
                    (distance <= PDQ_DISTANCE_MAX).then_some((distance, other))
                })
                .collect();
            found.sort_by(|left, right| left.0.cmp(&right.0).then(left.1.id.cmp(&right.1.id)));
            found.truncate(AUTO_MATCHES_PER_ASSET);
            matches.extend(
                found
                    .into_iter()
                    .map(|(distance, other)| (other, target, distance)),
            );
        }
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let now = chrono::Utc::now().to_rfc3339();
        let mut created = 0;
        for (existing, candidate, distance) in matches {
            if insert_historical_review(&transaction, existing, candidate, distance, &now)? {
                created += 1;
            }
        }
        for asset_id in &queued {
            transaction.execute(
                "DELETE FROM similarity_auto_compare_queue WHERE asset_id = ?1",
                [asset_id],
            )?;
        }
        transaction.commit()?;
        Ok(created)
    }
}

/// Every image the explicit scan would compare, read now rather than from a frozen snapshot.
fn load_comparable(connection: &Connection) -> Result<Vec<ScanAsset>, LibraryError> {
    let mut statement = connection.prepare(
        "SELECT id, content_hash, perceptual_hash, perceptual_hash_quality, width, height
         FROM assets WHERE status = 'normal' AND media_kind IN ('image', 'gif')
           AND length(perceptual_hash) = 64 AND perceptual_hash_quality >= ?1
           AND width > 0 AND height > 0
         ORDER BY collected_at, id",
    )?;
    let rows = statement.query_map([PDQ_QUALITY_MIN], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, Vec<u8>>(2)?,
            row.get::<_, u8>(3)?,
            row.get::<_, u32>(4)?,
            row.get::<_, u32>(5)?,
        ))
    })?;
    rows.map(|row| {
        let (id, content_hash, bytes, quality, width, height) = row?;
        Ok(ScanAsset {
            id,
            content_hash,
            fingerprint: ImageFingerprint::from_stored_bytes(&bytes, quality)?,
            dimensions: (width, height),
        })
    })
    .collect()
}

/// Record one historical pair unless an input changed or the pair is already known (either
/// orientation, incoming reviews and decided pairs included). Returns whether it was created.
fn insert_historical_review(
    connection: &Connection,
    existing: &ScanAsset,
    candidate: &ScanAsset,
    distance: u32,
    now: &str,
) -> Result<bool, LibraryError> {
    if !input_is_current(connection, existing)? || !input_is_current(connection, candidate)? {
        return Ok(false);
    }
    let known: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM similarity_reviews
         WHERE min(existing_asset_id, candidate_asset_id) = min(?1, ?2)
           AND max(existing_asset_id, candidate_asset_id) = max(?1, ?2)
           AND status != 'stale')",
        params![existing.id, candidate.id],
        |row| row.get(0),
    )?;
    if known {
        return Ok(false);
    }
    connection.execute(
        "INSERT INTO similarity_reviews
         (id, existing_asset_id, candidate_asset_id, distance, fingerprint_kind, review_kind, status, created_at)
         VALUES (?1, ?2, ?3, ?4, 'pdq-v1', 'historical', 'open', ?5)",
        params![
            uuid::Uuid::new_v4().to_string(),
            existing.id,
            candidate.id,
            distance,
            now
        ],
    )?;
    Ok(true)
}

fn scan_progress(connection: &Connection) -> Result<Option<ImageSimilarityScan>, LibraryError> {
    Ok(connection
        .query_row(
            "SELECT id, total_assets, skipped_assets, compared_pairs, reviews_created, completed
         FROM image_similarity_scan WHERE singleton = 1",
            [],
            |row| {
                let total = u64::try_from(row.get::<_, i64>(1)?).unwrap_or(0);
                Ok(ImageSimilarityScan {
                    id: row.get(0)?,
                    total_assets: total,
                    skipped_assets: u64::try_from(row.get::<_, i64>(2)?).unwrap_or(0),
                    compared_pairs: u64::try_from(row.get::<_, i64>(3)?).unwrap_or(0),
                    total_pairs: total * total.saturating_sub(1) / 2,
                    reviews_created: u64::try_from(row.get::<_, i64>(4)?).unwrap_or(0),
                    completed: row.get(5)?,
                })
            },
        )
        .optional()?)
}

fn load_snapshot(connection: &Connection) -> Result<Vec<ScanAsset>, LibraryError> {
    let mut statement = connection.prepare(
        "SELECT asset_id, content_hash, fingerprint, quality, width, height
         FROM image_similarity_scan_assets ORDER BY position",
    )?;
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, Vec<u8>>(2)?,
            row.get::<_, u8>(3)?,
            row.get::<_, u32>(4)?,
            row.get::<_, u32>(5)?,
        ))
    })?;
    rows.map(|row| {
        let (id, content_hash, bytes, quality, width, height) = row?;
        Ok(ScanAsset {
            id,
            content_hash,
            fingerprint: ImageFingerprint::from_stored_bytes(&bytes, quality)?,
            dimensions: (width, height),
        })
    })
    .collect()
}

fn input_is_current(connection: &Connection, asset: &ScanAsset) -> Result<bool, LibraryError> {
    Ok(connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM assets WHERE id = ?1 AND status = 'normal'
         AND media_kind IN ('image', 'gif') AND content_hash = ?2 AND perceptual_hash = ?3
         AND perceptual_hash_quality = ?4 AND width = ?5 AND height = ?6)",
        params![
            asset.id,
            asset.content_hash,
            asset.fingerprint.to_stored_bytes(),
            asset.fingerprint.quality,
            asset.dimensions.0,
            asset.dimensions.1
        ],
        |row| row.get(0),
    )?)
}

#[cfg(test)]
mod tests {
    use tempfile::TempDir;

    use super::super::{
        image_fingerprint::ImageFingerprint,
        models::{SimilarityDecision, SimilarityDecisionRequest},
        Library,
    };

    #[test]
    fn historical_scan_resumes_after_reopen_and_does_not_duplicate_reviews() {
        let temp = TempDir::new().unwrap();
        let scan_id = {
            let library = Library::open(temp.path()).unwrap();
            insert_asset(&library, "a", [0; 32], [0; 32]);
            let mut near = [0; 32];
            near[0] = 1;
            insert_asset(&library, "b", near, near);
            insert_asset(&library, "c", [u8::MAX; 32], [u8::MAX; 32]);

            let scan = library.start_image_similarity_scan().unwrap();
            assert_eq!((scan.total_assets, scan.total_pairs), (3, 3));
            let paused = library.run_image_similarity_scan_batch(&scan.id).unwrap();
            assert_eq!(paused.compared_pairs, 2);
            assert!(!paused.completed);
            scan.id
        };

        let library = Library::open(temp.path()).unwrap();
        let completed = library.run_image_similarity_scan_batch(&scan_id).unwrap();
        assert!(completed.completed);
        assert_eq!(
            (completed.compared_pairs, completed.reviews_created),
            (3, 1)
        );
        let reviews = library.list_similarity_reviews(None, 20).unwrap();
        assert_eq!(reviews.total_count, 1);
        assert!(reviews.items[0].historical);

        let rerun = library.start_image_similarity_scan().unwrap();
        let rerun = run_to_completion(&library, rerun);
        assert_eq!(rerun.reviews_created, 0);
        assert_eq!(
            library
                .list_similarity_reviews(None, 20)
                .unwrap()
                .total_count,
            1
        );
    }

    #[test]
    fn historical_decision_moves_only_the_rejected_asset_to_trash() {
        let temp = TempDir::new().unwrap();
        let library = Library::open(temp.path()).unwrap();
        insert_asset(&library, "a", [0; 32], [0; 32]);
        insert_asset(&library, "b", [0; 32], [0; 32]);
        let completed = run_to_completion(&library, library.start_image_similarity_scan().unwrap());
        assert_eq!(completed.reviews_created, 1);
        let review = library
            .list_similarity_reviews(None, 1)
            .unwrap()
            .items
            .remove(0);

        library
            .decide_similarity_review(SimilarityDecisionRequest {
                review_id: review.id,
                decision: SimilarityDecision::KeepExisting,
            })
            .unwrap();

        let connection = library.connection().unwrap();
        let statuses = ["a", "b"].map(|id| {
            connection
                .query_row("SELECT status FROM assets WHERE id=?1", [id], |row| {
                    row.get::<_, String>(0)
                })
                .unwrap()
        });
        assert_eq!(statuses, ["normal", "trash"]);
        drop(connection);
        assert_eq!(
            library
                .list_similarity_reviews(None, 20)
                .unwrap()
                .total_count,
            0
        );
    }

    fn run_to_completion(
        library: &Library,
        mut scan: super::super::models::ImageSimilarityScan,
    ) -> super::super::models::ImageSimilarityScan {
        while !scan.completed {
            scan = library.run_image_similarity_scan_batch(&scan.id).unwrap();
        }
        scan
    }

    fn insert_asset(library: &Library, id: &str, whole: [u8; 32], cropped: [u8; 32]) {
        let fingerprint = ImageFingerprint {
            bytes: whole,
            cropped_bytes: cropped,
            quality: 100,
        };
        library
            .connection()
            .unwrap()
            .execute(
                "INSERT INTO assets
             (id,content_hash,media_kind,original_name,relative_path,thumbnail_relative_path,
              byte_size,width,height,collected_at,status,perceptual_hash,perceptual_hash_quality)
             VALUES (?1,?2,'image',?3,?4,?5,1,100,100,?6,'normal',?7,100)",
                rusqlite::params![
                    id,
                    format!("hash-{id}"),
                    format!("{id}.png"),
                    format!("assets/{id}.png"),
                    format!("thumbnails/{id}.webp"),
                    format!(
                        "2026-09-22T00:00:0{}Z",
                        if id == "a" {
                            1
                        } else if id == "b" {
                            2
                        } else {
                            3
                        }
                    ),
                    fingerprint.to_stored_bytes(),
                ],
            )
            .unwrap();
    }
}
