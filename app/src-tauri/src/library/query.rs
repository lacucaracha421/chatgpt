use rusqlite::params;

use super::{
    error::LibraryError,
    models::{AssetCursor, AssetPage, AssetQuery, AssetSummary},
    Library,
};

impl Library {
    pub fn list_assets(&self, query: AssetQuery) -> Result<AssetPage, LibraryError> {
        if !(1..=200).contains(&query.limit) {
            return Err(LibraryError::InvalidAssetPageLimit);
        }

        let connection = self.connection()?;
        if let Some(classification_id) = query.classification_id.as_deref() {
            let exists: bool = connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM classification_entries WHERE id = ?1)",
                [classification_id],
                |row| row.get(0),
            )?;
            if !exists {
                return Err(LibraryError::ClassificationNotFound);
            }
        }
        let mut statement = connection.prepare(
            "WITH RECURSIVE descendants(id) AS (
                 SELECT ?1 WHERE ?1 IS NOT NULL
                 UNION ALL
                 SELECT entry.id
                 FROM classification_entries AS entry
                 JOIN descendants ON entry.parent_id = descendants.id
             )
             SELECT asset.id, asset.title, asset.original_name, asset.relative_path,
                    asset.thumbnail_relative_path, asset.byte_size, asset.width,
                    asset.height, asset.collected_at, asset.favorite
             FROM assets AS asset
             WHERE asset.status = 'normal'
               AND (
                   ?1 IS NULL
                   OR EXISTS (
                       SELECT 1
                       FROM asset_classifications AS link
                       WHERE link.asset_id = asset.id
                         AND (
                             (?2 AND link.classification_id = ?1)
                             OR (NOT ?2 AND link.classification_id IN (SELECT id FROM descendants))
                         )
                   )
               )
               AND (
                   ?3 IS NULL
                   OR asset.collected_at < ?3
                   OR (asset.collected_at = ?3 AND asset.id < ?4)
               )
             ORDER BY asset.collected_at DESC, asset.id DESC
             LIMIT ?5",
        )?;
        let mut rows = statement.query(params![
            query.classification_id,
            query.direct_only,
            query.after.as_ref().map(|cursor| &cursor.collected_at),
            query.after.as_ref().map(|cursor| &cursor.id),
            i64::from(query.limit) + 1,
        ])?;
        let mut items = Vec::new();
        while let Some(row) = rows.next()? {
            let byte_size =
                u64::try_from(row.get::<_, i64>(5)?).map_err(|_| rusqlite::Error::InvalidQuery)?;
            items.push(AssetSummary {
                id: row.get(0)?,
                title: row.get(1)?,
                original_name: row.get(2)?,
                relative_path: row.get(3)?,
                thumbnail_relative_path: row.get(4)?,
                byte_size,
                width: row.get(6)?,
                height: row.get(7)?,
                collected_at: row.get(8)?,
                favorite: row.get(9)?,
            });
        }

        let has_more = items.len() > query.limit as usize;
        items.truncate(query.limit as usize);
        let next_cursor = has_more.then(|| {
            let asset = items
                .last()
                .expect("a page with another item has a returned item");
            AssetCursor {
                collected_at: asset.collected_at.clone(),
                id: asset.id.clone(),
            }
        });
        Ok(AssetPage { items, next_cursor })
    }
}

#[cfg(test)]
mod tests {
    use rusqlite::params;

    use crate::library::{
        error::LibraryError,
        models::{AssetQuery, ClassificationKind, CreateClassification},
        Library,
    };

    #[test]
    fn descendant_assets_are_included_unless_direct_only_is_requested() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let root = classification(&library, ClassificationKind::Root, "게임", None);
        let work = classification(
            &library,
            ClassificationKind::Work,
            "블루 아카이브",
            Some(root.id.clone()),
        );
        let tag = classification(&library, ClassificationKind::Tag, "아로나", Some(work.id));
        insert_asset(&library, "asset-1", "2026-07-30T00:00:00Z");
        library
            .set_asset_classifications("asset-1", &[tag.id])
            .unwrap();

        let descendants = library
            .list_assets(AssetQuery {
                classification_id: Some(root.id.clone()),
                direct_only: false,
                after: None,
                limit: 20,
            })
            .unwrap();
        let direct = library
            .list_assets(AssetQuery {
                classification_id: Some(root.id),
                direct_only: true,
                after: None,
                limit: 20,
            })
            .unwrap();

