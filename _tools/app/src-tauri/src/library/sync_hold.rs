//! Machine-local outbound fence. Release is persisted, but never unlatches this process.
use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::{Arc, LazyLock, Mutex, RwLock, RwLockReadGuard},
};

use super::{error::LibraryError, machine_settings, Library};

#[derive(Debug)]
pub(crate) struct Gate(RwLock<bool>);

impl Default for Gate {
    fn default() -> Self {
        Self::new(true)
    }
}

impl Gate {
    pub(crate) fn new(held: bool) -> Self {
        Self(RwLock::new(held))
    }
    pub(crate) fn held(&self) -> bool {
        *self
            .0
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
    pub(crate) fn permit(&self) -> Result<RwLockReadGuard<'_, bool>, LibraryError> {
        let guard = self
            .0
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if *guard {
            Err(LibraryError::CloudSyncHeld)
        } else {
            Ok(guard)
        }
    }
    fn hold(&self) {
        *self
            .0
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = true;
    }
}

type Key = (PathBuf, String, String);
#[derive(Debug, Default)]
pub(crate) struct Session(Mutex<BTreeMap<Key, Arc<Gate>>>);
static SESSION: LazyLock<Arc<Session>> = LazyLock::new(|| Arc::new(Session::default()));

pub(crate) fn process_session() -> Arc<Session> {
    SESSION.clone()
}

impl Session {
    pub(crate) fn gate(&self, path: PathBuf, library: String, endpoint: String) -> Arc<Gate> {
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .entry((path.clone(), library.clone(), endpoint.clone()))
            .or_insert_with(|| {
                Arc::new(Gate::new(machine_settings::receive_only_hold(
                    &path, &library, &endpoint,
                )))
            })
            .clone()
    }
}

pub(crate) fn endpoint_key(endpoint: &str) -> Result<String, LibraryError> {
    let url = url::Url::parse(endpoint.trim()).map_err(|_| LibraryError::InvalidCloudSyncConfig)?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(LibraryError::InvalidCloudSyncConfig);
    }
    // Both Cloud and Exchange join absolute /v1 paths, so path/query changes do
    // not select another server and must not evade this server's hold.
    Ok(url.origin().ascii_serialization())
}

/// Known entries waiting behind a missing prerequisite in one received log window.
#[derive(Debug, Default, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TabletWait {
    pub count: usize,
    pub target_ids: Vec<String>,
}

pub(super) fn missing_targets_on(
    db: &rusqlite::Connection,
    targets: &[(&str, &str)],
) -> Result<Vec<String>, LibraryError> {
    let mut missing = Vec::new();
    for (table, id) in targets {
        let exists: bool = db.query_row(
            &format!("SELECT EXISTS(SELECT 1 FROM {table} WHERE id=?1)"),
            [id],
            |row| row.get(0),
        )?;
        if !exists {
            missing.push((*id).to_owned());
        }
    }
    Ok(missing)
}

