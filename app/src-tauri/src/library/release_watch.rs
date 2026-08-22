use rusqlite::{params, OptionalExtension};

use super::{
    aladin::{self, AladinItem},
    aladin_flow::StoredAladinSource,
    collection::require_collection,
    error::LibraryError,
    models::{
        ReleaseWatchEvent, ReleaseWatchEventKind, ReleaseWatchRunResult, ReleaseWatchRunStopReason,
        ReleaseWatchStatus,
    },
    Library,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct PendingReleaseChange {
    pub(super) kind: ReleaseWatchEventKind,
    pub(super) volume_number: i64,
    pub(super) previous_value: Option<String>,
    pub(super) current_value: Option<String>,
}

pub(super) fn pending_release_changes(
    existing: Option<&StoredAladinSource>,
    item: &AladinItem,
    previous_checked_at: Option<&str>,
    checked_at: &str,
) -> Vec<PendingReleaseChange> {
    let Some(existing) = existing else {
        return vec![PendingReleaseChange {
            kind: ReleaseWatchEventKind::NewVolume,
            volume_number: item.volume_number,
            previous_value: None,
            current_value: item.publication_date.clone(),
        }];
    };
    let mut changes = Vec::new();
    if existing.publication_date != item.publication_date {
        changes.push(PendingReleaseChange {
            kind: ReleaseWatchEventKind::ReleaseDateChanged,
            volume_number: item.volume_number,
            previous_value: existing.publication_date.clone(),
            current_value: item.publication_date.clone(),
        });
    }
    if let Some(previous_checked_at) = previous_checked_at {
        let previous_status =
            release_status_at(existing.publication_date.as_deref(), previous_checked_at);
        let current_status = release_status_at(item.publication_date.as_deref(), checked_at);
        if previous_status.is_some()
            && current_status.is_some()
            && previous_status != current_status
        {
            changes.push(PendingReleaseChange {
                kind: ReleaseWatchEventKind::ReleaseStatusChanged,
                volume_number: item.volume_number,
                previous_value: previous_status.map(str::to_owned),
                current_value: current_status.map(str::to_owned),
            });
        }
    }
    changes
}

fn release_status_at(publication_date: Option<&str>, checked_at: &str) -> Option<&'static str> {
    let date = chrono::NaiveDate::parse_from_str(publication_date?, "%Y-%m-%d").ok()?;
    let checked = chrono::DateTime::parse_from_rfc3339(checked_at)
        .ok()?
        .date_naive();
    Some(if date > checked {
        "upcoming"
    } else {
        "released"
    })
}

pub(super) fn event_kind_str(kind: ReleaseWatchEventKind) -> &'static str {
    match kind {
        ReleaseWatchEventKind::NewVolume => "new_volume",
        ReleaseWatchEventKind::ReleaseDateChanged => "release_date_changed",
        ReleaseWatchEventKind::ReleaseStatusChanged => "release_status_changed",
    }
}

impl Library {
    pub fn run_due_release_watch(
        &self,
        ttb_key: &str,
    ) -> Result<ReleaseWatchRunResult, LibraryError> {
        let checked_at = chrono::Utc::now().to_rfc3339();
        self.run_due_release_watch_with(&checked_at, |query| aladin::search(ttb_key, query))
    }

