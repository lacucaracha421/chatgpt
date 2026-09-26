use std::collections::BTreeSet;

use rusqlite::{params, Connection, Transaction};

use super::{
    album_authority,
    error::LibraryError,
    folder_appearance,
    models::{AlbumEntry, AssetAlbumPatch, CreateAlbum},
    validated_asset_ids, Library,
};

/// Enqueue the authoritative intent for an accepted local Album mutation.
///
/// Called after the local row is written, inside the same transaction, so a crash
/// can never leave a changed Album with no queued intent nor an intent for an Album
/// that never changed. When no authority is adopted this appends nothing and the
/// legacy PC-owned path is byte-identical to before.
fn enqueue_structural(
    transaction: &Transaction<'_>,
    command_type: &str,
    album_id: &str,
    fields: serde_json::Map<String, serde_json::Value>,
) -> Result<(), LibraryError> {
    let mut fields = fields;
    if command_type != album_authority::CREATE {
        // Only a create introduces the Album, so only a create has no prior revision
        // to compare against. Every other structural command is a compare-and-set.
        let expected = album_authority::predicted_album_revision(transaction, album_id)?;
        fields.insert("expectedRevision".into(), expected.into());
    }
    Library::enqueue_album_intent(transaction, command_type, album_id, fields)
}

/// Album rows with their normal-asset counts. The count subquery uses `CROSS JOIN`, which
/// SQLite documents as a fixed join order: the Album's `asset_albums` rows drive (through
/// `asset_albums_by_album`) and each asset is probed by id. With a plain `JOIN` and no
/// `sqlite_stat1`, the planner walks every normal asset through `assets_by_trash_age` and
/// probes the membership primary key once per asset, for every Album (measured on the real
/// library: 3 Albums x 9,147 assets, 137 k VM steps). The gate is
/// `album_lists_vm_steps_stay_proportional_to_memberships`.
const LIST_ALBUMS_SQL: &str = "SELECT id, name, parent_id, icon_key, color_key,
        (SELECT COUNT(*) FROM asset_albums AS count_link
         CROSS JOIN assets AS count_asset ON count_asset.id = count_link.asset_id
         WHERE count_link.album_id = albums.id
           AND count_asset.status = 'normal') AS asset_count
     FROM albums
     ORDER BY parent_id, name COLLATE NOCASE, id";

/// The Albums one asset belongs to, with the same count subquery as [`LIST_ALBUMS_SQL`].
const ASSET_ALBUMS_SQL: &str =
    "SELECT album.id, album.name, album.parent_id, album.icon_key, album.color_key,
        (SELECT COUNT(*) FROM asset_albums AS count_link
         CROSS JOIN assets AS count_asset ON count_asset.id = count_link.asset_id
         WHERE count_link.album_id = album.id
           AND count_asset.status = 'normal') AS asset_count
     FROM albums AS album
     JOIN asset_albums AS link ON link.album_id = album.id
     WHERE link.asset_id = ?1
     ORDER BY album.name COLLATE NOCASE, album.id";

impl Library {
    pub fn create_album(&self, request: CreateAlbum) -> Result<AlbumEntry, LibraryError> {
        let name = normalized_name(request.name)?;
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        if let Some(parent_id) = request.parent_id.as_deref() {
            require_album(&transaction, parent_id)?;
        }
        let entry = AlbumEntry {
            id: uuid::Uuid::new_v4().to_string(),
            name,
            parent_id: request.parent_id,
            icon_key: None,
            color_key: None,
            asset_count: 0,
        };
        transaction
            .execute(
                "INSERT INTO albums (id, name, parent_id, icon_key, color_key, created_at)
                 VALUES (?1, ?2, ?3, NULL, NULL, ?4)",
                params![
                    entry.id,
                    entry.name,
                    entry.parent_id,
                    chrono::Utc::now().to_rfc3339(),
                ],
            )
            .map_err(map_duplicate_name)?;
        let mut fields = serde_json::Map::new();
        fields.insert("name".into(), entry.name.clone().into());
        fields.insert(
            "parentId".into(),
            match &entry.parent_id {
                Some(parent_id) => parent_id.clone().into(),
                None => serde_json::Value::Null,
            },
        );
        fields.insert("iconKey".into(), serde_json::Value::Null);
        fields.insert("colorKey".into(), serde_json::Value::Null);
        enqueue_structural(&transaction, album_authority::CREATE, &entry.id, fields)?;
        transaction.commit()?;
        Ok(entry)
    }

