use rusqlite::{params, OptionalExtension};

use super::{
    collection::require_collection,
    error::LibraryError,
    models::{ReleaseWatchEvent, ReleaseWatchEventKind, ReleaseWatchStatus},
    Library,
};

impl Library {
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
                 ORDER BY detected_at, id",
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
    use crate::library::{
        error::LibraryError,
        models::{CollectionType, CreateCollection, ExternalBindingInput, ReleaseWatchEventKind},
        Library,
    };

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
        library
            .upsert_collection_external_binding(
                collection_id,
                ExternalBindingInput {
                    provider: "aladin".into(),
                    external_id: "item-1".into(),
                    provider_config_json: Some("{}".into()),
                    provider_data_json: Some("{}".into()),
                    last_synced_at: Some("2026-08-21T00:00:00Z".into()),
                },
            )
            .unwrap();
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
