//! PC work records and bounded, resumable cover focus. The Collections replica publishes
//! them only to servers that advertise the matching replica feature.
use super::{
    character_worker::RuntimeConfig,
    collection::{normalized_description, validated_personal_rating},
    error::LibraryError,
    Library,
};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{
    io::Read,
    process::{Command, Stdio},
    sync::{mpsc, Mutex, TryLockError},
    time::{Duration, Instant},
};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkRecord {
    pub status: Option<String>,
    pub owned_platform: Option<String>,
    pub my_score: Option<f64>,
    pub memo: Option<String>,
}
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ShelfCase {
    pub collection_id: String,
    pub owned_platform: Option<String>,
    pub spine_artwork_id: Option<String>,
}
#[derive(Deserialize)]
#[serde(tag = "field", rename_all = "camelCase")]
pub enum WorkRecordEdit {
    Status { value: Option<String> },
    OwnedPlatform { value: Option<String> },
    MyScore { value: Option<f64> },
    Memo { value: Option<String> },
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CoverFocus {
    pub volume_id: String,
    pub cover_artwork_id: String,
    pub focus_x: Option<f64>,
    pub method: String,
}
#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FocusJobResult {
    pub busy: bool,
    pub processed: usize,
    pub failed: usize,
}
/// Work-record statuses per Collection type; the Collections replica server checks the same lists.
pub(crate) fn allowed_statuses(kind: &str) -> &'static [&'static str] {
    match kind {
        "game" => &["done", "playing", "unplayed"],
        "av" => &["watched", "unwatched"],
        "movie" => &["watched", "watching", "unwatched"],
        "manga" => &["collecting", "complete"],
        _ => &[],
    }
}
/// The owned-platform limit (characters), shared with the replica server and the tablet.
pub(crate) const MAX_PLATFORM_CHARS: usize = 200;
static FOCUS_JOB: Mutex<()> = Mutex::new(());
const BATCH_SIZE: usize = 16;

/// Record a work's 상태 for a Collection of type `kind`; returns whether the row changed.
/// A value the type does not take is refused. The PC panel and a mobile edit (personal-edit
/// version 3) both write through here, so an unchanged value never dirties the publication.
pub(crate) fn write_record_status(
    connection: &rusqlite::Connection,
    id: &str,
    kind: &str,
    value: Option<&str>,
) -> Result<bool, LibraryError> {
    if !matches!(kind, "game" | "av" | "manga" | "movie") {
        return Err(LibraryError::InvalidCollectionType);
    }
    if value.is_some_and(|v| !allowed_statuses(kind).contains(&v)) {
        return Err(LibraryError::InvalidCollectionMetadata);
    }
    let changed = match value {
        // Clearing never creates a row: an absent record already reads as 미입력.
        None => connection.execute(
            "UPDATE collection_pc_records SET status=NULL WHERE collection_id=?1 AND status IS NOT NULL",
            [id],
        )?,
        Some(value) => connection.execute(
            "INSERT INTO collection_pc_records(collection_id,status) VALUES(?1,?2)
             ON CONFLICT(collection_id) DO UPDATE SET status=excluded.status WHERE status IS NOT excluded.status",
            params![id, value],
        )?,
    };
    Ok(changed > 0)
}

/// Record a game's owned 기기 (trimmed, at most [`MAX_PLATFORM_CHARS`], empty clears).
pub(crate) fn write_record_platform(
    connection: &rusqlite::Connection,
    id: &str,
    kind: &str,
    value: Option<String>,
) -> Result<bool, LibraryError> {
    if kind != "game" {
        return Err(LibraryError::InvalidCollectionType);
    }
    let value = normalized_description(value)?;
    if value
        .as_ref()
        .is_some_and(|v| v.chars().count() > MAX_PLATFORM_CHARS)
    {
        return Err(LibraryError::InvalidCollectionMetadata);
    }
    let changed = match value {
        None => connection.execute(
            "UPDATE collection_pc_records SET owned_platform=NULL WHERE collection_id=?1 AND owned_platform IS NOT NULL",
            [id],
        )?,
        Some(value) => connection.execute(
            "INSERT INTO collection_pc_records(collection_id,owned_platform) VALUES(?1,?2)
             ON CONFLICT(collection_id) DO UPDATE SET owned_platform=excluded.owned_platform WHERE owned_platform IS NOT excluded.owned_platform",
            params![id, value],
        )?,
    };
    Ok(changed > 0)
}