    pub fn list_albums(&self) -> Result<Vec<AlbumEntry>, LibraryError> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(LIST_ALBUMS_SQL)?;
        let entries = statement
            .query_map([], album_from_row)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(entries)
    }

    pub fn rename_album(&self, id: &str, name: &str) -> Result<(), LibraryError> {
        let name = normalized_name(name.to_owned())?;
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        let changed = transaction
            .execute(
                "UPDATE albums SET name = ?1 WHERE id = ?2",
                params![name, id],
            )
            .map_err(map_duplicate_name)?;
        if changed == 0 {
            return Err(LibraryError::AlbumNotFound);
        }
        let mut fields = serde_json::Map::new();
        fields.insert("name".into(), name.into());
        enqueue_structural(&transaction, album_authority::RENAME, id, fields)?;
        transaction.commit()?;
        Ok(())
    }

    pub fn move_album(&self, id: &str, parent_id: Option<&str>) -> Result<(), LibraryError> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        require_album(&transaction, id)?;
        if let Some(parent_id) = parent_id {
            require_album(&transaction, parent_id)?;
            let creates_cycle: bool = transaction.query_row(
                "WITH RECURSIVE descendants(id) AS (
                    SELECT id FROM albums WHERE id = ?1
                    UNION ALL
                    SELECT child.id FROM albums AS child
                    JOIN descendants ON child.parent_id = descendants.id
                 )
                 SELECT EXISTS(SELECT 1 FROM descendants WHERE id = ?2)",
                params![id, parent_id],
                |row| row.get(0),
            )?;
            if creates_cycle {
                return Err(LibraryError::AlbumCycle);
            }
        }
        transaction
            .execute(
                "UPDATE albums SET parent_id = ?1 WHERE id = ?2",
                params![parent_id, id],
            )
            .map_err(map_duplicate_name)?;
        let mut fields = serde_json::Map::new();
        fields.insert(
            "parentId".into(),
            match parent_id {
                Some(parent_id) => parent_id.into(),
                None => serde_json::Value::Null,
            },
        );
        enqueue_structural(&transaction, album_authority::MOVE, id, fields)?;
        transaction.commit()?;
        Ok(())
    }

    pub fn delete_album(&self, id: &str) -> Result<(), LibraryError> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        require_album(&transaction, id)?;
        let has_children: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM albums WHERE parent_id = ?1)",
            [id],
            |row| row.get(0),
        )?;
        if has_children {
            return Err(LibraryError::AlbumHasChildren);
        }
        // The local membership rows go with the Album through the declared
        // `ON DELETE CASCADE`; only the queued intent is added here.
        transaction.execute("DELETE FROM albums WHERE id = ?1", [id])?;
        enqueue_structural(
            &transaction,
            album_authority::DELETE,
            id,
            serde_json::Map::new(),
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn update_album_appearance(
        &self,
        id: &str,
        icon_key: Option<&str>,
        color_key: Option<&str>,
    ) -> Result<(), LibraryError> {
        if !folder_appearance::validate(icon_key, color_key) {
            return Err(LibraryError::InvalidAlbumAppearance);
        }
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        let changed = transaction.execute(
            "UPDATE albums SET icon_key = ?1, color_key = ?2 WHERE id = ?3",
            params![icon_key, color_key, id],
        )?;
        if changed == 0 {
            return Err(LibraryError::AlbumNotFound);
        }
        let mut fields = serde_json::Map::new();
        fields.insert(
            "iconKey".into(),
            match icon_key {
                Some(icon_key) => icon_key.into(),
                None => serde_json::Value::Null,
            },
        );
        fields.insert(
            "colorKey".into(),
            match color_key {
                Some(color_key) => color_key.into(),
                None => serde_json::Value::Null,
            },
        );
        enqueue_structural(&transaction, album_authority::APPEARANCE, id, fields)?;
        transaction.commit()?;
        Ok(())
    }

    pub fn patch_asset_albums(&self, patch: AssetAlbumPatch) -> Result<(), LibraryError> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        let asset_ids = validated_asset_ids(&transaction, &patch.asset_ids)?;
        let add_ids: BTreeSet<_> = patch.add_album_ids.iter().map(String::as_str).collect();
        let remove_ids: BTreeSet<_> = patch.remove_album_ids.iter().map(String::as_str).collect();
        for album_id in add_ids.iter().chain(remove_ids.iter()) {
            require_album(&transaction, album_id)?;
        }
        for asset_id in &asset_ids {
            for album_id in &remove_ids {
                // Each accepted relation change becomes its own intent. A patch is not
                // one command: the server's membership contract is per relation, and
                // collapsing the loops would make one queued payload describe several
                // relations it could not atomically compare-and-set.
                let removed = transaction.execute(
                    "DELETE FROM asset_albums WHERE asset_id = ?1 AND album_id = ?2",
                    params![asset_id, album_id],
                )? > 0;
                if removed {
                    Library::enqueue_album_membership_intent(
                        &transaction,
                        album_id,
                        asset_id,
                        false,
                    )?;
                }
            }
            for album_id in &add_ids {
                let inserted = transaction.execute(
                    "INSERT OR IGNORE INTO asset_albums (asset_id, album_id) VALUES (?1, ?2)",
                    params![asset_id, album_id],
                )? > 0;
                if inserted {
                    Library::enqueue_album_membership_intent(
                        &transaction,
                        album_id,
                        asset_id,
                        true,
                    )?;
                }
            }
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn get_asset_albums(&self, asset_id: &str) -> Result<Vec<AlbumEntry>, LibraryError> {
        let connection = self.connection()?;
        validated_asset_ids(&connection, &[asset_id.to_owned()])?;
        let mut statement = connection.prepare(ASSET_ALBUMS_SQL)?;
        let entries = statement
            .query_map([asset_id], album_from_row)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(entries)
    }
}

fn normalized_name(name: String) -> Result<String, LibraryError> {
    let name = name.trim().to_owned();
    if name.is_empty() {
        return Err(LibraryError::EmptyAlbumName);
    }
    Ok(name)
}

fn require_album(connection: &Connection, id: &str) -> Result<(), LibraryError> {
    let exists: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM albums WHERE id = ?1)",
        [id],
        |row| row.get(0),
    )?;
    if exists {
        Ok(())
    } else {
        Err(LibraryError::AlbumNotFound)
    }
}

