//! Personal Collection edits (my rating, Showcase membership, memo) accepted by the mobile
//! server while the PC was off.
//!
//! The PC owns every Collection. The server accepts a mobile edit, reflects it in what
//! mobile reads and appends it to an ordered log. This module pulls that log and applies
//! each entry locally with a targeted UPDATE of exactly one field, then the ordinary
//! publication (0074 dirty triggers) republishes the Collection. Mirrors the Character
//! exclusion channel (`character_exclusions.rs`, migration 0089).
//!
//! * Server-accepted order wins: an entry overwrites the PC value of that field, including
//!   an unpublished PC edit of the same field (user decision, 2026-09-24).
//! * A Collection this PC deleted, or an AV/hidden legacy one (never published), gets a
//!   `skipped` receipt and the cursor still advances: PC deletion wins.
//! * Each page is applied in one transaction that re-reads and advances the durable
//!   cursor and writes a receipt per consumed entry, so a replay is a no-op and a stale
//!   page can never rewind the cursor.
//! * A malformed entry, a gap, or a receipt conflict fails the whole page closed.
use std::sync::OnceLock;

use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;

use super::{error::LibraryError, Library};
use crate::cloud::client::{CloudClient, CollectionsStatus};
use crate::library::credential;

/// The server bounds this to 1..=100.
const PAGE_LIMIT: i64 = 100;
/// Pages one pass may apply; the durable cursor lets a backlog drain across passes.
const MAX_PAGES: usize = 10;
/// The server's cursor bound (JavaScript's exact-integer maximum).
const MAX_CURSOR: i64 = 9_007_199_254_740_991;

/// One accepted edit from the server's ordered log.
#[derive(Debug, Clone, Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PersonalEditEntry {
    pub sequence: i64,
    pub operation_id: String,
    pub collection_id: String,
    pub field: String,
    pub value: serde_json::Value,
    pub previous: serde_json::Value,
    pub created_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PersonalEditPage {
    pub version: u8,
    pub library_id: String,
    pub after: i64,
    pub next_cursor: i64,
    pub has_more: bool,
    pub items: Vec<PersonalEditEntry>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct PageOutcome {
    /// Entries that changed a local Collection.
    pub changed: u64,
    /// Entries naming a deleted/AV Collection.
    pub skipped: u64,
    pub already_consumed: u64,
}

/// The adopted identity a handshake publication is composed under; the cursor itself is
/// read by the snapshot transaction (`cloud/collections.rs`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PersonalEditFeature {
    pub endpoint: String,
    pub library_id: String,
}

/// A validated value for one field.
#[derive(Debug, Clone, PartialEq)]
enum EditValue {
    Score(Option<f64>),
    Showcase(bool),
    Memo(Option<String>),
}

type Listener = Box<dyn Fn() + Send + Sync>;
static COLLECTIONS_CHANGED: OnceLock<Listener> = OnceLock::new();

/// Register the UI refresh hook (the app emits a Tauri event). Set once at startup.
pub(crate) fn set_collections_changed_listener(listener: impl Fn() + Send + Sync + 'static) {
    let _ = COLLECTIONS_CHANGED.set(Box::new(listener));
}

fn notify_collections_changed() {
    if let Some(listener) = COLLECTIONS_CHANGED.get() {
        listener();
    }
}

/// Reject a page the caller must not apply: it must be for this library and position,
/// contiguous from `after + 1`, and end at `next_cursor`.
pub(crate) fn validate_page(
    page: &PersonalEditPage,
    library_id: &str,
    after: i64,
    limit: i64,
) -> Result<(), LibraryError> {
    let invalid = || Err(LibraryError::CollectionPersonalEditInvalid);
    if !(0..MAX_CURSOR).contains(&after) {
        return invalid();
    }
    if page.version != 1 || page.library_id != library_id || page.after != after {
        return invalid();
    }
    if page.items.len() > 100 || page.items.len() as i64 > limit {
        return invalid();
    }
    let mut expected = after + 1;
    for item in &page.items {
        if item.sequence != expected
            || item.operation_id.is_empty()
            || item.operation_id.len() > 64
            || item.collection_id.is_empty()
            || item.collection_id.len() > 128
        {
            return invalid();
        }
        parse_value(&item.field, &item.value)?;
        expected += 1;
    }
    if page.next_cursor != expected - 1 || (page.has_more && page.items.is_empty()) {
        return invalid();
    }
    Ok(())
}

/// The PC's own validation, so a value the PC would refuse is never written.
fn parse_value(field: &str, value: &serde_json::Value) -> Result<EditValue, LibraryError> {
    let invalid = LibraryError::CollectionPersonalEditInvalid;
    match (field, value) {
        ("myScore", serde_json::Value::Null) => Ok(EditValue::Score(None)),
        ("myScore", serde_json::Value::Number(number)) => {
            let score = number.as_f64().ok_or(invalid)?;
            super::collection::validated_personal_rating(Some(score))
                .map(EditValue::Score)
                .map_err(|_| LibraryError::CollectionPersonalEditInvalid)
        }
        ("showcase", serde_json::Value::Bool(on)) => Ok(EditValue::Showcase(*on)),
        ("memo", serde_json::Value::Null) => Ok(EditValue::Memo(None)),
        ("memo", serde_json::Value::String(text)) => {
            super::collection::normalized_description(Some(text.clone()))
                .map(EditValue::Memo)
                .map_err(|_| LibraryError::CollectionPersonalEditInvalid)
        }
        _ => Err(invalid),
    }
}

