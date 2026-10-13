//! Tiny picker display publication on the existing metadata lane.
//! notes_state holds the desired payload and an endpoint-scoped delivery checkpoint.
use crate::library::{error::LibraryError, home_publications::HomeTransport, Library};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

const DESIRED: &str = "pickerDisplay";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Display {
    classification_order_ids: Vec<String>,
    pinned_classification_ids: Vec<String>,
}

#[derive(Default, Serialize, Deserialize)]
struct Delivery {
    payload: Option<String>,
    retry_after: i64,
}

fn checkpoint(endpoint: &str) -> String {
    format!("pickerDisplayDelivery:{endpoint}")
}

fn load(db: &Connection, key: &str) -> Result<Option<String>, LibraryError> {
    Ok(db
        .query_row("SELECT value FROM notes_state WHERE key=?1", [key], |row| {
            row.get(0)
        })
        .optional()?)
}

fn save(db: &Connection, key: &str, value: &str) -> Result<(), LibraryError> {
    db.execute("INSERT INTO notes_state(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE value<>excluded.value", params![key, value])?;
    Ok(())
}

fn delivery(db: &Connection, endpoint: &str) -> Result<Delivery, LibraryError> {
    load(db, &checkpoint(endpoint))?
        .map(|raw| serde_json::from_str(&raw).map_err(|_| LibraryError::InvalidCloudResponse))
        .unwrap_or_else(|| Ok(Delivery::default()))
}

pub(crate) fn due(db: &Connection, endpoint: &str, now: i64) -> Result<bool, LibraryError> {
    let Some(desired) = load(db, DESIRED)? else {
        return Ok(false);
    };
    let sent = delivery(db, endpoint)?;
    Ok(sent.payload.as_deref() != Some(&desired) && sent.retry_after <= now)
}

impl Library {
    pub(crate) fn save_picker_display(
        &self,
        order: Vec<String>,
        pins: Vec<String>,
    ) -> Result<(), LibraryError> {
        for ids in [&order, &pins] {
            if ids.len() > 20_000
                || ids.iter().any(|id| {
                    id.is_empty()
                        || id.len() > 64
                        || !id
                            .bytes()
                            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
                })
            {
                return Err(LibraryError::InvalidCloudResponse);
            }
        }
        let unique = |ids: Vec<String>| {
            let mut seen = std::collections::HashSet::new();
            ids.into_iter()
                .filter(|id| seen.insert(id.clone()))
                .collect()
        };
        let body = Display {
            classification_order_ids: unique(order),
            pinned_classification_ids: unique(pins),
        };
        let value = serde_json::to_string(&body).map_err(|_| LibraryError::InvalidCloudResponse)?;
        let mut db = self.connection()?;
        let first = load(&db, DESIRED)?.is_none();
        let tx = db.transaction()?;
        save(&tx, DESIRED, &value)?;
        if first {
            // Upgrade once from the older alphabetical character projection, even if
            // the user has not moved a character since installing this PC build.
            tx.execute("UPDATE mobile_publication_state SET generation=generation+1,first_dirty=CASE WHEN generation=published_generation THEN unixepoch() ELSE first_dirty END,last_dirty=unixepoch() WHERE kind='characters'", [])?;
        }
        tx.commit()?;
        drop(db);
        if first {
            self.publication_inputs.signal(&[1]);
        }
        crate::cloud::status_watch::wake_publications();
        Ok(())
    }

    pub(crate) fn publish_due_picker_display(&self, endpoint: &str) -> Result<(), LibraryError> {
        self.ensure_send_to(endpoint)?;
        self.publish_due_picker_display_with(endpoint, &self.cloud_client(endpoint)?)
    }