fn album_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<AlbumEntry> {
    Ok(AlbumEntry {
        id: row.get(0)?,
        name: row.get(1)?,
        parent_id: row.get(2)?,
        icon_key: row.get(3)?,
        color_key: row.get(4)?,
        asset_count: u64::try_from(row.get::<_, i64>(5)?).unwrap_or(0),
    })
}

fn map_duplicate_name(error: rusqlite::Error) -> LibraryError {
    match error {
        rusqlite::Error::SqliteFailure(error, _)
            if error.code == rusqlite::ErrorCode::ConstraintViolation =>
        {
            LibraryError::DuplicateAlbumName
        }
        error => error.into(),
    }
}

#[cfg(test)]
mod tests {
    use crate::library::{
        error::LibraryError,
        models::{AlbumEntry, AssetAlbumPatch, CreateAlbum},
        Library,
    };

    #[test]
    fn creates_lists_and_renames_nested_albums() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let root = library
            .create_album(CreateAlbum {
                name: "표지".into(),
                parent_id: None,
            })
            .unwrap();
        let child = library
            .create_album(CreateAlbum {
                name: "게임 표지".into(),
                parent_id: Some(root.id.clone()),
            })
            .unwrap();

        library.rename_album(&child.id, "  대표 표지  ").unwrap();

