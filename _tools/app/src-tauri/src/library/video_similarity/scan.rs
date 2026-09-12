use super::{fingerprint::*, Error, Result, VideoScanProgress, VideoScanRequest};
use crate::library::{
    image_fingerprint::{fingerprint, ImageFingerprint},
    video_media, Library,
};
use rusqlite::{params, OptionalExtension};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs::{File, OpenOptions},
    io::Read,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

#[derive(Debug, Default)]
pub(crate) struct ScanState {
    active: Option<(String, Arc<AtomicBool>)>,
}

#[derive(Clone)]
pub(super) struct Source {
    pub id: String,
    pub hash: String,
    pub path: String,
    pub bytes: u64,
    pub duration_ms: u64,
    pub width: u32,
    pub height: u32,
}
impl Source {
    fn metadata(&self) -> VideoFingerprint {
        VideoFingerprint {
            duration_ms: self.duration_ms,
            width: self.width,
            height: self.height,
            frames: Vec::new(),
        }
    }
}

// Keeping this handle open denies writes/deletion during extraction or a decision on Windows.
pub(super) struct VerifiedSource {
    pub _file: File,
    pub path: PathBuf,
}

impl Library {
    pub fn recover_video_similarity_scans(
        &self,
    ) -> std::result::Result<(), crate::library::error::LibraryError> {
        self.connection()?.execute_batch(
            "UPDATE video_similarity_scans SET state = 'paused', reason = 'interrupted' WHERE state IN ('queued','running');
             UPDATE video_similarity_scan_items SET state = 'queued', reason = NULL WHERE state = 'running';")?;
        Ok(())
    }

    pub fn stop_video_similarity_scan(&self) {
        if let Some((_, cancel)) = &self
            .video_similarity_scan
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .active
        {
            cancel.store(true, Ordering::Relaxed);
        }
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            if self
                .video_similarity_scan
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .active
                .is_none()
            {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    /// Acquire before backup/catalog/database locks. Holding the idle state guard
    /// prevents a new scan from racing the replacement of library.sqlite.
    pub(crate) fn video_similarity_restore_guard(
        &self,
    ) -> std::result::Result<
        std::sync::MutexGuard<'_, ScanState>,
        crate::library::error::LibraryError,
    > {
        self.stop_video_similarity_scan();
        let state = self
            .video_similarity_scan
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if state.active.is_some() {
            return Err(crate::library::error::LibraryError::Database(
                rusqlite::Error::SqliteFailure(
                    rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_BUSY),
                    None,
                ),
            ));
        }
        Ok(state)
    }

    pub fn start_video_similarity_scan(
        &self,
        request: VideoScanRequest,
    ) -> Result<VideoScanProgress> {
        let ids = request
            .asset_ids
            .into_iter()
            .collect::<std::collections::BTreeSet<_>>();
        if !(2..=MAX_ASSETS).contains(&ids.len())
            || ids.iter().any(|id| uuid::Uuid::parse_str(id).is_err())
        {
            return Err(Error::InvalidSelection);
        }
        let mut state = self
            .video_similarity_scan
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if state.active.is_some() {
            return Err(Error::Busy);
        }
        let sources = ids
            .iter()
            .map(|id| self.video_similarity_source(id))
            .collect::<Result<Vec<_>>>()?;
        let id = uuid::Uuid::new_v4().to_string();
        let now = chrono::Utc::now().to_rfc3339();
        {
            let mut connection = self.connection()?;
            let tx = connection.transaction()?;
            tx.execute("INSERT INTO video_similarity_scans(id,profile,state,created_at,updated_at) VALUES(?1,?2,'queued',?3,?3)", params![id,PROFILE,now])?;
            for (ordinal, source) in sources.iter().enumerate() {
                tx.execute("INSERT INTO video_similarity_scan_items(scan_id,ordinal,asset_id,source_hash,state) VALUES(?1,?2,?3,?4,'queued')",
                    params![id, ordinal as i64, source.id, source.hash])?;
            }
            tx.commit()?;
        }
        let cancel = Arc::new(AtomicBool::new(false));
        state.active = Some((id.clone(), cancel.clone()));
        drop(state);
        self.spawn_video_similarity_scan(id.clone(), cancel);
        self.get_video_similarity_scan(&id)
    }

    pub fn get_video_similarity_scan(&self, scan_id: &str) -> Result<VideoScanProgress> {
        let connection = self.connection()?;
        connection.query_row(
            "SELECT s.id,s.state,s.reason,
              (SELECT COUNT(*) FROM video_similarity_scan_items WHERE scan_id=s.id),
              (SELECT COUNT(*) FROM video_similarity_scan_items WHERE scan_id=s.id AND state='ready'),
              (SELECT COUNT(*) FROM video_similarity_scan_items WHERE scan_id=s.id AND state='failed'),
              (SELECT COUNT(*) FROM video_similarity_scan_items WHERE scan_id=s.id AND state='skipped'),
              (SELECT COUNT(*) FROM video_similarity_reviews WHERE scan_id=s.id AND state='open'),
              (SELECT asset_id FROM video_similarity_scan_items WHERE scan_id=s.id AND state='running' LIMIT 1)
             FROM video_similarity_scans s WHERE s.id=?1", [scan_id], |r| Ok(VideoScanProgress {
                id:r.get(0)?,state:r.get(1)?,reason:r.get(2)?,total:r.get(3)?,completed:r.get(4)?,
                failed:r.get(5)?,skipped:r.get(6)?,candidate_count:r.get(7)?,active_asset_id:r.get(8)?,
             })).optional()?.ok_or(Error::NotFound)
    }

