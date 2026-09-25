//! Encrypted local-first notes. Plaintext never crosses the cloud boundary.
mod ledger;
mod model;
mod secret;

use super::{credential, error::LibraryError, Library};
pub use model::Content;
use ledger::{Entry, Planned, Recurring};
use model::{present, Field, Item, CHECKLIST, LEDGER, LEDGER_MONTH, SECRET, TEXT};
use ring::{
    aead,
    rand::{SecureRandom, SystemRandom},
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::sync::Mutex;

static SYNC: Mutex<()> = Mutex::new(());
pub const MAX_BACKUP_BYTES: usize = 64 * 1024 * 1024;
pub type Result<T> = std::result::Result<T, Error>;
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("메모 저장소를 읽거나 저장하지 못했습니다.")]
    Db(#[from] rusqlite::Error),
    #[error("메모 자격 증명 또는 라이브러리를 사용할 수 없습니다.")]
    Library(#[from] super::error::LibraryError),
    #[error("메모 데이터 형식이 올바르지 않습니다.")]
    Json(#[from] serde_json::Error),
    #[error("{0}")]
    Message(&'static str),
    #[error("{0}")]
    Text(String),
}
const LOCKED: Error = Error::Message("메모 암호화 키를 등록해 주세요.");
const INVALID: Error = Error::Message("암호화 키가 맞지 않거나 메모가 손상됐습니다.");
const RECOVERY_MISMATCH: Error = Error::Message("복구키가 맞지 않습니다.");
/// The UI matches these two texts to show the PIN prompt instead of an error.
pub const SECRET_LOCKED_TEXT: &str = "암호 메모 잠금을 해제해 주세요.";
pub const PIN_REQUIRED_TEXT: &str = "복구키를 보려면 암호 메모 PIN을 먼저 입력해 주세요.";
const SECRET_LOCKED: Error = Error::Message(SECRET_LOCKED_TEXT);
const PIN_REQUIRED: Error = Error::Message(PIN_REQUIRED_TEXT);

#[derive(Clone, Serialize, Deserialize)]
pub struct Envelope {
    pub version: u8,
    pub nonce: String,
    pub ciphertext: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Remote {
    pub id: String,
    pub revision: i64,
    pub operation_id: String,
    pub payload: Envelope,
    pub sequence: i64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    pub items: Vec<Remote>,
    pub next_cursor: Option<i64>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub id: String,
    #[serde(flatten)]
    pub content: Content,
    pub local_revision: i64,
    pub pending: bool,
    /// Legacy manual-resolution state (a stored server version awaiting a choice).
    pub conflict: bool,
    /// A local copy kept automatically when an edit collision could not merge.
    pub conflict_copy: bool,
    /// Newer schema or unknown type: only pin, trash, archive and restore apply.
    pub read_only: bool,
    /// A secret note while its PIN session is closed: body, memo, fields, labels
    /// and unknown fields are withheld from the UI.
    pub redacted: bool,
    /// Set when a stale save could not be merged: the draft was kept as this new note.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub copied_to: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct State {
    pub unlocked: bool,
    /// The OS credential store is locked (Linux keyring); the UI may ask to unlock it.
    pub keyring_locked: bool,
    pub notes: Vec<Note>,
    /// Rows that do not authenticate or parse; hidden but kept.
    pub unreadable: usize,
    pub last_synced_at: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretStatus {
    pub pin_set: bool,
    pub unlocked: bool,
}
/// A save request. Absent fields keep the stored value, so fields this client does not
/// edit (or cannot see, such as a locked secret note's values) are never lost.
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Draft {
    pub id: String,
    pub expected_revision: i64,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub pinned: Option<bool>,
    #[serde(default)]
    pub deleted: Option<bool>,
    #[serde(default)]
    pub archived: Option<bool>,
    #[serde(default, rename = "type")]
    pub kind: Option<String>,
    /// `Some(None)` clears the colour; absent keeps it.
    #[serde(default, deserialize_with = "present")]
    pub color: Option<Option<String>>,
    #[serde(default)]
    pub labels: Option<Vec<String>>,
    #[serde(default)]
    pub items: Option<Vec<Item>>,
    #[serde(default)]
    pub fields: Option<Vec<Field>>,
    #[serde(default)]
    pub memo: Option<String>,
    /// Ledger notes (design 2026-09-25): `ledger` and `month` of a month note are immutable.
    #[serde(default)]
    pub ledger: Option<String>,
    #[serde(default)]
    pub month: Option<String>,
    /// `Some(None)` clears the income; absent keeps it.
    #[serde(default, deserialize_with = "present")]
    pub income: Option<Option<u64>>,
    /// Ledger: `Some(None)` clears the income day; absent keeps it.
    #[serde(default, deserialize_with = "present")]
    pub income_day: Option<Option<u64>>,
    #[serde(default)]
    pub recurring: Option<Vec<Recurring>>,
    #[serde(default)]
    pub planned: Option<Vec<Planned>>,
    #[serde(default)]
    pub entries: Option<Vec<Entry>>,
}
#[derive(Serialize, Deserialize)]
pub struct Backup {
    version: u8,
    vault: String,
    items: Vec<BackupItem>,
}
#[derive(Serialize, Deserialize)]
struct BackupItem {
    id: String,
    payload: Envelope,
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
fn unhex(text: &str) -> Result<Vec<u8>> {
    if text.len() % 2 != 0 || !text.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(INVALID);
    }
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).map_err(|_| INVALID))
        .collect()
}
fn random<const N: usize>() -> Result<[u8; N]> {
    let mut v = [0; N];
    SystemRandom::new().fill(&mut v).map_err(|_| INVALID)?;
    Ok(v)
}
pub fn generate_key() -> Result<String> {
    Ok(hex(&random::<32>()?))
}
fn vault(key: &[u8]) -> String {
    hex(&Sha256::digest(key))
}
fn aad(key: &[u8], id: &str) -> String {
    format!("lakomics-notes:1:{}:{id}", vault(key))
}
fn seal(key: &[u8], id: &str, content: &impl Serialize) -> Result<Envelope> {
    let key_object = aead::LessSafeKey::new(
        aead::UnboundKey::new(&aead::AES_256_GCM, key).map_err(|_| INVALID)?,
    );
    let nonce = random::<12>()?;
    let mut bytes = serde_json::to_vec(content)?;
    key_object
        .seal_in_place_append_tag(
            aead::Nonce::assume_unique_for_key(nonce),
            aead::Aad::from(aad(key, id)),
            &mut bytes,
        )
        .map_err(|_| INVALID)?;
    Ok(Envelope {
        version: 1,
        nonce: hex(&nonce),
        ciphertext: hex(&bytes),
    })
}
/// Decrypts and parses JSON; fails only on a wrong key, tampering or non-JSON bytes.
fn open_value(key: &[u8], id: &str, envelope: &Envelope) -> Result<Value> {
    if envelope.version != 1 || envelope.nonce.len() != 24 || envelope.ciphertext.len() > 600000 {
        return Err(INVALID);
    }
    let nonce: [u8; 12] = unhex(&envelope.nonce)?.try_into().map_err(|_| INVALID)?;
    let mut bytes = unhex(&envelope.ciphertext)?;
    let key_object = aead::LessSafeKey::new(
        aead::UnboundKey::new(&aead::AES_256_GCM, key).map_err(|_| INVALID)?,
    );
    let plain = key_object
        .open_in_place(
            aead::Nonce::assume_unique_for_key(nonce),
            aead::Aad::from(aad(key, id)),
            &mut bytes,
        )
        .map_err(|_| INVALID)?;
    Ok(serde_json::from_slice(plain)?)
}
fn open(key: &[u8], id: &str, envelope: &Envelope) -> Result<Stored> {
    Ok(Stored::decode(open_value(key, id, envelope)?))
}
fn open_str(key: &[u8], id: &str, payload: &str) -> Result<Stored> {
    open(key, id, &serde_json::from_str(payload)?)
}

/// A decrypted payload. `Raw` is a note from a newer schema, of an unknown type, or one
/// this client cannot decode: it is shown read-only and saved back byte-for-byte except
/// for the metadata a user may still change (pin, trash, archive).
#[derive(Clone, Debug)]
enum Stored {
    Typed(Content),
    Raw(Value),
}
impl Stored {
    fn decode(value: Value) -> Self {
        let schema_ok = match value.get("schema") {
            None | Some(Value::Null) => true,
            Some(schema) => schema.as_u64().is_some_and(|s| s <= model::SUPPORTED_SCHEMA),
        };
        let type_ok = match value.get("type") {
            None | Some(Value::Null) => true,
            Some(Value::String(kind)) => {
                matches!(kind.as_str(), TEXT | CHECKLIST | SECRET | LEDGER | LEDGER_MONTH)
            }
            Some(_) => false,
        };
        if schema_ok && type_ok {
            if let Ok(content) = serde_json::from_value::<Content>(value.clone()) {
                if content.title.chars().count() <= model::MAX_TITLE_CHARS
                    && content.body.len() <= model::MAX_BODY_BYTES
                {
                    return Self::Typed(content);
                }
            }
        }
        Self::Raw(value)
    }
    /// What the UI may show: the typed content, or the readable basics of a raw note.
    fn display(&self) -> Content {
        match self {
            Self::Typed(content) => content.clone(),
            Self::Raw(value) => {
                let text = |key: &str| value.get(key).and_then(Value::as_str).unwrap_or("");
                let flag = |key: &str| value.get(key).and_then(Value::as_bool).unwrap_or(false);
                Content {
                    schema: value.get("schema").and_then(Value::as_u64),
                    kind: value.get("type").and_then(Value::as_str).map(str::to_owned),
                    title: text("title").chars().take(model::MAX_TITLE_CHARS).collect(),
                    body: text("body").into(),
                    pinned: flag("pinned"),
                    deleted: flag("deleted"),
                    archived: flag("archived"),
                    created_at: text("createdAt").into(),
                    updated_at: text("updatedAt").into(),
                    ..Content::new("")
                }
            }
        }
    }
    fn to_value(&self) -> Result<Value> {
        Ok(match self {
            Self::Typed(content) => serde_json::to_value(content)?,
            Self::Raw(value) => value.clone(),
        })
    }
}

/// Metadata-only change of a raw payload; every other key is kept as stored.
fn patch_raw(mut value: Value, draft: &Draft, now: &str) -> Result<Value> {
    let object = value.as_object_mut().ok_or(Error::Message(
        "이 메모는 이 버전에서 바꿀 수 없습니다.",
    ))?;
    for (key, change) in [
        ("pinned", draft.pinned),
        ("deleted", draft.deleted),
        ("archived", draft.archived),
    ] {
        if let Some(flag) = change {
            object.insert(key.into(), Value::Bool(flag));
        }
    }
    object.insert("updatedAt".into(), Value::String(now.into()));
    Ok(value)
}

fn view(
    id: String,
    stored: &Stored,
    local_revision: i64,
    pending: bool,
    conflict: bool,
    conflict_copy: bool,
    reveal_secret: bool,
) -> Note {
    let raw = matches!(stored, Stored::Raw(_));
    let mut content = stored.display();
    let read_only = raw || !content.supported();
    let redacted = content.kind() == SECRET && !reveal_secret;
    // Unknown keys stay in the backend; saves restore them from the stored payload.
    content.extra.clear();
    for item in content.items.iter_mut().flatten() {
        item.extra.clear();
    }
    for field in content.fields.iter_mut().flatten() {
        field.extra.clear();
    }
    ledger::clear_extra(&mut content);
    if redacted {
        content = Content {
            body: String::new(),
            memo: None,
            labels: vec![],
            items: None,
            fields: None,
            ..content
        };
    }
    Note {
        id,
        content,
        local_revision,
        pending,
        conflict,
        conflict_copy,
        read_only,
        redacted,
        copied_to: None,
    }
}

/// Applies a save request to the stored content (or a new note).
fn apply_draft(
    old: Option<Content>,
    draft: Draft,
    now: &str,
    secret_open: impl Fn() -> bool,
) -> Result<Content> {
    let mut content = old.clone().unwrap_or_else(|| Content::new(now));
    if let Some(value) = draft.pinned {
        content.pinned = value;
    }
    if let Some(value) = draft.deleted {
        content.deleted = value;
    }
    if let Some(value) = draft.archived {
        content.archived = value;
    }
    content.updated_at = now.into();
    if !content.supported() {
        return Ok(content);
    }
    if let Some(kind) = draft.kind {
        if !matches!(kind.as_str(), TEXT | CHECKLIST | SECRET | LEDGER | LEDGER_MONTH) {
            return Err(Error::Message("지원하지 않는 메모 형식입니다."));
        }
        if kind != content.kind() && old.is_some() && (kind == SECRET || content.kind() == SECRET) {
            return Err(Error::Message("암호 메모는 다른 형식으로 바꿀 수 없습니다."));
        }
        if kind != content.kind()
            && old.is_some()
            && (ledger::is_ledger_kind(&kind) || ledger::is_ledger_kind(content.kind()))
        {
            return Err(Error::Message("가계부는 다른 형식으로 바꿀 수 없습니다."));
        }
        content.kind = Some(kind);
    }
    for (stored, change) in [
        (&mut content.ledger, draft.ledger),
        (&mut content.month, draft.month),
    ] {
        if let Some(value) = change {
            if stored.as_ref().is_some_and(|s| *s != value) {
                return Err(Error::Message("가계부 월 기록의 가계부와 달은 바꿀 수 없습니다."));
            }
            *stored = Some(value);
        }
    }
    if let Some(income) = draft.income {
        content.income = Some(income);
    }
    if let Some(day) = draft.income_day {
        content.income_day = day;
    }
    let secret = content.kind() == SECRET;
    if secret
        && (draft.fields.is_some() || draft.memo.is_some() || draft.labels.is_some())
        && !secret_open()
    {
        return Err(SECRET_LOCKED);
    }
    if let Some(title) = draft.title {
        content.title = title;
    }
    if let Some(color) = draft.color {
        content.color = color;
    }
    if let Some(labels) = draft.labels {
        content.labels = labels;
    }
    match content.kind() {
        CHECKLIST => {
            if let Some(mut items) = draft.items {
                // The UI never sees unknown per-item keys; keep them by id.
                if let Some(old) = &content.items {
                    for item in items.iter_mut().filter(|i| i.extra.is_empty()) {
                        if let Some(prev) = old.iter().find(|o| o.id == item.id) {
                            item.extra = prev.extra.clone();
                        }
                    }
                }
                content.items = Some(items);
            }
            content.fields = None;
            content.memo = None;
            clear_ledger(&mut content);
        }
        SECRET => {
            if let Some(mut fields) = draft.fields {
                if let Some(old) = &content.fields {
                    for field in fields.iter_mut().filter(|f| f.extra.is_empty()) {
                        if let Some(prev) = old.iter().find(|o| o.id == field.id) {
                            field.extra = prev.extra.clone();
                        }
                    }
                }
                content.fields = Some(fields);
            }
            if let Some(memo) = draft.memo {
                content.memo = Some(memo);
            }
            content.items = None;
            clear_ledger(&mut content);
        }
        LEDGER => {
            if let Some(mut recurring) = draft.recurring {
                ledger::restore_extra(&mut recurring, content.recurring.as_ref());
                content.recurring = Some(recurring);
            }
            if let Some(mut planned) = draft.planned {
                ledger::restore_extra(&mut planned, content.planned.as_ref());
                content.planned = Some(planned);
            }
            content.items = None;
            content.fields = None;
            content.memo = None;
            content.entries = None;
            content.ledger = None;
            content.month = None;
        }
        LEDGER_MONTH => {
            if let Some(mut entries) = draft.entries {
                ledger::restore_extra(&mut entries, content.entries.as_ref());
                content.entries = Some(entries);
            }
            content.items = None;
            content.fields = None;
            content.memo = None;
            content.recurring = None;
            content.planned = None;
        }
        _ => {
            if let Some(body) = draft.body {
                content.body = body;
            }
            content.items = None;
            content.fields = None;
            content.memo = None;
            clear_ledger(&mut content);
        }
    }
    content.normalize();
    content.validate().map_err(Error::Message)?;
    Ok(content)
}
fn clear_ledger(content: &mut Content) {
    content.ledger = None;
    content.month = None;
    content.income = None;
    content.income_day = None;
    content.recurring = None;
    content.planned = None;
    content.entries = None;
}
fn state_value(db: &Connection, key: &str) -> Result<Option<String>> {
    Ok(db
        .query_row("SELECT value FROM notes_state WHERE key=?", [key], |r| {
            r.get(0)
        })
        .optional()?)
}
fn set_state(db: &Connection, key: &str, value: &str) -> Result<()> {
    db.execute(
        "INSERT INTO notes_state VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        params![key, value],
    )?;
    Ok(())
}
/// Keeps the payload a pull is about to replace, so a queued save against that local
/// revision can still be rebased (see `notes_save_with_key`).
fn remember_revision(db: &Connection, id: &str) -> Result<()> {
    db.execute(
        "INSERT OR REPLACE INTO notes_revisions(id,local_revision,payload) SELECT id,local_revision,payload FROM notes WHERE id=?1",
        [id],
    )?;
    db.execute(
        "DELETE FROM notes_revisions WHERE id=?1 AND local_revision < (SELECT local_revision FROM notes WHERE id=?1) - 20",
        [id],
    )?;
    Ok(())
}
fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

impl Library {
    fn notes_target(&self) -> String {
        format!(
            "Lakomics/Notes/{}",
            hex(&Sha256::digest(self.root().to_string_lossy().as_bytes()))
        )
    }
    fn notes_key(&self) -> Result<Vec<u8>> {
        let key = credential::notes_key(&self.notes_target())?.ok_or(LOCKED)?;
        if key.len() != 32 {
            return Err(INVALID);
        }
        let db = self.connection()?;
        if state_value(&db, "vault")?.as_deref() != Some(vault(&key).as_str()) {
            return Err(INVALID);
        }
        Ok(key)
    }
    pub fn notes_unlock(&self, text: &str) -> Result<State> {
        let key = unhex(text.trim())?;
        if key.len() != 32 {
            return Err(INVALID);
        }
        {
            let db = self.connection()?;
            if let Some(existing) = state_value(&db, "vault")? {
                if existing != vault(&key) {
                    return Err(INVALID);
                }
            }
            let mut stmt = db.prepare("SELECT id,payload FROM notes")?;
            for row in
                stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
            {
                let (id, payload) = row?;
                // Key check: every stored note must authenticate with this key.
                open_value(&key, &id, &serde_json::from_str(&payload)?)?;
            }
            // A key cannot silently replace another library's encryption identity.
            set_state(&db, "vault", &vault(&key))?;
        }
        credential::set_notes_key(&self.notes_target(), &key)?;
        self.notes_state()
    }
    /// The stored key is the recovery key; showing it lets a user re-record a lost copy.
    /// With a secret-note PIN set, it needs an open PIN session: the recovery key would
    /// otherwise bypass the PIN (it resets it).
    pub fn notes_recovery_key(&self) -> Result<String> {
        let key = self.notes_key()?;
        if self.pin_verifier()?.is_some() && !secret::touch(&self.notes_target()) {
            return Err(PIN_REQUIRED);
        }
        Ok(hex(&key))
    }
    pub fn notes_state(&self) -> Result<State> {
        let locked = |keyring_locked| State {
            unlocked: false,
            keyring_locked,
            notes: vec![],
            unreadable: 0,
            last_synced_at: None,
        };
        match credential::notes_key(&self.notes_target()) {
            // Reported, never resolved here: only an explicit user action may prompt.
            Err(LibraryError::CredentialStoreLocked) => return Ok(locked(true)),
            Err(error) => return Err(error.into()),
            Ok(None) => return Ok(locked(false)),
            Ok(Some(_)) => {}
        }
        let key = self.notes_key()?;
        self.notes_state_with_key(&key)
    }
    /// The user opened Notes while the keyring is locked: show the system unlock dialog.
    pub fn notes_unlock_keyring(&self) -> Result<State> {
        credential::unlock_store_interactive()?;
        self.notes_state()
    }
    fn pin_verifier(&self) -> Result<Option<secret::Verifier>> {
        // The verifier is per device (not per library) and never synced or exported.
        Ok(match credential::notes_key(secret::PIN_TARGET)? {
            Some(bytes) => Some(serde_json::from_slice(&bytes)?),
            None => None,
        })
    }
    fn set_pin(&self, pin: &str) -> Result<()> {
        if !secret::valid_pin(pin) {
            return Err(Error::Message("PIN은 숫자 4~8자리로 입력해 주세요."));
        }
        let verifier = secret::make_verifier(pin, secret::ITERATIONS).ok_or(INVALID)?;
        credential::set_notes_key(secret::PIN_TARGET, &serde_json::to_vec(&verifier)?)?;
        self.connection()?
            .execute("DELETE FROM notes_state WHERE key='pinFailures'", [])?;
        secret::open(&self.notes_target());
        Ok(())
    }
    pub fn notes_secret_status(&self) -> Result<SecretStatus> {
        Ok(SecretStatus {
            pin_set: self.pin_verifier()?.is_some(),
            unlocked: secret::is_open(&self.notes_target()),
        })
    }
    pub fn notes_secret_set_pin(&self, pin: &str) -> Result<State> {
        self.notes_key()?;
        if self.pin_verifier()?.is_some() {
            return Err(Error::Message("이미 PIN이 설정돼 있습니다."));
        }
        self.set_pin(pin)?;
        self.notes_state()
    }
    pub fn notes_secret_unlock(&self, pin: &str) -> Result<State> {
        self.notes_key()?;
        {
            // Check, verify and record under one lock; the counter survives restarts.
            let _attempt = secret::ATTEMPTS.lock().unwrap_or_else(|e| e.into_inner());
            let db = self.connection()?;
            let (failures, last) = state_value(&db, "pinFailures")?
                .and_then(|v| {
                    let (count, at) = v.split_once(':')?;
                    Some((count.parse::<u64>().ok()?, at.parse::<u64>().ok()?))
                })
                .unwrap_or((0, 0));
            let now = unix_now();
            if let Some(wait) = secret::lockout_remaining(failures, last, now) {
                return Err(Error::Text(format!(
                    "PIN을 여러 번 틀렸습니다. {}초 뒤에 다시 시도해 주세요.",
                    wait
                )));
            }
            let verifier = self
                .pin_verifier()?
                .ok_or(Error::Message("먼저 PIN을 설정해 주세요."))?;
            if !secret::check(&verifier, pin) {
                set_state(&db, "pinFailures", &format!("{}:{now}", failures + 1))?;
                return Err(Error::Message("PIN이 맞지 않습니다."));
            }
            db.execute("DELETE FROM notes_state WHERE key='pinFailures'", [])?;
        }
        secret::open(&self.notes_target());
        self.notes_state()
    }
    /// A forgotten PIN is replaced by proving the recovery key.
    pub fn notes_secret_reset_pin(&self, recovery_key: &str, pin: &str) -> Result<State> {
        let key = self.notes_key()?;
        let given = unhex(recovery_key.trim()).map_err(|_| RECOVERY_MISMATCH)?;
        if vault(&given) != vault(&key) {
            return Err(RECOVERY_MISMATCH);
        }
        self.set_pin(pin)?;
        self.notes_state()
    }
    pub fn notes_secret_lock(&self) {
        secret::lock(&self.notes_target());
    }
    /// UI activity while secret notes are open keeps the backend session alive.
    pub fn notes_secret_touch(&self) -> bool {
        secret::touch(&self.notes_target())
    }
    /// The deterministic id of a ledger's month note (see `ledger::month_id`).
    pub fn notes_ledger_month_id(&self, ledger_id: &str, month: &str) -> Result<String> {
        let key = self.notes_key()?;
        if !ledger::canonical_uuid(ledger_id) || !ledger::valid_month(month) {
            return Err(Error::Message("가계부 월 기록을 찾을 수 없습니다."));
        }
        Ok(ledger::month_id(&key, ledger_id, month))
    }
    pub fn notes_dismiss_conflict_copy(&self, id: &str) -> Result<()> {
        self.connection()?
            .execute("UPDATE notes SET conflict_copy=0 WHERE id=?", [id])?;
        Ok(())
    }
    pub fn notes_export(&self) -> Result<Backup> {
        let key = self.notes_key()?;
        self.notes_export_with_key(&key)
    }
    fn notes_export_with_key(&self, key: &[u8]) -> Result<Backup> {
        let db = self.connection()?;
        let mut stmt = db.prepare("SELECT id,payload FROM notes ORDER BY id")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        let mut items = vec![];
        for row in rows {
            let (id, payload) = row?;
            items.push(BackupItem {
                id,
                payload: serde_json::from_str(&payload)?,
            });
        }
        Ok(Backup {
            version: 1,
            vault: vault(&key),
            items,
        })
    }
    pub fn notes_import(&self, backup: Backup) -> Result<State> {
        let key = self.notes_key()?;
        self.notes_import_with_key(&key, backup)
    }
    fn notes_import_with_key(&self, key: &[u8], backup: Backup) -> Result<State> {
        if backup.version != 1 || backup.vault != vault(&key) {
            return Err(INVALID);
        }
        let mut prepared = vec![];
        for item in backup.items {
            // Re-sealed under a new id exactly as stored, including unknown keys.
            let value = open_value(&key, &item.id, &item.payload)?;
            let id = uuid::Uuid::new_v4().to_string();
            let payload = serde_json::to_string(&seal(&key, &id, &value)?)?;
            prepared.push((id, payload));
        }
        {
            let mut db = self.connection()?;
            let tx = db.transaction()?;
            for (id, payload) in prepared {
                tx.execute(
                    "INSERT INTO notes(id,payload,operation_id) VALUES(?1,?2,?3)",
                    params![id, payload, uuid::Uuid::new_v4().to_string()],
                )?;
            }
            tx.commit()?;
        }
        self.notes_state_with_key(&key)
    }
    fn notes_state_with_key(&self, key: &[u8]) -> Result<State> {
        let db = self.connection()?;
        let mut stmt = db.prepare(
            "SELECT id,payload,local_revision,dirty,conflict IS NOT NULL,conflict_copy FROM notes",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, bool>(3)?,
                r.get::<_, bool>(4)?,
                r.get::<_, bool>(5)?,
            ))
        })?;
        let reveal = secret::is_open(&self.notes_target());
        let mut notes = vec![];
        let mut unreadable = 0;
        for row in rows {
            let (id, payload, local_revision, pending, conflict, conflict_copy) = row?;
            // One damaged row must not hide the whole vault; it is counted instead.
            let Ok(stored) = open_str(key, &id, &payload) else {
                unreadable += 1;
                continue;
            };
            notes.push(view(
                id,
                &stored,
                local_revision,
                pending,
                conflict,
                conflict_copy,
                reveal,
            ));
        }
        Ok(State {
            unlocked: true,
            keyring_locked: false,
            notes,
            unreadable,
            last_synced_at: state_value(&db, "lastSyncedAt")?,
        })
    }
    pub fn notes_save(&self, draft: Draft) -> Result<Note> {
        let key = self.notes_key()?;
        self.notes_save_with_key(&key, draft)
    }
    /// Saves a draft. A draft written against an older local revision (a pull replaced
    /// the note while the save was queued) is rebased: three-way merged with the payload
    /// it was based on; only an unresolvable collision keeps it as a separate copy.
    fn notes_save_with_key(&self, key: &[u8], draft: Draft) -> Result<Note> {
        uuid::Uuid::parse_str(&draft.id).map_err(|_| INVALID)?;
        // A month note's content is only written under its derived id (metadata-only saves,
        // such as trashing a keep-both copy, are exempt).
        let month_edit = draft.kind.is_some()
            || draft.entries.is_some()
            || draft.ledger.is_some()
            || draft.month.is_some()
            || draft.income.is_some();
        let mut db = self.connection()?;
        let tx = db.transaction()?;
        let old: Option<(String, i64, bool, bool)> = tx
            .query_row(
                "SELECT payload,local_revision,conflict IS NOT NULL,conflict_copy FROM notes WHERE id=?",
                [&draft.id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .optional()?;
        let now = chrono::Utc::now().to_rfc3339();
        let id = draft.id.clone();
        let target = self.notes_target();
        let touch = || secret::touch(&target);
        let (stored, revision, conflict, conflict_copy) = match old {
            None => {
                let content = apply_draft(None, draft, &now, touch)?;
                (Stored::Typed(content), 1, false, false)
            }
            Some((payload, revision, conflict, conflict_copy)) => {
                let current = open_str(key, &id, &payload)?;
                let stale = revision != draft.expected_revision;
                let next = match current {
                    // Metadata patches are safe against any newer state.
                    Stored::Raw(value) => Stored::Raw(patch_raw(value, &draft, &now)?),
                    Stored::Typed(current) if !stale => {
                        Stored::Typed(apply_draft(Some(current), draft, &now, touch)?)
                    }
                    Stored::Typed(current) => {
                        let base = tx
                            .query_row(
                                "SELECT payload FROM notes_revisions WHERE id=?1 AND local_revision=?2",
                                params![id, draft.expected_revision],
                                |r| r.get::<_, String>(0),
                            )
                            .optional()?
                            .and_then(|p| open_str(key, &id, &p).ok());
                        let (base, missing_base) = match base {
                            Some(Stored::Typed(base)) => (base, false),
                            // Month notes merge against an empty month instead.
                            _ => match ledger::empty_month_base(&current, &current) {
                                Some(empty) => (empty, false),
                                None => (current.clone(), true),
                            },
                        };
                        let local = apply_draft(Some(base.clone()), draft, &now, touch)?;
                        match (!missing_base)
                            .then(|| model::merge(&base, &local, &current))
                            .flatten()
                        {
                            Some(merged) => Stored::Typed(merged),
                            None => {
                                let copy_id = uuid::Uuid::new_v4().to_string();
                                let sealed = serde_json::to_string(&seal(key, &copy_id, &local)?)?;
                                tx.execute(
                                    "INSERT INTO notes(id,payload,operation_id,conflict_copy) VALUES(?1,?2,?3,1)",
                                    params![copy_id, sealed, uuid::Uuid::new_v4().to_string()],
                                )?;
                                tx.commit()?;
                                let mut note = view(
                                    id,
                                    &Stored::Typed(current),
                                    revision,
                                    false,
                                    conflict,
                                    conflict_copy,
                                    secret::is_open(&target),
                                );
                                note.copied_to = Some(copy_id);
                                return Ok(note);
                            }
                        }
                    }
                };
                (next, revision + 1, conflict, conflict_copy)
            }
        };
        if let Stored::Typed(content) = &stored {
            if month_edit && content.kind() == LEDGER_MONTH {
                let ledger_id = content.ledger.as_deref().unwrap_or("");
                if !ledger::canonical_uuid(ledger_id)
                    || id != ledger::month_id(key, ledger_id, content.month.as_deref().unwrap_or(""))
                {
                    return Err(Error::Message("가계부 월 기록 형식이 올바르지 않습니다."));
                }
            }
        }
        let payload = serde_json::to_string(&seal(key, &id, &stored.to_value()?)?)?;
        tx.execute("INSERT INTO notes(id,payload,operation_id) VALUES(?1,?2,?3) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,operation_id=excluded.operation_id,local_revision=notes.local_revision+1,dirty=1",params![id,payload,uuid::Uuid::new_v4().to_string()])?;
        tx.commit()?;
        Ok(view(
            id,
            &stored,
            revision,
            true,
            conflict,
            conflict_copy,
            secret::is_open(&target),
        ))
    }
    pub fn notes_resolve(&self, id: &str, expected: i64, keep_copy: bool) -> Result<State> {
        let key = self.notes_key()?;
        self.notes_resolve_with_key(&key, id, expected, keep_copy)
    }
    fn notes_resolve_with_key(
        &self,
        key: &[u8],
        id: &str,
        expected: i64,
        keep_copy: bool,
    ) -> Result<State> {
        {
            let mut db = self.connection()?;
            let tx = db.transaction()?;
            let (local,conflict,revision):(String,String,i64)=tx.query_row("SELECT payload,conflict,local_revision FROM notes WHERE id=? AND conflict IS NOT NULL",[id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?;
            if revision != expected {
                return Err(Error::Message("메모가 변경됐습니다. 다시 확인해 주세요."));
            }
            let remote: Remote = serde_json::from_str(&conflict)?;
            open_value(&key, id, &remote.payload)?;
            if keep_copy {
                let copy_id = uuid::Uuid::new_v4().to_string();
                let copy = match open_str(&key, id, &local)? {
                    Stored::Typed(mut content) => {
                        content.title = format!(
                            "{} (복사본)",
                            content.title.chars().take(192).collect::<String>()
                        );
                        content.deleted = false;
                        serde_json::to_value(content)?
                    }
                    Stored::Raw(value) => value,
                };
                let payload = serde_json::to_string(&seal(&key, &copy_id, &copy)?)?;
                tx.execute(
                    "INSERT INTO notes(id,payload,operation_id) VALUES(?1,?2,?3)",
                    params![copy_id, payload, uuid::Uuid::new_v4().to_string()],
                )?;
            }
            remember_revision(&tx, id)?;
            tx.execute("UPDATE notes SET payload=?2,remote_revision=?3,operation_id=?4,local_revision=local_revision+1,dirty=0,conflict=NULL,base_payload=?2 WHERE id=?1",params![id,serde_json::to_string(&remote.payload)?,remote.revision,remote.operation_id])?;
            tx.commit()?;
        }
        self.notes_state_with_key(key)
    }
    /// Applies one pulled server row. A pending local edit from another operation is
    /// merged three-way against the last acknowledged payload; an unresolvable collision
    /// (or any side this client cannot decode) keeps the local edit as a separate
    /// conflict copy and takes the server version. A row that does not authenticate is
    /// skipped; it never stops the rest of the sync.
    fn notes_merge(&self, key: &[u8], remote: &Remote) -> Result<()> {
        if uuid::Uuid::parse_str(&remote.id).is_err() || remote.revision < 1 {
            return Ok(());
        }
        let Ok(remote_stored) = open(key, &remote.id, &remote.payload) else {
            return Ok(());
        };
        let remote_payload = serde_json::to_string(&remote.payload)?;
        let mut db = self.connection()?;
        let tx = db.transaction()?;
        let old: Option<(i64, bool, String, String, Option<String>)> = tx
            .query_row(
                "SELECT remote_revision,dirty,operation_id,payload,base_payload FROM notes WHERE id=?",
                [&remote.id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .optional()?;
        if let Some((revision, dirty, operation, payload, base)) = old {
            if remote.revision <= revision {
                return Ok(());
            }
            remember_revision(&tx, &remote.id)?;
            if dirty && operation != remote.operation_id {
                let local = open_str(key, &remote.id, &payload).ok();
                let base = base.and_then(|b| open_str(key, &remote.id, &b).ok());
                let merged = match (&base, &local, &remote_stored) {
                    (Some(Stored::Typed(b)), Some(Stored::Typed(l)), Stored::Typed(r)) => {
                        model::merge(b, l, r).map(|m| (m != *r, m))
                    }
                    // Both devices created the same month offline: union both sides.
                    (None, Some(Stored::Typed(l)), Stored::Typed(r)) => {
                        ledger::empty_month_base(l, r)
                            .and_then(|b| model::merge(&b, l, r))
                            .map(|m| (m != *r, m))
                    }
                    _ => None,
                };
                match merged {
                    Some((true, merged)) => {
                        let sealed = serde_json::to_string(&seal(key, &remote.id, &merged)?)?;
                        tx.execute("UPDATE notes SET payload=?2,remote_revision=?3,operation_id=?4,local_revision=local_revision+1,dirty=1,conflict=NULL,base_payload=?5 WHERE id=?1",params![remote.id,sealed,remote.revision,uuid::Uuid::new_v4().to_string(),remote_payload])?;
                        tx.commit()?;
                        return Ok(());
                    }
                    Some((false, _)) => {}
                    None => {
                        if let Some(local) = local {
                            let copy_id = uuid::Uuid::new_v4().to_string();
                            let sealed =
                                serde_json::to_string(&seal(key, &copy_id, &local.to_value()?)?)?;
                            tx.execute(
                                "INSERT INTO notes(id,payload,operation_id,conflict_copy) VALUES(?1,?2,?3,1)",
                                params![copy_id, sealed, uuid::Uuid::new_v4().to_string()],
                            )?;
                        }
                    }
                }
            }
        }
        tx.execute("INSERT INTO notes(id,payload,remote_revision,operation_id,dirty,base_payload) VALUES(?1,?2,?3,?4,0,?2) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,remote_revision=excluded.remote_revision,operation_id=excluded.operation_id,local_revision=notes.local_revision+1,dirty=0,conflict=NULL,base_payload=excluded.base_payload",params![remote.id,remote_payload,remote.revision,remote.operation_id])?;
        tx.commit()?;
        Ok(())
    }
    pub fn notes_sync(&self) -> Result<State> {
        let _sync = SYNC
            .try_lock()
            .map_err(|_| Error::Message("메모를 동기화하고 있습니다."))?;
        let key = self.notes_key()?;
        let config = self.cloud_sync_config()?;
        if !config.enabled {
            return Err(Error::Message(
                "Cloud 설정에서 동기화를 연결해 주세요. 메모는 PC에 저장돼 있습니다.",
            ));
        }
        let endpoint = config
            .api_base_url
            .ok_or(Error::Message("Cloud 서버 주소를 설정해 주세요."))?;
        let token = credential::read_cloud_api_token_os()?;
        let token = token.expose();
        self.notes_sync_with(&key, &endpoint, &token)
    }
    fn notes_sync_with(&self, key: &[u8], endpoint: &str, token: &str) -> Result<State> {
        let client = crate::cloud::client::CloudClient::new(&endpoint)?;
        {
            let db = self.connection()?;
            if let Some(bound) = state_value(&db, "endpoint")? {
                if bound != endpoint {
                    return Err(Error::Message(
                        "메모 동기화 서버가 변경됐습니다. 기존 서버 연결을 복원해 주세요.",
                    ));
                }
            }
        }
        let mut cursor = 0;
        loop {
            let page = client.notes_list(&vault(&key), cursor, &token)?;
            for remote in &page.items {
                self.notes_merge(&key, remote)?;
            }
            match page.next_cursor {
                Some(next) if next > cursor => cursor = next,
                None => break,
                _ => return Err(INVALID),
            }
        }
        {
            let db = self.connection()?;
            set_state(&db, "endpoint", &endpoint)?;
        }
        let pending = {
            let db = self.connection()?;
            let mut stmt=db.prepare("SELECT id,payload,remote_revision,operation_id,local_revision FROM notes WHERE dirty=1 AND conflict IS NULL")?;
            let rows = stmt.query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, i64>(4)?,
                ))
            })?;
            rows.collect::<std::result::Result<Vec<_>, _>>()?
        };
        for (id, payload, revision, operation, local_revision) in pending {
            let payload: Envelope = serde_json::from_str(&payload)?;
            let remote =
                client.notes_put(&vault(&key), &id, revision, &operation, &payload, &token)?;
            if remote.id != id
                || remote.operation_id != operation
                || remote.revision != revision + 1
                || serde_json::to_string(&remote.payload)? != serde_json::to_string(&payload)?
            {
                return Err(INVALID);
            }
            let db = self.connection()?;
            // A newer edit made during the HTTP request remains dirty and never loses its text.
            // The acknowledged payload is the merge base for later concurrent edits.
            db.execute("UPDATE notes SET remote_revision=?2,dirty=CASE WHEN local_revision=?3 THEN 0 ELSE 1 END,base_payload=?5 WHERE id=?1 AND remote_revision=?4",params![id,remote.revision,local_revision,revision,serde_json::to_string(&payload)?])?;
        }
        {
            let db = self.connection()?;
            set_state(&db, "lastSyncedAt", &chrono::Utc::now().to_rfc3339())?;
        }
        self.notes_state_with_key(key)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[cfg(any(windows, target_os = "linux"))]
    #[ignore = "Opt-in native credential store integration; isolated temporary library"]
    fn native_key_survives_library_reopen_and_rejects_replacement() {
        let temp = tempfile::tempdir().unwrap();
        let lib = Library::open(temp.path()).unwrap();
        struct Cleanup(String);
        impl Drop for Cleanup {
            fn drop(&mut self) { credential::delete_notes_test_key(&self.0); }
        }
        let cleanup = Cleanup(lib.notes_target());
        let key = generate_key().unwrap();
        assert!(lib.notes_unlock(&key).unwrap().unlocked);
        let id = uuid::Uuid::new_v4().to_string();
        lib.notes_save(draft(&id, "isolated credential check", 0)).unwrap();
        drop(lib);
        let reopened = Library::open(temp.path()).unwrap();
        assert_eq!(reopened.notes_state().unwrap().notes[0].content.title, "isolated credential check");
        assert!(reopened.notes_unlock(&generate_key().unwrap()).is_err());
        assert_eq!(reopened.notes_state().unwrap().notes.len(), 1);
        drop(cleanup);
        assert!(!reopened.notes_state().unwrap().unlocked);
    }
    #[test]
    fn encrypted_payload_rejects_wrong_key_tamper_and_other_identity() {
        let key = [7; 32];
        let content = Content {
            title: "비밀 제목".into(),
            body: "본문".into(),
            pinned: true,
            ..Content::new("now")
        };
        let sealed = seal(&key, "note-a", &content).unwrap();
        assert_eq!(open(&key, "note-a", &sealed).unwrap().display().body, "본문");
        assert!(open(&[8; 32], "note-a", &sealed).is_err());
        assert!(open(&key, "note-b", &sealed).is_err());
        let mut bad = sealed.clone();
        let first = u8::from_str_radix(&bad.ciphertext[..2], 16).unwrap() ^ 1;
        bad.ciphertext.replace_range(0..2, &format!("{first:02x}"));
        assert!(open(&key, "note-a", &bad).is_err());
        assert_ne!(sealed.nonce, seal(&key, "note-a", &content).unwrap().nonce);
    }
    fn draft(id: &str, title: &str, revision: i64) -> Draft {
        Draft {
            id: id.into(),
            title: Some(title.into()),
            body: Some("private body".into()),
            pinned: Some(false),
            deleted: Some(false),
            expected_revision: revision,
            ..Default::default()
        }
    }
    #[test]
    fn local_ciphertext_cas_remote_conflict_and_tombstone() {
        let temp = tempfile::tempdir().unwrap();
        let lib = Library::open(temp.path()).unwrap();
        let key = [5; 32];
        let id = uuid::Uuid::new_v4().to_string();
        let saved = lib
            .notes_save_with_key(&key, draft(&id, "private title", 0))
            .unwrap();
        let db = lib.connection().unwrap();
        let payload: String = db
            .query_row("SELECT payload FROM notes", [], |r| r.get(0))
            .unwrap();
        drop(db);
        assert!(!payload.contains("private"));
        // A stale save with no remembered base is kept as a separate copy, never refused.
        let stale = lib
            .notes_save_with_key(&key, draft(&id, "stale", 0))
            .unwrap();
        let stale_copy = stale.copied_to.clone().unwrap();
        assert_eq!(stale.content.title, "private title");
        let remote = Remote {
            id: id.clone(),
            revision: 1,
            operation_id: uuid::Uuid::new_v4().to_string(),
            sequence: 1,
            payload: seal(
                &key,
                &id,
                &Content {
                    title: "remote".into(),
                    ..saved.content.clone()
                },
            )
            .unwrap(),
        };
        lib.notes_merge(&key, &remote).unwrap();
        // No base yet: the collision keeps both copies automatically.
        let state = lib.notes_state_with_key(&key).unwrap();
        let original = state.notes.iter().find(|n| n.id == id).unwrap();
        assert_eq!(original.content.title, "remote");
        assert!(state.notes.iter().any(|n| n.id == stale_copy && n.content.title == "stale" && n.conflict_copy));
        let copy = state.notes.iter().find(|n| n.id != id && n.id != stale_copy).unwrap();
        assert!(copy.conflict_copy && copy.pending);
        assert_eq!(copy.content.title, "private title");
        let mut deleted = draft(&id, "remote", original.local_revision);
        deleted.deleted = Some(true);
        lib.notes_save_with_key(&key, deleted).unwrap();
        assert!(
            lib.notes_state_with_key(&key)
                .unwrap()
                .notes
                .iter()
                .any(|n| n.id == id && n.content.deleted)
        );
    }
    #[test]
    fn two_devices_exchange_only_encrypted_payload_and_preserve_identity() {
        let temp_a = tempfile::tempdir().unwrap();
        let temp_b = tempfile::tempdir().unwrap();
        let a = Library::open(temp_a.path()).unwrap();
        let b = Library::open(temp_b.path()).unwrap();
        let key = [9; 32];
        let id = uuid::Uuid::new_v4().to_string();
        a.notes_save_with_key(&key, draft(&id, "secret note", 0))
            .unwrap();
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}", server.server_addr());
        let expected_id = id.clone();
        let thread = std::thread::spawn(move || {
            let req = server.recv().unwrap();
            assert!(req.url().starts_with("/v1/notes/"));
            req.respond(tiny_http::Response::from_string(
                r#"{"items":[],"nextCursor":null}"#,
            ))
            .unwrap();
            let mut req = server.recv().unwrap();
            let mut body = String::new();
            req.as_reader().read_to_string(&mut body).unwrap();
            assert!(!body.contains("secret note"));
            assert!(!body.contains("private body"));
            let write: serde_json::Value = serde_json::from_str(&body).unwrap();
            let remote = serde_json::json!({"id":expected_id,"revision":1,"operationId":write["operationId"],"payload":write["payload"],"sequence":1});
            req.respond(tiny_http::Response::from_string(remote.to_string()))
                .unwrap();
            let req = server.recv().unwrap();
            req.respond(tiny_http::Response::from_string(
                serde_json::json!({"items":[remote],"nextCursor":null}).to_string(),
            ))
            .unwrap();
        });
        let state = a.notes_sync_with(&key, &endpoint, "fixture-token").unwrap();
        assert!(!state.notes[0].pending);
        let other = b.notes_sync_with(&key, &endpoint, "fixture-token").unwrap();
        assert_eq!(other.notes[0].id, id);
        assert_eq!(other.notes[0].content.title, "secret note");
        thread.join().unwrap();
    }
    #[test]
    fn recovery_keeps_both_conflicting_versions_and_backup_import_is_atomic() {
        let temp = tempfile::tempdir().unwrap();
        let lib = Library::open(temp.path()).unwrap();
        let key = [11; 32];
        let id = uuid::Uuid::new_v4().to_string();
        let saved = lib
            .notes_save_with_key(&key, draft(&id, "local", 0))
            .unwrap();
        let remote = Remote {
            id: id.clone(),
            revision: 1,
            operation_id: uuid::Uuid::new_v4().to_string(),
            sequence: 1,
            payload: seal(
                &key,
                &id,
                &Content {
                    title: "remote".into(),
                    ..saved.content
                },
            )
            .unwrap(),
        };
        // A conflict stored by a pre-v2 build still resolves manually.
        lib.connection()
            .unwrap()
            .execute(
                "UPDATE notes SET conflict=?2 WHERE id=?1",
                params![id, serde_json::to_string(&remote).unwrap()],
            )
            .unwrap();
        let state = lib.notes_resolve_with_key(&key, &id, 1, true).unwrap();
        assert_eq!(state.notes.len(), 2);
        assert!(state
            .notes
            .iter()
            .any(|n| n.content.title == "local (복사본)" && n.pending));
        assert!(state
            .notes
            .iter()
            .any(|n| n.content.title == "remote" && !n.pending));
        let backup = lib.notes_export_with_key(&key).unwrap();
        let encoded = serde_json::to_string(&backup).unwrap();
        assert!(!encoded.contains("local"));
        assert!(!encoded.contains("remote"));
        assert!(lib.notes_import_with_key(&[12; 32], backup).is_err());
        let mut bad: Backup = serde_json::from_str(&encoded).unwrap();
        bad.items[1].payload.nonce = "00".into();
        assert!(lib.notes_import_with_key(&key, bad).is_err());
        assert_eq!(lib.notes_state_with_key(&key).unwrap().notes.len(), 2);
        let imported = lib
            .notes_import_with_key(&key, serde_json::from_str(&encoded).unwrap())
            .unwrap();
        assert_eq!(imported.notes.len(), 4);
        assert_eq!(imported.notes.iter().filter(|n| n.id == id).count(), 1);
    }
}

#[cfg(test)]
mod v2_tests {
    use super::*;
    use serde_json::json;

    fn remote(key: &[u8], id: &str, revision: i64, content: &Content) -> Remote {
        Remote {
            id: id.into(),
            revision,
            operation_id: uuid::Uuid::new_v4().to_string(),
            sequence: revision,
            payload: seal(key, id, content).unwrap(),
        }
    }
    fn column(lib: &Library, sql: &str, id: &str) -> Option<String> {
        lib.connection()
            .unwrap()
            .query_row(sql, [id], |r| r.get(0))
            .unwrap()
    }
    fn checklist_draft(id: &str, revision: i64, items: serde_json::Value) -> Draft {
        serde_json::from_value(json!({"id":id,"expectedRevision":revision,"type":"checklist","title":"장보기","items":items})).unwrap()
    }

    #[test]
    fn base_is_recorded_on_clean_apply_and_concurrent_checklist_edits_merge() {
        let temp = tempfile::tempdir().unwrap();
        let lib = Library::open(temp.path()).unwrap();
        let key = [21; 32];
        let id = uuid::Uuid::new_v4().to_string();
        let mut base = Content::new("2026-09-01T00:00:00Z");
        base.title = "장보기".into();
        base.kind = Some(CHECKLIST.into());
        base.items = Some(serde_json::from_value(json!([
            {"id":"a","text":"우유","checked":false,"order":"V"},
            {"id":"b","text":"달걀","checked":false,"order":"h"}
        ])).unwrap());
        base.normalize();
        let first = remote(&key, &id, 1, &base);
        lib.notes_merge(&key, &first).unwrap();
        assert_eq!(
            column(&lib, "SELECT base_payload FROM notes WHERE id=?", &id),
            Some(serde_json::to_string(&first.payload).unwrap())
        );
        // Local: check item a. Remote: edit item b.
        lib.notes_save_with_key(&key, checklist_draft(&id, 1, json!([
            {"id":"a","text":"우유","checked":true,"order":"V"},
            {"id":"b","text":"달걀","checked":false,"order":"h"}
        ]))).unwrap();
        let mut theirs = base.clone();
        theirs.items.as_mut().unwrap()[1].text = "달걀 10개".into();
        theirs.normalize();
        let second = remote(&key, &id, 2, &theirs);
        lib.notes_merge(&key, &second).unwrap();
        let state = lib.notes_state_with_key(&key).unwrap();
        assert_eq!(state.notes.len(), 1, "no conflict copy");
        let note = &state.notes[0];
        assert!(note.pending && !note.conflict && !note.conflict_copy);
        let items = note.content.items.as_ref().unwrap();
        assert!(items[0].checked);
        assert_eq!(items[1].text, "달걀 10개");
        assert_eq!(note.content.body, "- [ ] 달걀 10개\n- [x] 우유");
        // The merged write is based on the server revision it merged with.
        let (revision, base_payload): (i64, String) = lib.connection().unwrap().query_row(
            "SELECT remote_revision,base_payload FROM notes WHERE id=?", [&id], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!(revision, 2);
        assert_eq!(base_payload, serde_json::to_string(&second.payload).unwrap());
    }

    #[test]
    fn unresolvable_or_baseless_collisions_keep_both_copies_automatically() {
        let temp = tempfile::tempdir().unwrap();
        let lib = Library::open(temp.path()).unwrap();
        let key = [22; 32];
        // Never synced: no base, so any remote collision keeps both.
        let id = uuid::Uuid::new_v4().to_string();
        let saved = lib.notes_save_with_key(&key, serde_json::from_value(json!({"id":id,"expectedRevision":0,"title":"로컬","body":"내 글"})).unwrap()).unwrap();
        let theirs = Content { title: "서버".into(), ..saved.content.clone() };
        lib.notes_merge(&key, &remote(&key, &id, 1, &theirs)).unwrap();
        let state = lib.notes_state_with_key(&key).unwrap();
        assert_eq!(state.notes.len(), 2);
        let original = state.notes.iter().find(|n| n.id == id).unwrap();
        assert_eq!(original.content.title, "서버");
        assert!(!original.pending && !original.conflict);
        let copy = state.notes.iter().find(|n| n.id != id).unwrap();
        assert_eq!(copy.content.title, "로컬");
        assert!(copy.pending && copy.conflict_copy && !copy.conflict);
        lib.notes_dismiss_conflict_copy(&copy.id).unwrap();
        assert!(lib.notes_state_with_key(&key).unwrap().notes.iter().all(|n| !n.conflict_copy));
        // With a base, both sides editing the body is still a collision.
        let base = original.content.clone();
        lib.notes_save_with_key(&key, serde_json::from_value(json!({"id":id,"expectedRevision":original.local_revision,"body":"로컬 수정"})).unwrap()).unwrap();
        let theirs = Content { body: "서버 수정".into(), ..base };
        lib.notes_merge(&key, &remote(&key, &id, 2, &theirs)).unwrap();
        let state = lib.notes_state_with_key(&key).unwrap();
        assert_eq!(state.notes.len(), 3);
        assert_eq!(state.notes.iter().find(|n| n.id == id).unwrap().content.body, "서버 수정");
        assert!(state.notes.iter().any(|n| n.conflict_copy && n.content.body == "로컬 수정"));
    }

    #[test]
    fn saves_preserve_unknown_fields_and_newer_schemas_stay_read_only() {
        let temp = tempfile::tempdir().unwrap();
        let lib = Library::open(temp.path()).unwrap();
        let key = [23; 32];
        let id = uuid::Uuid::new_v4().to_string();
        let future: Content = serde_json::from_value(json!({"schema":3,"type":"drawing","title":"그림","body":"대체","pinned":false,"deleted":false,"createdAt":"a","updatedAt":"a","strokes":[1,2]})).unwrap();
        lib.notes_merge(&key, &remote(&key, &id, 1, &future)).unwrap();
        let note = lib.notes_state_with_key(&key).unwrap().notes.remove(0);
        assert!(note.read_only);
        let saved = lib.notes_save_with_key(&key, serde_json::from_value(json!({"id":id,"expectedRevision":note.local_revision,"title":"바꿈","body":"x","pinned":true,"type":"text"})).unwrap()).unwrap();
        assert!(saved.content.pinned && saved.read_only);
        assert_eq!(saved.content.title, "그림");
        assert!(saved.content.extra.is_empty(), "unknown keys never reach the UI");
        assert_eq!(saved.content.schema, Some(3));
        let stored = |id: &str| -> serde_json::Value {
            let payload = column(&lib, "SELECT payload FROM notes WHERE id=?", id).unwrap();
            open_value(&key, id, &serde_json::from_str(&payload).unwrap()).unwrap()
        };
        assert_eq!(stored(&id)["strokes"], json!([1, 2]));
        assert_eq!(stored(&id)["pinned"], json!(true));
        // A supported note keeps unknown keys through an ordinary edit.
        let id2 = uuid::Uuid::new_v4().to_string();
        let known: Content = serde_json::from_value(json!({"schema":2,"title":"t","body":"b","color":"magenta","pinned":false,"deleted":false,"createdAt":"a","updatedAt":"a","reminder":"09:00"})).unwrap();
        lib.notes_merge(&key, &remote(&key, &id2, 1, &known)).unwrap();
        let rev = lib.notes_state_with_key(&key).unwrap().notes.into_iter().find(|n| n.id == id2).unwrap().local_revision;
        let saved = lib.notes_save_with_key(&key, serde_json::from_value(json!({"id":id2,"expectedRevision":rev,"body":"새 본문"})).unwrap()).unwrap();
        assert_eq!(stored(&id2)["reminder"], json!("09:00"));
        assert_eq!(saved.content.color.as_deref(), Some("magenta"), "unknown colour kept");
        assert_eq!(saved.content.body, "새 본문");
        // Limits are enforced on save.
        let too_many: Vec<_> = (0..=model::MAX_ITEMS).map(|i| json!({"id":format!("i{i}"),"text":"x","checked":false,"order":"a"})).collect();
        assert!(lib.notes_save_with_key(&key, checklist_draft(&uuid::Uuid::new_v4().to_string(), 0, json!(too_many))).is_err());
        // Converting between checklist and text rewrites the fallback body.
        let id3 = uuid::Uuid::new_v4().to_string();
        let c = lib.notes_save_with_key(&key, checklist_draft(&id3, 0, json!([{"id":"a","text":"우유","checked":true,"order":"V"}]))).unwrap();
        assert_eq!(c.content.body, "- [x] 우유");
        assert_eq!(c.content.schema, Some(2));
        let t = lib.notes_save_with_key(&key, serde_json::from_value(json!({"id":id3,"expectedRevision":1,"type":"text","body":"- [x] 우유"})).unwrap()).unwrap();
        assert!(t.content.items.is_none() && t.content.kind.is_none());
    }

    #[test]
    fn put_acknowledgement_records_the_base() {
        let temp = tempfile::tempdir().unwrap();
        let lib = Library::open(temp.path()).unwrap();
        let key = [24; 32];
        let id = uuid::Uuid::new_v4().to_string();
        lib.notes_save_with_key(&key, serde_json::from_value(json!({"id":id,"expectedRevision":0,"title":"보낼 메모","labels":["업무"]})).unwrap()).unwrap();
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}", server.server_addr());
        let expected_id = id.clone();
        let thread = std::thread::spawn(move || {
            let req = server.recv().unwrap();
            req.respond(tiny_http::Response::from_string(r#"{"items":[],"nextCursor":null}"#)).unwrap();
            let mut req = server.recv().unwrap();
            let mut body = String::new();
            req.as_reader().read_to_string(&mut body).unwrap();
            assert!(!body.contains("업무"));
            let write: serde_json::Value = serde_json::from_str(&body).unwrap();
            let remote = json!({"id":expected_id,"revision":1,"operationId":write["operationId"],"payload":write["payload"],"sequence":1});
            req.respond(tiny_http::Response::from_string(remote.to_string())).unwrap();
            write["payload"].to_string()
        });
        lib.notes_sync_with(&key, &endpoint, "fixture-token").unwrap();
        let sent = thread.join().unwrap();
        let base: serde_json::Value = serde_json::from_str(&column(&lib, "SELECT base_payload FROM notes WHERE id=?", &id).unwrap()).unwrap();
        assert_eq!(base, serde_json::from_str::<serde_json::Value>(&sent).unwrap());
    }

    #[test]
    fn secret_notes_need_the_pin_session_and_are_redacted_when_locked() {
        let temp = tempfile::tempdir().unwrap();
        let lib = Library::open(temp.path()).unwrap();
        let key = generate_key().unwrap();
        lib.notes_unlock(&key).unwrap();
        let raw = unhex(&key).unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let draft = || -> Draft { serde_json::from_value(json!({"id":id,"expectedRevision":0,"type":"secret","title":"서버 계정","memo":"메모","fields":[{"id":"f","label":"비밀번호","value":"hunter2","order":"V"}]})).unwrap() };
        assert!(lib.notes_save_with_key(&raw, draft()).is_err(), "no session");
        assert!(!lib.notes_secret_status().unwrap().pin_set);
        assert!(lib.notes_secret_unlock("1234").is_err());
        assert!(lib.notes_secret_set_pin("12").is_err());
        lib.notes_secret_set_pin("2468").unwrap();
        assert!(lib.notes_secret_set_pin("1357").is_err(), "cannot silently replace");
        let saved = lib.notes_save_with_key(&raw, draft()).unwrap();
        assert!(!saved.redacted);
        assert_eq!(saved.content.body, "비밀번호: hunter2\n\n메모");
        lib.notes_secret_lock();
        let state = lib.notes_state().unwrap();
        let locked = &state.notes[0];
        assert!(locked.redacted);
        assert_eq!(locked.content.title, "서버 계정");
        let shown = serde_json::to_string(locked).unwrap();
        assert!(!shown.contains("hunter2") && !shown.contains("메모\""));
        // Metadata-only saves work while locked and keep the hidden fields.
        let pinned = lib.notes_save_with_key(&raw, serde_json::from_value(json!({"id":id,"expectedRevision":1,"pinned":true})).unwrap()).unwrap();
        assert!(pinned.redacted && pinned.content.pinned);
        assert!(lib.notes_secret_unlock("0000").is_err());
        let state = lib.notes_secret_unlock("2468").unwrap();
        assert_eq!(state.notes[0].content.fields.as_ref().unwrap()[0].value, "hunter2");
        // Converting a secret note to another type is refused.
        assert!(lib.notes_save_with_key(&raw, serde_json::from_value(json!({"id":id,"expectedRevision":2,"type":"text"})).unwrap()).is_err());
        // A forgotten PIN is replaced only with the recovery key.
        assert!(lib.notes_secret_reset_pin(&generate_key().unwrap(), "9999").is_err());
        lib.notes_secret_reset_pin(&key, "9999").unwrap();
        lib.notes_secret_lock();
        assert!(lib.notes_secret_unlock("9999").is_ok());
        lib.notes_secret_lock();
    }
}

#[cfg(test)]
mod review_tests {
    use super::*;
    use serde_json::json;

    fn remote(key: &[u8], id: &str, revision: i64, content: &impl Serialize) -> Remote {
        Remote {
            id: id.into(),
            revision,
            operation_id: uuid::Uuid::new_v4().to_string(),
            sequence: revision,
            payload: seal(key, id, content).unwrap(),
        }
    }
    fn save(lib: &Library, key: &[u8], draft: serde_json::Value) -> Note {
        lib.notes_save_with_key(key, serde_json::from_value(draft).unwrap())
            .unwrap()
    }
    fn note(lib: &Library, key: &[u8], id: &str) -> Note {
        lib.notes_state_with_key(key)
            .unwrap()
            .notes
            .into_iter()
            .find(|n| n.id == id)
            .unwrap()
    }

    #[test]
    fn a_save_queued_before_a_pull_is_rebased_instead_of_stranded() {
        let temp = tempfile::tempdir().unwrap();
        let lib = Library::open(temp.path()).unwrap();
        let key = [31; 32];
        let id = uuid::Uuid::new_v4().to_string();
        let mut server = Content::new("2026-09-01T00:00:00Z");
        server.title = "장보기".into();
        server.body = "우유".into();
        lib.notes_merge(&key, &remote(&key, &id, 1, &server)).unwrap();
        // The editor knows this revision and starts typing.
        let seen = note(&lib, &key, &id).local_revision;
        // A pull replaces the note (another device renamed it) before the save lands.
        let renamed = Content { title: "주말 장보기".into(), ..server.clone() };
        lib.notes_merge(&key, &remote(&key, &id, 2, &renamed)).unwrap();
        assert_eq!(note(&lib, &key, &id).local_revision, seen + 1);
        let saved = save(&lib, &key, json!({"id":id,"expectedRevision":seen,"title":"장보기","body":"우유\n빵"}));
        assert!(saved.copied_to.is_none());
        assert_eq!(saved.local_revision, seen + 2);
        assert_eq!(saved.content.title, "주말 장보기", "the remote rename survives");
        assert_eq!(saved.content.body, "우유\n빵", "the typed text survives");
        // Typing continues on the returned revision without any error.
        let again = save(&lib, &key, json!({"id":id,"expectedRevision":saved.local_revision,"title":"주말 장보기","body":"우유\n빵\n달걀"}));
        assert_eq!(again.content.body, "우유\n빵\n달걀");
        // A pull that merges into a pending edit is rebased the same way.
        let before = again.local_revision;
        let pinned = Content { pinned: true, title: "주말 장보기".into(), ..server.clone() };
        lib.notes_merge(&key, &remote(&key, &id, 3, &pinned)).unwrap();
        let rebased = save(&lib, &key, json!({"id":id,"expectedRevision":before,"title":"주말 장보기","body":"우유\n빵\n달걀\n버터"}));
        assert!(rebased.content.pinned && rebased.copied_to.is_none());
        assert_eq!(rebased.content.body, "우유\n빵\n달걀\n버터");
        assert_eq!(lib.notes_state_with_key(&key).unwrap().notes.len(), 1);
    }

    #[test]
    fn an_unmergeable_stale_save_is_kept_as_a_copy() {
        let temp = tempfile::tempdir().unwrap();
        let lib = Library::open(temp.path()).unwrap();
        let key = [32; 32];
        let id = uuid::Uuid::new_v4().to_string();
        let mut server = Content::new("2026-09-01T00:00:00Z");
        server.body = "처음".into();
        lib.notes_merge(&key, &remote(&key, &id, 1, &server)).unwrap();
        let seen = note(&lib, &key, &id).local_revision;
        let theirs = Content { body: "다른 기기".into(), ..server };
        lib.notes_merge(&key, &remote(&key, &id, 2, &theirs)).unwrap();
        let saved = save(&lib, &key, json!({"id":id,"expectedRevision":seen,"body":"이 PC"}));
        let copy = saved.copied_to.clone().unwrap();
        assert_eq!(saved.content.body, "다른 기기");
        let copy = note(&lib, &key, &copy);
        assert!(copy.conflict_copy && copy.pending);
        assert_eq!(copy.content.body, "이 PC");
    }

    #[test]
    fn undecodable_and_newer_payloads_stay_readable_and_never_break_the_vault() {
        let temp = tempfile::tempdir().unwrap();
        let lib = Library::open(temp.path()).unwrap();
        let key = [33; 32];
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../tests/fixtures/notes-v2/payload-examples.json");
        let file: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let cases = file["undecodable"].as_array().unwrap();
        assert!(cases.len() >= 5);
        for (index, case) in cases.iter().enumerate() {
            let id = uuid::Uuid::new_v4().to_string();
            let payload = &case["payload"];
            lib.notes_merge(&key, &remote(&key, &id, 1, payload)).unwrap();
            let shown = note(&lib, &key, &id);
            let name = case["name"].as_str().unwrap();
            assert!(shown.read_only, "{name}");
            assert_eq!(shown.content.title, case["shows"]["title"].as_str().unwrap(), "{name}");
            // Pin/trash/archive patch the raw payload; everything else is kept as stored.
            let saved = save(&lib, &key, json!({"id":id,"expectedRevision":shown.local_revision,"pinned":true,"archived":true,"title":"무시됨","body":"무시됨"}));
            assert!(saved.read_only && saved.content.pinned, "{name}");
            let stored_payload = lib.connection().unwrap().query_row("SELECT payload FROM notes WHERE id=?", [&id], |r| r.get::<_, String>(0)).unwrap();
            let mut stored = open_value(&key, &id, &serde_json::from_str(&stored_payload).unwrap()).unwrap();
            let mut expected = payload.clone();
            for value in [&mut stored, &mut expected] {
                let object = value.as_object_mut().unwrap();
                object.remove("updatedAt");
                object.remove("pinned");
                object.remove("archived");
            }
            assert_eq!(stored, expected, "{name}: kept byte-for-byte apart from metadata");
            assert_eq!(lib.notes_state_with_key(&key).unwrap().notes.len(), index + 1);
        }
        // A row that does not authenticate is counted, not fatal; a pulled one is skipped.
        let bad = uuid::Uuid::new_v4().to_string();
        let foreign = seal(&[99; 32], &bad, &json!({"title":"x"})).unwrap();
        lib.connection().unwrap().execute("INSERT INTO notes(id,payload,operation_id) VALUES(?1,?2,'op')", params![bad, serde_json::to_string(&foreign).unwrap()]).unwrap();
        let state = lib.notes_state_with_key(&key).unwrap();
        assert_eq!(state.unreadable, 1);
        assert_eq!(state.notes.len(), cases.len());
        let other = uuid::Uuid::new_v4().to_string();
        let mut unauthenticated = remote(&key, &other, 1, &json!({"title":"y"}));
        unauthenticated.payload = seal(&[98; 32], &other, &json!({"title":"y"})).unwrap();
        lib.notes_merge(&key, &unauthenticated).unwrap();
    }

    #[test]
    fn recovery_key_needs_the_pin_once_a_pin_exists_and_failures_persist() {
        let temp = tempfile::tempdir().unwrap();
        let lib = Library::open(temp.path()).unwrap();
        let key = generate_key().unwrap();
        lib.notes_unlock(&key).unwrap();
        assert_eq!(lib.notes_recovery_key().unwrap(), key, "no PIN yet");
        lib.notes_secret_set_pin("2468").unwrap();
        assert_eq!(lib.notes_recovery_key().unwrap(), key, "session open");
        lib.notes_secret_lock();
        assert!(matches!(lib.notes_recovery_key(), Err(Error::Message(PIN_REQUIRED_TEXT))));
        for _ in 0..5 {
            assert!(lib.notes_secret_unlock("0000").is_err());
        }
        // Locked out even with the right PIN, and a reopened library remembers it.
        assert!(matches!(lib.notes_secret_unlock("2468"), Err(Error::Text(_))));
        drop(lib);
        let lib = Library::open(temp.path()).unwrap();
        assert!(matches!(lib.notes_secret_unlock("2468"), Err(Error::Text(_))));
        // Resetting with the recovery key clears the counter.
        lib.notes_secret_reset_pin(&key, "1357").unwrap();
        lib.notes_secret_lock();
        lib.notes_secret_unlock("1357").unwrap();
        assert!(lib.notes_secret_touch());
        lib.notes_secret_lock();
        assert!(!lib.notes_secret_touch());
    }
}

#[cfg(test)]
mod mobile_interop {
    use super::*;
    #[test]
    fn v2_envelope_vector_from_shared_fixture() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../tests/fixtures/notes-v2/payload-examples.json");
        let file: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let vector = &file["envelope"];
        let key = unhex(vector["key"].as_str().unwrap()).unwrap();
        let envelope: Envelope = serde_json::from_value(vector["envelope"].clone()).unwrap();
        let content = open(&key, vector["id"].as_str().unwrap(), &envelope).unwrap();
        let name = vector["payloadExample"].as_str().unwrap();
        let example = file["examples"]
            .as_array()
            .unwrap()
            .iter()
            .find(|e| e["name"] == name)
            .unwrap();
        assert_eq!(content.to_value().unwrap(), example["payload"]);
        assert!(matches!(content, Stored::Typed(_)));
    }
    #[test]
    fn android_notes_envelope_compatibility() {
        let key=unhex("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f").unwrap();
        let content=open_value(&key,"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",&Envelope {version:1,nonce:"000102030405060708090a0b".into(),ciphertext:"3c20a272b189a739b7637c222502d2c5a1faa5569f1f265e0245b5c6f1f08092eaba06171f55fe05c88653cff8ee46568b3d42b73cb7cfa95abb087d7d8f909a9558e440b5b04a127978880d9dea6f9c5dee88165459715acdcfa8ee54d2ccfdaf992d83c000bc38a43e0c827a4303023c0e7d8bb1f9d4ebd5dbca9f3a7604db".into()}).unwrap();
        assert_eq!(content["title"],"메모");assert_eq!(content["body"],"PC와 모바일");
    }
}

#[cfg(test)]
mod ledger_tests {
    use super::*;
    use serde_json::json;

    fn save(lib: &Library, key: &[u8], draft: Value) -> Result<Note> {
        lib.notes_save_with_key(key, serde_json::from_value(draft).unwrap())
    }
    fn entry(id: &str, date: &str, amount: u64) -> Value {
        json!({"id":id,"date":date,"amount":amount,"name":id,"createdAt":format!("{date}T00:00:00Z")})
    }
    fn month_draft(id: &str, revision: i64, entries: Value) -> Value {
        json!({"id":id,"expectedRevision":revision,"type":"ledger-month","title":"가계부 2026년 9월","ledger":"11111111-2222-4333-8444-555555555555","month":"2026-09","income":null,"entries":entries,"archived":true})
    }

    #[test]
    fn the_same_month_created_offline_on_two_devices_becomes_one_note() {
        let temp = tempfile::tempdir().unwrap();
        let lib = Library::open(temp.path()).unwrap();
        let key = [41; 32];
        let id = ledger::month_id(&key, "11111111-2222-4333-8444-555555555555", "2026-09");
        // This device adds an entry to a month it has never synced (no merge base).
        save(&lib, &key, month_draft(&id, 0, json!([entry("mine", "2026-09-25", 9500)]))).unwrap();
        // The other device created and pushed the same month first.
        let mut value = month_draft(&id, 0, json!([entry("theirs", "2026-09-24", 31800)]));
        for (k, v) in [("body", json!("")), ("pinned", json!(false)), ("deleted", json!(false)), ("createdAt", json!("2026-09-24T00:00:00Z")), ("updatedAt", json!("2026-09-24T00:00:00Z"))] {
            value[k] = v;
        }
        value.as_object_mut().unwrap().retain(|k, _| k != "id" && k != "expectedRevision");
        let mut theirs: Content = serde_json::from_value(value).unwrap();
        theirs.normalize();
        let remote = Remote { id: id.clone(), revision: 1, operation_id: uuid::Uuid::new_v4().to_string(), sequence: 1, payload: seal(&key, &id, &theirs).unwrap() };
        lib.notes_merge(&key, &remote).unwrap();
        let state = lib.notes_state_with_key(&key).unwrap();
        assert_eq!(state.notes.len(), 1, "no conflict copy");
        let note = &state.notes[0];
        assert!(note.pending && !note.conflict_copy && !note.read_only && note.content.archived);
        let ids: Vec<&str> = note.content.entries.as_ref().unwrap().iter().map(|e| e.id.as_str()).collect();
        assert_eq!(ids, ["mine", "theirs"]);
        assert_eq!(note.content.body, "# 2026년 9월 기록 (2건)\n- 09-25 ₩9,500 mine\n- 09-24 ₩31,800 theirs");
    }

    #[test]
    fn ledger_saves_keep_unknown_keys_and_refuse_immutable_changes() {
        let temp = tempfile::tempdir().unwrap();
        let lib = Library::open(temp.path()).unwrap();
        let key = [42; 32];
        let id = uuid::Uuid::new_v4().to_string();
        let r = json!({"id":"r","name":"넷플릭스","amount":17000,"every":1,"unit":"month","start":"2026-01-03","trial":false,"until":null,"memo":"","order":"V"});
        let created = save(&lib, &key, json!({"id":id,"expectedRevision":0,"type":"ledger","title":"가계부","pinned":true,"income":2300000,"recurring":[r],"planned":[]})).unwrap();
        assert_eq!(created.content.body, "# 가계부\n월 수입 ₩2,300,000\n\n## 고정·구독\n- 넷플릭스 ₩17,000 · 매월 · 2026-01-03부터");
        assert_eq!(created.content.schema, Some(2));
        // A newer client added a key to the charge; this client's edit keeps it.
        let mut stored = created.content.clone();
        stored.recurring.as_mut().unwrap()[0].extra.insert("color".into(), json!("red"));
        let sealed = serde_json::to_string(&seal(&key, &id, &stored).unwrap()).unwrap();
        lib.connection().unwrap().execute("UPDATE notes SET payload=?2 WHERE id=?1", params![id, sealed]).unwrap();
        let edited = save(&lib, &key, json!({"id":id,"expectedRevision":1,"income":null,"recurring":[{"id":"r","name":"넷플릭스","amount":13500,"every":1,"unit":"month","start":"2026-01-03","trial":false,"until":null,"memo":"","order":"V"}]})).unwrap();
        assert!(edited.content.recurring.as_ref().unwrap()[0].extra.is_empty(), "unknown keys stay in the backend");
        assert_eq!(edited.content.income, Some(None));
        let payload: String = lib.connection().unwrap().query_row("SELECT payload FROM notes WHERE id=?", [&id], |r| r.get(0)).unwrap();
        let value = open_value(&key, &id, &serde_json::from_str(&payload).unwrap()).unwrap();
        assert_eq!(value["recurring"][0]["color"], json!("red"));
        assert_eq!(value["recurring"][0]["amount"], json!(13500));
        assert_eq!(value["income"], Value::Null);
        assert!(value.get("incomeDay").is_none(), "no income day key until one is set");
        // 들어오는 날: set, refused out of range, cleared (the key disappears again).
        let day = save(&lib, &key, json!({"id":id,"expectedRevision":2,"income":2300000,"incomeDay":25})).unwrap();
        assert_eq!(day.content.income_day, Some(25));
        assert!(day.content.body.starts_with("# 가계부\n월 수입 ₩2,300,000 · 매달 25일"));
        assert!(save(&lib, &key, json!({"id":id,"expectedRevision":3,"incomeDay":32})).is_err());
        assert!(save(&lib, &key, json!({"id":id,"expectedRevision":3,"incomeDay":0})).is_err());
        let kept = save(&lib, &key, json!({"id":id,"expectedRevision":3,"title":"생활비"})).unwrap();
        assert_eq!(kept.content.income_day, Some(25), "absent keeps the day");
        let cleared = save(&lib, &key, json!({"id":id,"expectedRevision":4,"income":null,"incomeDay":null})).unwrap();
        assert_eq!(cleared.content.income_day, None);
        let payload: String = lib.connection().unwrap().query_row("SELECT payload FROM notes WHERE id=?", [&id], |r| r.get(0)).unwrap();
        let value = open_value(&key, &id, &serde_json::from_str(&payload).unwrap()).unwrap();
        assert!(value.get("incomeDay").is_none());
        // A ledger cannot become another type, and a month's ledger and month are fixed.
        assert!(save(&lib, &key, json!({"id":id,"expectedRevision":5,"type":"text","body":"x"})).is_err());
        // A month note is written only under its derived id and with a canonical ledger id.
        assert!(save(&lib, &key, month_draft(&uuid::Uuid::new_v4().to_string(), 0, json!([]))).is_err());
        let month = ledger::month_id(&key, "11111111-2222-4333-8444-555555555555", "2026-09");
        save(&lib, &key, month_draft(&month, 0, json!([]))).unwrap();
        let mut moved = month_draft(&month, 1, json!([]));
        moved["month"] = json!("2026-10");
        assert!(save(&lib, &key, moved).is_err());
        assert!(save(&lib, &key, json!({"id":month,"expectedRevision":1,"entries":[entry("big", "2026-09-01", 1_000_000_000_000)]})).is_err());
        // Pin and trash still work on a month note; it stays archived.
        let pinned = save(&lib, &key, json!({"id":month,"expectedRevision":1,"archived":false,"deleted":true})).unwrap();
        assert!(pinned.content.deleted && pinned.content.archived);
    }
}
