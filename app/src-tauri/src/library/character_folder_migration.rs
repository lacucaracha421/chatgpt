//! One-time migration from a mixed legacy classification folder into character relations + a display group.
use std::collections::BTreeSet;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use super::{
    character_autotag::{self, Cause},
    character_groups::{save_character_group_in, GroupDraft},
    characters::{Error, Result},
    models::SetAssetClassification,
    Library,
};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MixedFolderTargetCount {
    pub target_id: String,
    pub count: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MixedFolderPreview {
    pub folder_id: String,
    pub folder_name: String,
    pub series_id: String,
    pub series_name: String,
    pub total_count: u64,
    pub image_count: u64,
    pub other_media_count: u64,
    pub child_folder_count: u64,
    pub unscanned_count: u64,
    pub pending_count: u64,
    pub resolved_count: u64,
    pub review_count: u64,
    pub failed_count: u64,
    pub target_counts: Vec<MixedFolderTargetCount>,
    pub grouped_target_ids: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueMixedFolderRequest {
    pub folder_id: String,
    pub series_id: String,
    pub expected_total_count: u64,
    pub expected_image_count: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FinalizeMixedFolderRequest {
    pub folder_id: String,
    pub series_id: String,
    pub expected_total_count: u64,
    pub expected_image_count: u64,
    pub group_name: String,
    pub target_ids: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FinalizeMixedFolderResult {
    pub series_id: String,
    pub group_id: String,
    pub moved_image_count: u64,
    pub retained_asset_count: u64,
    pub folder_removed: bool,
}

fn folder_context(connection: &Connection, folder_id: &str) -> Result<(String, String, String)> {
    let folder = connection
        .query_row(
            "SELECT name,parent_id FROM classification_entries WHERE id=?1",
            [folder_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
        )
        .optional()?;
    let Some((folder_name, Some(parent_id))) = folder else {
        return Err(Error::Invalid("작품 아래의 일반 폴더를 선택해 주세요."));
    };
    let registered: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM character_series WHERE classification_id=?1)",
        [folder_id],
        |row| row.get(0),
    )?;
    if registered {
        return Err(Error::Invalid(
            "작품 폴더 자체는 이 방식으로 정리할 수 없습니다.",
        ));
    }
    let linked: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM character_targets WHERE linked_classification_id=?1)",
        [folder_id],
        |row| row.get(0),
    )?;
    if linked {
        return Err(Error::Invalid("이미 단일 캐릭터로 연결된 폴더입니다."));
    }
    let series = connection
        .query_row(
            "WITH RECURSIVE lineage(id,name,parent_id,depth) AS (
                SELECT id,name,parent_id,0 FROM classification_entries WHERE id=?1
                UNION ALL
                SELECT c.id,c.name,c.parent_id,lineage.depth+1
                FROM classification_entries c JOIN lineage ON c.id=lineage.parent_id)
             SELECT lineage.id,lineage.name FROM lineage
             JOIN character_series s ON s.classification_id=lineage.id
             ORDER BY lineage.depth,lineage.id LIMIT 1",
            [parent_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()?;
    let Some((series_id, series_name)) = series else {
        return Err(Error::Invalid(
            "먼저 상위 작품을 캐릭터 시리즈로 등록해 주세요.",
        ));
    };
    Ok((folder_name, series_id, series_name))
}

fn direct_asset_ids(
    connection: &Connection,
    folder_id: &str,
    images_only: bool,
) -> Result<Vec<String>> {
    let media_filter = if images_only {
        "AND a.media_kind='image'"
    } else {
        ""
    };
    let sql = format!(
        "SELECT a.id FROM assets a JOIN asset_classifications ac ON ac.asset_id=a.id
         WHERE ac.classification_id=?1 AND a.status='normal' {media_filter} ORDER BY a.id"
    );
    Ok(connection
        .prepare(&sql)?
        .query_map([folder_id], |row| row.get::<_, String>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?)
}

fn counts(connection: &Connection, folder_id: &str) -> Result<(u64, u64, u64, u64)> {
    let (total, images): (i64, i64) = connection.query_row(
        "SELECT COUNT(*),COALESCE(SUM(CASE WHEN a.media_kind='image' THEN 1 ELSE 0 END),0)
         FROM assets a JOIN asset_classifications ac ON ac.asset_id=a.id
         WHERE ac.classification_id=?1 AND a.status='normal'",
        [folder_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    let children: i64 = connection.query_row(
        "SELECT COUNT(*) FROM classification_entries WHERE parent_id=?1",
        [folder_id],
        |row| row.get(0),
    )?;
    Ok((
        total.max(0) as u64,
        images.max(0) as u64,
        total.saturating_sub(images).max(0) as u64,
        children.max(0) as u64,
    ))
}

fn analysis_counts(
    connection: &Connection,
    folder_id: &str,
    image_count: u64,
) -> Result<(u64, u64, u64, u64, u64)> {
    let (pending, resolved, review, failed): (i64, i64, i64, i64) = connection.query_row(
        "SELECT
            COALESCE(SUM(CASE WHEN j.state IN ('pending','processing') THEN 1 ELSE 0 END),0),
            COALESCE(SUM(CASE WHEN j.state='completed' AND e.id IS NOT NULL AND j.review_state='resolved' THEN 1 ELSE 0 END),0),
            COALESCE(SUM(CASE WHEN j.state='completed' AND e.id IS NOT NULL AND j.review_state IN ('awaiting_candidates','unresolved','partially_resolved') THEN 1 ELSE 0 END),0),
            COALESCE(SUM(CASE WHEN j.state='failed' THEN 1 ELSE 0 END),0)
         FROM assets a
         JOIN asset_classifications ac ON ac.asset_id=a.id AND ac.classification_id=?1
         LEFT JOIN character_autotag_jobs j ON j.asset_id=a.id
         LEFT JOIN character_autotag_evidence e ON e.asset_id=a.id AND e.generation=j.generation
            AND e.source_generation=j.source_generation AND e.content_hash=a.content_hash
         WHERE a.status='normal' AND a.media_kind='image'",
        [folder_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
    )?;
    let pending = pending.max(0) as u64;
    let resolved = resolved.max(0) as u64;
    let review = review.max(0) as u64;
    let failed = failed.max(0) as u64;
    let known = pending
        .saturating_add(resolved)
        .saturating_add(review)
        .saturating_add(failed);
    Ok((
        image_count.saturating_sub(known),
        pending,
        resolved,
        review,
        failed,
    ))
}

impl Library {
    pub fn mixed_character_folder_preview(&self, folder_id: &str) -> Result<MixedFolderPreview> {
        let connection = self.connection()?;
        let (folder_name, series_id, series_name) = folder_context(&connection, folder_id)?;
        let (total_count, image_count, other_media_count, child_folder_count) =
            counts(&connection, folder_id)?;
        let (unscanned_count, pending_count, resolved_count, review_count, failed_count) =
            analysis_counts(&connection, folder_id, image_count)?;
        let target_counts = connection
            .prepare(
                "SELECT r.target_id,COUNT(DISTINCT r.asset_id)
                 FROM character_relations r
                 JOIN character_targets t ON t.id=r.target_id AND t.series_classification_id=?2
                 JOIN asset_classifications ac ON ac.asset_id=r.asset_id AND ac.classification_id=?1
                 JOIN assets a ON a.id=r.asset_id AND a.status='normal' AND a.media_kind='image'
                 GROUP BY r.target_id ORDER BY COUNT(DISTINCT r.asset_id) DESC,r.target_id",
            )?
            .query_map(params![folder_id, series_id], |row| {
                Ok(MixedFolderTargetCount {
                    target_id: row.get(0)?,
                    count: row.get::<_, i64>(1)?.max(0) as u64,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let grouped_target_ids = connection
            .prepare(
                "SELECT m.target_id FROM character_group_members m
                 JOIN character_groups g ON g.id=m.group_id WHERE g.series_id=?1 ORDER BY m.target_id",
            )?
            .query_map([&series_id], |row| row.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(MixedFolderPreview {
            folder_id: folder_id.to_string(),
            folder_name,
            series_id,
            series_name,
            total_count,
            image_count,
            other_media_count,
            child_folder_count,
            unscanned_count,
            pending_count,
            resolved_count,
            review_count,
            failed_count,
            target_counts,
            grouped_target_ids,
        })
    }

    pub fn queue_mixed_character_folder(&self, request: QueueMixedFolderRequest) -> Result<usize> {
        let mut connection = self.connection()?;
        let (_, series_id, _) = folder_context(&connection, &request.folder_id)?;
        if series_id != request.series_id {
            return Err(Error::Stale);
        }
        let (total_count, image_count, _, _) = counts(&connection, &request.folder_id)?;
        if total_count != request.expected_total_count
            || image_count != request.expected_image_count
        {
            return Err(Error::Stale);
        }
        if image_count == 0 {
            return Err(Error::Invalid("분석할 이미지가 없습니다."));
        }
        let automatic: bool = connection.query_row(
            "SELECT auto_classify FROM character_series WHERE classification_id=?1",
            [&series_id],
            |row| row.get(0),
        )?;
        if !automatic {
            return Err(Error::Invalid("먼저 작품의 자동 분류를 켜 주세요."));
        }
        let ids = direct_asset_ids(&connection, &request.folder_id, true)?;
        let transaction = connection.transaction()?;
        let mut queued = 0;
        for id in ids {
            let in_flight: bool = transaction.query_row(
                "SELECT EXISTS(SELECT 1 FROM character_autotag_jobs WHERE asset_id=?1 AND state IN ('pending','processing'))",
                [&id],
                |row| row.get(0),
            )?;
            if !in_flight {
                queued += usize::from(character_autotag::enqueue(
                    &transaction,
                    &id,
                    Cause::ManualScanEnrollment,
                )?);
            }
        }
        transaction.commit()?;
        Ok(queued)
    }

    pub fn finalize_mixed_character_folder(
        &self,
        request: FinalizeMixedFolderRequest,
    ) -> Result<FinalizeMixedFolderResult> {
        let mut connection = self.connection()?;
        let (folder_name, series_id, _) = folder_context(&connection, &request.folder_id)?;
        if series_id != request.series_id {
            return Err(Error::Stale);
        }
        let (total_count, image_count, _, _) = counts(&connection, &request.folder_id)?;
        if total_count != request.expected_total_count
            || image_count != request.expected_image_count
        {
            return Err(Error::Stale);
        }
        if image_count == 0 {
            return Err(Error::Invalid("정리할 이미지가 없습니다."));
        }
        let (_, pending, resolved, review, failed) =
            analysis_counts(&connection, &request.folder_id, image_count)?;
        let analyzed = pending
            .saturating_add(resolved)
            .saturating_add(review)
            .saturating_add(failed);
        if pending > 0 || analyzed < image_count {
            return Err(Error::Invalid(
                "폴더 이미지 분석이 끝난 뒤 정리를 완료해 주세요.",
            ));
        }
        let targets = request.target_ids.iter().cloned().collect::<BTreeSet<_>>();
        if targets.len() < 2 || targets.len() != request.target_ids.len() {
            return Err(Error::Invalid(
                "그룹에 넣을 캐릭터를 두 명 이상 선택해 주세요.",
            ));
        }
        let group_name = request.group_name.trim();
        if group_name.is_empty() || group_name.chars().count() > 100 {
            return Err(Error::Invalid("그룹 이름을 확인해 주세요."));
        }
        let duplicate_group: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM character_groups WHERE series_id=?1 AND name=?2 COLLATE NOCASE)",
            params![series_id, group_name],
            |row| row.get(0),
        )?;
        if duplicate_group {
            return Err(Error::Invalid("같은 이름의 캐릭터 그룹이 이미 있습니다."));
        }
        let image_ids = direct_asset_ids(&connection, &request.folder_id, true)?;
        let transaction = connection.transaction()?;
        let group_id = save_character_group_in(
            &transaction,
            GroupDraft {
                id: None,
                series_id: series_id.clone(),
                expected_revision: None,
                name: group_name.to_string(),
                target_ids: request.target_ids,
                delete: false,
            },
        )?;
        for chunk in image_ids.chunks(200) {
            Self::set_asset_classification_cause_in(
                &transaction,
                &SetAssetClassification {
                    asset_ids: chunk.to_vec(),
                    classification_id: Some(series_id.clone()),
                },
                Cause::AutomaticFinalization,
            )?;
        }
        let retained_asset_count: i64 = transaction.query_row(
            "SELECT COUNT(*) FROM assets a JOIN asset_classifications ac ON ac.asset_id=a.id
             WHERE ac.classification_id=?1 AND a.status='normal'",
            [&request.folder_id],
            |row| row.get(0),
        )?;
        let retained_structure: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM classification_entries WHERE parent_id=?1)
                OR EXISTS(SELECT 1 FROM character_series WHERE classification_id=?1)
                OR EXISTS(SELECT 1 FROM character_targets WHERE linked_classification_id=?1)",
            [&request.folder_id],
            |row| row.get(0),
        )?;
        let folder_removed = retained_asset_count == 0 && !retained_structure;
        if folder_removed {
            transaction.execute(
                "DELETE FROM classification_entries WHERE id=?1",
                [&request.folder_id],
            )?;
        }
        transaction.commit()?;
        let _ = folder_name;
        Ok(FinalizeMixedFolderResult {
            series_id,
            group_id,
            moved_image_count: image_ids.len() as u64,
            retained_asset_count: retained_asset_count.max(0) as u64,
            folder_removed,
        })
    }
}
