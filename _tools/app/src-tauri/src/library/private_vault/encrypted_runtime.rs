//! Runtime of the encrypted Private Vault (ADR-0039, stage 2a): discovery, lock state,
//! remembered keys, import, listing and decrypted media for the app media protocol.
//! Trash, permanent deletion and export live in the child module `files`.
//!
//! State model:
//! - `RuntimeState` (one short-lived mutex) holds the cached vault location, the unlocked
//!   session (vault handle, root and decrypted index) and the auto-unlock bookkeeping. It is
//!   never held across slow disk work except the single "is the root still there" check.
//! - `write_lock` serializes every vault write: object writes, index saves, password
//!   changes and orphan cleanup. Lock order is always `write_lock` before `state`.
//! - `import_job` (its own short-lived mutex) is the app-level import job: progress, the
//!   final report or error code. It outlives the view that started the import, so the UI
//!   can reattach to a running import and show its summary later.
//! - Media requests clone the `Arc<EncryptedVault>` under `state` and decrypt outside it,
//!   so a lock drops the session at once and the key is zeroized when the last reader ends.
//!
//! Nothing here writes plaintext into the vault root or logs keys, secrets, paths or names.

use std::{
    collections::{HashMap, HashSet},
    fmt,
    fs::{self, File},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard, PoisonError},
};

use image::ImageDecoder;
use rusqlite::{Connection, OpenFlags};
use uuid::Uuid;
use zeroize::Zeroize;

use super::{
    canonical_vault_root,
    crypto::{MasterKey, ObjectReader, Secret, VaultError},
    encrypted_store::{
        self, EncryptedVault, VaultIndex, VaultItem, VaultItemKind, ORPHAN_SAFETY_WINDOW, VAULT_DIR,
    },
    scan::{self, VaultMediaKind},
    validated_relative,
};
use crate::library::{
    error::LibraryError,
    models::{
        CreatedEncryptedVault, EncryptedVaultExportJob, EncryptedVaultImportJob,
        EncryptedVaultImportProgress, EncryptedVaultImportReport, EncryptedVaultItemKind,
        EncryptedVaultItemPage, EncryptedVaultItemSummary, EncryptedVaultQuery,
        EncryptedVaultSecretInput, EncryptedVaultSidecarCleanupPreview,
        EncryptedVaultSidecarCleanupResult, EncryptedVaultState, EncryptedVaultStatus,
    },
    Library,
};

/// Stage 3: vault trash, permanent deletion and export (a child module, so it shares the
/// runtime's private session state and write lock).
#[path = "encrypted_files.rs"]
mod files;

const MAX_TITLE_CHARS: usize = 200;
const MAX_PAGE_SIZE: u32 = 500;
/// Minimum number of newly imported items between index saves.
const SAVE_EVERY: usize = 25;
const MAX_LEGACY_THUMBNAIL_BYTES: u64 = 32 * 1024 * 1024;
const LEGACY_METADATA_DIR: &str = ".lakomics";
/// Image extensions of a `<video file name>_thumb.<ext>` sidecar thumbnail.
const SIDECAR_EXTENSIONS: [&str; 4] = ["jpg", "jpeg", "png", "webp"];
const SIDECAR_SUFFIX: &str = "_thumb";
const MAX_CLEANUP_EXAMPLES: usize = 5;

/// Where remembered master keys live. Production uses the OS credential store; tests use an
/// in-memory store so they never touch the real Credential Manager / Secret Service.
pub(crate) trait VaultKeyStore: Send + Sync {
    fn read(&self, vault_id: &str) -> Result<Option<Vec<u8>>, LibraryError>;
    fn write(&self, vault_id: &str, key: &[u8]) -> Result<(), LibraryError>;
    fn delete(&self, vault_id: &str) -> Result<(), LibraryError>;
    /// How many reads this store served (tests assert that polling does not hammer it).
    #[cfg(test)]
    fn read_count(&self) -> usize {
        0
    }
}

#[cfg_attr(test, allow(dead_code))]
struct OsVaultKeyStore;

impl VaultKeyStore for OsVaultKeyStore {
    fn read(&self, vault_id: &str) -> Result<Option<Vec<u8>>, LibraryError> {
        crate::library::credential::vault_key(vault_id)
    }

    fn write(&self, vault_id: &str, key: &[u8]) -> Result<(), LibraryError> {
        crate::library::credential::set_vault_key(vault_id, key)
    }

    fn delete(&self, vault_id: &str) -> Result<(), LibraryError> {
        crate::library::credential::delete_vault_key(vault_id)
    }
}

/// Facts about a plaintext source video, computed on the trusted PC before encryption.
#[derive(Default)]
pub(crate) struct VideoFacts {
    pub width: Option<u32>,
    pub height: Option<u32>,
    /// In-memory WebP poster; never written to disk.
    pub poster: Option<Vec<u8>>,
}

pub(crate) trait VideoInspector: Send + Sync {
    fn inspect(&self, source: &Path) -> VideoFacts;
}

#[cfg_attr(test, allow(dead_code))]
struct NativeVideoInspector;

impl VideoInspector for NativeVideoInspector {
    /// FFprobe for the size, then one FFmpeg frame piped to memory (no temporary files).
    fn inspect(&self, source: &Path) -> VideoFacts {
        let extension = source
            .extension()
            .and_then(|value| value.to_str())
            .map(str::to_ascii_lowercase)
            .unwrap_or_default();
        let Ok(probe) = crate::library::video_media::probe_video(source, &extension) else {
            return VideoFacts::default();
        };
        let poster = crate::library::video_media::render_video_frame_webp(
            source,
            probe.duration_ms.min(1_000) / 2,
        )
        .ok()
        .and_then(|frame| image::load_from_memory(&frame).ok())
        .and_then(|image| crate::library::ingestion::encode_thumbnail_webp(&image).ok());
        VideoFacts {
            width: Some(probe.width).filter(|value| *value > 0),
            height: Some(probe.height).filter(|value| *value > 0),
            poster,
        }
    }
}

struct Environment {
    key_store: Box<dyn VaultKeyStore>,
    video: Box<dyn VideoInspector>,
    mount_roots: fn() -> Vec<PathBuf>,
    pbkdf2_iterations: u32,
}

impl Default for Environment {
    #[cfg(not(test))]
    fn default() -> Self {
        Self {
            key_store: Box::new(OsVaultKeyStore),
            video: Box::new(NativeVideoInspector),
            mount_roots: super::discovery::mounted_root_candidates,
            pbkdf2_iterations: super::crypto::PBKDF2_ITERATIONS,
        }
    }

    #[cfg(test)]
    fn default() -> Self {
        Self {
            key_store: Box::new(test_support::MemoryKeyStore::default()),
            video: Box::new(test_support::FakeVideoInspector),
            mount_roots: Vec::new,
            pbkdf2_iterations: 1_000,
        }
    }
}

#[derive(Clone)]
struct StoredSettings {
    vault_id: Option<Uuid>,
    last_root: Option<PathBuf>,
}

#[derive(Clone)]
struct Located {
    root: PathBuf,
    vault_id: Uuid,
}

struct Session {
    vault: Arc<EncryptedVault>,
    root: PathBuf,
    index: VaultIndex,
    generation: u64,
    /// The index came from `index.prev.bin` because `index.bin` did not decrypt. Objects
    /// newer than that backup are unknown to it, so nothing is deleted in this session.
    from_backup_index: bool,
}

#[derive(Default)]
struct RuntimeState {
    /// `library_settings` columns, read once and kept in sync by create/unlock.
    settings: Option<StoredSettings>,
    located: Option<Located>,
    session: Option<Session>,
    /// Auto-unlock is tried once per appearance of a vault; a manual lock also sets it so
    /// the next status poll does not silently reopen the vault.
    auto_unlock_tried: Option<Uuid>,
    remembered: Option<(Uuid, bool)>,
    generation: u64,
}

impl RuntimeState {
    fn remembered(&self, vault_id: Uuid) -> bool {
        self.remembered == Some((vault_id, true))
    }

    fn status(&self) -> EncryptedVaultStatus {
        if let Some(session) = &self.session {
            let vault_id = session.vault.vault_id();
            return EncryptedVaultStatus {
                state: EncryptedVaultState::Unlocked,
                vault_id: Some(vault_id.to_string()),
                root: Some(session.root.to_string_lossy().into_owned()),
                item_count: Some(
                    session
                        .index
                        .items
                        .iter()
                        .filter(|item| item.trashed_at.is_none())
                        .count() as u64,
                ),
                trashed_count: Some(
                    session
                        .index
                        .items
                        .iter()
                        .filter(|item| item.trashed_at.is_some())
                        .count() as u64,
                ),
                remembered: self.remembered(vault_id),
                backup_index: session.from_backup_index,
            };
        }
        match &self.located {
            Some(located) => EncryptedVaultStatus {
                state: EncryptedVaultState::Locked,
                vault_id: Some(located.vault_id.to_string()),
                root: Some(located.root.to_string_lossy().into_owned()),
                item_count: None,
                trashed_count: None,
                remembered: self.remembered(located.vault_id),
                backup_index: false,
            },
            None => EncryptedVaultStatus {
                state: EncryptedVaultState::Absent,
                vault_id: None,
                root: None,
                item_count: None,
                trashed_count: None,
                remembered: false,
                backup_index: false,
            },
        }
    }

    fn session_matching(&mut self, generation: u64) -> Option<&mut Session> {
        self.session
            .as_mut()
            .filter(|session| session.generation == generation)
    }

    fn forget_location(&mut self) {
        self.session = None;
        self.located = None;
        self.auto_unlock_tried = None;
    }
}

pub(crate) struct EncryptedVaultRuntime {
    state: Mutex<RuntimeState>,
    write_lock: Mutex<()>,
    /// The current or last import of this app session; at most one runs at a time.
    import_job: Mutex<Option<EncryptedVaultImportJob>>,
    /// The current or last export of this app session; at most one runs at a time.
    export_job: Mutex<Option<EncryptedVaultExportJob>>,
    env: Environment,
}

impl Default for EncryptedVaultRuntime {
    fn default() -> Self {
        Self {
            state: Mutex::default(),
            write_lock: Mutex::default(),
            import_job: Mutex::default(),
            export_job: Mutex::default(),
            env: Environment::default(),
        }
    }
}

impl fmt::Debug for EncryptedVaultRuntime {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("EncryptedVaultRuntime { .. }")
    }
}

impl EncryptedVaultRuntime {
    fn state(&self) -> MutexGuard<'_, RuntimeState> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn writes(&self) -> MutexGuard<'_, ()> {
        self.write_lock
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    fn import_job(&self) -> MutexGuard<'_, Option<EncryptedVaultImportJob>> {
        self.import_job
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    fn export_job(&self) -> MutexGuard<'_, Option<EncryptedVaultExportJob>> {
        self.export_job
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    fn import_running(&self) -> bool {
        self.import_job().as_ref().is_some_and(|job| job.running)
    }

    fn update_running_job(&self, update: impl FnOnce(&mut EncryptedVaultImportJob)) {
        if let Some(job) = self.import_job().as_mut().filter(|job| job.running) {
            update(job);
        }
    }
}

/// Ends the running job; if the import unwinds without recording a result, it still ends
/// so a later import is not refused forever.
struct ImportJobGuard<'a>(&'a EncryptedVaultRuntime);

impl Drop for ImportJobGuard<'_> {
    fn drop(&mut self) {
        self.0.update_running_job(|job| {
            job.running = false;
            job.error = Some(IMPORT_FAILED_CODE.to_owned());
        });
    }
}

const IMPORT_FAILED_CODE: &str = "encrypted_vault_import_failed";

/// Command error code of an import failure, kept in the job for a UI that reattaches later.
/// A test checks that these match the codes of the failed command itself.
pub(crate) fn import_error_code(error: &LibraryError) -> &'static str {
    match error {
        LibraryError::EncryptedVaultLocked => "encrypted_vault_locked",
        LibraryError::EncryptedVaultFolderUnavailable => "encrypted_vault_folder_unavailable",
        LibraryError::EncryptedVaultNotFound => "encrypted_vault_not_found",
        LibraryError::EncryptedVaultCorrupt => "encrypted_vault_corrupt",
        LibraryError::EncryptedVaultIo => "encrypted_vault_io_failed",
        LibraryError::EncryptedVaultCrypto => "encrypted_vault_crypto_failed",
        _ => IMPORT_FAILED_CODE,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum EncryptedVaultMediaVariant {
    Asset,
    Thumbnail,
    Playback,
}

/// A decrypting reader over one vault object, handed to the media protocol.
pub(crate) struct EncryptedVaultMedia {
    reader: ObjectReader,
    pub(crate) mime: &'static str,
    pub(crate) video: bool,
}

impl EncryptedVaultMedia {
    pub(crate) fn len(&self) -> u64 {
        self.reader.len()
    }

    pub(crate) fn read_range(&mut self, offset: u64, len: u64) -> Result<Vec<u8>, LibraryError> {
        self.reader.read_range(offset, len).map_err(vault_error)
    }
}

pub(crate) fn vault_error(error: VaultError) -> LibraryError {
    match error {
        VaultError::AlreadyExists => LibraryError::EncryptedVaultAlreadyExists,
        VaultError::NotFound => LibraryError::EncryptedVaultNotFound,
        VaultError::WrongSecret => LibraryError::EncryptedVaultWrongSecret,
        VaultError::EmptyPassword => LibraryError::EncryptedVaultEmptyPassword,
        VaultError::InvalidRecoveryKey => LibraryError::EncryptedVaultInvalidRecoveryKey,
        VaultError::UnsupportedFormat => LibraryError::EncryptedVaultUnsupportedFormat,
        VaultError::Corrupt => LibraryError::EncryptedVaultCorrupt,
        VaultError::Crypto => LibraryError::EncryptedVaultCrypto,
        VaultError::Io(_) => LibraryError::EncryptedVaultIo,
        VaultError::Changed => LibraryError::EncryptedVaultLocked,
    }
}

fn secret_of(input: &EncryptedVaultSecretInput) -> Secret<'_> {
    match input {
        EncryptedVaultSecretInput::Password(value) => Secret::Password(value),
        EncryptedVaultSecretInput::RecoveryKey(value) => Secret::RecoveryKey(value),
    }
}

