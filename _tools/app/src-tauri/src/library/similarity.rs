use super::auto_tags::CONTENT_RATING_SQL;
use std::{
    collections::HashMap,
    fs::File,
    io::{BufReader, Seek, SeekFrom},
    path::Path,
};

use image::{ImageDecoder, ImageReader};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};

use super::{
    error::LibraryError,
    image_fingerprint::{
        dimensions_are_compatible, fingerprint, minimum_distance, ImageFingerprint,
    },
    models::{
        AccountRole, AssetCursor, AssetSummary, ClassificationEntry, ClassificationKind, ClueKey,
        ClueSide, SimilarityClues, SimilarityDecision, SimilarityDecisionRequest,
        SimilarityIndexProgress, SimilarityReviewAsset, SimilarityReviewPage,
        SimilarityReviewSummary,
    },
    query::asset_summary_from_row,
    Library, MediaVariant,
};

pub(super) const PDQ_QUALITY_MIN: u8 = 50;
pub(super) const PDQ_DISTANCE_MAX: u32 = 20;
pub(super) const AUTO_REPOST_DISTANCE_MAX: u32 = 8;
const INDEX_BATCH_SIZE: u32 = 50;
// Bound decoding across overlapping UI requests, including a reopened library.
static INDEX_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SimilarAssetCandidate {
    pub(crate) asset_id: String,
    pub(crate) distance: u32,
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct PerceptualHashResult {
    pub(crate) fingerprint: ImageFingerprint,
    pub(crate) width: u32,
    pub(crate) height: u32,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ReviewCursor {
    created_at: String,
    id: String,
}

struct OpenReviewRow {
    historical: bool,
    id: String,
    existing_asset_id: String,
    candidate_asset_id: String,
    distance: u32,
    created_at: String,
}

/// What recording a server-applied mobile decision found on this PC.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ServerAppliedRecord {
    Recorded,
    /// The user already resolved this review the other way here.
    Conflict,
}

struct StoredReview {
    historical: bool,
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
        // A review whose existing Asset left `normal` through any path (grid trash, a sibling
        // review's "replace existing", cloud trash) can no longer be decided; release it
        // before counting so it neither breaks nor pads the page.
        release_incoming_reviews_without_existing(&transaction, None)?;
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
            "SELECT id, existing_asset_id, candidate_asset_id, distance, created_at, review_kind = 'historical'
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
                    historical: row.get(5)?,
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
        // 리뷰당 4회 쿼리(N+1) 대신 자산 요약·분류를 배치로 로드한다.
        // 상태 보장(normal/review)은 배치 로딩으로 모아 온 뒤 클로저에서 검증한다.
        let asset_ids: Vec<String> = rows
            .iter()
            .flat_map(|row| {
                [
                    row.existing_asset_id.clone(),
                    row.candidate_asset_id.clone(),
                ]
            })
            .collect();
        let summaries = load_asset_summaries(&transaction, &asset_ids)?;
        // 상태는 AssetSummary에 없으므로 id별 상태를 별도 맵으로 모은다.
        let statuses = load_asset_statuses(&transaction, &asset_ids)?;
        let roles = load_account_roles(&transaction, &asset_ids)?;
        let classifications = classifications_for_assets(&transaction, &asset_ids)?;
        let review_asset = |asset_id: &str,
                            expected_status: &str|
         -> Result<SimilarityReviewAsset, LibraryError> {
            let asset = summaries
                .get(asset_id)
                .cloned()
                .ok_or(LibraryError::AssetNotFound)?;
            let actual_status = statuses
                .get(asset_id)
                .map(String::as_str)
                .ok_or(LibraryError::AssetNotFound)?;
            if actual_status != expected_status {
                return Err(LibraryError::AssetNotFound);
            }
            let format = review_format(&asset.relative_path);
            Ok(SimilarityReviewAsset {
                account_role: if posting_handle(&asset).is_some() {
                    roles.get(asset_id).copied().unwrap_or_default()
                } else {
                    AccountRole::Unknown
                },
                asset,
                format,
                classifications: classifications.get(asset_id).cloned().unwrap_or_default(),
            })
        };
        // One row whose Assets are not in the expected state (a state no release above
        // explains) is left out rather than failing the whole page.
        let items = rows
            .into_iter()
            .filter_map(|row| {
                let existing = review_asset(&row.existing_asset_id, "normal").ok()?;
                let candidate = review_asset(
                    &row.candidate_asset_id,
                    if row.historical { "normal" } else { "review" },
                )
                .ok()?;
                let (clues, reason, favoured) = comparison_clues(
                    &existing.asset,
                    existing.account_role,
                    &candidate.asset,
                    candidate.account_role,
                );
                let recommended_asset_id = favoured.map(|side| match side {
                    ClueSide::A => existing.asset.id.clone(),
                    ClueSide::B => candidate.asset.id.clone(),
                });
                Some(SimilarityReviewSummary {
                    id: row.id,
                    distance: row.distance,
                    historical: row.historical,
                    recommended_asset_id,
                    clues,
                    reason,
                    existing,
                    candidate,
                })
            })
            .collect::<Vec<_>>();
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
        if review.historical {
            return self.resolve_historical_review(&request, &review);
        }
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

    /// Record a mobile decision the server already carried out (it moved the discarded image
    /// to Library Trash itself, and the PC learns that through its Asset sync). The historical
    /// review of exactly this pair is marked resolved, so the PC stops offering it - an open
    /// one, and a stale one too (the server's trash can reach this PC first and mark the pair
    /// stale; left stale, a restore and a rescan would offer the same pair again) unless another
    /// non-stale row already holds the pair. Nothing is trashed, merged or queued here, so a
    /// later restore from Library Trash is never undone. A review the user already resolved
    /// differently is a [`ServerAppliedRecord::Conflict`]; a changed, missing or incoming
    /// review is left as it is.
    pub(crate) fn record_server_applied_similarity_review(
        &self,
        review_id: &str,
        existing_id: &str,
        candidate_id: &str,
        decision: SimilarityDecision,
    ) -> Result<ServerAppliedRecord, LibraryError> {
        let _trash_guard = self
            .trash_lock
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let review = match self.load_stored_review(review_id) {
            Ok(review) => review,
            Err(LibraryError::SimilarityReviewNotFound) => {
                return Ok(ServerAppliedRecord::Recorded)
            }
            Err(error) => return Err(error),
        };
        let requested = decision_name(decision);
        if !review.historical
            || review.existing_asset_id.as_deref() != Some(existing_id)
            || review.candidate_asset_id.as_deref() != Some(candidate_id)
        {
            return Ok(ServerAppliedRecord::Recorded);
        }
        let mut connection = self.connection()?;
        match review.status.as_str() {
            "resolved" if review.decision.as_deref() == Some(requested) => {}
            "resolved" => return Ok(ServerAppliedRecord::Conflict),
            "open" => {
                let transaction = connection
                    .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
                match resolve_review(&transaction, review_id, requested) {
                    Ok(()) => {}
                    Err(LibraryError::SimilarityReviewConflict) => {
                        return Ok(ServerAppliedRecord::Recorded)
                    }
                    Err(error) => return Err(error),
                }
                transaction.commit()?;
            }
            "stale" => {
                let transaction = connection
                    .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
                let held_elsewhere: bool = transaction.query_row(
                    "SELECT EXISTS(SELECT 1 FROM similarity_reviews
                     WHERE id != ?1 AND status != 'stale'
                       AND min(existing_asset_id, candidate_asset_id) = min(?2, ?3)
                       AND max(existing_asset_id, candidate_asset_id) = max(?2, ?3))",
                    params![review_id, existing_id, candidate_id],
                    |row| row.get(0),
                )?;
                if !held_elsewhere {
                    transaction.execute(
                        "UPDATE similarity_reviews
                         SET status = 'resolved', decision = ?2, resolved_at = ?3
                         WHERE id = ?1 AND status = 'stale'",
                        params![review_id, requested, chrono::Utc::now().to_rfc3339()],
                    )?;
                }
                transaction.commit()?;
            }
            _ => {}
        }
        Ok(ServerAppliedRecord::Recorded)
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
                "SELECT existing_asset_id, candidate_asset_id, status, decision, review_kind = 'historical'
                 FROM similarity_reviews WHERE id = ?1",
                [review_id],
                |row| {
                    Ok(StoredReview {
                        existing_asset_id: row.get(0)?,
                        candidate_asset_id: row.get(1)?,
                        status: row.get(2)?,
                        decision: row.get(3)?,
                        historical: row.get(4)?,
                    })
                },
            )
            .optional()?
            .ok_or(LibraryError::SimilarityReviewNotFound)
    }

    fn resolve_historical_review(
        &self,
        request: &SimilarityDecisionRequest,
        review: &StoredReview,
    ) -> Result<(), LibraryError> {
        let decision = decision_name(request.decision);
        if review.status == "resolved" && review.decision.as_deref() == Some(decision) {
            return Ok(());
        }
        if review.status != "open" {
            return Err(LibraryError::SimilarityReviewConflict);
        }
        let (existing_id, candidate_id) = open_review_asset_ids(review)?;
        let mut connection = self.connection()?;
        let transaction =
            connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        verify_asset_status(&transaction, existing_id, "normal")?;
        verify_asset_status(&transaction, candidate_id, "normal")?;
        // Resolve first so the lifecycle trigger only invalidates OTHER overlapping pairs.
        resolve_review(&transaction, &request.review_id, decision)?;
        let discarded = match request.decision {
            SimilarityDecision::KeepExisting => Some(candidate_id),
            SimilarityDecision::ReplaceExisting => Some(existing_id),
            SimilarityDecision::KeepBoth => None,
        };
        if let Some(asset_id) = discarded {
            let kept = if asset_id == existing_id {
                candidate_id
            } else {
                existing_id
            };
            merge_review_metadata(&transaction, asset_id, kept)?;
            super::trash::update_trash_status_in_transaction(
                &transaction,
                &[asset_id.to_owned()],
                "normal",
                "trash",
                Some(&chrono::Utc::now().to_rfc3339()),
            )?;
        }
        transaction.commit()?;
        Ok(())
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
        merge_review_metadata(&transaction, existing_id, candidate_id)?;
        transaction.execute(
            "UPDATE assets SET status = 'trash', trashed_at = ?2 WHERE id = ?1 AND status = 'normal'",
            params![existing_id, chrono::Utc::now().to_rfc3339()],
        )?;
        super::asset_authority::enqueue(&transaction, &[existing_id.to_string()], "trash")?;
        transaction.execute(
            "UPDATE assets SET status = 'normal', trashed_at = NULL WHERE id = ?1 AND status = 'review'",
            [candidate_id],
        )?;
        super::character_autotag::enqueue(
            &transaction,
            candidate_id,
            super::character_autotag::Cause::SimilarityResolution,
        )?;
        resolve_review(&transaction, review_id, "replace_existing")?;
        // Other incoming reviews against the Asset just trashed are released, not stranded.
        release_incoming_reviews_without_existing(&transaction, None)?;
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
        let final_classification = incoming_promotion_classification(&transaction, candidate_id)?;
        transaction.execute(
            "UPDATE assets SET status = 'normal', trashed_at = NULL WHERE id = ?1 AND status = 'review'",
            [candidate_id],
        )?;
        Library::enqueue_classification_assignment_intent(
            &transaction,
            candidate_id,
            final_classification.as_deref(),
        )?;
        super::character_autotag::enqueue(
            &transaction,
            candidate_id,
            super::character_autotag::Cause::SimilarityResolution,
        )?;
        crate::cloud::queue::enqueue_asset_upsert(
            &transaction,
            candidate_id,
            &chrono::Utc::now().to_rfc3339(),
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

    #[cfg(any(windows, target_os = "linux"))]
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

    #[cfg(not(any(windows, target_os = "linux")))]
    fn remove_review_candidate_files(
        &self,
        _relative_path: &str,
        _thumbnail_relative_path: &str,
    ) -> Result<(), LibraryError> {
        Err(LibraryError::UnsupportedManagedFileDeletion)
    }

    pub fn index_missing_similarity_hashes(&self) -> Result<SimilarityIndexProgress, LibraryError> {
        let before = crate::auto_jobs::similarity_counts(self);
        crate::auto_jobs::tracked(
            self,
            "similarity",
            || self.index_missing_similarity_hashes_inner(),
            |result| {
                let failed = before.map_or(0, |(_,failed)|result.failed.saturating_sub(failed));
                (failed==0, before.map(|(pending,_)|pending.saturating_sub(result.remaining).saturating_sub(failed)))
            },
        )
    }
    fn index_missing_similarity_hashes_inner(
        &self,
    ) -> Result<SimilarityIndexProgress, LibraryError> {
        let result =
            self.index_missing_similarity_hashes_with_budget(crate::performance::budgets());
        if let Err(error) = &result {
            crate::activities::finish("similarity-hashes", Some(error.to_string()));
        }
        result
    }

    fn index_missing_similarity_hashes_with_budget(
        &self,
        budget: crate::performance::Budgets,
    ) -> Result<SimilarityIndexProgress, LibraryError> {
        let _index = INDEX_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let asset_ids = {
            let connection = self.connection()?;
            let mut statement = connection.prepare(
                "SELECT id
                 FROM assets
                 WHERE status = 'normal'
                   AND media_kind IN ('image', 'gif')
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

        let workers = budget
            .indexing_workers(std::thread::available_parallelism().map_or(1, |count| count.get()));
        if !asset_ids.is_empty() {
            crate::activities::report(
                "similarity-hashes",
                "similarity",
                "유사 이미지 준비",
                "running",
                0,
                None,
                Some(format!("{}개 처리 중", asset_ids.len())),
                None,
                None,
                None,
            );
        }
        let manual = crate::auto_jobs::manual(self, "similarity");
        std::thread::scope(|scope| {
            let handles: Vec<_> = asset_ids
                .chunks(asset_ids.len().div_ceil(workers).max(1))
                .map(|chunk| {
                    scope.spawn(move || {
                        chunk.iter().try_for_each(|id| {
                            if crate::workload::is_restricted() && !manual {
                                Ok(())
                            } else {
                                self.index_similarity_asset(id)
                            }
                        })
                    })
                })
                .collect();
            // Each worker persists completed images immediately; no image buffers are queued.
            handles
                .into_iter()
                .map(|handle| {
                    handle
                        .join()
                        .unwrap_or_else(|panic| std::panic::resume_unwind(panic))
                })
                .collect::<Result<Vec<_>, LibraryError>>()
        })?;

        let connection = self.connection()?;
        let (remaining, failed): (i64, i64) = connection.query_row(
            "SELECT
                COALESCE(SUM(CASE WHEN perceptual_hash IS NULL AND perceptual_hash_error IS NULL THEN 1 ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN perceptual_hash_error IS NOT NULL THEN 1 ELSE 0 END), 0)
             FROM assets
             WHERE status = 'normal' AND media_kind IN ('image', 'gif')",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        if remaining > 0 {
            crate::activities::report("similarity-hashes", "similarity", "유사 이미지 준비", if crate::workload::is_restricted() { "queued" } else { "running" }, 0, None, Some(format!("{remaining}개 남음")), None,
                crate::workload::is_restricted().then(|| "절약 모드".into()), None);
        } else { crate::activities::finish("similarity-hashes", (failed > 0).then(|| format!("실패 {failed}개"))); }
        Ok(SimilarityIndexProgress {
            remaining: remaining as u64,
            failed: failed as u64,
        })
    }

    /// Compute one Asset's missing PDQ hash through the lazy indexing path (same decode
    /// bound, same failure codes). A hashed or failed Asset is left as it is.
    /// Returns false when workload policy defers the Asset, leaving it queued.
    pub(super) fn ensure_similarity_hash(
        &self,
        asset_id: &str,
        is_restricted: &impl Fn() -> bool,
    ) -> Result<bool, LibraryError> {
        let _index = INDEX_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if is_restricted() {
            return Ok(false);
        }
        let missing: bool = self.connection()?.query_row(
            "SELECT EXISTS(SELECT 1 FROM assets WHERE id = ?1 AND status = 'normal'
             AND media_kind IN ('image', 'gif')
             AND perceptual_hash IS NULL AND perceptual_hash_error IS NULL)",
            [asset_id],
            |row| row.get(0),
        )?;
        if missing {
            self.index_similarity_asset(asset_id)?;
        }
        Ok(true)
    }

    fn index_similarity_asset(&self, asset_id: &str) -> Result<(), LibraryError> {
        let result = self
            .resolve_media(asset_id, MediaVariant::Asset)
            .and_then(|media| perceptual_hash_from_file(media.file));
        let connection = self.connection()?;
        match result {
            Ok(result) => {
                connection.execute(
                    "UPDATE assets
                     SET perceptual_hash = ?2, perceptual_hash_quality = ?3, width = ?4, height = ?5
                     WHERE id = ?1 AND status = 'normal'
                       AND perceptual_hash IS NULL AND perceptual_hash_error IS NULL",
                    params![
                        asset_id,
                        result.fingerprint.to_stored_bytes(),
                        result.fingerprint.quality,
                        i64::from(result.width),
                        i64::from(result.height)
                    ],
                )?;
            }
            Err(error) => {
                let code = similarity_index_error_code(&error).ok_or(error)?;
                connection.execute(
                    "UPDATE assets
                     SET perceptual_hash_error = ?2
                     WHERE id = ?1 AND status = 'normal'
                       AND perceptual_hash IS NULL AND perceptual_hash_error IS NULL",
                    params![asset_id, code],
                )?;
            }
        }
        Ok(())
    }

    pub(crate) fn find_similar_asset(
        &self,
        target: &ImageFingerprint,
        target_dimensions: (u32, u32),
    ) -> Result<Option<SimilarAssetCandidate>, LibraryError> {
        if target.quality < PDQ_QUALITY_MIN {
            return Ok(None);
        }
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT id, perceptual_hash, perceptual_hash_quality, width, height
             FROM assets
             WHERE status = 'normal'
               AND media_kind IN ('image', 'gif')
               AND perceptual_hash IS NOT NULL
               AND perceptual_hash_quality >= ?1
             ORDER BY collected_at, id",
        )?;
        let rows = statement.query_map([PDQ_QUALITY_MIN], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Vec<u8>>(1)?,
                row.get::<_, u8>(2)?,
                row.get::<_, u32>(3)?,
                row.get::<_, u32>(4)?,
            ))
        })?;
        let mut best: Option<SimilarAssetCandidate> = None;
        for row in rows {
            let (asset_id, bytes, quality, width, height) = row?;
            let stored = ImageFingerprint::from_stored_bytes(&bytes, quality)?;
            if !dimensions_are_compatible(target_dimensions, (width, height)) {
                continue;
            }
            let distance = minimum_distance(target, &stored);
            if distance <= PDQ_DISTANCE_MAX
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

/// 여러 자산의 요약을 한 번의 IN 쿼리로 로드한다(단건 쿼리 반복 제거).
/// 상태 판정은 별도 배치 조회 결과로 수행한다. normal·review 자산이
/// 한 페이지에 섞여 있기 때문이다.
pub(super) fn load_asset_summaries(
    connection: &Connection,
    asset_ids: &[String],
) -> Result<HashMap<String, AssetSummary>, LibraryError> {
    if asset_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let mut sql = format!(
        "SELECT asset.id, asset.title, asset.original_name, asset.relative_path,
                asset.thumbnail_relative_path, asset.byte_size, asset.width, asset.height,
                asset.collected_at, EXISTS(SELECT 1 FROM asset_likes WHERE asset_id = asset.id), asset.source_url, asset.media_kind,
                video.duration_ms, video.preparation_state, video.scrub_frame_count,
                asset.source_published_at, asset.creator_name, asset.creator_handle,
                asset.creator_url, asset.import_source, asset.import_batch_id,
                asset.original_modified_at, {CONTENT_RATING_SQL} AS content_rating FROM assets AS asset
         LEFT JOIN video_assets AS video ON video.asset_id = asset.id
         WHERE asset.id IN (",
    );
    for (index, _) in asset_ids.iter().enumerate() {
        if index > 0 {
            sql.push_str(", ");
        }
        sql.push_str(&format!("?{}", index + 1));
    }
    sql.push(')');
    let mut statement = connection.prepare(&sql)?;
    let params: Vec<&str> = asset_ids.iter().map(String::as_str).collect();
    let mut map = HashMap::new();
    let rows = statement.query_map(
        rusqlite::params_from_iter(params.iter()),
        asset_summary_from_row,
    )?;
    for summary in rows {
        let summary = summary?;
        map.insert(summary.id.clone(), summary);
    }
    Ok(map)
}

pub(super) fn load_account_roles(
    connection: &Connection,
    ids: &[String],
) -> Result<HashMap<String, AccountRole>, LibraryError> {
    let mut roles = HashMap::new();
    for chunk in ids.chunks(400) {
        let placeholders = vec!["?"; chunk.len()].join(",");
        let mut stmt = connection.prepare(&format!(
            "SELECT scope.asset_id, artists.reposter
            FROM asset_artist_scope scope JOIN artists ON scope.scope_ref = 'artist:' || artists.id
            WHERE scope.asset_id IN ({placeholders})"
        ))?;
        for row in stmt.query_map(rusqlite::params_from_iter(chunk), |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, bool>(1)?))
        })? {
            let (id, reposter) = row?;
            roles.insert(
                id,
                if reposter {
                    AccountRole::Reposter
                } else {
                    AccountRole::Artist
                },
            );
        }
    }
    Ok(roles)
}

