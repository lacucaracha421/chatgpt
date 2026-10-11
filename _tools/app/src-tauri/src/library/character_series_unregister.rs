//! "시리즈 등록 해제": a registered series stops being a recognition scope.
//!
//! Images and folders never move. The series' characters, groups and 기타 move to the
//! nearest registered ancestor series, whose folder tree already contains theirs, so every
//! reference stays eligible. Without a registered ancestor there is nowhere for characters
//! to go, so the series can only be unregistered once it has none.
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::Serialize;

use super::{
    character_extras::unique_extras_name,
    characters::{Error, Result},
    Library,
};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeriesUnregisterPreview {
    pub series_id: String,
    pub series_name: String,
    /// The nearest registered ancestor that receives the characters.
    pub destination_id: Option<String>,
    pub destination_name: Option<String>,
    pub character_count: usize,
    pub group_count: usize,
    /// Images held by the series' 기타 buckets (they are kept in the destination's 기타).
    pub extras_image_count: usize,
    /// Names that already exist in the destination series.
    pub collisions: Vec<String>,
    /// Why the series cannot be unregistered right now (Korean, ready to show), if it cannot.
    pub refusal: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeriesUnregisterResult {
    pub series_id: String,
    pub destination_id: Option<String>,
    pub moved_character_count: usize,
    pub moved_group_count: usize,
}

struct Plan {
    preview: SeriesUnregisterPreview,
    /// Targets (characters and group 기타) that change series.
    moving: Vec<String>,
}

fn plan(connection: &Connection, series_id: &str) -> Result<Plan> {
    let registered: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM character_series WHERE classification_id=?1)",
        [series_id],
        |row| row.get(0),
    )?;
    if !registered {
        return Err(Error::Invalid("등록된 시리즈를 선택해 주세요."));
    }
    let series_name: String = connection.query_row(
        "SELECT name FROM classification_entries WHERE id=?1",
        [series_id],
        |row| row.get(0),
    )?;
    let destination: Option<(String, String)> = connection
        .query_row(
            "WITH RECURSIVE up(id,parent_id,depth) AS (
                SELECT id,parent_id,0 FROM classification_entries WHERE id=?1
                UNION ALL
                SELECT c.id,c.parent_id,u.depth+1 FROM classification_entries c JOIN up u ON c.id=u.parent_id
             )
             SELECT u.id,e.name FROM up u
             JOIN character_series s ON s.classification_id=u.id
             JOIN classification_entries e ON e.id=u.id
             WHERE u.depth>0 ORDER BY u.depth LIMIT 1",
            [series_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let character_count: i64 = connection.query_row(
        "SELECT COUNT(*) FROM character_targets WHERE series_classification_id=?1 AND role='character'",
        [series_id],
        |row| row.get(0),
    )?;
    let group_count: i64 = connection.query_row(
        "SELECT COUNT(*) FROM character_groups WHERE series_id=?1",
        [series_id],
        |row| row.get(0),
    )?;
    let extras_image_count: i64 = connection.query_row(
        "SELECT COUNT(DISTINCT r.asset_id) FROM character_targets t
         JOIN character_relations r ON r.target_id=t.id
         WHERE t.series_classification_id=?1 AND t.role='extras'",
        [series_id],
        |row| row.get(0),
    )?;
    let moving = connection
        .prepare(
            "SELECT id FROM character_targets WHERE series_classification_id=?1
             AND NOT (role='extras' AND extras_group_id IS NULL) ORDER BY id",
        )?
        .query_map([series_id], |row| row.get::<_, String>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;

    let mut collisions = Vec::new();
    let mut refusal = None;
    match &destination {
        None => {
            if character_count > 0 {
                refusal = Some(format!(
                    "「{series_name}」에는 캐릭터가 {character_count}명 있고 옮겨 갈 상위 시리즈가 없습니다. 캐릭터를 다른 시리즈로 옮기거나 정리한 뒤 다시 시도해 주세요."
                ));
            } else if extras_image_count > 0 {
                refusal = Some(format!(
                    "「{series_name}」의 기타에 이미지가 {extras_image_count}장 있고 옮겨 갈 상위 시리즈가 없습니다. 기타를 먼저 비워 주세요."
                ));
            }
        }
        Some((destination_id, destination_name)) => {
            collisions = connection
                .prepare(
                    "SELECT t.display_name FROM character_targets t
                     WHERE t.series_classification_id=?1
                       AND NOT (t.role='extras' AND t.extras_group_id IS NULL)
                       AND EXISTS(SELECT 1 FROM character_targets d
                                  WHERE d.series_classification_id=?2 AND d.display_name=t.display_name COLLATE NOCASE)
                     UNION
                     SELECT '그룹 ' || g.name FROM character_groups g
                     WHERE g.series_id=?1
                       AND EXISTS(SELECT 1 FROM character_groups d
                                  WHERE d.series_id=?2 AND d.name=g.name COLLATE NOCASE)
                     ORDER BY 1",
                )?
                .query_map(params![series_id, destination_id], |row| {
                    row.get::<_, String>(0)
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            if !collisions.is_empty() {
                refusal = Some(format!(
                    "「{destination_name}」에 같은 이름이 이미 있어 등록을 해제할 수 없습니다: {}. 이름을 구분한 뒤 다시 시도해 주세요.",
                    collisions.join(", ")
                ));
            }
        }
    }
    Ok(Plan {
        preview: SeriesUnregisterPreview {
            series_id: series_id.to_owned(),
            series_name,
            destination_id: destination.as_ref().map(|d| d.0.clone()),
            destination_name: destination.map(|d| d.1),
            character_count: usize::try_from(character_count).unwrap_or(0),
            group_count: usize::try_from(group_count).unwrap_or(0),
            extras_image_count: usize::try_from(extras_image_count).unwrap_or(0),
            collisions,
            refusal,
        },
        moving,
    })
}

impl Library {
    /// What "시리즈 등록 해제" would do, without changing anything.
    pub fn character_series_unregister_preview(
        &self,
        series_id: &str,
    ) -> Result<SeriesUnregisterPreview> {
        let connection = self.connection()?;
        Ok(plan(&connection, series_id)?.preview)
    }

    /// Unregister a series. See the module documentation for the rule; a refusal is returned
    /// as a Korean error and changes nothing.
    pub fn unregister_character_series(&self, series_id: &str) -> Result<SeriesUnregisterResult> {
        let mut connection = self.connection()?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let (result, moving) = Self::unregister_in(&tx, series_id)?;
        tx.commit()?;
        drop(connection);
        self.cancel_scans_of(&moving);
        Ok(result)
    }

    /// Stop only an obsolete explicit scan of a moved character, not the native queue.
    pub(super) fn cancel_scans_of(&self, moved_targets: &[String]) {
        if let Some(scan) = self.character_scan_status() {
            if moved_targets.contains(&scan.target_id)
                && matches!(scan.state.as_str(), "running" | "cancelling")
            {
                let _ = self.cancel_character_scan(&scan.id);
            }
        }
    }

    /// The body of [`Self::unregister_character_series`] inside the caller's transaction.
    /// Returns the result and the moved targets, whose obsolete scans the caller stops after
    /// the commit.
    pub(super) fn unregister_in(
        tx: &Connection,
        series_id: &str,
    ) -> Result<(SeriesUnregisterResult, Vec<String>)> {
        let Plan { preview, moving } = plan(tx, series_id)?;
        if let Some(refusal) = preview.refusal {
            return Err(Error::InvalidMessage(refusal));
        }
        let now = chrono::Utc::now().to_rfc3339();
        let timestamp = chrono::Utc::now().timestamp();
        let mut moved_characters = 0;
        match (&preview.destination_id, &preview.destination_name) {
            (Some(destination), Some(destination_name)) => {
                moved_characters = preview.character_count;
                // The series' own 기타 joins the destination's 기타: its images are put in
                // the destination's (created on the way if it has none yet).
                let child_extras: Option<String> = tx
                    .query_row(
                        "SELECT id FROM character_targets
                         WHERE role='extras' AND series_classification_id=?1 AND extras_group_id IS NULL",
                        [series_id],
                        |row| row.get(0),
                    )
                    .optional()?;
                if let Some(child_extras) = child_extras {
                    let destination_extras: Option<String> = tx
                        .query_row(
                            "SELECT id FROM character_targets
                             WHERE role='extras' AND series_classification_id=?1 AND extras_group_id IS NULL",
                            [destination],
                            |row| row.get(0),
                        )
                        .optional()?;
                    match destination_extras {
                        Some(destination_extras) => {
                            tx.execute(
                                "INSERT INTO character_decisions
                                 (target_id,asset_id,source_asset_id,asset_hash,decision,target_fingerprint,
                                  baseline_fingerprint,reference_snapshot,origin,created_at)
                                 SELECT ?1,r.asset_id,r.asset_id,d.asset_hash,'accepted','extras-merged',NULL,
                                  '{\"reason\":\"series_unregistered\"}','manual',?3
                                 FROM character_relations r JOIN character_decisions d ON d.sequence=r.sequence
                                 WHERE r.target_id=?2
                                   AND NOT EXISTS(SELECT 1 FROM character_relations x
                                                  WHERE x.target_id=?1 AND x.asset_id=r.asset_id)",
                                params![destination_extras, child_extras, now],
                            )?;
                            tx.execute(
                                "DELETE FROM character_decisions WHERE target_id=?1",
                                [&child_extras],
                            )?;
                            tx.execute(
                                "DELETE FROM character_targets WHERE id=?1",
                                [&child_extras],
                            )?;
                        }
                        None => {
                            let name = unique_extras_name(
                                &tx,
                                destination,
                                destination_name.trim(),
                                Some(&child_extras),
                            )?;
                            tx.execute(
                                "UPDATE character_targets SET series_classification_id=?2,display_name=?3,
                                  revision=revision+1,updated_at=?4 WHERE id=?1",
                                params![child_extras, destination, name, now],
                            )?;
                        }
                    }
                }
                // Groups first: the group membership trigger keeps members whose group
                // already lives in the new series.
                tx.execute(
                    "UPDATE character_groups SET series_id=?2,revision=revision+1 WHERE series_id=?1",
                    params![series_id, destination],
                )?;
                tx.execute(
                    "UPDATE character_targets SET series_classification_id=?2,revision=revision+1,updated_at=?3
                     WHERE series_classification_id=?1",
                    params![series_id, destination, now],
                )?;
                // Explicit opt-outs stay opt-outs after the move.
                tx.execute(
                    "INSERT OR IGNORE INTO character_series_asset_exclusions(series_id,asset_id,created_at)
                     SELECT ?2,asset_id,?3 FROM character_series_asset_exclusions WHERE series_id=?1",
                    params![series_id, destination, now],
                )?;
                // A running historical comparison belongs to the old scope; close it.
                for target in &moving {
                    tx.execute(
                        "UPDATE character_autotag_jobs SET state='superseded',review_state='superseded',claim_id=NULL,error=NULL
                         WHERE cause='reconsideration' AND EXISTS(SELECT 1 FROM character_reference_refresh_items i
                            WHERE i.target_id=?1 AND i.asset_id=character_autotag_jobs.asset_id
                              AND i.generation=character_autotag_jobs.generation AND i.state IN ('pending','processing'))",
                        [target],
                    )?;
                    tx.execute(
                        "UPDATE character_reference_refresh_items SET state='superseded',updated_at=?2
                         WHERE target_id=?1 AND state IN ('pending','processing')",
                        params![target, timestamp],
                    )?;
                    tx.execute(
                        "UPDATE character_reference_refreshes SET state='completed',discovery_complete=1,
                           completed_at=?2,updated_at=?2,last_error=NULL WHERE target_id=?1",
                        params![target, timestamp],
                    )?;
                }
            }
            _ => {
                // No destination and nothing to keep: only empty 기타 buckets can remain.
                tx.execute(
                    "DELETE FROM character_decisions WHERE target_id IN
                     (SELECT id FROM character_targets WHERE series_classification_id=?1 AND role='extras')",
                    [series_id],
                )?;
                tx.execute(
                    "DELETE FROM character_targets WHERE series_classification_id=?1 AND role='extras'",
                    [series_id],
                )?;
            }
        }
        tx.execute(
            "DELETE FROM character_series WHERE classification_id=?1",
            [series_id],
        )?;
        Ok((
            SeriesUnregisterResult {
                series_id: series_id.to_owned(),
                destination_id: preview.destination_id,
                moved_character_count: moved_characters,
                moved_group_count: preview.group_count,
            },
            moving,
        ))
    }
}

#[cfg(test)]
#[path = "character_series_unregister_tests.rs"]
mod tests;
