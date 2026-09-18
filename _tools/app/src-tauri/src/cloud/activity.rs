use crate::cloud::failure::CloudFailureReason;
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
    /// Machine-readable reason for `last_error`, when that failure has a known cause.
    /// A stable code from [`CloudFailureReason::code`], never formatted error text.
    pub last_reason: Option<String>,
    /// Machine-readable reason for `metadata_last_error`.
    pub metadata_last_reason: Option<String>,
}

impl Library {
    pub(crate) fn record_cloud_metadata_activity(&self, error: Option<&'static str>) -> Result<(), LibraryError> {
        self.record_cloud_metadata_activity_with(error, None)
    }

    /// Record the metadata publication outcome, with an optional structured reason.
    ///
    /// The reason is stored only when the pass failed; a later success clears both the
    /// message and the code so a stale cause cannot outlive the failure it described.
    pub(crate) fn record_cloud_metadata_activity_with(
        &self,
        error: Option<&'static str>,
        reason: Option<CloudFailureReason>,
    ) -> Result<(), LibraryError> {
        self.connection()?.execute("UPDATE cloud_activity SET metadata_last_attempt_at = ?1,
            metadata_last_success_at = CASE WHEN ?2 IS NULL THEN ?1 ELSE metadata_last_success_at END,
            metadata_last_error = ?2, metadata_last_reason = ?3 WHERE direction = 'replication'",
            params![chrono::Utc::now().to_rfc3339(), error, reason.map(CloudFailureReason::code)])?;
        Ok(())
    }
    pub(crate) fn begin_cloud_activity(&self, direction: &str) -> Result<(), LibraryError> {
        self.connection()?.execute("UPDATE cloud_activity SET last_attempt_at = ?2 WHERE direction = ?1",
            params![direction, chrono::Utc::now().to_rfc3339()])?;
        Ok(())
    }

    // Callers pass fixed public messages only; transport errors may contain secrets/paths.
    pub(crate) fn finish_cloud_activity(&self, direction: &str, processed: u64, problems: u64, error: Option<&'static str>) -> Result<(), LibraryError> {
        self.finish_cloud_activity_with(direction, processed, problems, error, None)
    }

    /// Record a pass outcome together with a structured reason for its failure.
    ///
    /// The reason describes the *pass-level* failure and is cleared whenever the recorded
    /// outcome has none, so a stale cause cannot outlive the failure it described. A pass
    /// that ran but had individual items rejected carries no reason: its per-item causes
    /// live with those items (`cloud_sync_queue.last_error`, the capture import row), not
    /// in one pass-level code.
    pub(crate) fn finish_cloud_activity_with(
        &self,
        direction: &str,
        processed: u64,
        problems: u64,
        error: Option<&'static str>,
        reason: Option<CloudFailureReason>,
    ) -> Result<(), LibraryError> {
        self.connection()?.execute(
            "UPDATE cloud_activity SET processed = ?2, problems = ?3, last_error = ?4, last_reason = ?6,
             last_success_at = CASE WHEN ?4 IS NULL AND ?3 = 0 THEN ?5 ELSE last_success_at END
             WHERE direction = ?1",
            params![direction, processed as i64, problems as i64, error, chrono::Utc::now().to_rfc3339(), reason.map(CloudFailureReason::code)])?;
        Ok(())
    }
}

pub(crate) fn read_activity(connection: &rusqlite::Connection) -> Result<Vec<CloudActivity>, LibraryError> {
    let mut statement = connection.prepare("SELECT direction, last_attempt_at, last_success_at, last_error, processed, problems, metadata_last_attempt_at, metadata_last_success_at, metadata_last_error, last_reason, metadata_last_reason FROM cloud_activity ORDER BY direction")?;
    let rows = statement.query_map([], |row| Ok(CloudActivity {
        direction: row.get(0)?, last_attempt_at: row.get(1)?, last_success_at: row.get(2)?,
        last_error: row.get(3)?, processed: row.get::<_, i64>(4)? as u64, problems: row.get::<_, i64>(5)? as u64,
        metadata_last_attempt_at: row.get(6)?, metadata_last_success_at: row.get(7)?, metadata_last_error: row.get(8)?,
        last_reason: row.get(9)?, metadata_last_reason: row.get(10)?,
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

    #[test]
    fn structured_reason_is_persisted_beside_the_human_message_and_cleared_on_success() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();

        library
            .finish_cloud_activity_with(
                "capture",
                0,
                1,
                Some("수신 연결을 확인하지 못했습니다. 서버 주소·연결 키와 네트워크를 확인해 주세요."),
                Some(CloudFailureReason::CredentialStoreLocked),
            )
            .unwrap();
        let activity = read_activity(&library.connection().unwrap()).unwrap();
        let capture = activity.iter().find(|row| row.direction == "capture").unwrap();
        // The operator sees the same message; the diagnosis is now machine-readable. A
        // locked keyring no longer has to be inferred from the absence of server requests.
        assert!(capture.last_error.as_deref().unwrap().starts_with("수신 연결을 확인하지 못했습니다"));
        assert_eq!(capture.last_reason.as_deref(), Some("credential_store_locked"));

        // A later success clears the failure and its reason together, so a stale cause
        // cannot describe a pass that has since succeeded.
        library.finish_cloud_activity_with("capture", 1, 0, None, None).unwrap();
        let activity = read_activity(&library.connection().unwrap()).unwrap();
        let capture = activity.iter().find(|row| row.direction == "capture").unwrap();
        assert_eq!(capture.last_reason, None);
        assert_eq!(capture.last_error, None);
        assert_eq!(capture.problems, 0);
    }

    #[test]
    fn metadata_reason_is_recorded_and_cleared_independently_of_media_replication() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();

        library
            .record_cloud_metadata_activity_with(
                Some("모바일 기록을 전송하지 못했습니다. 서버 연결을 확인해 주세요."),
                Some(CloudFailureReason::CredentialStoreLocked),
            )
            .unwrap();
        let activity = read_activity(&library.connection().unwrap()).unwrap();
        let replication = activity.iter().find(|row| row.direction == "replication").unwrap();
        assert_eq!(replication.metadata_last_reason.as_deref(), Some("credential_store_locked"));
        // The media-replication lane keeps its own state: one lane's credential failure
        // must not be written into the other's record.
        assert_eq!(replication.last_error, None);
        assert_eq!(replication.last_reason, None);

        library.record_cloud_metadata_activity_with(None, None).unwrap();
        let activity = read_activity(&library.connection().unwrap()).unwrap();
        let replication = activity.iter().find(|row| row.direction == "replication").unwrap();
        assert_eq!(replication.metadata_last_reason, None);
    }
}
