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
use sha2::{Digest, Sha256};

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

    let token = credential::read_cloud_api_token_os()?;
    let client = CloudClient::new(&base_url)?;
    let selected =
        select_stale_candidates(&client, &token, &candidates, options.limit, &mut report)?;
    report.selected = selected.len();
    report.bytes_selected = selected.iter().map(|candidate| candidate.bytes).sum();
    upload_candidates(root, &client, &token, &selected, &mut report);
    Ok(report)
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
            .thumbnail_remote_sizes(&ids, token)?
            .into_iter()
            .collect::<BTreeMap<_, _>>();
        for candidate in chunk {
            match remote.get(&candidate.asset_id) {
                Some(Ok(remote_bytes)) if *remote_bytes == candidate.bytes => {
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
    let sha256 = hex_digest(Sha256::digest(&bytes));
    let object_key = format!("library/{}/thumbnail", candidate.asset_id);
    client
        .upload_replication_variant(&object_key, "image/webp", bytes, &sha256, token)
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

fn hex_digest(bytes: impl AsRef<[u8]>) -> String {
    bytes
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

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
