use std::{
    fs,
    path::{Path, PathBuf},
};

use chrono::{DateTime, Duration, FixedOffset, Utc};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

use super::{
    error::LibraryError,
    models::{AssetCursor, AssetSummary, PurgeSummary, TrashAssetSummary, TrashPage},
    Library,
};

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct TrashCursor {
    trashed_at: String,
    id: String,
}

struct TrashRow {
    asset: AssetSummary,
    trashed_at: String,
}

impl Library {
    pub fn trash_asset(&self, asset_id: &str) -> Result<(), LibraryError> {
        let _trash_guard = self
            .trash_lock
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        self.update_trash_status(
            asset_id,
            "normal",
            "trash",
            Some(chrono::Utc::now().to_rfc3339()),
        )
    }

    pub fn restore_asset(&self, asset_id: &str) -> Result<(), LibraryError> {
        let _trash_guard = self
            .trash_lock
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        self.update_trash_status(asset_id, "trash", "normal", None)
    }

    pub fn list_trash(
        &self,
        after: Option<AssetCursor>,
        limit: u32,
    ) -> Result<TrashPage, LibraryError> {
        if !(1..=200).contains(&limit) {
            return Err(LibraryError::InvalidAssetPageLimit);
        }
        let connection = self.connection()?;
        let total_count: i64 = connection.query_row(
            "SELECT COUNT(*) FROM assets WHERE status = 'trash'",
            [],
            |row| row.get(0),
        )?;
        let total_bytes: i64 = connection.query_row(
            "SELECT COALESCE(SUM(byte_size), 0) FROM assets WHERE status = 'trash'",
            [],
            |row| row.get(0),
        )?;
        let retention_days: Option<u32> = connection.query_row(
            "SELECT trash_retention_days FROM library_settings WHERE singleton = 1",
            [],
            |row| row.get(0),
        )?;
        let cursor = decode_cursor(after)?;
        let mut statement = connection.prepare(
            "SELECT id, title, original_name, relative_path, thumbnail_relative_path, byte_size, width, height, collected_at, favorite, source_url, trashed_at
             FROM assets WHERE status = 'trash'
             AND (?1 IS NULL OR trashed_at < ?1 OR (trashed_at = ?1 AND id < ?2))
             ORDER BY trashed_at DESC, id DESC LIMIT ?3",
        )?;
        let (trashed_at, id) = cursor
            .as_ref()
            .map(|cursor| (Some(cursor.trashed_at.as_str()), Some(cursor.id.as_str())))
            .unwrap_or((None, None));
        let mut rows = statement.query(params![trashed_at, id, i64::from(limit) + 1])?;
        let mut items = Vec::new();
        while let Some(row) = rows.next()? {
            items.push(trash_asset_row(row)?);
        }
        let has_more = items.len() > limit as usize;
        items.truncate(limit as usize);
        let next_cursor = has_more.then(|| {
            let item = items
                .last()
                .expect("a page with another item has a returned item");
            AssetCursor {
                token: serde_json::to_string(&TrashCursor {
                    trashed_at: item.trashed_at.clone(),
                    id: item.asset.id.clone(),
                })
                .expect("trash cursor serializes"),
            }
        });
        Ok(TrashPage {
            items: items
                .into_iter()
                .map(|item| trash_summary(item, retention_days))
                .collect::<Result<Vec<_>, _>>()?,
            next_cursor,
            total_count: total_count as u64,
            total_bytes: total_bytes as u64,
        })
    }

    pub fn empty_trash(&self) -> Result<PurgeSummary, LibraryError> {
        let _trash_guard = self
            .trash_lock
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let connection = self.connection()?;
        let asset_ids = connection
            .prepare("SELECT id FROM assets WHERE status = 'trash'")?
            .query_map([], |row| row.get(0))?
            .collect::<Result<Vec<String>, _>>()?;
        self.purge_candidates(asset_ids)
    }

    pub fn purge_expired_trash(&self, now: DateTime<Utc>) -> Result<PurgeSummary, LibraryError> {
        let _trash_guard = self
            .trash_lock
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let connection = self.connection()?;
        let retention_days: Option<u32> = connection.query_row(
            "SELECT trash_retention_days FROM library_settings WHERE singleton = 1",
            [],
            |row| row.get(0),
        )?;
        let Some(retention_days) = retention_days else {
            return Ok(PurgeSummary {
                deleted_count: 0,
                failed_asset_ids: Vec::new(),
            });
        };
        let candidates = connection
            .prepare("SELECT id, trashed_at FROM assets WHERE status = 'trash'")?
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let cutoff = now - Duration::days(i64::from(retention_days));
        let asset_ids = candidates
            .into_iter()
            .filter_map(|(id, trashed_at)| {
                DateTime::parse_from_rfc3339(&trashed_at)
                    .ok()
                    .map(|timestamp| (id, timestamp.with_timezone(&Utc)))
            })
            .filter_map(|(id, trashed_at)| (trashed_at <= cutoff).then_some(id))
            .collect();
        self.purge_candidates(asset_ids)
    }

