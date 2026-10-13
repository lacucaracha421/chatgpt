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
        // Display order now rides the read projection used by the tablet picker.
        tx.execute("UPDATE mobile_publication_state SET generation=generation+1,first_dirty=CASE WHEN generation=published_generation THEN unixepoch() ELSE first_dirty END,last_dirty=unixepoch() WHERE kind='characters'", [])?;
        tx.commit()?;
        self.publication_inputs.signal(&[1]);
        Ok(())
    }

    /// Puts one visible band of a series in the given order: the loose characters (`group_id`
    /// `None`) or the members of one group. `target_ids` must be exactly that band's characters,
    /// each once; a band that changed since the list was read (a character joined or left) is
    /// `Stale`. The band keeps the positions it already occupies, so every other band and the
    /// series-wide order stay where they are. Revisions and fingerprints are not touched.
    pub fn reorder_character_folders(
        &self,
        series_id: &str,
        group_id: Option<&str>,
        target_ids: &[String],
    ) -> Result<()> {
        if target_ids.len() > 1000 {
            return Err(Error::Invalid("캐릭터 순서를 확인해 주세요."));
        }
        let mut requested = target_ids.to_vec();
        requested.sort();
        if requested.windows(2).any(|pair| pair[0] == pair[1]) {
            return Err(Error::Invalid("캐릭터 순서를 확인해 주세요."));
        }
        let mut connection = self.connection()?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let band = tx
            .prepare(
                "SELECT t.id,o.position FROM character_targets t
             JOIN character_folder_order o ON o.target_id=t.id
             LEFT JOIN character_group_members gm ON gm.target_id=t.id
             WHERE t.series_classification_id=?1 AND t.role='character' AND gm.group_id IS ?2
             ORDER BY o.position,t.id",
            )?
            .query_map(params![series_id, group_id], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let mut stored = band.iter().map(|(id, _)| id.clone()).collect::<Vec<_>>();
        stored.sort();
        if stored != requested {
            // A character joined, left or moved series since the list was read.
            return Err(Error::Stale);
        }
        let positions = band
            .iter()
            .map(|(_, position)| *position)
            .collect::<Vec<_>>();
        let current = band
            .iter()
            .map(|(id, position)| (id.as_str(), *position))
            .collect::<std::collections::HashMap<_, _>>();
        let mut changed = false;
        for (id, position) in target_ids.iter().zip(positions.iter()) {
            if current[id.as_str()] != *position {
                tx.execute(
                    "UPDATE character_folder_order SET position=?2 WHERE target_id=?1",
                    params![id, position],
                )?;
                changed = true;
            }
        }
        if !changed {
            return Ok(());
        }
        tx.execute(
            "UPDATE character_folder_order SET legacy_sidebar=0 WHERE target_id IN
             (SELECT id FROM character_targets WHERE series_classification_id=?1)",
            [series_id],
        )?;
        // Display order now rides the read projection used by the tablet picker.
        tx.execute("UPDATE mobile_publication_state SET generation=generation+1,first_dirty=CASE WHEN generation=published_generation THEN unixepoch() ELSE first_dirty END,last_dirty=unixepoch() WHERE kind='characters'", [])?;
        tx.commit()?;
        self.publication_inputs.signal(&[1]);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library::{
        characters::{tests::Fixture, Target},
        db,
    };

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
        let publication_after = publication(&f.library);
        assert_eq!(publication_after.0, publication_before.0);
        let scopes = |value: &serde_json::Value| {
            value["scopes"].as_array().unwrap().iter().map(|scope| (
                format!("{}:{}", scope["nodeId"], scope["filter"]), scope["assetIds"].clone()
            )).collect::<std::collections::BTreeMap<_, _>>()
        };
        assert_eq!(scopes(&publication_after.1), scopes(&publication_before.1));
        assert_eq!(publication_after.1["nodes"].as_array().unwrap().iter()
            .filter(|node| node["kind"] == "character")
            .map(|node| node["sourceId"].as_str().unwrap()).collect::<Vec<_>>(),
            [z.id.as_str(), new.id.as_str(), a.id.as_str()]);
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
    fn reorder_character_folders_orders_one_band_and_keeps_the_rest() {
        let f = Fixture::new();
        let a = f.target("A");
        let b = f.target("B");
        let c = f.target("C");
        let d = f.target("D");
        let e = f.target("E");
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
        let ids_of = |list: &[&Target]| list.iter().map(|t| t.id.clone()).collect::<Vec<_>>();
        let before = f.library.get_character_target(&b.id).unwrap();
        // Loose band (B, D, E at positions 2, 4, 5) in a new order; the group keeps its places.
        f.library
            .reorder_character_folders(&f.series, None, &ids_of(&[&e, &b, &d]))
            .unwrap();
        assert_eq!(ids(&f.library), ids_of(&[&a, &e, &c, &b, &d]));
        // The group band (A, C at positions 1, 3), reversed.
        f.library
            .reorder_character_folders(&f.series, Some("g"), &ids_of(&[&c, &a]))
            .unwrap();
        assert_eq!(ids(&f.library), ids_of(&[&c, &e, &a, &b, &d]));
        // Same order again changes nothing and is accepted.
        f.library
            .reorder_character_folders(&f.series, Some("g"), &ids_of(&[&c, &a]))
            .unwrap();
        assert_eq!(ids(&f.library), ids_of(&[&c, &e, &a, &b, &d]));
        // An order is not an edit: revisions and fingerprints stay.
        let after = f.library.get_character_target(&b.id).unwrap();
        assert_eq!(
            (after.revision, after.fingerprint),
            (before.revision, before.fingerprint)
        );
        // Stale or wrong bands are refused and change nothing.
        let stale = |result: Result<()>| matches!(result, Err(Error::Stale));
        assert!(stale(f.library.reorder_character_folders(
            &f.series,
            None,
            &ids_of(&[&e, &b])
        )));
        assert!(stale(f.library.reorder_character_folders(
            &f.series,
            None,
            &ids_of(&[&e, &b, &d, &a])
        )));
        assert!(stale(f.library.reorder_character_folders(
            &f.series,
            Some("g"),
            &ids_of(&[&a, &b])
        )));
        assert!(stale(f.library.reorder_character_folders(
            &f.outside,
            None,
            &ids_of(&[&e, &b, &d])
        )));
        assert!(stale(f.library.reorder_character_folders(
            &f.series,
            Some("missing"),
            &ids_of(&[&a, &c])
        )));
        assert!(matches!(
            f.library
                .reorder_character_folders(&f.series, None, &ids_of(&[&e, &e, &d])),
            Err(Error::Invalid(_))
        ));
        assert_eq!(ids(&f.library), ids_of(&[&c, &e, &a, &b, &d]));
        // Leaving the group makes the character part of the loose band, so the old list is stale.
        db.execute(
            "DELETE FROM character_group_members WHERE target_id=?1",
            [&a.id],
        )
        .unwrap();
        assert!(stale(f.library.reorder_character_folders(
            &f.series,
            None,
            &ids_of(&[&e, &b, &d])
        )));
        f.library
            .reorder_character_folders(&f.series, None, &ids_of(&[&d, &a, &b, &e]))
            .unwrap();
        assert_eq!(ids(&f.library), ids_of(&[&c, &d, &a, &b, &e]));
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
