//! Canonical catalog content publication boundary.
use rusqlite::{types::Value, Connection, OptionalExtension};

use super::error::LibraryError;

const REVISION_KEY: &str = "lakomics.catalog.contentRevision";

pub(crate) fn content_revision(connection: &Connection) -> Result<String, LibraryError> {
    Ok(connection
        .query_row(
            "SELECT Value FROM CrawlState WHERE Key=?1",
            [REVISION_KEY],
            |row| row.get(0),
        )
        .optional()?
        .unwrap_or_else(|| "legacy".to_owned()))
}

/// Establish a durable source identity at an authorized publication/setup boundary.
/// Reads intentionally do not call this function because initialization is a write.
pub(crate) fn initialize_content_revision(connection: &Connection) -> Result<String, LibraryError> {
    let candidate = uuid::Uuid::new_v4().to_string();
    connection.execute(
        "INSERT INTO CrawlState(Key,Value) VALUES(?1,?2)
         ON CONFLICT(Key) DO UPDATE SET Value=excluded.Value
         WHERE CrawlState.Value='legacy'",
        rusqlite::params![REVISION_KEY, candidate],
    )?;
    content_revision(connection)
}

/// The caller owns the transaction, including publication/import staging.
pub(crate) fn mark_catalog_changed(connection: &Connection) -> Result<(), LibraryError> {
    connection.execute(
        "INSERT INTO CrawlState(Key,Value) VALUES(?1,?2) ON CONFLICT(Key) DO UPDATE SET Value=excluded.Value",
        rusqlite::params![REVISION_KEY, uuid::Uuid::new_v4().to_string()],
    )?;
    Ok(())
}

#[derive(PartialEq)]
pub(super) struct WorkContent {
    fields: Vec<Value>,
    tags: Vec<(String, String)>,
}

/// Compare canonical storage values, excluding transport JSON and crawl time.
pub(super) fn read_work_content(
    connection: &Connection,
    id: i64,
) -> Result<Option<WorkContent>, LibraryError> {
    let fields = connection
        .query_row(
            "SELECT Token,Title,TitleJpn,Category,Uploader,Posted,Updated,FileCount,FileSize,
         Rating,Views,Thumb,ThumbExtension,Expunged,Blocked,Archived,TorrentCount,
         ParentGid,ParentKey,CurrentGid,CurrentKey,FirstGid,FirstKey FROM Works WHERE Id=?1",
            [id],
            |row| {
                (0..row.as_ref().column_count())
                    .map(|index| row.get(index))
                    .collect::<rusqlite::Result<Vec<Value>>>()
            },
        )
        .optional()?;
    let Some(fields) = fields else {
        return Ok(None);
    };
    let mut statement = connection
        .prepare("SELECT Namespace,Value FROM Tags WHERE WorkId=?1 ORDER BY Namespace,Value")?;
    let tags = statement
        .query_map([id], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(Some(WorkContent { fields, tags }))
}
