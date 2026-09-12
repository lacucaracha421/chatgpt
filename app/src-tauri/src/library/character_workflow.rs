//! Explicit manual-character and series-level character-classification workflow.
use super::{
    character_autotag::{self, Cause},
    character_hub,
    characters::{DecisionKind, DecisionRequest, Error, Result, Target},
    query::asset_summaries_by_ids,
    Library,
};
use rusqlite::{params, OptionalExtension};
use serde::Deserialize;
use std::collections::BTreeSet;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManualCharacterRequest {
    pub series_id: String,
    pub display_name: String,
    pub asset_ids: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeriesAssetExclusionRequest {
    pub series_id: String,
    pub asset_ids: Vec<String>,
    pub excluded: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CharacterReviewCompletionRequest {
    pub series_id: String,
    pub asset_ids: Vec<String>,
}

impl Library {
    pub fn create_manual_character(&self, request: ManualCharacterRequest) -> Result<Target> {
        let ids = request.asset_ids.into_iter().collect::<BTreeSet<_>>();
        let name = request.display_name.trim();
        if ids.is_empty() || ids.len() > 200 || name.is_empty() {
            return Err(Error::Invalid(
                "캐릭터 이름과 1~200개 자산을 확인해 주세요.",
            ));
        }
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        let registered: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM character_series WHERE classification_id=?1)",
            [&request.series_id],
            |r| r.get(0),
        )?;
        if !registered {
            return Err(Error::Invalid("등록된 시리즈를 선택해 주세요."));
        }
        let duplicate: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM character_targets WHERE series_classification_id=?1 AND display_name=?2 COLLATE NOCASE)",
            params![request.series_id, name], |r| r.get(0),
        )?;
        if duplicate {
            return Err(Error::Invalid("같은 이름의 캐릭터가 이미 있습니다."));
        }
        for asset_id in &ids {
            character_hub::candidate_media_mode(
                &transaction,
                &request.series_id,
                asset_id,
                false,
                true,
            )?;
        }
        let thumbnail: Option<String> =
            ids.iter().find_map(|asset_id| {
                transaction.query_row(
                "SELECT id FROM assets WHERE id=?1 AND status='normal' AND media_kind='image'",
                [asset_id], |r| r.get(0),
            ).ok()
            });
        let id = uuid::Uuid::new_v4().to_string();
        let now = chrono::Utc::now().to_rfc3339();
        transaction.execute(
            "INSERT INTO character_targets(id,series_classification_id,display_name,enabled,manual_only,thumbnail_asset_id,created_at,updated_at)
             VALUES(?1,?2,?3,1,1,?4,?5,?5)",
            params![id, request.series_id, name, thumbnail, now],
        )?;
        transaction.execute(
            "INSERT INTO character_manual_targets(target_id,created_at) VALUES(?1,?2)",
            params![id, now],
        )?;
        let target = self.read_character_target(&transaction, &id)?;
        self.write_character_decisions(
            &transaction,
            DecisionRequest {
                target_id: id.clone(),
                expected_fingerprint: target.fingerprint.clone(),
                asset_ids: ids.into_iter().collect(),
                decision: DecisionKind::Accepted,
                baseline_fingerprint: None,
                scan_id: None,
            },
        )?;
        let result = self.read_character_target(&transaction, &id)?;
        transaction.commit()?;
        Ok(result)
    }

    pub fn complete_character_review(
        &self,
        request: CharacterReviewCompletionRequest,
    ) -> Result<usize> {
        let ids = request.asset_ids.into_iter().collect::<BTreeSet<_>>();
        if ids.is_empty() || ids.len() > 200 {
            return Err(Error::Invalid("한 번에 1~200개 자산을 선택해 주세요."));
        }
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        let registered: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM character_series WHERE classification_id=?1)",
            [&request.series_id],
            |row| row.get(0),
        )?;
        if !registered {
            return Err(Error::Invalid("등록된 시리즈를 선택해 주세요."));
        }
        let now = chrono::Utc::now().to_rfc3339();
        for asset_id in &ids {
            character_hub::candidate_image_mode(&transaction, &request.series_id, asset_id, false)?;
            let current: Option<(i64, i64)> = transaction
                .query_row(
                    "SELECT generation,source_generation FROM character_autotag_jobs
                 WHERE asset_id=?1 AND state='completed' AND review_state='partially_resolved'",
                    [asset_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?;
            let (generation, source_generation) = current.ok_or(Error::Stale)?;
            transaction.execute(
                "INSERT INTO character_review_completions(asset_id,generation,source_generation,completed_at)
                 VALUES(?1,?2,?3,?4)
                 ON CONFLICT(asset_id) DO UPDATE SET generation=excluded.generation,source_generation=excluded.source_generation,completed_at=excluded.completed_at",
                params![asset_id, generation, source_generation, now],
            )?;
        }
        transaction.commit()?;
        Ok(ids.len())
    }

    pub fn set_character_series_asset_excluded(
        &self,
        request: SeriesAssetExclusionRequest,
    ) -> Result<usize> {
        let ids = request.asset_ids.into_iter().collect::<BTreeSet<_>>();
        if ids.is_empty() || ids.len() > 200 {
            return Err(Error::Invalid("한 번에 1~200개 자산을 선택해 주세요."));
        }
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        let registered: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM character_series WHERE classification_id=?1)",
            [&request.series_id],
            |r| r.get(0),
        )?;
        if !registered {
            return Err(Error::Invalid("등록된 시리즈를 선택해 주세요."));
        }
        for asset_id in &ids {
            character_hub::candidate_media_mode_including_excluded(
                &transaction,
                &request.series_id,
                asset_id,
                false,
                true,
            )?;
            if request.excluded {
                transaction.execute(
                    "INSERT OR IGNORE INTO character_series_asset_exclusions(series_id,asset_id,created_at) VALUES(?1,?2,?3)",
                    params![request.series_id, asset_id, chrono::Utc::now().to_rfc3339()],
                )?;
            } else {
                transaction.execute(
                    "DELETE FROM character_series_asset_exclusions WHERE series_id=?1 AND asset_id=?2",
                    params![request.series_id, asset_id],
                )?;
                character_autotag::enqueue(&transaction, asset_id, Cause::ManualScanEnrollment)?;
            }
        }
        transaction.commit()?;
        Ok(ids.len())
    }
}

