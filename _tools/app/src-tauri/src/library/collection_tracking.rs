use rusqlite::params;
use serde::{Deserialize, Serialize};
use super::{Library, error::LibraryError, models::ReleaseWatchEvent, release_watch::release_watch_event_from_row};

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
}

impl Library {
    pub fn set_owned_volume_count(&self, collection_id: &str, edition_index: u8, count: i64) -> Result<Vec<VolumeOwnership>, LibraryError> {
        if edition_index > 3 || !(0..=2000).contains(&count) { return Err(LibraryError::InvalidCollectionMetadata); }
        {
            let mut connection = self.connection()?;
            super::collection::require_collection(&connection, collection_id)?;
            let kind: String = connection.query_row("SELECT type FROM collections WHERE id=?1", [collection_id], |row| row.get(0))?;
            if kind != "manga" { return Err(LibraryError::InvalidCollectionType); }
            let transaction = connection.transaction()?;
            transaction.execute("DELETE FROM collection_volume_ownership WHERE collection_id=?1 AND edition_index=?2", params![collection_id, edition_index])?;
            for volume in 1..=count {
                transaction.execute("INSERT INTO collection_volume_ownership(collection_id,volume_number,edition_index,physical,digital) VALUES(?1,?2,?3,1,0)", params![collection_id,volume,edition_index])?;
            }
            transaction.commit()?;
        }
        self.list_volume_ownership(collection_id)
    }

    pub fn list_volume_ownership(&self, collection_id: &str) -> Result<Vec<VolumeOwnership>, LibraryError> {
        let connection = self.connection()?;
        super::collection::require_collection(&connection, collection_id)?;
        let mut statement = connection.prepare("SELECT volume_number, edition_index, physical, digital FROM collection_volume_ownership WHERE collection_id=?1 ORDER BY edition_index,volume_number")?;
        let result = statement.query_map([collection_id], |row| Ok(VolumeOwnership {
            volume_number: row.get(0)?, edition_index: row.get(1)?, physical: row.get(2)?, digital: row.get(3)?,
        }))?.collect::<Result<Vec<_>, _>>()?;
        Ok(result)
    }

    pub fn set_volume_ownership(&self, collection_id: &str, edition_index: u8, volume_numbers: Vec<i64>, format: &str, owned: bool) -> Result<Vec<VolumeOwnership>, LibraryError> {
        if edition_index > 3 || volume_numbers.is_empty() || volume_numbers.len() > 2000 || volume_numbers.iter().any(|v| *v <= 0 || *v > 10000) || !matches!(format, "physical" | "digital") {
            return Err(LibraryError::InvalidCollectionMetadata);
        }
        {
            let mut connection = self.connection()?;
            super::collection::require_collection(&connection, collection_id)?;
            let kind: String = connection.query_row("SELECT type FROM collections WHERE id=?1", [collection_id], |row| row.get(0))?;
            if kind != "manga" { return Err(LibraryError::InvalidCollectionMetadata); }
            let transaction = connection.transaction()?;
            // The column name is a closed, validated format, never user SQL.
            let sql = format!("INSERT INTO collection_volume_ownership(collection_id,volume_number,edition_index,{format}) VALUES(?1,?2,?3,?4) ON CONFLICT(collection_id,volume_number,edition_index) DO UPDATE SET {format}=excluded.{format}");
            for volume in volume_numbers {
                transaction.execute(&sql, params![collection_id, volume, edition_index, owned])?;
            }
            transaction.execute("DELETE FROM collection_volume_ownership WHERE collection_id=?1 AND physical=0 AND digital=0", [collection_id])?;
            transaction.commit()?;
        }
        self.list_volume_ownership(collection_id)
    }

    pub fn list_release_inbox(&self) -> Result<Vec<ReleaseInboxItem>, LibraryError> {
        let connection = self.connection()?;
        let mut statement = connection.prepare("SELECT e.id,e.event_kind,e.volume_number,e.previous_value,e.current_value,e.detected_at,e.collection_id,c.name FROM release_watch_events e JOIN collections c ON c.id=e.collection_id WHERE e.read_at IS NULL ORDER BY e.detected_at DESC,e.rowid DESC")?;
        let result = statement.query_map([], |row| Ok(ReleaseInboxItem {
            collection_id: row.get(6)?, collection_name: row.get(7)?, event: release_watch_event_from_row(row)?,
        }))?.collect::<Result<Vec<_>, _>>()?;
        Ok(result)
    }

    pub fn acknowledge_release_events(&self, collection_id: &str, event_ids: Vec<String>) -> Result<(), LibraryError> {
        if event_ids.len() > 2000 { return Err(LibraryError::InvalidCollectionMetadata); }
        let mut connection = self.connection()?;
        super::collection::require_collection(&connection, collection_id)?;
        let transaction = connection.transaction()?;
        let now = chrono::Utc::now().to_rfc3339();
        for id in event_ids {
            transaction.execute("UPDATE release_watch_events SET read_at=?1 WHERE collection_id=?2 AND id=?3 AND read_at IS NULL", params![now,collection_id,id])?;
        }
        transaction.commit()?;
        Ok(())
    }
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