/// Write one field with a targeted UPDATE; returns whether the row changed.
///
/// Showcase follows `Library::set_collection_showcase`: turning it on appends after the
/// current maximum within the type (an already ordered member keeps its place), turning
/// it off clears the order. Unchanged values issue no write, so no publication churn.
fn write_field(
    connection: &Connection,
    collection_id: &str,
    value: &EditValue,
    now: &str,
) -> Result<bool, LibraryError> {
    let changed = match value {
        EditValue::Score(score) => connection.execute(
            "UPDATE collections SET my_score = ?1, updated_at = ?2
             WHERE id = ?3 AND my_score IS NOT ?1",
            params![score, now, collection_id],
        )?,
        EditValue::Memo(memo) => connection.execute(
            "UPDATE collections SET description = ?1, updated_at = ?2
             WHERE id = ?3 AND description IS NOT ?1",
            params![memo, now, collection_id],
        )?,
        EditValue::Showcase(true) => connection.execute(
            "UPDATE collections
             SET showcase = 1,
                 showcase_order = (
                     SELECT COALESCE(MAX(other.showcase_order) + 1, 0)
                     FROM collections AS other
                     WHERE other.type = collections.type
                       AND other.id <> collections.id
                       AND (other.legacy_kind IS NULL OR other.legacy_kind <> 'gacha')
                 ),
                 updated_at = ?1
             WHERE id = ?2 AND NOT (showcase = 1 AND showcase_order IS NOT NULL)",
            params![now, collection_id],
        )?,
        EditValue::Showcase(false) => connection.execute(
            "UPDATE collections SET showcase = 0, showcase_order = NULL, updated_at = ?1
             WHERE id = ?2 AND (showcase <> 0 OR showcase_order IS NOT NULL)",
            params![now, collection_id],
        )?,
    };
    Ok(changed > 0)
}

fn bump_collections_generation(connection: &Connection) -> Result<(), LibraryError> {
    connection.execute(
        "UPDATE mobile_publication_state SET generation=generation+1,
         first_dirty=CASE WHEN generation=published_generation THEN unixepoch() ELSE first_dirty END,
         last_dirty=unixepoch() WHERE kind='collections'",
        [],
    )?;
    Ok(())
}