    fn update_trash_status(
        &self,
        asset_id: &str,
        from_status: &str,
        to_status: &str,
        trashed_at: Option<String>,
    ) -> Result<(), LibraryError> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        let changed = transaction.execute(
            "UPDATE assets SET status = ?3, trashed_at = ?4 WHERE id = ?1 AND status = ?2",
            params![asset_id, from_status, to_status, trashed_at],
        )?;
        if changed == 0
            && transaction
                .query_row(
                    "SELECT status FROM assets WHERE id = ?1",
                    [asset_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()?
                .is_none()
        {
            return Err(LibraryError::AssetNotFound);
        }
        transaction.commit()?;
        Ok(())
    }

    fn purge_candidates(&self, asset_ids: Vec<String>) -> Result<PurgeSummary, LibraryError> {
        let connection = self.connection()?;
        let mut deleted_count = 0;
        let mut failed_asset_ids = Vec::new();
        for asset_id in asset_ids {
            let paths = connection
                .query_row(
                    "SELECT relative_path, thumbnail_relative_path FROM assets WHERE id = ?1 AND status = 'trash'",
                    [&asset_id],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
                )
                .optional()?;
            let Some((relative_path, thumbnail_relative_path)) = paths else {
                continue;
            };
            if self
                .remove_managed_files(&relative_path, &thumbnail_relative_path)
                .is_err()
            {
                failed_asset_ids.push(asset_id);
                continue;
            }
            deleted_count += connection.execute(
                "DELETE FROM assets WHERE id = ?1 AND status = 'trash'",
                [&asset_id],
            )? as u64;
        }
        Ok(PurgeSummary {
            deleted_count,
            failed_asset_ids,
        })
    }

    fn remove_managed_files(
        &self,
        relative_path: &str,
        thumbnail_relative_path: &str,
    ) -> Result<(), ()> {
        let canonical_root = fs::canonicalize(&self.root).map_err(|_| ())?;
        let asset_path = managed_file_path(&canonical_root, relative_path)?;
        let thumbnail_path = managed_file_path(&canonical_root, thumbnail_relative_path)?;
        delete_file_if_present(asset_path)?;
        delete_file_if_present(thumbnail_path)
    }
}

fn managed_file_path(canonical_root: &Path, relative_path: &str) -> Result<Option<PathBuf>, ()> {
    let relative_path = Path::new(relative_path);
    if relative_path.is_absolute() {
        return Err(());
    }
    let requested_path = canonical_root.join(relative_path);
    let canonical_path = match fs::canonicalize(&requested_path) {
        Ok(path) => path,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(()),
    };
    canonical_path
        .starts_with(canonical_root)
        .then_some(canonical_path)
        .map(Some)
        .ok_or(())
}

fn delete_file_if_present(path: Option<PathBuf>) -> Result<(), ()> {
    let Some(path) = path else {
        return Ok(());
    };
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(()),
    }
}

fn decode_cursor(after: Option<AssetCursor>) -> Result<Option<TrashCursor>, LibraryError> {
    after
        .map(|cursor| {
            serde_json::from_str(&cursor.token).map_err(|_| LibraryError::InvalidAssetCursor)
        })
        .transpose()
}

fn trash_asset_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<TrashRow> {
    let byte_size =
        u64::try_from(row.get::<_, i64>(5)?).map_err(|_| rusqlite::Error::InvalidQuery)?;
    Ok(TrashRow {
        asset: AssetSummary {
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
            source_url: row.get(10)?,
        },
        trashed_at: row.get(11)?,
    })
}

fn trash_summary(
    item: TrashRow,
    retention_days: Option<u32>,
) -> Result<TrashAssetSummary, LibraryError> {
    let purge_at = retention_days
        .map(|days| {
            DateTime::parse_from_rfc3339(&item.trashed_at)
                .map(|timestamp| timestamp + Duration::days(i64::from(days)))
                .map(|timestamp: DateTime<FixedOffset>| timestamp.to_rfc3339())
                .map_err(|_| LibraryError::InvalidTrashTimestamp)
        })
        .transpose()?;
    Ok(TrashAssetSummary {
        asset: item.asset,
        trashed_at: item.trashed_at,
        purge_at,
    })
}
