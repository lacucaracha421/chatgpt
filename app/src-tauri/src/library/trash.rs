#[cfg(windows)]
use std::{
    ffi::OsString,
    fs::OpenOptions,
    os::windows::{ffi::OsStringExt, fs::OpenOptionsExt, io::AsRawHandle},
};
use std::{
    fs::{self, File},
    io,
    path::{Path, PathBuf},
};

use chrono::{DateTime, Duration, FixedOffset, Utc};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
#[cfg(windows)]
use windows_sys::Win32::Storage::FileSystem::{
    FileDispositionInfo, GetFinalPathNameByHandleW, SetFileInformationByHandle, DELETE,
    FILE_DISPOSITION_INFO, FILE_FLAG_OPEN_REPARSE_POINT, FILE_NAME_NORMALIZED, FILE_SHARE_DELETE,
    FILE_SHARE_READ, FILE_SHARE_WRITE,
};

use super::{
    error::LibraryError,
    models::{AssetCursor, AssetSummary, PurgeSummary, TrashAssetSummary, TrashPage},
    query::asset_summary_from_row,
    validated_asset_ids, Library,
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
        self.trash_assets(&[asset_id.to_owned()])
    }

    pub fn trash_assets(&self, asset_ids: &[String]) -> Result<(), LibraryError> {
        let _trash_guard = self
            .trash_lock
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        self.update_trash_status(
            asset_ids,
            "normal",
            "trash",
            Some(chrono::Utc::now().to_rfc3339()),
        )
    }

    pub fn restore_asset(&self, asset_id: &str) -> Result<(), LibraryError> {
        self.restore_assets(&[asset_id.to_owned()])
    }

    pub fn restore_assets(&self, asset_ids: &[String]) -> Result<(), LibraryError> {
        let _trash_guard = self
            .trash_lock
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        self.update_trash_status(asset_ids, "trash", "normal", None)
    }

    pub fn list_trash(
        &self,
        after: Option<AssetCursor>,
        limit: u32,
    ) -> Result<TrashPage, LibraryError> {
        let _trash_guard = self
            .trash_lock
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if !(1..=200).contains(&limit) {
            return Err(LibraryError::InvalidAssetPageLimit);
        }
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        let total_count: i64 = transaction.query_row(
            "SELECT COUNT(*) FROM assets WHERE status = 'trash'",
            [],
            |row| row.get(0),
        )?;
        let total_bytes: i64 = transaction.query_row(
            "SELECT COALESCE(SUM(byte_size), 0) FROM assets WHERE status = 'trash'",
            [],
            |row| row.get(0),
        )?;
        run_after_trash_count_hook();
        let retention_days: Option<u32> = transaction.query_row(
            "SELECT trash_retention_days FROM library_settings WHERE singleton = 1",
            [],
            |row| row.get(0),
        )?;
        let cursor = decode_cursor(after)?;
        let mut statement = transaction.prepare(
            "SELECT asset.id, asset.title, asset.original_name, asset.relative_path,
                    asset.thumbnail_relative_path, asset.byte_size, asset.width, asset.height,
                    asset.collected_at, asset.favorite, asset.source_url, asset.media_kind,
                    video.duration_ms, video.preparation_state, video.scrub_frame_count,
                    asset.trashed_at
             FROM assets AS asset
             LEFT JOIN video_assets AS video ON video.asset_id = asset.id
             WHERE asset.status = 'trash'
             AND (?1 IS NULL OR asset.trashed_at < ?1
                  OR (asset.trashed_at = ?1 AND asset.id < ?2))
             ORDER BY asset.trashed_at DESC, asset.id DESC LIMIT ?3",
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
        drop(rows);
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
        let page = TrashPage {
            items: items
                .into_iter()
                .map(|item| trash_summary(item, retention_days))
                .collect::<Result<Vec<_>, _>>()?,
            next_cursor,
            total_count: total_count as u64,
            total_bytes: total_bytes as u64,
        };
        drop(statement);
        transaction.commit()?;
        Ok(page)
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
        drop(connection);
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
        drop(connection);
        self.purge_candidates(asset_ids)
    }

    fn update_trash_status(
        &self,
        asset_ids: &[String],
        from_status: &str,
        to_status: &str,
        trashed_at: Option<String>,
    ) -> Result<(), LibraryError> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        let asset_ids = validated_asset_ids(&transaction, asset_ids)?;
        for asset_id in asset_ids {
            transaction.execute(
                "UPDATE assets SET status = ?3, trashed_at = ?4 WHERE id = ?1 AND status = ?2",
                params![asset_id, from_status, to_status, trashed_at],
            )?;
        }
        transaction.commit()?;
        Ok(())
    }

    #[cfg(windows)]
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

    #[cfg(not(windows))]
    fn purge_candidates(&self, _asset_ids: Vec<String>) -> Result<PurgeSummary, LibraryError> {
        Err(LibraryError::UnsupportedManagedFileDeletion)
    }

    #[cfg(windows)]
    pub(crate) fn remove_managed_files(
        &self,
        relative_path: &str,
        thumbnail_relative_path: &str,
    ) -> Result<(), ()> {
        let canonical_root = fs::canonicalize(&self.root).map_err(|_| ())?;
        delete_managed_file(&canonical_root, relative_path)?;
        delete_managed_file(&canonical_root, thumbnail_relative_path)
    }
}

