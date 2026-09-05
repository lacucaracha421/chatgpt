//! Checkpoints live beside their canonical catalog data, not in user metadata.
use std::path::Path;

use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde::{Deserialize, Serialize};

use super::{
    catalog_provider::CatalogProvider,
    error::LibraryError,
    models::{CatalogLanguage, CatalogStreamStatus},
};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub(super) struct Checkpoint {
    pub watermark: u64,
    pub cursor: Option<u64>,
    pub pending_max: u64,
    pub initial_complete: bool,
}

#[derive(Default, Serialize, Deserialize)]
pub(super) struct RunStatus {
    pub last_attempt_at: Option<String>,
    pub last_progress_at: Option<String>,
    pub last_completed_at: Option<String>,
    pub last_added: u64,
    pub last_error: Option<String>,
}

fn key(language: CatalogLanguage, kind: &str) -> String {
    format!(
        "lakomics.catalog.{}.{}.{kind}",
        CatalogProvider::KHentai.as_str(),
        language.as_tag()
    )
}

fn value(connection: &Connection, key: &str) -> Result<Option<String>, LibraryError> {
    Ok(connection
        .query_row("SELECT Value FROM CrawlState WHERE Key=?1", [key], |row| {
            row.get(0)
        })
        .optional()?)
}

pub(super) fn persisted(
    connection: &Connection,
    language: CatalogLanguage,
) -> Result<Option<Checkpoint>, LibraryError> {
    value(connection, &key(language, "checkpoint"))?
        .map(|value| {
            let checkpoint: Checkpoint =
                serde_json::from_str(&value).map_err(|_| LibraryError::InvalidOnlineCatalog)?;
            if checkpoint.watermark > i64::MAX as u64
                || checkpoint.pending_max > i64::MAX as u64
                || checkpoint.pending_max < checkpoint.watermark
                || checkpoint
                    .cursor
                    .is_some_and(|cursor| cursor == 0 || cursor > i64::MAX as u64)
                || (!checkpoint.initial_complete && checkpoint.watermark != 0)
            {
                return Err(LibraryError::InvalidOnlineCatalog);
            }
            Ok(checkpoint)
        })
        .transpose()
}

pub(super) fn load(
    connection: &Connection,
    language: CatalogLanguage,
) -> Result<Checkpoint, LibraryError> {
    if let Some(checkpoint) = persisted(connection, language)? {
        return Ok(checkpoint);
    }
    if language == CatalogLanguage::Japanese {
        return Ok(Checkpoint {
            watermark: 0,
            cursor: None,
            pending_max: 0,
            initial_complete: false,
        });
    }
    // Only the Korean stream may adopt the old unqualified Lakomics keys.
    // A language-qualified baseline also remains safe after targeted imports.
    let korean_max = connection
        .query_row(
            "SELECT COALESCE(MAX(work.Id),0) FROM Works AS work WHERE EXISTS
         (SELECT 1 FROM Tags WHERE WorkId=work.Id AND Namespace='language' AND Value='korean')",
            [],
            |row| row.get::<_, i64>(0),
        )?
        .max(0) as u64;
    let legacy_watermark = value(connection, "lakomics_update_watermark")?;
    let legacy_cursor = value(connection, "lakomics_update_cursor")?;
    match (legacy_watermark, legacy_cursor) {
        (Some(watermark), Some(cursor)) => {
            let watermark = watermark
                .parse::<u64>()
                .map_err(|_| LibraryError::InvalidOnlineCatalog)?;
            let cursor = cursor
                .parse::<u64>()
                .map_err(|_| LibraryError::InvalidOnlineCatalog)?;
            if watermark > i64::MAX as u64 || cursor == 0 || cursor > i64::MAX as u64 {
                return Err(LibraryError::InvalidOnlineCatalog);
            }
            Ok(Checkpoint {
                watermark,
                cursor: Some(cursor),
                pending_max: korean_max.max(watermark),
                initial_complete: true,
            })
        }
        (None, None) => Ok(Checkpoint {
            watermark: korean_max,
            cursor: None,
            pending_max: korean_max,
            initial_complete: true,
        }),
        _ => Err(LibraryError::InvalidOnlineCatalog),
    }
}

fn put<T: Serialize>(connection: &Connection, key: &str, value: &T) -> Result<(), LibraryError> {
    let json = serde_json::to_string(value).map_err(|_| LibraryError::InvalidOnlineCatalog)?;
    connection.execute("INSERT INTO CrawlState(Key,Value) VALUES(?1,?2) ON CONFLICT(Key) DO UPDATE SET Value=excluded.Value", params![key, json])?;
    Ok(())
}

