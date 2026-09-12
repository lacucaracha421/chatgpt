//! Encrypted local-first notes. Plaintext never crosses the cloud boundary.
use super::{credential, Library};
use ring::{
    aead,
    rand::{SecureRandom, SystemRandom},
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
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
}
const LOCKED: Error = Error::Message("메모 암호화 키를 등록해 주세요.");
const INVALID: Error = Error::Message("암호화 키가 맞지 않거나 메모가 손상됐습니다.");

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Content {
    pub title: String,
    pub body: String,
    pub pinned: bool,
    pub deleted: bool,
    pub created_at: String,
    pub updated_at: String,
}
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
    pub conflict: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct State {
    pub unlocked: bool,
    pub notes: Vec<Note>,
    pub last_synced_at: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Draft {
    pub id: String,
    pub title: String,
    pub body: String,
    pub pinned: bool,
    pub deleted: bool,
    pub expected_revision: i64,
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
fn seal(key: &[u8], id: &str, content: &Content) -> Result<Envelope> {
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
fn open(key: &[u8], id: &str, envelope: &Envelope) -> Result<Content> {
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
    let content: Content = serde_json::from_slice(plain)?;
    if content.title.chars().count() > 200 || content.body.len() > 128 * 1024 {
        return Err(INVALID);
    }
    Ok(content)
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
                open(&key, &id, &serde_json::from_str(&payload)?)?;
            }
            // A key cannot silently replace another library's encryption identity.
            set_state(&db, "vault", &vault(&key))?;
        }
        credential::set_notes_key(&self.notes_target(), &key)?;
        self.notes_state()
    }
    pub fn notes_state(&self) -> Result<State> {
        if credential::notes_key(&self.notes_target())?.is_none() {
            return Ok(State {
                unlocked: false,
                notes: vec![],
                last_synced_at: None,
            });
        }
        let key = self.notes_key()?;
        self.notes_state_with_key(&key)
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
            let content = open(&key, &item.id, &item.payload)?;
            let id = uuid::Uuid::new_v4().to_string();
            let payload = serde_json::to_string(&seal(&key, &id, &content)?)?;
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
        let mut stmt =
            db.prepare("SELECT id,payload,local_revision,dirty,conflict IS NOT NULL FROM notes")?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, bool>(3)?,
                r.get::<_, bool>(4)?,
            ))
        })?;
        let mut notes = vec![];
        for row in rows {
            let (id, payload, local_revision, pending, conflict) = row?;
            notes.push(Note {
                id: id.clone(),
                content: open(&key, &id, &serde_json::from_str(&payload)?)?,
                local_revision,
                pending,
                conflict,
            });
        }
        Ok(State {
            unlocked: true,
            notes,
            last_synced_at: state_value(&db, "lastSyncedAt")?,
        })
    }
    pub fn notes_save(&self, draft: Draft) -> Result<Note> {
        let key = self.notes_key()?;
        self.notes_save_with_key(&key, draft)
    }
    fn notes_save_with_key(&self, key: &[u8], draft: Draft) -> Result<Note> {
        uuid::Uuid::parse_str(&draft.id).map_err(|_| INVALID)?;
        if draft.title.chars().count() > 200 || draft.body.len() > 128 * 1024 {
            return Err(Error::Message(
                "제목은 200자, 본문은 128 KiB까지 저장할 수 있습니다.",
            ));
        }
        let db = self.connection()?;
        let old: Option<(String, i64, bool)> = db
            .query_row(
                "SELECT payload,local_revision,conflict IS NOT NULL FROM notes WHERE id=?",
                [&draft.id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        if old.as_ref().map(|v| v.1).unwrap_or(0) != draft.expected_revision {
            return Err(Error::Message(
                "메모가 변경됐습니다. 작성 내용을 복사한 뒤 다시 불러와 주세요.",
            ));
        }
        let now = chrono::Utc::now().to_rfc3339();
        let created = match &old {
            Some((payload, _, _)) => {
                open(&key, &draft.id, &serde_json::from_str(payload)?)?.created_at
            }
            None => now.clone(),
        };
        let content = Content {
            title: draft.title,
            body: draft.body,
            pinned: draft.pinned,
            deleted: draft.deleted,
            created_at: created,
            updated_at: now,
        };
        let payload = serde_json::to_string(&seal(&key, &draft.id, &content)?)?;
        db.execute("INSERT INTO notes(id,payload,operation_id) VALUES(?1,?2,?3) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,operation_id=excluded.operation_id,local_revision=notes.local_revision+1,dirty=1",params![draft.id,payload,uuid::Uuid::new_v4().to_string()])?;
        Ok(Note {
            id: draft.id,
            content,
            local_revision: draft.expected_revision + 1,
            pending: true,
            conflict: old.map(|v| v.2).unwrap_or(false),
        })
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
            open(&key, id, &remote.payload)?;
            if keep_copy {
                let copy_id = uuid::Uuid::new_v4().to_string();
                let mut content = open(&key, id, &serde_json::from_str(&local)?)?;
                content.title = format!(
                    "{} (복사본)",
                    content.title.chars().take(192).collect::<String>()
                );
                content.deleted = false;
                let payload = serde_json::to_string(&seal(&key, &copy_id, &content)?)?;
                tx.execute(
                    "INSERT INTO notes(id,payload,operation_id) VALUES(?1,?2,?3)",
                    params![copy_id, payload, uuid::Uuid::new_v4().to_string()],
                )?;
            }
            tx.execute("UPDATE notes SET payload=?2,remote_revision=?3,operation_id=?4,local_revision=local_revision+1,dirty=0,conflict=NULL WHERE id=?1",params![id,serde_json::to_string(&remote.payload)?,remote.revision,remote.operation_id])?;
            tx.commit()?;
        }
        self.notes_state_with_key(key)
    }
    fn notes_merge(&self, key: &[u8], remote: &Remote) -> Result<()> {
        uuid::Uuid::parse_str(&remote.id).map_err(|_| INVALID)?;
        if remote.revision < 1 {
            return Err(INVALID);
        }
        open(key, &remote.id, &remote.payload)?;
        let db = self.connection()?;
        let old: Option<(i64, bool, String)> = db
            .query_row(
                "SELECT remote_revision,dirty,operation_id FROM notes WHERE id=?",
                [&remote.id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        if let Some((revision, dirty, operation)) = old {
            if remote.revision <= revision {
                return Ok(());
            }
            if dirty && operation != remote.operation_id {
                db.execute(
                    "UPDATE notes SET conflict=?2 WHERE id=?1",
                    params![remote.id, serde_json::to_string(remote)?],
                )?;
                return Ok(());
            }
        }
        db.execute("INSERT INTO notes(id,payload,remote_revision,operation_id,dirty) VALUES(?1,?2,?3,?4,0) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,remote_revision=excluded.remote_revision,operation_id=excluded.operation_id,local_revision=notes.local_revision+1,dirty=0,conflict=NULL",params![remote.id,serde_json::to_string(&remote.payload)?,remote.revision,remote.operation_id])?;
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
            open(&key, &id, &remote.payload)?;
            if remote.id != id
                || remote.operation_id != operation
                || remote.revision != revision + 1
                || serde_json::to_string(&remote.payload)? != serde_json::to_string(&payload)?
            {
                return Err(INVALID);
            }
            let db = self.connection()?;
            // A newer edit made during the HTTP request remains dirty and never loses its text.
            db.execute("UPDATE notes SET remote_revision=?2,dirty=CASE WHEN local_revision=?3 THEN 0 ELSE 1 END WHERE id=?1 AND remote_revision=?4",params![id,remote.revision,local_revision,revision])?;
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
            deleted: false,
            created_at: "now".into(),
            updated_at: "now".into(),
        };
        let sealed = seal(&key, "note-a", &content).unwrap();
        assert_eq!(open(&key, "note-a", &sealed).unwrap().body, "본문");
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
            title: title.into(),
            body: "private body".into(),
            pinned: false,
            deleted: false,
            expected_revision: revision,
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
        assert!(lib
            .notes_save_with_key(&key, draft(&id, "stale", 0))
            .is_err());
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
        let state = lib.notes_state_with_key(&key).unwrap();
        assert!(state.notes[0].conflict);
        assert_eq!(state.notes[0].content.title, "private title");
        let mut deleted = draft(&id, "private title", 1);
        deleted.deleted = true;
        lib.notes_save_with_key(&key, deleted).unwrap();
        assert!(
            lib.notes_state_with_key(&key).unwrap().notes[0]
                .content
                .deleted
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
        lib.notes_merge(&key, &remote).unwrap();
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