        assert_eq!(
            library.list_albums().unwrap(),
            vec![
                root,
                AlbumEntry {
                    id: child.id,
                    name: "대표 표지".into(),
                    parent_id: Some(child.parent_id.unwrap()),
                    icon_key: None,
                    color_key: None,
                    asset_count: 0,
                },
            ]
        );
    }

    #[test]
    fn moves_an_album_but_rejects_self_and_descendant_cycles() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let root = library
            .create_album(CreateAlbum {
                name: "표지".into(),
                parent_id: None,
            })
            .unwrap();
        let child = library
            .create_album(CreateAlbum {
                name: "게임 표지".into(),
                parent_id: Some(root.id.clone()),
            })
            .unwrap();
        let other_root = library
            .create_album(CreateAlbum {
                name: "참고".into(),
                parent_id: None,
            })
            .unwrap();

        library.move_album(&child.id, Some(&other_root.id)).unwrap();
        assert_eq!(
            library
                .list_albums()
                .unwrap()
                .into_iter()
                .find(|entry| entry.id == child.id)
                .unwrap()
                .parent_id,
            Some(other_root.id.clone())
        );

        assert!(matches!(
            library.move_album(&other_root.id, Some(&child.id)),
            Err(LibraryError::AlbumCycle)
        ));
        assert!(matches!(
            library.move_album(&other_root.id, Some(&other_root.id)),
            Err(LibraryError::AlbumCycle)
        ));
        assert_eq!(
            library
                .list_albums()
                .unwrap()
                .into_iter()
                .find(|entry| entry.id == other_root.id)
                .unwrap()
                .parent_id,
            None
        );
    }

    #[test]
    fn blocks_delete_with_children_and_deletes_a_leaf() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let root = library
            .create_album(CreateAlbum {
                name: "표지".into(),
                parent_id: None,
            })
            .unwrap();
        let child = library
            .create_album(CreateAlbum {
                name: "게임 표지".into(),
                parent_id: Some(root.id.clone()),
            })
            .unwrap();

        assert!(matches!(
            library.delete_album(&root.id),
            Err(LibraryError::AlbumHasChildren)
        ));
        library.delete_album(&child.id).unwrap();

        assert_eq!(library.list_albums().unwrap(), vec![root]);
    }

    #[test]
    fn album_appearance_uses_the_shared_catalog_and_rejects_unknown_keys() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let album = library
            .create_album(CreateAlbum {
                name: "표지".into(),
                parent_id: None,
            })
            .unwrap();

        library
            .update_album_appearance(&album.id, Some("photo"), Some("pink"))
            .unwrap();
        let changed = library.list_albums().unwrap().pop().unwrap();
        assert_eq!(changed.icon_key.as_deref(), Some("photo"));
        assert_eq!(changed.color_key.as_deref(), Some("pink"));

        assert!(matches!(
            library.update_album_appearance(&album.id, Some("uploaded-svg"), Some("#ffffff")),
            Err(LibraryError::InvalidAlbumAppearance)
        ));
        let unchanged = library.list_albums().unwrap().pop().unwrap();
        assert_eq!(unchanged.icon_key.as_deref(), Some("photo"));
        assert_eq!(unchanged.color_key.as_deref(), Some("pink"));
    }

    #[test]
    fn rejects_duplicate_sibling_names_case_insensitively() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        library
            .create_album(CreateAlbum {
                name: "Covers".into(),
                parent_id: None,
            })
            .unwrap();

        assert!(matches!(
            library.create_album(CreateAlbum {
                name: "covers".into(),
                parent_id: None,
            }),
            Err(LibraryError::DuplicateAlbumName)
        ));
        assert_eq!(library.list_albums().unwrap().len(), 1);
    }

    #[test]
    fn one_asset_can_join_multiple_albums_without_new_asset_rows() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        insert_asset(&library, "asset-1");
        let first = library
            .create_album(CreateAlbum {
                name: "표지".into(),
                parent_id: None,
            })
            .unwrap();
        let second = library
            .create_album(CreateAlbum {
                name: "참고".into(),
                parent_id: None,
            })
            .unwrap();

        library
            .patch_asset_albums(AssetAlbumPatch {
                asset_ids: vec!["asset-1".into()],
                add_album_ids: vec![first.id.clone(), second.id.clone()],
                remove_album_ids: Vec::new(),
            })
            .unwrap();

        let album_ids = library
            .get_asset_albums("asset-1")
            .unwrap()
            .into_iter()
            .map(|entry| entry.id)
            .collect::<Vec<_>>();
        assert_eq!(album_ids.clone(), vec![second.id.clone(), first.id.clone()]);
        let counts = library
            .list_albums()
            .unwrap()
            .into_iter()
            .map(|entry| (entry.id, entry.asset_count))
            .collect::<Vec<_>>();
        assert_eq!(counts, vec![(second.id, 1), (first.id, 1)]);
        assert_eq!(
            library
                .connection()
                .unwrap()
                .query_row("SELECT COUNT(*) FROM assets", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }

    /// PERF-ALL-001 tighten-only gate. The Album list (and one asset's Albums) must cost VM
    /// steps in proportion to memberships, not Albums x assets. The planner-chosen plain-`JOIN`
    /// form (the queries before the fix) runs on the same fixture to prove identical rows and
    /// that the thresholds catch the regression. Lower a `MAX_*` after a verified
    /// improvement; raise it only with a justified, measured reason.
    #[test]
    fn album_lists_vm_steps_stay_proportional_to_memberships() {
        const ASSETS: usize = 2_000;
        const ALBUMS: usize = 16;
        const LINKS_PER_ALBUM: usize = 25;
        const SHARED_ASSET: &str = "asset-00001";
        // Measured on this fixture (bundled SQLite of rusqlite 0.40): list fixed 2,813,
        // plain-`JOIN` plan 137,733; one asset's Albums fixed 2,899, plain-`JOIN` plan 103,543.
        const MAX_LIST_VM_STEPS: i32 = 3_200;
        const MAX_ASSET_VM_STEPS: i32 = 3_200;

        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        // Four roots with three children each: nesting, NOCASE name order and NULL parents.
        let mut albums = Vec::new();
        for root in 0..ALBUMS / 4 {
            let parent = library
                .create_album(CreateAlbum {
                    name: format!("{} root {root}", if root % 2 == 0 { "a" } else { "B" }),
                    parent_id: None,
                })
                .unwrap();
            for child in 0..3 {
                albums.push(
                    library
                        .create_album(CreateAlbum {
                            name: format!("Child {}", 3 - child),
                            parent_id: Some(parent.id.clone()),
                        })
                        .unwrap(),
                );
            }
            albums.push(parent);
        }
        {
            let mut connection = library.connection().unwrap();
            let transaction = connection.transaction().unwrap();
            {
                let mut asset = transaction
                    .prepare(
                        "INSERT INTO assets (
                            id, content_hash, media_kind, original_name, relative_path,
                            thumbnail_relative_path, byte_size, width, height, collected_at,
                            status
                         ) VALUES (?1, 'hash-' || ?1, 'image', ?1 || '.png',
                            'assets/' || ?1 || '.png', 'thumbnails/' || ?1 || '.webp',
                            1, 1, 1, '2026-08-16T00:00:00Z', ?2)",
                    )
                    .unwrap();
                for index in 0..ASSETS {
                    let status = if index % 7 == 3 { "trash" } else { "normal" };
                    asset
                        .execute(rusqlite::params![format!("asset-{index:05}"), status])
                        .unwrap();
                }
                let mut link = transaction
                    .prepare(
                        "INSERT OR IGNORE INTO asset_albums (asset_id, album_id)
                         VALUES (?1, ?2)",
                    )
                    .unwrap();
                for (position, album) in albums.iter().enumerate() {
                    // Every fourth Album stays empty; the others share some assets (including
                    // trashed ones, which must not be counted).
                    if position % 4 == 0 {
                        continue;
                    }
                    link.execute(rusqlite::params![SHARED_ASSET, album.id])
                        .unwrap();
                    for slot in 0..LINKS_PER_ALBUM {
                        let asset = (position * 31 + slot * 53) % ASSETS;
                        link.execute(rusqlite::params![format!("asset-{asset:05}"), album.id])
                            .unwrap();
                    }
                }
            }
            transaction.commit().unwrap();
        }

        let (list, asset) = {
            let connection = library.connection().unwrap();
            (
                fixed_and_plain_join(&connection, super::LIST_ALBUMS_SQL, None),
                fixed_and_plain_join(&connection, super::ASSET_ALBUMS_SQL, Some(SHARED_ASSET)),
            )
        };
        eprintln!(
            "list_albums VM steps: fixed {}, plain JOIN {}; get_asset_albums VM steps: fixed {}, plain JOIN {}",
            list.fixed_steps, list.plain_steps, asset.fixed_steps, asset.plain_steps
        );

        assert_eq!(list.fixed_rows.len(), ALBUMS);
        assert_eq!(list.fixed_rows, list.plain_rows);
        assert_eq!(asset.fixed_rows.len(), ALBUMS - ALBUMS / 4);
        assert_eq!(asset.fixed_rows, asset.plain_rows);
        let counted = list
            .fixed_rows
            .iter()
            .filter(|row| row[5] != rusqlite::types::Value::Integer(0))
            .count();
        assert_eq!(counted, ALBUMS - ALBUMS / 4);
        // The product calls return the same rows as the gated statements.
        let product = library
            .list_albums()
            .unwrap()
            .into_iter()
            .map(|entry| (entry.id, entry.asset_count as i64))
            .collect::<Vec<_>>();
        let gated = list
            .fixed_rows
            .iter()
            .map(|row| match (&row[0], &row[5]) {
                (rusqlite::types::Value::Text(id), rusqlite::types::Value::Integer(count)) => {
                    (id.clone(), *count)
                }
                other => panic!("unexpected row shape {other:?}"),
            })
            .collect::<Vec<_>>();
        assert_eq!(product, gated);

        assert!(
            list.fixed_steps <= MAX_LIST_VM_STEPS,
            "list_albums VM steps {} exceed the gate {MAX_LIST_VM_STEPS}",
            list.fixed_steps
        );
        assert!(
            list.plain_steps > MAX_LIST_VM_STEPS,
            "the pre-fix list plan ({} VM steps) no longer exceeds the gate",
            list.plain_steps
        );
        assert!(
            asset.fixed_steps <= MAX_ASSET_VM_STEPS,
            "get_asset_albums VM steps {} exceed the gate {MAX_ASSET_VM_STEPS}",
            asset.fixed_steps
        );
        assert!(
            asset.plain_steps > MAX_ASSET_VM_STEPS,
            "the pre-fix asset-albums plan ({} VM steps) no longer exceeds the gate",
            asset.plain_steps
        );
    }

    /// Real-data equality check for the Album count rewrite. Point `LAKOMICS_ALBUMS_SNAPSHOT_DB`
    /// at the `library.sqlite` of a snapshot copy (for example one kept by
    /// `perf_probe --keep-snapshot`), never at the live library; it is opened read-only.
    #[test]
    #[ignore = "needs LAKOMICS_ALBUMS_SNAPSHOT_DB"]
    fn album_lists_match_plain_join_plan_on_snapshot() {
        let path =
            std::env::var_os("LAKOMICS_ALBUMS_SNAPSHOT_DB").expect("LAKOMICS_ALBUMS_SNAPSHOT_DB");
        let connection =
            rusqlite::Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
                .unwrap();
        let list = fixed_and_plain_join(&connection, super::LIST_ALBUMS_SQL, None);
        eprintln!(
            "list_albums rows {}; VM steps: fixed {}, plain JOIN {}",
            list.fixed_rows.len(),
            list.fixed_steps,
            list.plain_steps
        );
        assert_eq!(list.fixed_rows, list.plain_rows);

        let members = connection
            .prepare("SELECT DISTINCT asset_id FROM asset_albums ORDER BY asset_id")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        let (mut fixed_steps, mut plain_steps) = (0_i64, 0_i64);
        for asset_id in &members {
            let asset = fixed_and_plain_join(&connection, super::ASSET_ALBUMS_SQL, Some(asset_id));
            assert!(!asset.fixed_rows.is_empty());
            assert_eq!(asset.fixed_rows, asset.plain_rows, "asset {asset_id}");
            fixed_steps += i64::from(asset.fixed_steps);
            plain_steps += i64::from(asset.plain_steps);
        }
        eprintln!(
            "get_asset_albums over {} member assets; VM steps: fixed {fixed_steps}, plain JOIN {plain_steps}",
            members.len()
        );
    }

    type Rows = Vec<Vec<rusqlite::types::Value>>;

    struct Compared {
        fixed_rows: Rows,
        fixed_steps: i32,
        plain_rows: Rows,
        plain_steps: i32,
    }

    /// Runs a product Album query and its plain-`JOIN` form (the query before the fix) and
    /// returns every column of every row with each statement's VM steps.
    fn fixed_and_plain_join(
        connection: &rusqlite::Connection,
        fixed_sql: &str,
        asset_id: Option<&str>,
    ) -> Compared {
        assert_eq!(fixed_sql.matches("CROSS JOIN").count(), 1);
        let run = |sql: &str| {
            let mut statement = connection.prepare(sql).unwrap();
            let columns = statement.column_count();
            let params = asset_id.map_or_else(Vec::new, |id| vec![id]);
            let rows = statement
                .query_map(rusqlite::params_from_iter(params), |row| {
                    (0..columns)
                        .map(|index| row.get::<_, rusqlite::types::Value>(index))
                        .collect::<rusqlite::Result<Vec<_>>>()
                })
                .unwrap()
                .collect::<rusqlite::Result<Vec<_>>>()
                .unwrap();
            let steps = statement.get_status(rusqlite::StatementStatus::VmStep);
            (rows, steps)
        };
        let (fixed_rows, fixed_steps) = run(fixed_sql);
        let (plain_rows, plain_steps) = run(&fixed_sql.replace("CROSS JOIN", "JOIN"));
        Compared {
            fixed_rows,
            fixed_steps,
            plain_rows,
            plain_steps,
        }
    }

    fn insert_asset(library: &Library, id: &str) {
        library
            .connection()
            .unwrap()
            .execute(
                "INSERT INTO assets (
                    id, content_hash, media_kind, original_name, relative_path,
                    thumbnail_relative_path, byte_size, width, height, collected_at
                 ) VALUES (?1, ?2, 'image', 'asset.png', ?3, ?4, 1, 1, 1,
                    '2026-08-12T00:00:00Z')",
                rusqlite::params![
                    id,
                    format!("hash-{id}"),
                    format!("assets/{id}.png"),
                    format!("thumbnails/{id}.webp"),
                ],
            )
            .unwrap();
    }
}