/// 여러 자산의 상태를 한 번의 IN 쿼리로 로드한다.
fn load_asset_statuses(
    connection: &Connection,
    asset_ids: &[String],
) -> Result<HashMap<String, String>, LibraryError> {
    if asset_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let mut sql = String::from("SELECT id, status FROM assets WHERE id IN (");
    for (index, _) in asset_ids.iter().enumerate() {
        if index > 0 {
            sql.push_str(", ");
        }
        sql.push_str(&format!("?{}", index + 1));
    }
    sql.push(')');
    let mut statement = connection.prepare(&sql)?;
    let params: Vec<&str> = asset_ids.iter().map(String::as_str).collect();
    let mut map = HashMap::new();
    let rows = statement.query_map(rusqlite::params_from_iter(params.iter()), |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    for row in rows {
        let (id, status) = row?;
        map.insert(id, status);
    }
    Ok(map)
}

/// 여러 자산의 분류를 한 번의 IN 쿼리로 로드한다(단건 쿼리 반복 제거).
/// Same count subquery (and `CROSS JOIN` driver) as `classification::ASSET_CLASSIFICATIONS_SQL`.
pub(super) fn classifications_for_assets(
    connection: &Connection,
    asset_ids: &[String],
) -> Result<HashMap<String, Vec<ClassificationEntry>>, LibraryError> {
    if asset_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let mut sql = String::from(
        "SELECT link.asset_id, entry.id, entry.kind, entry.name, entry.parent_id, entry.icon_key, entry.color_key,
            (SELECT COUNT(*) FROM asset_classifications AS count_link
             CROSS JOIN assets AS count_asset ON count_asset.id = count_link.asset_id
             WHERE count_link.classification_id = entry.id
               AND count_asset.status = 'normal') AS asset_count
         FROM classification_entries AS entry
         JOIN asset_classifications AS link ON link.classification_id = entry.id
         WHERE link.asset_id IN (",
    );
    for (index, _) in asset_ids.iter().enumerate() {
        if index > 0 {
            sql.push_str(", ");
        }
        sql.push_str(&format!("?{}", index + 1));
    }
    sql.push_str(") ORDER BY entry.name COLLATE NOCASE, entry.id");
    let mut statement = connection.prepare(&sql)?;
    let params: Vec<&str> = asset_ids.iter().map(String::as_str).collect();
    let rows = statement.query_map(rusqlite::params_from_iter(params.iter()), |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, Option<String>>(4)?,
            row.get::<_, Option<String>>(5)?,
            row.get::<_, Option<String>>(6)?,
            row.get::<_, i64>(7)?,
        ))
    })?;
    let mut map: HashMap<String, Vec<ClassificationEntry>> = HashMap::new();
    for row in rows {
        let (asset_id, id, kind, name, parent_id, icon_key, color_key, asset_count) = row?;
        let kind = match kind.as_str() {
            "root" => ClassificationKind::Root,
            "work" => ClassificationKind::Work,
            "tag" => ClassificationKind::Tag,
            _ => return Err(rusqlite::Error::InvalidQuery.into()),
        };
        map.entry(asset_id).or_default().push(ClassificationEntry {
            id,
            kind,
            name,
            parent_id,
            icon_key,
            color_key,
            asset_count: asset_count.max(0) as u64,
            is_container: false,
            total_asset_count: None,
        });
    }
    Ok(map)
}

