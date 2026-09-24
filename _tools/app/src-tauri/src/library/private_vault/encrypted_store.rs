//! On-disk layout of an encrypted Private Vault (ADR-0039):
//!
//! ```text
//! <root>/.lakomics-vault/vault.json   plaintext header: format, UUID, KDF, wrapped master key
//! <root>/.lakomics-vault/index.bin    encrypted index (object format, purpose Index)
//! <root>/.lakomics-vault/objects/<id> encrypted objects, id = random 128-bit hex
//! ```
//!
//! Every write goes to a temporary file in the destination folder, is flushed and then
//! renamed, so a crash leaves either the old or the new file plus a stale temporary file
//! that orphan cleanup removes. No API here writes plaintext to disk. Callers must serialize
//! writes and orphan cleanup for one vault (stage 2 holds the vault behind one lock).
#![allow(dead_code)]

use std::{
    collections::HashSet,
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use uuid::Uuid;
use zeroize::Zeroize;

use super::crypto::{
    self, MasterKey, ObjectReader, Purpose, RecoveryKey, Result, Secret, VaultError, VaultHeader,
};

pub(crate) const VAULT_DIR: &str = ".lakomics-vault";
const HEADER_FILE: &str = "vault.json";
const INDEX_FILE: &str = "index.bin";
const OBJECTS_DIR: &str = "objects";
const TEMP_MARKER: &str = ".tmp-";
/// Fixed object id used for the index blob; its purpose (Index) keeps it apart from objects.
const INDEX_OBJECT_ID: [u8; 16] = [0; 16];
const INDEX_FORMAT_VERSION: u32 = 1;
const MAX_INDEX_BYTES: u64 = 256 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum VaultItemKind {
    Image,
    Video,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VaultItem {
    pub id: String,
    pub object_id: String,
    pub original_relative_path: String,
    pub original_file_name: String,
    pub kind: VaultItemKind,
    pub byte_size: u64,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub imported_at: String,
    pub title: Option<String>,
    pub thumbnail_object_id: Option<String>,
    pub poster_object_id: Option<String>,
    pub trashed_at: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VaultIndex {
    pub format_version: u32,
    /// Incremented on every save.
    pub revision: u64,
    pub items: Vec<VaultItem>,
}

impl Default for VaultIndex {
    fn default() -> Self {
        Self {
            format_version: INDEX_FORMAT_VERSION,
            revision: 0,
            items: Vec::new(),
        }
    }
}

impl VaultIndex {
    /// Every object id the index keeps alive.
    fn referenced_objects(&self) -> HashSet<&str> {
        self.items
            .iter()
            .flat_map(|item| {
                [
                    Some(item.object_id.as_str()),
                    item.thumbnail_object_id.as_deref(),
                    item.poster_object_id.as_deref(),
                ]
            })
            .flatten()
            .collect()
    }
}

/// An unlocked vault. Dropping it zeroizes the master key (lock).
pub(crate) struct EncryptedVault {
    dir: PathBuf,
    vault_id: Uuid,
    key: MasterKey,
}

impl EncryptedVault {
    /// Creates `<root>/.lakomics-vault` with a new master key, an empty index and `objects/`.
    /// Returns the unlocked vault and the recovery key; this is the only time it is shown.
    pub(crate) fn create(root: &Path, password: &str) -> Result<(Self, RecoveryKey)> {
        Self::create_with_iterations(root, password, crypto::PBKDF2_ITERATIONS)
    }

    /// `create` with an explicit PBKDF2 cost; tests use a low value to stay fast.
    pub(crate) fn create_with_iterations(
        root: &Path,
        password: &str,
        iterations: u32,
    ) -> Result<(Self, RecoveryKey)> {
        let (header, key, recovery) = VaultHeader::create(password, iterations)?;
        let dir = root.join(VAULT_DIR);
        fs::create_dir(&dir).map_err(|error| match error.kind() {
            io::ErrorKind::AlreadyExists => VaultError::AlreadyExists,
            _ => VaultError::Io(error),
        })?;
        fs::create_dir(dir.join(OBJECTS_DIR))?;
        write_header(&dir, &header)?;
        let vault = Self {
            dir,
            vault_id: header.vault_id(),
            key,
        };
        vault.save_index(&mut VaultIndex::default())?;
        Ok((vault, recovery))
    }

    /// Unlocks with the password or the recovery key. A wrong secret is `WrongSecret`.
    pub(crate) fn unlock(root: &Path, secret: &Secret) -> Result<Self> {
        let dir = root.join(VAULT_DIR);
        let header = read_header(&dir)?;
        let key = header.unlock(secret)?;
        Ok(Self {
            dir,
            vault_id: header.vault_id(),
            key,
        })
    }

    /// Opens with a master key from the OS credential store; a key of another vault (or a
    /// stale one) fails with `WrongSecret` because the index does not decrypt.
    pub(crate) fn unlock_with_key(root: &Path, key: MasterKey) -> Result<Self> {
        let dir = root.join(VAULT_DIR);
        let header = read_header(&dir)?;
        let vault = Self {
            dir,
            vault_id: header.vault_id(),
            key,
        };
        match vault.load_index() {
            Err(VaultError::Corrupt) => Err(VaultError::WrongSecret),
            other => other.map(|_| vault),
        }
    }

    /// Verifies `current` (password or recovery key) and rewraps the master key under
    /// `new_password`. Only the password wrap in `vault.json` changes, atomically.
    pub(crate) fn change_password(root: &Path, current: &Secret, new_password: &str) -> Result<()> {
        let dir = root.join(VAULT_DIR);
        let mut header = read_header(&dir)?;
        let key = header.unlock(current)?;
        header.set_password(&key, new_password)?;
        write_header(&dir, &header)
    }

    /// Reads the vault UUID without unlocking.
    pub(crate) fn read_vault_id(root: &Path) -> Result<Uuid> {
        Ok(read_header(&root.join(VAULT_DIR))?.vault_id())
    }

    pub(crate) fn vault_id(&self) -> Uuid {
        self.vault_id
    }

    pub(crate) fn master_key(&self) -> &MasterKey {
        &self.key
    }

    fn objects_dir(&self) -> PathBuf {
        self.dir.join(OBJECTS_DIR)
    }

    /// Encrypts `reader` into a new object and returns its id. Streams in 64 KiB chunks.
    pub(crate) fn write_object(&self, reader: &mut impl Read) -> Result<String> {
        let id = crypto::new_object_id()?;
        let id_hex = crypto::object_id_hex(&id);
        let dir = self.objects_dir();
        write_atomic(&dir, &id_hex, |file| {
            crypto::seal_object(
                &self.key,
                Purpose::Object,
                &self.vault_id,
                &id,
                reader,
                file,
            )
            .map(|_| ())
        })?;
        Ok(id_hex)
    }

    /// Opens an object for ranged reads (for example HTTP range requests on videos).
    pub(crate) fn open_object(&self, object_id: &str) -> Result<ObjectReader> {
        let id = crypto::parse_object_id(object_id).ok_or(VaultError::Corrupt)?;
        let file = File::open(self.objects_dir().join(object_id)).map_err(not_found_as_corrupt)?;
        ObjectReader::open(&self.key, Purpose::Object, &self.vault_id, &id, file)
    }

    pub(crate) fn read_range(&self, object_id: &str, offset: u64, len: u64) -> Result<Vec<u8>> {
        self.open_object(object_id)?.read_range(offset, len)
    }

    pub(crate) fn read_object(&self, object_id: &str) -> Result<Vec<u8>> {
        self.open_object(object_id)?.read_all()
    }

    pub(crate) fn load_index(&self) -> Result<VaultIndex> {
        let file = File::open(self.dir.join(INDEX_FILE)).map_err(not_found_as_corrupt)?;
        let mut reader = ObjectReader::open(
            &self.key,
            Purpose::Index,
            &self.vault_id,
            &INDEX_OBJECT_ID,
            file,
        )?;
        if reader.len() > MAX_INDEX_BYTES {
            return Err(VaultError::Corrupt);
        }
        let mut bytes = reader.read_all()?;
        let index = serde_json::from_slice::<VaultIndex>(&bytes);
        bytes.as_mut_slice().zeroize();
        let index = index.map_err(|_| VaultError::Corrupt)?;
        if index.format_version != INDEX_FORMAT_VERSION {
            return Err(VaultError::UnsupportedFormat);
        }
        Ok(index)
    }

    /// Increments `index.revision` and replaces `index.bin` atomically.
    pub(crate) fn save_index(&self, index: &mut VaultIndex) -> Result<()> {
        index.revision += 1;
        let mut bytes = serde_json::to_vec(index).map_err(|_| VaultError::Corrupt)?;
        let result = write_atomic(&self.dir, INDEX_FILE, |file| {
            crypto::seal_object(
                &self.key,
                Purpose::Index,
                &self.vault_id,
                &INDEX_OBJECT_ID,
                &mut bytes.as_slice(),
                file,
            )
            .map(|_| ())
        });
        bytes.as_mut_slice().zeroize();
        result
    }

    /// Deletes objects the index does not reference and stale temporary files (left by a
    /// crash). Unknown files are left alone. Returns how many files were removed.
    pub(crate) fn remove_orphans(&self, index: &VaultIndex) -> Result<usize> {
        let referenced = index.referenced_objects();
        let mut removed = remove_temp_files(&self.dir)?;
        for entry in fs::read_dir(self.objects_dir())? {
            let entry = entry?;
            if !entry.file_type()?.is_file() {
                continue;
            }
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            let orphan = crypto::parse_object_id(name).is_some() && !referenced.contains(name);
            if orphan || name.starts_with(TEMP_MARKER) {
                fs::remove_file(entry.path())?;
                removed += 1;
            }
        }
        Ok(removed)
    }
}

fn not_found_as_corrupt(error: io::Error) -> VaultError {
    match error.kind() {
        io::ErrorKind::NotFound => VaultError::Corrupt,
        _ => VaultError::Io(error),
    }
}

fn read_header(dir: &Path) -> Result<VaultHeader> {
    let bytes = fs::read(dir.join(HEADER_FILE)).map_err(|error| match error.kind() {
        io::ErrorKind::NotFound => VaultError::NotFound,
        _ => VaultError::Io(error),
    })?;
    let header: VaultHeader = serde_json::from_slice(&bytes).map_err(|_| VaultError::Corrupt)?;
    header.validate()?;
    Ok(header)
}

fn write_header(dir: &Path, header: &VaultHeader) -> Result<()> {
    let bytes = serde_json::to_vec_pretty(header).map_err(|_| VaultError::Corrupt)?;
    write_atomic(dir, HEADER_FILE, |file| Ok(file.write_all(&bytes)?))
}

/// Removes `<name>.tmp-*` files left in the vault folder by an interrupted atomic write.
fn remove_temp_files(dir: &Path) -> Result<usize> {
    let mut removed = 0;
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name();
        let stale = name.to_str().is_some_and(|name| {
            [HEADER_FILE, INDEX_FILE]
                .iter()
                .any(|target| name.starts_with(&format!("{target}{TEMP_MARKER}")))
        });
        if stale && entry.file_type()?.is_file() {
            fs::remove_file(entry.path())?;
            removed += 1;
        }
    }
    Ok(removed)
}

/// Writes `dir/<name>` through `dir/<name>.tmp-<random>` (or `.tmp-<random>` for objects),
/// fsyncs it and renames it into place. The temporary file is removed on failure.
fn write_atomic(dir: &Path, name: &str, write: impl FnOnce(&mut File) -> Result<()>) -> Result<()> {
    let prefix = if crypto::parse_object_id(name).is_some() {
        ""
    } else {
        name
    };
    let temp = dir.join(format!(
        "{prefix}{TEMP_MARKER}{}",
        crypto::object_id_hex(&crypto::new_object_id()?)
    ));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)?;
        write(&mut file)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temp, dir.join(name))?;
        sync_dir(dir);
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

/// Best effort: persist the rename itself. Directories cannot be fsynced on Windows.
fn sync_dir(dir: &Path) {
    #[cfg(unix)]
    if let Ok(dir) = File::open(dir) {
        let _ = dir.sync_all();
    }
    #[cfg(not(unix))]
    let _ = dir;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    const ITERATIONS: u32 = 1_000;
    const PASSWORD: &str = "correct horse";
    const MARKER: &[u8] = b"PLAINTEXT-MARKER-7f3a";

    fn create(root: &Path) -> (EncryptedVault, String) {
        let (vault, recovery) =
            EncryptedVault::create_with_iterations(root, PASSWORD, ITERATIONS).unwrap();
        (vault, recovery.as_str().to_owned())
    }

    fn pattern(len: usize) -> Vec<u8> {
        (0..len).map(|i| (i * 31 + i / 7) as u8).collect()
    }

    fn object_path(root: &Path, id: &str) -> PathBuf {
        root.join(VAULT_DIR).join(OBJECTS_DIR).join(id)
    }

    fn is_wrong_secret<T>(result: Result<T>) -> bool {
        matches!(result, Err(VaultError::WrongSecret))
    }

    fn is_corrupt<T>(result: Result<T>) -> bool {
        matches!(result, Err(VaultError::Corrupt))
    }

    fn item(object_id: &str, thumbnail: Option<String>) -> VaultItem {
        VaultItem {
            id: "item-1".into(),
            object_id: object_id.into(),
            original_relative_path: "holiday/secret-original-name.mp4".into(),
            original_file_name: "secret-original-name.mp4".into(),
            kind: VaultItemKind::Video,
            byte_size: 3,
            width: Some(1920),
            height: Some(1080),
            imported_at: "2026-09-24T00:00:00Z".into(),
            title: Some("비밀 제목".into()),
            thumbnail_object_id: thumbnail,
            poster_object_id: None,
            trashed_at: None,
        }
    }

    #[test]
    fn create_and_unlock_with_password_and_recovery_key() {
        let dir = tempfile::tempdir().unwrap();
        let (vault, recovery) = create(dir.path());
        assert_eq!(recovery.len(), 64);
        let id = vault
            .write_object(&mut Cursor::new(b"hello".to_vec()))
            .unwrap();

        let by_password = EncryptedVault::unlock(dir.path(), &Secret::Password(PASSWORD)).unwrap();
        assert_eq!(by_password.vault_id(), vault.vault_id());
        assert_eq!(by_password.read_object(&id).unwrap(), b"hello");

        let spaced = format!("{} - {}", &recovery[..32], recovery[32..].to_uppercase());
        let by_recovery =
            EncryptedVault::unlock(dir.path(), &Secret::RecoveryKey(&spaced)).unwrap();
        assert_eq!(by_recovery.read_object(&id).unwrap(), b"hello");
        assert_eq!(by_recovery.load_index().unwrap().revision, 1);

        let exported = vault.master_key().export_for_credential_store();
        let key = MasterKey::import_from_credential_store(exported.as_bytes()).unwrap();
        let remembered = EncryptedVault::unlock_with_key(dir.path(), key).unwrap();
        assert_eq!(remembered.read_object(&id).unwrap(), b"hello");
    }

    #[test]
    fn refuses_to_create_twice() {
        let dir = tempfile::tempdir().unwrap();
        create(dir.path());
        assert!(matches!(
            EncryptedVault::create_with_iterations(dir.path(), PASSWORD, ITERATIONS),
            Err(VaultError::AlreadyExists)
        ));
        assert!(matches!(
            EncryptedVault::create_with_iterations(dir.path(), "", ITERATIONS),
            Err(VaultError::EmptyPassword)
        ));
    }

    #[test]
    fn wrong_secrets_are_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let (_vault, recovery) = create(dir.path());
        assert!(is_wrong_secret(EncryptedVault::unlock(
            dir.path(),
            &Secret::Password("nope")
        )));
        let mut wrong = recovery.into_bytes();
        wrong[0] = if wrong[0] == b'0' { b'1' } else { b'0' };
        let wrong = String::from_utf8(wrong).unwrap();
        assert!(is_wrong_secret(EncryptedVault::unlock(
            dir.path(),
            &Secret::RecoveryKey(&wrong)
        )));
        assert!(matches!(
            EncryptedVault::unlock(dir.path(), &Secret::RecoveryKey("abc")),
            Err(VaultError::InvalidRecoveryKey)
        ));
        let other = tempfile::tempdir().unwrap();
        let (other_vault, _) = create(other.path());
        let foreign = MasterKey::import_from_credential_store(
            other_vault
                .master_key()
                .export_for_credential_store()
                .as_bytes(),
        )
        .unwrap();
        assert!(is_wrong_secret(EncryptedVault::unlock_with_key(
            dir.path(),
            foreign
        )));
        assert!(matches!(
            EncryptedVault::unlock(
                tempfile::tempdir().unwrap().path(),
                &Secret::Password(PASSWORD)
            ),
            Err(VaultError::NotFound)
        ));
    }

    #[test]
    fn change_password_keeps_recovery_key() {
        let dir = tempfile::tempdir().unwrap();
        let (vault, recovery) = create(dir.path());
        let id = vault
            .write_object(&mut Cursor::new(b"data".to_vec()))
            .unwrap();
        assert!(is_wrong_secret(EncryptedVault::change_password(
            dir.path(),
            &Secret::Password("nope"),
            "new password"
        )));
        EncryptedVault::change_password(dir.path(), &Secret::Password(PASSWORD), "new password")
            .unwrap();
        assert!(is_wrong_secret(EncryptedVault::unlock(
            dir.path(),
            &Secret::Password(PASSWORD)
        )));
        let unlocked =
            EncryptedVault::unlock(dir.path(), &Secret::Password("new password")).unwrap();
        assert_eq!(unlocked.read_object(&id).unwrap(), b"data");
        let recovered =
            EncryptedVault::unlock(dir.path(), &Secret::RecoveryKey(&recovery)).unwrap();
        assert_eq!(recovered.read_object(&id).unwrap(), b"data");
        // A recovery key can reset a forgotten password.
        EncryptedVault::change_password(dir.path(), &Secret::RecoveryKey(&recovery), "third")
            .unwrap();
        EncryptedVault::unlock(dir.path(), &Secret::Password("third")).unwrap();
    }

    #[test]
    fn objects_round_trip_at_chunk_boundaries() {
        let dir = tempfile::tempdir().unwrap();
        let (vault, _) = create(dir.path());
        let chunk = crypto::CHUNK_SIZE;
        for size in [0, 1, chunk - 1, chunk, chunk + 1, 300 * 1024] {
            let data = pattern(size);
            let id = vault.write_object(&mut Cursor::new(data.clone())).unwrap();
            let mut reader = vault.open_object(&id).unwrap();
            assert_eq!(reader.len(), size as u64, "size {size}");
            assert_eq!(reader.read_all().unwrap(), data, "size {size}");
        }
    }

    #[test]
    fn read_range_decrypts_only_requested_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let (vault, _) = create(dir.path());
        let data = pattern(300 * 1024);
        let id = vault.write_object(&mut Cursor::new(data.clone())).unwrap();
        let chunk = crypto::CHUNK_SIZE as u64;
        let cases = [
            (0, 10),
            (chunk - 1, 1),
            (chunk - 1, 2),
            (chunk, chunk),
            (chunk - 5, chunk + 10),
            (10, 3 * chunk),
            (data.len() as u64 - 7, 100),
        ];
        let mut reader = vault.open_object(&id).unwrap();
        for (offset, len) in cases {
            let end = (offset + len).min(data.len() as u64);
            assert_eq!(
                reader.read_range(offset, len).unwrap(),
                &data[offset as usize..end as usize],
                "range {offset}+{len}"
            );
        }
        assert!(reader.read_range(data.len() as u64, 10).unwrap().is_empty());
        assert_eq!(vault.read_range(&id, 5, 5).unwrap(), &data[5..10]);
    }

    #[test]
    fn tampered_objects_fail() {
        let dir = tempfile::tempdir().unwrap();
        let (vault, _) = create(dir.path());
        let data = pattern(200 * 1024);
        let id = vault.write_object(&mut Cursor::new(data)).unwrap();
        let path = object_path(dir.path(), &id);
        let original = fs::read(&path).unwrap();
        let header = 38;
        let chunk_ct = crypto::CHUNK_SIZE + 16;

        let check = |bytes: Vec<u8>| {
            fs::write(&path, bytes).unwrap();
            let result = vault.open_object(&id).and_then(|mut r| r.read_all());
            assert!(is_corrupt(result));
        };

        let mut flipped = original.clone();
        flipped[header + 100] ^= 1;
        check(flipped);

        let mut header_flipped = original.clone();
        header_flipped[10] ^= 1;
        check(header_flipped);

        let mut swapped = original.clone();
        let (first, rest) = swapped[header..].split_at_mut(chunk_ct);
        first.swap_with_slice(&mut rest[..chunk_ct]);
        check(swapped);

        check(original[..original.len() - 1].to_vec());
        check(original[..header + 2 * chunk_ct].to_vec());

        let mut extended = original.clone();
        extended.extend_from_slice(&[0; 20]);
        check(extended);

        fs::write(&path, &original).unwrap();
        assert!(vault.read_object(&id).is_ok());

        let copy = crypto::object_id_hex(&crypto::new_object_id().unwrap());
        fs::write(object_path(dir.path(), &copy), &original).unwrap();
        assert!(is_corrupt(vault.read_object(&copy)));
        assert!(is_corrupt(vault.read_object("../vault.json")));
    }

    #[test]
    fn objects_from_another_vault_fail() {
        let dir = tempfile::tempdir().unwrap();
        let (vault, _) = create(dir.path());
        let other_dir = tempfile::tempdir().unwrap();
        let (other, _) = create(other_dir.path());
        let id = other
            .write_object(&mut Cursor::new(b"foreign".to_vec()))
            .unwrap();
        fs::copy(
            object_path(other_dir.path(), &id),
            object_path(dir.path(), &id),
        )
        .unwrap();
        assert!(is_corrupt(vault.read_object(&id)));
        // An index blob moved between vaults fails too.
        fs::copy(
            other_dir.path().join(VAULT_DIR).join(INDEX_FILE),
            dir.path().join(VAULT_DIR).join(INDEX_FILE),
        )
        .unwrap();
        assert!(is_corrupt(vault.load_index()));
    }

    #[test]
    fn index_round_trip_and_tamper_detection() {
        let dir = tempfile::tempdir().unwrap();
        let (vault, _) = create(dir.path());
        let mut index = vault.load_index().unwrap();
        assert_eq!(index.revision, 1);
        assert!(index.items.is_empty());
        index
            .items
            .push(item("0123456789abcdef0123456789abcdef", None));
        vault.save_index(&mut index).unwrap();
        assert_eq!(index.revision, 2);
        assert_eq!(vault.load_index().unwrap(), index);

        let path = dir.path().join(VAULT_DIR).join(INDEX_FILE);
        let mut bytes = fs::read(&path).unwrap();
        let last = bytes.len() - 1;
        bytes[last] ^= 0x80;
        fs::write(&path, bytes).unwrap();
        assert!(is_corrupt(vault.load_index()));

        // An object file cannot pose as the index.
        let id = vault
            .write_object(&mut Cursor::new(b"{}".to_vec()))
            .unwrap();
        fs::copy(object_path(dir.path(), &id), &path).unwrap();
        assert!(is_corrupt(vault.load_index()));
    }

    #[test]
    fn orphan_cleanup_keeps_referenced_objects() {
        let dir = tempfile::tempdir().unwrap();
        let (vault, _) = create(dir.path());
        let kept = vault.write_object(&mut Cursor::new(b"a".to_vec())).unwrap();
        let thumbnail = vault.write_object(&mut Cursor::new(b"b".to_vec())).unwrap();
        let orphan = vault.write_object(&mut Cursor::new(b"c".to_vec())).unwrap();
        let mut index = vault.load_index().unwrap();
        index.items.push(item(&kept, Some(thumbnail.clone())));
        vault.save_index(&mut index).unwrap();

        let objects = dir.path().join(VAULT_DIR).join(OBJECTS_DIR);
        fs::write(objects.join(".tmp-0123"), b"partial").unwrap();
        fs::write(dir.path().join(VAULT_DIR).join("index.bin.tmp-0123"), b"x").unwrap();
        fs::write(objects.join("unrelated.txt"), b"keep").unwrap();

        assert_eq!(vault.remove_orphans(&index).unwrap(), 3);
        assert!(object_path(dir.path(), &kept).exists());
        assert!(object_path(dir.path(), &thumbnail).exists());
        assert!(!object_path(dir.path(), &orphan).exists());
        assert!(!objects.join(".tmp-0123").exists());
        assert!(objects.join("unrelated.txt").exists());
        assert!(dir.path().join(VAULT_DIR).join(HEADER_FILE).exists());
        assert_eq!(vault.load_index().unwrap(), index);
        assert_eq!(vault.read_object(&kept).unwrap(), b"a");
        assert_eq!(vault.remove_orphans(&index).unwrap(), 0);
    }

    #[test]
    fn no_plaintext_on_disk() {
        let dir = tempfile::tempdir().unwrap();
        let (vault, recovery) = create(dir.path());
        let mut content = pattern(100 * 1024);
        content[70_000..70_000 + MARKER.len()].copy_from_slice(MARKER);
        content[..MARKER.len()].copy_from_slice(MARKER);
        let id = vault.write_object(&mut Cursor::new(content)).unwrap();
        let mut index = vault.load_index().unwrap();
        index.items.push(item(&id, None));
        vault.save_index(&mut index).unwrap();

        let needles: [&[u8]; 5] = [
            MARKER,
            b"secret-original-name",
            b"holiday",
            "비밀 제목".as_bytes(),
            recovery.as_bytes(),
        ];
        let mut files = 0;
        let mut stack = vec![dir.path().to_path_buf()];
        while let Some(path) = stack.pop() {
            for entry in fs::read_dir(path).unwrap() {
                let entry = entry.unwrap();
                if entry.file_type().unwrap().is_dir() {
                    stack.push(entry.path());
                    continue;
                }
                files += 1;
                let bytes = fs::read(entry.path()).unwrap();
                for needle in needles {
                    assert!(!bytes.windows(needle.len()).any(|w| w == needle));
                }
            }
        }
        assert_eq!(files, 3);
    }
}
