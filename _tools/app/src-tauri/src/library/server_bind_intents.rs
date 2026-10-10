//! Durable provider bind requests. Resolve settings before taking the library lock.
use rusqlite::{params, OptionalExtension};
use serde::Serialize;
use serde_json::{json, Value};

use super::{error::LibraryError, Library};

#[derive(Debug, Serialize)]
pub struct ServerBindResult {
    pub outcome: String,
    pub message: Option<String>,
}

impl Library {
    pub(super) fn server_bind_intent_key(&self, work: &str, provider: &str) -> Result<String, LibraryError> {
        let config = self.cloud_sync_config()?;
        // Preserve Kakao's already-persisted keys across upgrades. The prefix scopes
        // provider; endpoint and work scope the remainder for both providers.
        let prefix = match provider {
            "kakao" => "serverKakaoIntent",
            "mangadex" => "serverMangaDexIntent",
            _ => return Err(LibraryError::InvalidCloudResponse),
        };
        Ok(format!("{prefix}:{}:{work}", config.api_base_url.as_deref().unwrap_or_default()))
    }

    pub(super) fn has_server_bind_intent(&self, work: &str, provider: &str) -> Result<bool, LibraryError> {
        let key = self.server_bind_intent_key(work, provider)?;
        Ok(self.connection()?.query_row("SELECT EXISTS(SELECT 1 FROM notes_state WHERE key=?1)",
            [key], |row| row.get(0))?)
    }

    pub(super) fn server_bind_intent_choice(&self, work: &str, provider: &str) -> Result<Option<Value>, LibraryError> {
        let key = self.server_bind_intent_key(work, provider)?;
        let raw: Option<String> = self.connection()?.query_row("SELECT value FROM notes_state WHERE key=?1", [key], |r| r.get(0)).optional()?;
        raw.map(|raw| serde_json::from_str::<Value>(&raw).map(|body| body["choice"].clone())
            .map_err(|_| LibraryError::InvalidCloudResponse)).transpose()
    }

    pub(super) fn apply_server_bind_intent_with(&self, work: &str, provider: &str, choice: Value,
        same_choice: &dyn Fn(&Value, &Value) -> bool,
        post: &dyn Fn(&Value) -> Result<Value, LibraryError>,
        pull: &dyn Fn() -> Result<(), LibraryError>) -> Result<ServerBindResult, LibraryError> {
        let key = self.server_bind_intent_key(work, provider)?;
        let body = {
            let mut db = self.connection()?;
            let tx = db.transaction()?;
            let existing: Option<String> = tx.query_row("SELECT value FROM notes_state WHERE key=?1", [&key], |r| r.get(0)).optional()?;
            let existing = existing.map(|raw| serde_json::from_str::<Value>(&raw).map_err(|_| LibraryError::InvalidCloudResponse)).transpose()?;
            let body = match existing {
                Some(body) if same_choice(&body["choice"], &choice) => body,
                _ => {
                    let external: Option<String> = tx.query_row("SELECT external_id FROM collection_external_bindings WHERE collection_id=?1 AND provider=?2",
                        params![work, provider], |r| r.get(0)).optional()?;
                    json!({"version":1,"operationId":uuid::Uuid::new_v4().to_string(),"collectionId":work,
                        "provider":provider,"choice":choice,"expected":{"externalId":external}})
                }
            };
            tx.execute("INSERT INTO notes_state(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",params![key,body.to_string()])?;
            tx.commit()?;
            body
        };
        let reply = post(&body)?;
        if reply["detail"]["code"].is_string() {
            // Replay precedes readiness on the server. A coded refusal proves that
            // this ID was not accepted; an unknown transport outcome proves nothing.
            self.connection()?.execute("DELETE FROM notes_state WHERE key=?1 AND value=?2", params![key,body.to_string()])?;
            return Ok(ServerBindResult {outcome:"failed".into(), message:reply["detail"]["message"].as_str().map(str::to_owned)});
        }
        let row = &reply["request"];
        if reply["version"] != 1 || row["operationId"] != body["operationId"] || row["collectionId"] != body["collectionId"]
            || row["provider"] != provider || row["executor"] != "server" {
            return Err(LibraryError::InvalidCloudResponse);
        }
        let state = row["state"].as_str().ok_or(LibraryError::InvalidCloudResponse)?;
        if !matches!(state, "pending" | "applied" | "failed" | "superseded") { return Err(LibraryError::InvalidCloudResponse); }
        if state == "applied" { pull()?; }
        if state != "pending" { self.connection()?.execute("DELETE FROM notes_state WHERE key=?1 AND value=?2", params![key,body.to_string()])?; }
        Ok(ServerBindResult {outcome:state.into(), message:row["reason"]["message"].as_str().map(str::to_owned)})
    }
}