fn decode_review_cursor(after: Option<AssetCursor>) -> Result<Option<ReviewCursor>, LibraryError> {
    after
        .map(|cursor| {
            serde_json::from_str(&cursor.token).map_err(|_| LibraryError::InvalidAssetCursor)
        })
        .transpose()
}

fn load_asset_summary(
    connection: &Connection,
    asset_id: &str,
    expected_status: &str,
) -> Result<AssetSummary, LibraryError> {
    connection
        .query_row(
            &format!("SELECT asset.id, asset.title, asset.original_name, asset.relative_path,
                    asset.thumbnail_relative_path, asset.byte_size, asset.width, asset.height,
                    asset.collected_at, EXISTS(SELECT 1 FROM asset_likes WHERE asset_id = asset.id), asset.source_url, asset.media_kind,
                    video.duration_ms, video.preparation_state, video.scrub_frame_count,
                    asset.source_published_at, asset.creator_name, asset.creator_handle,
                    asset.creator_url, asset.import_source, asset.import_batch_id,
                    asset.original_modified_at, {CONTENT_RATING_SQL} AS content_rating FROM assets AS asset
             LEFT JOIN video_assets AS video ON video.asset_id = asset.id
             WHERE asset.id = ?1 AND asset.status = ?2"),
            params![asset_id, expected_status],
            asset_summary_from_row,
        )
        .optional()?
        .ok_or(LibraryError::AssetNotFound)
}

/// Carry the discarded image's user organization to the kept image. Classifications
/// have one direct membership: as with replacement, the discarded assignment wins.
fn merge_review_metadata(
    transaction: &Transaction<'_>,
    discarded_id: &str,
    kept_id: &str,
) -> Result<(), LibraryError> {
    let source = incoming_promotion_classification(transaction, discarded_id)?;
    let final_classification = source.or(incoming_promotion_classification(transaction, kept_id)?);
    if let Some(id) = &final_classification {
        transaction.execute(
            "DELETE FROM asset_classifications WHERE asset_id=?1",
            [kept_id],
        )?;
        transaction.execute(
            "INSERT INTO asset_classifications(asset_id,classification_id) VALUES(?1,?2)",
            params![kept_id, id],
        )?;
    }
    // Under the Collections authority the inherited memberships and covers are server
    // commands too; inactive libraries keep the legacy local rewrite only.
    let authority = super::collection_authority::collection_write_status(transaction)?;
    let joined: Vec<String> = transaction
            .prepare(
                "SELECT collection_id FROM collection_assets WHERE asset_id = ?1
                 AND collection_id NOT IN (SELECT collection_id FROM collection_assets WHERE asset_id = ?2)",
            )?
            .query_map(params![discarded_id, kept_id], |r| r.get(0))?
            .collect::<Result<_, _>>()?;
    let covered: Vec<(String, serde_json::Value)> = if authority.active {
        transaction
            .prepare("SELECT id FROM collections WHERE cover_asset_id = ?1")?
            .query_map([discarded_id], |r| r.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?
            .into_iter()
            .map(|id| {
                let before = super::collection_authority::editable_work(transaction, &id)?;
                Ok((id, before))
            })
            .collect::<Result<_, LibraryError>>()?
    } else {
        Vec::new()
    };
    transaction.execute(
        "INSERT OR IGNORE INTO collection_assets (collection_id, asset_id, added_at)
             SELECT collection_id, ?2, added_at
             FROM collection_assets WHERE asset_id = ?1",
        params![discarded_id, kept_id],
    )?;
    transaction.execute(
        "UPDATE collections
             SET cover_asset_id = ?2, updated_at = ?3
             WHERE cover_asset_id = ?1",
        params![discarded_id, kept_id, chrono::Utc::now().to_rfc3339()],
    )?;
    if authority.active {
        for collection_id in &joined {
            let entity_key = serde_json::json!([collection_id, kept_id]).to_string();
            let revision = super::collection_authority::predicted_collection_revision(
                transaction,
                "memberships",
                &entity_key,
            )?;
            super::collection_authority::enqueue_collection_command(
                transaction,
                &authority,
                "setMembership",
                &entity_key,
                serde_json::json!({"workId":collection_id,"assetId":kept_id,"desiredState":true,"expectedRevision":revision}),
            )?;
        }
        for (collection_id, before) in &covered {
            super::collection_authority::enqueue_work_changes(
                transaction,
                &authority,
                collection_id,
                before,
            )?;
        }
    }

    let albums = transaction.prepare("SELECT album_id FROM asset_albums WHERE asset_id=?1 AND album_id NOT IN (SELECT album_id FROM asset_albums WHERE asset_id=?2)")?
        .query_map(params![discarded_id,kept_id], |r|r.get::<_,String>(0))?.collect::<Result<Vec<_>,_>>()?;
    for album in albums {
        transaction.execute(
            "INSERT INTO asset_albums(asset_id,album_id) VALUES(?1,?2)",
            params![kept_id, album],
        )?;
        Library::enqueue_album_membership_intent(transaction, &album, kept_id, true)?;
    }
    transaction.execute("UPDATE assets SET favorite=MAX(favorite,(SELECT favorite FROM assets WHERE id=?1)) WHERE id=?2",params![discarded_id,kept_id])?;
    Library::enqueue_classification_assignment_intent(
        transaction,
        kept_id,
        final_classification.as_deref(),
    )?;
    crate::cloud::queue::enqueue_asset_upsert(
        transaction,
        kept_id,
        &chrono::Utc::now().to_rfc3339(),
    )?;
    Ok(())
}

/// Resolve within the caller's transaction: no incoming-file deletion, even when A wins.
pub(super) fn auto_resolve_repost(
    transaction: &Transaction<'_>,
    review_id: &str,
    a: &str,
    b: &str,
    distance: u32,
) -> Result<Option<String>, LibraryError> {
    if distance > AUTO_REPOST_DISTANCE_MAX {
        return Ok(None);
    }
    let ids = vec![a.to_owned(), b.to_owned()];
    let summaries = load_asset_summaries(transaction, &ids)?;
    let roles = load_account_roles(transaction, &ids)?;
    let (Some(aa), Some(bb)) = (summaries.get(a), summaries.get(b)) else {
        return Ok(None);
    };
    if posting_handle(aa).is_none() || posting_handle(bb).is_none() {
        return Ok(None);
    }
    if posting_handle(aa)
        .zip(posting_handle(bb))
        .is_some_and(|(a, b)| a.eq_ignore_ascii_case(b))
    {
        return Ok(None);
    }
    let ar = roles.get(a).copied().unwrap_or_default();
    let br = roles.get(b).copied().unwrap_or_default();
    let (kept, discarded, decision) = match (ar, br) {
        (AccountRole::Artist, AccountRole::Reposter) => (a, b, "keep_existing"),
        (AccountRole::Reposter, AccountRole::Artist) => (b, a, "replace_existing"),
        _ => return Ok(None),
    };
    resolve_review(transaction, review_id, decision)?;
    transaction.execute(
        "UPDATE assets SET status='normal' WHERE id=?1 AND status='review'",
        [b],
    )?;
    merge_review_metadata(transaction, discarded, kept)?;
    super::trash::update_trash_status_in_transaction(
        transaction,
        &[discarded.to_owned()],
        "normal",
        "trash",
        Some(&chrono::Utc::now().to_rfc3339()),
    )?;
    super::character_autotag::enqueue(
        transaction,
        kept,
        super::character_autotag::Cause::SimilarityResolution,
    )?;
    release_incoming_reviews_without_existing(transaction, None)?;
    Ok(Some(kept.to_owned()))
}

/// Only X exposes a posting handle today. Other sources remain unknown/manual.
pub(super) fn posting_handle(asset: &AssetSummary) -> Option<&str> {
    let url = url::Url::parse(asset.source_url.as_deref()?).ok()?;
    if !matches!(
        url.host_str()?.trim_start_matches("www."),
        "x.com" | "twitter.com" | "mobile.twitter.com"
    ) {
        return None;
    }
    asset
        .creator_handle
        .as_deref()
        .map(|h| h.trim().trim_start_matches('@'))
        .filter(|h| !h.is_empty())
}

pub(super) fn comparison_clues(
    a: &AssetSummary,
    ar: AccountRole,
    b: &AssetSummary,
    br: AccountRole,
) -> (SimilarityClues, Option<ClueKey>, Option<ClueSide>) {
    use std::cmp::Ordering;
    let favour = |order| match order {
        Ordering::Greater => Some(ClueSide::A),
        Ordering::Less => Some(ClueSide::B),
        Ordering::Equal => None,
    };
    let ah = posting_handle(a);
    let bh = posting_handle(b);
    let same = matches!((ah, bh), (Some(a), Some(b)) if a.eq_ignore_ascii_case(b));
    let rank = |r| match r {
        AccountRole::Artist => 2,
        AccountRole::Unknown => 1,
        AccountRole::Reposter => 0,
    };
    let account = if same || (ah.is_none() && bh.is_none()) {
        None
    } else {
        favour(rank(ar).cmp(&rank(br)))
    };
    let minute = |value: &Option<String>| {
        value
            .as_deref()
            .and_then(|v| chrono::DateTime::parse_from_rfc3339(v).ok())
            .map(|v| v.timestamp().div_euclid(60))
    };
    let posted = if same {
        None
    } else {
        match (
            minute(&a.source_published_at),
            minute(&b.source_published_at),
        ) {
            (Some(a), Some(b)) => favour(b.cmp(&a)),
            _ => None,
        }
    };
    let pixels = |s: &AssetSummary| {
        (s.width > 0 && s.height > 0).then_some(u64::from(s.width) * u64::from(s.height))
    };
    let resolution = match (pixels(a), pixels(b)) {
        (Some(a), Some(b)) => favour(a.cmp(&b)),
        _ => None,
    };
    let largest = a.byte_size.max(b.byte_size) as u128;
    let bytes =
        if largest == 0 || u128::from(a.byte_size.abs_diff(b.byte_size)) * 100 <= largest * 2 {
            None
        } else {
            favour(a.byte_size.cmp(&b.byte_size))
        };
    let clues = SimilarityClues {
        account,
        posted,
        resolution,
        bytes,
    };
    let deciding = [
        (ClueKey::Account, account),
        (ClueKey::Posted, posted),
        (ClueKey::Resolution, resolution),
        (ClueKey::Bytes, bytes),
    ]
    .into_iter()
    .find(|(_, side)| side.is_some());
    (
        clues,
        deciding.map(|(key, _)| key),
        deciding.and_then(|(_, side)| side),
    )
}

/// The format label shown for a review image: its file extension, `JPG` as `JPEG`.
pub(super) fn review_format(relative_path: &str) -> String {
    Path::new(relative_path)
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| match extension.to_ascii_uppercase().as_str() {
            "JPG" => "JPEG".to_owned(),
            other => other.to_owned(),
        })
        .unwrap_or_else(|| "IMAGE".to_owned())
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

// Do not silently choose a folder when a legacy Asset has multiple memberships.
fn incoming_promotion_classification(
    connection: &Connection,
    asset_id: &str,
) -> Result<Option<String>, LibraryError> {
    let classifications = connection
        .prepare("SELECT classification_id FROM asset_classifications WHERE asset_id = ?1")?
        .query_map([asset_id], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    if classifications.len() > 1 {
        return Err(LibraryError::InvalidAssetSelection);
    }
    Ok(classifications.into_iter().next())
}

/// Close open incoming reviews whose existing Asset is no longer `normal` (or is `departing`,
/// i.e. about to be deleted), keeping the candidate.
///
/// Such a review can never be decided: every decision verifies the existing Asset is
/// `normal`. An incoming review has no `stale` state (0090 allows it only for historical
/// pairs), and the only outcome that never loses the candidate image is the one "keep both"
/// already defines: the candidate becomes `normal` with the same follow-up work, and the
/// review is `resolved` / `keep_both`. Resolving also clears the open-row CHECK that would
/// otherwise make deleting the existing Asset (purge) fail through `ON DELETE SET NULL`.
pub(crate) fn release_incoming_reviews_without_existing(
    connection: &Connection,
    departing: Option<&str>,
) -> Result<usize, LibraryError> {
    // Legacy cleanup can call without a transaction. Promotion and both outboxes
    // must still commit together; existing transactional callers keep their boundary.
    if connection.is_autocommit() {
        let transaction = connection.unchecked_transaction()?;
        let released = release_incoming_reviews_without_existing(&transaction, departing)?;
        transaction.commit()?;
        return Ok(released);
    }
    let stranded = connection
        .prepare(
            "SELECT id, candidate_asset_id FROM similarity_reviews r
             WHERE review_kind = 'incoming' AND status = 'open'
               AND (existing_asset_id = ?1
                    OR NOT EXISTS (SELECT 1 FROM assets a
                                   WHERE a.id = r.existing_asset_id AND a.status = 'normal'))",
        )?
        .query_map([departing], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let now = chrono::Utc::now().to_rfc3339();
    for (review_id, candidate_id) in &stranded {
        let final_classification = incoming_promotion_classification(connection, candidate_id)?;
        let promoted = connection.execute(
            "UPDATE assets SET status = 'normal', trashed_at = NULL WHERE id = ?1 AND status = 'review'",
            [candidate_id],
        )?;
        if promoted > 0 {
            Library::enqueue_classification_assignment_intent(
                connection,
                candidate_id,
                final_classification.as_deref(),
            )?;
            super::character_autotag::enqueue(
                connection,
                candidate_id,
                super::character_autotag::Cause::SimilarityResolution,
            )?;
            crate::cloud::queue::enqueue_asset_upsert(connection, candidate_id, &now)?;
        }
        resolve_review(connection, review_id, "keep_both")?;
    }
    Ok(stranded.len())
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

pub(crate) fn perceptual_hash_from_file(file: File) -> Result<PerceptualHashResult, LibraryError> {
    let image = decode_image_for_fingerprint(file)?;
    perceptual_hash_from_image(&image)
}

/// Decode with the same decoder and limits used for stored fingerprints.
pub(super) fn decode_image_for_fingerprint(
    mut file: File,
) -> Result<image::DynamicImage, LibraryError> {
    #[cfg(test)]
    let decode_phase = super::ingestion::performance::Phase::start("fingerprint_decode");
    file.seek(SeekFrom::Start(0))
        .map_err(|_| LibraryError::UnsupportedImage)?;
    let reader = ImageReader::new(BufReader::new(file))
        .with_guessed_format()
        .map_err(|_| LibraryError::UnsupportedImage)?;
    let mut decoder = reader
        .into_decoder()
        .map_err(|_| LibraryError::UnsupportedImage)?;
    let orientation = decoder
        .orientation()
        .unwrap_or(image::metadata::Orientation::NoTransforms);
    let mut image =
        image::DynamicImage::from_decoder(decoder).map_err(|_| LibraryError::UnsupportedImage)?;
    image.apply_orientation(orientation);
    #[cfg(test)]
    drop(decode_phase);
    Ok(image)
}

/// The caller must apply EXIF orientation before sharing these pixels with other consumers.
pub(super) fn perceptual_hash_from_image(
    image: &image::DynamicImage,
) -> Result<PerceptualHashResult, LibraryError> {
    #[cfg(test)]
    let _compute_phase = super::ingestion::performance::Phase::start("fingerprint_compute");
    let fingerprint = fingerprint(image)?;
    Ok(PerceptualHashResult {
        fingerprint,
        width: image.width(),
        height: image.height(),
    })
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
#[path = "similarity_tests.rs"]
mod tests;
