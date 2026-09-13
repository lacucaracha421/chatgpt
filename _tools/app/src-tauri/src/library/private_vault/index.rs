use std::{path::Path, time::Duration};

use rusqlite::{params, Connection, OpenFlags, OptionalExtension};

use crate::library::{
    error::LibraryError,
    models::{
        MediaKindFilter, MediaSummary, PrivateVaultAssetPage, PrivateVaultAssetSummary,
        PrivateVaultQuery, VideoPreparationState,
    },
};

#[derive(Debug, Clone)]
pub(super) struct IndexedVaultAsset {
    pub id: String,
    pub relative_path: String,
    pub media_kind: String,
    pub original_name: String,
    pub title: Option<String>,
    pub byte_size: u64,
    pub modified_ns: i64,
    pub modified_at: String,
    pub width: u32,
    pub height: u32,
    pub duration_ms: Option<u64>,
    pub container: Option<String>,
    pub video_codec: Option<String>,
    pub audio_codec: Option<String>,
    pub thumbnail_relative_path: Option<String>,
    pub custom_thumbnail_relative_path: Option<String>,
    pub playback_relative_path: Option<String>,
    pub scrub_relative_dir: Option<String>,
    pub scrub_frame_count: u32,
    pub scan_error: Option<String>,
}

pub(super) fn initialize_index(path: &Path) -> Result<(), LibraryError> {
    let connection = open_index(path)?;
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS vault_assets(
            id TEXT PRIMARY KEY NOT NULL,
            relative_path TEXT NOT NULL UNIQUE,
            media_kind TEXT NOT NULL CHECK(media_kind IN ('image','gif','video')),
            original_name TEXT NOT NULL,
            title TEXT,
            byte_size INTEGER NOT NULL CHECK(byte_size >= 0),
            modified_ns INTEGER NOT NULL,
            modified_at TEXT NOT NULL,
            width INTEGER NOT NULL CHECK(width > 0),
            height INTEGER NOT NULL CHECK(height > 0),
            duration_ms INTEGER,
            container TEXT,
            video_codec TEXT,
            audio_codec TEXT,
            thumbnail_relative_path TEXT,
            custom_thumbnail_relative_path TEXT,
            playback_relative_path TEXT,
            scrub_relative_dir TEXT,
            scrub_frame_count INTEGER NOT NULL DEFAULT 0 CHECK(scrub_frame_count >= 0),
            scan_error TEXT
        );
        CREATE INDEX IF NOT EXISTS vault_assets_by_modified ON vault_assets(modified_ns DESC, id DESC);"
    )?;
    let columns = table_columns(&connection)?;
    if !columns.iter().any(|column| column == "title") {
        connection.execute("ALTER TABLE vault_assets ADD COLUMN title TEXT", [])?;
    }
    if !columns.iter().any(|column| column == "custom_thumbnail_relative_path") {
        connection.execute("ALTER TABLE vault_assets ADD COLUMN custom_thumbnail_relative_path TEXT", [])?;
    }
    connection.pragma_update(None, "user_version", 2)?;
    Ok(())
}