fn checked_relative_path(relative_path: &str) -> Result<&Path, ()> {
    let relative_path = Path::new(relative_path);
    if relative_path.is_absolute()
        || relative_path.components().any(|component| {
            matches!(
                component,
                std::path::Component::ParentDir
                    | std::path::Component::RootDir
                    | std::path::Component::Prefix(_)
            )
        })
    {
        return Err(());
    }
    Ok(relative_path)
}

#[cfg(windows)]
fn delete_managed_file(canonical_root: &Path, relative_path: &str) -> Result<(), ()> {
    let requested_path = canonical_root.join(checked_relative_path(relative_path)?);
    let comparable_root = normalized_windows_path(canonical_root);
    let file = match OpenOptions::new()
        .read(true)
        .access_mode(DELETE)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(&requested_path)
    {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err(()),
    };
    let is_file = file.metadata().map_err(|_| ())?.is_file();
    let handle_path = windows_handle_path(&file).map_err(|_| ())?;
    if !is_file || !handle_path.starts_with(&comparable_root) {
        return Err(());
    }
    run_before_handle_delete_hook(&requested_path);
    let disposition = FILE_DISPOSITION_INFO { DeleteFile: true };
    // SAFETY: the open handle has DELETE access and `disposition` remains valid for the call.
    if unsafe {
        SetFileInformationByHandle(
            file.as_raw_handle(),
            FileDispositionInfo,
            &disposition as *const FILE_DISPOSITION_INFO as *const _,
            std::mem::size_of::<FILE_DISPOSITION_INFO>() as u32,
        )
    } == 0
    {
        return Err(());
    }
    drop(file);
    Ok(())
}

#[cfg(windows)]
fn windows_handle_path(file: &File) -> io::Result<PathBuf> {
    let mut buffer = vec![0_u16; 260];
    loop {
        // SAFETY: the valid file handle and mutable UTF-16 buffer are passed for this query.
        let length = unsafe {
            GetFinalPathNameByHandleW(
                file.as_raw_handle(),
                buffer.as_mut_ptr(),
                buffer.len() as u32,
                FILE_NAME_NORMALIZED,
            )
        };
        if length == 0 {
            return Err(io::Error::last_os_error());
        }
        if length < buffer.len() as u32 {
            buffer.truncate(length as usize);
            return Ok(normalized_windows_path(&PathBuf::from(
                OsString::from_wide(&buffer),
            )));
        }
        buffer.resize(length as usize + 1, 0);
    }
}