    fn run_due_release_watch_with<F>(
        &self,
        checked_at: &str,
        mut fetch: F,
    ) -> Result<ReleaseWatchRunResult, LibraryError>
    where
        F: FnMut(&str) -> Result<Vec<AladinItem>, LibraryError>,
    {
        let _guard = self
            .release_watch_lock
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let checked = chrono::DateTime::parse_from_rfc3339(checked_at)
            .map_err(|_| LibraryError::InvalidAladinResponse)?;
        let cutoff = checked - chrono::Duration::hours(24);
        let due = {
            let connection = self.connection()?;
            let mut statement = connection.prepare(
                "SELECT collection_id, last_checked_at
                 FROM release_watch_subscriptions
                 ORDER BY COALESCE(last_checked_at, ''), collection_id",
            )?;
            let rows = statement
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            rows.into_iter()
                .filter(|(_, last_checked_at)| {
                    last_checked_at.as_deref().is_none_or(|value| {
                        chrono::DateTime::parse_from_rfc3339(value)
                            .map(|timestamp| timestamp <= cutoff)
                            .unwrap_or(true)
                    })
                })
                .collect::<Vec<_>>()
        };
        let mut result = ReleaseWatchRunResult {
            checked: 0,
            changed_collections: 0,
            skipped: 0,
            stop_reason: None,
        };
        for (collection_id, _) in due {
            let query = match self.get_aladin_connection(&collection_id) {
                Ok(Some(connection)) => connection.query,
                Ok(None) => {
                    result.skipped += 1;
                    continue;
                }
                Err(error) => {
                    if let Some(reason) = stop_reason(&error) {
                        result.stop_reason = Some(reason);
                        break;
                    }
                    result.skipped += 1;
                    continue;
                }
            };
            let items = match fetch(&query) {
                Ok(items) => items,
                Err(error) => {
                    if let Some(reason) = stop_reason(&error) {
                        result.stop_reason = Some(reason);
                        break;
                    }
                    result.skipped += 1;
                    continue;
                }
            };
            match self.refresh_aladin_items_at(&collection_id, items, checked_at) {
                Ok(outcome) => {
                    result.checked += 1;
                    if outcome.release_event_count > 0 {
                        result.changed_collections += 1;
                    }
                }
                Err(error) => {
                    if let Some(reason) = stop_reason(&error) {
                        result.stop_reason = Some(reason);
                        break;
                    }
                    result.skipped += 1;
                }
            }
        }
        Ok(result)
    }

    pub fn get_release_watch_status(
        &self,
        collection_id: &str,
    ) -> Result<ReleaseWatchStatus, LibraryError> {
        let connection = self.connection()?;
        require_collection(&connection, collection_id)?;
        release_watch_status(&connection, collection_id)
    }

    pub fn set_release_watch_enabled(
        &self,
        collection_id: &str,
        enabled: bool,
    ) -> Result<ReleaseWatchStatus, LibraryError> {
        let connection = self.connection()?;
        require_collection(&connection, collection_id)?;
        if enabled {
            let inserted = connection.execute(
                "INSERT INTO release_watch_subscriptions (
                    collection_id, provider, last_checked_at
                 )
                 SELECT binding.collection_id, binding.provider, binding.last_synced_at
                 FROM collection_external_bindings AS binding
                 JOIN collections AS collection ON collection.id = binding.collection_id
                 WHERE binding.collection_id = ?1
                   AND binding.provider = 'aladin'
                   AND collection.type = 'manga'
                 ON CONFLICT(collection_id, provider) DO NOTHING",
                [collection_id],
            )?;
            if inserted == 0 && !subscription_exists(&connection, collection_id)? {
                return Err(LibraryError::ReleaseWatchRequiresAladinBinding);
            }
        } else {
            connection.execute(
                "DELETE FROM release_watch_subscriptions
                 WHERE collection_id = ?1 AND provider = 'aladin'",
                [collection_id],
            )?;
        }
        release_watch_status(&connection, collection_id)
    }

    pub fn take_unread_release_changes(
        &self,
        collection_id: &str,
    ) -> Result<Vec<ReleaseWatchEvent>, LibraryError> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        require_collection(&transaction, collection_id)?;
        let events = {
            let mut statement = transaction.prepare(
                "SELECT id, event_kind, volume_number, previous_value, current_value, detected_at
                 FROM release_watch_events
                 WHERE collection_id = ?1 AND read_at IS NULL
                 ORDER BY detected_at, rowid",
            )?;
            let events = statement
                .query_map([collection_id], release_watch_event_from_row)?
                .collect::<Result<Vec<_>, _>>()?;
            events
        };
        let now = chrono::Utc::now().to_rfc3339();
        for event in &events {
            transaction.execute(
                "UPDATE release_watch_events SET read_at = ?1
                 WHERE id = ?2 AND read_at IS NULL",
                params![now, event.id],
            )?;
        }
        transaction.commit()?;
        Ok(events)
    }
}

