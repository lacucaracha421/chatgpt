// The same ordered provider replies and literal public entries used by the server's
// tests/test_release_calendar.py. Registered inside home_publications so this test
// exercises its private snapshot projection without changing production visibility.

use std::cell::RefCell;
use std::collections::VecDeque;

use chrono::{NaiveDate, TimeZone, Utc};
use serde_json::{json, Value};

use super::Library;
use crate::library::error::LibraryError;
use crate::library::release_calendar::{self, ReleaseTransport};

struct FixtureTransport<'a> {
    case: &'a str,
    responses: RefCell<VecDeque<Value>>,
}

impl FixtureTransport<'_> {
    fn reply(&self, request: Value) -> Result<String, LibraryError> {
        let expected = self
            .responses
            .borrow_mut()
            .pop_front()
            .unwrap_or_else(|| panic!("{}: unexpected request {request}", self.case));
        for (key, value) in request.as_object().unwrap() {
            assert_eq!(
                &expected[key], value,
                "{}: request field {key} disagrees: {request}",
                self.case
            );
        }
        if let Some(error) = expected.get("error") {
            return Err(
                match (
                    expected["provider"].as_str().unwrap(),
                    error.as_str().unwrap(),
                ) {
                    ("igdb", "credential_not_configured") => {
                        LibraryError::IgdbCredentialNotConfigured
                    }
                    ("igdb", "invalid_credential") => LibraryError::IgdbUnauthorized,
                    ("igdb", "rate_limited") => LibraryError::IgdbRateLimited,
                    ("igdb", "timed_out") => LibraryError::IgdbTimedOut,
                    ("igdb", "unavailable") => LibraryError::IgdbUnavailable,
                    ("igdb", "invalid_response") => LibraryError::IgdbInvalidResponse,
                    (_, "credential_not_configured") => LibraryError::TmdbCredentialNotConfigured,
                    (_, "invalid_credential") => LibraryError::TmdbUnauthorized,
                    (_, "rate_limited") => LibraryError::TmdbRateLimited,
                    (_, "timed_out") => LibraryError::TmdbTimedOut,
                    (_, "unavailable") => LibraryError::TmdbUnavailable,
                    (_, "invalid_response") => LibraryError::TmdbInvalidResponse,
                    (_, "not_found") => LibraryError::TmdbNotFound,
                    _ => panic!("{}: unsupported fixture error {error}", self.case),
                },
            );
        }
        Ok(expected
            .get("response")
            .expect("fixture response")
            .to_string())
    }
}

impl ReleaseTransport for FixtureTransport<'_> {
    fn igdb(&self, body: &str) -> Result<String, LibraryError> {
        self.reply(json!({"provider": "igdb", "body": body}))
    }

    fn tmdb(&self, path: &str, query: &[(&str, String)]) -> Result<String, LibraryError> {
        let provider = if path == "/discover/tv" || path.starts_with("/tv/") {
            "tmdb_tv"
        } else {
            "tmdb"
        };
        let params: serde_json::Map<String, Value> = query
            .iter()
            .map(|(key, value)| ((*key).into(), json!(value)))
            .collect();
        self.reply(json!({"provider": provider, "path": path, "params": params}))
    }
}

fn day(value: &Value) -> NaiveDate {
    NaiveDate::parse_from_str(value.as_str().unwrap(), "%Y-%m-%d").unwrap()
}

#[test]
fn release_calendar_shared_provider_fixture_matches_pc_snapshot() {
    let fixture: Value =
        serde_json::from_str(include_str!("fixtures/release_calendar.json")).unwrap();
    assert_eq!(fixture["version"], 1);
    let cases = fixture["cases"].as_array().unwrap();
    assert!(!cases.is_empty(), "shared fixture must contain cases");
    let mut disagreements = Vec::new();
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let today = day(&case["today"]);
            let (start, end) = release_calendar::window(today);
            assert_eq!(start, day(&case["rangeStart"]), "{name}: range start");
            assert_eq!(end, day(&case["rangeEnd"]), "{name}: range end");
            let transport = FixtureTransport {
                case: name,
                responses: RefCell::new(case["responses"].as_array().unwrap().clone().into()),
            };
            let directory = tempfile::tempdir().unwrap();
            let library = Library::open(directory.path()).unwrap();
            let now = Utc.from_utc_datetime(&today.and_hms_opt(0, 0, 0).unwrap());
            let calendar = library
                .refresh_release_calendar_with(&transport, false, now, today)
                .unwrap();
            assert!(
                transport.responses.borrow().is_empty(),
                "{name}: unused responses"
            );
            // Fetch failures are cached by the real refresh path rather than returned.
            // They must not turn an accidental failure into a matching empty snapshot.
            for source in &calendar.sources {
                assert_eq!(
                    source.error_code, None,
                    "{name}: {} fetch failed",
                    source.provider
                );
                assert!(!source.due, "{name}: {} was not refreshed", source.provider);
            }
            let snapshot = library.upcoming_body(now, today, 0).unwrap();
            // generatedAt is attached by the publisher after this projection.
            let expected = json!({
                "version": 1,
                "rangeStart": case["rangeStart"],
                "rangeEnd": case["rangeEnd"],
                "intentCursor": 0,
                "wishlist": [],
                "entries": case["expectedEntries"],
                "sources": [
                    {"provider": "igdb", "fetchedAt": now.to_rfc3339(), "errorCode": null},
                    {"provider": "tmdb", "fetchedAt": now.to_rfc3339(), "errorCode": null}
                ]
            });
            if snapshot != expected {
                disagreements.push(format!(
                    "{name}:\nPC: {}\nFixture: {}",
                    serde_json::to_string_pretty(&snapshot).unwrap(),
                    serde_json::to_string_pretty(&expected).unwrap()
                ));
            }
        }));
        if let Err(error) = result {
            let message = error
                .downcast_ref::<String>()
                .map(String::as_str)
                .or_else(|| error.downcast_ref::<&str>().copied())
                .unwrap_or("non-string panic");
            disagreements.push(format!("{name}: {message}"));
        }
    }
    assert!(disagreements.is_empty(), "{}", disagreements.join("\n\n"));
}
