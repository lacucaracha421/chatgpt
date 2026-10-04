//! Explicit, verification-only authority check. The report belongs to app-local data.
use super::{
    client::CloudClient,
    collections::ReplicaFeatures,
    publication::{report, Reporter},
};
use crate::library::{credential, error::LibraryError, Library};
use serde::Serialize;
use serde_json::Value;
use std::{
    path::{Path, PathBuf},
    sync::Mutex,
};

const MAX_STAGING_BYTES: usize = 128 * 1024 * 1024;
static VERIFY: Mutex<()> = Mutex::new(());

#[derive(Debug)]
pub(crate) enum VerifyError {
    Library(LibraryError),
    Http(u16),
    TooLarge,
    Save,
    Busy,
}
impl From<LibraryError> for VerifyError {
    fn from(error: LibraryError) -> Self {
        Self::Library(error)
    }
}
impl From<VerifyError> for crate::commands::CommandError {
    fn from(error: VerifyError) -> Self {
        let (code, message) = match error {
            VerifyError::Library(error) => return error.into(),
            VerifyError::Http(401 | 403) => return LibraryError::CloudUnauthorized.into(),
            VerifyError::Http(404) => (
                "collection_authority_verify_unsupported",
                "서버가 컬렉션 이전 점검을 지원하지 않습니다.",
            ),
            VerifyError::Http(413) | VerifyError::TooLarge => (
                "collection_authority_verify_too_large",
                "점검 자료가 서버의 크기 제한을 넘었습니다.",
            ),
            VerifyError::Http(_) => (
                "collection_authority_verify_rejected",
                "서버가 컬렉션 이전 점검을 처리하지 못했습니다.",
            ),
            VerifyError::Save => (
                "collection_authority_report_save_failed",
                "점검 보고서를 PC에 저장하지 못했습니다.",
            ),
            VerifyError::Busy => (
                "collection_authority_verify_busy",
                "컬렉션 이전 점검이 이미 진행 중입니다.",
            ),
        };
        Self {
            code,
            message: message.into(),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyResult {
    pub report: Value,
    pub report_path: String,
}

impl Library {
    pub(crate) fn verify_collection_authority_baseline(
        &self,
        data_dir: &Path,
        progress: Reporter<'_>,
    ) -> Result<VerifyResult, VerifyError> {
        let _guard = VERIFY.try_lock().map_err(|_| VerifyError::Busy)?;
        self.ensure_cloud_send()?;
        report(progress, "connecting", 0, None, "items");
        let config = self.cloud_sync_config()?;
        let endpoint = config
            .api_base_url
            .as_deref()
            .ok_or(LibraryError::InvalidCloudSyncConfig)?;
        let client = self.cloud_client(endpoint)?;
        let token = credential::read_cloud_api_token_os()?;
        let publisher = credential::read_cloud_publisher_token_os()?;
        self.verify_collection_authority_with(
            &client,
            endpoint,
            token.expose(),
            publisher.expose(),
            data_dir,
            progress,
        )
    }

    pub(crate) fn verify_collection_authority_with(
        &self,
        client: &CloudClient,
        endpoint: &str,
        token: &str,
        publisher: &str,
        data_dir: &Path,
        progress: Reporter<'_>,
    ) -> Result<VerifyResult, VerifyError> {
        self.ensure_send_to(endpoint)?;
        client.ensure_send()?;
        let status = client.collections_status(token)?;
        // prepare already receives without the idle-poll claim; its existing handshake
        // and library/cursor checks still apply.
        let feature =
            self.prepare_collection_personal_edits(client, endpoint, &status, Some(publisher))?;
        self.receive_collection_bindings_now(client, publisher, endpoint)?;
        self.receive_collection_release_reads_now(client, publisher, endpoint)?;
        let published =
            self.push_cloud_collections_with(client, endpoint, token, Some(publisher), progress)?;
        let baseline = self.collection_authority_baseline(
            endpoint,
            &published.revision,
            feature.as_ref(),
            ReplicaFeatures::from_status(&status),
            progress,
        )?;
        let bytes =
            serde_json::to_vec(&baseline).map_err(|_| LibraryError::InvalidCloudResponse)?;
        if bytes.len() > MAX_STAGING_BYTES {
            return Err(VerifyError::TooLarge);
        }
        report(progress, "publishing", 0, Some(1), "items");
        let report_value = client.verify_collection_authority(&bytes, publisher)?;
        let path = save_report(data_dir, &report_value)?;
        report(progress, "publishing", 1, Some(1), "items");
        Ok(VerifyResult {
            report: report_value,
            report_path: path.to_string_lossy().into_owned(),
        })
    }
}

fn save_report(data_dir: &Path, report: &Value) -> Result<PathBuf, VerifyError> {
    let directory = data_dir.join("collection-authority");
    std::fs::create_dir_all(&directory).map_err(|_| VerifyError::Save)?;
    let name = format!(
        "verify-{}.json",
        chrono::Utc::now().format("%Y%m%dT%H%M%S%.9fZ")
    );
    let path = directory.join(name);
    let mut temporary =
        tempfile::NamedTempFile::new_in(&directory).map_err(|_| VerifyError::Save)?;
    serde_json::to_writer_pretty(&mut temporary, report).map_err(|_| VerifyError::Save)?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|_| VerifyError::Save)?;
    temporary
        .persist_noclobber(&path)
        .map_err(|_| VerifyError::Save)?;
    Ok(path)
}

#[cfg(test)]
mod collection_baseline_command_tests {
    use super::*;
    use crate::library::collection_personal_edits::tests::{configure, scripted};
    use serde_json::json;

    #[test]
    fn receives_now_publishes_then_verifies_with_the_publisher_and_saves_report() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path().join("library")).unwrap();
        let id = library.library_id().unwrap();
        let status = json!({"revision":"old", "libraryId":id, "collectionTypes":["game","manga","movie","av"],
            "replicaFeatures":["workRecord","coverFocus","people","portraitImage"],
            "capabilities":{"collectionPersonalEdit":true,"collectionTrackingEdit":true,"collectionRecordEdit":true}}).to_string();
        let edits =
            json!({"version":1,"libraryId":id,"after":0,"nextCursor":0,"hasMore":false,"items":[]})
                .to_string();
        let empty_log = json!({"version":1,"after":0,"lastSequence":0,"nextCursor":0,"hasMore":false,"items":[]}).to_string();
        let report = json!({"version":1,"verdict":"blocked","validation":{"code":"fixture","message":"Fixture report","detail":{}}});
        let (base, server) = scripted(vec![
            ("/v1/collections/status", 200, status.clone()),
            ("/v1/collections/personal-edits", 200, edits.clone()),
            ("/v1/collections/bindings", 200, empty_log.clone()),
            ("/v1/collections/releases/reads", 200, empty_log),
            ("/v1/collections/status", 200, status),
            ("/v1/collections/personal-edits", 200, edits),
            (
                "/v1/collections?",
                200,
                json!({"revision":"old"}).to_string(),
            ),
            (
                "/v1/collections/replica",
                200,
                json!({"revision":"published"}).to_string(),
            ),
            (
                "/v1/collections/authority/staging/verify",
                200,
                report.to_string(),
            ),
        ]);
        configure(&library, &base);
        // Polls are not due, but an explicit verification must still receive now.
        let future = chrono::Utc::now().timestamp() + 3600;
        for prefix in ["collectionBindingSync", "collectionReleaseSync"] {
            library
                .connection()
                .unwrap()
                .execute(
                    "INSERT INTO notes_state(key,value) VALUES(?1,?2)",
                    rusqlite::params![
                        format!("{prefix}:{base}"),
                        json!({"lastPolled":future}).to_string()
                    ],
                )
                .unwrap();
        }
        let client = library.cloud_client(&base).unwrap();
        let result = library
            .verify_collection_authority_with(
                &client,
                &base,
                "shared",
                "publisher",
                &temp.path().join("app-data"),
                &|_| {},
            )
            .unwrap();
        let seen = server.join().unwrap();
        assert_eq!(seen.len(), 9);
        for i in [1, 2, 3, 5, 7, 8] {
            assert_eq!(seen[i].1.as_deref(), Some("Bearer publisher"));
        }
        let baseline: Value = serde_json::from_str(&seen[8].2).unwrap();
        assert_eq!(baseline["stagingVersion"], 2);
        assert_eq!(baseline["legacyRevision"], "published");
        assert_eq!(baseline["libraryId"], id);
        assert_eq!(result.report, report);
        assert!(!Path::new(&result.report_path).starts_with(library.root()));
        assert_eq!(
            serde_json::from_slice::<Value>(&std::fs::read(result.report_path).unwrap()).unwrap(),
            report
        );
    }

