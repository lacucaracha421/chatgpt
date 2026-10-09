//! Handover of Kakao new-volume checks to the server (SERVER-INDEP-001, slice 2).
//!
//! While the cached authority status advertises `serverReleaseChecks:kakao`, the server
//! checks Kakao volumes by itself once a day. The PC then does no local Kakao work: its
//! update status is the server's, and the 신간 새로고침 asks the server to check now.
//! Without the feature (old server, switch off, cloud sync off) nothing here applies and
//! the local worker runs exactly as before. MangaDex always stays local.
use serde::Serialize;
use serde_json::Value;

use super::{
    collection_authority::collection_write_status, collection_updates::CollectionUpdateStatus,
    error::LibraryError, Library,
};
use crate::cloud::client::ReleaseCheckRun;

pub(crate) const KAKAO_FEATURE: &str = "serverReleaseChecks:kakao";

/// What `request_server_release_check` did. `Local`: the server is not in charge of this
/// provider (right now), so the caller keeps its ordinary local check.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "outcome")]
pub enum ServerReleaseCheck {
    Local,
    Started {
        status: CollectionUpdateStatus,
    },
    #[serde(rename_all = "camelCase")]
    RateLimited {
        retry_after_seconds: Option<u64>,
    },
}

/// The provider's `CollectionUpdateStatus` from a server status object. A failure detail
/// this build cannot read is dropped rather than hiding the whole status.
fn parse_status(value: &Value, provider: &str) -> Option<CollectionUpdateStatus> {
    let read = |value: &Value| serde_json::from_value::<CollectionUpdateStatus>(value.clone()).ok();
    let mut status = read(value).or_else(|| {
        let mut trimmed = value.clone();
        trimmed
            .as_object_mut()?
            .insert("lastFailure".into(), Value::Null);
        read(&trimmed)
    })?;
    status.provider = provider.into();
    Some(status)
}

impl Library {
    /// Whether the server currently owns `provider`'s new-volume checks.
    pub fn server_release_checks_enabled(&self, provider: &str) -> bool {
        provider == "kakao"
            && self
                .connection()
                .ok()
                .and_then(|db| collection_write_status(&db).ok())
                .is_some_and(|status| {
                    status.active && status.features.iter().any(|f| f == KAKAO_FEATURE)
                })
    }

    pub(super) fn server_collection_update_status_with(
        &self,
        provider: &str,
        fetch: &dyn Fn() -> Result<Option<Value>, LibraryError>,
    ) -> Result<Option<CollectionUpdateStatus>, LibraryError> {
        if !self.server_release_checks_enabled(provider) {
            return Ok(None);
        }
        match fetch() {
            // 404: the server switched the checks off since the last sync - local again.
            Ok(None) => Ok(None),
            // An unreachable or unreadable server is an error, not this PC's status: the
            // screen keeps its last server numbers instead of flipping to local ones.
            Ok(Some(value)) => parse_status(&value["providers"][provider], provider)
                .map(Some)
                .ok_or(LibraryError::InvalidCloudResponse),
            Err(error) => Err(error),
        }
    }

    /// 새로고침 for the server-owned provider: wake the server's checker now.
    pub fn request_server_release_check(
        &self,
        provider: &str,
    ) -> Result<ServerReleaseCheck, LibraryError> {
        self.request_server_release_check_with(provider, &|| match self.authority_client()? {
            Some((client, token)) => client.release_checks_run(provider, token.expose()),
            None => Ok(ReleaseCheckRun::Unavailable),
        })
    }

    fn request_server_release_check_with(
        &self,
        provider: &str,
        run: &dyn Fn() -> Result<ReleaseCheckRun, LibraryError>,
    ) -> Result<ServerReleaseCheck, LibraryError> {
        if !self.server_release_checks_enabled(provider) {
            return Ok(ServerReleaseCheck::Local);
        }
        Ok(match run()? {
            ReleaseCheckRun::Started(reply) => match parse_status(&reply["status"], provider) {
                Some(status) => ServerReleaseCheck::Started { status },
                // A reply this build cannot read is still a started check.
                None => ServerReleaseCheck::Started {
                    status: self.local_collection_update_status(provider)?,
                },
            },
            ReleaseCheckRun::Unavailable => ServerReleaseCheck::Local,
            ReleaseCheckRun::RateLimited(retry_after_seconds) => ServerReleaseCheck::RateLimited {
                retry_after_seconds,
            },
        })
    }

