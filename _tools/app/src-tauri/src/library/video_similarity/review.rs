use super::{
    scan::Source, Error, Result, VideoDecisionRequest, VideoMatchEvidence, VideoReview,
    VideoReviewDecision, VideoReviewPage,
};
use crate::library::{trash::update_trash_status_in_transaction, Library};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{
    sync::atomic::AtomicBool,
    time::{Duration, Instant},
};

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Cursor {
    created_at: String,
    id: String,
}

impl Library {
    pub(super) fn save_video_review(
        &self,
        scan_id: &str,
        left: &Source,
        right: &Source,
        evidence: &VideoMatchEvidence,
    ) -> Result<()> {
        let connection = self.connection()?;
        let valid: bool = connection.query_row(
            "SELECT (SELECT COUNT(*) FROM assets WHERE status='normal' AND media_kind='video' AND ((id=?1 AND content_hash=?2) OR (id=?3 AND content_hash=?4)))=2",
            params![left.id,left.hash,right.id,right.hash],|r|r.get(0))?;
        if !valid {
            return Ok(());
        }
        let json = serde_json::to_string(evidence).map_err(|_| Error::Processing)?;
        connection.execute(
            "INSERT INTO video_similarity_reviews(id,scan_id,left_asset_id,right_asset_id,left_hash,right_hash,profile,evidence_json,state,created_at)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,'open',?9)
             ON CONFLICT(left_hash,right_hash) DO UPDATE SET
               scan_id=excluded.scan_id,left_asset_id=excluded.left_asset_id,right_asset_id=excluded.right_asset_id,
               profile=excluded.profile,evidence_json=excluded.evidence_json,state='open'
             WHERE video_similarity_reviews.decision IS NULL",
            params![uuid::Uuid::new_v4().to_string(),scan_id,left.id,right.id,left.hash,right.hash,evidence.profile,json,chrono::Utc::now().to_rfc3339()])?;
        Ok(())
    }

