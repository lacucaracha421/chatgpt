#[cfg(windows)]
use std::{
    ffi::OsString,
    fs::OpenOptions,
    os::windows::{ffi::OsStringExt, fs::OpenOptionsExt, io::AsRawHandle},
};
use std::{fs, path::Path};
#[cfg(windows)]
use std::{fs::File, io, path::PathBuf};

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

struct ManagedAssetPaths {
    original: Option<String>,
    thumbnail: Option<String>,
    video_directory: Option<String>,
}

/// Hidden from the trash: a server-known Asset whose purge waits for (or has passed) the
/// server's tombstone acceptance. It keeps `status='trash'` until then.
const NOT_PURGE_PENDING: &str =
    "NOT EXISTS (SELECT 1 FROM asset_purge_pending pending WHERE pending.asset_id = assets.id)";

impl Library {
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
            &format!("SELECT COUNT(*) FROM assets WHERE status = 'trash' AND {NOT_PURGE_PENDING}"),
            [],
            |row| row.get(0),
        )?;
        let total_bytes: i64 = transaction.query_row(
            &format!(
                "SELECT COALESCE(SUM(byte_size), 0) FROM assets
                 WHERE status = 'trash' AND {NOT_PURGE_PENDING}"
            ),
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
                    asset.source_published_at, asset.creator_name, asset.creator_handle,
                    asset.creator_url, asset.import_source, asset.import_batch_id,
                    asset.original_modified_at,
                    asset.trashed_at
             FROM assets AS asset
             LEFT JOIN video_assets AS video ON video.asset_id = asset.id
             WHERE asset.status = 'trash'
             AND NOT EXISTS (SELECT 1 FROM asset_purge_pending pending
                             WHERE pending.asset_id = asset.id)
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
        self.settle_purge_pending()?;
        let connection = self.connection()?;
        let asset_ids = connection
            .prepare(&format!(
                "SELECT id FROM assets WHERE status = 'trash' AND {NOT_PURGE_PENDING}"
            ))?
            .query_map([], |row| row.get(0))?
            .collect::<Result<Vec<String>, _>>()?;
        drop(connection);
        let mut summary = self.purge_candidates(asset_ids)?;
        summary
            .failed_asset_ids
            .extend(self.delete_accepted_purge_files_locked()?);
        Ok(summary)
    }

    pub fn purge_expired_trash(&self, now: DateTime<Utc>) -> Result<PurgeSummary, LibraryError> {
        if crate::workload::is_restricted() { return Ok(PurgeSummary { deleted_count: 0, failed_asset_ids: Vec::new() }); }
        let _trash_guard = self
            .trash_lock
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        // App start: finish any purge whose tombstone was accepted before a crash, and
        // settle purge-pending rows that lost their queued intent.
        self.settle_purge_pending()?;
        let pending_failures = self.delete_accepted_purge_files_locked()?;
        let connection = self.connection()?;
        let retention_days: Option<u32> = connection.query_row(
            "SELECT trash_retention_days FROM library_settings WHERE singleton = 1",
            [],
            |row| row.get(0),
        )?;
        let Some(retention_days) = retention_days else {
            return Ok(PurgeSummary {
                deleted_count: 0,
                failed_asset_ids: pending_failures,
            });
        };
        let candidates = connection
            .prepare(&format!(
                "SELECT id, trashed_at FROM assets WHERE status = 'trash' AND {NOT_PURGE_PENDING}"
            ))?
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
        let mut summary = self.purge_candidates(asset_ids)?;
        summary.failed_asset_ids.extend(pending_failures);
        Ok(summary)
    }

    fn settle_purge_pending(&self) -> Result<(), LibraryError> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        super::asset_authority::reconcile_purge_pending(&transaction)?;
        transaction.commit()?;
        Ok(())
    }

    /// Delete the files of purges whose tombstone the server has accepted.
    pub(crate) fn delete_accepted_purge_files(&self) -> Result<Vec<String>, LibraryError> {
        let _trash_guard = self
            .trash_lock
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        self.delete_accepted_purge_files_locked()
    }

    /// Caller holds `trash_lock`. Returns the Asset ids whose deletion must be retried.
    ///
    /// Guards, each re-checked here rather than trusted from the acceptance step: the Asset
    /// must be tombstoned in the confirmed server state and absent locally; every path is a
    /// recorded path of this Asset, relative, inside the library root and not shared with any
    /// other remaining record. The file primitives never follow a symlink out of the root.
    #[cfg(any(windows, target_os = "linux"))]
    fn delete_accepted_purge_files_locked(&self) -> Result<Vec<String>, LibraryError> {
        let rows = {
            let connection = self.connection()?;
            let rows = connection
                .prepare(
                    "SELECT asset_id, relative_path, thumbnail_relative_path, video_directory
                     FROM asset_purge_pending WHERE accepted_at IS NOT NULL ORDER BY asset_id",
                )?
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        ManagedAssetPaths {
                            original: row.get(1)?,
                            thumbnail: row.get(2)?,
                            video_directory: row.get(3)?,
                        },
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        };
        let mut failed = Vec::new();
        let (mut removed, mut kept_shared) = (0_u32, 0_u32);
        for (asset_id, recorded) in rows {
            let paths = {
                let connection = self.connection()?;
                let tombstoned: bool = connection.query_row(
                    "SELECT EXISTS(SELECT 1 FROM asset_authority_state
                                   WHERE asset_id = ?1 AND lifecycle = 'tombstoned')
                        AND NOT EXISTS(SELECT 1 FROM assets WHERE id = ?1)",
                    [&asset_id],
                    |row| row.get(0),
                )?;
                if !tombstoned {
                    // Not provably retired: never delete. The row is dropped so the files
                    // simply stay, which is the pre-existing (safe) outcome.
                    connection.execute(
                        "DELETE FROM asset_purge_pending WHERE asset_id = ?1",
                        [&asset_id],
                    )?;
                    continue;
                }
                let paths = unshared_paths(&connection, &asset_id, &recorded)?;
                kept_shared += recorded.count() - paths.count();
                paths
            };
            if self.remove_managed_paths(&paths).is_ok() {
                removed += 1;
                self.connection()?.execute(
                    "DELETE FROM asset_purge_pending WHERE asset_id = ?1 AND accepted_at IS NOT NULL",
                    [&asset_id],
                )?;
            } else {
                failed.push(asset_id);
            }
        }
        if !failed.is_empty() || kept_shared > 0 {
            // Counts only: paths and ids stay out of logs.
            eprintln!(
                "trash purge: {removed} assets' files deleted, {} deferred, {kept_shared} shared files kept",
                failed.len()
            );
        }
        Ok(failed)
    }

    #[cfg(not(any(windows, target_os = "linux")))]
    fn delete_accepted_purge_files_locked(&self) -> Result<Vec<String>, LibraryError> {
        Ok(Vec::new())
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
        update_trash_status_in_transaction(&transaction, asset_ids, from_status, to_status, trashed_at.as_deref())?;
        transaction.commit()?;
        Ok(())
    }

    #[cfg(any(windows, target_os = "linux"))]
    fn purge_candidates(&self, asset_ids: Vec<String>) -> Result<PurgeSummary, LibraryError> {
        // The library connection lock is not reentrant, so the legacy branch must be
        // decided without holding a second handle to it.
        let authority_adopted = {
            let connection = self.connection()?;
            connection.query_row("SELECT EXISTS(SELECT 1 FROM asset_authority)",[],|r|r.get::<_,bool>(0))?
        };
        if !authority_adopted {
            return self.purge_candidates_legacy(asset_ids);
        }
        let mut connection = self.connection()?;
        // Partition by explicit canonical ownership. A trashed Asset the server has never
        // committed has no tombstone to send: the server cannot resolve a lifecycle
        // command for an Asset it does not own, and its managed file has no server-side GC
        // that would ever reclaim it, so purge must remove the bytes locally. A
        // server-owned Asset keeps its bytes because physical deletion belongs to the
        // server's own GC, exactly as before.
        let mut server_known: Vec<String> = Vec::new();
        let mut local_only_paths: Vec<(String, ManagedAssetPaths)> = Vec::new();
        {
            let tx = connection.transaction()?;
            for id in asset_ids {
                let row = tx
                    .query_row(
                        "SELECT relative_path, thumbnail_relative_path, media_kind
                         FROM assets WHERE id = ?1 AND status = 'trash'",
                        [&id],
                        |row| {
                            let media_kind = row.get::<_, String>(2)?;
                            Ok(ManagedAssetPaths {
                                original: Some(row.get(0)?),
                                thumbnail: row.get(1)?,
                                video_directory: (media_kind == "video")
                                    .then(|| format!("video-media/{id}")),
                            })
                        },
                    )
                    .optional()?;
                let Some(paths) = row else { continue };
                let paths = unshared_paths(&tx, &id, &paths)?;
                let owned = tx.query_row(
                    "SELECT EXISTS(SELECT 1 FROM asset_authority_state WHERE asset_id=?)",
                    [&id],
                    |r| r.get::<_, bool>(0))?;
                if owned {
                    server_known.push(id);
                } else {
                    local_only_paths.push((id, paths));
                }
            }
            tx.commit()?;
        }

        // File removal happens outside the transaction, as in the legacy path.
        let mut failed_asset_ids = Vec::new();
        let mut purged_local: Vec<String> = Vec::new();
        for (id, paths) in local_only_paths {
            if self.remove_managed_paths(&paths).is_ok() {
                purged_local.push(id);
            } else {
                failed_asset_ids.push(id);
            }
        }

        let tx = connection.transaction()?;
        let now = chrono::Utc::now().to_rfc3339();
        let mut deleted_count = server_known.len() as u64;
        for id in server_known.iter().chain(purged_local.iter()) {
            // A purged Asset must never be published afterwards, so any queued legacy
            // upload work and any non-tombstone lifecycle desire for it is cancelled.
            tx.execute("DELETE FROM cloud_sync_queue WHERE entity_type='asset' AND entity_id=?", [id])?;
            tx.execute("DELETE FROM asset_lifecycle_outbox WHERE asset_id=? AND desired<>'tombstoned'", [id])?;
        }
        // Two-phase purge for server-owned Assets: the row and its files stay (hidden as
        // purge pending) until the server accepts the tombstone; `retire_local_row` then
        // deletes the row and records the files, which `delete_accepted_purge_files`
        // removes. A restore on another device before acceptance therefore still wins.
        // `enqueue` selects by canonical state, so the server-owned subset is exactly the
        // set that receives a tombstone command.
        for id in &server_known {
            tx.execute(
                "INSERT OR IGNORE INTO asset_purge_pending(asset_id, requested_at) VALUES(?1, ?2)",
                params![id, now],
            )?;
        }
        super::asset_authority::enqueue(&tx, &server_known, "tombstoned")?;
        for id in &purged_local {
            tx.execute("DELETE FROM assets WHERE id=?", [id])?;
        }
        // A purged Asset the server never owned can never receive a relation, so its
        // queued Album/Classification intents are retired now instead of waiting at the
        // send half for an upload that was just cancelled.
        super::album_authority::drop_album_intents_for_assets(
            &tx,
            &purged_local,
            super::album_authority::DROP_ASSET_PURGED,
            &now,
        )?;
        super::classification_authority::drop_classification_intents_for_assets(
            &tx,
            &purged_local,
            super::album_authority::DROP_ASSET_PURGED,
            &now,
        )?;
        deleted_count += purged_local.len() as u64;
        tx.commit()?;
        Ok(PurgeSummary { deleted_count, failed_asset_ids })
    }

    #[cfg(not(any(windows, target_os = "linux")))]
    fn purge_candidates_legacy(&self, _asset_ids: Vec<String>) -> Result<PurgeSummary, LibraryError> {
        Err(LibraryError::UnsupportedManagedFileDeletion)
    }

    #[cfg(any(windows, target_os = "linux"))]
    fn purge_candidates_legacy(&self, asset_ids: Vec<String>) -> Result<PurgeSummary, LibraryError> {
        let connection = self.connection()?;
        let mut deleted_count = 0;
        let mut failed_asset_ids = Vec::new();
        for asset_id in asset_ids {
            let paths = connection
                .query_row(
                    "SELECT relative_path, thumbnail_relative_path, media_kind
                     FROM assets WHERE id = ?1 AND status = 'trash'",
                    [&asset_id],
                    |row| {
                        let media_kind = row.get::<_, String>(2)?;
                        Ok(ManagedAssetPaths {
                            original: Some(row.get(0)?),
                            thumbnail: row.get(1)?,
                            video_directory: (media_kind == "video")
                                .then(|| format!("video-media/{asset_id}")),
                        })
                    },
                )
                .optional()?;
            let Some(paths) = paths else {
                continue;
            };
            let paths = unshared_paths(&connection, &asset_id, &paths)?;
            if self.remove_managed_paths(&paths).is_err() {
                failed_asset_ids.push(asset_id);
                continue;
            }
            let deleted = connection.execute(
                "DELETE FROM assets WHERE id = ?1 AND status = 'trash'",
                [&asset_id],
            )?;
            if deleted > 0 {
                // Same rule as the authority path: a purged Asset's queued relation
                // intents can never apply, so they are retired with the purge.
                let now = chrono::Utc::now().to_rfc3339();
                let purged = [asset_id.clone()];
                super::album_authority::drop_album_intents_for_assets(
                    &connection,
                    &purged,
                    super::album_authority::DROP_ASSET_PURGED,
                    &now,
                )?;
                super::classification_authority::drop_classification_intents_for_assets(
                    &connection,
                    &purged,
                    super::album_authority::DROP_ASSET_PURGED,
                    &now,
                )?;
            }
            deleted_count += deleted as u64;
        }
        Ok(PurgeSummary {
            deleted_count,
            failed_asset_ids,
        })
    }

    #[cfg(not(any(windows, target_os = "linux")))]
    fn purge_candidates(&self, _asset_ids: Vec<String>) -> Result<PurgeSummary, LibraryError> {
        Err(LibraryError::UnsupportedManagedFileDeletion)
    }

    #[cfg(any(windows, target_os = "linux"))]
    fn remove_managed_paths(&self, paths: &ManagedAssetPaths) -> Result<(), ()> {
        let canonical_root = fs::canonicalize(&self.root).map_err(|_| ())?;
        if let Some(original) = &paths.original {
            delete_managed_file(&canonical_root, original)?;
        }
        if paths.video_directory.is_none() {
            if let Some(thumbnail) = &paths.thumbnail {
                delete_managed_file(&canonical_root, thumbnail)?;
            }
        }
        if let Some(video_directory) = &paths.video_directory {
            delete_managed_directory(&canonical_root, video_directory)?;
        }
        Ok(())
    }

    pub(crate) fn remove_managed_files(
        &self,
        relative_path: &str,
        thumbnail_relative_path: &str,
    ) -> Result<(), ()> {
        self.remove_managed_paths(&ManagedAssetPaths {
            original: Some(relative_path.to_owned()),
            thumbnail: Some(thumbnail_relative_path.to_owned()),
            video_directory: None,
        })
    }
}