    pub(super) fn fetch_release_checks_status(&self) -> Result<Option<Value>, LibraryError> {
        match self.authority_client()? {
            Some((client, token)) => client.release_checks_status(token.expose()),
            None => Ok(None),
        }
    }

    /// The status the 신간 screen and the hourly check read. Kakao follows the server while
    /// it owns the checks; everything else is the local worker's.
    pub fn collection_update_status(
        &self,
        provider: &str,
    ) -> Result<CollectionUpdateStatus, LibraryError> {
        match self.server_collection_update_status_with(provider, &|| {
            self.fetch_release_checks_status()
        })? {
            Some(status) => Ok(status),
            None => self.local_collection_update_status(provider),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library::collection_authority::tests::{adopt, binding, fixture, work};
    use serde_json::json;
    use std::cell::Cell;

    fn advertise(library: &Library, features: &[&str]) {
        let id = library.library_id().unwrap();
        library
            .connection()
            .unwrap()
            .execute(
                "INSERT INTO notes_state(key,value) VALUES('personProfileFieldsStatus',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                [json!({"active":true,"libraryId":id,"epoch":1,"features":features}).to_string()],
            )
            .unwrap();
    }

    fn server_status() -> Value {
        json!({"version":1,"providers":{"kakao":{
            "provider":"kakao","checked":3,"changedCollections":1,"failed":0,"remaining":2,
            "requests":9,"elapsedMs":10,"networkMs":8,"throttleMs":0,
            "startedAt":"2026-10-09T01:00:00Z","finishedAt":null,"retryAt":null,"stopReason":null,
            "consecutiveFailures":0,"lastFailure":null,"busy":true}}})
    }

    #[test]
    fn the_gate_follows_the_advertised_feature_only_for_kakao() {
        let (_temp, library, status) = fixture();
        adopt(&library, &status, json!({"works":[work("w", 1)]}));
        assert!(!library.server_release_checks_enabled("kakao"));
        advertise(&library, &["kakaoReview"]);
        assert!(!library.server_release_checks_enabled("kakao"));
        advertise(&library, &["kakaoReview", KAKAO_FEATURE]);
        assert!(library.server_release_checks_enabled("kakao"));
        assert!(!library.server_release_checks_enabled("mangadex"));
    }

    #[test]
    fn a_gated_status_is_the_servers_and_a_missing_feature_stays_local() {
        let (_temp, library, status) = fixture();
        adopt(&library, &status, json!({"works":[work("w", 1)]}));
        let fetches = Cell::new(0);
        let fetch = || {
            fetches.set(fetches.get() + 1);
            Ok(Some(server_status()))
        };
        // Not advertised: the server is never asked.
        assert!(library
            .server_collection_update_status_with("kakao", &fetch)
            .unwrap()
            .is_none());
        assert_eq!(fetches.get(), 0);
        advertise(&library, &[KAKAO_FEATURE]);
        let shown = library
            .server_collection_update_status_with("kakao", &fetch)
            .unwrap()
            .unwrap();
        assert_eq!((shown.checked, shown.remaining, shown.busy), (3, 2, true));
        // MangaDex is never taken over.
        assert!(library
            .server_collection_update_status_with("mangadex", &fetch)
            .unwrap()
            .is_none());
        // The server switched the checks off since the last sync: local again.
        assert!(library
            .server_collection_update_status_with("kakao", &|| Ok(None))
            .unwrap()
            .is_none());
        // An unreachable server is an error: the screen keeps its last server numbers.
        assert!(library
            .server_collection_update_status_with("kakao", &|| Err(
                LibraryError::CloudRequestUnavailable
            ))
            .is_err());
    }

    #[test]
    fn a_gated_run_does_no_local_work_and_returns_the_server_status() {
        let mut bound = binding();
        bound["provider"] = json!("kakao");
        let rows = |library: &Library| -> i64 {
            library
                .connection()
                .unwrap()
                .query_row("SELECT COUNT(*) FROM collection_update_status", [], |r| {
                    r.get(0)
                })
                .unwrap()
        };
        let server = || Ok(Some(server_status()));
        let key = || Err(LibraryError::AladinCredentialNotConfigured);
        // Control: a due bound manga makes the local worker run and persist its status.
        let (_temp, library, status) = fixture();
        adopt(
            &library,
            &status,
            json!({"works":[work("w", 1)],"bindings":[bound.clone()]}),
        );
        library
            .run_collection_updates_gated("kakao", key(), &server)
            .unwrap();
        assert_eq!(rows(&library), 1);
        // Gated: the server status comes back and the local worker never starts.
        let (_temp, library, status) = fixture();
        adopt(
            &library,
            &status,
            json!({"works":[work("w", 1)],"bindings":[bound]}),
        );
        advertise(&library, &[KAKAO_FEATURE]);
        let shown = library
            .run_collection_updates_gated("kakao", key(), &server)
            .unwrap();
        assert_eq!((shown.checked, shown.remaining, shown.busy), (3, 2, true));
        assert_eq!(rows(&library), 0);
        // MangaDex is not the server's: it answers with its own (empty) local status.
        let local = library
            .run_collection_updates_gated("mangadex", Ok(String::new()), &server)
            .unwrap();
        assert_eq!(
            (local.provider.as_str(), local.checked, local.busy),
            ("mangadex", 0, false)
        );
    }

    #[test]
    fn requesting_a_check_maps_the_servers_answers() {
        let (_temp, library, status) = fixture();
        adopt(&library, &status, json!({"works":[work("w", 1)]}));
        let ran = Cell::new(0);
        let started = || {
            ran.set(ran.get() + 1);
            Ok(ReleaseCheckRun::Started(json!({
                "version":1,"queued":true,"status":server_status()["providers"]["kakao"].clone()
            })))
        };
        // Not advertised: local, and the server is not asked.
        assert!(matches!(
            library
                .request_server_release_check_with("kakao", &started)
                .unwrap(),
            ServerReleaseCheck::Local
        ));
        assert_eq!(ran.get(), 0);
        advertise(&library, &[KAKAO_FEATURE]);
        match library
            .request_server_release_check_with("kakao", &started)
            .unwrap()
        {
            ServerReleaseCheck::Started { status } => {
                assert_eq!((status.remaining, status.busy), (2, true));
            }
            other => panic!("unexpected {other:?}"),
        }
        assert!(matches!(
            library
                .request_server_release_check_with("mangadex", &started)
                .unwrap(),
            ServerReleaseCheck::Local
        ));
        assert_eq!(ran.get(), 1);
        // 404: the feature is gone, fall back to the local check.
        assert!(matches!(
            library
                .request_server_release_check_with("kakao", &|| Ok(ReleaseCheckRun::Unavailable))
                .unwrap(),
            ServerReleaseCheck::Local
        ));
        // 429: a calm message with the wait.
        let limited = library
            .request_server_release_check_with("kakao", &|| {
                Ok(ReleaseCheckRun::RateLimited(Some(12)))
            })
            .unwrap();
        assert_eq!(
            serde_json::to_value(limited).unwrap(),
            json!({"outcome":"rateLimited","retryAfterSeconds":12})
        );
    }

    #[test]
    fn an_unreadable_failure_detail_does_not_hide_the_server_status() {
        let mut value = server_status()["providers"]["kakao"].clone();
        value["lastFailure"] = json!({"collectionId":"w","unexpected":true});
        let status = parse_status(&value, "kakao").unwrap();
        assert_eq!(status.remaining, 2);
        assert!(status.last_failure.is_none());
    }
}