    pub fn list_video_similarity_reviews(
        &self,
        after: Option<String>,
        limit: u32,
    ) -> Result<VideoReviewPage> {
        let cursor: Option<Cursor> = after
            .as_deref()
            .map(serde_json::from_str)
            .transpose()
            .map_err(|_| Error::NotFound)?;
        let _guard = self
            .trash_lock
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let (count, mut rows) = {
            let connection = self.connection()?;
            let count: u32 = connection.query_row(
                "SELECT COUNT(*) FROM video_similarity_reviews WHERE state='open'",
                [],
                |r| r.get(0),
            )?;
            let mut statement = connection.prepare(
                "SELECT id,left_asset_id,right_asset_id,evidence_json,created_at FROM video_similarity_reviews
                 WHERE state='open' AND (?1 IS NULL OR created_at>?1 OR (created_at=?1 AND id>?2))
                 ORDER BY created_at,id LIMIT ?3")?;
            let rows = statement
                .query_map(
                    params![
                        cursor.as_ref().map(|c| &c.created_at),
                        cursor.as_ref().map(|c| &c.id),
                        limit.clamp(1, 50) + 1
                    ],
                    |r| {
                        Ok((
                            r.get::<_, String>(0)?,
                            r.get::<_, String>(1)?,
                            r.get::<_, String>(2)?,
                            r.get::<_, String>(3)?,
                            r.get::<_, String>(4)?,
                        ))
                    },
                )?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            (count, rows)
        };
        let more = rows.len() > limit.clamp(1, 50) as usize;
        rows.truncate(limit.clamp(1, 50) as usize);
        let next_cursor = if more {
            rows.last()
                .map(|(id, _, _, _, date)| {
                    serde_json::to_string(&Cursor {
                        created_at: date.clone(),
                        id: id.clone(),
                    })
                    .map_err(|_| Error::Processing)
                })
                .transpose()?
        } else {
            None
        };
        let mut items = Vec::new();
        for (id, left, right, json, created_at) in rows {
            items.push(VideoReview {
                id,
                left: self.get_asset(&left)?,
                right: self.get_asset(&right)?,
                evidence: serde_json::from_str(&json).map_err(|_| Error::Processing)?,
                created_at,
            });
        }
        Ok(VideoReviewPage {
            items,
            total_count: count,
            next_cursor,
        })
    }

    pub fn decide_video_similarity_review(&self, request: VideoDecisionRequest) -> Result<()> {
        let (left_id,right_id,left_hash,right_hash,state,stored_decision) = self.connection()?.query_row(
            "SELECT left_asset_id,right_asset_id,left_hash,right_hash,state,decision FROM video_similarity_reviews WHERE id=?1",
            [&request.review_id],|r|Ok((r.get::<_,Option<String>>(0)?,r.get::<_,Option<String>>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?,r.get::<_,String>(4)?,r.get::<_,Option<String>>(5)?)))
            .optional()?.ok_or(Error::NotFound)?;
        if state == "resolved" {
            return if stored_decision.as_deref() == Some(request.decision.as_str()) {
                Ok(())
            } else {
                Err(Error::Conflict)
            };
        }
        if state != "open" {
            return Err(Error::Stale);
        }
        let left_id = left_id.ok_or(Error::Stale)?;
        let right_id = right_id.ok_or(Error::Stale)?;
        let left = self.video_similarity_source(&left_id)?;
        let right = self.video_similarity_source(&right_id)?;
        if left.hash != left_hash || right.hash != right_hash {
            return Err(Error::Stale);
        }
        let cancel = AtomicBool::new(false);
        let deadline = Instant::now() + Duration::from_secs(60);
        // Verify the bytes, not merely the saved assets.content_hash. Handles prevent a
        // Windows writer from replacing either file before the decision commits.
        let verified = (|| {
            Ok::<_, &'static str>((
                self.verify_video_similarity_source(&left, &cancel, deadline)?,
                self.verify_video_similarity_source(&right, &cancel, deadline)?,
            ))
        })();
        let _sources = match verified {
            Ok(sources) => sources,
            Err(_) => {
                self.connection()?.execute("UPDATE video_similarity_reviews SET state='stale' WHERE id=?1 AND state='open'",[&request.review_id])?;
                return Err(Error::Stale);
            }
        };
        let _guard = self
            .trash_lock
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut connection = self.connection()?;
        let tx = connection.transaction()?;
        let current: (String, Option<String>) = tx.query_row(
            "SELECT state,decision FROM video_similarity_reviews WHERE id=?1",
            [&request.review_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        if current.0 == "resolved" {
            return if current.1.as_deref() == Some(request.decision.as_str()) {
                Ok(())
            } else {
                Err(Error::Conflict)
            };
        }
        if current.0 != "open" {
            return Err(Error::Stale);
        }
        let valid:bool = tx.query_row(
            "SELECT (SELECT COUNT(*) FROM assets WHERE status='normal' AND media_kind='video' AND ((id=?1 AND content_hash=?2) OR (id=?3 AND content_hash=?4)))=2",
            params![left_id,left_hash,right_id,right_hash],|r|r.get(0))?;
        if !valid {
            return Err(Error::Stale);
        }
        let now = chrono::Utc::now().to_rfc3339();
        let trash_id = match request.decision {
            VideoReviewDecision::KeepLeft => Some(right_id),
            VideoReviewDecision::KeepRight => Some(left_id),
            _ => None,
        };
        if let Some(id) = trash_id {
            update_trash_status_in_transaction(&tx, &[id], "normal", "trash", Some(&now))?;
        }
        // The asset-status trigger may have marked this and other pairs stale.
        tx.execute("UPDATE video_similarity_reviews SET state='resolved',decision=?2,resolved_at=?3 WHERE id=?1",params![request.review_id,request.decision.as_str(),now])?;
        tx.commit()?;
        Ok(())
    }
}
