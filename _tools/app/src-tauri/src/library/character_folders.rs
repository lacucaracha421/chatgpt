//! Ordinary folder navigation and inherited character-classification opt-out.
use super::{
    characters::{Error, Result},
    Library,
};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderExclusionRequest {
    pub classification_id: String,
    pub excluded: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeriesFolder {
    pub classification_id: String,
    pub thumbnail_asset_id: Option<String>,
}

pub(super) fn asset_excluded(connection: &Connection, asset_id: &str) -> Result<bool> {
    Ok(connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM asset_classifications ac
         JOIN character_excluded_folders e ON e.id=ac.classification_id WHERE ac.asset_id=?1)",
        [asset_id],
        |row| row.get(0),
    )?)
}

impl Library {
    pub fn character_folder_exclusions(&self) -> Result<Vec<String>> {
        let connection = self.connection()?;
        let result = connection.prepare("SELECT classification_id FROM character_folder_exclusions ORDER BY classification_id")?
            .query_map([], |row| row.get(0))?.collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(result)
    }

    pub fn set_character_folder_excluded(&self, request: FolderExclusionRequest) -> Result<()> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        if request.excluded {
            let eligible: bool = transaction.query_row(
                "WITH RECURSIVE ancestors(id,parent_id) AS (
                    SELECT id,parent_id FROM classification_entries WHERE id=?1
                    UNION SELECT c.id,c.parent_id FROM classification_entries c JOIN ancestors p ON c.id=p.parent_id
                 ) SELECT EXISTS(SELECT 1 FROM classification_entries c WHERE c.id=?1 AND c.parent_id IS NOT NULL
                    AND NOT EXISTS(SELECT 1 FROM character_series WHERE classification_id=c.id)
                    AND NOT EXISTS(SELECT 1 FROM character_targets WHERE linked_classification_id=c.id))
                 AND EXISTS(SELECT 1 FROM ancestors a JOIN character_series s ON s.classification_id=a.id)",
                [&request.classification_id], |row| row.get(0),
            )?;
            if !eligible
                || super::classification::classification_in_role_scope(
                    &transaction,
                    &request.classification_id,
                    "originals",
                )?
            {
                return Err(Error::Invalid("시리즈 아래의 일반 폴더를 선택해 주세요."));
            }
            transaction.execute(
                "INSERT OR IGNORE INTO character_folder_exclusions VALUES(?1)",
                [&request.classification_id],
            )?;
            // Fence work already claimed before the policy changed, even if the
            // user immediately restores inclusion before a worker replies.
            transaction.execute(
                "UPDATE character_autotag_jobs SET state='superseded',review_state='superseded',generation=generation+1,claim_id=NULL,error=NULL,updated_at=unixepoch()
                 WHERE state IN ('pending','processing') AND asset_id IN (
                    SELECT ac.asset_id FROM asset_classifications ac JOIN character_excluded_folders e ON e.id=ac.classification_id)", [],
            )?;
        } else {
            transaction.execute(
                "DELETE FROM character_folder_exclusions WHERE classification_id=?1",
                [&request.classification_id],
            )?;
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn character_series_folders(&self, series_id: &str) -> Result<Vec<SeriesFolder>> {
        let connection = self.connection()?;
        let result = connection.prepare(
            "WITH RECURSIVE folders(id) AS (
                SELECT c.id FROM classification_entries c WHERE c.parent_id=?1
                AND NOT EXISTS(SELECT 1 FROM character_series s WHERE s.classification_id=c.id)
                AND NOT EXISTS(SELECT 1 FROM character_targets t WHERE t.linked_classification_id=c.id)
             ), scope(root,id) AS (
                SELECT id,id FROM folders UNION SELECT s.root,c.id FROM classification_entries c JOIN scope s ON c.parent_id=s.id
             ) SELECT f.id,(SELECT a.id FROM scope s JOIN asset_classifications ac ON ac.classification_id=s.id
                JOIN assets a ON a.id=ac.asset_id WHERE s.root=f.id AND a.status='normal' AND a.thumbnail_relative_path IS NOT NULL
                ORDER BY a.collected_at DESC,a.id DESC LIMIT 1) FROM folders f JOIN classification_entries c ON c.id=f.id ORDER BY c.name COLLATE NOCASE,f.id",
        )?.query_map([series_id], |row| Ok(SeriesFolder { classification_id: row.get(0)?, thumbnail_asset_id: row.get(1)? }))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library::{
        character_autotag::{self, Cause},
        character_hub::{BrowseQuery, SeriesGalleryFilter},
        character_scope::resolve_character_scope,
        characters::{tests::Fixture, DecisionKind, DecisionRequest},
        models::{ClassificationKind, CreateClassification, SetAssetClassification},
    };

    fn folder(f: &Fixture, parent: &str, name: &str) -> String {
        f.library
            .create_classification(CreateClassification {
                kind: ClassificationKind::Tag,
                name: name.into(),
                parent_id: Some(parent.into()),
            })
            .unwrap()
            .id
    }
    fn exclude(f: &Fixture, folder_id: &str, excluded: bool) {
        f.library
            .set_character_folder_excluded(FolderExclusionRequest {
                classification_id: folder_id.into(),
                excluded,
            })
            .unwrap();
    }
    fn move_asset(f: &Fixture, id: &str, folder_id: &str) {
        f.library
            .set_asset_classification(SetAssetClassification {
                asset_ids: vec![id.into()],
                classification_id: Some(folder_id.into()),
            })
            .unwrap();
    }
    fn gallery(f: &Fixture, all: bool) -> Vec<String> {
        let mut ids = Vec::new();
        let mut after = None;
        let mut total = None;
        loop {
            let page = f
                .library
                .browse_character_assets(BrowseQuery {
                    series_id: f.series.clone(),
                    target_id: None,
                    group_id: None,
                    reference_target_id: None,
                    after,
                    limit: 1,
                    all,
                    series_filter: Some(if all {
                        SeriesGalleryFilter::All
                    } else {
                        SeriesGalleryFilter::Unclassified
                    }),
                })
                .unwrap();
            if let Some(total) = total {
                assert_eq!(page.total_count, total);
            }
            total = Some(page.total_count);
            ids.extend(page.items.into_iter().map(|asset| asset.id));
            after = page.next_cursor;
            if after.is_none() {
                break;
            }
        }
        assert_eq!(ids.len() as u64, total.unwrap());
        ids
    }

    #[test]
    fn character_folder_policy_hides_descendants_but_keeps_all_and_manual_relations() {
        let f = Fixture::new();
        let target = f.ready("Pilot");
        let machines = folder(&f, &f.series, "Machines");
        let nested = folder(&f, &machines, "Variants");
        move_asset(&f, "asset-5", &nested);
        assert!(gallery(&f, false).contains(&"asset-5".into()));
        exclude(&f, &machines, true);
        assert!(!gallery(&f, false).contains(&"asset-5".into()));
        assert!(gallery(&f, true).contains(&"asset-5".into()));
        assert!(
            resolve_character_scope(&f.library.connection().unwrap(), "asset-5")
                .unwrap()
                .is_none()
        );
        // Explicit existing memberships remain visible and editable.
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
        assert_eq!(
            f.library.character_relations_for_asset("asset-5").unwrap(),
            vec![target.id.clone()]
        );
        f.library
            .record_character_decisions(DecisionRequest {
                target_id: target.id.clone(),
                expected_fingerprint: target.fingerprint.clone(),
                asset_ids: vec!["asset-5".into()],
                decision: DecisionKind::Rejected,
                baseline_fingerprint: None,
                scan_id: None,
            })
            .unwrap();
        exclude(&f, &machines, false);
        assert!(gallery(&f, false).contains(&"asset-5".into()));
        assert!(
            resolve_character_scope(&f.library.connection().unwrap(), "asset-5")
                .unwrap()
                .is_some()
        );
    }

    #[test]
    fn character_folder_policy_fences_claims_and_future_arrivals_without_replaying_history() {
        let f = Fixture::new();
        f.ready("Pilot");
        let machines = folder(&f, &f.series, "Machines");
        move_asset(&f, "asset-5", &machines);
        let job = f.library.claim_character_autotag().unwrap().unwrap();
        let before = f
            .library
            .character_autotag_context(&f.library.connection().unwrap(), &job, &"a".repeat(64))
            .unwrap();
        exclude(&f, &machines, true);
        exclude(&f, &machines, false);
        let mut connection = f.library.connection().unwrap();
        let tx = connection.transaction().unwrap();
        assert!(matches!(
            f.library.publish_character_autotag(
                &tx,
                &job,
                &before,
                &[],
                character_autotag::ReviewState::Resolved,
                &serde_json::json!([])
            ),
            Err(Error::Stale)
        ));
        tx.commit().unwrap();
        drop(connection);
        assert!(f.library.claim_character_autotag().unwrap().is_none());
        exclude(&f, &machines, true);
        let new_child = folder(&f, &machines, "New arrivals");
        move_asset(&f, "asset-6", &new_child);
        assert!(!character_autotag::enqueue(
            &f.library.connection().unwrap(),
            "asset-6",
            Cause::Ingestion
        )
        .unwrap());
        assert!(!gallery(&f, false).contains(&"asset-6".into()));
        assert!(gallery(&f, true).contains(&"asset-6".into()));
        // The policy follows folder identity after rename and respects moving an asset out.
        let connection = f.library.connection().unwrap();
        connection
            .execute(
                "UPDATE classification_entries SET name='Renamed' WHERE id=?1",
                [&machines],
            )
            .unwrap();
        assert!(asset_excluded(&connection, "asset-6").unwrap());
        drop(connection);
        move_asset(&f, "asset-6", &f.series);
        assert!(!asset_excluded(&f.library.connection().unwrap(), "asset-6").unwrap());
        assert_eq!(
            f.library.character_folder_exclusions().unwrap(),
            vec![machines]
        );
    }

    #[test]
    fn character_folder_cards_keep_ordinary_folders_and_valid_nested_previews() {
        let f = Fixture::new();
        f.ready("Pilot");
        let machines = folder(&f, &f.series, "Machines");
        let nested = folder(&f, &machines, "Variants");
        move_asset(&f, "asset-5", &nested);
        let empty = folder(&f, &f.series, "Empty");
        exclude(&f, &machines, true);
        let cards = f.library.character_series_folders(&f.series).unwrap();
        assert_eq!(cards.len(), 2); // The linked character folder is already represented by its character.
        assert_eq!(
            cards
                .iter()
                .find(|card| card.classification_id == machines)
                .unwrap()
                .thumbnail_asset_id
                .as_deref(),
            Some("asset-5")
        );
        assert_eq!(
            cards
                .iter()
                .find(|card| card.classification_id == empty)
                .unwrap()
                .thumbnail_asset_id,
            None
        );
        f.library.trash_assets(&["asset-5".into()]).unwrap();
        assert_eq!(
            f.library
                .character_series_folders(&f.series)
                .unwrap()
                .iter()
                .find(|card| card.classification_id == machines)
                .unwrap()
                .thumbnail_asset_id,
            None
        );
        // Child exclusions survive removing an ancestor's policy.
        exclude(&f, &nested, true);
        exclude(&f, &machines, false);
        assert!(f
            .library
            .character_folder_exclusions()
            .unwrap()
            .contains(&nested));
        f.library.delete_classification(&nested).unwrap();
        let connection = f.library.connection().unwrap();
        assert!(connection
            .prepare("PRAGMA foreign_key_check")
            .unwrap()
            .query([])
            .unwrap()
            .next()
            .unwrap()
            .is_none());
        drop(connection);
        assert!(!f
            .library
            .character_folder_exclusions()
            .unwrap()
            .contains(&nested));
    }

    #[test]
    fn character_folder_policy_rejects_series_linked_character_and_unrelated_folders() {
        let f = Fixture::new();
        f.ready("Pilot");
        for id in [&f.series, &f.child, &f.outside] {
            assert!(f
                .library
                .set_character_folder_excluded(FolderExclusionRequest {
                    classification_id: id.clone(),
                    excluded: true
                })
                .is_err());
        }
        assert!(f.library.character_folder_exclusions().unwrap().is_empty());
        // An excluded branch also cannot supply inferred series competitors.
        let machines = folder(&f, &f.series, "Machines");
        exclude(&f, &machines, true);
        let nested_series = folder(&f, &machines, "Nested series");
        f.library
            .save_character_series(crate::library::character_hub::Series {
                classification_id: nested_series,
                hero_asset_id: None,
                auto_classify: true,
            })
            .unwrap();
        let root: String = f
            .library
            .connection()
            .unwrap()
            .query_row(
                "SELECT parent_id FROM classification_entries WHERE id=?1",
                [&f.series],
                |row| row.get(0),
            )
            .unwrap();
        move_asset(&f, "asset-6", &root);
        let scope = resolve_character_scope(&f.library.connection().unwrap(), "asset-6")
            .unwrap()
            .unwrap();
        assert_eq!(scope.series_classification_ids, vec![f.series]);
    }
    #[test]
    fn character_folder_policy_upgrades_v70_and_survives_reopening() {
        let f = Fixture::new();
        f.ready("Pilot");
        let folder_id = folder(&f, &f.series, "Machines");
        let connection = f.library.connection().unwrap();
        connection.execute_batch("DROP TRIGGER character_group_remove_empty; DROP VIEW character_excluded_folders; DROP TABLE character_folder_exclusions; PRAGMA user_version=70;").unwrap();
        drop(connection);
        drop(f.library);
        let library = Library::open(f.temp.path()).unwrap();
        library
            .set_character_folder_excluded(FolderExclusionRequest {
                classification_id: folder_id.clone(),
                excluded: true,
            })
            .unwrap();
        assert_eq!(
            library
                .list_classifications()
                .unwrap()
                .iter()
                .filter(|entry| entry.id == folder_id)
                .count(),
            1
        );
        drop(library);
        let reopened = Library::open(f.temp.path()).unwrap();
        assert_eq!(
            reopened.character_folder_exclusions().unwrap(),
            vec![folder_id]
        );
        assert_eq!(
            reopened
                .connection()
                .unwrap()
                .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            super::super::db::SCHEMA_VERSION
        );
    }
}
