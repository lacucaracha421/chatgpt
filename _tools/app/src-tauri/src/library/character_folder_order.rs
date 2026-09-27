//! Local folder presentation, independent of classification authority and recognition.
use rusqlite::{params, TransactionBehavior};

use super::{
    characters::{Error, Result},
    Library,
};

impl Library {
    pub fn move_character_folder(
        &self,
        series_id: &str,
        target_id: &str,
        group_id: Option<&str>,
        direction: i32,
    ) -> Result<()> {
        if !matches!(direction, -1 | 1) {
            return Err(Error::Invalid("이동 방향을 확인해 주세요."));
        }
        let mut connection = self.connection()?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        // Resolve adjacency inside the current visible group, across page boundaries.
        // A stale series/group must not move a target in a different screen.
        let siblings = tx
            .prepare(
                "SELECT t.id,o.position FROM character_targets t
             JOIN character_folder_order o ON o.target_id=t.id
             LEFT JOIN character_group_members gm ON gm.target_id=t.id
             WHERE t.series_classification_id=?1 AND gm.group_id IS ?2
             ORDER BY o.position,t.id",
            )?
            .query_map(params![series_id, group_id], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let index = siblings
            .iter()
            .position(|(id, _)| id == target_id)
            .ok_or(Error::Stale)?;
        let destination = index as i64 + i64::from(direction);
        if destination < 0 || destination >= siblings.len() as i64 {
            return Ok(());
        }
        let (neighbor, position) = &siblings[destination as usize];
        tx.execute(
            "UPDATE character_folder_order SET position=?2 WHERE target_id=?1",
            params![target_id, position],
        )?;
        tx.execute(
            "UPDATE character_folder_order SET position=?2 WHERE target_id=?1",
            params![neighbor, siblings[index].1],
        )?;
        tx.execute(
            "UPDATE character_folder_order SET legacy_sidebar=0 WHERE target_id IN
             (SELECT id FROM character_targets WHERE series_classification_id=?1)",
            [series_id],
        )?;
        tx.commit()?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library::{characters::tests::Fixture, db};

    fn ids(library: &Library) -> Vec<String> {
        library
            .list_character_targets()
            .unwrap()
            .into_iter()
            .map(|t| t.id)
            .collect()
    }

    fn publication(library: &Library) -> (serde_json::Value, serde_json::Value) {
        let mut connection = library.connection().unwrap();
        let classifications = crate::library::list_classifications_in(&connection).unwrap();
        let characters =
            crate::cloud::characters::snapshot_from_connection(&mut connection, None, &|_| {})
                .unwrap();
        (
            serde_json::to_value(classifications).unwrap(),
            serde_json::to_value(characters).unwrap(),
        )
    }

    #[test]
    fn character_folder_order_migration_move_append_and_restart() {
        let f = Fixture::new();
        let path = f.temp.path().join("library.sqlite");
        let z = f.target("Zulu");
        let a = f.target("alpha");
        // Reconstruct v102 (undo 0103 and 0104), using only the temporary fixture.
        f.library
            .connection()
            .unwrap()
            .execute_batch(&format!(
                "{}\n PRAGMA user_version=102;",
                db::UNDO_AFTER_102
            ))
            .unwrap();
        let before: Vec<String> = f
            .library
            .connection()
            .unwrap()
            .prepare("SELECT id FROM character_targets ORDER BY display_name COLLATE NOCASE,id")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<std::result::Result<_, _>>()
            .unwrap();
        drop(db::initialize_database(&path).unwrap());
        assert_eq!(ids(&f.library), before);
        assert!(f
            .library
            .list_character_targets()
            .unwrap()
            .iter()
            .all(|t| t.folder_order.is_none()));
        let new = f.target("A new character");
        assert_eq!(
            ids(&f.library),
            [a.id.clone(), z.id.clone(), new.id.clone()]
        );
        let publication_before = publication(&f.library);
        f.library
            .move_character_folder(&f.series, &z.id, None, -1)
            .unwrap();
        assert_eq!(
            ids(&f.library),
            [z.id.clone(), a.id.clone(), new.id.clone()]
        );
        f.library
            .move_character_folder(&f.series, &z.id, None, -1)
            .unwrap();
        f.library
            .move_character_folder(&f.series, &new.id, None, 1)
            .unwrap();
        assert_eq!(
            ids(&f.library),
            [z.id.clone(), a.id.clone(), new.id.clone()]
        );
        f.library
            .move_character_folder(&f.series, &a.id, None, 1)
            .unwrap();
        assert_eq!(publication(&f.library), publication_before);
        let late = f.target("0 appended after manual ordering");
        let expected = vec![z.id.clone(), new.id.clone(), a.id.clone(), late.id];
        assert_eq!(ids(&f.library), expected);
        let after = f.library.get_character_target(&z.id).unwrap();
        assert_eq!(after.revision, z.revision);
        assert_eq!(after.fingerprint, z.fingerprint);
        assert!(f
            .library
            .list_character_targets()
            .unwrap()
            .iter()
            .all(|t| t.folder_order.is_some()));
        drop(f.library);
        let reopened = Library::open(f.temp.path()).unwrap();
        assert_eq!(ids(&reopened), expected);
        let c = reopened.connection().unwrap();
        assert_eq!(
            c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            db::SCHEMA_VERSION
        );
        assert!(!c
            .prepare("PRAGMA foreign_key_check")
            .unwrap()
            .exists([])
            .unwrap());
        assert_eq!(
            c.query_row("PRAGMA quick_check", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "ok"
        );
    }

    #[test]
    fn character_folder_order_group_scope_and_stale_requests() {
        let f = Fixture::new();
        let a = f.target("A");
        let b = f.target("B");
        let c = f.target("C");
        let db = db::open_database(&f.temp.path().join("library.sqlite")).unwrap();
        db.execute(
            "INSERT INTO character_groups(id,series_id,name) VALUES('g',?1,'Group')",
            [&f.series],
        )
        .unwrap();
        for id in [&a.id, &c.id] {
            db.execute(
                "INSERT INTO character_group_members(target_id,group_id) VALUES(?1,'g')",
                [id],
            )
            .unwrap();
        }
        assert!(f
            .library
            .move_character_folder(&f.series, &c.id, None, -1)
            .is_err());
        assert!(f
            .library
            .move_character_folder(&f.outside, &c.id, Some("g"), -1)
            .is_err());
        assert!(f
            .library
            .move_character_folder(&f.series, &c.id, Some("g"), 0)
            .is_err());
        assert_eq!(ids(&f.library), [a.id.clone(), b.id.clone(), c.id.clone()]);
        f.library
            .move_character_folder(&f.series, &c.id, Some("g"), -1)
            .unwrap();
        assert_eq!(ids(&f.library), [c.id.clone(), b.id.clone(), a.id.clone()]);
        f.library
            .move_character_folder(&f.series, &b.id, None, -1)
            .unwrap();
        assert_eq!(ids(&f.library), [c.id.clone(), b.id.clone(), a.id.clone()]);
        // Membership changes do not reset the series order.
        db.execute("DELETE FROM character_group_members", [])
            .unwrap();
        assert_eq!(ids(&f.library), [c.id, b.id, a.id]);
    }

    #[test]
    fn character_folder_order_relocation_appends_and_delete_cleans_up() {
        let f = Fixture::new();
        let a = f.target("A");
        let b = f.target("B");
        let db = db::open_database(&f.temp.path().join("library.sqlite")).unwrap();
        db.execute(
            "UPDATE character_targets SET series_classification_id=?2 WHERE id=?1",
            params![a.id, f.outside],
        )
        .unwrap();
        db.execute(
            "UPDATE character_targets SET series_classification_id=?2 WHERE id=?1",
            params![a.id, f.series],
        )
        .unwrap();
        assert_eq!(ids(&f.library), [b.id.clone(), a.id.clone()]);
        db.execute("DELETE FROM character_targets WHERE id=?1", [&a.id])
            .unwrap();
        assert_eq!(ids(&f.library), [b.id]);
        assert!(!db
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM character_folder_order WHERE target_id=?1)",
                [&a.id],
                |r| r.get::<_, bool>(0)
            )
            .unwrap());
    }
}