impl Library {
    pub fn collection_work_record(&self, id: &str) -> Result<WorkRecord, LibraryError> {
        self.connection()?.query_row("SELECT p.status,p.owned_platform,c.my_score,c.description FROM collections c LEFT JOIN collection_pc_records p ON p.collection_id=c.id WHERE c.id=?1",[id],|r|Ok(WorkRecord{status:r.get(0)?,owned_platform:r.get(1)?,my_score:r.get(2)?,memo:r.get(3)?})).optional()?.ok_or(LibraryError::CollectionNotFound)
    }
    /// What each shelf case prints, for a whole list in one read: the owned device and the
    /// spine artwork (the selected spine, else the oldest). Unknown ids are left out.
    pub fn collection_shelf_cases(&self, ids: &[String]) -> Result<Vec<ShelfCase>, LibraryError> {
        let ids = serde_json::to_string(ids).map_err(|_| rusqlite::Error::InvalidQuery)?;
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT c.id, p.owned_platform,
                (SELECT a.id FROM collection_work_artworks a
                 WHERE a.collection_id = c.id AND a.kind = 'spine'
                 ORDER BY a.selected DESC, a.created_at, a.id LIMIT 1)
             FROM collections c LEFT JOIN collection_pc_records p ON p.collection_id = c.id
             WHERE c.id IN (SELECT value FROM json_each(?1))",
        )?;
        let cases = statement
            .query_map([ids], |r| {
                Ok(ShelfCase {
                    collection_id: r.get(0)?,
                    owned_platform: r.get(1)?,
                    spine_artwork_id: r.get(2)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(cases)
    }
    pub fn save_collection_work_record(
        &self,
        id: &str,
        edit: WorkRecordEdit,
    ) -> Result<WorkRecord, LibraryError> {
        let mut c = self.connection()?;
        let tx = c.transaction()?;
        let authority = super::collection_authority::collection_write_status(&tx)?;
        let before = super::collection_authority::editable_work(&tx, id)?;
        let kind: String = tx
            .query_row("SELECT type FROM collections WHERE id=?1", [id], |r| {
                r.get(0)
            })
            .optional()?
            .ok_or(LibraryError::CollectionNotFound)?;
        if !matches!(kind.as_str(), "game" | "av" | "manga" | "movie") {
            return Err(LibraryError::InvalidCollectionType);
        }
        match edit {
            WorkRecordEdit::Status { value } => {
                write_record_status(&tx, id, &kind, value.as_deref())?;
            }
            WorkRecordEdit::OwnedPlatform { value } => {
                write_record_platform(&tx, id, &kind, value)?;
            }
            // Inactive personal fields retain the legacy handshake and triggers.
            WorkRecordEdit::MyScore { value } => {
                let value = validated_personal_rating(value)?;
                tx.execute(
                    "UPDATE collections SET my_score=?2,updated_at=?3 WHERE id=?1",
                    params![id, value, chrono::Utc::now().to_rfc3339()],
                )?;
            }
            WorkRecordEdit::Memo { value } => {
                let value = normalized_description(value)?;
                tx.execute(
                    "UPDATE collections SET description=?2,updated_at=?3 WHERE id=?1",
                    params![id, value, chrono::Utc::now().to_rfc3339()],
                )?;
            }
        }
        super::collection_authority::enqueue_work_changes(&tx, &authority, id, &before)?;
        tx.commit()?;
        drop(c);
        self.collection_work_record(id)
    }
    pub fn collection_cover_focus(&self, id: &str) -> Result<Vec<CoverFocus>, LibraryError> {
        let c = self.connection()?;
        let mut s=c.prepare("SELECT f.volume_id,f.cover_artwork_id,f.focus_x,f.method FROM collection_volume_cover_focus f JOIN collection_volumes v ON v.id=f.volume_id AND v.cover_artwork_id=f.cover_artwork_id WHERE v.collection_id=?1 ORDER BY v.edition_index,v.volume_number")?;
        let rows = s
            .query_map([id], |r| {
                Ok(CoverFocus {
                    volume_id: r.get(0)?,
                    cover_artwork_id: r.get(1)?,
                    focus_x: r.get(2)?,
                    method: r.get(3)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }
    pub(crate) fn store_cover_focus(&self, focus: &CoverFocus) -> Result<bool, LibraryError> {
        super::collection_authority::fence_collection_operation(&*self.connection()?)?;
        if focus
            .focus_x
            .is_some_and(|v| !v.is_finite() || !(0.0..=1.0).contains(&v))
            || !matches!(focus.method.as_str(), "head" | "close-up" | "body" | "none")
            || (focus.method == "none") != focus.focus_x.is_none()
        {
            return Err(LibraryError::InvalidCollectionMetadata);
        }
        let changed=self.connection()?.execute("INSERT INTO collection_volume_cover_focus(volume_id,cover_artwork_id,focus_x,method) SELECT v.id,v.cover_artwork_id,?3,?4 FROM collection_volumes v JOIN collections c ON c.id=v.collection_id WHERE v.id=?1 AND v.cover_artwork_id=?2 AND c.type='manga' ON CONFLICT(volume_id) DO UPDATE SET cover_artwork_id=excluded.cover_artwork_id,focus_x=excluded.focus_x,method=excluded.method",params![focus.volume_id,focus.cover_artwork_id,focus.focus_x,focus.method])?;
        Ok(changed > 0)
    }
    /// Explicit screen-triggered job, not library-open/startup maintenance. One detector
    /// child across all libraries; at most sixteen covers per invocation, each with a deadline.
    /// Completed/no-person rows are skipped. Failures remain eligible on the next open.
    pub fn compute_collection_cover_focus(
        &self,
        id: &str,
        config: &RuntimeConfig,
        on_focus: &dyn Fn(CoverFocus),
    ) -> Result<FocusJobResult, LibraryError> {
        super::collection_authority::fence_collection_operation(&*self.connection()?)?;
        let _guard = match FOCUS_JOB.try_lock() {
            Ok(guard) => guard,
            Err(TryLockError::WouldBlock) => {
                return Ok(FocusJobResult {
                    busy: true,
                    ..Default::default()
                })
            }
            Err(TryLockError::Poisoned(error)) => error.into_inner(),
        };
        let rows = {
            let c = self.connection()?;
            let mut s=c.prepare("SELECT v.id,v.cover_artwork_id,a.relative_path FROM collection_volumes v JOIN collections c ON c.id=v.collection_id JOIN collection_work_artworks a ON a.id=v.cover_artwork_id WHERE v.collection_id=?1 AND c.type='manga' AND NOT EXISTS(SELECT 1 FROM collection_volume_cover_focus f WHERE f.volume_id=v.id AND f.cover_artwork_id=v.cover_artwork_id) ORDER BY v.edition_index,v.volume_number LIMIT ?2")?;
            let rows = s
                .query_map(params![id, BATCH_SIZE as i64], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        };
        let mut result = FocusJobResult::default();
        for (volume_id, cover_artwork_id, relative) in rows {
            result.processed += 1;
            // Use the same containment/file checks as artwork serving before giving Python a path.
            let focus = self.open_library_media(&relative).and_then(|_| {
                let path = self.root().join(&relative);
                let (focus_x, method) =
                    detect_focus(config, &path).ok_or(LibraryError::InvalidCollectionMetadata)?;
                let focus = CoverFocus {
                    volume_id,
                    cover_artwork_id,
                    focus_x,
                    method,
                };
                self.store_cover_focus(&focus)
                    .map(|stored| stored.then_some(focus))
            });
            match focus {
                Ok(Some(focus)) => on_focus(focus),
                Ok(None) => {}
                Err(_) => result.failed += 1,
            }
        }
        Ok(result)
    }
}
fn detect_focus(config: &RuntimeConfig, path: &std::path::Path) -> Option<(Option<f64>, String)> {
    let mut command = Command::new(&config.python);
    command
        .arg("-B")
        .arg(config.script.with_file_name("cover_focus.py"))
        .arg("--models")
        .arg(&config.models)
        .arg("--image")
        .arg(path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .env("OPENBLAS_NUM_THREADS", "1")
        .env("OMP_NUM_THREADS", "1")
        .env("MKL_NUM_THREADS", "1")
        .env("ORT_DISABLE_TELEMETRY", "1");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command.spawn().ok()?;
    let stdout = child.stdout.take()?;
    let (sender, receiver) = mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let read = stdout.take(4097).read_to_end(&mut bytes);
        let _ = sender.send(read.ok().filter(|_| bytes.len() <= 4096).map(|_| bytes));
    });
    let started = Instant::now();
    let bytes = receiver
        .recv_timeout(Duration::from_secs(20))
        .ok()
        .flatten();
    if bytes.is_none() {
        let _ = child.kill();
    }
    let success = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.success(),
            Ok(None) if started.elapsed() < Duration::from_secs(20) => {
                std::thread::sleep(Duration::from_millis(20))
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break false;
            }
        }
    };
    if !success {
        return None;
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Output {
        focus_x: Option<f64>,
        method: String,
    }
    let output: Output = serde_json::from_slice(&bytes?).ok()?;
    Some((output.focus_x, output.method))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (tempfile::TempDir, Library) {
        let t = tempfile::tempdir().unwrap();
        let l = Library::open(t.path()).unwrap();
        l.connection().unwrap().execute_batch("INSERT INTO collections(id,name,type,description,my_score,created_at,updated_at) VALUES('g','Game','game','memo',3.5,'c','u'),('m','Manga','manga',NULL,NULL,'c','u'); INSERT INTO collection_work_artworks(id,collection_id,provider,provider_image_id,kind,relative_path,mime_type,width,height,created_at,updated_at) VALUES('a','m','local','a','volume_cover','cover.png','image/png',400,600,'c','u'); INSERT INTO collection_volumes(id,collection_id,volume_number,edition_index,sort_order,cover_artwork_id,created_at,updated_at) VALUES('v','m',1,0,10,'a','c','u');").unwrap();
        (t, l)
    }
    #[test]
    fn collection_pc_personal_fields_saved_read_and_isolated() {
        let (_t, l) = fixture();
        let before = serde_json::to_value(l.get_collection("g").unwrap()).unwrap();
        l.save_collection_work_record(
            "g",
            WorkRecordEdit::Status {
                value: Some("playing".into()),
            },
        )
        .unwrap();
        let r = l
            .save_collection_work_record(
                "g",
                WorkRecordEdit::OwnedPlatform {
                    value: Some("Switch 2".into()),
                },
            )
            .unwrap();
        assert_eq!(r.status.as_deref(), Some("playing"));
        assert_eq!(r.owned_platform.as_deref(), Some("Switch 2"));
        assert_eq!(r.my_score, Some(3.5));
        assert_eq!(r.memo.as_deref(), Some("memo"));
        assert_eq!(
            serde_json::to_value(l.get_collection("g").unwrap()).unwrap(),
            before
        );
        assert!(l
            .save_collection_work_record(
                "g",
                WorkRecordEdit::Status {
                    value: Some("watched".into())
                }
            )
            .is_err());
        l.save_collection_work_record(
            "g",
            WorkRecordEdit::Memo {
                value: Some("changed".into()),
            },
        )
        .unwrap();
        assert_eq!(l.collection_work_record("g").unwrap().my_score, Some(3.5));
        l.save_collection_work_record("g", WorkRecordEdit::MyScore { value: Some(4.5) })
            .unwrap();
        assert_eq!(
            l.collection_work_record("g").unwrap().memo.as_deref(),
            Some("changed")
        );
    }
    #[test]
    fn collection_pc_shelf_cases_read_owned_device_and_chosen_spine_in_one_call() {
        let (_t, l) = fixture();
        l.connection().unwrap().execute_batch("INSERT INTO collections(id,name,type,created_at,updated_at) VALUES('h','Other','game','c','u'); INSERT INTO collection_work_artworks(id,collection_id,provider,provider_image_id,kind,relative_path,mime_type,width,height,selected,created_at,updated_at) VALUES('s-old','g','local','s-old','spine','a.png','image/png',40,600,0,'1','u'),('s-new','g','local','s-new','spine','b.png','image/png',40,600,0,'2','u'),('c','g','local','c','cover','c.png','image/png',400,600,1,'0','u'),('h-old','h','local','h-old','spine','d.png','image/png',40,600,0,'1','u'),('h-picked','h','local','h-picked','spine','e.png','image/png',40,600,1,'2','u');").unwrap();
        l.save_collection_work_record(
            "g",
            WorkRecordEdit::OwnedPlatform {
                value: Some("PS5".into()),
            },
        )
        .unwrap();
        let ids = ["g", "h", "m", "missing"].map(String::from);
        let mut cases = l.collection_shelf_cases(&ids).unwrap();
        cases.sort_by(|a, b| a.collection_id.cmp(&b.collection_id));
        let case = |id: &str, owned: Option<&str>, spine: Option<&str>| ShelfCase {
            collection_id: id.into(),
            owned_platform: owned.map(Into::into),
            spine_artwork_id: spine.map(Into::into),
        };
        // Oldest spine without a selection; the selected spine wins over an older one; no spine and no record read as none.
        assert_eq!(
            cases,
            vec![
                case("g", Some("PS5"), Some("s-old")),
                case("h", None, Some("h-picked")),
                case("m", None, None),
            ]
        );
        assert!(l.collection_shelf_cases(&[]).unwrap().is_empty());
    }
    #[test]
    fn collection_pc_focus_stored_read_centre_and_stale_cover() {
        let (_t, l) = fixture();
        let mut f = CoverFocus {
            volume_id: "v".into(),
            cover_artwork_id: "a".into(),
            focus_x: Some(0.3),
            method: "head".into(),
        };
        assert!(l.collection_cover_focus("m").unwrap().is_empty());
        assert!(l.store_cover_focus(&f).unwrap());
        assert_eq!(l.collection_cover_focus("m").unwrap(), vec![f.clone()]);
        f.focus_x = None;
        f.method = "none".into();
        l.store_cover_focus(&f).unwrap();
        assert_eq!(
            l.collection_cover_focus("m").unwrap()[0]
                .focus_x
                .unwrap_or(0.5),
            0.5
        );
        f.focus_x = Some(2.0);
        assert!(l.store_cover_focus(&f).is_err());
        l.connection()
            .unwrap()
            .execute(
                "UPDATE collection_volumes SET cover_artwork_id=NULL WHERE id='v'",
                [],
            )
            .unwrap();
        f.focus_x = None;
        assert!(!l.store_cover_focus(&f).unwrap());
        assert!(l.collection_cover_focus("m").unwrap().is_empty());
    }
    #[test]
    #[cfg(unix)]
    fn collection_pc_focus_job_is_bounded_resumable_serial_and_failure_keeps_centre() {
        let (t, l) = fixture();
        let script = t.path().join("cover_focus.py");
        std::fs::write(t.path().join("cover.png"), b"fixture bytes").unwrap();
        std::fs::write(&script, "print('{\"focusX\":0.25,\"method\":\"head\"}')").unwrap();
        let config = RuntimeConfig {
            performance: crate::performance::Profile::Laptop.budgets(),
            python: std::path::PathBuf::from("/usr/bin/python3"),
            script: t.path().join("scan_worker.py"),
            models: t.path().into(),
            augmentation_model: None,
            shadow_model: None,
            s36_shadow_disabled: true,
            s36: Default::default(),
        };
        for n in 2..=17 {
            l.connection().unwrap().execute("INSERT INTO collection_volumes(id,collection_id,volume_number,edition_index,sort_order,cover_artwork_id,created_at,updated_at) VALUES(?1,'m',?2,0,?2,'a','c','u')",params![format!("v{n}"),n]).unwrap();
        }
        {
            let _guard = FOCUS_JOB.lock().unwrap();
            assert!(
                l.compute_collection_cover_focus("m", &config, &|_| panic!(
                    "busy job cannot report"
                ))
                .unwrap()
                .busy
            );
        }
        // Invalid output never stores a guessed focus; retry remains possible.
        std::fs::write(&script, "print('{\"focusX\":2.0,\"method\":\"head\"}')").unwrap();
        let failed = l
            .compute_collection_cover_focus("m", &config, &|_| {
                panic!("invalid output cannot report")
            })
            .unwrap();
        assert_eq!((failed.processed, failed.failed), (16, 16));
        assert!(l.collection_cover_focus("m").unwrap().is_empty());
        std::fs::write(&script, "print('{\"focusX\":0.25,\"method\":\"head\"}')").unwrap();
        let first = l
            .compute_collection_cover_focus("m", &config, &|_| {})
            .unwrap();
        assert_eq!((first.processed, first.failed), (16, 0));
        assert_eq!(l.collection_cover_focus("m").unwrap().len(), 16);
        let second = l
            .compute_collection_cover_focus("m", &config, &|_| {})
            .unwrap();
        assert_eq!((second.processed, second.failed), (1, 0));
        assert_eq!(
            l.compute_collection_cover_focus("m", &config, &|_| {})
                .unwrap()
                .processed,
            0
        );
    }
}
