//! Test-only writer for the old plaintext vault index (`.lakomics/index.sqlite`, LONG-003).
//! The app reads that format only as an import source (`encrypted_runtime::read_legacy_index`);
//! these helpers build fixtures for that reader.

use std::{path::Path, time::Duration};

use rusqlite::{params, Connection};

use crate::library::error::LibraryError;

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