pub(super) fn save(
    connection: &Connection,
    language: CatalogLanguage,
    checkpoint: &Checkpoint,
) -> Result<(), LibraryError> {
    put(connection, &key(language, "checkpoint"), checkpoint)
}

pub(super) fn run_status(
    connection: &Connection,
    language: CatalogLanguage,
) -> Result<RunStatus, LibraryError> {
    match value(connection, &key(language, "status"))? {
        Some(value) => serde_json::from_str(&value).map_err(|_| LibraryError::InvalidOnlineCatalog),
        None => Ok(RunStatus::default()),
    }
}

pub(super) fn save_status(
    connection: &Connection,
    language: CatalogLanguage,
    status: &RunStatus,
) -> Result<(), LibraryError> {
    put(connection, &key(language, "status"), status)
}

pub(super) fn start(
    path: &Path,
    language: CatalogLanguage,
    at: &str,
) -> Result<Checkpoint, LibraryError> {
    let mut connection = Connection::open(path)?;
    let transaction = connection.transaction()?;
    // Freeze the Korean baseline before Japanese records can affect the DB.
    if value(&transaction, &key(CatalogLanguage::Korean, "checkpoint"))?.is_none() {
        let korean = load(&transaction, CatalogLanguage::Korean)?;
        save(&transaction, CatalogLanguage::Korean, &korean)?;
    }
    let checkpoint = load(&transaction, language)?;
    save(&transaction, language, &checkpoint)?;
    let mut status = run_status(&transaction, language)?;
    status.last_attempt_at = Some(at.into());
    status.last_error = None;
    status.last_added = 0;
    save_status(&transaction, language, &status)?;
    transaction.commit()?;
    Ok(checkpoint)
}

pub(super) fn record_error(
    path: &Path,
    language: CatalogLanguage,
    error: &str,
) -> Result<(), LibraryError> {
    let mut connection = Connection::open(path)?;
    let transaction = connection.transaction()?;
    let mut status = run_status(&transaction, language)?;
    status.last_error = Some(error.into());
    save_status(&transaction, language, &status)?;
    transaction.commit()?;
    Ok(())
}

pub(crate) fn statuses(path: &Path) -> Result<Vec<CatalogStreamStatus>, LibraryError> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    Ok([CatalogLanguage::Korean, CatalogLanguage::Japanese]
        .into_iter()
        .map(|language| {
            stream_status(&connection, language).unwrap_or_else(|_| CatalogStreamStatus {
                provider: CatalogProvider::KHentai,
                language,
                has_state: true,
                initial_complete: false,
                watermark: 0,
                cursor: None,
                pending_max: 0,
                last_attempt_at: None,
                last_progress_at: None,
                last_completed_at: None,
                last_added: 0,
                last_error: Some(
                    "수집 상태를 읽지 못했습니다. 해당 언어의 체크포인트를 확인해 주세요".into(),
                ),
            })
        })
        .collect())
}

fn stream_status(
    connection: &Connection,
    language: CatalogLanguage,
) -> Result<CatalogStreamStatus, LibraryError> {
    let has_state =
        persisted(&connection, language)?.is_some() || language == CatalogLanguage::Korean;
    let checkpoint = load(&connection, language)?;
    let status = run_status(&connection, language)?;
    Ok(CatalogStreamStatus {
        provider: CatalogProvider::KHentai,
        language,
        has_state,
        initial_complete: checkpoint.initial_complete,
        watermark: checkpoint.watermark,
        cursor: checkpoint.cursor,
        pending_max: checkpoint.pending_max,
        last_attempt_at: status.last_attempt_at,
        last_progress_at: status.last_progress_at,
        last_completed_at: status.last_completed_at,
        last_added: status.last_added,
        last_error: status.last_error,
    })
}

pub(crate) fn reset_japanese(path: &Path) -> Result<(), LibraryError> {
    if !path.exists() {
        return Err(LibraryError::OnlineCatalogNotInstalled);
    }
    let mut connection = Connection::open(path)?;
    let transaction = connection.transaction()?;
    transaction.execute(
        "DELETE FROM CrawlState WHERE Key IN (?1,?2)",
        params![
            key(CatalogLanguage::Japanese, "checkpoint"),
            key(CatalogLanguage::Japanese, "status")
        ],
    )?;
    transaction.commit()?;
    Ok(())
}
