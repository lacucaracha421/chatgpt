use super::{
    error::LibraryError, models::ReleaseWatchEvent, release_watch::release_watch_event_from_row,
    Library,
};
use rusqlite::params;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VolumeOwnership {
    pub volume_number: i64,
    pub edition_index: u8,
    pub physical: bool,
    pub digital: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseInboxItem {
    pub collection_id: String,
    pub collection_name: String,
    pub event: ReleaseWatchEvent,
    pub provider: String,
}

impl Library {
    pub fn set_owned_volume_count(
        &self,
        collection_id: &str,
        edition_index: u8,
        count: i64,
    ) -> Result<Vec<VolumeOwnership>, LibraryError> {
        if edition_index > 3 || !(0..=2000).contains(&count) {
            return Err(LibraryError::InvalidCollectionMetadata);
        }
        {
            let mut connection = self.connection()?;
            super::collection::require_collection(&connection, collection_id)?;
            let transaction = connection.transaction()?;
            let authority = super::collection_authority::collection_write_status(&transaction)?;
            if authority.active {
                let kind: String = transaction.query_row(
                    "SELECT type FROM collections WHERE id=?1",
                    [collection_id],
                    |r| r.get(0),
                )?;
                if kind != "manga" {
                    return Err(LibraryError::InvalidCollectionType);
                }
                let (tracked, rows) = super::collection_authority::pending_ownership(
                    &transaction,
                    collection_id,
                    edition_index,
                )?;
                let held: Vec<_> = rows.iter().filter(|(_, row)| row.0 || row.1).collect();
                let expected = tracked.then_some(held.len() as i64);
                let same = expected == Some(count)
                    && held
                        .iter()
                        .zip(1..)
                        .all(|((v, row), n)| **v == n && row.0 && !row.1);
                if !same {
                    let key = serde_json::json!([collection_id, edition_index]).to_string();
                    super::collection_authority::enqueue_collection_command(
                        &transaction,
                        &authority,
                        "setOwnershipTracking",
                        &key,
                        serde_json::json!({"workId":collection_id,"editionIndex":edition_index,"count":count,"expectedCount":expected,"expectedRevision":null}),
                    )?;
                }
            } else if write_owned_volume_count(&transaction, collection_id, edition_index, count)? {
                // Ownership has no 0074 trigger; the Collection publication carries the counts.
                super::collection_personal_edits::bump_collections_generation(&transaction)?;
            }
            transaction.commit()?;
        }
        self.list_volume_ownership(collection_id)
    }

    pub fn list_ownership_tracking(&self, collection_id: &str) -> Result<Vec<u8>, LibraryError> {
        let connection = self.connection()?;
        super::collection::require_collection(&connection, collection_id)?;
        let mut statement = connection.prepare("SELECT edition_index FROM collection_ownership_tracking WHERE collection_id=?1 ORDER BY edition_index")?;
        let result = statement.query_map([collection_id], |row| row.get(0))?.collect::<Result<Vec<_>, _>>()?;
        Ok(result)
    }

    pub fn list_volume_ownership(&self, collection_id: &str) -> Result<Vec<VolumeOwnership>, LibraryError> {
        let connection = self.connection()?;
        super::collection::require_collection(&connection, collection_id)?;
        let volume_range = super::collection_volume_range::load(&connection, collection_id)?;
        let mut statement = connection.prepare(
            "SELECT volume_number, edition_index, physical, digital
             FROM collection_volume_ownership
             WHERE collection_id=?1
               AND (?2 IS NULL OR volume_number >= ?2)
               AND (?3 IS NULL OR volume_number <= ?3)
             ORDER BY edition_index,volume_number",
        )?;
        let result = statement.query_map(
            rusqlite::params![collection_id, volume_range.min_volume, volume_range.max_volume],
            |row| Ok(VolumeOwnership {
                volume_number: row.get(0)?,
                edition_index: row.get(1)?,
                physical: row.get(2)?,
                digital: row.get(3)?,
            }),
        )?.collect::<Result<Vec<_>, _>>()?;
        Ok(result)
    }

    pub fn set_volume_ownership(
        &self,
        collection_id: &str,
        edition_index: u8,
        volume_numbers: Vec<i64>,
        format: &str,
        owned: bool,
    ) -> Result<Vec<VolumeOwnership>, LibraryError> {
        if edition_index > 3
            || volume_numbers.is_empty()
            || volume_numbers.len() > 2000
            || volume_numbers.iter().any(|v| *v <= 0 || *v > 10000)
            || !matches!(format, "physical" | "digital")
        {
            return Err(LibraryError::InvalidCollectionMetadata);
        }
        {
            let mut connection = self.connection()?;
            super::collection::require_collection(&connection, collection_id)?;
            let kind: String = connection.query_row(
                "SELECT type FROM collections WHERE id=?1",
                [collection_id],
                |row| row.get(0),
            )?;
            if kind != "manga" {
                return Err(LibraryError::InvalidCollectionMetadata);
            }
            let transaction = connection.transaction()?;
            let authority = super::collection_authority::collection_write_status(&transaction)?;
            if authority.active {
                let (_, rows) = super::collection_authority::pending_ownership(
                    &transaction,
                    collection_id,
                    edition_index,
                )?;
                for volume in volume_numbers
                    .into_iter()
                    .collect::<std::collections::BTreeSet<_>>()
                {
                    let key = serde_json::json!([collection_id, volume, edition_index]).to_string();
                    let (mut physical, mut digital, revision) =
                        rows.get(&volume).copied().unwrap_or((false, false, 0));
                    if (if format == "physical" {
                        physical
                    } else {
                        digital
                    }) == owned
                    {
                        continue;
                    }
                    if format == "physical" {
                        physical = owned;
                    } else {
                        digital = owned;
                    }
                    super::collection_authority::enqueue_collection_command(
                        &transaction,
                        &authority,
                        "setVolumeOwnership",
                        &key,
                        serde_json::json!({"workId":collection_id,"volumeNumber":volume,"editionIndex":edition_index,"physical":physical,"digital":digital,"expectedRevision":revision}),
                    )?;
                }
                transaction.commit()?;
                drop(connection);
                return self.list_volume_ownership(collection_id);
            }
            // The column name is a closed, validated format, never user SQL.
            let sql = format!("INSERT INTO collection_volume_ownership(collection_id,volume_number,edition_index,{format}) VALUES(?1,?2,?3,?4) ON CONFLICT(collection_id,volume_number,edition_index) DO UPDATE SET {format}=excluded.{format}");
            transaction.execute("INSERT OR IGNORE INTO collection_ownership_tracking(collection_id,edition_index) VALUES(?1,?2)", params![collection_id, edition_index])?;
            for volume in volume_numbers {
                transaction.execute(&sql, params![collection_id, volume, edition_index, owned])?;
            }
            transaction.execute("DELETE FROM collection_volume_ownership WHERE collection_id=?1 AND physical=0 AND digital=0", [collection_id])?;
            super::collection_personal_edits::bump_collections_generation(&transaction)?;
            transaction.commit()?;
        }
        self.list_volume_ownership(collection_id)
    }

    pub fn list_release_inbox(&self) -> Result<Vec<ReleaseInboxItem>, LibraryError> {
        let connection = self.connection()?;
        let mut statement = connection.prepare("SELECT e.id,e.event_kind,e.volume_number,e.previous_value,e.current_value,e.detected_at,e.collection_id,c.name,e.provider FROM release_watch_events e JOIN collections c ON c.id=e.collection_id WHERE e.read_at IS NULL ORDER BY e.detected_at DESC,e.rowid DESC")?;
        let result = statement.query_map([], |row| Ok(ReleaseInboxItem {
            provider: row.get(8)?,
            collection_id: row.get(6)?, collection_name: row.get(7)?, event: release_watch_event_from_row(row)?,
        }))?.collect::<Result<Vec<_>, _>>()?;
        Ok(result)
    }

    /// Every manga Collection's 신간 알림 state, owned counts and release schedule.
    pub(crate) fn list_release_board(&self) -> Result<Vec<crate::cloud::collections::ReleaseBoardEntry>, LibraryError> {
        let connection = self.connection()?;
        crate::cloud::collections::release_board(&connection)
    }

    pub fn acknowledge_release_events(
        &self,
        collection_id: &str,
        event_ids: Vec<String>,
    ) -> Result<(), LibraryError> {
        if event_ids.len() > 2000 {
            return Err(LibraryError::InvalidCollectionMetadata);
        }
        let mut connection = self.connection()?;
        super::collection::require_collection(&connection, collection_id)?;
        let transaction = connection.transaction()?;
        let authority = super::collection_authority::collection_write_status(&transaction)?;
        if authority.active {
            super::collection_authority::enqueue_release_ack(
                &transaction,
                &authority,
                collection_id,
                &event_ids,
            )?;
        } else {
            acknowledge_release_events_in(
                &transaction,
                collection_id,
                &event_ids,
                &chrono::Utc::now().to_rfc3339(),
            )?;
        }
        transaction.commit()?;
        Ok(())
    }
}

/// Mark exactly these unread events of one Collection read; unknown or already read ids are
/// no-ops. Returns how many events changed. Shared by the PC inbox and the mobile read log.
pub(super) fn acknowledge_release_events_in(
    connection: &rusqlite::Connection,
    collection_id: &str,
    event_ids: &[String],
    now: &str,
) -> Result<usize, LibraryError> {
    super::collection_authority::fence_collection_operation(connection)?;
    let mut changed = 0;
    for id in event_ids {
        changed += connection.execute("UPDATE release_watch_events SET read_at=?1 WHERE collection_id=?2 AND id=?3 AND read_at IS NULL", params![now,collection_id,id])?;
    }
    Ok(changed)
}

/// Own volumes 1..=count of one edition as physical, replacing that edition's per-volume
/// detail and marking it tracked (the PC count control). Returns whether anything changed;
/// an edition already in exactly that state is left alone. Non-manga is `InvalidCollectionType`.
pub(super) fn write_owned_volume_count(
    connection: &rusqlite::Connection,
    collection_id: &str,
    edition_index: u8,
    count: i64,
) -> Result<bool, LibraryError> {
    super::collection_authority::fence_collection_operation(connection)?;
    if edition_index > 3 || !(0..=2000).contains(&count) {
        return Err(LibraryError::InvalidCollectionMetadata);
    }
    let kind: String = connection.query_row(
        "SELECT type FROM collections WHERE id=?1",
        [collection_id],
        |row| row.get(0),
    )?;
    if kind != "manga" {
        return Err(LibraryError::InvalidCollectionType);
    }
    let tracked: bool = connection.query_row("SELECT EXISTS(SELECT 1 FROM collection_ownership_tracking WHERE collection_id=?1 AND edition_index=?2)", params![collection_id, edition_index], |row| row.get(0))?;
    let rows = connection.prepare("SELECT volume_number, physical, digital FROM collection_volume_ownership WHERE collection_id=?1 AND edition_index=?2 ORDER BY volume_number")?
        .query_map(params![collection_id, edition_index], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, bool>(1)?, row.get::<_, bool>(2)?)))?
        .collect::<Result<Vec<_>, _>>()?;
    let same = tracked
        && rows.len() as i64 == count
        && rows
            .iter()
            .zip(1..)
            .all(|(&(volume, physical, digital), expected)| {
                volume == expected && physical && !digital
            });
    if same {
        return Ok(false);
    }
    connection.execute(
        "DELETE FROM collection_volume_ownership WHERE collection_id=?1 AND edition_index=?2",
        params![collection_id, edition_index],
    )?;
    connection.execute("INSERT OR IGNORE INTO collection_ownership_tracking(collection_id,edition_index) VALUES(?1,?2)", params![collection_id, edition_index])?;
    for volume in 1..=count {
        connection.execute("INSERT INTO collection_volume_ownership(collection_id,volume_number,edition_index,physical,digital) VALUES(?1,?2,?3,1,0)", params![collection_id,volume,edition_index])?;
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn library() -> (tempfile::TempDir, Library) {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        library.connection().unwrap().execute("INSERT INTO collections(id,name,type,created_at,updated_at) VALUES('m','Manga','manga','t','t')", []).unwrap();
        (temp, library)
    }
    #[test]
    fn ownership_preserves_both_formats_and_separate_editions() {
        let (_temp, library) = library();
        library.set_volume_ownership("m", 0, vec![1,2,3], "physical", true).unwrap();
        library.set_volume_ownership("m", 0, vec![2], "digital", true).unwrap();
        library.set_volume_ownership("m", 1, vec![2], "physical", true).unwrap();
        let entries = library.set_volume_ownership("m", 0, vec![2], "physical", false).unwrap();
        assert_eq!(entries.len(), 4);
        assert!(!entries[1].physical && entries[1].digital);
        assert_eq!(entries[3].edition_index, 1);
        assert!(library.set_volume_ownership("m", 0, vec![0], "physical", true).is_err());
        assert!(library.set_volume_ownership("m", 0, vec![1], "other", true).is_err());
    }
    #[test]
    fn owned_count_replaces_both_formats_and_can_decrease_to_zero() {
        let (_temp, library) = library();
        library.set_volume_ownership("m", 0, vec![7], "digital", true).unwrap();
        library.set_volume_ownership("m", 1, vec![2], "digital", true).unwrap();
        let data = library.set_owned_volume_count("m", 0, 3).unwrap();
        assert_eq!(data.iter().filter(|entry| entry.edition_index == 0).count(), 3);
        let data = library.set_owned_volume_count("m", 0, 0).unwrap();
        assert_eq!(data.len(), 1);
        assert_eq!(data[0].edition_index, 1);
    }

    #[test]
    fn v40_upgrade_preserves_existing_release_events() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("library.sqlite");
        let mut connection = rusqlite::Connection::open(&path).unwrap();
        connection.pragma_update(None, "foreign_keys", "OFF").unwrap();
        let mut files = std::fs::read_dir(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("migrations"))
            .unwrap().map(|entry| entry.unwrap().path())
            .filter(|path| path.extension().is_some_and(|extension| extension == "sql"))
            .collect::<Vec<_>>();
        files.sort();
        let transaction = connection.transaction().unwrap();
        for file in files.iter().take(40) {
            transaction.execute_batch(&std::fs::read_to_string(file).unwrap()).unwrap();
        }
        transaction.commit().unwrap();
        connection.pragma_update(None, "foreign_keys", "ON").unwrap();
        connection.execute("INSERT INTO collections(id,name,type,created_at,updated_at) VALUES('m','Manga','manga','t','t')", []).unwrap();
        connection.execute("INSERT INTO release_watch_events(id,collection_id,event_kind,volume_number,detected_at) VALUES('old','m','new_volume',7,'t')", []).unwrap();
        drop(connection);
        let upgraded = Library::open(temp.path()).unwrap();
        assert_eq!(upgraded.list_release_inbox().unwrap()[0].event.id, "old");
        assert!(upgraded.list_volume_ownership("m").unwrap().is_empty());
        assert_eq!(upgraded.connection().unwrap().query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0)).unwrap(), super::super::db::SCHEMA_VERSION);
    }

    #[test]
    fn reading_inbox_does_not_acknowledge_and_confirmation_is_exact() {
        let (_temp, library) = library();
        library.connection().unwrap().execute("INSERT INTO release_watch_events(id,collection_id,event_kind,volume_number,detected_at) VALUES('e1','m','new_volume',4,'t'),('e2','m','new_volume',5,'t')", []).unwrap();
        assert_eq!(library.list_release_inbox().unwrap().len(), 2);
        assert_eq!(library.list_release_inbox().unwrap().len(), 2);
        library.acknowledge_release_events("m", vec!["e1".into()]).unwrap();
        let remaining = library.list_release_inbox().unwrap();
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].event.id, "e2");
        assert!(library.list_volume_ownership("m").unwrap().is_empty());
    }
}