pub(super) fn record_tablet_wait_on(
    db: &rusqlite::Connection,
    endpoint: &str,
    log: &str,
    wait: &TabletWait,
) -> Result<(), LibraryError> {
    let key = format!("syncHoldWait:{}:{log}", endpoint_key(endpoint)?);
    if wait.count == 0 {
        db.execute("DELETE FROM notes_state WHERE key=?1", [&key])?;
    } else {
        let value = serde_json::to_string(wait).map_err(|_| LibraryError::InvalidCloudResponse)?;
        db.execute("INSERT INTO notes_state(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE value<>excluded.value",
            rusqlite::params![key, value])?;
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub held: bool,
    pub release_after_restart: bool,
    pub tablet_wait: TabletWait,
}

impl Library {
    #[cfg(test)]
    pub(crate) fn simulate_sync_hold_restart(&mut self) {
        self.sync_hold_session = Arc::new(Session::default());
    }
    pub(crate) fn sync_gate(&self, endpoint: &str) -> Result<Arc<Gate>, LibraryError> {
        #[cfg(test)]
        if self.machine_settings_path().is_none() {
            endpoint_key(endpoint)?;
            return Ok(Arc::new(Gate::new(false)));
        }
        self.sync_gate_required(endpoint)
    }
    fn sync_gate_required(&self, endpoint: &str) -> Result<Arc<Gate>, LibraryError> {
        let endpoint = endpoint_key(endpoint)?;
        match self.machine_settings_path() {
            Some(path) => Ok(self
                .sync_hold_session
                .gate(path, self.library_id()?, endpoint)),
            // Standalone fixtures have no machine settings; production must attach them before sends.
            None => Ok(Arc::new(Gate::default())),
        }
    }
    pub(crate) fn sync_held(&self, endpoint: &str) -> bool {
        self.sync_gate(endpoint).map_or(true, |gate| gate.held())
    }
    pub(crate) fn ensure_send_to(&self, endpoint: &str) -> Result<(), LibraryError> {
        if self.sync_held(endpoint) {
            Err(LibraryError::CloudSyncHeld)
        } else {
            Ok(())
        }
    }
    pub(crate) fn ensure_cloud_send(&self) -> Result<(), LibraryError> {
        let Some(endpoint) = self.cloud_sync_config()?.api_base_url else {
            return Ok(());
        };
        if self.sync_held(&endpoint) {
            Err(LibraryError::CloudSyncHeld)
        } else {
            Ok(())
        }
    }
    pub(crate) fn cloud_client(
        &self,
        endpoint: &str,
    ) -> Result<crate::cloud::client::CloudClient, LibraryError> {
        crate::cloud::client::CloudClient::with_gate(endpoint, self.sync_gate(endpoint)?)
    }
    pub fn cloud_sync_hold(&self, endpoint: &str) -> Result<Status, LibraryError> {
        let endpoint = endpoint_key(endpoint)?;
        let gate = self.sync_gate(&endpoint)?;
        let requested = self.machine_settings_path().map_or(true, |path| {
            machine_settings::receive_only_hold(
                &path,
                &self.library_id().unwrap_or_default(),
                &endpoint,
            )
        });
        Ok(Status {
            held: gate.held(),
            release_after_restart: gate.held() && !requested,
            tablet_wait: if gate.held() {
                self.tablet_wait(&endpoint)?
            } else {
                TabletWait::default()
            },
        })
    }
    fn tablet_wait(&self, endpoint: &str) -> Result<TabletWait, LibraryError> {
        let db = self.connection()?;
        let mut total = TabletWait::default();
        for log in [
            "personalEdits",
            "characterExclusions",
            "characterReview",
            "similarityReview",
        ] {
            use rusqlite::OptionalExtension;
            let value: Option<String> = db
                .query_row(
                    "SELECT value FROM notes_state WHERE key=?1",
                    [format!("syncHoldWait:{endpoint}:{log}")],
                    |row| row.get(0),
                )
                .optional()?;
            if let Some(value) = value {
                let wait: TabletWait =
                    serde_json::from_str(&value).map_err(|_| LibraryError::InvalidCloudResponse)?;
                total.count += wait.count;
                total.target_ids.extend(wait.target_ids);
            }
        }
        total.target_ids.sort();
        total.target_ids.dedup();
        Ok(total)
    }
    pub fn set_cloud_sync_hold(&self, endpoint: &str, held: bool) -> Result<Status, LibraryError> {
        let endpoint = endpoint_key(endpoint)?;
        let path = self
            .machine_settings_path()
            .ok_or(LibraryError::CloudSyncHeld)?;
        let gate = self.sync_gate(&endpoint)?;
        // Drain already-started requests before confirming the hold. Failed persistence stays held.
        if held {
            gate.hold();
        }
        machine_settings::set_receive_only_hold(&path, &self.library_id()?, &endpoint, held)?;
        self.cloud_sync_hold(&endpoint)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn production_library_without_machine_settings_is_held() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let gate = library
            .sync_gate_required("https://fixture.invalid")
            .unwrap();
        assert!(gate.held());
        assert!(matches!(gate.permit(), Err(LibraryError::CloudSyncHeld)));
    }
    #[test]
    fn equivalent_transport_endpoints_share_the_hold() {
        assert_eq!(
            endpoint_key("https://CLOUD.invalid:443/v1?unused=1").unwrap(),
            endpoint_key("https://cloud.invalid/").unwrap()
        );
        assert_ne!(
            endpoint_key("http://cloud.invalid:8080").unwrap(),
            endpoint_key("http://cloud.invalid:8081").unwrap()
        );
    }
    #[test]
    fn hold_survives_reopen_and_release_requires_a_new_session() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("machine.json");
        let session = Session::default();
        let endpoint = "https://cloud.invalid".to_owned();
        machine_settings::set_receive_only_hold(&path, "a", &endpoint, true).unwrap();
        let gate = session.gate(path.clone(), "a".into(), endpoint.clone());
        assert!(gate.held());
        assert!(matches!(gate.permit(), Err(LibraryError::CloudSyncHeld)));
        machine_settings::set_receive_only_hold(&path, "a", &endpoint, false).unwrap();
        assert!(session
            .gate(path.clone(), "a".into(), endpoint.clone())
            .held());
        assert!(!Session::default().gate(path, "a".into(), endpoint).held());
    }
    #[test]
    fn persistence_is_isolated_and_invalid_settings_fail_closed() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("machine.json");
        machine_settings::set_receive_only_hold(&path, "a", "one", true).unwrap();
        assert!(machine_settings::receive_only_hold(&path, "a", "one"));
        assert!(!machine_settings::receive_only_hold(&path, "b", "one"));
        assert!(!machine_settings::receive_only_hold(&path, "a", "two"));
        for bytes in ["invalid", r#"{"receiveOnlyHolds":{"a":{"one":"false"}}}"#] {
            std::fs::write(&path, bytes).unwrap();
            assert!(machine_settings::receive_only_hold(&path, "a", "one"));
            assert!(machine_settings::set_receive_only_hold(&path, "a", "one", false).is_err());
            assert_eq!(std::fs::read_to_string(&path).unwrap(), bytes);
        }
        assert!(machine_settings::receive_only_hold(temp.path(), "a", "one"));
    }
}