fn stop_reason(error: &LibraryError) -> Option<ReleaseWatchRunStopReason> {
    match error {
        LibraryError::InvalidAladinCredential => Some(ReleaseWatchRunStopReason::InvalidCredential),
        LibraryError::AladinRateLimited => Some(ReleaseWatchRunStopReason::RateLimited),
        LibraryError::AladinTimedOut => Some(ReleaseWatchRunStopReason::TimedOut),
        LibraryError::AladinUnavailable => Some(ReleaseWatchRunStopReason::Unavailable),
        LibraryError::InvalidAladinResponse => Some(ReleaseWatchRunStopReason::InvalidResponse),
        _ => None,
    }
}

fn subscription_exists(
    connection: &rusqlite::Connection,
    collection_id: &str,
) -> Result<bool, LibraryError> {
    Ok(connection.query_row(
        "SELECT EXISTS(
            SELECT 1 FROM release_watch_subscriptions
            WHERE collection_id = ?1 AND provider = 'aladin'
         )",
        [collection_id],
        |row| row.get(0),
    )?)
}

fn release_watch_status(
    connection: &rusqlite::Connection,
    collection_id: &str,
) -> Result<ReleaseWatchStatus, LibraryError> {
    let last_checked_at = connection
        .query_row(
            "SELECT last_checked_at
             FROM release_watch_subscriptions
             WHERE collection_id = ?1 AND provider = 'aladin'",
            [collection_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()?;
    Ok(ReleaseWatchStatus {
        enabled: last_checked_at.is_some(),
        last_checked_at: last_checked_at.flatten(),
    })
}

fn release_watch_event_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ReleaseWatchEvent> {
    let kind = match row.get::<_, String>(1)?.as_str() {
        "new_volume" => ReleaseWatchEventKind::NewVolume,
        "release_date_changed" => ReleaseWatchEventKind::ReleaseDateChanged,
        "release_status_changed" => ReleaseWatchEventKind::ReleaseStatusChanged,
        _ => return Err(rusqlite::Error::InvalidQuery),
    };
    Ok(ReleaseWatchEvent {
        id: row.get(0)?,
        kind,
        volume_number: row.get(2)?,
        previous_value: row.get(3)?,
        current_value: row.get(4)?,
        detected_at: row.get(5)?,
    })
}

#[cfg(test)]
mod tests {
    use super::pending_release_changes;
    use crate::library::{
        aladin::AladinItem,
        aladin_flow::StoredAladinSource,
        error::LibraryError,
        models::{CollectionType, CreateCollection, ExternalBindingInput, ReleaseWatchEventKind},
        Library,
    };
    use rusqlite::params;

    fn item(volume_number: i64, publication_date: Option<&str>) -> AladinItem {
        AladinItem {
            item_id: format!("item-{volume_number}"),
            title: format!("던전밥 {volume_number}권"),
            author: Some("작가".into()),
            publisher: Some("출판사".into()),
            isbn13: Some(format!("978{volume_number}")),
            publication_date: publication_date.map(Into::into),
            item_url: None,
            volume_number,
            base_title: "던전밥".into(),
            snapshot_json: format!(r#"{{"itemId":"item-{volume_number}"}}"#),
        }
    }

    fn stored(volume_number: i64, publication_date: Option<&str>) -> StoredAladinSource {
        StoredAladinSource {
            provider_item_id: format!("item-{volume_number}"),
            title: format!("던전밥 {volume_number}권"),
            author: Some("작가".into()),
            publisher: Some("출판사".into()),
            isbn13: Some(format!("978{volume_number}")),
            publication_date: publication_date.map(Into::into),
            item_url: None,
            provider_data_json: format!(r#"{{"itemId":"item-{volume_number}"}}"#),
        }
    }

    #[test]
    fn pending_release_changes_detects_new_date_and_status_changes() {
        let checked_at = "2026-08-22T00:00:00Z";
        let previous = "2026-08-20T00:00:00Z";

        let changes = pending_release_changes(
            None,
            &item(13, Some("2026-09-01")),
            Some(previous),
            checked_at,
        );
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].kind, ReleaseWatchEventKind::NewVolume);
        assert_eq!(changes[0].volume_number, 13);
        assert_eq!(changes[0].previous_value, None);
        assert_eq!(changes[0].current_value.as_deref(), Some("2026-09-01"));

        let changes = pending_release_changes(
            Some(&stored(12, Some("2026-08-21"))),
            &item(12, Some("2026-08-20")),
            Some(previous),
            checked_at,
        );
        assert_eq!(changes.len(), 2);
        assert_eq!(changes[0].kind, ReleaseWatchEventKind::ReleaseDateChanged);
        assert_eq!(changes[0].previous_value.as_deref(), Some("2026-08-21"));
        assert_eq!(changes[0].current_value.as_deref(), Some("2026-08-20"));
        assert_eq!(changes[1].kind, ReleaseWatchEventKind::ReleaseStatusChanged);
        assert_eq!(changes[1].previous_value.as_deref(), Some("upcoming"));
        assert_eq!(changes[1].current_value.as_deref(), Some("released"));
    }

    #[test]
    fn pending_release_changes_handles_time_crossing_and_missing_history() {
        let checked_at = "2026-08-22T00:00:00Z";
        let previous = "2026-08-20T00:00:00Z";
        let stored = stored(12, Some("2026-08-21"));
        let unchanged = item(12, Some("2026-08-21"));

        let changes =
            pending_release_changes(Some(&stored), &unchanged, Some(previous), checked_at);
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].kind, ReleaseWatchEventKind::ReleaseStatusChanged);

        assert!(pending_release_changes(Some(&stored), &unchanged, None, checked_at).is_empty());
        assert!(pending_release_changes(
            Some(&stored),
            &unchanged,
            Some("2026-08-22T00:00:00Z"),
            checked_at,
        )
        .is_empty());
    }

    fn create_collection(library: &Library, name: &str, collection_type: CollectionType) -> String {
        library
            .create_collection(CreateCollection {
                name: name.into(),
                description: None,
                collection_type,
            })
            .unwrap()
            .id
    }

    fn connect_aladin(library: &Library, collection_id: &str) {
        connect_aladin_with(library, collection_id, "item-1", "던전밥");
    }

    fn connect_aladin_with(library: &Library, collection_id: &str, item_id: &str, query: &str) {
        library
            .upsert_collection_external_binding(
                collection_id,
                ExternalBindingInput {
                    provider: "aladin".into(),
                    external_id: item_id.into(),
                    provider_config_json: Some(format!(
                        r#"{{"version":1,"query":"{query}","groupFingerprint":"","knownItemIds":[]}}"#
                    )),
                    provider_data_json: Some("{}".into()),
                    last_synced_at: Some("2026-08-21T00:00:00Z".into()),
                },
            )
            .unwrap();
    }

    fn runner_item(item_id: &str, title: &str) -> AladinItem {
        AladinItem {
            item_id: item_id.into(),
            title: format!("{title} 1권"),
            author: Some("작가".into()),
            publisher: Some("출판사".into()),
            isbn13: Some(format!("isbn-{item_id}")),
            publication_date: None,
            item_url: None,
            volume_number: 1,
            base_title: title.into(),
            snapshot_json: format!(r#"{{"itemId":"{item_id}"}}"#),
        }
    }

    fn subscribe_at(library: &Library, collection_id: &str, checked_at: Option<&str>) {
        library
            .set_release_watch_enabled(collection_id, true)
            .unwrap();
        library
            .connection()
            .unwrap()
            .execute(
                "UPDATE release_watch_subscriptions SET last_checked_at = ?1
                 WHERE collection_id = ?2",
                params![checked_at, collection_id],
            )
            .unwrap();
    }

    fn seed_source(library: &Library, collection_id: &str, item_id: &str, title: &str) {
        library
            .connection()
            .unwrap()
            .execute(
                "INSERT INTO collection_volume_sources (
                    collection_id, volume_number, provider, provider_item_id, title,
                    author, publisher, isbn13, publication_date, item_url,
                    provider_data_json, created_at, updated_at
                 ) VALUES (?1, 1, 'aladin', ?2, ?3, '작가', '출판사', ?4,
                    NULL, NULL, ?5, 't', 't')",
                params![
                    collection_id,
                    item_id,
                    format!("{title} 1권"),
                    format!("isbn-{item_id}"),
                    format!(r#"{{"itemId":"{item_id}"}}"#),
                ],
            )
            .unwrap();
    }

    #[test]
    fn run_due_release_watch_checks_only_due_subscriptions_oldest_first() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        for (query, checked_at, has_source) in [
            ("never", None, true),
            ("oldest", Some("2026-08-20T12:00:00Z"), false),
            ("exact", Some("2026-08-21T12:00:00Z"), true),
            ("fresh", Some("2026-08-21T12:00:01Z"), false),
        ] {
            let collection_id = create_collection(&library, query, CollectionType::Manga);
            let item_id = format!("item-{query}");
            connect_aladin_with(&library, &collection_id, &item_id, query);
            subscribe_at(&library, &collection_id, checked_at);
            if has_source {
                seed_source(&library, &collection_id, &item_id, query);
            }
        }
        let mut calls = Vec::new();

        let result = library
            .run_due_release_watch_with("2026-08-22T12:00:00Z", |query| {
                calls.push(query.to_owned());
                Ok(vec![runner_item(&format!("item-{query}"), query)])
            })
            .unwrap();

        assert_eq!(calls, vec!["never", "oldest", "exact"]);
        assert_eq!(result.checked, 3);
        assert_eq!(result.changed_collections, 1);
        assert_eq!(result.skipped, 0);
        assert_eq!(result.stop_reason, None);
    }

    #[test]
    fn run_due_release_watch_skips_binding_failure_and_continues() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        for query in ["broken", "later"] {
            let collection_id = create_collection(&library, query, CollectionType::Manga);
            connect_aladin_with(&library, &collection_id, &format!("item-{query}"), query);
            subscribe_at(
                &library,
                &collection_id,
                Some(if query == "broken" {
                    "2026-08-20T12:00:00Z"
                } else {
                    "2026-08-21T12:00:00Z"
                }),
            );
        }
        let mut calls = Vec::new();

        let result = library
            .run_due_release_watch_with("2026-08-22T12:00:00Z", |query| {
                calls.push(query.to_owned());
                if query == "broken" {
                    Err(LibraryError::AmbiguousAladinBinding)
                } else {
                    Ok(vec![runner_item("item-later", "later")])
                }
            })
            .unwrap();

        assert_eq!(calls, vec!["broken", "later"]);
        assert_eq!(result.checked, 1);
        assert_eq!(result.changed_collections, 1);
        assert_eq!(result.skipped, 1);
        assert_eq!(result.stop_reason, None);
    }

    #[test]
    fn run_due_release_watch_stops_after_provider_wide_failure() {
        use crate::library::models::ReleaseWatchRunStopReason;

        let cases: [(fn() -> LibraryError, ReleaseWatchRunStopReason); 5] = [
            (
                || LibraryError::InvalidAladinCredential,
                ReleaseWatchRunStopReason::InvalidCredential,
            ),
            (
                || LibraryError::AladinRateLimited,
                ReleaseWatchRunStopReason::RateLimited,
            ),
            (
                || LibraryError::AladinTimedOut,
                ReleaseWatchRunStopReason::TimedOut,
            ),
            (
                || LibraryError::AladinUnavailable,
                ReleaseWatchRunStopReason::Unavailable,
            ),
            (
                || LibraryError::InvalidAladinResponse,
                ReleaseWatchRunStopReason::InvalidResponse,
            ),
        ];
        for (failure, expected_reason) in cases {
            let temp = tempfile::tempdir().unwrap();
            let library = Library::open(temp.path()).unwrap();
            for query in ["first", "later"] {
                let collection_id = create_collection(&library, query, CollectionType::Manga);
                connect_aladin_with(&library, &collection_id, &format!("item-{query}"), query);
                subscribe_at(&library, &collection_id, None);
            }
            let mut calls = 0;

            let result = library
                .run_due_release_watch_with("2026-08-22T12:00:00Z", |_query| {
                    calls += 1;
                    Err(failure())
                })
                .unwrap();

            assert_eq!(calls, 1);
            assert_eq!(result.checked, 0);
            assert_eq!(result.skipped, 0);
            assert_eq!(result.stop_reason, Some(expected_reason));
        }
    }

    #[test]
    fn subscription_requires_aladin_and_toggle_is_idempotent() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let collection_id = create_collection(&library, "Dungeon Meshi", CollectionType::Manga);

        assert_eq!(
            library.get_release_watch_status(&collection_id).unwrap(),
            crate::library::models::ReleaseWatchStatus {
                enabled: false,
                last_checked_at: None,
            }
        );
        assert!(matches!(
            library.get_release_watch_status("missing"),
            Err(LibraryError::CollectionNotFound)
        ));

        assert!(matches!(
            library.set_release_watch_enabled(&collection_id, true),
            Err(LibraryError::ReleaseWatchRequiresAladinBinding)
        ));

        connect_aladin(&library, &collection_id);
        for _ in 0..2 {
            let enabled = library
                .set_release_watch_enabled(&collection_id, true)
                .unwrap();
            assert!(enabled.enabled);
            assert_eq!(
                enabled.last_checked_at.as_deref(),
                Some("2026-08-21T00:00:00Z")
            );
            assert_eq!(
                library.get_release_watch_status(&collection_id).unwrap(),
                enabled
            );
        }
        for _ in 0..2 {
            let disabled = library
                .set_release_watch_enabled(&collection_id, false)
                .unwrap();
            assert!(!disabled.enabled);
            assert_eq!(disabled.last_checked_at, None);
        }
    }

    #[test]
    fn subscription_rejects_non_manga_collection() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let collection_id = create_collection(&library, "Astral Chain", CollectionType::Game);
        connect_aladin(&library, &collection_id);

        assert!(matches!(
            library.set_release_watch_enabled(&collection_id, true),
            Err(LibraryError::ReleaseWatchRequiresAladinBinding)
        ));
        assert_eq!(
            library
                .connection()
                .unwrap()
                .query_row(
                    "SELECT COUNT(*) FROM release_watch_subscriptions",
                    [],
                    |row| { row.get::<_, i64>(0) }
                )
                .unwrap(),
            0
        );
    }

    #[test]
    fn take_unread_release_changes_returns_and_marks_the_snapshot() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let collection_id = create_collection(&library, "Dungeon Meshi", CollectionType::Manga);
        connect_aladin(&library, &collection_id);
        library
            .set_release_watch_enabled(&collection_id, true)
            .unwrap();
        let connection = library.connection().unwrap();
        for (id, kind, volume_number, detected_at) in [
            (
                "event-2",
                "release_date_changed",
                12,
                "2026-08-22T00:00:01Z",
            ),
            ("event-1", "new_volume", 13, "2026-08-22T00:00:00Z"),
            (
                "event-3",
                "release_status_changed",
                11,
                "2026-08-22T00:00:02Z",
            ),
        ] {
            connection
                .execute(
                    "INSERT INTO release_watch_events (
                        id, collection_id, event_kind, volume_number,
                        previous_value, current_value, detected_at, read_at
                     ) VALUES (?1, ?2, ?3, ?4, 'before', 'after', ?5, NULL)",
                    rusqlite::params![id, collection_id, kind, volume_number, detected_at],
                )
                .unwrap();
        }
        connection
            .execute(
                "DELETE FROM release_watch_subscriptions WHERE collection_id = ?1",
                [&collection_id],
            )
            .unwrap();
        drop(connection);

        let events = library.take_unread_release_changes(&collection_id).unwrap();
        assert_eq!(events.len(), 3);
        assert_eq!(events[0].id, "event-1");
        assert_eq!(events[0].kind, ReleaseWatchEventKind::NewVolume);
        assert_eq!(events[0].volume_number, 13);
        assert_eq!(events[0].previous_value.as_deref(), Some("before"));
        assert_eq!(events[0].current_value.as_deref(), Some("after"));
        assert_eq!(events[0].detected_at, "2026-08-22T00:00:00Z");
        assert_eq!(events[1].kind, ReleaseWatchEventKind::ReleaseDateChanged);
        assert_eq!(events[2].kind, ReleaseWatchEventKind::ReleaseStatusChanged);
        assert!(library
            .take_unread_release_changes(&collection_id)
            .unwrap()
            .is_empty());
        assert_eq!(
            library
                .connection()
                .unwrap()
                .query_row(
                    "SELECT COUNT(*) FROM release_watch_events WHERE read_at IS NOT NULL",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            3
        );
    }
}
