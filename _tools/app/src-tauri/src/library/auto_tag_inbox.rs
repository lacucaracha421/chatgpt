//! Machine-local nightly inbox. All callers share the existing ingestion gate;
//! tag import and review additionally hold one database connection throughout.
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    time::{Duration, SystemTime},
};

use serde::{Deserialize, Serialize};

use super::{error::LibraryError, machine_settings, Library};

pub(crate) const FILES: [&str; 2] = ["auto-tags-latest.sqlite", "artist-style-latest.sqlite"];
const RETRY_SECONDS: i64 = 3600;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct Settings {
    pub folder: Option<String>,
    pub apply_tagger_review: bool,
    pub last: Option<BTreeMap<String, Last>>,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            folder: None,
            apply_tagger_review: true,
            last: None,
        }
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Last {
    /// Nanoseconds since the Unix epoch, as text to preserve precision in JS.
    pub file_modified: String,
    pub file_size: u64,
    /// Completion time of the attempt, including failed attempts (retry clock).
    pub imported_at: String,
    pub imported: BTreeMap<String, u64>,
    pub tagger: Option<TaggerCounts>,
    pub error: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TaggerCounts {
    pub veto: usize,
    pub recommend: usize,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RunResult {
    pub settings: Settings,
    pub processed: Vec<String>,
    pub skipped: Option<String>,
}
fn invalid(message: impl Into<String>) -> LibraryError {
    LibraryError::InvalidAutoTag(message.into())
}

impl Library {
    fn inbox_settings_location(&self) -> Result<(PathBuf, String), LibraryError> {
        let path = self
            .machine_settings_path()
            .ok_or_else(|| invalid("이 PC의 설정 경로를 찾지 못했습니다."))?;
        Ok((path, self.library_id()?))
    }

    pub(crate) fn auto_tag_inbox(&self) -> Result<Settings, LibraryError> {
        let (path, id) = self.inbox_settings_location()?;
        Ok(machine_settings::entry(&path, &id)?
            .unwrap_or_default()
            .auto_tag_inbox)
    }

    pub(crate) fn set_auto_tag_inbox(
        &self,
        folder: Option<String>,
        apply_tagger_review: bool,
    ) -> Result<Settings, LibraryError> {
        let _gate = self
            .ingestion_lock
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let folder = folder.filter(|s| !s.trim().is_empty());
        if folder
            .as_ref()
            .is_some_and(|s| !machine_settings::usable_directory(s))
        {
            return Err(invalid("이 PC에서 사용할 수 있는 폴더를 선택해 주세요."));
        }
        let (path, id) = self.inbox_settings_location()?;
        // Preserve legacy manga-root adoption before creating the machine entry.
        {
            let connection = self.connection()?;
            super::manga::manga_root(self, &connection)?;
        }
        let mut settings = self.auto_tag_inbox()?;
        if settings.folder != folder {
            settings.last = None;
        }
        settings.folder = folder;
        settings.apply_tagger_review = apply_tagger_review;
        machine_settings::set_auto_tag_inbox(&path, &id, settings.clone())?;
        Ok(settings)
    }

    /// The manual style-import command uses the same gate as automatic runs.
    pub(crate) fn import_artist_style_from_inbox_gate(
        &self,
        path: &Path,
    ) -> Result<super::artist_style::ImportResult, LibraryError> {
        let _gate = self
            .ingestion_lock
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        self.import_artist_style_features(path)
    }

    pub(crate) fn run_auto_tag_inbox(&self) -> Result<RunResult, LibraryError> {
        self.run_auto_tag_inbox_at(chrono::Utc::now(), crate::workload::is_restricted())
    }

    fn run_auto_tag_inbox_at(
        &self,
        now: chrono::DateTime<chrono::Utc>,
        restricted: bool,
    ) -> Result<RunResult, LibraryError> {
        // Try before reading the DB: a manual import holding the DB must not turn
        // this tick into a queued second run.
        let _gate = match self.ingestion_lock.try_lock() {
            Ok(guard) => guard,
            Err(std::sync::TryLockError::Poisoned(error)) => error.into_inner(),
            Err(std::sync::TryLockError::WouldBlock) => {
                return Ok(RunResult {
                    settings: Settings::default(),
                    processed: vec![],
                    skipped: Some("다른 가져오기가 진행 중입니다.".into()),
                });
            }
        };
        let mut result = RunResult {
            settings: self.auto_tag_inbox()?,
            processed: vec![],
            skipped: None,
        };
        if restricted {
            result.skipped = Some("절약 모드 또는 복구 대기 중에는 가져오지 않습니다.".into());
            return Ok(result);
        }
        let Some(folder) = result.settings.folder.clone() else {
            result.skipped = Some("가져올 폴더를 선택해 주세요.".into());
            return Ok(result);
        };
        let (settings_path, id) = self.inbox_settings_location()?;
        for name in FILES {
            if crate::workload::is_restricted() {
                result.skipped = Some("절약 모드 또는 복구 대기 중에는 가져오지 않습니다.".into());
                break;
            }
            let path = Path::new(&folder).join(name);
            let metadata = match std::fs::metadata(&path) {
                Ok(metadata) => Ok(metadata),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(e) => Err(e.to_string()),
            };
            let stamp = metadata
                .as_ref()
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
                .map(|t| t.as_nanos().to_string())
                .unwrap_or_default();
            let size = metadata.as_ref().map(|m| m.len()).unwrap_or(0);
            let previous = result.settings.last.as_ref().and_then(|last| last.get(name));
            if previous.is_some_and(|last| {
                let retry_waiting = chrono::DateTime::parse_from_rfc3339(&last.imported_at)
                    .is_ok_and(|at| now.signed_duration_since(at).num_seconds() < RETRY_SECONDS);
                last.file_modified == stamp
                    && last.file_size == size
                    && (last.error.is_none() || retry_waiting)
            }) {
                continue;
            }
            let mut last = Last {
                file_modified: stamp,
                file_size: size,
                imported_at: now.to_rfc3339(),
                imported: BTreeMap::new(),
                tagger: None,
                error: None,
            };
            let imported = (|| -> Result<(), String> {
                let metadata = metadata?;
                if !metadata.is_file() {
                    return Err("가져올 경로가 파일이 아닙니다.".into());
                }
                if name == FILES[0] {
                    let mut connection = self.connection().map_err(|e| e.to_string())?;
                    let summary = super::auto_tags::import_file(
                        &connection,
                        &path,
                        &now.to_rfc3339(),
                    ).map_err(|e| e.to_string())?;
                    last.imported = BTreeMap::from([
                        ("taggedAssets".into(), summary.tagged_assets),
                        ("tagRows".into(), summary.tag_rows),
                        ("skippedAssets".into(), summary.skipped_assets),
                    ]);
                    if result.settings.apply_tagger_review {
                        let preview = super::tagger_review::preview_on(&connection)
                            .map_err(|e| e.to_string())?;
                        let applied = self
                            .apply_tagger_review_on(&mut connection, &preview.preview_token)
                            .map_err(|e| e.to_string())?;
                        last.tagger = Some(TaggerCounts {
                            veto: applied.veto.count,
                            recommend: applied.recommend.count,
                        });
                    }
                } else {
                    let summary = self
                        .import_artist_style_features(&path)
                        .map_err(|e| e.to_string())?;
                    last.imported = BTreeMap::from([
                        ("imported".into(), summary.imported.into()),
                        ("skipped".into(), summary.skipped.into()),
                    ]);
                }
                Ok(())
            })();
            last.error = imported.err();
            // `now` is injectable for retry tests; production records completion.
            last.imported_at = std::cmp::max(now, chrono::Utc::now()).to_rfc3339();
            result
                .settings
                .last
                .get_or_insert_with(BTreeMap::new)
                .insert(name.into(), last);
            machine_settings::set_auto_tag_inbox(&settings_path, &id, result.settings.clone())?;
            result.processed.push(name.into());
        }
        Ok(result)
    }
}

/// Called by the existing native workload timer; no frontend timer or app startup I/O.
#[derive(Default)]
pub(crate) struct Schedule {
    root: Option<PathBuf>,
    due: Option<std::time::Instant>,
}
impl Schedule {
    pub(crate) fn tick(
        &mut self,
        library: Option<&Library>,
        restricted: bool,
        now: std::time::Instant,
    ) -> bool {
        let root = library.map(|l| l.root().to_path_buf());
        if self.root != root {
            self.root = root;
            self.due = Some(now + Duration::from_secs(120));
        }
        if library.is_none() || restricted || !self.due.is_some_and(|due| now >= due) {
            return false;
        }
        self.due = Some(now + Duration::from_secs(3600));
        true
    }
}

#[cfg(test)]
#[path = "auto_tag_inbox_tests.rs"]
mod tests;