impl Library {
    /// The adopted `(library_id, received_cursor)` for one endpoint, if any.
    pub(crate) fn collection_personal_edit_adoption(
        &self,
        endpoint: &str,
    ) -> Result<Option<(String, i64)>, LibraryError> {
        let connection = self.connection()?;
        Ok(connection
            .query_row(
                "SELECT library_id, received_cursor FROM mobile_collection_personal_edit_sync
                 WHERE endpoint = ?1",
                [endpoint],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?)
    }

    /// Bind this endpoint to the local library at cursor zero, marking Collections dirty.
    ///
    /// The dirty bump makes the first handshake publication happen soon: that publication
    /// is what creates the server's state row, and until then mobile edits are refused.
    /// An existing row keeps its cursor (`DO NOTHING`).
    pub(crate) fn adopt_collection_personal_edit_library(
        &self,
        endpoint: &str,
        library_id: &str,
    ) -> Result<(), LibraryError> {
        if !super::is_valid_library_id(library_id) || self.library_id()? != library_id {
            return Err(LibraryError::CollectionPersonalEditCursorRejected);
        }
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        let inserted = transaction.execute(
            "INSERT INTO mobile_collection_personal_edit_sync(endpoint, library_id, received_cursor, updated_at)
             VALUES (?1, ?2, 0, ?3)
             ON CONFLICT(endpoint, library_id) DO NOTHING",
            params![endpoint, library_id, chrono::Utc::now().to_rfc3339()],
        )?;
        if inserted == 1 {
            bump_collections_generation(&transaction)?;
        }
        transaction.commit()?;
        Ok(())
    }

    /// Decide how the next Collection publication is composed, receiving pending edits first.
    ///
    /// Handshake rule (the server creates its state row on the first handshake publication,
    /// so `capabilities.collectionPersonalEdit` is still `false` before that):
    ///
    /// * no `capabilities` object in `/v1/collections/status` → an older server: legacy
    ///   snapshot with the shared token (`Ok(None)`), so publication never breaks;
    /// * `capabilities` present and a publisher token configured → adopt, receive, and send
    ///   the handshake with the publisher token (`Ok(Some(_))`);
    /// * `capabilities` present, feature not yet active, and either no publisher token or
    ///   the server library is not linked (`collectionPersonalEditUnsupported`) → legacy.
    ///   No edit can have been accepted without the state row, so nothing is lost;
    /// * feature already active without a publisher token → error: the server refuses a
    ///   legacy snapshot from then on.
    pub(crate) fn prepare_collection_personal_edits(
        &self,
        client: &CloudClient,
        endpoint: &str,
        status: &CollectionsStatus,
        publisher_token: Option<&str>,
    ) -> Result<Option<PersonalEditFeature>, LibraryError> {
        let Some(capabilities) = status.capabilities.as_ref() else {
            return Ok(None);
        };
        let active = capabilities.collection_personal_edit;
        let Some(publisher) = publisher_token else {
            return if active {
                Err(LibraryError::CloudCredentialNotConfigured)
            } else {
                Ok(None)
            };
        };
        let library_id = self.library_id()?;
        if active && status.library_id.as_deref() != Some(library_id.as_str()) {
            return Err(LibraryError::CollectionPersonalEditCursorRejected);
        }
        if let Some((adopted, _)) = self.collection_personal_edit_adoption(endpoint)? {
            if adopted != library_id {
                return Err(LibraryError::CollectionPersonalEditCursorRejected);
            }
        } else {
            self.adopt_collection_personal_edit_library(endpoint, &library_id)?;
        }
        match self.receive_collection_personal_edits_with(client, publisher, endpoint) {
            Ok(_) => Ok(Some(PersonalEditFeature {
                endpoint: endpoint.to_string(),
                library_id,
            })),
            Err(LibraryError::CollectionPersonalEditUnsupported) if !active => Ok(None),
            Err(error) => Err(error),
        }
    }

    /// Claim the idle receive poll for this endpoint: true at most once a minute, durably.
    pub(crate) fn claim_collection_personal_edit_poll(
        &self,
        endpoint: &str,
    ) -> Result<bool, LibraryError> {
        let db = self.connection()?;
        let due: bool = db
            .query_row(
                "SELECT last_checked <= unixepoch() - 60 FROM mobile_collection_personal_edit_poll WHERE endpoint = ?1",
                [endpoint],
                |row| row.get(0),
            )
            .optional()?
            .unwrap_or(true);
        if due {
            db.execute(
                "INSERT INTO mobile_collection_personal_edit_poll(endpoint, last_checked) VALUES (?1, unixepoch())
                 ON CONFLICT(endpoint) DO UPDATE SET last_checked = excluded.last_checked",
                [endpoint],
            )?;
        }
        Ok(due)
    }

    /// Idle poll, not gated on a dirty publication: an edit accepted while the PC sat idle
    /// is exactly the case no local change would publish. Network work holds no DB lock.
    pub(crate) fn run_due_collection_personal_edits(
        &self,
        endpoint: &str,
    ) -> Result<(), LibraryError> {
        let config = self.cloud_sync_config()?;
        if !config.enabled || config.api_base_url.as_deref() != Some(endpoint) {
            return Ok(());
        }
        if !self.claim_collection_personal_edit_poll(endpoint)? {
            return Ok(());
        }
        let publisher = match credential::read_cloud_publisher_token_os() {
            Ok(token) => token,
            Err(LibraryError::CloudCredentialNotConfigured) => return Ok(()),
            Err(error) => return Err(error),
        };
        let client = CloudClient::new(endpoint)?;
        // Always through the handshake rule, so an unlinked server library (which refuses the
        // feed) keeps the legacy path instead of failing every poll.
        let token = credential::read_cloud_api_token_os()?;
        let status = client.collections_status(token.expose())?;
        self.prepare_collection_personal_edits(
            &client,
            endpoint,
            &status,
            Some(publisher.expose()),
        )?;
        Ok(())
    }

    /// Pull and apply pending edits for the adopted endpoint, up to [`MAX_PAGES`] pages.
    /// Returns the durable cursor, or `None` when the endpoint is not configured/adopted.
    pub(crate) fn receive_collection_personal_edits_with(
        &self,
        client: &CloudClient,
        publisher_token: &str,
        endpoint: &str,
    ) -> Result<Option<i64>, LibraryError> {
        let config = self.cloud_sync_config()?;
        if !config.enabled || config.api_base_url.as_deref() != Some(endpoint) {
            return Ok(None);
        }
        let Some((library_id, mut cursor)) = self.collection_personal_edit_adoption(endpoint)?
        else {
            return Ok(None);
        };
        let mut changed = 0;
        for _ in 0..MAX_PAGES {
            let page = client
                .collection_personal_edits(publisher_token, &library_id, cursor, PAGE_LIMIT)?
                .ok_or(LibraryError::CollectionPersonalEditUnsupported)?;
            changed += self
                .apply_collection_personal_edit_page(endpoint, &library_id, &page.items)?
                .changed;
            // Re-read the durable position; another pass may have moved it further.
            let durable = self
                .collection_personal_edit_adoption(endpoint)?
                .map(|(_, cursor)| cursor)
                .ok_or(LibraryError::CollectionPersonalEditCursorRejected)?;
            cursor = durable;
            if !page.has_more || durable <= page.after {
                break;
            }
        }
        if changed > 0 {
            notify_collections_changed();
        }
        Ok(Some(cursor))
    }

    /// Apply one validated page, advancing the cursor and writing receipts in the same
    /// transaction. The persisted cursor is read inside it, so a stale page is harmless.
    pub(crate) fn apply_collection_personal_edit_page(
        &self,
        endpoint: &str,
        library_id: &str,
        items: &[PersonalEditEntry],
    ) -> Result<PageOutcome, LibraryError> {
        if !super::is_valid_library_id(library_id) || self.library_id()? != library_id {
            return Err(LibraryError::CollectionPersonalEditCursorRejected);
        }
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        let durable: i64 = transaction
            .query_row(
                "SELECT received_cursor FROM mobile_collection_personal_edit_sync
                 WHERE endpoint = ?1 AND library_id = ?2",
                params![endpoint, library_id],
                |row| row.get(0),
            )
            .optional()?
            .ok_or(LibraryError::CollectionPersonalEditCursorRejected)?;
        let mut expected = durable + 1;
        let mut highest = durable;
        let mut outcome = PageOutcome::default();
        let now = chrono::Utc::now().to_rfc3339();
        for item in items {
            let value = parse_value(&item.field, &item.value)?;
            let value_json = item.value.to_string();
            let consumed = receipt_matches(&transaction, item, &value_json, endpoint, library_id)?;
            if item.sequence <= durable {
                // Below the cursor only a receipt explains the entry; anything else is a
                // divergence this PC cannot reconcile.
                if !consumed {
                    return Err(LibraryError::CollectionPersonalEditInvalid);
                }
                outcome.already_consumed += 1;
                continue;
            }
            if item.sequence != expected {
                return Err(LibraryError::CollectionPersonalEditInvalid);
            }
            if consumed {
                outcome.already_consumed += 1;
            } else {
                // Only Collections this PC publishes can be edited: deleted, AV and hidden
                // legacy rows are skipped (PC deletion wins).
                let publishable: bool = transaction
                    .query_row(
                        "SELECT type IN ('game','manga','movie')
                            AND (legacy_kind IS NULL OR legacy_kind <> 'gacha')
                         FROM collections WHERE id = ?1",
                        [&item.collection_id],
                        |row| row.get(0),
                    )
                    .optional()?
                    .unwrap_or(false);
                let result = if publishable {
                    if write_field(&transaction, &item.collection_id, &value, &now)? {
                        outcome.changed += 1;
                    }
                    "applied"
                } else {
                    outcome.skipped += 1;
                    "skipped"
                };
                transaction.execute(
                    "INSERT INTO mobile_collection_personal_edit_receipts
                        (endpoint, library_id, operation_id, sequence, collection_id, field,
                         value, previous_value, outcome, created_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                    params![
                        endpoint,
                        library_id,
                        item.operation_id,
                        item.sequence,
                        item.collection_id,
                        item.field,
                        value_json,
                        item.previous.to_string(),
                        result,
                        now
                    ],
                )?;
            }
            expected += 1;
            highest = item.sequence;
        }
        if highest > durable {
            transaction.execute(
                "UPDATE mobile_collection_personal_edit_sync
                 SET received_cursor = ?3, updated_at = ?4
                 WHERE endpoint = ?1 AND library_id = ?2",
                params![endpoint, library_id, highest, now],
            )?;
            // Even a skipped/no-op entry needs a publication so the server can acknowledge
            // the new cursor; a changed row is also dirtied by the 0074 triggers.
            bump_collections_generation(&transaction)?;
        }
        transaction.commit()?;
        Ok(outcome)
    }
}

/// Whether this origin already consumed this exact entry; a receipt with other content
/// under the same operation id is a divergence and is refused.
fn receipt_matches(
    transaction: &Connection,
    item: &PersonalEditEntry,
    value_json: &str,
    endpoint: &str,
    library_id: &str,
) -> Result<bool, LibraryError> {
    let recorded: Option<(i64, String, String, String)> = transaction
        .query_row(
            "SELECT sequence, collection_id, field, value
             FROM mobile_collection_personal_edit_receipts
             WHERE endpoint = ?1 AND library_id = ?2 AND operation_id = ?3",
            params![endpoint, library_id, &item.operation_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()?;
    let Some((sequence, collection_id, field, value)) = recorded else {
        return Ok(false);
    };
    if sequence != item.sequence
        || collection_id != item.collection_id
        || field != item.field
        || value != value_json
    {
        return Err(LibraryError::CollectionPersonalEditInvalid);
    }
    Ok(true)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::library::models::{CollectionPersonalBase, CollectionType, UpdateCollection};

    pub(crate) const ENDPOINT: &str = "https://sync.example.test";

    pub(crate) fn entry(
        sequence: i64,
        collection: &str,
        field: &str,
        value: serde_json::Value,
    ) -> PersonalEditEntry {
        PersonalEditEntry {
            sequence,
            operation_id: format!("op-{sequence}"),
            collection_id: collection.into(),
            field: field.into(),
            value,
            previous: serde_json::Value::Null,
            created_at: "2026-09-24T00:00:00Z".into(),
        }
    }

    fn fixture() -> (tempfile::TempDir, Library) {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        library
            .connection()
            .unwrap()
            .execute_batch(
                "INSERT INTO collections(id,name,type,my_score,description,showcase,showcase_order,created_at,updated_at) VALUES
                 ('a','A','manga',3.0,'PC memo',0,NULL,'2026','2026'),
                 ('s','S','manga',NULL,NULL,1,4,'2026','2026'),
                 ('g','G','game',NULL,NULL,1,0,'2026','2026'),
                 ('av','AV','av',NULL,NULL,0,NULL,'2026','2026');",
            )
            .unwrap();
        (temp, library)
    }

    fn adopt(library: &Library, endpoint: &str) -> String {
        let id = library.library_id().unwrap();
        library
            .adopt_collection_personal_edit_library(endpoint, &id)
            .unwrap();
        id
    }

    fn row(library: &Library, id: &str) -> (Option<f64>, Option<String>, bool, Option<i64>) {
        library
            .connection()
            .unwrap()
            .query_row(
                "SELECT my_score, description, showcase, showcase_order FROM collections WHERE id=?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap()
    }

    fn cursor(library: &Library, endpoint: &str) -> i64 {
        library
            .collection_personal_edit_adoption(endpoint)
            .unwrap()
            .unwrap()
            .1
    }

    fn mark_published(library: &Library) {
        library
            .connection()
            .unwrap()
            .execute(
                "UPDATE mobile_publication_state SET published_generation=generation",
                [],
            )
            .unwrap();
    }

    fn dirty(library: &Library) -> bool {
        library
            .connection()
            .unwrap()
            .query_row(
                "SELECT generation>published_generation FROM mobile_publication_state WHERE kind='collections'",
                [],
                |r| r.get(0),
            )
            .unwrap()
    }

    fn receipts(library: &Library) -> Vec<(i64, String)> {
        library
            .connection()
            .unwrap()
            .prepare("SELECT sequence, outcome FROM mobile_collection_personal_edit_receipts ORDER BY sequence")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    }

    #[test]
    fn applies_a_page_with_targeted_updates_and_advances_the_cursor_atomically() {
        let (_temp, library) = fixture();
        let id = adopt(&library, ENDPOINT);
        mark_published(&library);
        let outcome = library
            .apply_collection_personal_edit_page(
                ENDPOINT,
                &id,
                &[
                    entry(1, "a", "myScore", serde_json::json!(4.5)),
                    entry(2, "a", "memo", serde_json::json!("  폰 메모  ")),
                    entry(3, "a", "showcase", serde_json::json!(true)),
                ],
            )
            .unwrap();
        assert_eq!(
            outcome,
            PageOutcome {
                changed: 3,
                skipped: 0,
                already_consumed: 0
            }
        );
        // Showcase on appends after the current maximum within the type (s has 4).
        assert_eq!(
            row(&library, "a"),
            (Some(4.5), Some("폰 메모".into()), true, Some(5))
        );
        assert_eq!(cursor(&library, ENDPOINT), 3);
        assert_eq!(receipts(&library).len(), 3);
        assert!(dirty(&library), "0074 triggers must schedule a republish");
        // Other PC-owned fields are untouched.
        let name: String = library
            .connection()
            .unwrap()
            .query_row("SELECT name FROM collections WHERE id='a'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(name, "A");
    }

    #[test]
    fn an_invalid_entry_rolls_back_the_whole_page_and_keeps_the_cursor() {
        let (_temp, library) = fixture();
        let id = adopt(&library, ENDPOINT);
        for bad in [
            vec![
                entry(1, "a", "myScore", serde_json::json!(4.5)),
                entry(2, "a", "myScore", serde_json::json!(4.25)),
            ],
            vec![
                entry(1, "a", "myScore", serde_json::json!(4.5)),
                entry(3, "a", "memo", serde_json::json!("gap")),
            ],
            vec![entry(1, "a", "memo", serde_json::json!("x".repeat(2001)))],
            vec![entry(1, "a", "name", serde_json::json!("x"))],
        ] {
            assert!(matches!(
                library.apply_collection_personal_edit_page(ENDPOINT, &id, &bad),
                Err(LibraryError::CollectionPersonalEditInvalid)
            ));
            assert_eq!(cursor(&library, ENDPOINT), 0);
            assert_eq!(row(&library, "a").0, Some(3.0));
            assert!(receipts(&library).is_empty());
        }
    }

    #[test]
    fn a_replayed_or_stale_page_is_harmless() {
        let (_temp, library) = fixture();
        let id = adopt(&library, ENDPOINT);
        let first = [
            entry(1, "a", "myScore", serde_json::json!(4.5)),
            entry(2, "a", "memo", serde_json::json!(null)),
        ];
        library
            .apply_collection_personal_edit_page(ENDPOINT, &id, &first)
            .unwrap();
        // The PC later changes the rating itself; replaying the page must not undo that.
        library
            .connection()
            .unwrap()
            .execute("UPDATE collections SET my_score=1.0 WHERE id='a'", [])
            .unwrap();
        mark_published(&library);
        let replay = library
            .apply_collection_personal_edit_page(ENDPOINT, &id, &first)
            .unwrap();
        assert_eq!(replay.already_consumed, 2);
        assert_eq!(replay.changed, 0);
        assert_eq!(row(&library, "a").0, Some(1.0));
        assert_eq!(cursor(&library, ENDPOINT), 2);
        assert!(!dirty(&library), "a replay schedules nothing");
        // An empty page never rewinds.
        library
            .apply_collection_personal_edit_page(ENDPOINT, &id, &[])
            .unwrap();
        assert_eq!(cursor(&library, ENDPOINT), 2);
        // The same operation id with different content is a divergence.
        let mut forged = entry(1, "a", "myScore", serde_json::json!(2.0));
        forged.operation_id = "op-1".into();
        assert!(matches!(
            library.apply_collection_personal_edit_page(ENDPOINT, &id, &[forged]),
            Err(LibraryError::CollectionPersonalEditInvalid)
        ));
        // Below the cursor with no receipt is unexplainable.
        let mut unknown = entry(2, "a", "memo", serde_json::json!(null));
        unknown.operation_id = "never-seen".into();
        assert!(matches!(
            library.apply_collection_personal_edit_page(ENDPOINT, &id, &[unknown]),
            Err(LibraryError::CollectionPersonalEditInvalid)
        ));
    }

    #[test]
    fn missing_and_av_collections_are_skipped_but_the_cursor_advances() {
        let (_temp, library) = fixture();
        let id = adopt(&library, ENDPOINT);
        mark_published(&library);
        let outcome = library
            .apply_collection_personal_edit_page(
                ENDPOINT,
                &id,
                &[
                    entry(1, "deleted", "myScore", serde_json::json!(5.0)),
                    entry(2, "av", "showcase", serde_json::json!(true)),
                ],
            )
            .unwrap();
        assert_eq!(outcome.skipped, 2);
        assert_eq!(outcome.changed, 0);
        assert_eq!(cursor(&library, ENDPOINT), 2);
        assert_eq!(
            receipts(&library),
            vec![(1, "skipped".into()), (2, "skipped".into())]
        );
        assert_eq!(row(&library, "av"), (None, None, false, None));
        assert!(
            dirty(&library),
            "the new cursor still needs acknowledging by a publication"
        );
    }

    #[test]
    fn showcase_follows_the_pc_order_semantics() {
        let (_temp, library) = fixture();
        let id = adopt(&library, ENDPOINT);
        library
            .apply_collection_personal_edit_page(
                ENDPOINT,
                &id,
                &[
                    // Already on: keeps its manual place.
                    entry(1, "s", "showcase", serde_json::json!(true)),
                    // Off clears the order.
                    entry(2, "g", "showcase", serde_json::json!(false)),
                    // On appends within its own type (manga max is 4 → 5).
                    entry(3, "a", "showcase", serde_json::json!(true)),
                ],
            )
            .unwrap();
        assert_eq!(row(&library, "s").2..=row(&library, "s").2, true..=true);
        assert_eq!(row(&library, "s").3, Some(4));
        assert_eq!((row(&library, "g").2, row(&library, "g").3), (false, None));
        assert_eq!(row(&library, "a").3, Some(5));
        // Matches `set_collection_showcase` for the next toggle.
        library.set_collection_showcase("g", true).unwrap();
        assert_eq!(row(&library, "g").3, Some(0));
    }

    #[test]
    fn a_page_for_another_library_or_unadopted_endpoint_is_refused() {
        let (_temp, library) = fixture();
        let items = [entry(1, "a", "myScore", serde_json::json!(4.5))];
        let id = library.library_id().unwrap();
        assert!(matches!(
            library.apply_collection_personal_edit_page(ENDPOINT, &id, &items),
            Err(LibraryError::CollectionPersonalEditCursorRejected)
        ));
        adopt(&library, ENDPOINT);
        assert!(matches!(
            library.apply_collection_personal_edit_page(
                ENDPOINT,
                "fedcba9876543210fedcba9876543210",
                &items
            ),
            Err(LibraryError::CollectionPersonalEditCursorRejected)
        ));
        assert_eq!(row(&library, "a").0, Some(3.0));
    }

    #[test]
    fn adoption_dirties_collections_once_and_keeps_an_existing_cursor() {
        let (_temp, library) = fixture();
        mark_published(&library);
        let id = adopt(&library, ENDPOINT);
        assert!(dirty(&library));
        library
            .apply_collection_personal_edit_page(
                ENDPOINT,
                &id,
                &[entry(1, "a", "myScore", serde_json::json!(4.5))],
            )
            .unwrap();
        mark_published(&library);
        adopt(&library, ENDPOINT);
        assert!(!dirty(&library));
        assert_eq!(cursor(&library, ENDPOINT), 1);
    }

    #[test]
    fn the_idle_poll_runs_at_most_once_a_minute_across_restarts() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        assert!(library
            .claim_collection_personal_edit_poll(ENDPOINT)
            .unwrap());
        assert!(!library
            .claim_collection_personal_edit_poll(ENDPOINT)
            .unwrap());
        drop(library);
        let reopened = Library::open(temp.path()).unwrap();
        assert!(!reopened
            .claim_collection_personal_edit_poll(ENDPOINT)
            .unwrap());
        reopened
            .connection()
            .unwrap()
            .execute(
                "UPDATE mobile_collection_personal_edit_poll SET last_checked=unixepoch()-61",
                [],
            )
            .unwrap();
        assert!(reopened
            .claim_collection_personal_edit_poll(ENDPOINT)
            .unwrap());
    }

    fn update(
        library: &Library,
        score: Option<f64>,
        memo: Option<&str>,
        base: Option<(Option<f64>, Option<&str>)>,
    ) {
        library
            .update_collection(
                "a",
                UpdateCollection {
                    name: "A renamed".into(),
                    description: memo.map(str::to_owned),
                    collection_type: CollectionType::Manga,
                    year: None,
                    original_title: None,
                    runtime_minutes: None,
                    author: None,
                    director: None,
                    developer: None,
                    publisher: None,
                    platforms: None,
                    production_company: None,
                    release_date: None,
                    external_score: None,
                    my_score: score,
                    personal_base: base.map(|(my_score, description)| CollectionPersonalBase {
                        my_score,
                        description: description.map(str::to_owned),
                    }),
                },
            )
            .unwrap();
    }

    #[test]
    fn a_stale_edit_dialog_does_not_clobber_a_mobile_applied_value() {
        let (_temp, library) = fixture();
        let id = adopt(&library, ENDPOINT);
        // The dialog opened with rating 3 and "PC memo"; then mobile edits arrive.
        library
            .apply_collection_personal_edit_page(
                ENDPOINT,
                &id,
                &[
                    entry(1, "a", "myScore", serde_json::json!(4.5)),
                    entry(2, "a", "memo", serde_json::json!("폰 메모")),
                ],
            )
            .unwrap();
        // Saving the dialog with only the name changed keeps both mobile values.
        update(
            &library,
            Some(3.0),
            Some("PC memo "),
            Some((Some(3.0), Some("PC memo"))),
        );
        assert_eq!(row(&library, "a").0, Some(4.5));
        assert_eq!(row(&library, "a").1.as_deref(), Some("폰 메모"));
        // A field the user did change in the dialog is written.
        update(
            &library,
            Some(2.0),
            Some("PC memo"),
            Some((Some(3.0), Some("PC memo"))),
        );
        assert_eq!(row(&library, "a").0, Some(2.0));
        assert_eq!(row(&library, "a").1.as_deref(), Some("폰 메모"));
        // Callers without a base keep the old whole-record behaviour.
        update(&library, None, None, None);
        assert_eq!(row(&library, "a").0, None);
        assert_eq!(row(&library, "a").1, None);
    }

    // --- Scripted server: receive, handshake decision --------------------------------

    fn page_body(library_id: &str, after: i64, next: i64, has_more: bool, items: &str) -> String {
        format!(
            r#"{{"version":1,"libraryId":"{library_id}","after":{after},"nextCursor":{next},"hasMore":{has_more},"items":[{items}]}}"#
        )
    }

    /// Serves `(status, body)` responses in order, asserting each request path prefix.
    pub(crate) fn scripted(
        responses: Vec<(&'static str, u16, String)>,
    ) -> (
        String,
        std::thread::JoinHandle<Vec<(String, Option<String>, String)>>,
    ) {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let base = format!("http://{}", server.server_addr());
        let handle = std::thread::spawn(move || {
            let mut seen = Vec::new();
            for (prefix, status, body) in responses {
                let mut request = server
                    .recv_timeout(std::time::Duration::from_secs(5))
                    .unwrap()
                    .expect("request");
                assert!(
                    request.url().starts_with(prefix),
                    "{} does not start with {prefix}",
                    request.url()
                );
                let authorization = request
                    .headers()
                    .iter()
                    .find(|h| h.field.equiv("Authorization"))
                    .map(|h| h.value.to_string());
                let mut sent = String::new();
                std::io::Read::read_to_string(request.as_reader(), &mut sent).unwrap();
                seen.push((request.url().to_string(), authorization, sent));
                request
                    .respond(tiny_http::Response::from_string(body).with_status_code(status))
                    .unwrap();
            }
            seen
        });
        (base, handle)
    }

    pub(crate) fn configure(library: &Library, base: &str) {
        library
            .set_cloud_sync_config(crate::cloud::models::CloudSyncConfig {
                enabled: true,
                api_base_url: Some(base.into()),
            })
            .unwrap();
    }

    fn status(json: &str) -> CollectionsStatus {
        serde_json::from_str(json).unwrap()
    }

    #[test]
    fn receive_drains_pages_through_the_real_client_and_refreshes_the_ui() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static NOTIFIED: AtomicUsize = AtomicUsize::new(0);
        set_collections_changed_listener(|| {
            NOTIFIED.fetch_add(1, Ordering::SeqCst);
        });
        let (_temp, library) = fixture();
        let id = library.library_id().unwrap();
        let one = serde_json::to_string(&entry(1, "a", "myScore", serde_json::json!(4.5))).unwrap();
        let two =
            serde_json::to_string(&entry(2, "a", "showcase", serde_json::json!(true))).unwrap();
        let (base, handle) = scripted(vec![
            (
                "/v1/collections/personal-edits?libraryId=",
                200,
                page_body(&id, 0, 1, true, &one),
            ),
            (
                "/v1/collections/personal-edits?libraryId=",
                200,
                page_body(&id, 1, 2, false, &two),
            ),
        ]);
        configure(&library, &base);
        adopt(&library, &base);
        let client = CloudClient::new(&base).unwrap();
        let before = NOTIFIED.load(Ordering::SeqCst);
        let received = library
            .receive_collection_personal_edits_with(&client, "publisher-token", &base)
            .unwrap();
        let seen = handle.join().unwrap();
        assert_eq!(received, Some(2));
        assert!(seen[0].0.contains("after=0") && seen[1].0.contains("after=1"));
        assert_eq!(seen[0].1.as_deref(), Some("Bearer publisher-token"));
        assert_eq!(row(&library, "a").0, Some(4.5));
        assert_eq!(row(&library, "a").3, Some(5));
        assert!(NOTIFIED.load(Ordering::SeqCst) > before);
    }

    #[test]
    fn a_legacy_server_keeps_the_legacy_publication_without_any_request() {
        let (_temp, library) = fixture();
        configure(&library, "http://127.0.0.1:9");
        let client = CloudClient::new("http://127.0.0.1:9").unwrap();
        let feature = library
            .prepare_collection_personal_edits(
                &client,
                "http://127.0.0.1:9",
                &status(r#"{"revision":null,"publishedAt":null}"#),
                Some("publisher-token"),
            )
            .unwrap();
        assert_eq!(feature, None);
        assert_eq!(
            library
                .collection_personal_edit_adoption("http://127.0.0.1:9")
                .unwrap(),
            None
        );
        // No publisher token before activation: legacy too.
        let inactive = status(r#"{"capabilities":{"collectionPersonalEdit":false}}"#);
        assert_eq!(
            library
                .prepare_collection_personal_edits(&client, "http://127.0.0.1:9", &inactive, None)
                .unwrap(),
            None
        );
        // After activation a legacy snapshot would be refused, so it is an error.
        let active = status(&format!(
            r#"{{"capabilities":{{"collectionPersonalEdit":true}},"libraryId":"{}"}}"#,
            library.library_id().unwrap()
        ));
        assert!(matches!(
            library.prepare_collection_personal_edits(&client, "http://127.0.0.1:9", &active, None),
            Err(LibraryError::CloudCredentialNotConfigured)
        ));
    }

    #[test]
    fn an_unlinked_server_library_falls_back_only_before_activation() {
        let (_temp, library) = fixture();
        let unsupported =
            r#"{"detail":{"code":"collectionPersonalEditUnsupported","message":"x"}}"#;
        let (base, handle) = scripted(vec![
            ("/v1/collections/personal-edits", 409, unsupported.into()),
            ("/v1/collections/personal-edits", 409, unsupported.into()),
        ]);
        configure(&library, &base);
        let client = CloudClient::new(&base).unwrap();
        let inactive = status(r#"{"capabilities":{"collectionPersonalEdit":false}}"#);
        assert_eq!(
            library
                .prepare_collection_personal_edits(&client, &base, &inactive, Some("publisher"))
                .unwrap(),
            None
        );
        let active = status(&format!(
            r#"{{"capabilities":{{"collectionPersonalEdit":true}},"libraryId":"{}"}}"#,
            library.library_id().unwrap()
        ));
        assert!(matches!(
            library.prepare_collection_personal_edits(&client, &base, &active, Some("publisher")),
            Err(LibraryError::CollectionPersonalEditUnsupported)
        ));
        handle.join().unwrap();
        // A server bound to another library is never published to with the handshake.
        let other = status(
            r#"{"capabilities":{"collectionPersonalEdit":true},"libraryId":"fedcba9876543210fedcba9876543210"}"#,
        );
        assert!(matches!(
            library.prepare_collection_personal_edits(&client, &base, &other, Some("publisher")),
            Err(LibraryError::CollectionPersonalEditCursorRejected)
        ));
    }
}
