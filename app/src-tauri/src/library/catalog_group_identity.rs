use std::collections::HashMap;

use rusqlite::{params, Connection};

use super::error::LibraryError;

pub(super) struct ReconciledHandles {
    pub member_groups: HashMap<String, String>,
    pub resolved_handles: HashMap<String, String>,
}

#[derive(Debug, PartialEq, Eq)]
pub(super) struct GroupPreference {
    pub anchor_work_id: String,
    pub selected_work_id: Option<String>,
    pub edit_revision: i64,
}

pub(super) fn set_preference(
    connection: &Connection,
    provider: &str,
    anchor_work_id: &str,
    selected_work_id: Option<&str>,
) -> Result<i64, LibraryError> {
    // NULL is an explicit return to automatic selection, not a deleted choice.
    // Allocate and write in one statement, also when called outside a rebuild.
    Ok(connection.query_row(
        "INSERT INTO online_catalog_group_preferences(provider,anchor_work_id,selected_work_id,edit_revision)
         SELECT ?1,?2,?3,COALESCE(MAX(edit_revision),0)+1 FROM online_catalog_group_preferences WHERE 1
         ON CONFLICT(provider,anchor_work_id) DO UPDATE SET
           selected_work_id=excluded.selected_work_id, edit_revision=excluded.edit_revision
         RETURNING edit_revision",
        params![provider, anchor_work_id, selected_work_id],
        |row| row.get(0),
    )?)
}

pub(super) fn load_preferences(
    connection: &Connection,
    provider: &str,
) -> Result<Vec<GroupPreference>, LibraryError> {
    let mut statement = connection.prepare(
        "SELECT anchor_work_id,selected_work_id,edit_revision FROM online_catalog_group_preferences
         WHERE provider=?1 ORDER BY anchor_work_id",
    )?;
    let preferences = statement
        .query_map([provider], |row| {
            Ok(GroupPreference {
                anchor_work_id: row.get(0)?,
                selected_work_id: row.get(1)?,
                edit_revision: row.get(2)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(preferences)
}

pub(super) fn reconcile_handles(
    connection: &Connection,
    provider: &str,
    components: &[Vec<String>],
) -> Result<ReconciledHandles, LibraryError> {
    // The caller owns the transaction so handles and derived membership commit together.
    let mut statement = connection.prepare(
        "SELECT anchor_work_id, group_id, sequence FROM online_catalog_group_handles WHERE provider=?1",
    )?;
    let mut handles = statement
        .query_map([provider], |row| {
            Ok((
                row.get::<_, String>(0)?,
                (row.get::<_, String>(1)?, row.get::<_, i64>(2)?),
            ))
        })?
        .collect::<Result<HashMap<_, _>, _>>()?;
    let mut insert = connection.prepare(
        "INSERT INTO online_catalog_group_handles(provider,anchor_work_id,group_id) VALUES(?1,?2,?3)",
    )?;
    let mut member_groups = HashMap::new();
    for component in components {
        for work_id in component {
            if !handles.contains_key(work_id) {
                let group_id = uuid::Uuid::new_v4().to_string();
                insert.execute(params![provider, work_id, group_id])?;
                handles.insert(work_id.clone(), (group_id, connection.last_insert_rowid()));
            }
        }
        if let Some((group_id, _)) = component
            .iter()
            .map(|id| &handles[id])
            .min_by_key(|(_, sequence)| *sequence)
        {
            for work_id in component {
                member_groups.insert(work_id.clone(), group_id.clone());
            }
        }
    }
    let resolved_handles = handles
        .into_iter()
        .filter_map(|(anchor, (handle, _))| {
            member_groups
                .get(&anchor)
                .map(|active| (handle, active.clone()))
        })
        .collect();
    Ok(ReconciledHandles {
        member_groups,
        resolved_handles,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn components(groups: &[&[&str]]) -> Vec<Vec<String>> {
        groups
            .iter()
            .map(|group| group.iter().map(|id| (*id).to_owned()).collect())
            .collect()
    }

    #[test]
    fn manual_preferences_keep_dormant_anchors_and_explicit_auto_after_restart() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("library.sqlite");
        let db = super::super::db::initialize_database(&path).unwrap();
        let first = set_preference(&db, "p", "a", Some("b")).unwrap();
        assert!(first > 0);
        let second = set_preference(&db, "p", "b", Some("a")).unwrap();
        let auto = set_preference(&db, "p", "a", None).unwrap();
        assert!(first < second && second < auto);
        reconcile_handles(&db, "p", &[]).unwrap();
        drop(db);
        let db = super::super::db::initialize_database(&path).unwrap();
        assert_eq!(
            load_preferences(&db, "p").unwrap(),
            vec![
                GroupPreference {
                    anchor_work_id: "a".into(),
                    selected_work_id: None,
                    edit_revision: auto
                },
                GroupPreference {
                    anchor_work_id: "b".into(),
                    selected_work_id: Some("a".into()),
                    edit_revision: second
                },
            ]
        );
        assert!(load_preferences(&db, "other").unwrap().is_empty());
        assert!(set_preference(&db, "other", "a", Some("arbitrary/string:id")).unwrap() > auto);
    }

    #[test]
    fn durable_handles_survive_rebuild_merge_split_and_missing_return() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("library.sqlite");
        let db = super::super::db::initialize_database(&path).unwrap();
        let first = reconcile_handles(&db, "provider", &components(&[&["z"], &["y"]])).unwrap();
        assert_eq!(first.member_groups.len(), 2);
        let z = first.member_groups["z"].clone();
        let y = first.member_groups["y"].clone();
        assert_ne!(z, y);
        assert!(uuid::Uuid::parse_str(&z).is_ok());
        drop(db);
        let db = super::super::db::initialize_database(&path).unwrap();
        let merged = reconcile_handles(&db, "provider", &components(&[&["a", "y", "z"]])).unwrap();
        assert_eq!(merged.member_groups["a"], z);
        assert_eq!(merged.resolved_handles[&y], z);
        let split =
            reconcile_handles(&db, "provider", &components(&[&["a", "y"], &["z"]])).unwrap();
        assert_eq!(split.member_groups["a"], y);
        assert_eq!(split.resolved_handles[&y], y);
        assert_eq!(split.resolved_handles[&z], z);
        let missing = reconcile_handles(&db, "provider", &components(&[&["z"]])).unwrap();
        assert!(!missing.resolved_handles.contains_key(&y));
        let returned = reconcile_handles(&db, "provider", &components(&[&["y"]])).unwrap();
        assert_eq!(returned.member_groups["y"], y);
        let other = reconcile_handles(&db, "other", &components(&[&["y"]])).unwrap();
        assert_ne!(other.member_groups["y"], y);
    }
}