    fn publish_due_picker_display_with(
        &self,
        endpoint: &str,
        client: &dyn HomeTransport,
    ) -> Result<(), LibraryError> {
        let db = self.connection()?;
        let now = chrono::Utc::now().timestamp();
        if !due(&db, endpoint, now)? {
            return Ok(());
        }
        let payload = load(&db, DESIRED)?.ok_or(LibraryError::InvalidCloudResponse)?;
        let mut sent = delivery(&db, endpoint)?;
        sent.retry_after = now + 60;
        save(
            &db,
            &checkpoint(endpoint),
            &serde_json::to_string(&sent).map_err(|_| LibraryError::InvalidCloudResponse)?,
        )?;
        drop(db);
        let broker = crate::library::credential_broker::broker();
        let target = crate::library::credential::CredentialTarget::CloudPublisher;
        let token = broker.credential(target)?;
        let body =
            serde_json::from_str(&payload).map_err(|_| LibraryError::InvalidCloudResponse)?;
        // This PUT is publisher-only; the ordinary CloudApi credential is a reader.
        if let Err(error) = client.publish("/v1/picker/display", Some(&body), token.expose()) {
            broker.invalidate_on_auth_rejection(target, &error);
            return Err(error);
        }
        // A change during HTTP remains due: acknowledge only the payload actually sent.
        sent.payload = Some(payload);
        sent.retry_after = 0;
        save(
            &*self.connection()?,
            &checkpoint(endpoint),
            &serde_json::to_string(&sent).map_err(|_| LibraryError::InvalidCloudResponse)?,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picker_display_publication_uses_publisher_and_acknowledges_only_sent_payload() {
        use crate::library::credential;
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let endpoint = "http://127.0.0.1";
        library
            .save_picker_display(vec!["folder".into()], vec![])
            .unwrap();
        credential::set_cloud_api_token_os("fixture-reader").unwrap();
        credential::set_cloud_publisher_token_os("fixture-publisher").unwrap();
        let (client, requests) = crate::cloud::client::CloudClient::home_test_client(vec![
            serde_json::json!({"ok":true}),
        ]);
        library
            .publish_due_picker_display_with(endpoint, &client)
            .unwrap();
        library
            .publish_due_picker_display_with(endpoint, &client)
            .unwrap();
        let requests = requests.lock().unwrap();
        assert_eq!(requests.len(), 1);
        let request = String::from_utf8_lossy(&requests[0]);
        assert!(request.starts_with("PUT /v1/picker/display "));
        assert!(request.contains("Bearer fixture-publisher"));
        assert!(!request.contains("fixture-reader"));
        let db = library.connection().unwrap();
        assert_eq!(delivery(&db, endpoint).unwrap().retry_after, 0);
        assert!(!due(&db, endpoint, chrono::Utc::now().timestamp()).unwrap());
        credential::delete_cloud_api_token_os().unwrap();
        credential::delete_cloud_publisher_token_os().unwrap();
    }

    #[test]
    fn picker_display_publication_without_publisher_preserves_failure_and_retry() {
        use crate::library::credential;
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let endpoint = "http://127.0.0.1";
        library
            .save_picker_display(vec!["folder".into()], vec![])
            .unwrap();
        credential::set_cloud_api_token_os("fixture-reader").unwrap();
        let (client, requests) = crate::cloud::client::CloudClient::home_test_client(vec![]);
        assert!(matches!(
            library.publish_due_picker_display_with(endpoint, &client),
            Err(LibraryError::CloudCredentialNotConfigured)
        ));
        let db = library.connection().unwrap();
        let sent = delivery(&db, endpoint).unwrap();
        assert!(sent.payload.is_none());
        assert!(sent.retry_after > chrono::Utc::now().timestamp());
        assert!(!due(&db, endpoint, sent.retry_after - 1).unwrap());
        assert!(due(&db, endpoint, sent.retry_after).unwrap());
        assert!(requests.lock().unwrap().is_empty());
        credential::delete_cloud_api_token_os().unwrap();
    }

    #[test]
    fn picker_display_payload_and_change_detection() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let endpoint = "https://fixture.invalid";
        let db = library.connection().unwrap();
        assert!(!due(&db, endpoint, 100).unwrap());
        let character_generation: i64 = db
            .query_row(
                "SELECT generation FROM mobile_publication_state WHERE kind='characters'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        drop(db);
        library
            .save_picker_display(vec!["b".into(), "a".into()], vec!["a".into()])
            .unwrap();
        let db = library.connection().unwrap();
        let value = load(&db, DESIRED).unwrap().unwrap();
        let after_first: i64 = db
            .query_row(
                "SELECT generation FROM mobile_publication_state WHERE kind='characters'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(after_first, character_generation + 1);
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&value).unwrap(),
            serde_json::json!({"classificationOrderIds":["b","a"],"pinnedClassificationIds":["a"]})
        );
        assert!(due(&db, endpoint, 100).unwrap());
        save(
            &db,
            &checkpoint(endpoint),
            &serde_json::to_string(&Delivery {
                payload: Some(value),
                retry_after: 0,
            })
            .unwrap(),
        )
        .unwrap();
        drop(db);
        library
            .save_picker_display(vec!["b".into(), "a".into()], vec!["a".into()])
            .unwrap();
        let db = library.connection().unwrap();
        assert!(!due(&db, endpoint, 100).unwrap());
        let after_same: i64 = db
            .query_row(
                "SELECT generation FROM mobile_publication_state WHERE kind='characters'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(after_same, after_first);
        assert!(due(&db, "https://another.invalid", 100).unwrap());
        drop(db);
        library
            .save_picker_display(vec!["a".into(), "b".into()], vec![])
            .unwrap();
        let db = library.connection().unwrap();
        assert!(due(&db, endpoint, 100).unwrap());
        save(
            &db,
            &checkpoint(endpoint),
            &serde_json::to_string(&Delivery {
                payload: None,
                retry_after: 160,
            })
            .unwrap(),
        )
        .unwrap();
        assert!(!due(&db, endpoint, 159).unwrap());
        assert!(due(&db, endpoint, 160).unwrap());
    }
}
