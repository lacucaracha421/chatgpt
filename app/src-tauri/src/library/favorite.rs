use rusqlite::params;

#[cfg(test)]
use crate::library::models::{AssetQuery, AssetSort};
use crate::library::{error::LibraryError, Library};

impl Library {
    pub fn set_asset_favorite(&self, asset_id: &str, favorite: bool) -> Result<(), LibraryError> {
        let changed = self.connection()?.execute(
            "UPDATE assets SET favorite = ?2 WHERE id = ?1 AND status = 'normal'",
            params![asset_id, favorite],
        )?;
        if changed == 0 {
            return Err(LibraryError::AssetNotFound);
        }
        Ok(())
    }
}

#[cfg(test)]
#[test]
fn favorite_can_be_toggled_and_filtered() {
    let temp = tempfile::tempdir().unwrap();
    let library = Library::open(temp.path()).unwrap();
    insert_asset(&library, "asset-a", "hash-a", "2026-07-30T00:00:00Z");
    insert_asset(&library, "asset-b", "hash-b", "2026-07-31T00:00:00Z");

    library.set_asset_favorite("asset-a", true).unwrap();
    let page = library
        .list_assets(query(AssetSort::Newest, true, 20))
        .unwrap();

    assert_eq!(ids(&page), ["asset-a"]);
    assert!(page.items[0].favorite);

    library.set_asset_favorite("asset-a", false).unwrap();
    assert!(library
        .list_assets(query(AssetSort::Newest, true, 20))
        .unwrap()
        .items
        .is_empty());
}

#[cfg(test)]
#[test]
fn setting_a_missing_asset_favorite_returns_asset_not_found() {
    let temp = tempfile::tempdir().unwrap();
    let library = Library::open(temp.path()).unwrap();

    let error = library.set_asset_favorite("missing", true).unwrap_err();

    assert!(matches!(error, LibraryError::AssetNotFound));
}

#[cfg(test)]
fn query(sort: AssetSort, favorite_only: bool, limit: u32) -> AssetQuery {
    AssetQuery {
        classification_id: None,
        direct_only: false,
        favorite_only,
        sort,
        random_pivot: None,
        after: None,
        limit,
    }
}

#[cfg(test)]
fn ids(page: &crate::library::models::AssetPage) -> Vec<&str> {
    page.items.iter().map(|asset| asset.id.as_str()).collect()
}

#[cfg(test)]
fn insert_asset(library: &Library, id: &str, content_hash: &str, collected_at: &str) {
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
                content_hash,
                format!("{id}.png"),
                format!("assets/{id}.png"),
                format!("thumbnails/{id}.webp"),
                collected_at,
            ],
        )
        .unwrap();
}