#[cfg(windows)]
fn normalized_windows_path(path: &Path) -> PathBuf {
    let path = path.to_string_lossy();
    let path = path
        .strip_prefix(r"\\?\UNC\")
        .map(|path| format!(r"\\{path}"))
        .or_else(|| path.strip_prefix(r"\\?\").map(str::to_owned))
        .unwrap_or_else(|| path.into_owned());
    PathBuf::from(path)
}

#[cfg(all(test, windows))]
type HandleDeleteHook = Box<dyn FnOnce(&Path)>;

#[cfg(all(test, windows))]
thread_local! {
    static BEFORE_HANDLE_DELETE_HOOK: std::cell::RefCell<Option<HandleDeleteHook>> = const { std::cell::RefCell::new(None) };
}

#[cfg(all(test, windows))]
fn set_before_handle_delete_hook(hook: impl FnOnce(&Path) + 'static) {
    BEFORE_HANDLE_DELETE_HOOK.with(|slot| *slot.borrow_mut() = Some(Box::new(hook)));
}

#[cfg(all(test, windows))]
fn run_before_handle_delete_hook(path: &Path) {
    BEFORE_HANDLE_DELETE_HOOK.with(|slot| {
        if let Some(hook) = slot.borrow_mut().take() {
            hook(path);
        }
    });
}

#[cfg(not(all(test, windows)))]
fn run_before_handle_delete_hook(_path: &Path) {}

#[cfg(test)]
type TrashCountHook = Box<dyn FnOnce()>;

#[cfg(test)]
thread_local! {
    static AFTER_TRASH_COUNT_HOOK: std::cell::RefCell<Option<TrashCountHook>> = const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
fn set_after_trash_count_hook(hook: impl FnOnce() + 'static) {
    AFTER_TRASH_COUNT_HOOK.with(|slot| *slot.borrow_mut() = Some(Box::new(hook)));
}

#[cfg(test)]
fn run_after_trash_count_hook() {
    AFTER_TRASH_COUNT_HOOK.with(|slot| {
        if let Some(hook) = slot.borrow_mut().take() {
            hook();
        }
    });
}

#[cfg(not(test))]
fn run_after_trash_count_hook() {}

fn decode_cursor(after: Option<AssetCursor>) -> Result<Option<TrashCursor>, LibraryError> {
    after
        .map(|cursor| {
            serde_json::from_str(&cursor.token).map_err(|_| LibraryError::InvalidAssetCursor)
        })
        .transpose()
}

fn trash_asset_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<TrashRow> {
    Ok(TrashRow {
        asset: asset_summary_from_row(row)?,
        trashed_at: row.get(15)?,
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

#[cfg(test)]
mod tests {
    use std::{sync::mpsc, time::Duration};

    use crate::library::Library;

    use super::set_after_trash_count_hook;

    #[test]
    fn list_trash_waits_for_the_lifecycle_lock() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let guard = library.trash_lock.lock().unwrap();
        let waiting_library = library.clone();
        let (done_tx, done_rx) = mpsc::channel();
        let waiting = std::thread::spawn(move || {
            waiting_library.list_trash(None, 20).unwrap();
            done_tx.send(()).unwrap();
        });

        assert!(done_rx.recv_timeout(Duration::from_millis(100)).is_err());

        drop(guard);
        waiting.join().unwrap();
    }

    #[test]
    fn list_trash_uses_one_read_snapshot_for_totals_and_items() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        insert_trashed_asset(&library, "first", "2026-08-02T00:00:00Z");
        let root = library.root().to_path_buf();
        set_after_trash_count_hook(move || {
            let connection = rusqlite::Connection::open(root.join("library.sqlite")).unwrap();
            connection
                .execute(
                    "INSERT INTO assets (
                        id, content_hash, media_kind, original_name, relative_path,
                        thumbnail_relative_path, byte_size, width, height, collected_at,
                        status, trashed_at
                     ) VALUES (
                        'second', 'hash-second', 'image', 'second.png', 'assets/second.png',
                        'thumbnails/second.webp', 1, 1, 1, '2026-08-02T00:00:00Z',
                        'trash', '2026-08-02T00:00:00Z'
                     )",
                    [],
                )
                .unwrap();
        });

        let page = library.list_trash(None, 20).unwrap();

        assert_eq!(page.total_count, 1);
        assert_eq!(page.items.len(), 1);
    }

    #[test]
    fn batch_trash_and_restore_are_atomic() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        insert_normal_asset(&library, "first");
        insert_normal_asset(&library, "second");

        library
            .trash_assets(&["first".into(), "second".into()])
            .unwrap();
        assert_eq!(library.list_trash(None, 20).unwrap().total_count, 2);

        let error = library
            .restore_assets(&["first".into(), "missing".into()])
            .unwrap_err();
        assert!(matches!(
            error,
            crate::library::error::LibraryError::AssetNotFound
        ));
        assert_eq!(library.list_trash(None, 20).unwrap().total_count, 2);

        library
            .restore_assets(&["first".into(), "second".into()])
            .unwrap();
        assert_eq!(library.list_trash(None, 20).unwrap().total_count, 0);
    }

    fn insert_normal_asset(library: &Library, id: &str) {
        library
            .connection()
            .unwrap()
            .execute(
                "INSERT INTO assets (
                id, content_hash, media_kind, original_name, relative_path,
                thumbnail_relative_path, byte_size, width, height, collected_at
             ) VALUES (?1, ?2, 'image', ?3, ?4, ?5, 1, 1, 1, '2026-08-02T00:00:00Z')",
                rusqlite::params![
                    id,
                    format!("hash-{id}"),
                    format!("{id}.png"),
                    format!("assets/{id}.png"),
                    format!("thumbnails/{id}.webp")
                ],
            )
            .unwrap();
    }

    fn insert_trashed_asset(library: &Library, id: &str, trashed_at: &str) {
        library
            .connection()
            .unwrap()
            .execute(
                "INSERT INTO assets (
                    id, content_hash, media_kind, original_name, relative_path,
                    thumbnail_relative_path, byte_size, width, height, collected_at,
                    status, trashed_at
                 ) VALUES (?1, ?2, 'image', ?3, ?4, ?5, 1, 1, 1, ?6, 'trash', ?7)",
                rusqlite::params![
                    id,
                    format!("hash-{id}"),
                    format!("{id}.png"),
                    format!("assets/{id}.png"),
                    format!("thumbnails/{id}.webp"),
                    trashed_at,
                    trashed_at,
                ],
            )
            .unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn windows_handle_deletion_keeps_a_path_replacement() {
        use super::{delete_managed_file, set_before_handle_delete_hook};

        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("library");
        let assets = root.join("assets");
        std::fs::create_dir_all(&assets).unwrap();
        let original = assets.join("asset.png");
        let moved = assets.join("moved.png");
        std::fs::write(&original, b"managed").unwrap();
        let moved_for_hook = moved.clone();
        set_before_handle_delete_hook(move |opened_path| {
            std::fs::rename(opened_path, &moved_for_hook).unwrap();
            std::fs::write(opened_path, b"replacement").unwrap();
        });

        delete_managed_file(&std::fs::canonicalize(&root).unwrap(), "assets/asset.png").unwrap();

        assert_eq!(std::fs::read(&original).unwrap(), b"replacement");
        assert!(!moved.exists());
    }
}
