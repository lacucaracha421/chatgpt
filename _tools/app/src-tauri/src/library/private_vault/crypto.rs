//! Cryptographic core of the encrypted Private Vault (ADR-0039).
//!
//! Keys:
//! - A random 256-bit master key encrypts everything in a vault.
//! - The master key is stored twice in `vault.json`, each time sealed with AES-256-GCM:
//!   once under a PBKDF2-HMAC-SHA256 password key and once under a random 256-bit
//!   recovery key. The wrap AAD binds the format version, the vault UUID and the wrap kind.
//!
//! Objects (files, thumbnails, posters and the index blob) use one streaming format:
//!
//! ```text
//! header  = "LKVO" | version (1 byte) | purpose (1 byte) | salt (32 random bytes)
//! body    = chunk_0 | chunk_1 | ... | chunk_{n-1}
//! chunk_i = AES-256-GCM(plaintext[i * 64 KiB .. (i + 1) * 64 KiB]) | 16-byte tag
//! ```
//!
//! Nonce/AAD scheme: every object is sealed with its own AES key, derived with
//! HKDF-SHA256 from the master key, the header's fresh random salt, the vault UUID and the
//! object id. Nonces therefore only need to be unique within one object and are simply
//! `7 zero bytes | chunk index (u32 BE) | final flag (1 byte)`. The AAD of each chunk is
//! `domain | vault UUID | object id | header | chunk index (u32 BE) | final flag`, so a chunk
//! only opens at its own position, in its own object, in its own vault. The last chunk (and
//! only the last) carries final flag 1, and every object has at least one (possibly empty)
//! chunk, so truncation, extension and reordering all fail authentication.
#![allow(dead_code)]

use std::{
    fs::File,
    io::{self, Read, Seek, SeekFrom, Write},
    num::NonZeroU32,
};