impl Library {
    pub fn character_series_excluded_assets(
        &self,
        series_id: &str,
        after: Option<&str>,
        limit: usize,
    ) -> Result<character_hub::BrowsePage> {
        if !(1..=200).contains(&limit) {
            return Err(Error::Invalid("조회 개수가 올바르지 않습니다."));
        }
        let cursor: Option<(String, String)> = after.map(serde_json::from_str).transpose()?;
        let connection = self.connection()?;
        let scope = "WITH RECURSIVE scope(id) AS (SELECT id FROM classification_entries WHERE id=?1 UNION SELECT c.id FROM classification_entries c JOIN scope s ON c.parent_id=s.id)
            SELECT a.id,a.collected_at FROM assets a WHERE a.status='normal'
            AND EXISTS(SELECT 1 FROM asset_classifications ac WHERE ac.asset_id=a.id AND ac.classification_id IN (SELECT id FROM scope))
            AND EXISTS(SELECT 1 FROM character_series_asset_exclusions x WHERE x.series_id=?1 AND x.asset_id=a.id)";
        let total: i64 = connection.query_row(
            &format!("SELECT COUNT(*) FROM ({scope})"),
            [series_id],
            |r| r.get(0),
        )?;
        let sql = format!("{scope} AND (?2 IS NULL OR (a.collected_at,a.id)<(?2,?3)) ORDER BY a.collected_at DESC,a.id DESC LIMIT ?4");
        let rows = connection
            .prepare(&sql)?
            .query_map(
                params![
                    series_id,
                    cursor.as_ref().map(|c| &c.0),
                    cursor.as_ref().map(|c| &c.1),
                    (limit + 1) as i64
                ],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
            )?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let next_cursor = if rows.len() > limit {
            let last = &rows[limit - 1];
            Some(serde_json::to_string(&(&last.1, &last.0))?)
        } else {
            None
        };
        let ids = rows
            .iter()
            .take(limit)
            .map(|row| row.0.clone())
            .collect::<Vec<_>>();
        let items = asset_summaries_by_ids(&connection, &ids)?;
        Ok(character_hub::BrowsePage {
            items,
            next_cursor,
            total_count: total as u64,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library::{
        character_hub::Series,
        characters::{tests::Fixture, CharacterSettingsDraft, TargetDraft},
        models::SetAssetClassification,
    };

    fn register_series(f: &Fixture) {
        f.library
            .save_character_series(Series {
                classification_id: f.series.clone(),
                hero_asset_id: None,
                auto_classify: true,
            })
            .unwrap();
        f.library
            .connection()
            .unwrap()
            .execute("DELETE FROM character_autotag_reconsideration", [])
            .unwrap();
    }

    #[test]
    fn manual_character_needs_no_references_and_promotes_in_place_at_five() {
        let f = Fixture::new();
        register_series(&f);
        let manual = f
            .library
            .create_manual_character(ManualCharacterRequest {
                series_id: f.series.clone(),
                display_name: "Small cast".into(),
                asset_ids: vec!["asset-5".into()],
            })
            .unwrap();
        assert!(manual.manual_only);
        assert!(!manual.ready);
        assert_eq!(
            f.library.character_relations_for_asset("asset-5").unwrap(),
            vec![manual.id.clone()]
        );
        let reconsideration: i64 = f
            .library
            .connection()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM character_autotag_reconsideration WHERE series_id=?1",
                [&f.series],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(reconsideration, 0);

        let promoted = f
            .library
            .replace_character_references(&manual.id, manual.revision, &f.refs)
            .unwrap();
        assert_eq!(promoted.id, manual.id);
        assert!(!promoted.manual_only);
        assert!(promoted.ready);
        let reconsideration: i64 = f
            .library
            .connection()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM character_autotag_reconsideration WHERE series_id=?1",
                [&f.series],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(reconsideration, 0);
    }

    #[test]
    fn underfilled_character_created_from_settings_is_manual() {
        let f = Fixture::new();
        register_series(&f);

        let created = f
            .library
            .save_character_settings(
                CharacterSettingsDraft {
                    target: TargetDraft {
                        id: None,
                        expected_revision: None,
                        series_classification_id: Some(f.series.clone()),
                        linked_classification_id: None,
                        display_name: "Small cast".into(),
                        description: String::new(),
                        thumbnail_asset_id: None,
                        enabled: true,
                    },
                    reference_ids: vec!["asset-5".into()],
                },
                true,
            )
            .unwrap();

        assert!(created.manual_only);
        assert!(!created.ready);
        assert_eq!(created.references.len(), 1);
        assert_eq!(
            f.library
                .connection()
                .unwrap()
                .query_row(
                    "SELECT COUNT(*) FROM character_manual_targets WHERE target_id=?1",
                    [&created.id],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            1
        );
    }

    #[test]
    fn series_exclusion_hides_unclassified_asset_and_restore_queues_manual_work() {
        let f = Fixture::new();
        register_series(&f);
        let before = f
            .library
            .browse_character_assets(character_hub::BrowseQuery {
                series_id: f.series.clone(),
                target_id: None,
                group_id: None,
                reference_target_id: None,
                after: None,
                limit: 100,
                all: false,
                series_filter: None,
            })
            .unwrap()
            .total_count;
        f.library
            .set_character_series_asset_excluded(SeriesAssetExclusionRequest {
                series_id: f.series.clone(),
                asset_ids: vec!["asset-5".into()],
                excluded: true,
            })
            .unwrap();
        let hidden = f
            .library
            .browse_character_assets(character_hub::BrowseQuery {
                series_id: f.series.clone(),
                target_id: None,
                group_id: None,
                reference_target_id: None,
                after: None,
                limit: 100,
                all: false,
                series_filter: None,
            })
            .unwrap()
            .total_count;
        assert_eq!(hidden + 1, before);
        let excluded = f
            .library
            .character_series_excluded_assets(&f.series, None, 100)
            .unwrap();
        assert_eq!(
            excluded
                .items
                .iter()
                .map(|a| a.id.as_str())
                .collect::<Vec<_>>(),
            vec!["asset-5"]
        );

        f.library
            .set_character_series_asset_excluded(SeriesAssetExclusionRequest {
                series_id: f.series.clone(),
                asset_ids: vec!["asset-5".into()],
                excluded: false,
            })
            .unwrap();
        let job = f.library.character_autotag_job("asset-5").unwrap().unwrap();
        assert_eq!(job.state, "pending");
        assert_eq!(job.cause, "manual_scan");
    }

    #[test]
    fn excluded_asset_requires_explicit_restore_before_manual_assignment() {
        let f = Fixture::new();
        register_series(&f);
        let target = f.ready("A");
        f.library
            .set_character_series_asset_excluded(SeriesAssetExclusionRequest {
                series_id: f.series.clone(),
                asset_ids: vec!["asset-5".into()],
                excluded: true,
            })
            .unwrap();

        assert!(character_hub::candidate_image_mode(
            &f.library.connection().unwrap(),
            &f.series,
            "asset-5",
            false,
        )
        .is_err());
        assert!(character_hub::validate_character_selection(
            &f.library.connection().unwrap(),
            &f.series,
            Some(&target.id),
            "asset-5",
        )
        .is_err());
        assert!(f
            .library
            .record_character_decisions(DecisionRequest {
                target_id: target.id.clone(),
                expected_fingerprint: target.fingerprint.clone(),
                asset_ids: vec!["asset-5".into()],
                decision: DecisionKind::Accepted,
                baseline_fingerprint: None,
                scan_id: None,
            })
            .is_err());
        assert!(f.library.connection().unwrap().query_row(
            "SELECT EXISTS(SELECT 1 FROM character_series_asset_exclusions WHERE series_id=?1 AND asset_id='asset-5')",
            [&f.series], |row| row.get::<_, bool>(0),
        ).unwrap());

        f.library
            .set_character_series_asset_excluded(SeriesAssetExclusionRequest {
                series_id: f.series.clone(),
                asset_ids: vec!["asset-5".into()],
                excluded: false,
            })
            .unwrap();
        assert!(character_hub::candidate_image_mode(
            &f.library.connection().unwrap(),
            &f.series,
            "asset-5",
            false,
        )
        .is_ok());
        let job = f.library.character_autotag_job("asset-5").unwrap().unwrap();
        assert_eq!(job.state, "pending");
        assert_eq!(job.cause, "manual_scan");
    }

    #[test]
    fn failed_exclusion_restore_rolls_back_the_exclusion_and_queue_together() {
        let f = Fixture::new();
        register_series(&f);
        f.library
            .set_character_series_asset_excluded(SeriesAssetExclusionRequest {
                series_id: f.series.clone(),
                asset_ids: vec!["asset-5".into()],
                excluded: true,
            })
            .unwrap();

        assert!(f
            .library
            .set_character_series_asset_excluded(SeriesAssetExclusionRequest {
                series_id: f.series.clone(),
                asset_ids: vec!["asset-5".into(), "asset-6".into()],
                excluded: false,
            })
            .is_err());

        assert!(f.library.connection().unwrap().query_row(
            "SELECT EXISTS(SELECT 1 FROM character_series_asset_exclusions WHERE series_id=?1 AND asset_id='asset-5')",
            [&f.series], |row| row.get::<_, bool>(0),
        ).unwrap());
        assert!(f
            .library
            .character_autotag_job("asset-5")
            .unwrap()
            .is_none());
    }

    #[test]
    fn review_completion_hides_only_the_current_partial_generation() {
        let f = Fixture::new();
        register_series(&f);
        let target = f.ready("A");
        f.library
            .record_character_decisions(DecisionRequest {
                target_id: target.id.clone(),
                expected_fingerprint: target.fingerprint.clone(),
                asset_ids: vec!["asset-5".into()],
                decision: DecisionKind::Accepted,
                baseline_fingerprint: None,
                scan_id: None,
            })
            .unwrap();
        f.library.connection().unwrap().execute(
            "INSERT INTO character_autotag_jobs(asset_id,generation,source_generation,content_hash,relative_path,classification_ids,state,review_state,updated_at)
             SELECT id,1,1,content_hash,relative_path,'[]','completed','partially_resolved','now' FROM assets WHERE id='asset-5'",
            [],
        ).unwrap();
        let needs_review = || {
            f.library
                .browse_character_assets(character_hub::BrowseQuery {
                    series_id: f.series.clone(),
                    target_id: None,
                    group_id: None,
                    reference_target_id: None,
                    after: None,
                    limit: 100,
                    all: false,
                    series_filter: Some(character_hub::SeriesGalleryFilter::NeedsReview),
                })
                .unwrap()
        };
        assert_eq!(
            needs_review()
                .items
                .iter()
                .map(|asset| asset.id.as_str())
                .collect::<Vec<_>>(),
            vec!["asset-5"]
        );
        let relations = f.library.character_relations_for_asset("asset-5").unwrap();

        assert_eq!(
            f.library
                .complete_character_review(CharacterReviewCompletionRequest {
                    series_id: f.series.clone(),
                    asset_ids: vec!["asset-5".into()],
                })
                .unwrap(),
            1
        );
        assert!(needs_review().items.is_empty());
        assert_eq!(
            f.library.character_relations_for_asset("asset-5").unwrap(),
            relations
        );
        let all = f
            .library
            .browse_character_assets(character_hub::BrowseQuery {
                series_id: f.series.clone(),
                target_id: None,
                group_id: None,
                reference_target_id: None,
                after: None,
                limit: 100,
                all: true,
                series_filter: Some(character_hub::SeriesGalleryFilter::All),
            })
            .unwrap();
        assert!(all.items.iter().any(|asset| asset.id == "asset-5"));

        f.library.connection().unwrap().execute(
            "UPDATE character_autotag_jobs SET generation=2,source_generation=2,review_state='partially_resolved' WHERE asset_id='asset-5'",
            [],
        ).unwrap();
        assert_eq!(
            needs_review()
                .items
                .iter()
                .map(|asset| asset.id.as_str())
                .collect::<Vec<_>>(),
            vec!["asset-5"]
        );
    }

    #[test]
    fn review_completion_is_atomic_and_a_relation_change_reopens_review() {
        let f = Fixture::new();
        register_series(&f);
        let target = f.ready("A");
        f.library
            .record_character_decisions(DecisionRequest {
                target_id: target.id.clone(),
                expected_fingerprint: target.fingerprint.clone(),
                asset_ids: vec!["asset-5".into()],
                decision: DecisionKind::Accepted,
                baseline_fingerprint: None,
                scan_id: None,
            })
            .unwrap();
        f.library.connection().unwrap().execute(
            "INSERT INTO character_autotag_jobs(asset_id,generation,source_generation,content_hash,relative_path,classification_ids,state,review_state,updated_at)
             SELECT id,1,1,content_hash,relative_path,'[]','completed','partially_resolved','now' FROM assets WHERE id='asset-5'",
            [],
        ).unwrap();

        assert!(f
            .library
            .complete_character_review(CharacterReviewCompletionRequest {
                series_id: f.series.clone(),
                asset_ids: vec!["asset-5".into(), "asset-6".into()],
            })
            .is_err());
        assert_eq!(
            f.library
                .connection()
                .unwrap()
                .query_row(
                    "SELECT COUNT(*) FROM character_review_completions",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            0
        );

        f.library
            .complete_character_review(CharacterReviewCompletionRequest {
                series_id: f.series.clone(),
                asset_ids: vec!["asset-5".into()],
            })
            .unwrap();
        f.library
            .record_character_decisions(DecisionRequest {
                target_id: target.id,
                expected_fingerprint: target.fingerprint,
                asset_ids: vec!["asset-5".into()],
                decision: DecisionKind::Cleared,
                baseline_fingerprint: None,
                scan_id: None,
            })
            .unwrap();
        assert_eq!(
            f.library
                .connection()
                .unwrap()
                .query_row(
                    "SELECT COUNT(*) FROM character_review_completions WHERE asset_id='asset-5'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            0
        );
    }

    #[test]
    fn originals_role_blocks_registered_series_from_moving_into_storage_scope() {
        let f = Fixture::new();
        register_series(&f);
        let originals: String = f
            .library
            .connection()
            .unwrap()
            .query_row(
                "SELECT classification_id FROM classification_roles WHERE role='originals'",
                [],
                |row| row.get(0),
            )
            .unwrap();

        assert!(f
            .library
            .save_character_series(Series {
                classification_id: originals.clone(),
                hero_asset_id: None,
                auto_classify: true,
            })
            .is_err());
        assert!(f
            .library
            .move_classification(&f.series, Some(&originals))
            .is_err());
        assert!(f
            .library
            .rename_classification(&originals, "Renamed originals")
            .is_err());
        assert!(f.library.move_classification(&originals, None).is_err());
        assert!(f.library.delete_classification(&originals).is_err());

        let parent: Option<String> = f
            .library
            .connection()
            .unwrap()
            .query_row(
                "SELECT parent_id FROM classification_entries WHERE id=?1",
                [&f.series],
                |row| row.get(0),
            )
            .unwrap();
        assert_ne!(parent.as_deref(), Some(originals.as_str()));
    }

    #[test]
    fn originals_are_storage_only_and_never_enter_character_queue() {
        let f = Fixture::new();
        let original_id: String = f
            .library
            .connection()
            .unwrap()
            .query_row(
                "SELECT id FROM classification_entries WHERE parent_id IS NULL AND name='오리지널'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        f.library
            .set_asset_classification(SetAssetClassification {
                asset_ids: vec!["asset-5".into()],
                classification_id: Some(original_id),
            })
            .unwrap();
        assert!(f
            .library
            .character_autotag_job("asset-5")
            .unwrap()
            .is_none());
        assert!(!character_autotag::enqueue(
            &f.library.connection().unwrap(),
            "asset-5",
            Cause::Ingestion,
        )
        .unwrap());
    }
}