    pub fn latest_video_similarity_scan(&self) -> Result<Option<VideoScanProgress>> {
        let id: Option<String> = self
            .connection()?
            .query_row(
                "SELECT id FROM video_similarity_scans ORDER BY created_at DESC,id DESC LIMIT 1",
                [],
                |r| r.get(0),
            )
            .optional()?;
        id.as_deref()
            .map(|id| self.get_video_similarity_scan(id))
            .transpose()
    }

    pub fn cancel_video_similarity_scan(&self, scan_id: &str) -> Result<VideoScanProgress> {
        let state = self
            .video_similarity_scan
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some((id, cancel)) = &state.active {
            if id == scan_id {
                cancel.store(true, Ordering::Relaxed);
            }
        }
        drop(state);
        self.get_video_similarity_scan(scan_id)
    }

    pub fn resume_video_similarity_scan(&self, scan_id: &str) -> Result<VideoScanProgress> {
        let mut state = self
            .video_similarity_scan
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if state.active.is_some() {
            return Err(Error::Busy);
        }
        let status = self.get_video_similarity_scan(scan_id)?;
        if !matches!(status.state.as_str(), "paused" | "cancelled" | "failed") {
            return Err(Error::Conflict);
        }
        {
            let mut connection = self.connection()?;
            let tx = connection.transaction()?;
            tx.execute("UPDATE video_similarity_scan_items SET state='queued',reason=NULL WHERE scan_id=?1 AND state IN ('running','failed')", [scan_id])?;
            tx.execute("UPDATE video_similarity_scans SET state='queued',reason=NULL,updated_at=?2 WHERE id=?1", params![scan_id,chrono::Utc::now().to_rfc3339()])?;
            tx.commit()?;
        }
        let cancel = Arc::new(AtomicBool::new(false));
        state.active = Some((scan_id.to_owned(), cancel.clone()));
        drop(state);
        self.spawn_video_similarity_scan(scan_id.to_owned(), cancel);
        self.get_video_similarity_scan(scan_id)
    }