    #[test]
    fn forced_receives_keep_failure_backoff_without_network_requests() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let base = "http://127.0.0.1:9";
        configure(&library, base);
        let future = chrono::Utc::now().timestamp() + 3600;
        for prefix in ["collectionBindingSync", "collectionReleaseSync"] {
            library
                .connection()
                .unwrap()
                .execute(
                    "INSERT INTO notes_state(key,value) VALUES(?1,?2)",
                    rusqlite::params![
                        format!("{prefix}:{base}"),
                        json!({"retryAfter":future,"lastPolled":1}).to_string()
                    ],
                )
                .unwrap();
        }
        let client = library.cloud_client(base).unwrap();
        library
            .receive_collection_bindings_now(&client, "publisher", base)
            .unwrap();
        library
            .receive_collection_release_reads_now(&client, "publisher", base)
            .unwrap();
        assert_eq!(
            library
                .collection_binding_sync_state(base)
                .unwrap()
                .retry_after,
            future
        );
        assert_eq!(
            library
                .collection_binding_sync_state(base)
                .unwrap()
                .last_polled,
            1
        );
        assert_eq!(
            library
                .collection_release_sync_state(base)
                .unwrap()
                .retry_after,
            future
        );
        assert_eq!(
            library
                .collection_release_sync_state(base)
                .unwrap()
                .last_polled,
            1
        );
    }

    #[test]
    fn http_failures_are_mapped_and_invalid_reports_are_rejected() {
        for status in [401, 403, 404, 413, 422, 500, 200] {
            let (base, server) = scripted(vec![(
                "/v1/collections/authority/staging/verify",
                status,
                "{\"secret\":\"must not echo\"}".into(),
            )]);
            let client = CloudClient::new(&base).unwrap();
            let error = client
                .verify_collection_authority(b"{}", "publisher")
                .unwrap_err();
            if status == 200 {
                assert!(matches!(
                    error,
                    VerifyError::Library(LibraryError::InvalidCloudResponse)
                ));
            } else {
                assert!(matches!(error,VerifyError::Http(s) if s==status));
            }
            let mapped = crate::commands::CommandError::from(error);
            assert!(!mapped.message.contains("secret"));
            assert_eq!(
                server.join().unwrap()[0].1.as_deref(),
                Some("Bearer publisher")
            );
        }
    }
    #[test]
    fn maps_errors_without_echoing_server_payloads() {
        for (status, code) in [
            (404, "collection_authority_verify_unsupported"),
            (413, "collection_authority_verify_too_large"),
            (422, "collection_authority_verify_rejected"),
            (500, "collection_authority_verify_rejected"),
        ] {
            assert_eq!(
                crate::commands::CommandError::from(VerifyError::Http(status)).code,
                code
            );
        }
        for status in [401, 403] {
            assert_eq!(
                crate::commands::CommandError::from(VerifyError::Http(status)).code,
                crate::commands::CommandError::from(LibraryError::CloudUnauthorized).code
            );
        }
        assert_eq!(
            crate::commands::CommandError::from(VerifyError::Save).code,
            "collection_authority_report_save_failed"
        );
        assert_eq!(
            crate::commands::CommandError::from(VerifyError::Busy).code,
            "collection_authority_verify_busy"
        );
    }
    #[test]
    fn saves_the_unmodified_report_in_app_data() {
        let temp = tempfile::tempdir().unwrap();
        let report =
            serde_json::json!({"version":1,"verdict":"blocked","validation":{"code":"fixture"}});
        let path = save_report(temp.path(), &report).unwrap();
        assert_eq!(
            path.parent().unwrap(),
            temp.path().join("collection-authority")
        );
        assert!(path
            .file_name()
            .unwrap()
            .to_str()
            .unwrap()
            .starts_with("verify-"));
        assert_eq!(
            serde_json::from_slice::<Value>(&std::fs::read(path).unwrap()).unwrap(),
            report
        );
    }
}