use ring::{
    aead, hkdf, pbkdf2,
    rand::{SecureRandom, SystemRandom},
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use zeroize::Zeroize;

pub(crate) type Result<T> = std::result::Result<T, VaultError>;

/// Errors never carry keys, plaintext paths or file names.
#[derive(Debug, thiserror::Error)]
pub(crate) enum VaultError {
    #[error("이 폴더에는 이미 비밀 보관함이 있습니다")]
    AlreadyExists,
    #[error("비밀 보관함을 찾을 수 없습니다")]
    NotFound,
    #[error("비밀번호 또는 복구 키가 맞지 않습니다")]
    WrongSecret,
    #[error("비밀번호를 입력해 주세요")]
    EmptyPassword,
    #[error("복구 키 형식이 올바르지 않습니다")]
    InvalidRecoveryKey,
    #[error("지원하지 않는 비밀 보관함 형식입니다")]
    UnsupportedFormat,
    #[error("비밀 보관함 데이터가 손상됐습니다")]
    Corrupt,
    #[error("암호화 처리에 실패했습니다")]
    Crypto,
    #[error("비밀 보관함 파일을 읽거나 쓸 수 없습니다")]
    Io(#[from] io::Error),
    /// The folder now holds another vault (or none): a USB swapped under an unlocked session.
    #[error("다른 비밀 보관함으로 바뀌었습니다")]
    Changed,
}

pub(crate) const FORMAT_VERSION: u32 = 1;
pub(crate) const KDF_NAME: &str = "pbkdf2-hmac-sha256";
/// Production PBKDF2 iteration count. Tests inject a lower value.
pub(crate) const PBKDF2_ITERATIONS: u32 = 600_000;
/// Upper bound accepted from `vault.json`, so a damaged file cannot stall unlock forever.
const MAX_PBKDF2_ITERATIONS: u32 = 20_000_000;
/// Lowest iteration count accepted from the unauthenticated `vault.json`, so a tampered
/// header cannot weaken the password wrap. Tests create vaults with a low count to stay fast.
const MIN_STORED_PBKDF2_ITERATIONS: u32 = if cfg!(test) { 100 } else { PBKDF2_ITERATIONS };
pub(crate) const CHUNK_SIZE: usize = 64 * 1024;

const KEY_LEN: usize = 32;
const SALT_LEN: usize = 16;
const TAG_LEN: usize = 16;
const OBJECT_MAGIC: &[u8; 4] = b"LKVO";
const OBJECT_VERSION: u8 = 1;
const OBJECT_SALT_LEN: usize = 32;
const HEADER_LEN: usize = 4 + 1 + 1 + OBJECT_SALT_LEN;
const CHUNK_CT_LEN: u64 = (CHUNK_SIZE + TAG_LEN) as u64;

fn random_bytes<const N: usize>() -> Result<[u8; N]> {
    let mut bytes = [0u8; N];
    SystemRandom::new()
        .fill(&mut bytes)
        .map_err(|_| VaultError::Crypto)?;
    Ok(bytes)
}

pub(crate) fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn unhex_into(text: &str, out: &mut [u8]) -> bool {
    let text = text.as_bytes();
    if text.len() != out.len() * 2 {
        return false;
    }
    for (i, pair) in text.chunks(2).enumerate() {
        let (Some(hi), Some(lo)) = (hex_digit(pair[0]), hex_digit(pair[1])) else {
            return false;
        };
        out[i] = hi << 4 | lo;
    }
    true
}

fn hex_digit(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}

/// The unlocked 256-bit master key. Zeroized on drop; deliberately neither `Debug` nor `Clone`.
pub(crate) struct MasterKey([u8; KEY_LEN]);

impl MasterKey {
    fn generate() -> Result<Self> {
        Ok(Self(random_bytes()?))
    }

    /// Raw key bytes, only for storing the key in the OS credential store ("remember on this
    /// PC", stage 2). The caller must not log them or write them anywhere else.
    pub(crate) fn export_for_credential_store(&self) -> SecretBytes {
        SecretBytes(self.0)
    }

    /// Rebuilds a key read back from the OS credential store. The caller should verify it
    /// against the vault (for example by loading the index) before trusting it.
    pub(crate) fn import_from_credential_store(bytes: &[u8]) -> Result<Self> {
        let key: [u8; KEY_LEN] = bytes.try_into().map_err(|_| VaultError::Corrupt)?;
        Ok(Self(key))
    }

    /// Per-object AES-256-GCM key: HKDF-SHA256(master, salt, info = domain | vault | object).
    fn object_key(
        &self,
        purpose: Purpose,
        vault_id: &Uuid,
        object_id: &[u8; 16],
        salt: &[u8],
    ) -> aead::LessSafeKey {
        let info = [
            b"lakomics-vault/object-key/v1".as_slice(),
            &[purpose as u8],
            vault_id.as_bytes(),
            object_id,
        ];
        let prk = hkdf::Salt::new(hkdf::HKDF_SHA256, salt).extract(&self.0);
        let okm = prk
            .expand(&info, &aead::AES_256_GCM)
            .expect("32-byte AES key is a valid HKDF output length");
        aead::LessSafeKey::new(aead::UnboundKey::from(okm))
    }
}

impl Drop for MasterKey {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

/// 32 secret bytes that are zeroized on drop.
pub(crate) struct SecretBytes([u8; KEY_LEN]);

impl SecretBytes {
    pub(crate) fn as_bytes(&self) -> &[u8] {
        &self.0
    }
}

impl Drop for SecretBytes {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

/// The recovery key as 64 lowercase hex characters. Returned only once, at vault creation.
pub(crate) struct RecoveryKey([u8; KEY_LEN * 2]);

impl RecoveryKey {
    fn from_key(key: &[u8; KEY_LEN]) -> Self {
        let mut text = [0u8; KEY_LEN * 2];
        const DIGITS: &[u8; 16] = b"0123456789abcdef";
        for (i, byte) in key.iter().enumerate() {
            text[i * 2] = DIGITS[(byte >> 4) as usize];
            text[i * 2 + 1] = DIGITS[(byte & 0x0f) as usize];
        }
        Self(text)
    }

    pub(crate) fn as_str(&self) -> &str {
        std::str::from_utf8(&self.0).expect("recovery key is ASCII hex")
    }
}

impl Drop for RecoveryKey {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

/// A secret the user typed to unlock the vault.
pub(crate) enum Secret<'a> {
    Password(&'a str),
    /// 64 hex characters; spaces and hyphens are ignored, case-insensitive.
    RecoveryKey(&'a str),
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum WrapKind {
    Password,
    Recovery,
}

impl WrapKind {
    fn label(self) -> &'static str {
        match self {
            Self::Password => "password",
            Self::Recovery => "recovery",
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WrappedKey {
    nonce: String,
    ciphertext: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KdfParams {
    name: String,
    iterations: u32,
    salt: String,
}

/// Contents of the plaintext `vault.json`: nothing but format, id, KDF parameters and wraps.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VaultHeader {
    format_version: u32,
    vault_id: Uuid,
    kdf: KdfParams,
    password_wrap: WrappedKey,
    recovery_wrap: WrappedKey,
}

/// A wrapping key derived from a secret; zeroized on drop.
struct WrappingKey([u8; KEY_LEN]);

impl Drop for WrappingKey {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

fn password_key(password: &str, iterations: u32, salt: &[u8]) -> Result<WrappingKey> {
    let iterations = NonZeroU32::new(iterations).ok_or(VaultError::Corrupt)?;
    let mut key = WrappingKey([0; KEY_LEN]);
    pbkdf2::derive(
        pbkdf2::PBKDF2_HMAC_SHA256,
        iterations,
        salt,
        password.as_bytes(),
        &mut key.0,
    );
    Ok(key)
}

fn recovery_wrapping_key(text: &str) -> Result<WrappingKey> {
    let mut digits = [0u8; KEY_LEN * 2];
    let mut count = 0;
    for c in text
        .bytes()
        .filter(|c| !matches!(c, b' ' | b'-' | b'\t' | b'\r' | b'\n'))
    {
        if count == digits.len() {
            digits.zeroize();
            return Err(VaultError::InvalidRecoveryKey);
        }
        digits[count] = c;
        count += 1;
    }
    let mut key = WrappingKey([0; KEY_LEN]);
    let ok =
        count == digits.len() && unhex_into(std::str::from_utf8(&digits).unwrap_or(""), &mut key.0);
    digits.zeroize();
    if ok {
        Ok(key)
    } else {
        Err(VaultError::InvalidRecoveryKey)
    }
}

fn wrap_aad(vault_id: &Uuid, kind: WrapKind) -> String {
    format!(
        "lakomics-vault/wrap/v{FORMAT_VERSION}/{vault_id}/{}",
        kind.label()
    )
}

fn wrap(
    wrapping: &WrappingKey,
    master: &MasterKey,
    vault_id: &Uuid,
    kind: WrapKind,
) -> Result<WrappedKey> {
    let key = aead::LessSafeKey::new(
        aead::UnboundKey::new(&aead::AES_256_GCM, &wrapping.0).map_err(|_| VaultError::Crypto)?,
    );
    let nonce = random_bytes::<12>()?;
    let mut buffer = master.0.to_vec();
    key.seal_in_place_append_tag(
        aead::Nonce::assume_unique_for_key(nonce),
        aead::Aad::from(wrap_aad(vault_id, kind)),
        &mut buffer,
    )
    .map_err(|_| VaultError::Crypto)?;
    let wrapped = WrappedKey {
        nonce: hex(&nonce),
        ciphertext: hex(&buffer),
    };
    buffer.as_mut_slice().zeroize();
    Ok(wrapped)
}

fn unwrap(
    wrapping: &WrappingKey,
    wrapped: &WrappedKey,
    vault_id: &Uuid,
    kind: WrapKind,
) -> Result<MasterKey> {
    let mut nonce = [0u8; 12];
    let mut buffer = vec![0u8; KEY_LEN + TAG_LEN];
    if !unhex_into(&wrapped.nonce, &mut nonce) || !unhex_into(&wrapped.ciphertext, &mut buffer) {
        return Err(VaultError::Corrupt);
    }
    let key = aead::LessSafeKey::new(
        aead::UnboundKey::new(&aead::AES_256_GCM, &wrapping.0).map_err(|_| VaultError::Crypto)?,
    );
    let result = key
        .open_in_place(
            aead::Nonce::assume_unique_for_key(nonce),
            aead::Aad::from(wrap_aad(vault_id, kind)),
            &mut buffer,
        )
        .map_err(|_| VaultError::WrongSecret)
        .and_then(|plain| MasterKey::import_from_credential_store(plain));
    buffer.as_mut_slice().zeroize();
    result
}

impl VaultHeader {
    /// Creates a new vault header with a fresh master key and recovery key.
    pub(crate) fn create(
        password: &str,
        iterations: u32,
    ) -> Result<(Self, MasterKey, RecoveryKey)> {
        if password.is_empty() {
            return Err(VaultError::EmptyPassword);
        }
        let iterations = iterations.clamp(MIN_STORED_PBKDF2_ITERATIONS, MAX_PBKDF2_ITERATIONS);
        let vault_id = Uuid::new_v4();
        let master = MasterKey::generate()?;
        let recovery = WrappingKey(random_bytes()?);
        let recovery_text = RecoveryKey::from_key(&recovery.0);
        let salt = random_bytes::<SALT_LEN>()?;
        let password_wrapping = password_key(password, iterations, &salt)?;
        let header = Self {
            format_version: FORMAT_VERSION,
            vault_id,
            kdf: KdfParams {
                name: KDF_NAME.to_owned(),
                iterations,
                salt: hex(&salt),
            },
            password_wrap: wrap(&password_wrapping, &master, &vault_id, WrapKind::Password)?,
            recovery_wrap: wrap(&recovery, &master, &vault_id, WrapKind::Recovery)?,
        };
        Ok((header, master, recovery_text))
    }

    pub(crate) fn vault_id(&self) -> Uuid {
        self.vault_id
    }

    /// Rejects unknown versions or KDFs and malformed parameters before any key work.
    pub(crate) fn validate(&self) -> Result<()> {
        if self.format_version != FORMAT_VERSION || self.kdf.name != KDF_NAME {
            return Err(VaultError::UnsupportedFormat);
        }
        if !(MIN_STORED_PBKDF2_ITERATIONS..=MAX_PBKDF2_ITERATIONS).contains(&self.kdf.iterations) {
            return Err(VaultError::Corrupt);
        }
        self.salt().map(|_| ())
    }

    fn salt(&self) -> Result<[u8; SALT_LEN]> {
        let mut salt = [0u8; SALT_LEN];
        if unhex_into(&self.kdf.salt, &mut salt) {
            Ok(salt)
        } else {
            Err(VaultError::Corrupt)
        }
    }

    pub(crate) fn unlock(&self, secret: &Secret) -> Result<MasterKey> {
        self.validate()?;
        match secret {
            Secret::Password(password) => {
                let key = password_key(password, self.kdf.iterations, &self.salt()?)?;
                unwrap(
                    &key,
                    &self.password_wrap,
                    &self.vault_id,
                    WrapKind::Password,
                )
            }
            Secret::RecoveryKey(text) => {
                let key = recovery_wrapping_key(text)?;
                unwrap(
                    &key,
                    &self.recovery_wrap,
                    &self.vault_id,
                    WrapKind::Recovery,
                )
            }
        }
    }

    /// Rewraps only the password wrap, with a fresh salt. The recovery wrap is untouched.
    /// The new wrap uses at least `min_iterations` (the configured production cost), never
    /// less than the stored count, so a lowered count in `vault.json` is not inherited.
    pub(crate) fn set_password(
        &mut self,
        master: &MasterKey,
        new_password: &str,
        min_iterations: u32,
    ) -> Result<()> {
        if new_password.is_empty() {
            return Err(VaultError::EmptyPassword);
        }
        let iterations = self
            .kdf
            .iterations
            .max(min_iterations)
            .clamp(MIN_STORED_PBKDF2_ITERATIONS, MAX_PBKDF2_ITERATIONS);
        let salt = random_bytes::<SALT_LEN>()?;
        let key = password_key(new_password, iterations, &salt)?;
        self.password_wrap = wrap(&key, master, &self.vault_id, WrapKind::Password)?;
        self.kdf.salt = hex(&salt);
        self.kdf.iterations = iterations;
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn iterations(&self) -> u32 {
        self.kdf.iterations
    }
}

/// What an object holds; part of its key derivation and AAD so blobs cannot be swapped
/// between roles (for example an object file presented as the index).
#[derive(Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub(crate) enum Purpose {
    Object = 1,
    Index = 2,
}

fn object_header(purpose: Purpose, salt: &[u8; OBJECT_SALT_LEN]) -> [u8; HEADER_LEN] {
    let mut header = [0u8; HEADER_LEN];
    header[..4].copy_from_slice(OBJECT_MAGIC);
    header[4] = OBJECT_VERSION;
    header[5] = purpose as u8;
    header[6..].copy_from_slice(salt);
    header
}

/// Nonce = 7 zero bytes | chunk index (u32 BE) | final flag. Unique because each object has
/// its own derived key and each chunk index appears once per object.
fn chunk_nonce(index: u32, last: bool) -> aead::Nonce {
    let mut nonce = [0u8; 12];
    nonce[7..11].copy_from_slice(&index.to_be_bytes());
    nonce[11] = last as u8;
    aead::Nonce::assume_unique_for_key(nonce)
}

/// Everything that identifies one object's chunks, precomputed for sealing and opening.
struct ChunkCipher {
    key: aead::LessSafeKey,
    aad_prefix: Vec<u8>,
}

impl ChunkCipher {
    fn new(
        master: &MasterKey,
        purpose: Purpose,
        vault_id: &Uuid,
        object_id: &[u8; 16],
        header: &[u8; HEADER_LEN],
    ) -> Self {
        let mut aad_prefix = b"lakomics-vault/chunk/v1".to_vec();
        aad_prefix.extend_from_slice(vault_id.as_bytes());
        aad_prefix.extend_from_slice(object_id);
        aad_prefix.extend_from_slice(header);
        Self {
            key: master.object_key(purpose, vault_id, object_id, &header[6..]),
            aad_prefix,
        }
    }

    fn aad(&self, index: u32, last: bool) -> aead::Aad<Vec<u8>> {
        let mut aad = self.aad_prefix.clone();
        aad.extend_from_slice(&index.to_be_bytes());
        aad.push(last as u8);
        aead::Aad::from(aad)
    }

    fn seal(&self, index: u32, last: bool, buffer: &mut Vec<u8>) -> Result<()> {
        self.key
            .seal_in_place_append_tag(chunk_nonce(index, last), self.aad(index, last), buffer)
            .map_err(|_| VaultError::Crypto)
    }

    fn open<'b>(&self, index: u32, last: bool, buffer: &'b mut [u8]) -> Result<&'b mut [u8]> {
        self.key
            .open_in_place(chunk_nonce(index, last), self.aad(index, last), buffer)
            .map_err(|_| VaultError::Corrupt)
    }
}

/// Reads until `buffer` is full or the reader is exhausted; returns the bytes read.
fn fill(reader: &mut impl Read, buffer: &mut [u8]) -> io::Result<usize> {
    let mut filled = 0;
    while filled < buffer.len() {
        match reader.read(&mut buffer[filled..]) {
            Ok(0) => break,
            Ok(n) => filled += n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) => return Err(e),
        }
    }
    Ok(filled)
}

/// Streams `reader` into `writer` as an encrypted object, one 64 KiB chunk at a time.
/// Returns the plaintext length. At most two plaintext chunks are held in memory.
pub(crate) fn seal_object(
    master: &MasterKey,
    purpose: Purpose,
    vault_id: &Uuid,
    object_id: &[u8; 16],
    reader: &mut impl Read,
    writer: &mut impl Write,
) -> Result<u64> {
    let header = object_header(purpose, &random_bytes()?);
    let cipher = ChunkCipher::new(master, purpose, vault_id, object_id, &header);
    writer.write_all(&header)?;

    // A chunk is final only once we know nothing follows it, so read one chunk ahead.
    let mut current = vec![0u8; CHUNK_SIZE + TAG_LEN];
    let mut next = vec![0u8; CHUNK_SIZE + TAG_LEN];
    let mut current_len = fill(reader, &mut current[..CHUNK_SIZE])?;
    let mut index: u32 = 0;
    let mut total: u64 = 0;
    let result = loop {
        let next_len = if current_len == CHUNK_SIZE {
            fill(reader, &mut next[..CHUNK_SIZE])?
        } else {
            0
        };
        let last = next_len == 0;
        current.truncate(current_len);
        cipher.seal(index, last, &mut current)?;
        writer.write_all(&current)?;
        total += current_len as u64;
        if last {
            break Ok(total);
        }
        index = index.checked_add(1).ok_or(VaultError::Crypto)?;
        current.as_mut_slice().zeroize();
        current.resize(CHUNK_SIZE + TAG_LEN, 0);
        std::mem::swap(&mut current, &mut next);
        current_len = next_len;
    };
    current.as_mut_slice().zeroize();
    next.as_mut_slice().zeroize();
    result
}

/// Random 128-bit object id.
pub(crate) fn new_object_id() -> Result<[u8; 16]> {
    random_bytes()
}

pub(crate) fn object_id_hex(id: &[u8; 16]) -> String {
    hex(id)
}

/// Parses a 32-character lowercase hex object id; anything else (including path
/// separators) is rejected, so ids can be joined to `objects/` safely.
pub(crate) fn parse_object_id(text: &str) -> Option<[u8; 16]> {
    let mut id = [0u8; 16];
    (text.bytes().all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f')) && unhex_into(text, &mut id))
        .then_some(id)
}

/// Random-access reader over one encrypted object. Opening it authenticates the final chunk,
/// so `len()` is trustworthy before any range is served.
pub(crate) struct ObjectReader {
    file: File,
    cipher: ChunkCipher,
    len: u64,
    chunks: u64,
    last_chunk_ct_len: u64,
}

impl ObjectReader {
    pub(crate) fn open(
        master: &MasterKey,
        purpose: Purpose,
        vault_id: &Uuid,
        object_id: &[u8; 16],
        mut file: File,
    ) -> Result<Self> {
        let size = file.metadata()?.len();
        let mut header = [0u8; HEADER_LEN];
        if size < (HEADER_LEN + TAG_LEN) as u64 {
            return Err(VaultError::Corrupt);
        }
        file.read_exact(&mut header)?;
        if &header[..4] != OBJECT_MAGIC || header[5] != purpose as u8 {
            return Err(VaultError::Corrupt);
        }
        if header[4] != OBJECT_VERSION {
            return Err(VaultError::UnsupportedFormat);
        }
        // Layout follows from the file size: full chunks, then a last chunk of 16..=64 KiB+16.
        let body = size - HEADER_LEN as u64;
        let chunks = body.div_ceil(CHUNK_CT_LEN);
        let last_chunk_ct_len = body - (chunks - 1) * CHUNK_CT_LEN;
        if last_chunk_ct_len < TAG_LEN as u64 || chunks > u64::from(u32::MAX) + 1 {
            return Err(VaultError::Corrupt);
        }
        let mut reader = Self {
            cipher: ChunkCipher::new(master, purpose, vault_id, object_id, &header),
            file,
            len: body - chunks * TAG_LEN as u64,
            chunks,
            last_chunk_ct_len,
        };
        let mut last = reader.read_chunk(chunks - 1)?;
        last.as_mut_slice().zeroize();
        Ok(reader)
    }

    /// Authenticated plaintext length.
    pub(crate) fn len(&self) -> u64 {
        self.len
    }

    fn read_chunk(&mut self, index: u64) -> Result<Vec<u8>> {
        let last = index + 1 == self.chunks;
        let ct_len = if last {
            self.last_chunk_ct_len
        } else {
            CHUNK_CT_LEN
        };
        let mut buffer = vec![0u8; ct_len as usize];
        self.file
            .seek(SeekFrom::Start(HEADER_LEN as u64 + index * CHUNK_CT_LEN))?;
        self.file.read_exact(&mut buffer)?;
        let plain_len = self.cipher.open(index as u32, last, &mut buffer)?.len();
        buffer.truncate(plain_len);
        Ok(buffer)
    }

    /// Decrypts only the chunks covering `offset..offset + len`, clamped to the object end.
    pub(crate) fn read_range(&mut self, offset: u64, len: u64) -> Result<Vec<u8>> {
        if offset >= self.len {
            return Ok(Vec::new());
        }
        let end = offset.saturating_add(len).min(self.len);
        let mut out = Vec::with_capacity((end - offset) as usize);
        let mut position = offset;
        while position < end {
            let index = position / CHUNK_SIZE as u64;
            let mut chunk = self.read_chunk(index)?;
            let start = (position - index * CHUNK_SIZE as u64) as usize;
            let stop = (end - index * CHUNK_SIZE as u64).min(chunk.len() as u64) as usize;
            out.extend_from_slice(&chunk[start..stop]);
            chunk.as_mut_slice().zeroize();
            position += (stop - start) as u64;
        }
        Ok(out)
    }

    pub(crate) fn read_all(&mut self) -> Result<Vec<u8>> {
        self.read_range(0, self.len)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn set_password_never_weakens_the_stored_cost() {
        let (mut header, master, _) = VaultHeader::create("old", 1_000).unwrap();
        header.set_password(&master, "new", 2_000).unwrap();
        assert_eq!(header.iterations(), 2_000);
        // A lower configured minimum never lowers the stored cost.
        header.set_password(&master, "newer", 500).unwrap();
        assert_eq!(header.iterations(), 2_000);
        assert!(header.unlock(&Secret::Password("newer")).is_ok());
    }

    #[test]
    fn stored_iterations_below_the_floor_are_rejected() {
        let (header, _, _) = VaultHeader::create("pw", 1_000).unwrap();
        let mut json = serde_json::to_value(&header).unwrap();
        json["kdf"]["iterations"] = serde_json::json!(MIN_STORED_PBKDF2_ITERATIONS - 1);
        let tampered: VaultHeader = serde_json::from_value(json).unwrap();
        assert!(matches!(tampered.validate(), Err(VaultError::Corrupt)));
        assert!(matches!(
            tampered.unlock(&Secret::Password("pw")),
            Err(VaultError::Corrupt)
        ));
        // A creation request below the floor is raised to it.
        let (low, _, _) = VaultHeader::create("pw", 1).unwrap();
        assert_eq!(low.iterations(), MIN_STORED_PBKDF2_ITERATIONS);
    }
}