fn vault_present(root: &Path) -> bool {
    fs::metadata(root.join(VAULT_DIR)).is_ok_and(|metadata| metadata.is_dir())
}

fn item_kind(kind: VaultItemKind) -> EncryptedVaultItemKind {
    match kind {
        VaultItemKind::Image => EncryptedVaultItemKind::Image,
        VaultItemKind::Video => EncryptedVaultItemKind::Video,
    }
}

fn original_mime(item: &VaultItem) -> &'static str {
    let path = Path::new(&item.original_file_name);
    let jfif = path
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case("jfif"));
    if jfif {
        "image/jpeg"
    } else {
        crate::library::mime_for_path(path)
    }
}

/// Image type from magic bytes: JPEG, PNG or WebP.
fn sniff_image_mime(head: &[u8]) -> Option<&'static str> {
    if head.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("image/jpeg")
    } else if head.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if head.len() >= 12 && head.starts_with(b"RIFF") && &head[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

fn normalized_title(title: Option<&str>) -> Result<Option<String>, LibraryError> {
    let normalized = title.map(str::trim).filter(|value| !value.is_empty());
    if normalized.is_some_and(|value| value.chars().count() > MAX_TITLE_CHARS) {
        return Err(LibraryError::InvalidEncryptedVaultTitle);
    }
    Ok(normalized.map(str::to_owned))
}

enum ImportOutcome {
    Imported {
        legacy_title: bool,
        legacy_thumbnail: bool,
        has_thumbnail: bool,
    },
    /// A `_thumb` sidecar became its sibling video's custom thumbnail (no new item).
    SidecarApplied,
    /// A `_thumb` sidecar not stored because its video already has a different custom
    /// thumbnail. Sidecars are disposable derived files, so this is not data loss.
    SidecarSkipped,
    /// Verified to be in the vault already (same content hash). `backfilled` when a hash was
    /// just recorded for an older item, which the index must save.
    Skipped {
        backfilled: bool,
    },
    Failed,
}

/// A vault object that may hold the same file: the resume pre-filter matched its relative
/// path and size; its content hash decides.
struct Known {
    object_id: String,
    content_sha256: Option<String>,
}

/// Vault items by (original relative path, byte size): the cheap pre-filter of a resume.
type KnownFiles = HashMap<(String, u64), Vec<Known>>;

/// SHA-256 of a plaintext source file on the trusted PC; `None` if it cannot be read.
fn hash_file(path: &Path) -> Option<String> {
    encrypted_store::sha256_hex(&mut File::open(path).ok()?).ok()
}

enum Duplicate {
    No,
    /// `backfill`: the object id of an older item whose hash was computed to confirm it.
    Yes {
        backfill: Option<String>,
    },
}

/// Whether one of `candidates` holds exactly the content hashed as `source_hash`. Items from
/// before hashes were recorded are confirmed by decrypting and hashing their object; an
/// unreadable object never counts as a match, so the file is imported again instead.
fn find_duplicate(vault: &EncryptedVault, candidates: &[Known], source_hash: &str) -> Duplicate {
    if candidates
        .iter()
        .any(|known| known.content_sha256.as_deref() == Some(source_hash))
    {
        return Duplicate::Yes { backfill: None };
    }
    candidates
        .iter()
        .filter(|known| known.content_sha256.is_none())
        .find(|known| {
            vault
                .object_sha256(&known.object_id)
                .is_ok_and(|hash| hash == source_hash)
        })
        .map_or(Duplicate::No, |known| Duplicate::Yes {
            backfill: Some(known.object_id.clone()),
        })
}

/// The file name of the video a `<video file name>_thumb.<jpg|jpeg|png|webp>` sidecar
/// belongs to (extension matched case-insensitively), or `None` for any other name.
fn sidecar_video_name(file_name: &str) -> Option<&str> {
    let (stem, extension) = file_name.rsplit_once('.')?;
    if !SIDECAR_EXTENSIONS
        .iter()
        .any(|candidate| extension.eq_ignore_ascii_case(candidate))
    {
        return None;
    }
    stem.strip_suffix(SIDECAR_SUFFIX)
        .filter(|video| !video.is_empty())
}

/// The relative path of the video `relative_path` is a sidecar thumbnail of, as a candidate
/// (same directory, `_thumb.<ext>` removed).
fn sidecar_candidate(relative_path: &str) -> Option<String> {
    let (directory, file_name) = match relative_path.rsplit_once('/') {
        Some((directory, file_name)) => (Some(directory), file_name),
        None => (None, relative_path),
    };
    let video = sidecar_video_name(file_name)?;
    Some(match directory {
        Some(directory) => format!("{directory}/{video}"),
        None => video.to_owned(),
    })
}

/// Video relative paths a sidecar can attach to: an exact match first, else a unique
/// case-insensitive match.
#[derive(Default)]
struct VideoPaths {
    exact: HashSet<String>,
    /// Lowercased path -> the one path with that spelling, `None` when ambiguous.
    folded: HashMap<String, Option<String>>,
}

impl VideoPaths {
    fn insert(&mut self, path: &str) {
        if !self.exact.insert(path.to_owned()) {
            return;
        }
        self.folded
            .entry(path.to_lowercase())
            .and_modify(|existing| *existing = None)
            .or_insert_with(|| Some(path.to_owned()));
    }

    fn resolve(&self, candidate: &str) -> Option<String> {
        if self.exact.contains(candidate) {
            return Some(candidate.to_owned());
        }
        self.folded
            .get(&candidate.to_lowercase())
            .cloned()
            .flatten()
    }

    /// The video `relative_path` is a sidecar thumbnail of, if any.
    fn sidecar_target(&self, relative_path: &str) -> Option<String> {
        self.resolve(&sidecar_candidate(relative_path)?)
    }
}

/// Image items of `index` that are a `_thumb` sidecar of a video in the index, as
/// `(image index, video index)` in index order. Trashed items are ignored.
fn sidecar_image_matches(index: &VaultIndex) -> Vec<(usize, usize)> {
    let mut videos = VideoPaths::default();
    let mut video_at = HashMap::new();
    for (position, item) in index.items.iter().enumerate() {
        if item.kind == VaultItemKind::Video && item.trashed_at.is_none() {
            videos.insert(&item.original_relative_path);
            // The newest video wins when a path was imported more than once.
            video_at.insert(item.original_relative_path.as_str(), position);
        }
    }
    index
        .items
        .iter()
        .enumerate()
        .filter(|(_, item)| item.kind == VaultItemKind::Image && item.trashed_at.is_none())
        .filter_map(|(position, item)| {
            let target = videos.sidecar_target(&item.original_relative_path)?;
            Some((position, *video_at.get(target.as_str())?))
        })
        .collect()
}

enum ImportSource<'a> {
    /// Every supported file under a folder, relative paths kept.
    Folder(&'a Path),
    /// Individually chosen files, each at the top level under its file name.
    Files(&'a [PathBuf]),
}

struct LegacyEntry {
    title: Option<String>,
    custom_thumbnail: Option<String>,
}

impl Library {
    /// Cheap enough for window focus and a few-second poll: when unlocked it only checks that
    /// the vault folder still exists; when locked or absent it probes the cached root, the
    /// last root and the mount roots for `.lakomics-vault/vault.json`. It never writes the
    /// library database. A vault whose folder disappeared is locked (key dropped).
    pub fn encrypted_vault_status(&self) -> Result<EncryptedVaultStatus, LibraryError> {
        let runtime = &*self.encrypted_vault;
        let unlocked = runtime.state().session.as_ref().map(|session| {
            (
                session.root.clone(),
                session.vault.vault_id(),
                session.generation,
            )
        });
        if let Some((root, vault_id, generation)) = unlocked {
            // Re-read the UUID, not just the folder: another vault may have been swapped in
            // at the same drive letter or mount point.
            let same_vault = EncryptedVault::read_vault_id(&root).is_ok_and(|id| id == vault_id);
            let mut state = runtime.state();
            if state.session_matching(generation).is_some() {
                if same_vault {
                    return Ok(state.status());
                }
                state.forget_location();
            }
        }
        let Some(located) = self.locate_encrypted_vault()? else {
            let mut state = runtime.state();
            if state.session.is_none() {
                state.forget_location();
            }
            return Ok(state.status());
        };
        let try_auto_unlock = {
            let mut state = runtime.state();
            if state.session.is_some() {
                return Ok(state.status());
            }
            let first_sight = state.auto_unlock_tried != Some(located.vault_id);
            state.located = Some(located.clone());
            state.auto_unlock_tried = Some(located.vault_id);
            first_sight
        };
        if try_auto_unlock {
            self.try_auto_unlock(&located);
        }
        Ok(runtime.state().status())
    }

    /// Creates a vault in `root` and unlocks it. The recovery key is returned only here.
    /// After the vault exists nothing can fail any more, so the key is never lost.
    pub fn create_encrypted_vault(
        &self,
        root: &Path,
        password: &str,
        remember: bool,
    ) -> Result<CreatedEncryptedVault, LibraryError> {
        let root = canonical_vault_root(self, root).map_err(|error| match error {
            LibraryError::UnsafeMediaPath => LibraryError::EncryptedVaultInvalidRoot,
            _ => LibraryError::EncryptedVaultFolderUnavailable,
        })?;
        let (vault, recovery) = {
            let _writes = self.encrypted_vault.writes();
            EncryptedVault::create_with_iterations(
                &root,
                password,
                self.encrypted_vault.env.pbkdf2_iterations,
            )
            .map_err(vault_error)?
        };
        let recovery_key = recovery.as_str().to_owned();
        drop(recovery);
        let vault_id = vault.vault_id();
        let exported = remember.then(|| vault.master_key().export_for_credential_store());
        let _ = self.install_encrypted_session(root.clone(), vault);
        self.apply_remember(vault_id, exported.as_ref().map(|key| key.as_bytes()));
        let _ = self.save_encrypted_vault_settings(vault_id, &root);
        let status = self
            .encrypted_vault_status()
            .unwrap_or_else(|_| self.encrypted_vault.state().status());
        Ok(CreatedEncryptedVault {
            status,
            recovery_key,
        })
    }

    pub fn unlock_encrypted_vault(
        &self,
        secret: &EncryptedVaultSecretInput,
        remember: bool,
    ) -> Result<EncryptedVaultStatus, LibraryError> {
        let cached = self.encrypted_vault.state().located.clone();
        let located = match cached.filter(|located| vault_present(&located.root)) {
            Some(located) => located,
            None => self
                .locate_encrypted_vault()?
                .ok_or(LibraryError::EncryptedVaultNotFound)?,
        };
        let vault =
            EncryptedVault::unlock(&located.root, &secret_of(secret)).map_err(vault_error)?;
        let vault_id = vault.vault_id();
        let exported = remember.then(|| vault.master_key().export_for_credential_store());
        self.install_encrypted_session(located.root.clone(), vault)?;
        self.apply_remember(vault_id, exported.as_ref().map(|key| key.as_bytes()));
        let _ = self.save_encrypted_vault_settings(vault_id, &located.root);
        self.encrypted_vault_status()
    }

    /// Drops the key and the decrypted index. The vault stays locked until the user unlocks
    /// it again or the USB is removed and reinserted (which retries a remembered key).
    pub fn lock_encrypted_vault(&self) -> EncryptedVaultStatus {
        let mut state = self.encrypted_vault.state();
        if let Some(session) = state.session.take() {
            state.auto_unlock_tried = Some(session.vault.vault_id());
        }
        state.status()
    }

    /// Removes the remembered key from this PC; the vault stays unlocked.
    pub fn forget_encrypted_vault_key(&self) -> Result<EncryptedVaultStatus, LibraryError> {
        let vault_id = {
            let state = self.encrypted_vault.state();
            state
                .session
                .as_ref()
                .map(|session| session.vault.vault_id())
                .or(state.located.as_ref().map(|located| located.vault_id))
                .ok_or(LibraryError::EncryptedVaultNotFound)?
        };
        self.encrypted_vault
            .env
            .key_store
            .delete(&vault_id.to_string())?;
        let mut state = self.encrypted_vault.state();
        state.remembered = Some((vault_id, false));
        Ok(state.status())
    }

    /// Verifies `current` (password or recovery key) and rewraps the master key under the new
    /// password. A remembered key stays valid because the master key does not change.
    pub fn change_encrypted_vault_password(
        &self,
        current: &EncryptedVaultSecretInput,
        new_password: &str,
    ) -> Result<(), LibraryError> {
        let _writes = self.encrypted_vault.writes();
        let (vault, generation) = self
            .encrypted_vault
            .state()
            .session
            .as_ref()
            .map(|session| (Arc::clone(&session.vault), session.generation))
            .ok_or(LibraryError::EncryptedVaultLocked)?;
        vault
            .change_password(
                &secret_of(current),
                new_password,
                self.encrypted_vault.env.pbkdf2_iterations,
            )
            .map_err(|error| self.vault_write_error(generation, error))
    }

    pub fn list_encrypted_vault_items(
        &self,
        query: EncryptedVaultQuery,
    ) -> Result<EncryptedVaultItemPage, LibraryError> {
        let state = self.encrypted_vault.state();
        let session = state
            .session
            .as_ref()
            .ok_or(LibraryError::EncryptedVaultLocked)?;
        let limit = query.limit.clamp(1, MAX_PAGE_SIZE) as u64;
        let matching = || {
            session.index.items.iter().rev().filter(|item| {
                item.trashed_at.is_some() == query.trashed
                    && query.kind.is_none_or(|kind| item_kind(item.kind) == kind)
            })
        };
        let total_count = matching().count() as u64;
        let items = matching()
            .skip(usize::try_from(query.offset).unwrap_or(usize::MAX))
            .take(limit as usize)
            .map(|item| EncryptedVaultItemSummary {
                id: item.id.clone(),
                kind: item_kind(item.kind),
                byte_size: item.byte_size,
                width: item.width,
                height: item.height,
                title: item.title.clone(),
                original_file_name: item.original_file_name.clone(),
                imported_at: item.imported_at.clone(),
                has_thumbnail: item.thumbnail_object_id.is_some()
                    || item.poster_object_id.is_some(),
                trashed_at: item.trashed_at.clone(),
            })
            .collect::<Vec<_>>();
        let end = query.offset.saturating_add(items.len() as u64);
        Ok(EncryptedVaultItemPage {
            items,
            total_count,
            next_offset: (end < total_count).then_some(end),
        })
    }

    pub fn set_encrypted_vault_title(
        &self,
        item_id: &str,
        title: Option<&str>,
    ) -> Result<(), LibraryError> {
        let title = normalized_title(title)?;
        let _writes = self.encrypted_vault.writes();
        let (vault, generation, previous) = {
            let mut state = self.encrypted_vault.state();
            let session = state
                .session
                .as_mut()
                .ok_or(LibraryError::EncryptedVaultLocked)?;
            let item = session
                .index
                .items
                .iter_mut()
                .find(|item| item.id == item_id && item.trashed_at.is_none())
                .ok_or(LibraryError::AssetNotFound)?;
            let previous = std::mem::replace(&mut item.title, title);
            (Arc::clone(&session.vault), session.generation, previous)
        };
        if let Err(error) = self.persist_encrypted_index(&vault, generation) {
            let mut state = self.encrypted_vault.state();
            if let Some(item) = state.session_matching(generation).and_then(|session| {
                session
                    .index
                    .items
                    .iter_mut()
                    .find(|item| item.id == item_id)
            }) {
                item.title = previous;
            }
            return Err(error);
        }
        Ok(())
    }

    /// Resolves a vault item for the media protocol from memory only: no discovery, no status
    /// and no disk access except opening the one encrypted object. Trashed items are served
    /// too, so the vault trash view can show what it would delete.
    pub(crate) fn encrypted_vault_media(
        &self,
        item_id: &str,
        variant: EncryptedVaultMediaVariant,
    ) -> Result<EncryptedVaultMedia, LibraryError> {
        let (vault, object_id, mime, video) = {
            let state = self.encrypted_vault.state();
            let session = state
                .session
                .as_ref()
                .ok_or(LibraryError::EncryptedVaultLocked)?;
            let item = session
                .index
                .items
                .iter()
                .find(|item| item.id == item_id)
                .ok_or(LibraryError::AssetNotFound)?;
            let video = item.kind == VaultItemKind::Video;
            let (object_id, mime) = match variant {
                EncryptedVaultMediaVariant::Asset => (item.object_id.clone(), original_mime(item)),
                EncryptedVaultMediaVariant::Playback if video => {
                    (item.object_id.clone(), original_mime(item))
                }
                EncryptedVaultMediaVariant::Playback => return Err(LibraryError::AssetNotFound),
                EncryptedVaultMediaVariant::Thumbnail => (
                    item.thumbnail_object_id
                        .clone()
                        .or_else(|| item.poster_object_id.clone())
                        .ok_or(LibraryError::AssetNotFound)?,
                    "image/webp",
                ),
            };
            let video = video && variant != EncryptedVaultMediaVariant::Thumbnail;
            (Arc::clone(&session.vault), object_id, mime, video)
        };
        let mut reader = vault.open_object(&object_id).map_err(vault_error)?;
        // Custom thumbnails keep their original format (JPEG/PNG sidecars, legacy files).
        let mime = if variant == EncryptedVaultMediaVariant::Thumbnail {
            let mut head = reader.read_range(0, 12).map_err(vault_error)?;
            let sniffed = sniff_image_mime(&head).unwrap_or(mime);
            head.zeroize();
            sniffed
        } else {
            mime
        };
        Ok(EncryptedVaultMedia {
            reader,
            mime,
            video,
        })
    }

    /// Encrypts every supported file under `source` into the unlocked vault. Files already
    /// imported (same relative path and size) are skipped, so a re-run resumes. Titles and
    /// custom thumbnails of an old plaintext vault (`.lakomics/index.sqlite`) are carried over.
    ///
    /// The import runs to completion on the calling thread no matter who listens to
    /// `progress`; its state is also kept in the runtime (`encrypted_vault_import_job`).
    /// Only a lock, a removed vault or app exit stops it.
    pub fn import_into_encrypted_vault(
        &self,
        source: &Path,
        progress: &mut dyn FnMut(&EncryptedVaultImportProgress),
    ) -> Result<EncryptedVaultImportReport, LibraryError> {
        self.run_import_job(ImportSource::Folder(source), progress)
    }

    /// Encrypts the chosen files (not folders) into the unlocked vault: the same job,
    /// dedupe, sidecar and thumbnail rules as a folder import. Each file's relative path
    /// is its file name, so a `<video>_thumb.<image>` picked with its video (or next to a
    /// video already at the vault's top level) becomes that video's thumbnail.
    pub fn import_files_into_encrypted_vault(
        &self,
        files: &[PathBuf],
        progress: &mut dyn FnMut(&EncryptedVaultImportProgress),
    ) -> Result<EncryptedVaultImportReport, LibraryError> {
        self.run_import_job(ImportSource::Files(files), progress)
    }

    fn run_import_job(
        &self,
        source: ImportSource<'_>,
        progress: &mut dyn FnMut(&EncryptedVaultImportProgress),
    ) -> Result<EncryptedVaultImportReport, LibraryError> {
        let runtime = &*self.encrypted_vault;
        {
            let mut job = runtime.import_job();
            if job.as_ref().is_some_and(|job| job.running) {
                return Err(LibraryError::EncryptedVaultImportRunning);
            }
            let id = job.as_ref().map_or(1, |job| job.id + 1);
            *job = Some(EncryptedVaultImportJob {
                id,
                running: true,
                ..Default::default()
            });
        }
        let _job = ImportJobGuard(runtime);
        let result = self.run_encrypted_import(source, &mut |current| {
            runtime.update_running_job(|job| job.progress = current.clone());
            progress(current);
        });
        runtime.update_running_job(|job| {
            job.running = false;
            match &result {
                Ok(report) => job.report = Some(report.clone()),
                Err(error) => job.error = Some(import_error_code(error).to_owned()),
            }
        });
        result
    }

    /// The current or last import of this app session, if any. Cheap: one short lock.
    pub fn encrypted_vault_import_job(&self) -> Option<EncryptedVaultImportJob> {
        self.encrypted_vault.import_job().clone()
    }

    fn run_encrypted_import(
        &self,
        source: ImportSource<'_>,
        progress: &mut dyn FnMut(&EncryptedVaultImportProgress),
    ) -> Result<EncryptedVaultImportReport, LibraryError> {
        let runtime = &*self.encrypted_vault;
        let (vault, generation, vault_root, mut existing, mut videos) = {
            let state = runtime.state();
            let session = state
                .session
                .as_ref()
                .ok_or(LibraryError::EncryptedVaultLocked)?;
            // Trashed items do not count as present: adding a file again brings it back as
            // a new item, and emptying the trash never loses it.
            let mut existing = KnownFiles::new();
            for item in session
                .index
                .items
                .iter()
                .filter(|item| item.trashed_at.is_none())
            {
                existing
                    .entry((item.original_relative_path.clone(), item.byte_size))
                    .or_default()
                    .push(Known {
                        object_id: item.object_id.clone(),
                        content_sha256: item.content_sha256.clone(),
                    });
            }
            let mut videos = VideoPaths::default();
            for item in &session.index.items {
                if item.kind == VaultItemKind::Video && item.trashed_at.is_none() {
                    videos.insert(&item.original_relative_path);
                }
            }
            (
                Arc::clone(&session.vault),
                session.generation,
                session.root.clone(),
                existing,
                videos,
            )
        };
        let (source, files, unreadable, legacy) = match source {
            ImportSource::Folder(source) => {
                let source = fs::canonicalize(source)
                    .ok()
                    .filter(|path| path.is_dir())
                    .ok_or(LibraryError::EncryptedVaultFolderUnavailable)?;
                let (files, unreadable) = scan::media_files(&source)
                    .map_err(|_| LibraryError::EncryptedVaultFolderUnavailable)?;
                let legacy = read_legacy_index(&source);
                (source, files, unreadable, legacy)
            }
            ImportSource::Files(paths) => {
                let (files, unreadable) = scan::chosen_media_files(paths);
                (PathBuf::new(), files, unreadable, HashMap::new())
            }
        };
        for (_, relative_path, media_kind) in &files {
            if *media_kind == VaultMediaKind::Video {
                videos.insert(relative_path);
            }
        }
        // Sidecar thumbnails go last so their video is already imported, whatever the order.
        let (mut files, sidecars): (Vec<_>, Vec<_>) = files
            .into_iter()
            .map(|(path, relative_path, media_kind)| {
                let target = (media_kind == VaultMediaKind::Image)
                    .then(|| videos.sidecar_target(&relative_path))
                    .flatten();
                (path, relative_path, media_kind, target)
            })
            .partition(|file| file.3.is_none());
        files.extend(sidecars);
        let mut report = EncryptedVaultImportReport {
            total: files.len() as u64,
            failed: unreadable,
            ..Default::default()
        };
        runtime.update_running_job(|job| {
            job.progress.total = report.total;
            job.progress.failed = report.failed;
        });
        let mut processed = 0_u64;
        let mut unsaved = 0_usize;
        for (path, relative_path, media_kind, sidecar_target) in files {
            processed += 1;
            let sidecar = match &sidecar_target {
                Some(video_path) => self.import_sidecar(
                    &vault,
                    generation,
                    &vault_root,
                    &path,
                    &relative_path,
                    video_path,
                    &existing,
                )?,
                None => None,
            };
            let outcome = match sidecar {
                Some(outcome) => outcome,
                None => self.import_one(
                    &vault,
                    generation,
                    &vault_root,
                    &source,
                    &path,
                    &relative_path,
                    media_kind,
                    legacy.get(&relative_path),
                    &mut existing,
                )?,
            };
            match outcome {
                ImportOutcome::Imported {
                    legacy_title,
                    legacy_thumbnail,
                    has_thumbnail,
                } => {
                    report.imported += 1;
                    report.legacy_titles += u64::from(legacy_title);
                    report.legacy_thumbnails += u64::from(legacy_thumbnail);
                    report.without_thumbnail += u64::from(!has_thumbnail);
                    unsaved += 1;
                }
                ImportOutcome::SidecarApplied => {
                    report.sidecar_thumbnails += 1;
                    unsaved += 1;
                }
                ImportOutcome::SidecarSkipped => report.sidecar_skipped += 1,
                ImportOutcome::Skipped { backfilled } => {
                    report.skipped += 1;
                    unsaved += usize::from(backfilled);
                }
                ImportOutcome::Failed => report.failed += 1,
            }
            if unsaved >= SAVE_EVERY.max(existing.len() / 20) {
                let _writes = runtime.writes();
                self.persist_encrypted_index(&vault, generation)?;
                unsaved = 0;
            }
            progress(&EncryptedVaultImportProgress {
                processed,
                total: report.total,
                imported: report.imported,
                skipped: report.skipped,
                failed: report.failed,
            });
        }
        if unsaved > 0 {
            let _writes = runtime.writes();
            self.persist_encrypted_index(&vault, generation)?;
        }
        Ok(report)
    }

    #[allow(clippy::too_many_arguments)]
    fn import_one(
        &self,
        vault: &EncryptedVault,
        generation: u64,
        vault_root: &Path,
        source_root: &Path,
        path: &Path,
        relative_path: &str,
        media_kind: VaultMediaKind,
        legacy: Option<&LegacyEntry>,
        existing: &mut KnownFiles,
    ) -> Result<ImportOutcome, LibraryError> {
        let Ok(metadata) = fs::symlink_metadata(path) else {
            return Ok(ImportOutcome::Failed);
        };
        if !metadata.is_file() {
            return Ok(ImportOutcome::Failed);
        }
        let byte_size = metadata.len();
        let key = (relative_path.to_owned(), byte_size);
        // Same path and size is only a hint (another source folder can reuse the path):
        // the file counts as imported only when its content hash matches.
        if let Some(candidates) = existing.get_mut(&key) {
            let Some(source_hash) = hash_file(path) else {
                return Ok(ImportOutcome::Failed);
            };
            match find_duplicate(vault, candidates, &source_hash) {
                Duplicate::Yes { backfill: None } => {
                    return Ok(ImportOutcome::Skipped { backfilled: false })
                }
                Duplicate::Yes {
                    backfill: Some(object_id),
                } => {
                    for known in candidates.iter_mut() {
                        if known.object_id == object_id {
                            known.content_sha256 = Some(source_hash.clone());
                        }
                    }
                    self.record_content_hash(generation, &object_id, &source_hash)?;
                    return Ok(ImportOutcome::Skipped { backfilled: true });
                }
                Duplicate::No => {}
            }
        }
        let kind = match media_kind {
            VaultMediaKind::Video => VaultItemKind::Video,
            VaultMediaKind::Image | VaultMediaKind::Gif => VaultItemKind::Image,
        };
        let legacy_thumbnail = legacy
            .and_then(|entry| entry.custom_thumbnail.as_deref())
            .and_then(|relative| read_legacy_thumbnail(source_root, relative));
        let (width, height, generated) = match kind {
            VaultItemKind::Image => image_facts(path),
            VaultItemKind::Video => {
                let facts = self.encrypted_vault.env.video.inspect(path);
                (facts.width, facts.height, facts.poster)
            }
        };
        let Ok(mut file) = File::open(path) else {
            return Ok(ImportOutcome::Failed);
        };

        let _writes = self.encrypted_vault.writes();
        if self
            .encrypted_vault
            .state()
            .session_matching(generation)
            .is_none()
        {
            return Err(LibraryError::EncryptedVaultLocked);
        }
        let (object_id, content_sha256) = match vault.write_object_hashed(&mut file) {
            Ok(written) => written,
            Err(VaultError::Changed) => {
                return Err(self.vault_write_error(generation, VaultError::Changed))
            }
            Err(_) if !vault_present(vault_root) => return Err(LibraryError::EncryptedVaultLocked),
            Err(_) => return Ok(ImportOutcome::Failed),
        };
        let store = |bytes: Option<Vec<u8>>| {
            bytes.and_then(|bytes| vault.write_object(&mut bytes.as_slice()).ok())
        };
        let legacy_thumbnail_id = store(legacy_thumbnail);
        let generated_id = store(generated);
        let (thumbnail_object_id, poster_object_id) = match kind {
            VaultItemKind::Image => (legacy_thumbnail_id.clone().or(generated_id), None),
            VaultItemKind::Video => (legacy_thumbnail_id.clone(), generated_id),
        };
        let legacy_title = legacy.and_then(|entry| entry.title.clone());
        let has_thumbnail = thumbnail_object_id.is_some() || poster_object_id.is_some();
        let item = VaultItem {
            id: Uuid::new_v4().to_string(),
            object_id: object_id.clone(),
            original_relative_path: relative_path.to_owned(),
            original_file_name: relative_path
                .rsplit('/')
                .next()
                .unwrap_or(relative_path)
                .to_owned(),
            kind,
            byte_size,
            width,
            height,
            imported_at: chrono::Utc::now().to_rfc3339(),
            title: legacy_title.clone(),
            thumbnail_object_id,
            poster_object_id,
            trashed_at: None,
            content_sha256: Some(content_sha256.clone()),
            thumbnail_sha256: None,
        };
        {
            let mut state = self.encrypted_vault.state();
            let session = state
                .session_matching(generation)
                .ok_or(LibraryError::EncryptedVaultLocked)?;
            session.index.items.push(item);
        }
        existing.entry(key).or_default().push(Known {
            object_id,
            content_sha256: Some(content_sha256),
        });
        Ok(ImportOutcome::Imported {
            legacy_title: legacy_title.is_some(),
            legacy_thumbnail: legacy_thumbnail_id.is_some(),
            has_thumbnail,
        })
    }

    /// Applies a `<video>_thumb.<image>` sidecar as the custom thumbnail of its sibling video
    /// `video_path`. A sidecar already in the vault with the same content (as an image item,
    /// or as that video's custom thumbnail) is skipped as present. A sidecar whose video
    /// already has a different custom thumbnail is not stored and is reported separately
    /// (`SidecarSkipped`), never as present. `None` when the video is not in the vault (for
    /// example its import failed) or the file is too large for a thumbnail: the caller then
    /// imports it as an ordinary image.
    #[allow(clippy::too_many_arguments)]
    fn import_sidecar(
        &self,
        vault: &EncryptedVault,
        generation: u64,
        vault_root: &Path,
        path: &Path,
        relative_path: &str,
        video_path: &str,
        existing: &KnownFiles,
    ) -> Result<Option<ImportOutcome>, LibraryError> {
        let Ok(metadata) = fs::symlink_metadata(path) else {
            return Ok(Some(ImportOutcome::Failed));
        };
        if !metadata.is_file() {
            return Ok(Some(ImportOutcome::Failed));
        }
        let mut source_hash = None;
        if let Some(candidates) = existing.get(&(relative_path.to_owned(), metadata.len())) {
            let Some(hash) = hash_file(path) else {
                return Ok(Some(ImportOutcome::Failed));
            };
            if let Duplicate::Yes { backfill } = find_duplicate(vault, candidates, &hash) {
                if let Some(object_id) = &backfill {
                    self.record_content_hash(generation, object_id, &hash)?;
                }
                return Ok(Some(ImportOutcome::Skipped {
                    backfilled: backfill.is_some(),
                }));
            }
            source_hash = Some(hash);
        }
        if metadata.len() > MAX_LEGACY_THUMBNAIL_BYTES {
            return Ok(None);
        }
        let _writes = self.encrypted_vault.writes();
        let video_position = |session: &Session| {
            session.index.items.iter().rposition(|item| {
                item.kind == VaultItemKind::Video
                    && item.trashed_at.is_none()
                    && item.original_relative_path == video_path
            })
        };
        let current_thumbnail = {
            let mut state = self.encrypted_vault.state();
            let session = state
                .session_matching(generation)
                .ok_or(LibraryError::EncryptedVaultLocked)?;
            let Some(position) = video_position(session) else {
                return Ok(None);
            };
            let video = &session.index.items[position];
            video
                .thumbnail_object_id
                .clone()
                .map(|object_id| (object_id, video.thumbnail_sha256.clone()))
        };
        if let Some((object_id, recorded)) = current_thumbnail {
            let Some(hash) = source_hash.or_else(|| hash_file(path)) else {
                return Ok(Some(ImportOutcome::Failed));
            };
            let same = match &recorded {
                Some(recorded) => *recorded == hash,
                None => vault
                    .object_sha256(&object_id)
                    .is_ok_and(|thumbnail| thumbnail == hash),
            };
            if !same {
                return Ok(Some(ImportOutcome::SidecarSkipped));
            }
            if recorded.is_none() {
                let mut state = self.encrypted_vault.state();
                let session = state
                    .session_matching(generation)
                    .ok_or(LibraryError::EncryptedVaultLocked)?;
                if let Some(position) = video_position(session) {
                    session.index.items[position].thumbnail_sha256 = Some(hash);
                }
            }
            return Ok(Some(ImportOutcome::Skipped {
                backfilled: recorded.is_none(),
            }));
        }
        let Ok(mut file) = File::open(path) else {
            return Ok(Some(ImportOutcome::Failed));
        };
        let (object_id, hash) = match vault.write_object_hashed(&mut file) {
            Ok(written) => written,
            Err(VaultError::Changed) => {
                return Err(self.vault_write_error(generation, VaultError::Changed))
            }
            Err(_) if !vault_present(vault_root) => return Err(LibraryError::EncryptedVaultLocked),
            Err(_) => return Ok(Some(ImportOutcome::Failed)),
        };
        let mut state = self.encrypted_vault.state();
        let session = state
            .session_matching(generation)
            .ok_or(LibraryError::EncryptedVaultLocked)?;
        // Every index change holds the write lock, so the video is still where it was.
        let position = video_position(session).ok_or(LibraryError::EncryptedVaultLocked)?;
        let video = &mut session.index.items[position];
        video.thumbnail_object_id = Some(object_id);
        video.thumbnail_sha256 = Some(hash);
        Ok(Some(ImportOutcome::SidecarApplied))
    }

    /// Records the content hash confirmed for an older item (saved with the next index save).
    fn record_content_hash(
        &self,
        generation: u64,
        object_id: &str,
        hash: &str,
    ) -> Result<(), LibraryError> {
        let _writes = self.encrypted_vault.writes();
        let mut state = self.encrypted_vault.state();
        let session = state
            .session_matching(generation)
            .ok_or(LibraryError::EncryptedVaultLocked)?;
        for item in session
            .index
            .items
            .iter_mut()
            .filter(|item| item.object_id == object_id)
        {
            item.content_sha256 = Some(hash.to_owned());
        }
        Ok(())
    }

    /// Maps a failed vault write. `Changed` (another vault, or none, at the session root)
    /// also drops the session, so nothing more is written there and status reports it.
    fn vault_write_error(&self, generation: u64, error: VaultError) -> LibraryError {
        if matches!(error, VaultError::Changed) {
            let mut state = self.encrypted_vault.state();
            if state.session_matching(generation).is_some() {
                state.forget_location();
            }
        }
        vault_error(error)
    }

    /// Image items that are a sibling video's `_thumb` sidecar, imported before the sidecar
    /// rule existed. Read-only.
    pub fn preview_encrypted_vault_sidecar_cleanup(
        &self,
    ) -> Result<EncryptedVaultSidecarCleanupPreview, LibraryError> {
        let state = self.encrypted_vault.state();
        let session = state
            .session
            .as_ref()
            .ok_or(LibraryError::EncryptedVaultLocked)?;
        let matches = sidecar_image_matches(&session.index);
        Ok(EncryptedVaultSidecarCleanupPreview {
            count: matches.len() as u64,
            examples: matches
                .iter()
                .take(MAX_CLEANUP_EXAMPLES)
                .map(|(image, _)| session.index.items[*image].original_file_name.clone())
                .collect(),
        })
    }

    /// Turns the sidecar image items of the preview into their video's custom thumbnail
    /// (when the video has none; the encrypted object is reused as-is) and removes them from
    /// the index, saved once. Objects no longer referenced (the images' generated
    /// thumbnails, and images not moved) are then deleted. Refused while an import runs.
    pub fn apply_encrypted_vault_sidecar_cleanup(
        &self,
    ) -> Result<EncryptedVaultSidecarCleanupResult, LibraryError> {
        let runtime = &*self.encrypted_vault;
        if runtime.import_running() {
            return Err(LibraryError::EncryptedVaultImportRunning);
        }
        let _writes = runtime.writes();
        if runtime.import_running() {
            return Err(LibraryError::EncryptedVaultImportRunning);
        }
        let (vault, generation, mut index, from_backup_index) = {
            let state = runtime.state();
            let session = state
                .session
                .as_ref()
                .ok_or(LibraryError::EncryptedVaultLocked)?;
            (
                Arc::clone(&session.vault),
                session.generation,
                session.index.clone(),
                session.from_backup_index,
            )
        };
        let matches = sidecar_image_matches(&index);
        let mut result = EncryptedVaultSidecarCleanupResult::default();
        if matches.is_empty() {
            return Ok(result);
        }
        let mut removed = HashSet::new();
        for (image, video) in matches {
            if index.items[video].thumbnail_object_id.is_none() {
                index.items[video].thumbnail_object_id = Some(index.items[image].object_id.clone());
                index.items[video].thumbnail_sha256 = index.items[image].content_sha256.clone();
                result.moved_to_video_thumbnail += 1;
            }
            removed.insert(image);
        }
        let (dropped, kept): (Vec<_>, Vec<_>) = std::mem::take(&mut index.items)
            .into_iter()
            .enumerate()
            .partition(|(position, _)| removed.contains(position));
        index.items = kept.into_iter().map(|(_, item)| item).collect();
        result.removed = removed.len() as u64;
        vault
            .save_index(&mut index)
            .map_err(|error| self.vault_write_error(generation, error))?;
        {
            let mut state = runtime.state();
            let session = state
                .session_matching(generation)
                .ok_or(LibraryError::EncryptedVaultLocked)?;
            session.index = index.clone();
        }
        // Delete exactly the objects this cleanup stopped referencing (best effort; anything
        // left behind is removed by a later unlock). Nothing is deleted while the session
        // runs on the backup index.
        if !from_backup_index {
            let referenced = index.referenced_objects();
            let unreferenced = dropped
                .iter()
                .flat_map(|(_, item)| {
                    [
                        Some(item.object_id.as_str()),
                        item.thumbnail_object_id.as_deref(),
                        item.poster_object_id.as_deref(),
                    ]
                })
                .flatten()
                .filter(|object_id| !referenced.contains(object_id));
            let _ = vault.remove_objects(unreferenced);
        }
        Ok(result)
    }

    /// Saves the session index. The caller holds the write lock.
    fn persist_encrypted_index(
        &self,
        vault: &EncryptedVault,
        generation: u64,
    ) -> Result<(), LibraryError> {
        let mut snapshot = self
            .encrypted_vault
            .state()
            .session_matching(generation)
            .map(|session| session.index.clone())
            .ok_or(LibraryError::EncryptedVaultLocked)?;
        vault
            .save_index(&mut snapshot)
            .map_err(|error| self.vault_write_error(generation, error))?;
        if let Some(session) = self.encrypted_vault.state().session_matching(generation) {
            session.index.revision = snapshot.revision;
        }
        Ok(())
    }

    /// Loads the index (or its previous generation if it is damaged), removes orphans left
    /// by a crash and makes this the unlocked session.
    fn install_encrypted_session(
        &self,
        root: PathBuf,
        vault: EncryptedVault,
    ) -> Result<(), LibraryError> {
        let _writes = self.encrypted_vault.writes();
        let (index, from_backup_index) = vault.load_index_with_fallback().map_err(vault_error)?;
        // Best effort: a read-only or busy USB must not prevent opening the vault. Recent
        // objects may belong to an import in another runtime; a backup index does not know
        // the newest objects, so it never drives deletion.
        if !from_backup_index {
            let _ = vault.remove_orphans(&index, ORPHAN_SAFETY_WINDOW);
        }
        let vault_id = vault.vault_id();
        let mut state = self.encrypted_vault.state();
        state.generation += 1;
        state.session = Some(Session {
            vault: Arc::new(vault),
            root: root.clone(),
            index,
            generation: state.generation,
            from_backup_index,
        });
        state.located = Some(Located { root, vault_id });
        state.auto_unlock_tried = Some(vault_id);
        Ok(())
    }

    fn try_auto_unlock(&self, located: &Located) {
        let vault_id = located.vault_id;
        let stored = self
            .encrypted_vault
            .env
            .key_store
            .read(&vault_id.to_string());
        let Ok(Some(mut bytes)) = stored else {
            self.encrypted_vault.state().remembered = Some((vault_id, false));
            return;
        };
        self.encrypted_vault.state().remembered = Some((vault_id, true));
        let key = MasterKey::import_from_credential_store(&bytes);
        bytes.zeroize();
        let Ok(key) = key else { return };
        // A stale or foreign key fails here and the vault simply stays locked.
        if let Ok(vault) = EncryptedVault::unlock_with_key(&located.root, key) {
            let _ = self.install_encrypted_session(located.root.clone(), vault);
        }
    }

    fn apply_remember(&self, vault_id: Uuid, key: Option<&[u8]>) {
        let store = &self.encrypted_vault.env.key_store;
        let id = vault_id.to_string();
        let remembered = match key {
            Some(key) => store.write(&id, key).is_ok(),
            None => {
                let _ = store.delete(&id);
                false
            }
        };
        self.encrypted_vault.state().remembered = Some((vault_id, remembered));
    }

    fn locate_encrypted_vault(&self) -> Result<Option<Located>, LibraryError> {
        let (cached, settings) = {
            let state = self.encrypted_vault.state();
            (state.located.clone(), state.settings.clone())
        };
        let settings = match settings {
            Some(settings) => settings,
            None => {
                let settings = self.read_encrypted_vault_settings()?;
                self.encrypted_vault.state().settings = Some(settings.clone());
                settings
            }
        };
        let mut candidates: Vec<PathBuf> = Vec::new();
        let preferred_roots = cached
            .map(|located| located.root)
            .into_iter()
            .chain(settings.last_root);
        for root in preferred_roots.chain((self.encrypted_vault.env.mount_roots)()) {
            if !candidates.contains(&root) {
                candidates.push(root);
            }
        }
        let mut fallback = None;
        for root in candidates {
            let Ok(vault_id) = EncryptedVault::read_vault_id(&root) else {
                continue;
            };
            let located = Located { root, vault_id };
            if settings
                .vault_id
                .is_none_or(|preferred| preferred == vault_id)
            {
                return Ok(Some(located));
            }
            fallback.get_or_insert(located);
        }
        Ok(fallback)
    }

    fn read_encrypted_vault_settings(&self) -> Result<StoredSettings, LibraryError> {
        let (vault_id, last_root) = self.connection()?.query_row(
            "SELECT private_vault_id, private_vault_last_root FROM library_settings WHERE singleton=1",
            [],
            |row| Ok((row.get::<_, Option<String>>(0)?, row.get::<_, Option<String>>(1)?)),
        )?;
        Ok(StoredSettings {
            vault_id: vault_id.and_then(|value| Uuid::parse_str(&value).ok()),
            last_root: last_root.map(PathBuf::from),
        })
    }

    fn save_encrypted_vault_settings(
        &self,
        vault_id: Uuid,
        root: &Path,
    ) -> Result<(), LibraryError> {
        let root_string = root.to_string_lossy().into_owned();
        self.connection()?.execute(
            "UPDATE library_settings SET private_vault_id=?1, private_vault_last_root=?2 WHERE singleton=1",
            rusqlite::params![vault_id.to_string(), root_string],
        )?;
        self.encrypted_vault.state().settings = Some(StoredSettings {
            vault_id: Some(vault_id),
            last_root: Some(root.to_path_buf()),
        });
        Ok(())
    }
}

/// Decodes a plaintext source image on the trusted PC and encodes the thumbnail in memory.
/// An undecodable image is still imported (the original is what matters), without size or
/// thumbnail.
fn image_facts(path: &Path) -> (Option<u32>, Option<u32>, Option<Vec<u8>>) {
    let decoded = (|| {
        let reader = image::ImageReader::open(path)
            .ok()?
            .with_guessed_format()
            .ok()?;
        let mut decoder = reader.into_decoder().ok()?;
        let orientation = decoder
            .orientation()
            .unwrap_or(image::metadata::Orientation::NoTransforms);
        let mut image = image::DynamicImage::from_decoder(decoder).ok()?;
        image.apply_orientation(orientation);
        (image.width() > 0 && image.height() > 0).then_some(image)
    })();
    let Some(image) = decoded else {
        return (None, None, None);
    };
    let thumbnail = crate::library::ingestion::encode_thumbnail_webp(&image).ok();
    (Some(image.width()), Some(image.height()), thumbnail)
}

/// Reads titles and custom thumbnails from an old plaintext vault index, read-only.
fn read_legacy_index(source: &Path) -> HashMap<String, LegacyEntry> {
    let path = source.join(LEGACY_METADATA_DIR).join("index.sqlite");
    let is_file = fs::symlink_metadata(&path)
        .is_ok_and(|metadata| metadata.is_file() && !metadata.file_type().is_symlink());
    if !is_file {
        return HashMap::new();
    }
    let read = || -> rusqlite::Result<HashMap<String, LegacyEntry>> {
        let connection = Connection::open_with_flags(
            &path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        let columns = {
            let mut statement = connection.prepare("PRAGMA table_info(vault_assets)")?;
            let rows = statement.query_map([], |row| row.get::<_, String>(1))?;
            rows.collect::<Result<Vec<_>, _>>()?
        };
        let column = |name: &str| {
            if columns.iter().any(|column| column == name) {
                name.to_owned()
            } else {
                "NULL".to_owned()
            }
        };
        let sql = format!(
            "SELECT relative_path, {}, {} FROM vault_assets WHERE scan_error IS NULL",
            column("title"),
            column("custom_thumbnail_relative_path"),
        );
        let mut statement = connection.prepare(&sql)?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        })?;
        let mut entries = HashMap::new();
        for row in rows {
            let (relative_path, title, custom_thumbnail) = row?;
            let title = normalized_title(title.as_deref()).ok().flatten();
            if title.is_some() || custom_thumbnail.is_some() {
                entries.insert(
                    relative_path,
                    LegacyEntry {
                        title,
                        custom_thumbnail,
                    },
                );
            }
        }
        Ok(entries)
    };
    read().unwrap_or_default()
}

fn read_legacy_thumbnail(source: &Path, relative: &str) -> Option<Vec<u8>> {
    let path = source
        .join(LEGACY_METADATA_DIR)
        .join(validated_relative(relative).ok()?);
    let metadata = fs::symlink_metadata(&path).ok()?;
    if !metadata.is_file() || metadata.len() > MAX_LEGACY_THUMBNAIL_BYTES {
        return None;
    }
    fs::read(path).ok()
}

#[cfg(test)]
pub(crate) mod test_support {
    use std::{
        collections::HashMap,
        path::Path,
        sync::{
            atomic::{AtomicUsize, Ordering},
            Mutex, PoisonError,
        },
    };

    use super::{VaultKeyStore, VideoFacts, VideoInspector};
    use crate::library::error::LibraryError;

    #[derive(Default)]
    pub(crate) struct MemoryKeyStore {
        values: Mutex<HashMap<String, Vec<u8>>>,
        reads: AtomicUsize,
    }

    impl VaultKeyStore for MemoryKeyStore {
        fn read(&self, vault_id: &str) -> Result<Option<Vec<u8>>, LibraryError> {
            self.reads.fetch_add(1, Ordering::SeqCst);
            Ok(self
                .values
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .get(vault_id)
                .cloned())
        }

        fn write(&self, vault_id: &str, key: &[u8]) -> Result<(), LibraryError> {
            self.values
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .insert(vault_id.to_owned(), key.to_vec());
            Ok(())
        }

        fn delete(&self, vault_id: &str) -> Result<(), LibraryError> {
            self.values
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .remove(vault_id);
            Ok(())
        }

        fn read_count(&self) -> usize {
            self.reads.load(Ordering::SeqCst)
        }
    }

    /// FFmpeg-free stand-in: a fixed 64x36 size and a generated WebP poster.
    pub(crate) struct FakeVideoInspector;

    impl VideoInspector for FakeVideoInspector {
        fn inspect(&self, _source: &Path) -> VideoFacts {
            let frame = image::DynamicImage::new_rgb8(64, 36);
            VideoFacts {
                width: Some(64),
                height: Some(36),
                poster: crate::library::ingestion::encode_thumbnail_webp(&frame).ok(),
            }
        }
    }

    pub(crate) fn key_store_reads(library: &crate::library::Library) -> usize {
        library.encrypted_vault.env.key_store.read_count()
    }
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        path::{Path, PathBuf},
    };

    use super::{test_support::key_store_reads, EncryptedVaultMediaVariant};
    use crate::library::{
        error::LibraryError,
        external_vault::index::{self, IndexedVaultAsset},
        models::{
            EncryptedVaultItemKind, EncryptedVaultQuery, EncryptedVaultSecretInput,
            EncryptedVaultState,
        },
        Library,
    };

    const PASSWORD: &str = "correct horse";
    const MARKER: &[u8] = b"PLAINTEXT-MARKER-9c1e";
    const SECRET_NAME: &str = "SECRETNAME";

    fn setup() -> (tempfile::TempDir, Library, PathBuf) {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path().join("library")).unwrap();
        let vault = temp.path().join("vault");
        fs::create_dir(&vault).unwrap();
        (temp, library, vault)
    }

    fn password(value: &str) -> EncryptedVaultSecretInput {
        EncryptedVaultSecretInput::Password(value.into())
    }

    fn query(kind: Option<EncryptedVaultItemKind>, offset: u64, limit: u32) -> EncryptedVaultQuery {
        EncryptedVaultQuery {
            kind,
            offset,
            limit,
            trashed: false,
        }
    }

    fn write_png(path: &Path, width: u32, height: u32) {
        image::RgbImage::from_pixel(width, height, image::Rgb([200, 40, 90]))
            .save(path)
            .unwrap();
    }

    fn video_bytes() -> Vec<u8> {
        let mut bytes = MARKER.to_vec();
        bytes.extend((0..200_000_u32).map(|value| (value % 251) as u8));
        bytes
    }

    fn legacy_asset(relative_path: &str, kind: &str) -> IndexedVaultAsset {
        IndexedVaultAsset {
            id: uuid::Uuid::new_v4().to_string(),
            relative_path: relative_path.into(),
            media_kind: kind.into(),
            original_name: relative_path.rsplit('/').next().unwrap().into(),
            title: None,
            byte_size: 1,
            modified_ns: 1,
            modified_at: "2026-09-13T00:00:00Z".into(),
            width: 10,
            height: 10,
            duration_ms: None,
            container: None,
            video_codec: None,
            audio_codec: None,
            thumbnail_relative_path: None,
            custom_thumbnail_relative_path: None,
            playback_relative_path: None,
            scrub_relative_dir: None,
            scrub_frame_count: 0,
            scan_error: None,
        }
    }

    /// A plaintext source folder: an image, an undecodable image, a video, an old plaintext
    /// vault index with one title and one custom thumbnail, and files that must be ignored.
    fn source_folder(root: &Path) -> (PathBuf, Vec<u8>) {
        let source = root.join("source");
        fs::create_dir_all(source.join("a")).unwrap();
        fs::create_dir_all(source.join("b")).unwrap();
        write_png(&source.join(format!("a/photo {SECRET_NAME}.png")), 40, 30);
        fs::write(source.join(format!("b/broken-{SECRET_NAME}.jpg")), MARKER).unwrap();
        fs::write(
            source.join(format!("clip-{SECRET_NAME}.mp4")),
            video_bytes(),
        )
        .unwrap();
        fs::write(source.join("notes.txt"), MARKER).unwrap();
        let metadata = source.join(".lakomics");
        fs::create_dir_all(metadata.join("thumbnails")).unwrap();
        write_png(&metadata.join("thumbnails/ignored.png"), 4, 4);
        fs::create_dir_all(metadata.join("custom-thumbnails")).unwrap();
        let custom = image::DynamicImage::new_rgb8(20, 10);
        let custom = crate::library::ingestion::encode_thumbnail_webp(&custom).unwrap();
        fs::write(metadata.join("custom-thumbnails/clip.webp"), &custom).unwrap();
        let database = metadata.join("index.sqlite");
        index::initialize_index(&database).unwrap();
        let mut photo = legacy_asset(&format!("a/photo {SECRET_NAME}.png"), "image");
        photo.title = Some("  legacy title MARKERTITLE  ".into());
        index::upsert_asset(&database, &photo).unwrap();
        let mut clip = legacy_asset(&format!("clip-{SECRET_NAME}.mp4"), "video");
        clip.custom_thumbnail_relative_path = Some("custom-thumbnails/clip.webp".into());
        index::upsert_asset(&database, &clip).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(
            source.join(format!("a/photo {SECRET_NAME}.png")),
            source.join("linked.png"),
        )
        .unwrap();
        (source, custom)
    }

    fn all_files(root: &Path) -> Vec<PathBuf> {
        let mut pending = vec![root.to_path_buf()];
        let mut files = Vec::new();
        while let Some(directory) = pending.pop() {
            for entry in fs::read_dir(directory).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    pending.push(path);
                } else {
                    files.push(path);
                }
            }
        }
        files
    }

    fn contains(haystack: &[u8], needle: &[u8]) -> bool {
        haystack
            .windows(needle.len())
            .any(|window| window == needle)
    }

    fn read_media(library: &Library, id: &str, variant: EncryptedVaultMediaVariant) -> Vec<u8> {
        let mut media = library.encrypted_vault_media(id, variant).unwrap();
        let len = media.len();
        media.read_range(0, len).unwrap()
    }

    #[test]
    fn status_moves_through_create_lock_and_unlock_with_password_or_recovery_key() {
        let (_temp, library, vault) = setup();
        assert_eq!(
            library.encrypted_vault_status().unwrap().state,
            EncryptedVaultState::Absent
        );

        let created = library
            .create_encrypted_vault(&vault, PASSWORD, false)
            .unwrap();
        assert_eq!(created.recovery_key.len(), 64);
        assert_eq!(created.status.state, EncryptedVaultState::Unlocked);
        assert_eq!(created.status.item_count, Some(0));
        assert!(!created.status.remembered);
        let vault_id = created.status.vault_id.clone().unwrap();
        let stored: String = library
            .connection()
            .unwrap()
            .query_row(
                "SELECT private_vault_id FROM library_settings WHERE singleton=1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(stored, vault_id);

        let locked = library.lock_encrypted_vault();
        assert_eq!(locked.state, EncryptedVaultState::Locked);
        assert_eq!(locked.item_count, None);
        let status = library.encrypted_vault_status().unwrap();
        assert_eq!(status.state, EncryptedVaultState::Locked);
        assert_eq!(status.vault_id.as_deref(), Some(vault_id.as_str()));
        assert!(matches!(
            library.list_encrypted_vault_items(query(None, 0, 10)),
            Err(LibraryError::EncryptedVaultLocked)
        ));

        let wrong = library
            .unlock_encrypted_vault(&password("wrong horse"), false)
            .unwrap_err();
        assert!(matches!(wrong, LibraryError::EncryptedVaultWrongSecret));
        let command = crate::commands::CommandError::from(wrong);
        assert_eq!(command.code, "encrypted_vault_wrong_secret");
        assert!(!command.message.contains(vault.to_string_lossy().as_ref()));
        let malformed = library
            .unlock_encrypted_vault(&EncryptedVaultSecretInput::RecoveryKey("abc".into()), false)
            .unwrap_err();
        assert!(matches!(
            malformed,
            LibraryError::EncryptedVaultInvalidRecoveryKey
        ));

        let unlocked = library
            .unlock_encrypted_vault(&password(PASSWORD), false)
            .unwrap();
        assert_eq!(unlocked.state, EncryptedVaultState::Unlocked);
        library.lock_encrypted_vault();
        let recovery = EncryptedVaultSecretInput::RecoveryKey(created.recovery_key.clone());
        let unlocked = library.unlock_encrypted_vault(&recovery, false).unwrap();
        assert_eq!(unlocked.state, EncryptedVaultState::Unlocked);

        library
            .change_encrypted_vault_password(&recovery, "new horse")
            .unwrap();
        library.lock_encrypted_vault();
        assert!(library
            .unlock_encrypted_vault(&password(PASSWORD), false)
            .is_err());
        library
            .unlock_encrypted_vault(&password("new horse"), false)
            .unwrap();
    }

    #[test]
    fn create_refuses_existing_vaults_and_main_library_boundaries() {
        let (temp, library, vault) = setup();
        library
            .create_encrypted_vault(&vault, PASSWORD, false)
            .unwrap();
        assert!(matches!(
            library.create_encrypted_vault(&vault, PASSWORD, false),
            Err(LibraryError::EncryptedVaultAlreadyExists)
        ));
        let inside = temp.path().join("library/inside");
        fs::create_dir(&inside).unwrap();
        assert!(matches!(
            library.create_encrypted_vault(&inside, PASSWORD, false),
            Err(LibraryError::EncryptedVaultInvalidRoot)
        ));
        assert!(matches!(
            library.create_encrypted_vault(temp.path(), PASSWORD, false),
            Err(LibraryError::EncryptedVaultInvalidRoot)
        ));
    }

    #[test]
    fn remembered_key_unlocks_once_per_appearance_without_polling_the_store() {
        let (temp, library, vault) = setup();
        let created = library
            .create_encrypted_vault(&vault, PASSWORD, true)
            .unwrap();
        assert!(created.status.remembered);

        // A manual lock is not undone by the next status polls.
        library.lock_encrypted_vault();
        for _ in 0..3 {
            let status = library.encrypted_vault_status().unwrap();
            assert_eq!(status.state, EncryptedVaultState::Locked);
        }
        assert_eq!(key_store_reads(&library), 0);

        // Removing and reinserting the USB retries the remembered key exactly once.
        let away = temp.path().join("away");
        fs::rename(&vault, &away).unwrap();
        assert_eq!(
            library.encrypted_vault_status().unwrap().state,
            EncryptedVaultState::Absent
        );
        fs::rename(&away, &vault).unwrap();
        let status = library.encrypted_vault_status().unwrap();
        assert_eq!(status.state, EncryptedVaultState::Unlocked);
        assert!(status.remembered);
        library.encrypted_vault_status().unwrap();
        assert_eq!(key_store_reads(&library), 1);

        // Forgetting keeps the vault open, and the next appearance asks for the password.
        let forgotten = library.forget_encrypted_vault_key().unwrap();
        assert_eq!(forgotten.state, EncryptedVaultState::Unlocked);
        assert!(!forgotten.remembered);
        fs::rename(&vault, &away).unwrap();
        library.encrypted_vault_status().unwrap();
        fs::rename(&away, &vault).unwrap();
        assert_eq!(
            library.encrypted_vault_status().unwrap().state,
            EncryptedVaultState::Locked
        );
    }

    #[test]
    fn a_new_library_session_auto_unlocks_from_the_remembered_key() {
        let (_temp, library, vault) = setup();
        let created = library
            .create_encrypted_vault(&vault, PASSWORD, true)
            .unwrap();
        let vault_id = created.status.vault_id.unwrap();
        // Simulate an app restart: a fresh runtime whose store holds this vault's key.
        let key = {
            let state = library.encrypted_vault.state();
            let session = state.session.as_ref().unwrap();
            session.vault.master_key().export_for_credential_store()
        };
        let fresh = super::EncryptedVaultRuntime::default();
        fresh
            .env
            .key_store
            .write(&vault_id, key.as_bytes())
            .unwrap();
        let mut restarted = library.clone();
        restarted.encrypted_vault = std::sync::Arc::new(fresh);
        let status = restarted.encrypted_vault_status().unwrap();
        assert_eq!(status.state, EncryptedVaultState::Unlocked);
        assert!(status.remembered);
    }

    #[test]
    fn removing_the_vault_root_locks_and_drops_the_decrypted_index() {
        let (temp, library, vault) = setup();
        library
            .create_encrypted_vault(&vault, PASSWORD, false)
            .unwrap();
        let source = temp.path().join("source");
        fs::create_dir(&source).unwrap();
        write_png(&source.join("one.png"), 8, 8);
        library
            .import_into_encrypted_vault(&source, &mut |_| {})
            .unwrap();
        let id = library
            .list_encrypted_vault_items(query(None, 0, 10))
            .unwrap()
            .items[0]
            .id
            .clone();

        let away = temp.path().join("away");
        fs::rename(&vault, &away).unwrap();
        let status = library.encrypted_vault_status().unwrap();
        assert_eq!(status.state, EncryptedVaultState::Absent);
        assert!(library.encrypted_vault.state().session.is_none());
        assert!(matches!(
            library.encrypted_vault_media(&id, EncryptedVaultMediaVariant::Asset),
            Err(LibraryError::EncryptedVaultLocked)
        ));

        fs::rename(&away, &vault).unwrap();
        assert_eq!(
            library.encrypted_vault_status().unwrap().state,
            EncryptedVaultState::Locked
        );
        library
            .unlock_encrypted_vault(&password(PASSWORD), false)
            .unwrap();
        assert_eq!(
            read_media(&library, &id, EncryptedVaultMediaVariant::Asset),
            fs::read(source.join("one.png")).unwrap()
        );
    }

    #[test]
    fn import_encrypts_files_carries_legacy_metadata_and_resumes() {
        let (temp, library, vault) = setup();
        library
            .create_encrypted_vault(&vault, PASSWORD, false)
            .unwrap();
        let (source, custom_thumbnail) = source_folder(temp.path());
        let legacy_index_before = fs::read(source.join(".lakomics/index.sqlite")).unwrap();

        let mut events = Vec::new();
        let report = library
            .import_into_encrypted_vault(&source, &mut |progress| events.push(progress.clone()))
            .unwrap();
        assert_eq!(
            (report.total, report.imported, report.skipped, report.failed),
            (3, 3, 0, 0)
        );
        assert_eq!((report.legacy_titles, report.legacy_thumbnails), (1, 1));
        assert_eq!(report.without_thumbnail, 1);
        assert_eq!(events.len(), 3);
        assert_eq!(events.last().unwrap().processed, 3);
        assert_eq!(events.last().unwrap().imported, 3);
        assert_eq!(
            fs::read(source.join(".lakomics/index.sqlite")).unwrap(),
            legacy_index_before,
            "the legacy index is read-only"
        );

        let again = library
            .import_into_encrypted_vault(&source, &mut |_| {})
            .unwrap();
        assert_eq!((again.imported, again.skipped), (0, 3));

        // Newest first: files import in relative-path order.
        let page = library
            .list_encrypted_vault_items(query(None, 0, 10))
            .unwrap();
        assert_eq!(page.total_count, 3);
        let names = page
            .items
            .iter()
            .map(|item| item.original_file_name.as_str())
            .collect::<Vec<_>>();
        assert_eq!(
            names,
            [
                format!("clip-{SECRET_NAME}.mp4"),
                format!("broken-{SECRET_NAME}.jpg"),
                format!("photo {SECRET_NAME}.png"),
            ]
        );
        let clip = &page.items[0];
        let broken = &page.items[1];
        let photo = &page.items[2];
        assert_eq!(clip.kind, EncryptedVaultItemKind::Video);
        assert_eq!((clip.width, clip.height), (Some(64), Some(36)));
        assert!(clip.has_thumbnail);
        assert_eq!((broken.width, broken.has_thumbnail), (None, false));
        assert_eq!((photo.width, photo.height), (Some(40), Some(30)));
        assert_eq!(photo.title.as_deref(), Some("legacy title MARKERTITLE"));
        assert_eq!(
            photo.byte_size,
            fs::metadata(source.join(format!("a/photo {SECRET_NAME}.png")))
                .unwrap()
                .len()
        );

        let first = library
            .list_encrypted_vault_items(query(None, 0, 2))
            .unwrap();
        assert_eq!((first.items.len(), first.next_offset), (2, Some(2)));
        let last = library
            .list_encrypted_vault_items(query(None, 2, 2))
            .unwrap();
        assert_eq!((last.items.len(), last.next_offset), (1, None));
        let videos = library
            .list_encrypted_vault_items(query(Some(EncryptedVaultItemKind::Video), 0, 10))
            .unwrap();
        assert_eq!(videos.total_count, 1);
        let images = library
            .list_encrypted_vault_items(query(Some(EncryptedVaultItemKind::Image), 0, 10))
            .unwrap();
        assert_eq!(images.total_count, 2);

        // Decrypted media: originals, the carried-over custom thumbnail, generated thumbnails.
        assert_eq!(
            read_media(&library, &photo.id, EncryptedVaultMediaVariant::Asset),
            fs::read(source.join(format!("a/photo {SECRET_NAME}.png"))).unwrap()
        );
        assert_eq!(
            read_media(&library, &clip.id, EncryptedVaultMediaVariant::Playback),
            video_bytes()
        );
        assert_eq!(
            read_media(&library, &clip.id, EncryptedVaultMediaVariant::Thumbnail),
            custom_thumbnail
        );
        let thumbnail = read_media(&library, &photo.id, EncryptedVaultMediaVariant::Thumbnail);
        assert!(image::load_from_memory(&thumbnail).is_ok());
        assert!(matches!(
            library.encrypted_vault_media(&photo.id, EncryptedVaultMediaVariant::Playback),
            Err(LibraryError::AssetNotFound)
        ));
        assert!(matches!(
            library.encrypted_vault_media(&broken.id, EncryptedVaultMediaVariant::Thumbnail),
            Err(LibraryError::AssetNotFound)
        ));

        // Nothing in the vault root carries a source name, title or plaintext marker.
        let files = all_files(&vault);
        assert!(!files.is_empty());
        for file in files {
            let name = file.to_string_lossy().into_owned();
            assert!(!name.contains(SECRET_NAME), "{name}");
            assert!(!name.contains("photo") && !name.contains("clip"), "{name}");
            let bytes = fs::read(&file).unwrap();
            assert!(!contains(&bytes, MARKER), "{name}");
            assert!(!contains(&bytes, SECRET_NAME.as_bytes()), "{name}");
            assert!(!contains(&bytes, b"MARKERTITLE"), "{name}");
            assert!(!contains(&bytes, b"WEBPVP8"), "no plaintext WebP in {name}");
            assert!(
                !contains(&bytes, b"\x89PNG\r\n\x1a\n"),
                "no plaintext PNG in {name}"
            );
        }
    }

    /// The reported bug: an import seemed to stop when the user left the vault view. The
    /// backend import must run to completion while the UI is gone (progress sink ignored,
    /// like a Tauri channel nobody listens to) and while status, list and media requests
    /// run concurrently; its state stays readable for a UI that comes back.
    #[test]
    fn import_runs_to_completion_during_concurrent_requests_and_keeps_its_job() {
        use std::sync::mpsc;

        let (temp, library, vault) = setup();
        library
            .create_encrypted_vault(&vault, PASSWORD, false)
            .unwrap();
        let source = temp.path().join("many");
        fs::create_dir(&source).unwrap();
        for index in 0..6 {
            write_png(&source.join(format!("{index}.png")), 8 + index, 8);
        }
        assert_eq!(library.encrypted_vault_import_job(), None);

        let (step_tx, step_rx) = mpsc::channel::<u64>();
        let (resume_tx, resume_rx) = mpsc::channel::<()>();
        let worker = {
            let library = library.clone();
            let source = source.clone();
            std::thread::spawn(move || {
                library.import_into_encrypted_vault(&source, &mut |progress| {
                    // The listener may be gone: a failed send must not stop the import.
                    let _ = step_tx.send(progress.processed);
                    let _ = resume_rx.recv();
                })
            })
        };

        let processed = step_rx.recv().unwrap();
        assert_eq!(processed, 1);
        let job = library.encrypted_vault_import_job().unwrap();
        assert!(job.running);
        assert_eq!((job.progress.processed, job.progress.total), (1, 6));
        assert!(matches!(
            library.import_into_encrypted_vault(&source, &mut |_| {}),
            Err(LibraryError::EncryptedVaultImportRunning)
        ));
        assert!(library.encrypted_vault_import_job().unwrap().running);
        // What the rest of the app does meanwhile: status polls, gallery pages, media.
        for _ in 0..3 {
            assert_eq!(
                library.encrypted_vault_status().unwrap().state,
                EncryptedVaultState::Unlocked
            );
            let page = library
                .list_encrypted_vault_items(query(None, 0, 80))
                .unwrap();
            let first = page.items.last().unwrap();
            assert!(!read_media(&library, &first.id, EncryptedVaultMediaVariant::Asset).is_empty());
        }
        // The UI went away: nobody reads progress any more.
        drop(step_rx);
        drop(resume_tx);

        let report = worker.join().unwrap().unwrap();
        assert_eq!((report.total, report.imported), (6, 6));
        let job = library.encrypted_vault_import_job().unwrap();
        assert!(!job.running);
        assert_eq!(job.progress.processed, 6);
        assert_eq!(job.report.as_ref(), Some(&report));
        assert_eq!(job.error, None);
        assert_eq!(
            library
                .list_encrypted_vault_items(query(None, 0, 80))
                .unwrap()
                .total_count,
            6
        );

        // A later import is a new job; one stopped by a lock records the error code.
        library.lock_encrypted_vault();
        assert!(library
            .import_into_encrypted_vault(&source, &mut |_| {})
            .is_err());
        let job = library.encrypted_vault_import_job().unwrap();
        assert_eq!(job.id, 2);
        assert!(!job.running);
        assert_eq!(job.error.as_deref(), Some("encrypted_vault_locked"));
    }

    #[test]
    fn import_error_codes_match_the_command_error_codes() {
        for error in [
            LibraryError::EncryptedVaultLocked,
            LibraryError::EncryptedVaultFolderUnavailable,
            LibraryError::EncryptedVaultNotFound,
            LibraryError::EncryptedVaultCorrupt,
            LibraryError::EncryptedVaultIo,
            LibraryError::EncryptedVaultCrypto,
        ] {
            let code = super::import_error_code(&error);
            assert_eq!(code, crate::commands::CommandError::from(error).code);
        }
    }

    #[test]
    fn titles_are_validated_and_survive_lock_and_unlock() {
        let (temp, library, vault) = setup();
        library
            .create_encrypted_vault(&vault, PASSWORD, false)
            .unwrap();
        let source = temp.path().join("source");
        fs::create_dir(&source).unwrap();
        write_png(&source.join("one.png"), 8, 8);
        library
            .import_into_encrypted_vault(&source, &mut |_| {})
            .unwrap();
        let id = library
            .list_encrypted_vault_items(query(None, 0, 10))
            .unwrap()
            .items[0]
            .id
            .clone();

        library
            .set_encrypted_vault_title(&id, Some("  내 사진  "))
            .unwrap();
        assert!(matches!(
            library.set_encrypted_vault_title(&id, Some(&"가".repeat(201))),
            Err(LibraryError::InvalidEncryptedVaultTitle)
        ));
        assert!(matches!(
            library.set_encrypted_vault_title(&uuid::Uuid::new_v4().to_string(), Some("x")),
            Err(LibraryError::AssetNotFound)
        ));
        library.lock_encrypted_vault();
        assert!(matches!(
            library.set_encrypted_vault_title(&id, Some("x")),
            Err(LibraryError::EncryptedVaultLocked)
        ));
        library
            .unlock_encrypted_vault(&password(PASSWORD), false)
            .unwrap();
        let item = library
            .list_encrypted_vault_items(query(None, 0, 10))
            .unwrap()
            .items
            .remove(0);
        assert_eq!(item.title.as_deref(), Some("내 사진"));

        library.set_encrypted_vault_title(&id, None).unwrap();
        library.lock_encrypted_vault();
        library
            .unlock_encrypted_vault(&password(PASSWORD), false)
            .unwrap();
        let item = library
            .list_encrypted_vault_items(query(None, 0, 10))
            .unwrap()
            .items
            .remove(0);
        assert_eq!(item.title, None);
    }

    #[test]
    fn unlock_removes_orphan_objects_left_by_an_interrupted_import() {
        let (_temp, library, vault) = setup();
        library
            .create_encrypted_vault(&vault, PASSWORD, false)
            .unwrap();
        let orphan = {
            let state = library.encrypted_vault.state();
            let session = state.session.as_ref().unwrap();
            session
                .vault
                .write_object(&mut std::io::Cursor::new(b"orphan".to_vec()))
                .unwrap()
        };
        let orphan_path = vault.join(".lakomics-vault/objects").join(&orphan);
        assert!(orphan_path.is_file());
        age(&orphan_path);
        // A fresh orphan may be an import in flight in another runtime: it stays.
        let fresh = write_unindexed_object(&library);
        let fresh_path = vault.join(".lakomics-vault/objects").join(&fresh);
        library.lock_encrypted_vault();
        library
            .unlock_encrypted_vault(&password(PASSWORD), false)
            .unwrap();
        assert!(!orphan_path.exists());
        assert!(fresh_path.exists());
    }

    /// Moves a file's modification time before the orphan safety window.
    fn age(path: &Path) {
        let long_ago = std::time::SystemTime::now()
            - super::ORPHAN_SAFETY_WINDOW
            - std::time::Duration::from_secs(60);
        fs::File::options()
            .write(true)
            .open(path)
            .unwrap()
            .set_modified(long_ago)
            .unwrap();
    }

    /// An object written by an import that has not saved its index yet.
    fn write_unindexed_object(library: &Library) -> String {
        let state = library.encrypted_vault.state();
        state
            .session
            .as_ref()
            .unwrap()
            .vault
            .write_object(&mut std::io::Cursor::new(b"in flight".to_vec()))
            .unwrap()
    }

    /// Another runtime (library switch, second window) on the same vault: its unlock
    /// never deletes objects of an import still running in the first runtime.
    #[test]
    fn unlock_in_another_runtime_keeps_objects_of_an_import_in_flight() {
        let (_temp, library, vault) = setup();
        library
            .create_encrypted_vault(&vault, PASSWORD, false)
            .unwrap();
        let in_flight = write_unindexed_object(&library);
        let mut other = library.clone();
        other.encrypted_vault = std::sync::Arc::new(super::EncryptedVaultRuntime::default());
        other.encrypted_vault_status().unwrap();
        other
            .unlock_encrypted_vault(&password(PASSWORD), false)
            .unwrap();
        assert!(vault
            .join(".lakomics-vault/objects")
            .join(&in_flight)
            .exists());
    }

    fn vault_snapshot(root: &Path) -> Vec<(PathBuf, Vec<u8>)> {
        let mut files = all_files(root)
            .into_iter()
            .map(|path| {
                let bytes = fs::read(&path).unwrap();
                (path, bytes)
            })
            .collect::<Vec<_>>();
        files.sort();
        files
    }

    /// The reported risk: vault A unlocked, the USB swapped for vault B at the same mount.
    /// No write of A may land in B, and status must stop reporting A as unlocked.
    #[test]
    fn a_vault_swapped_under_an_unlocked_session_is_never_written() {
        let (temp, library, vault) = setup();
        library
            .create_encrypted_vault(&vault, PASSWORD, false)
            .unwrap();
        let source = temp.path().join("source");
        fs::create_dir(&source).unwrap();
        write_jpg(&source.join("x.mp4_thumb.jpg"), 10);
        library
            .import_into_encrypted_vault(&source, &mut |_| {})
            .unwrap();
        fs::write(source.join("x.mp4"), video_bytes()).unwrap();
        library
            .import_into_encrypted_vault(&source, &mut |_| {})
            .unwrap();
        assert_eq!(
            library
                .preview_encrypted_vault_sidecar_cleanup()
                .unwrap()
                .count,
            1
        );
        let id = items_by_name(&library)["x.mp4"].clone();
        write_png(&source.join("new.png"), 8, 8);

        // Swap: A leaves, B (another vault) appears at the same path.
        let other_library = Library::open(temp.path().join("other-library")).unwrap();
        let b_root = temp.path().join("b");
        fs::create_dir(&b_root).unwrap();
        let b_id = other_library
            .create_encrypted_vault(&b_root, "other", false)
            .unwrap()
            .status
            .vault_id
            .unwrap();
        fs::rename(&vault, temp.path().join("a-away")).unwrap();
        fs::rename(&b_root, &vault).unwrap();
        let before = vault_snapshot(&vault);

        assert!(matches!(
            library.set_encrypted_vault_title(&id, Some("x")),
            Err(LibraryError::EncryptedVaultLocked)
        ));
        assert_eq!(vault_snapshot(&vault), before);
        // Each write path on a fresh session of A (the first failure drops the session).
        let reopen = |library: &Library| {
            fs::rename(&vault, temp.path().join("b-away")).unwrap();
            fs::rename(temp.path().join("a-away"), &vault).unwrap();
            library.lock_encrypted_vault();
            library.encrypted_vault_status().unwrap();
            library
                .unlock_encrypted_vault(&password(PASSWORD), false)
                .unwrap();
            fs::rename(&vault, temp.path().join("a-away")).unwrap();
            fs::rename(temp.path().join("b-away"), &vault).unwrap();
        };
        reopen(&library);
        assert!(matches!(
            library.import_into_encrypted_vault(&source, &mut |_| {}),
            Err(LibraryError::EncryptedVaultLocked)
        ));
        assert_eq!(vault_snapshot(&vault), before);
        reopen(&library);
        assert!(matches!(
            library.apply_encrypted_vault_sidecar_cleanup(),
            Err(LibraryError::EncryptedVaultLocked)
        ));
        assert_eq!(vault_snapshot(&vault), before);
        reopen(&library);
        assert!(matches!(
            library.change_encrypted_vault_password(&password(PASSWORD), "new"),
            Err(LibraryError::EncryptedVaultLocked)
        ));
        assert_eq!(vault_snapshot(&vault), before);

        // Status alone notices the swap without any write attempt.
        reopen(&library);
        let status = library.encrypted_vault_status().unwrap();
        assert_eq!(status.state, EncryptedVaultState::Locked);
        assert_eq!(status.vault_id.as_deref(), Some(b_id.as_str()));
        assert!(library.encrypted_vault.state().session.is_none());
        assert_eq!(vault_snapshot(&vault), before);
    }

    /// Resume must not treat a different file as imported just because it has the same
    /// relative path and size (for example the same layout in another source folder).
    #[test]
    fn resume_skips_only_files_whose_content_is_already_in_the_vault() {
        let (temp, library, vault) = setup();
        library
            .create_encrypted_vault(&vault, PASSWORD, false)
            .unwrap();
        let first = temp.path().join("first");
        let second = temp.path().join("second");
        let third = temp.path().join("third");
        for (root, fill) in [(&first, b'a'), (&second, b'b'), (&third, b'a')] {
            fs::create_dir_all(root.join("dir")).unwrap();
            fs::write(root.join("dir/same.jpg"), vec![fill; 4096]).unwrap();
        }
        let report = library
            .import_into_encrypted_vault(&first, &mut |_| {})
            .unwrap();
        assert_eq!((report.imported, report.skipped), (1, 0));
        let other = library
            .import_into_encrypted_vault(&second, &mut |_| {})
            .unwrap();
        assert_eq!((other.imported, other.skipped), (1, 0), "different content");
        let same = library
            .import_into_encrypted_vault(&third, &mut |_| {})
            .unwrap();
        assert_eq!((same.imported, same.skipped), (0, 1), "same content");

        // Items from before hashes existed: confirmed by decrypting their object.
        {
            let mut state = library.encrypted_vault.state();
            let session = state.session.as_mut().unwrap();
            for item in &mut session.index.items {
                item.content_sha256 = None;
            }
            let mut index = session.index.clone();
            session.vault.save_index(&mut index).unwrap();
        }
        library.lock_encrypted_vault();
        library
            .unlock_encrypted_vault(&password(PASSWORD), false)
            .unwrap();
        let old = library
            .import_into_encrypted_vault(&third, &mut |_| {})
            .unwrap();
        assert_eq!((old.imported, old.skipped), (0, 1));
        let fourth = temp.path().join("fourth");
        fs::create_dir_all(fourth.join("dir")).unwrap();
        fs::write(fourth.join("dir/same.jpg"), vec![b'c'; 4096]).unwrap();
        let different = library
            .import_into_encrypted_vault(&fourth, &mut |_| {})
            .unwrap();
        assert_eq!((different.imported, different.skipped), (1, 0));
        // The confirmed hash was recorded and saved.
        library.lock_encrypted_vault();
        library
            .unlock_encrypted_vault(&password(PASSWORD), false)
            .unwrap();
        let state = library.encrypted_vault.state();
        let items = &state.session.as_ref().unwrap().index.items;
        assert_eq!(items.len(), 3);
        assert!(
            items
                .iter()
                .filter(|item| item.content_sha256.is_some())
                .count()
                >= 2
        );
    }

    /// A damaged `index.bin` opens from `index.prev.bin`, and that session deletes nothing,
    /// because objects newer than the backup are unknown to it.
    #[test]
    fn a_damaged_index_opens_from_the_backup_without_orphan_cleanup() {
        let (temp, library, vault) = setup();
        library
            .create_encrypted_vault(&vault, PASSWORD, false)
            .unwrap();
        let source = temp.path().join("source");
        fs::create_dir(&source).unwrap();
        write_png(&source.join("one.png"), 8, 8);
        library
            .import_into_encrypted_vault(&source, &mut |_| {})
            .unwrap();
        write_png(&source.join("two.png"), 9, 8);
        library
            .import_into_encrypted_vault(&source, &mut |_| {})
            .unwrap();
        library.lock_encrypted_vault();
        let objects = vault.join(".lakomics-vault/objects");
        for entry in fs::read_dir(&objects).unwrap() {
            age(&entry.unwrap().path());
        }
        let count = object_count(&vault);
        let index = vault.join(".lakomics-vault/index.bin");
        let mut bytes = fs::read(&index).unwrap();
        bytes[60] ^= 1;
        fs::write(&index, bytes).unwrap();

        let status = library
            .unlock_encrypted_vault(&password(PASSWORD), false)
            .unwrap();
        assert_eq!(status.state, EncryptedVaultState::Unlocked);
        assert_eq!(status.item_count, Some(1));
        assert_eq!(object_count(&vault), count, "two.png's objects are kept");
        assert!(
            library
                .encrypted_vault
                .state()
                .session
                .as_ref()
                .unwrap()
                .from_backup_index
        );
    }

    fn write_jpg(path: &Path, shade: u8) -> Vec<u8> {
        image::RgbImage::from_pixel(16, 9, image::Rgb([shade, 30, 60]))
            .save(path)
            .unwrap();
        fs::read(path).unwrap()
    }

    /// Writes an old plaintext vault index giving `relative_path` a custom thumbnail.
    fn legacy_custom_thumbnail(source: &Path, relative_path: &str) -> Vec<u8> {
        let metadata = source.join(".lakomics");
        fs::create_dir_all(metadata.join("custom-thumbnails")).unwrap();
        let custom = image::DynamicImage::new_rgb8(20, 10);
        let custom = crate::library::ingestion::encode_thumbnail_webp(&custom).unwrap();
        fs::write(metadata.join("custom-thumbnails/legacy.webp"), &custom).unwrap();
        let database = metadata.join("index.sqlite");
        index::initialize_index(&database).unwrap();
        let mut entry = legacy_asset(relative_path, "video");
        entry.custom_thumbnail_relative_path = Some("custom-thumbnails/legacy.webp".into());
        index::upsert_asset(&database, &entry).unwrap();
        custom
    }

    fn items_by_name(library: &Library) -> std::collections::HashMap<String, String> {
        library
            .list_encrypted_vault_items(query(None, 0, 100))
            .unwrap()
            .items
            .into_iter()
            .map(|item| (item.original_file_name, item.id))
            .collect()
    }

    fn object_count(vault: &Path) -> usize {
        fs::read_dir(vault.join(".lakomics-vault/objects"))
            .unwrap()
            .count()
    }

    fn thumbnail_type(library: &Library, id: &str) -> String {
        let response = crate::media_protocol::media_response(
            Some(library),
            &tauri::http::Method::GET,
            &format!("/vault-thumbnail/{id}"),
        );
        response.headers()[tauri::http::header::CONTENT_TYPE]
            .to_str()
            .unwrap()
            .to_owned()
    }

    /// What the thumbnail route of the media protocol serves for `id`.
    fn thumbnail_route(library: &Library, id: &str) -> Vec<u8> {
        let response = crate::media_protocol::media_response(
            Some(library),
            &tauri::http::Method::GET,
            &format!("/vault-thumbnail/{id}"),
        );
        assert_eq!(response.status(), tauri::http::StatusCode::OK);
        response.into_body()
    }

    #[test]
    fn sidecar_names_resolve_to_their_sibling_video() {
        assert_eq!(super::sidecar_video_name("a.mp4_thumb.jpg"), Some("a.mp4"));
        assert_eq!(super::sidecar_video_name("a.mp4_thumb.JPEG"), Some("a.mp4"));
        assert_eq!(super::sidecar_video_name("a.mp4_thumb.webp"), Some("a.mp4"));
        assert_eq!(super::sidecar_video_name("a.mp4_thumb.gif"), None);
        assert_eq!(super::sidecar_video_name("_thumb.jpg"), None);
        assert_eq!(super::sidecar_video_name("a.mp4.jpg"), None);
        let mut videos = super::VideoPaths::default();
        videos.insert("dir/Clip.mp4");
        videos.insert("x.mp4");
        videos.insert("X.mp4");
        assert_eq!(
            videos.sidecar_target("dir/Clip.mp4_thumb.jpg").as_deref(),
            Some("dir/Clip.mp4")
        );
        assert_eq!(
            videos.sidecar_target("dir/clip.MP4_thumb.png").as_deref(),
            Some("dir/Clip.mp4")
        );
        assert_eq!(videos.sidecar_target("Clip.mp4_thumb.jpg"), None);
        assert_eq!(
            videos.sidecar_target("X.mp4_thumb.jpg").as_deref(),
            Some("X.mp4")
        );
        assert_eq!(videos.sidecar_target("x.MP4_thumb.jpg"), None, "ambiguous");
    }

    #[test]
    fn import_applies_video_sidecar_thumbnails_instead_of_image_items() {
        let (temp, library, vault) = setup();
        library
            .create_encrypted_vault(&vault, PASSWORD, false)
            .unwrap();
        let source = temp.path().join("sidecars");
        fs::create_dir(&source).unwrap();
        fs::write(source.join("a.mp4"), video_bytes()).unwrap();
        let a_thumb = write_jpg(&source.join("a.mp4_thumb.jpg"), 10);
        let b_thumb = write_jpg(&source.join("b.mp4_thumb.jpg"), 20);
        fs::write(source.join("c.mp4"), video_bytes()).unwrap();
        write_jpg(&source.join("c.mp4_thumb.jpg"), 30);
        let legacy = legacy_custom_thumbnail(&source, "c.mp4");
        // Sorted by relative path, this sidecar comes before its (case-differing) video.
        let d_thumb = write_jpg(&source.join("D.mp4_thumb.jpg"), 40);
        fs::write(source.join("d.mp4"), video_bytes()).unwrap();

        let report = library
            .import_into_encrypted_vault(&source, &mut |_| {})
            .unwrap();
        // c.mp4 already has a different (legacy) custom thumbnail: its sidecar is neither
        // an image item nor reported as present, but counted on its own.
        assert_eq!(
            (report.total, report.imported, report.skipped, report.failed),
            (7, 4, 0, 0)
        );
        assert_eq!(
            (
                report.sidecar_thumbnails,
                report.sidecar_skipped,
                report.legacy_thumbnails
            ),
            (2, 1, 1)
        );

        let items = items_by_name(&library);
        let mut names = items.keys().cloned().collect::<Vec<_>>();
        names.sort();
        assert_eq!(names, ["a.mp4", "b.mp4_thumb.jpg", "c.mp4", "d.mp4"]);
        let images = library
            .list_encrypted_vault_items(query(Some(EncryptedVaultItemKind::Image), 0, 10))
            .unwrap();
        assert_eq!(images.total_count, 1);
        assert_eq!(thumbnail_route(&library, &items["a.mp4"]), a_thumb);
        assert_eq!(thumbnail_type(&library, &items["a.mp4"]), "image/jpeg");
        assert_eq!(thumbnail_type(&library, &items["c.mp4"]), "image/webp");
        assert_eq!(thumbnail_route(&library, &items["c.mp4"]), legacy);
        assert_eq!(thumbnail_route(&library, &items["d.mp4"]), d_thumb);
        assert_eq!(
            read_media(
                &library,
                &items["b.mp4_thumb.jpg"],
                EncryptedVaultMediaVariant::Asset
            ),
            b_thumb
        );
        let objects = object_count(&vault);

        let again = library
            .import_into_encrypted_vault(&source, &mut |_| {})
            .unwrap();
        assert_eq!(
            (
                again.imported,
                again.sidecar_thumbnails,
                again.skipped,
                again.sidecar_skipped
            ),
            (0, 0, 6, 1)
        );
        assert_eq!(object_count(&vault), objects);
        assert_eq!(items_by_name(&library).len(), 4);

        // The applied sidecar survives lock and unlock.
        library.lock_encrypted_vault();
        library
            .unlock_encrypted_vault(&password(PASSWORD), false)
            .unwrap();
        assert_eq!(thumbnail_route(&library, &items["a.mp4"]), a_thumb);
    }

    #[test]
    fn sidecar_cleanup_moves_old_sidecar_images_to_their_videos() {
        let (temp, library, vault) = setup();
        library
            .create_encrypted_vault(&vault, PASSWORD, false)
            .unwrap();
        // The old way: sidecars imported as images (here: before their videos existed).
        let source = temp.path().join("old");
        fs::create_dir_all(source.join("sub")).unwrap();
        let a_thumb = write_jpg(&source.join("sub/a.mp4_thumb.jpg"), 10);
        write_jpg(&source.join("c.mp4_thumb.jpg"), 30);
        let e_thumb = write_jpg(&source.join("e.mp4_thumb.jpg"), 50);
        library
            .import_into_encrypted_vault(&source, &mut |_| {})
            .unwrap();
        fs::write(source.join("sub/a.mp4"), video_bytes()).unwrap();
        fs::write(source.join("c.mp4"), video_bytes()).unwrap();
        let legacy = legacy_custom_thumbnail(&source, "c.mp4");
        let report = library
            .import_into_encrypted_vault(&source, &mut |_| {})
            .unwrap();
        assert_eq!(
            (report.imported, report.skipped, report.sidecar_thumbnails),
            (2, 3, 0)
        );
        assert_eq!(items_by_name(&library).len(), 5);
        // 3 images (original + thumbnail), a (original + poster), c (+ legacy thumbnail).
        assert_eq!(object_count(&vault), 11);

        let preview = library.preview_encrypted_vault_sidecar_cleanup().unwrap();
        assert_eq!(preview.count, 2);
        let mut examples = preview.examples.clone();
        examples.sort();
        assert_eq!(examples, ["a.mp4_thumb.jpg", "c.mp4_thumb.jpg"]);

        // Refused while an import runs.
        library.encrypted_vault.import_job().replace(
            crate::library::models::EncryptedVaultImportJob {
                id: 9,
                running: true,
                ..Default::default()
            },
        );
        assert!(matches!(
            library.apply_encrypted_vault_sidecar_cleanup(),
            Err(LibraryError::EncryptedVaultImportRunning)
        ));
        library.encrypted_vault.import_job().take();

        let result = library.apply_encrypted_vault_sidecar_cleanup().unwrap();
        assert_eq!((result.moved_to_video_thumbnail, result.removed), (1, 2));
        let items = items_by_name(&library);
        let mut names = items.keys().cloned().collect::<Vec<_>>();
        names.sort();
        assert_eq!(names, ["a.mp4", "c.mp4", "e.mp4_thumb.jpg"]);
        // Removed: a's image thumbnail, c's image and its thumbnail. a's image object lives
        // on as the video thumbnail.
        assert_eq!(object_count(&vault), 8);
        assert_eq!(thumbnail_route(&library, &items["a.mp4"]), a_thumb);
        assert_eq!(thumbnail_route(&library, &items["c.mp4"]), legacy);
        assert_eq!(
            read_media(
                &library,
                &items["e.mp4_thumb.jpg"],
                EncryptedVaultMediaVariant::Asset
            ),
            e_thumb
        );

        // Idempotent, and saved: the next unlock sees the same index and objects.
        assert_eq!(
            library
                .preview_encrypted_vault_sidecar_cleanup()
                .unwrap()
                .count,
            0
        );
        let again = library.apply_encrypted_vault_sidecar_cleanup().unwrap();
        assert_eq!((again.moved_to_video_thumbnail, again.removed), (0, 0));
        library.lock_encrypted_vault();
        library
            .unlock_encrypted_vault(&password(PASSWORD), false)
            .unwrap();
        assert_eq!(items_by_name(&library).len(), 3);
        assert_eq!(object_count(&vault), 8);
        assert_eq!(thumbnail_route(&library, &items["a.mp4"]), a_thumb);

        // A re-import neither brings the sidecars back nor re-applies them: a's content is the
        // video thumbnail now, and c's video keeps its own thumbnail (sidecar skipped).
        let reimport = library
            .import_into_encrypted_vault(&source, &mut |_| {})
            .unwrap();
        assert_eq!(
            (
                reimport.imported,
                reimport.sidecar_thumbnails,
                reimport.skipped,
                reimport.sidecar_skipped
            ),
            (0, 0, 4, 1)
        );
        assert_eq!(items_by_name(&library).len(), 3);
    }
}
