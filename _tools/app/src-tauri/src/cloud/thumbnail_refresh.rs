use std::{
    collections::BTreeMap,
    fs,
    path::Path,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Mutex,
    },
    thread,
};

use rusqlite::{Connection, OpenFlags};

use crate::library::{credential, error::LibraryError};

use super::client::CloudClient;

const DATABASE_NAME: &str = "library.sqlite";
const REMOTE_BATCH_SIZE: usize = 50;
const UPLOAD_WORKERS: usize = 12;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CloudThumbnailRefreshOptions {
    pub apply: bool,
    pub limit: Option<usize>,
    pub all: bool,
}

impl CloudThumbnailRefreshOptions {
    pub fn dry_run() -> Self {
        Self {
            apply: false,
            limit: None,
            all: false,
        }
    }
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct CloudThumbnailRefreshReport {
    pub eligible: usize,
    pub current: usize,
    pub selected: usize,
    pub uploaded: usize,
    pub failed: usize,
    pub bytes_eligible: u64,
    pub bytes_selected: u64,
    pub failures: Vec<String>,
}

#[derive(Debug, Clone)]
struct Candidate {
    asset_id: String,
    thumbnail_relative_path: String,
    bytes: u64,
}

pub fn refresh_cloud_thumbnails(
    root: &Path,
    options: CloudThumbnailRefreshOptions,
) -> Result<CloudThumbnailRefreshReport, LibraryError> {
    validate_options(options)?;
    let database = root.join(DATABASE_NAME);
    let connection = Connection::open_with_flags(&database, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let (enabled, base_url): (i64, Option<String>) = connection.query_row(
        "SELECT cloud_sync_enabled, cloud_api_base_url FROM library_settings WHERE singleton = 1",
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    if enabled == 0 {
        return Err(LibraryError::InvalidCloudSyncConfig);
    }
    let base_url = base_url.ok_or(LibraryError::InvalidCloudSyncConfig)?;
    let candidates = load_candidates(root, &connection)?;

    let mut report = CloudThumbnailRefreshReport {
        eligible: candidates.len(),
        bytes_eligible: candidates.iter().map(|candidate| candidate.bytes).sum(),
        ..CloudThumbnailRefreshReport::default()
    };
    if !options.apply {
        report.selected = report.eligible;
        report.bytes_selected = report.bytes_eligible;
        return Ok(report);
    }

    // This standalone maintenance command has no AppHandle. Resolve the same native
    // config location as Tauri; an unavailable location must never enable uploads.
    let config_dir = if cfg!(windows) {
        std::env::var_os("APPDATA").map(std::path::PathBuf::from)
    } else {
        std::env::var_os("XDG_CONFIG_HOME").map(std::path::PathBuf::from)
            .filter(|path| path.is_absolute())
            .or_else(|| std::env::var_os("HOME").map(|home| std::path::PathBuf::from(home).join(".config")))
    }.filter(|path| path.is_absolute()).ok_or(LibraryError::CloudSyncHeld)?;
    let config: serde_json::Value = serde_json::from_str(include_str!("../../tauri.conf.json"))
        .map_err(|_| LibraryError::CloudSyncHeld)?;
    let identifier = config["identifier"].as_str().ok_or(LibraryError::CloudSyncHeld)?;
    let settings = config_dir.join(identifier).join("library-machine.json");
    require_machine_settings(&settings)?;
    let gate = crate::library::sync_hold::process_session().gate(
        settings,
        crate::library::library_id_on(&connection)?,
        crate::library::sync_hold::endpoint_key(&base_url)?,
    );
    let client = CloudClient::with_gate(&base_url, gate)?;
    client.ensure_send()?;
    let token = credential::read_cloud_api_token_os()?;
    let token = token.expose();
    let selected = select_stale_candidates(
        root,
        &client,
        &token,
        &candidates,
        options.limit,
        &mut report,
    )?;
    report.selected = selected.len();
    report.bytes_selected = selected.iter().map(|candidate| candidate.bytes).sum();
    upload_candidates(root, &client, &token, &selected, &mut report);
    Ok(report)
}

fn require_machine_settings(path: &Path) -> Result<(), LibraryError> {
    if !path.is_file() {
        return Err(LibraryError::CloudSyncHeld);
    }
    Ok(())
}

fn load_candidates(root: &Path, connection: &Connection) -> Result<Vec<Candidate>, LibraryError> {
    let mut statement = connection.prepare(
        "SELECT asset.id, asset.thumbnail_relative_path
         FROM assets AS asset
         WHERE asset.status = 'normal'
           AND asset.media_kind IN ('image', 'gif')
           AND asset.thumbnail_relative_path IS NOT NULL
           AND EXISTS (
             SELECT 1 FROM cloud_sync_queue AS queue
             WHERE queue.entity_type = 'asset'
               AND queue.entity_id = asset.id
               AND queue.operation = 'upsert'
               AND queue.status = 'synced'
           )
         ORDER BY asset.id",
    )?;
    let rows = statement.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    let mut candidates = Vec::new();
    for row in rows {
        let (asset_id, relative_path) = row?;
        let path = root.join(&relative_path);
        let metadata = match fs::metadata(&path) {
            Ok(metadata) if metadata.is_file() && metadata.len() > 0 => metadata,
            _ => continue,
        };
        candidates.push(Candidate {
            asset_id,
            thumbnail_relative_path: relative_path,
            bytes: metadata.len(),
        });
    }
    Ok(candidates)
}

fn select_stale_candidates(
    root: &Path,
    client: &CloudClient,
    token: &str,
    candidates: &[Candidate],
    limit: Option<usize>,
    report: &mut CloudThumbnailRefreshReport,
) -> Result<Vec<Candidate>, LibraryError> {
    let mut selected = Vec::new();
    for chunk in candidates.chunks(REMOTE_BATCH_SIZE) {
        let ids = chunk
            .iter()
            .map(|candidate| candidate.asset_id.clone())
            .collect::<Vec<_>>();
        let remote = client
            .thumbnail_remote_hashes(&ids, token)?
            .into_iter()
            .collect::<BTreeMap<_, _>>();
        for candidate in chunk {
            let local = fs::read(root.join(&candidate.thumbnail_relative_path))
                .map(|bytes| super::thumbnail_upload::digest(&bytes));
            let local = match local {
                Ok(hash) => hash,
                Err(error) => {
                    report.failed += 1;
                    report.failures.push(format!(
                        "{}: local read failed: {error}",
                        candidate.asset_id
                    ));
                    continue;
                }
            };
            match remote.get(&candidate.asset_id) {
                Some(Ok(remote_hash)) if *remote_hash == local => {
                    report.current += 1;
                }
                Some(Ok(_)) => {
                    selected.push(candidate.clone());
                    if limit.is_some_and(|limit| selected.len() >= limit) {
                        return Ok(selected);
                    }
                }
                Some(Err(error)) => {
                    report.failed += 1;
                    report.failures.push(format!(
                        "{}: remote preflight failed: {error}",
                        candidate.asset_id
                    ));
                }
                None => {
                    report.failed += 1;
                    report.failures.push(format!(
                        "{}: remote preflight response missing",
                        candidate.asset_id
                    ));
                }
            }
        }
    }
    Ok(selected)
}

fn upload_candidates(
    root: &Path,
    client: &CloudClient,
    token: &str,
    candidates: &[Candidate],
    report: &mut CloudThumbnailRefreshReport,
) {
    if candidates.is_empty() {
        return;
    }
    let next = AtomicUsize::new(0);
    let outcomes = Mutex::new(Vec::with_capacity(candidates.len()));
    let workers = UPLOAD_WORKERS.min(candidates.len());
    thread::scope(|scope| {
        for _ in 0..workers {
            scope.spawn(|| loop {
                let index = next.fetch_add(1, Ordering::Relaxed);
                let Some(candidate) = candidates.get(index) else {
                    break;
                };
                let outcome = upload_candidate(root, client, token, candidate);
                outcomes
                    .lock()
                    .expect("thumbnail refresh outcome lock")
                    .push((candidate.asset_id.clone(), outcome));
            });
        }
    });
    for (asset_id, outcome) in outcomes.into_inner().expect("thumbnail refresh outcomes") {
        match outcome {
            Ok(()) => report.uploaded += 1,
            Err(error) => {
                report.failed += 1;
                report.failures.push(format!("{asset_id}: {error}"));
            }
        }
    }
}

fn upload_candidate(
    root: &Path,
    client: &CloudClient,
    token: &str,
    candidate: &Candidate,
) -> Result<(), String> {
    let path = root.join(&candidate.thumbnail_relative_path);
    let bytes = fs::read(&path).map_err(|error| format!("read failed: {error}"))?;
    let journal = client
        .thumbnail_journal(root, &format!("refresh:{}", candidate.asset_id))
        .map_err(|error| error.to_string())?;
    super::thumbnail_upload::refresh(client, &journal, &candidate.asset_id, bytes, token)
        .map_err(|error| error.to_string())
}

fn validate_options(options: CloudThumbnailRefreshOptions) -> Result<(), LibraryError> {
    if options.apply && options.limit.is_none() && !options.all {
        return Err(LibraryError::InvalidCloudSyncConfig);
    }
    if !options.apply && (options.limit.is_some() || options.all) {
        return Err(LibraryError::InvalidCloudSyncConfig);
    }
    if options.limit == Some(0) || (options.limit.is_some() && options.all) {
        return Err(LibraryError::InvalidCloudSyncConfig);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refresh_selects_same_size_different_bytes_and_skips_identical_bytes() {
        use serde_json::json;
        use tiny_http::{Response, Server};
        let server = Server::http("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", server.server_addr());
        let client = CloudClient::new(&origin).unwrap();
        let worker = std::thread::spawn(move || {
            let request = server
                .recv_timeout(std::time::Duration::from_secs(5))
                .unwrap()
                .unwrap();
            assert_eq!(request.url(), "/v1/library/media-tickets");
            request.respond(Response::from_string(json!({"items": [
                {"asset_id": "changed", "variant": "thumbnail", "ok": true, "url": format!("{origin}/old"), "size_bytes": 3},
                {"asset_id": "current", "variant": "thumbnail", "ok": true, "url": format!("{origin}/same"), "size_bytes": 3}
            ]}).to_string())).unwrap();
            for (path, bytes) in [("/old", "old"), ("/same", "new")] {
                let request = server
                    .recv_timeout(std::time::Duration::from_secs(5))
                    .unwrap()
                    .unwrap();
                assert_eq!(request.url(), path);
                request.respond(Response::from_string(bytes)).unwrap();
            }
        });
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("thumb.webp"), b"new").unwrap();
        let candidates = ["changed", "current"].map(|id| Candidate {
            asset_id: id.into(),
            thumbnail_relative_path: "thumb.webp".into(),
            bytes: 3,
        });
        let mut report = CloudThumbnailRefreshReport::default();
        let selected = select_stale_candidates(
            temp.path(),
            &client,
            "token",
            &candidates,
            None,
            &mut report,
        )
        .unwrap();
        assert_eq!(selected.len(), 1);
        assert_eq!(selected[0].asset_id, "changed");
        assert_eq!(report.current, 1);
        assert_eq!(report.failed, 0);
        worker.join().unwrap();
    }

    #[test]
    fn apply_requires_an_explicit_limit_or_all() {
        assert!(validate_options(CloudThumbnailRefreshOptions {
            apply: true,
            limit: None,
            all: false,
        })
        .is_err());
    }

    #[test]
    fn dry_run_rejects_apply_only_switches() {
        assert!(validate_options(CloudThumbnailRefreshOptions {
            apply: false,
            limit: Some(1),
            all: false,
        })
        .is_err());
        assert!(validate_options(CloudThumbnailRefreshOptions {
            apply: false,
            limit: None,
            all: true,
        })
        .is_err());
    }

    #[test]
    fn valid_apply_modes_are_accepted() {
        assert!(validate_options(CloudThumbnailRefreshOptions {
            apply: true,
            limit: Some(20),
            all: false,
        })
        .is_ok());
        assert!(validate_options(CloudThumbnailRefreshOptions {
            apply: true,
            limit: None,
            all: true,
        })
        .is_ok());
    }
}

#[cfg(test)]
mod hold_tests {
    use super::*;
    #[test]
    fn missing_machine_settings_fail_closed_at_a_valid_location() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("library-machine.json");
        assert!(matches!(
            require_machine_settings(&path),
            Err(LibraryError::CloudSyncHeld)
        ));
        assert!(matches!(
            require_machine_settings(temp.path()),
            Err(LibraryError::CloudSyncHeld)
        ));
        std::fs::write(&path, "{}").unwrap();
        require_machine_settings(&path).unwrap();
    }
}