impl ManagedAssetPaths {
    fn count(&self) -> u32 {
        u32::from(self.original.is_some())
            + u32::from(self.thumbnail.is_some() && self.video_directory.is_none())
            + u32::from(self.video_directory.is_some())
    }
}

/// Keep only the paths that belong to `owner` alone.
///
/// A path is dropped (its file kept) when it is not a plain relative path at least one
/// directory deep, or when any other remaining record still names it: another Asset's
/// original or thumbnail, a video derivative, or a manga thumbnail. Comparison ignores
/// ASCII case and separator style so a Windows spelling cannot slip past it.
fn unshared_paths(
    db: &rusqlite::Connection,
    owner: &str,
    paths: &ManagedAssetPaths,
) -> Result<ManagedAssetPaths, LibraryError> {
    let file = |path: &Option<String>| -> Result<Option<String>, LibraryError> {
        let Some(path) = path else { return Ok(None) };
        if !deletable_shape(path) {
            return Ok(None);
        }
        let key = comparable(path);
        let shared: bool = db.query_row(
            "SELECT EXISTS(SELECT 1 FROM assets WHERE id <> ?2
                  AND (lower(replace(relative_path, '\\', '/')) = ?1
                       OR lower(replace(thumbnail_relative_path, '\\', '/')) = ?1))
                 OR EXISTS(SELECT 1 FROM video_assets WHERE asset_id <> ?2
                  AND (lower(replace(poster_relative_path, '\\', '/')) = ?1
                       OR lower(replace(proxy_relative_path, '\\', '/')) = ?1))
                 OR EXISTS(SELECT 1 FROM manga_series
                  WHERE lower(replace(thumbnail_relative_path, '\\', '/')) = ?1)",
            params![key, owner],
            |row| row.get(0),
        )?;
        Ok((!shared).then(|| path.clone()))
    };
    let directory = match &paths.video_directory {
        // The derivative directory is named after the Asset itself; anything else is not
        // this Asset's to remove.
        Some(directory) if comparable(directory) == comparable(&format!("video-media/{owner}")) => {
            let prefix = format!("{}/%", comparable(directory));
            let shared: bool = db.query_row(
                "SELECT EXISTS(SELECT 1 FROM assets WHERE id <> ?2
                      AND (lower(replace(relative_path, '\\', '/')) LIKE ?1
                           OR lower(replace(thumbnail_relative_path, '\\', '/')) LIKE ?1))
                     OR EXISTS(SELECT 1 FROM video_assets WHERE asset_id <> ?2
                      AND (lower(replace(poster_relative_path, '\\', '/')) LIKE ?1
                           OR lower(replace(proxy_relative_path, '\\', '/')) LIKE ?1
                           OR lower(replace(scrub_relative_dir, '\\', '/')) LIKE ?1))",
                params![prefix, owner],
                |row| row.get(0),
            )?;
            (!shared).then(|| directory.clone())
        }
        _ => None,
    };
    Ok(ManagedAssetPaths {
        original: file(&paths.original)?,
        // A video's thumbnail lives inside its derivative directory and goes with it.
        thumbnail: if paths.video_directory.is_some() {
            None
        } else {
            file(&paths.thumbnail)?
        },
        video_directory: directory,
    })
}

