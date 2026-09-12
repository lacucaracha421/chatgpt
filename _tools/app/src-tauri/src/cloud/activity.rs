use crate::library::{error::LibraryError, Library};
use rusqlite::params;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudActivity {
    pub direction: String,
    pub last_attempt_at: Option<String>,
    pub last_success_at: Option<String>,
    pub last_error: Option<String>,
    pub processed: u64,
    pub problems: u64,
    pub metadata_last_attempt_at: Option<String>,
    pub metadata_last_success_at: Option<String>,
    pub metadata_last_error: Option<String>,
}

impl Library {
    pub(crate) fn record_cloud_metadata_activity(&self, error: Option<&'static str>) -> Result<(), LibraryError> {
        self.connection()?.execute("UPDATE cloud_activity SET metadata_last_attempt_at = ?1,
            metadata_last_success_at = CASE WHEN ?2 IS NULL THEN ?1 ELSE metadata_last_success_at END,
            metadata_last_error = ?2 WHERE direction = 'replication'",
            params![chrono::Utc::now().to_rfc3339(), error])?;
        Ok(())
    }
    pub(crate) fn begin_cloud_activity(&self, direction: &str) -> Result<(), LibraryError> {
        self.connection()?.execute("UPDATE cloud_activity SET last_attempt_at = ?2 WHERE direction = ?1",
            params![direction, chrono::Utc::now().to_rfc3339()])?;
        Ok(())
    }

    // Callers pass fixed public messages only; transport errors may contain secrets/paths.
    pub(crate) fn finish_cloud_activity(&self, direction: &str, processed: u64, problems: u64, error: Option<&'static str>) -> Result<(), LibraryError> {
        self.connection()?.execute(
            "UPDATE cloud_activity SET processed = ?2, problems = ?3, last_error = ?4,
             last_success_at = CASE WHEN ?4 IS NULL AND ?3 = 0 THEN ?5 ELSE last_success_at END
             WHERE direction = ?1",
            params![direction, processed as i64, problems as i64, error, chrono::Utc::now().to_rfc3339()])?;
        Ok(())
    }
}

pub(crate) fn read_activity(connection: &rusqlite::Connection) -> Result<Vec<CloudActivity>, LibraryError> {
    let mut statement = connection.prepare("SELECT direction, last_attempt_at, last_success_at, last_error, processed, problems, metadata_last_attempt_at, metadata_last_success_at, metadata_last_error FROM cloud_activity ORDER BY direction")?;
    let rows = statement.query_map([], |row| Ok(CloudActivity {
        direction: row.get(0)?, last_attempt_at: row.get(1)?, last_success_at: row.get(2)?,
        last_error: row.get(3)?, processed: row.get::<_, i64>(4)? as u64, problems: row.get::<_, i64>(5)? as u64,
        metadata_last_attempt_at: row.get(6)?, metadata_last_success_at: row.get(7)?, metadata_last_error: row.get(8)?,
    }))?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cloud::models::CloudSyncConfig;

    #[test]
    fn cloud_settings_migration_preserves_disabled_and_paused_choices() {
        for (enabled, state, expected_replication) in [(0, "idle", 0), (1, "paused", 0), (1, "running", 1)] {
            let connection = rusqlite::Connection::open_in_memory().unwrap();
            connection.execute_batch("CREATE TABLE library_settings(cloud_sync_enabled INTEGER); CREATE TABLE cloud_backfill_control(state TEXT); CREATE TABLE assets(id TEXT); INSERT INTO assets VALUES ('preserved');").unwrap();
            connection.execute("INSERT INTO library_settings VALUES (?1)", [enabled]).unwrap();
            connection.execute("INSERT INTO cloud_backfill_control VALUES (?1)", [state]).unwrap();
            connection.execute_batch(include_str!("../../migrations/0038_cloud_settings.sql")).unwrap();
            let values: (i64, i64) = connection.query_row("SELECT cloud_sync_enabled, cloud_capture_enabled FROM library_settings", [], |row| Ok((row.get(0)?, row.get(1)?))).unwrap();
            assert_eq!(values, (expected_replication, enabled));
            assert_eq!(connection.query_row::<String, _, _>("SELECT id FROM assets", [], |row| row.get(0)).unwrap(), "preserved");
        }
    }

    #[test]
    fn cloud_settings_directions_are_independent_and_survive_reopening() {
        let temp = tempfile::tempdir().unwrap();
        {
            let library = Library::open(temp.path()).unwrap();
            library.set_cloud_settings(CloudSyncConfig { enabled: false, api_base_url: Some("https://example.test".into()) }, true).unwrap();
            assert!(!library.cloud_sync_config().unwrap().enabled);
            assert!(library.cloud_capture_enabled().unwrap());
        }
        let library = Library::open(temp.path()).unwrap();
        assert!(!library.cloud_sync_config().unwrap().enabled);
        assert!(library.cloud_capture_enabled().unwrap());
        library.set_cloud_settings(CloudSyncConfig { enabled: true, api_base_url: Some("https://example.test".into()) }, false).unwrap();
        assert!(library.cloud_sync_config().unwrap().enabled);
        assert!(!library.cloud_capture_enabled().unwrap());
    }

    #[test]
    fn cloud_activity_preserves_success_across_later_failure_and_restart() {
        let temp = tempfile::tempdir().unwrap();
        let success;
        {
            let library = Library::open(temp.path()).unwrap();
            library.begin_cloud_activity("capture").unwrap();
            library.finish_cloud_activity("capture", 3, 0, None).unwrap();
            success = read_activity(&library.connection().unwrap()).unwrap()[0].last_success_at.clone();
            library.begin_cloud_activity("capture").unwrap();
            library.finish_cloud_activity("capture", 0, 1, Some("연결 확인 필요")).unwrap();
        }
        let library = Library::open(temp.path()).unwrap();
        let activity = read_activity(&library.connection().unwrap()).unwrap();
        assert!(success.is_some());
        assert_eq!(activity[0].last_success_at, success);
        assert_eq!(activity[0].last_error.as_deref(), Some("연결 확인 필요"));
        assert_eq!(activity[0].problems, 1);
        assert_eq!(activity[1].last_attempt_at, None);
    }
}