    fn spawn_video_similarity_scan(&self, id: String, cancel: Arc<AtomicBool>) {
        let library = self.clone();
        std::thread::spawn(move || {
            let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                library.run_video_similarity_scan(&id, &cancel)
            }));
            let (state, reason) = match outcome {
                Ok(Ok(())) => ("completed", None),
                Ok(Err("cancelled")) => ("cancelled", Some("cancelled")),
                Ok(Err("timeout")) => ("paused", Some("timeout")),
                Ok(Err(reason)) => ("failed", Some(reason)),
                Err(_) => ("failed", Some("processing_failed")),
            };
            if let Ok(connection) = library.connection() {
                let _ = connection.execute("UPDATE video_similarity_scans SET state=?2,reason=?3,updated_at=?4 WHERE id=?1", params![id,state,reason,chrono::Utc::now().to_rfc3339()]);
                let _ = connection.execute("UPDATE video_similarity_scan_items SET state='queued',reason=NULL WHERE scan_id=?1 AND state='running'", [&id]);
            }
            let mut state = library
                .video_similarity_scan
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if state
                .active
                .as_ref()
                .is_some_and(|(active, _)| active == &id)
            {
                state.active = None;
            }
        });
    }

    pub(super) fn video_similarity_source(&self, id: &str) -> Result<Source> {
        self.connection()?.query_row(
            "SELECT a.id,a.content_hash,a.relative_path,a.byte_size,v.duration_ms,a.width,a.height
             FROM assets a JOIN video_assets v ON v.asset_id=a.id WHERE a.id=?1 AND a.status='normal' AND a.media_kind='video'",
            [id], |r| Ok(Source {id:r.get(0)?,hash:r.get(1)?,path:r.get(2)?,
                bytes:u64::try_from(r.get::<_,i64>(3)?).map_err(|_|rusqlite::Error::InvalidQuery)?,
                duration_ms:u64::try_from(r.get::<_,i64>(4)?).map_err(|_|rusqlite::Error::InvalidQuery)?,
                width:r.get(5)?,height:r.get(6)?}))
            .optional()?.ok_or(Error::Stale)
    }

    pub(super) fn verify_video_similarity_source(
        &self,
        source: &Source,
        cancel: &AtomicBool,
        deadline: Instant,
    ) -> std::result::Result<VerifiedSource, &'static str> {
        if source.bytes > MAX_BYTES {
            return Err("out_of_scope");
        }
        let root =
            std::fs::canonicalize(self.root().join("assets")).map_err(|_| "source_changed")?;
        let path =
            std::fs::canonicalize(self.root().join(&source.path)).map_err(|_| "source_changed")?;
        if !path.starts_with(&root) || path == root {
            return Err("source_changed");
        }
        let mut options = OpenOptions::new();
        options.read(true);
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            // Other readers (FFmpeg) are allowed; writes and path replacement are not.
            options.share_mode(windows_sys::Win32::Storage::FileSystem::FILE_SHARE_READ);
        }
        let mut file = options.open(&path).map_err(|_| "source_changed")?;
        let metadata = file.metadata().map_err(|_| "source_changed")?;
        if !metadata.is_file() || metadata.len() != source.bytes {
            return Err("source_changed");
        }
        let mut hash = Sha256::new();
        let mut buffer = [0_u8; 64 * 1024];
        loop {
            check_budget(cancel, deadline)?;
            let n = file.read(&mut buffer).map_err(|_| "source_changed")?;
            if n == 0 {
                break;
            }
            hash.update(&buffer[..n]);
        }
        if hash
            .finalize()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>()
            != source.hash
        {
            return Err("source_changed");
        }
        Ok(VerifiedSource { _file: file, path })
    }

    fn run_video_similarity_scan(
        &self,
        scan_id: &str,
        cancel: &AtomicBool,
    ) -> std::result::Result<(), &'static str> {
        let deadline = Instant::now() + Duration::from_secs(600);
        check_budget(cancel, deadline)?;
        let tool = video_media::similarity_tool_profile()?;
        check_budget(cancel, deadline)?;
        let profile = format!("{PROFILE}/{tool}");
        self.connection().map_err(|_|"database_failed")?.execute(
            "UPDATE video_similarity_scans SET state='running',profile=?2,reason=NULL,updated_at=?3 WHERE id=?1",
            params![scan_id,profile,chrono::Utc::now().to_rfc3339()]).map_err(|_|"database_failed")?;
        let items = {
            let connection = self.connection().map_err(|_| "database_failed")?;
            let mut statement = connection.prepare("SELECT ordinal,asset_id,source_hash FROM video_similarity_scan_items WHERE scan_id=?1 ORDER BY ordinal").map_err(|_|"database_failed")?;
            let rows = statement
                .query_map([scan_id], |r| {
                    Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, Option<String>>(1)?,
                        r.get::<_, String>(2)?,
                    ))
                })
                .map_err(|_| "database_failed")?
                .collect::<std::result::Result<Vec<_>, _>>()
                .map_err(|_| "database_failed")?;
            rows
        };
        let sources = items
            .iter()
            .map(|(_, id, hash)| {
                id.as_deref()
                    .and_then(|id| self.video_similarity_source(id).ok())
                    .filter(|s| &s.hash == hash)
            })
            .collect::<Vec<_>>();
        let mut ready = Vec::new();
        for ((ordinal, _, _), source) in items.iter().zip(&sources) {
            check_budget(cancel, deadline)?;
            let Some(source) = source else {
                self.set_video_scan_item(scan_id, *ordinal, "failed", Some("source_changed"))?;
                continue;
            };
            if source.bytes > MAX_BYTES
                || !(2_000..=MAX_DURATION_MS).contains(&source.duration_ms)
                || !sources.iter().flatten().any(|other| {
                    other.id != source.id
                        && metadata_compatible(&source.metadata(), &other.metadata())
                })
            {
                self.set_video_scan_item(scan_id, *ordinal, "skipped", Some("out_of_scope"))?;
                continue;
            }
            self.set_video_scan_item(scan_id, *ordinal, "running", None)?;
            match self.fingerprint_video_source(source, &profile, cancel, deadline) {
                Ok(fingerprint) => {
                    if !has_usable_evidence(&fingerprint) {
                        self.set_video_scan_item(
                            scan_id,
                            *ordinal,
                            "skipped",
                            Some("insufficient_evidence"),
                        )?;
                        continue;
                    }
                    ready.push((source.clone(), fingerprint));
                    self.set_video_scan_item(scan_id, *ordinal, "ready", None)?;
                }
                Err("cancelled") => return Err("cancelled"),
                Err(reason) => {
                    self.set_video_scan_item(
                        scan_id,
                        *ordinal,
                        if matches!(reason, "unsupported_geometry" | "capacity_reached" | "insufficient_evidence") {
                            "skipped"
                        } else {
                            "failed"
                        },
                        Some(reason),
                    )?;
                    check_budget(cancel, deadline)?;
                }
            }
        }
        for left in 0..ready.len() {
            for right in left + 1..ready.len() {
                check_budget(cancel, deadline)?;
                let ((a, af), (b, bf)) = if ready[left].0.hash < ready[right].0.hash {
                    (&ready[left], &ready[right])
                } else {
                    (&ready[right], &ready[left])
                };
                if let Some(evidence) = compare(af, bf, &profile) {
                    self.save_video_review(scan_id, a, b, &evidence)
                        .map_err(|_| "database_failed")?;
                }
            }
        }
        Ok(())
    }

    fn set_video_scan_item(
        &self,
        id: &str,
        ordinal: i64,
        state: &str,
        reason: Option<&str>,
    ) -> std::result::Result<(), &'static str> {
        self.connection().map_err(|_|"database_failed")?.execute(
            "UPDATE video_similarity_scan_items SET state=?3,reason=?4 WHERE scan_id=?1 AND ordinal=?2",params![id,ordinal,state,reason])
            .map_err(|_|"database_failed")?;
        Ok(())
    }

    fn fingerprint_video_source(
        &self,
        source: &Source,
        profile: &str,
        cancel: &AtomicBool,
        scan_deadline: Instant,
    ) -> std::result::Result<VideoFingerprint, &'static str> {
        let deadline = scan_deadline.min(Instant::now() + Duration::from_secs(60));
        let verified = self.verify_video_similarity_source(source, cancel, deadline)?;
        if let Some(cached) = self
            .load_video_fingerprint(source, profile)
            .map_err(|_| "database_failed")?
        {
            return Ok(cached);
        }
        let has_capacity: bool = self.connection().map_err(|_|"database_failed")?.query_row(
            "SELECT (SELECT COUNT(*) FROM video_similarity_fingerprints)<10000 OR EXISTS(SELECT 1 FROM video_similarity_fingerprints WHERE asset_id=?1)", [&source.id], |r|r.get(0)).map_err(|_|"database_failed")?;
        if !has_capacity {
            return Err("capacity_reached");
        }
        {
            let _guard = self.acquire_video_similarity_tool(cancel, deadline)?;
            video_media::inspect_similarity_geometry(
                &verified.path,
                cancel,
                deadline.min(Instant::now() + Duration::from_secs(10)),
            )?;
        }
        let mut result = source.metadata();
        for at_ms in sample_times(source.duration_ms) {
            check_budget(cancel, deadline)?;
            let image = {
                let _guard = self.acquire_video_similarity_tool(cancel, deadline)?;
                video_media::extract_similarity_frame(
                    &verified.path,
                    at_ms,
                    cancel,
                    deadline.min(Instant::now() + Duration::from_secs(5)),
                )?
            };
            result.frames.push(FrameFingerprint {
                at_ms,
                hash: fingerprint(&image).map_err(|_| "decode_failed")?,
            });
        }
        check_budget(cancel, deadline)?;
        let mut connection = self.connection().map_err(|_| "database_failed")?;
        let tx = connection.transaction().map_err(|_| "database_failed")?;
        let valid: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM assets WHERE id=?1 AND content_hash=?2 AND status='normal')",params![source.id,source.hash],|r|r.get(0)).map_err(|_|"database_failed")?;
        if !valid {
            return Err("source_changed");
        }
        tx.execute(
            "DELETE FROM video_similarity_fingerprints WHERE asset_id=?1",
            [&source.id],
        )
        .map_err(|_| "database_failed")?;
        tx.execute("INSERT INTO video_similarity_fingerprints(asset_id,source_hash,profile,duration_ms,width,height,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7)",
            params![source.id,source.hash,profile,i64::try_from(source.duration_ms).map_err(|_|"out_of_scope")?,source.width,source.height,chrono::Utc::now().to_rfc3339()]).map_err(|_|"database_failed")?;
        for (index, frame) in result.frames.iter().enumerate() {
            tx.execute("INSERT INTO video_similarity_frames(asset_id,sample_index,requested_at_ms,pdq,quality) VALUES(?1,?2,?3,?4,?5)",
                params![source.id,index as i64,i64::try_from(frame.at_ms).map_err(|_|"out_of_scope")?,frame.hash.to_stored_bytes().as_slice(),frame.hash.quality]).map_err(|_|"database_failed")?;
        }
        tx.commit().map_err(|_| "database_failed")?;
        Ok(result)
    }

    fn acquire_video_similarity_tool(
        &self,
        cancel: &AtomicBool,
        deadline: Instant,
    ) -> std::result::Result<std::sync::MutexGuard<'_, ()>, &'static str> {
        loop {
            check_budget(cancel, deadline)?;
            match self.video_lock.try_lock() {
                Ok(guard) => return Ok(guard),
                Err(std::sync::TryLockError::Poisoned(error)) => return Ok(error.into_inner()),
                Err(std::sync::TryLockError::WouldBlock) => {
                    std::thread::sleep(Duration::from_millis(20))
                }
            }
        }
    }

    pub(super) fn load_video_fingerprint(
        &self,
        source: &Source,
        profile: &str,
    ) -> Result<Option<VideoFingerprint>> {
        let connection = self.connection()?;
        let exists:bool = connection.query_row("SELECT EXISTS(SELECT 1 FROM video_similarity_fingerprints WHERE asset_id=?1 AND source_hash=?2 AND profile=?3)",params![source.id,source.hash,profile],|r|r.get(0))?;
        if !exists {
            return Ok(None);
        }
        let mut statement = connection.prepare("SELECT sample_index,requested_at_ms,pdq,quality FROM video_similarity_frames WHERE asset_id=?1 ORDER BY sample_index")?;
        let rows = statement
            .query_map([&source.id], |r| {
                Ok((
                    usize::try_from(r.get::<_, i64>(0)?)
                        .map_err(|_| rusqlite::Error::InvalidQuery)?,
                    u64::try_from(r.get::<_, i64>(1)?)
                        .map_err(|_| rusqlite::Error::InvalidQuery)?,
                    r.get::<_, Vec<u8>>(2)?,
                    r.get::<_, u8>(3)?,
                ))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        if rows.len() != SAMPLES {
            return Ok(None);
        }
        let mut result = source.metadata();
        let times = sample_times(source.duration_ms);
        let mut indexes = HashSet::new();
        for (index, at_ms, bytes, quality) in rows {
            if index >= SAMPLES || !indexes.insert(index) || at_ms != times[index] {
                return Ok(None);
            }
            let Ok(hash) = ImageFingerprint::from_stored_bytes(&bytes, quality) else {
                return Ok(None);
            };
            result.frames.push(FrameFingerprint { at_ms, hash });
        }
        Ok(Some(result))
    }
}

fn check_budget(cancel: &AtomicBool, deadline: Instant) -> std::result::Result<(), &'static str> {
    if cancel.load(Ordering::Relaxed) {
        Err("cancelled")
    } else if Instant::now() >= deadline {
        Err("timeout")
    } else {
        Ok(())
    }
}