fn comparable(path: &str) -> String {
    path.replace('\\', "/").to_ascii_lowercase()
}

/// A recorded path we may delete: relative, no parent/root components, and inside a
/// subdirectory, so no top-level library file (the database, lock, catalogs) can match.
fn deletable_shape(path: &str) -> bool {
    let normalized = path.replace('\\', "/");
    checked_relative_path(&normalized).is_ok()
        && Path::new(&normalized)
            .components()
            .filter(|c| matches!(c, std::path::Component::Normal(_)))
            .count()
            >= 2
}

/// Shares the existing trash semantics with callers that must atomically record a decision.
pub(crate) fn update_trash_status_in_transaction(
    transaction: &rusqlite::Transaction<'_>,
    asset_ids: &[String],
    from_status: &str,
    to_status: &str,
    trashed_at: Option<&str>,
) -> Result<(), LibraryError> {
    let asset_ids = validated_asset_ids(transaction, asset_ids)?;
    for asset_id in asset_ids {
        let changed=transaction.execute(
            "UPDATE assets SET status = ?3, trashed_at = ?4 WHERE id = ?1 AND status = ?2
             AND NOT EXISTS (SELECT 1 FROM asset_purge_pending WHERE asset_id = ?1)",
            params![asset_id, from_status, to_status, trashed_at],
        )?;
        if changed > 0 {
            super::asset_authority::enqueue(transaction, &[asset_id.to_string()], to_status)?;
        }
        if changed > 0 && to_status == "normal" && from_status != "normal" {
            super::character_autotag::enqueue(transaction,asset_id,super::character_autotag::Cause::Restore)?;
        }
        if changed > 0 && to_status == "normal" && from_status == "trash" {
            requeue_relation_intents_after_restore(transaction, asset_id)?;
        }
    }
    Ok(())
}