fn table_columns(connection: &Connection) -> Result<Vec<String>, LibraryError> {
    let mut statement = connection.prepare("PRAGMA table_info(vault_assets)")?;
    let rows = statement.query_map([], |row| row.get::<_, String>(1))?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

fn open_index(path: &Path) -> Result<Connection, LibraryError> {
    let connection = Connection::open(path)?;
    connection.busy_timeout(Duration::from_secs(5))?;
    Ok(connection)
}

fn open_index_readonly(path: &Path) -> Result<Connection, LibraryError> {
    let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    connection.busy_timeout(Duration::from_secs(5))?;
    Ok(connection)
}

pub(super) fn find_by_id(path: &Path, id: &str) -> Result<Option<IndexedVaultAsset>, LibraryError> {
    if !path.is_file() {
        return Ok(None);
    }
    open_index_readonly(path)?.query_row(
        "SELECT id,relative_path,media_kind,original_name,title,byte_size,modified_ns,modified_at,width,height,duration_ms,container,video_codec,audio_codec,thumbnail_relative_path,custom_thumbnail_relative_path,playback_relative_path,scrub_relative_dir,scrub_frame_count,scan_error FROM vault_assets WHERE id=?1 AND scan_error IS NULL",
        [id], row_to_indexed,
    ).optional().map_err(Into::into)
}

pub(super) fn find_by_path(
    path: &Path,
    relative_path: &str,
) -> Result<Option<IndexedVaultAsset>, LibraryError> {
    initialize_index(path)?;
    open_index(path)?.query_row(
        "SELECT id,relative_path,media_kind,original_name,title,byte_size,modified_ns,modified_at,width,height,duration_ms,container,video_codec,audio_codec,thumbnail_relative_path,custom_thumbnail_relative_path,playback_relative_path,scrub_relative_dir,scrub_frame_count,scan_error FROM vault_assets WHERE relative_path=?1",
        [relative_path], row_to_indexed,
    ).optional().map_err(Into::into)
}

pub(super) fn upsert_asset(path: &Path, asset: &IndexedVaultAsset) -> Result<(), LibraryError> {
    initialize_index(path)?;
    open_index(path)?.execute(
        "INSERT INTO vault_assets(id,relative_path,media_kind,original_name,title,byte_size,modified_ns,modified_at,width,height,duration_ms,container,video_codec,audio_codec,thumbnail_relative_path,custom_thumbnail_relative_path,playback_relative_path,scrub_relative_dir,scrub_frame_count,scan_error)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20)
         ON CONFLICT(relative_path) DO UPDATE SET id=excluded.id,media_kind=excluded.media_kind,original_name=excluded.original_name,byte_size=excluded.byte_size,modified_ns=excluded.modified_ns,modified_at=excluded.modified_at,width=excluded.width,height=excluded.height,duration_ms=excluded.duration_ms,container=excluded.container,video_codec=excluded.video_codec,audio_codec=excluded.audio_codec,thumbnail_relative_path=excluded.thumbnail_relative_path,playback_relative_path=excluded.playback_relative_path,scrub_relative_dir=excluded.scrub_relative_dir,scrub_frame_count=excluded.scrub_frame_count,scan_error=excluded.scan_error",
        params![asset.id, asset.relative_path, asset.media_kind, asset.original_name, asset.title, asset.byte_size as i64, asset.modified_ns, asset.modified_at, asset.width as i64, asset.height as i64, asset.duration_ms.map(|v| v as i64), asset.container, asset.video_codec, asset.audio_codec, asset.thumbnail_relative_path, asset.custom_thumbnail_relative_path, asset.playback_relative_path, asset.scrub_relative_dir, asset.scrub_frame_count as i64, asset.scan_error],
    )?;
    Ok(())
}

pub(super) fn set_title(path: &Path, id: &str, title: Option<&str>) -> Result<(), LibraryError> {
    let changed = open_index(path)?.execute("UPDATE vault_assets SET title=?2 WHERE id=?1 AND scan_error IS NULL", params![id, title])?;
    if changed == 0 { return Err(LibraryError::AssetNotFound); }
    Ok(())
}

pub(super) fn set_custom_thumbnail(path: &Path, id: &str, relative_path: Option<&str>) -> Result<(), LibraryError> {
    let changed = open_index(path)?.execute("UPDATE vault_assets SET custom_thumbnail_relative_path=?2 WHERE id=?1 AND media_kind='video' AND scan_error IS NULL", params![id, relative_path])?;
    if changed == 0 { return Err(LibraryError::AssetNotFound); }
    Ok(())
}

pub(super) fn all_assets(path: &Path) -> Result<Vec<IndexedVaultAsset>, LibraryError> {
    initialize_index(path)?;
    let connection = open_index(path)?;
    let mut statement = connection.prepare("SELECT id,relative_path,media_kind,original_name,title,byte_size,modified_ns,modified_at,width,height,duration_ms,container,video_codec,audio_codec,thumbnail_relative_path,custom_thumbnail_relative_path,playback_relative_path,scrub_relative_dir,scrub_frame_count,scan_error FROM vault_assets ORDER BY relative_path")?;
    let rows = statement.query_map([], row_to_indexed)?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

pub(super) fn remove_indexed_asset(path: &Path, id: &str) -> Result<(), LibraryError> {
    open_index(path)?.execute("DELETE FROM vault_assets WHERE id=?1", [id])?;
    Ok(())
}

pub(super) fn asset_count(path: &Path) -> Result<u64, LibraryError> {
    if !path.is_file() {
        return Ok(0);
    }
    let count: i64 = open_index_readonly(path)?.query_row(
        "SELECT COUNT(*) FROM vault_assets WHERE scan_error IS NULL",
        [],
        |row| row.get(0),
    )?;
    Ok(count.max(0) as u64)
}

pub(super) fn list_assets(
    path: &Path,
    query: PrivateVaultQuery,
) -> Result<PrivateVaultAssetPage, LibraryError> {
    if !(1..=200).contains(&query.limit) {
        return Err(LibraryError::InvalidAssetPageLimit);
    }
    let connection = open_index_readonly(path)?;
    let condition = match query.media_kind {
        Some(MediaKindFilter::Images) => " AND media_kind IN ('image','gif')",
        Some(MediaKindFilter::Videos) => " AND media_kind='video'",
        None => "",
    };
    let count_sql =
        format!("SELECT COUNT(*) FROM vault_assets WHERE scan_error IS NULL{condition}");
    let total: i64 = connection.query_row(&count_sql, [], |row| row.get(0))?;
    let sql = format!("SELECT id,title,original_name,byte_size,width,height,modified_at,media_kind,duration_ms,scrub_frame_count FROM vault_assets WHERE scan_error IS NULL{condition} ORDER BY modified_ns DESC,id DESC LIMIT ?1 OFFSET ?2");
    let mut statement = connection.prepare(&sql)?;
    let rows = statement.query_map(params![query.limit as i64, query.offset as i64], |row| {
        let media_kind: String = row.get(7)?;
        let media = match media_kind.as_str() {
            "gif" => MediaSummary::Gif,
            "video" => MediaSummary::Video {
                duration_ms: row.get::<_, Option<i64>>(8)?.unwrap_or_default().max(0) as u64,
                preparation_state: VideoPreparationState::Ready,
                scrub_frame_count: row.get::<_, i64>(9)?.max(0) as u32,
            },
            _ => MediaSummary::Image,
        };
        Ok(PrivateVaultAssetSummary {
            id: row.get(0)?,
            title: row.get(1)?,
            original_name: row.get(2)?,
            byte_size: row.get::<_, i64>(3)?.max(0) as u64,
            width: row.get::<_, i64>(4)?.max(1) as u32,
            height: row.get::<_, i64>(5)?.max(1) as u32,
            modified_at: row.get(6)?,
            media,
        })
    })?;
    let items = rows.collect::<Result<Vec<_>, _>>()?;
    let total_count = total.max(0) as u64;
    let consumed = query.offset.saturating_add(items.len() as u64);
    Ok(PrivateVaultAssetPage {
        items,
        total_count,
        next_offset: (consumed < total_count).then_some(consumed),
    })
}

fn row_to_indexed(row: &rusqlite::Row<'_>) -> rusqlite::Result<IndexedVaultAsset> {
    Ok(IndexedVaultAsset {
        id: row.get(0)?,
        relative_path: row.get(1)?,
        media_kind: row.get(2)?,
        original_name: row.get(3)?,
        title: row.get(4)?,
        byte_size: row.get::<_, i64>(5)?.max(0) as u64,
        modified_ns: row.get(6)?,
        modified_at: row.get(7)?,
        width: row.get::<_, i64>(8)?.max(1) as u32,
        height: row.get::<_, i64>(9)?.max(1) as u32,
        duration_ms: row.get::<_, Option<i64>>(10)?.map(|v| v.max(0) as u64),
        container: row.get(11)?,
        video_codec: row.get(12)?,
        audio_codec: row.get(13)?,
        thumbnail_relative_path: row.get(14)?,
        custom_thumbnail_relative_path: row.get(15)?,
        playback_relative_path: row.get(16)?,
        scrub_relative_dir: row.get(17)?,
        scrub_frame_count: row.get::<_, i64>(18)?.max(0) as u32,
        scan_error: row.get(19)?,
    })
}

#[cfg(test)]
impl IndexedVaultAsset {
    fn fixture(media_kind: &str, name: &str, modified_ns: i64) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            relative_path: name.into(),
            media_kind: media_kind.into(),
            original_name: name.into(),
            title: None,
            byte_size: 10,
            modified_ns,
            modified_at: format!("2026-09-13T00:00:{modified_ns:02}Z"),
            width: 100,
            height: 80,
            duration_ms: (media_kind == "video").then_some(10_000),
            container: (media_kind == "video").then(|| "mp4".into()),
            video_codec: (media_kind == "video").then(|| "h264".into()),
            audio_codec: None,
            thumbnail_relative_path: Some(format!("thumbnails/{name}.webp")),
            custom_thumbnail_relative_path: None,
            playback_relative_path: None,
            scrub_relative_dir: None,
            scrub_frame_count: 0,
            scan_error: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{find_by_id, initialize_index, list_assets, open_index_readonly, set_custom_thumbnail, set_title, upsert_asset, IndexedVaultAsset};
    use crate::library::models::{MediaKindFilter, PrivateVaultQuery};

    #[test]
    fn portable_index_lists_newest_first_and_filters_media_kind() {
        let temp = tempfile::tempdir().unwrap();
        let db = temp.path().join("index.sqlite");
        initialize_index(&db).unwrap();
        upsert_asset(&db, &IndexedVaultAsset::fixture("image", "a.png", 10)).unwrap();
        upsert_asset(&db, &IndexedVaultAsset::fixture("video", "b.mp4", 20)).unwrap();
        let all = list_assets(
            &db,
            PrivateVaultQuery {
                media_kind: None,
                offset: 0,
                limit: 50,
            },
        )
        .unwrap();
        assert_eq!(all.total_count, 2);
        assert_eq!(
            all.items
                .iter()
                .map(|item| item.original_name.as_str())
                .collect::<Vec<_>>(),
            vec!["b.mp4", "a.png"]
        );
        let videos = list_assets(
            &db,
            PrivateVaultQuery {
                media_kind: Some(MediaKindFilter::Videos),
                offset: 0,
                limit: 50,
            },
        )
        .unwrap();
        assert_eq!(videos.total_count, 1);
        assert_eq!(videos.items[0].original_name, "b.mp4");
    }

    #[test]
    fn rescan_upsert_preserves_user_title_and_custom_thumbnail() {
        let temp = tempfile::tempdir().unwrap();
        let db = temp.path().join("index.sqlite");
        initialize_index(&db).unwrap();
        let asset = IndexedVaultAsset::fixture("video", "clip.mp4", 10);
        let id = asset.id.clone();
        upsert_asset(&db, &asset).unwrap();
        set_title(&db, &id, Some("내 영상")).unwrap();
        set_custom_thumbnail(&db, &id, Some("custom-thumbnails/thumb.webp")).unwrap();

        let mut rescanned = asset.clone();
        rescanned.modified_ns = 20;
        rescanned.thumbnail_relative_path = Some("media/new/poster.webp".into());
        upsert_asset(&db, &rescanned).unwrap();

        let stored = find_by_id(&db, &id).unwrap().unwrap();
        assert_eq!(stored.title.as_deref(), Some("내 영상"));
        assert_eq!(stored.custom_thumbnail_relative_path.as_deref(), Some("custom-thumbnails/thumb.webp"));
        let page = list_assets(&db, PrivateVaultQuery { media_kind: None, offset: 0, limit: 50 }).unwrap();
        assert_eq!(page.items[0].title.as_deref(), Some("내 영상"));
    }

    #[test]
    fn portable_index_browsing_uses_a_read_only_connection() {
        let temp = tempfile::tempdir().unwrap();
        let db = temp.path().join("index.sqlite");
        initialize_index(&db).unwrap();
        upsert_asset(&db, &IndexedVaultAsset::fixture("image", "a.png", 10)).unwrap();

        let connection = open_index_readonly(&db).unwrap();
        assert!(connection.execute("DELETE FROM vault_assets", []).is_err());
        let page = list_assets(
            &db,
            PrivateVaultQuery { media_kind: None, offset: 0, limit: 50 },
        ).unwrap();
        assert_eq!(page.items.len(), 1);
    }
}