        assert_eq!(
            descendants
                .items
                .iter()
                .map(|asset| asset.id.as_str())
                .collect::<Vec<_>>(),
            ["asset-1"]
        );
        assert!(direct.items.is_empty());
    }

    #[test]
    fn descendant_links_do_not_duplicate_an_asset() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let root = classification(&library, ClassificationKind::Root, "게임", None);
        let work = classification(
            &library,
            ClassificationKind::Work,
            "블루 아카이브",
            Some(root.id.clone()),
        );
        let tag = classification(
            &library,
            ClassificationKind::Tag,
            "아로나",
            Some(work.id.clone()),
        );
        insert_asset(&library, "asset-1", "2026-07-30T00:00:00Z");
        library
            .set_asset_classifications("asset-1", &[work.id, tag.id])
            .unwrap();

        let page = library
            .list_assets(AssetQuery {
                classification_id: Some(root.id),
                direct_only: false,
                after: None,
                limit: 20,
            })
            .unwrap();

        assert_eq!(page.items.len(), 1);
        assert_eq!(page.items[0].id, "asset-1");
    }

    #[test]
    fn keyset_pages_follow_collected_at_and_id_without_overlap() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        insert_asset(&library, "asset-a", "2026-07-30T00:00:00Z");
        insert_asset(&library, "asset-b", "2026-07-31T00:00:00Z");
        insert_asset(&library, "asset-c", "2026-07-30T00:00:00Z");

        let first = library
            .list_assets(AssetQuery {
                classification_id: None,
                direct_only: false,
                after: None,
                limit: 2,
            })
            .unwrap();
        let second = library
            .list_assets(AssetQuery {
                classification_id: None,
                direct_only: false,
                after: first.next_cursor.clone(),
                limit: 2,
            })
            .unwrap();

        assert_eq!(
            first
                .items
                .iter()
                .map(|asset| asset.id.as_str())
                .collect::<Vec<_>>(),
            ["asset-b", "asset-c"]
        );
        let cursor = first.next_cursor.as_ref().unwrap();
        assert_eq!(cursor.collected_at, "2026-07-30T00:00:00Z");
        assert_eq!(cursor.id, "asset-c");
        assert_eq!(
            second
                .items
                .iter()
                .map(|asset| asset.id.as_str())
                .collect::<Vec<_>>(),
            ["asset-a"]
        );
        assert!(second.next_cursor.is_none());
    }

    #[test]
    fn page_limit_must_be_between_one_and_two_hundred() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();

        for limit in [0, 201] {
            let error = library
                .list_assets(AssetQuery {
                    classification_id: None,
                    direct_only: false,
                    after: None,
                    limit,
                })
                .unwrap_err();

            assert!(matches!(error, LibraryError::InvalidAssetPageLimit));
        }
    }

    #[test]
    fn querying_a_missing_classification_returns_the_established_error() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();

        for direct_only in [false, true] {
            let error = library
                .list_assets(AssetQuery {
                    classification_id: Some("missing-classification".into()),
                    direct_only,
                    after: None,
                    limit: 20,
                })
                .unwrap_err();

            assert!(matches!(error, LibraryError::ClassificationNotFound));
        }
    }

    fn classification(
        library: &Library,
        kind: ClassificationKind,
        name: &str,
        parent_id: Option<String>,
    ) -> crate::library::models::ClassificationEntry {
        library
            .create_classification(CreateClassification {
                kind,
                name: name.into(),
                parent_id,
            })
            .unwrap()
    }

    fn insert_asset(library: &Library, id: &str, collected_at: &str) {
        library
            .connection()
            .unwrap()
            .execute(
                "INSERT INTO assets (
                    id, content_hash, media_kind, original_name, relative_path,
                    thumbnail_relative_path, byte_size, width, height, collected_at
                 ) VALUES (?1, ?2, 'image', ?3, ?4, ?5, 1, 400, 200, ?6)",
                params![
                    id,
                    format!("hash-{id}"),
                    format!("{id}.png"),
                    format!("assets/{id}.png"),
                    format!("thumbnails/{id}.webp"),
                    collected_at,
                ],
            )
            .unwrap();
    }
}