/// Re-queue the Album/Classification intents of a restored, never-committed Asset.
///
/// The send half retires the relation intents of an Asset trashed before its upload
/// committed (`assetTrashedBeforeUpload`), because replication does not upload a trashed
/// Asset. Restoring it resumes the upload, so the relations it still holds locally are
/// queued again and reach the server once it commits. Relations that still have a queued
/// intent (the send half had not retired it yet) are left alone, so nothing is doubled.
fn requeue_relation_intents_after_restore(
    transaction: &rusqlite::Transaction<'_>,
    asset_id: &str,
) -> Result<(), LibraryError> {
    use super::album_authority::{asset_intent_readiness, AssetIntentReadiness, MEMBERSHIP};
    if asset_intent_readiness(transaction, asset_id)? != AssetIntentReadiness::Wait {
        return Ok(());
    }
    let albums: Vec<String> = transaction
        .prepare(
            "SELECT album_id FROM asset_albums m WHERE m.asset_id = ?1
             AND NOT EXISTS (SELECT 1 FROM album_authority_outbox o
                 WHERE o.command_type = ?2 AND o.album_id = m.album_id AND o.asset_id = ?1)
             ORDER BY album_id",
        )?
        .query_map(params![asset_id, MEMBERSHIP], |row| row.get(0))?
        .collect::<Result<Vec<_>, _>>()?;
    for album_id in albums {
        Library::enqueue_album_membership_intent(transaction, &album_id, asset_id, true)?;
    }
    let queued: bool = transaction.query_row(
        "SELECT EXISTS(SELECT 1 FROM classification_authority_outbox
             WHERE command_type = ?1 AND asset_id = ?2)",
        params![super::classification_authority::ASSIGNMENT, asset_id],
        |row| row.get(0),
    )?;
    if !queued {
        let current: Option<String> = transaction
            .query_row(
                "SELECT classification_id FROM asset_classifications WHERE asset_id = ?1
                 ORDER BY classification_id LIMIT 1",
                [asset_id],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(classification_id) = current {
            Library::enqueue_classification_assignment_intent(
                transaction,
                asset_id,
                Some(&classification_id),
            )?;
        }
    }
    Ok(())
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
fn delete_managed_directory(canonical_root: &Path, relative_path: &str) -> Result<(), ()> {
    let requested_path = canonical_root.join(checked_relative_path(relative_path)?);
    let metadata = match fs::symlink_metadata(&requested_path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err(()),
    };
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(());
    }
    let canonical_directory = fs::canonicalize(&requested_path).map_err(|_| ())?;
    if canonical_directory == canonical_root || !canonical_directory.starts_with(canonical_root) {
        return Err(());
    }
    fs::remove_dir_all(canonical_directory).map_err(|_| ())
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
        trashed_at: row.get(22)?,
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

    /// An accepted purge of `id` recording the given paths, with confirmed `lifecycle`.
    fn accepted_purge(library: &Library, id: &str, lifecycle: &str, original: &str, thumbnail: &str) {
        let db = library.connection().unwrap();
        db.execute(
            "INSERT INTO asset_authority_state(asset_id,lifecycle,entity_revision,projection)
             VALUES(?1,?2,3,'{}')",
            rusqlite::params![id, lifecycle],
        )
        .unwrap();
        db.execute(
            "INSERT INTO asset_purge_pending(asset_id,requested_at,accepted_at,relative_path,thumbnail_relative_path)
             VALUES(?1,'2026','2026',?2,?3)",
            rusqlite::params![id, original, thumbnail],
        )
        .unwrap();
    }

    fn write(library: &Library, relative: &str) -> std::path::PathBuf {
        let path = library.root().join(relative);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, b"bytes").unwrap();
        path
    }

    fn pending(library: &Library) -> i64 {
        library
            .connection()
            .unwrap()
            .query_row("SELECT count(*) FROM asset_purge_pending", [], |r| r.get(0))
            .unwrap()
    }

    #[test]
    fn purge_deletes_only_the_accepted_assets_own_files() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let original = write(&library, "assets/aa/gone.png");
        let thumbnail = write(&library, "thumbnails/aa/gone.webp");
        let neighbour = write(&library, "assets/aa/neighbour.png");
        accepted_purge(&library, "gone", "tombstoned", "assets/aa/gone.png", "thumbnails/aa/gone.webp");
        assert!(library.delete_accepted_purge_files().unwrap().is_empty());
        assert!(!original.exists() && !thumbnail.exists());
        assert!(neighbour.is_file());
        assert_eq!(pending(&library), 0);
    }

    #[test]
    fn purge_keeps_a_file_another_asset_still_references() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        insert_normal_asset(&library, "keeper");
        let shared = write(&library, "assets/keeper.png");
        let own = write(&library, "thumbnails/aa/gone.webp");
        // A different spelling of the same path must still be recognised as shared.
        accepted_purge(&library, "gone", "tombstoned", r"Assets\KEEPER.png", "thumbnails/aa/gone.webp");
        assert!(library.delete_accepted_purge_files().unwrap().is_empty());
        assert!(shared.is_file(), "a file named by another Asset is never deleted");
        assert!(!own.exists());
        assert_eq!(pending(&library), 0);
    }

    #[test]
    fn purge_never_deletes_files_of_an_asset_that_is_not_tombstoned() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let original = write(&library, "assets/aa/gone.png");
        accepted_purge(&library, "gone", "trash", "assets/aa/gone.png", "thumbnails/aa/none.webp");
        library.delete_accepted_purge_files().unwrap();
        assert!(original.is_file());
        assert_eq!(pending(&library), 0);
    }

    #[test]
    fn purge_never_deletes_files_while_the_local_row_still_exists() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        insert_normal_asset(&library, "gone");
        let original = write(&library, "assets/gone.png");
        accepted_purge(&library, "gone", "tombstoned", "assets/gone.png", "thumbnails/gone.webp");
        library.delete_accepted_purge_files().unwrap();
        assert!(original.is_file());
    }

    #[test]
    fn purge_refuses_paths_outside_or_at_the_top_of_the_library() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("library");
        std::fs::create_dir_all(&root).unwrap();
        let library = Library::open(&root).unwrap();
        let outside = temp.path().join("outside.png");
        std::fs::write(&outside, b"outside").unwrap();
        let top_level = write(&library, "top.png");
        accepted_purge(&library, "escape", "tombstoned", "../outside.png", "top.png");
        accepted_purge(
            &library,
            "absolute",
            "tombstoned",
            outside.to_str().unwrap(),
            "library.sqlite",
        );
        library.delete_accepted_purge_files().unwrap();
        assert!(outside.is_file());
        assert!(top_level.is_file());
        assert!(root.join("library.sqlite").is_file());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn purge_never_follows_a_symlink_out_of_the_library() {
        let temp = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let target = outside.path().join("victim.png");
        std::fs::write(&target, b"outside").unwrap();
        std::fs::create_dir_all(library.root().join("assets")).unwrap();
        std::os::unix::fs::symlink(outside.path(), library.root().join("assets/linked")).unwrap();
        std::os::unix::fs::symlink(&target, library.root().join("assets/victim.png")).unwrap();
        accepted_purge(&library, "via-dir", "tombstoned", "assets/linked/victim.png", "assets/linked/x.webp");
        accepted_purge(&library, "via-file", "tombstoned", "assets/victim.png", "assets/none.webp");
        let failed = library.delete_accepted_purge_files().unwrap();
        assert!(target.is_file(), "a symlinked path must never reach a file outside the root");
        assert!(failed.contains(&"via-dir".to_string()) && failed.contains(&"via-file".to_string()));
        // Refused rows stay for a later retry rather than being reported as done.
        assert_eq!(pending(&library), 2);
    }

    #[test]
    fn a_local_only_purge_keeps_a_file_another_asset_references() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        insert_trashed_asset(&library, "gone", "2026-08-02T00:00:00Z");
        insert_normal_asset(&library, "keeper");
        let own = write(&library, "assets/gone.png");
        let shared = write(&library, "thumbnails/gone.webp");
        // Another record (a video poster of `keeper`) still names the thumbnail.
        library
            .connection()
            .unwrap()
            .execute(
                "INSERT INTO video_assets(asset_id,duration_ms,container,video_codec,preparation_state,poster_relative_path)
                 VALUES('keeper',1,'mp4','h264','pending','thumbnails/gone.webp')",
                [],
            )
            .unwrap();
        let summary = library.empty_trash().unwrap();
        assert_eq!(summary.deleted_count, 1);
        assert!(!own.exists());
        assert!(shared.is_file());
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

#[cfg(target_os = "linux")]
fn delete_managed_file(root: &Path, relative: &str) -> Result<(), ()> {
    super::linux_fs::delete_managed(root, checked_relative_path(relative)?, false).map_err(|_| ())
}
#[cfg(target_os = "linux")]
fn delete_managed_directory(root: &Path, relative: &str) -> Result<(), ()> {
    super::linux_fs::delete_managed(root, checked_relative_path(relative)?, true).map_err(|_| ())
}
