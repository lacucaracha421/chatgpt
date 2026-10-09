//! Gate all calendar provider work at the Rust boundary. Wishlist tracking stays on PC.
use super::{
    collection_authority::collection_write_status,
    error::LibraryError,
    release_calendar::{
        CalendarItem, CalendarSourceStatus, DatePrecision, ProviderReleaseDate, ReleaseCalendar,
        ReleaseKind, ReleaseTitle,
    },
    Library,
};
use crate::cloud::client::CalendarRun;
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;

const ABSENT_SECONDS: i64 = 180;
const MODE_KEY: &str = "serverReleaseCalendarMode";

#[derive(Default, Serialize, Deserialize)]
#[serde(default)]
struct CalendarMode {
    server: bool,
    absent_since: Option<i64>,
    local_fetch_after: Option<i64>,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(default)]
struct ServerCache {
    document: Option<Value>,
    etag: Option<String>,
    status: Option<Value>,
}

fn load<T: serde::de::DeserializeOwned + Default>(
    db: &Connection,
    key: &str,
) -> Result<T, LibraryError> {
    let raw: Option<String> = db
        .query_row("SELECT value FROM notes_state WHERE key=?1", [key], |r| {
            r.get(0)
        })
        .optional()?;
    raw.map(|raw| serde_json::from_str(&raw).map_err(|_| LibraryError::InvalidCloudResponse))
        .unwrap_or_else(|| Ok(T::default()))
}

fn save(db: &Connection, key: &str, value: &impl Serialize) -> Result<(), LibraryError> {
    db.execute("INSERT INTO notes_state(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        rusqlite::params![key, serde_json::to_string(value).map_err(|_| LibraryError::InvalidCloudResponse)?])?;
    Ok(())
}

pub(crate) const FEATURE: &str = "serverReleaseCalendar";

#[derive(Serialize)]
#[serde(tag = "outcome", rename_all = "camelCase")]
pub enum ServerCalendarRun {
    Local,
    Queued,
    Unavailable,
    #[serde(rename_all = "camelCase")]
    RateLimited {
        retry_after_seconds: Option<u64>,
    },
}

#[cfg(test)]
mod tests {
    use super::super::{
        collection_authority::tests::{adopt, fixture, work},
        release_calendar::{RefreshMode, ReleaseTransport},
    };
    use super::*;
    use serde_json::json;
    use std::cell::Cell;

    fn advertise(lib: &Library, feature: &str) {
        let id = lib.library_id().unwrap();
        lib.connection().unwrap().execute(
            "INSERT INTO notes_state(key,value) VALUES('personProfileFieldsStatus',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            [json!({"active":true,"libraryId":id,"epoch":1,"features":[feature]}).to_string()],
        ).unwrap();
    }

    struct NoProviders;
    impl ReleaseTransport for NoProviders {
        fn igdb(&self, _query: &str) -> Result<String, LibraryError> {
            panic!("calendar provider call after handover")
        }
        fn tmdb(&self, _path: &str, _params: &[(&str, String)]) -> Result<String, LibraryError> {
            panic!("calendar provider call after handover")
        }
    }

    #[test]
    fn server_release_calendar_gate_blocks_every_refresh_mode() {
        let (_temp, lib, status) = fixture();
        adopt(&lib, &status, json!({"works":[work("w",1)]}));
        assert!(!lib.server_release_calendar_enabled());
        advertise(&lib, "serverReleaseChecks:kakao");
        assert!(!lib.server_release_calendar_enabled());
        advertise(&lib, FEATURE);
        assert!(lib.server_release_calendar_enabled());
        let calls = Cell::new(0);
        let now = chrono::Utc::now();
        for mode in [
            RefreshMode::Due,
            RefreshMode::Manual,
            RefreshMode::Immediate,
        ] {
            assert!(lib
                .refresh_release_calendar_gated(&NoProviders, mode, now, now.date_naive(), &|| {
                    calls.set(calls.get() + 1);
                    Err(LibraryError::CloudRequestUnavailable)
                })
                .is_err());
        }
        assert_eq!(calls.get(), 3);
        let db = lib.connection().unwrap();
        let writes: i64 = db
            .query_row("SELECT COUNT(*) FROM release_calendar_cache", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(writes, 0);
    }

    #[test]
    fn server_release_calendar_public_title_retains_identity_cover_and_port_platforms() {
        let public = json!({"id":"igdb:1942","kind":"game","title":"Title","originalTitle":null,
            "date":"2026-11-14","precision":"exact","region":"KR","platforms":["PC"],
            "cover":{"url":"https://images.igdb.com/igdb/image/upload/t_cover_big/co1.jpg"},"popularity":null,"port":true});
        let title = serde_json::from_value::<PublishedTitle>(public.clone())
            .unwrap()
            .into_title()
            .unwrap();
        assert_eq!(title.external_id, "1942");
        assert_eq!(title.cover.as_deref(), Some("co1"));
        assert!(title.port);
        assert_eq!(title.dates.len(), 1);
        assert_eq!(title.dates[0].platform, "PC");
        let mut invalid = public;
        invalid["kind"] = json!("movie");
        assert!(serde_json::from_value::<PublishedTitle>(invalid)
            .unwrap()
            .into_title()
            .is_err());
    }

    fn document() -> Value {
        json!({"version":1,"revision":4,"publishedAt":"2026-10-09T00:00:00Z",
            "generatedAt":"2026-10-09T00:00:00Z","rangeStart":"2026-10-02","rangeEnd":"2027-04-10",
            "entries":[{"id":"igdb:1942","kind":"game","title":"Server entry","originalTitle":null,
                "date":"2026-11-14","precision":"exact","region":"KR","platforms":["PC"],
                "releaseType":null,"cover":null,"popularity":30.0,"port":false}],
            "wishlist":[],"sources":[{"provider":"igdb","fetchedAt":null,"errorCode":null}],
            "acknowledgedThrough":0,"pending":[]})
    }

    fn status() -> Value {
        json!({"version":1,"enabled":true,"configured":true,"alive":true,"busy":false,
            "wakes":1,"startedAt":null,"finishedAt":null,"stopReason":null,"nextProvider":"igdb",
            "sources":[{"provider":"igdb","fetchedAt":"2026-10-09T00:00:00Z","attemptedAt":null,"errorCode":null,"due":false},
                {"provider":"tmdb","fetchedAt":null,"attemptedAt":null,"errorCode":null,"due":true},
                {"provider":"tmdb_tv","fetchedAt":null,"attemptedAt":null,"errorCode":null,"due":true}]})
    }

    #[test]
    fn server_release_calendar_reads_real_get_and_status_shapes_and_local_watched_flags() {
        let (_temp, lib, _) = fixture();
        let calendar = lib.server_calendar_from(&document(), &status()).unwrap();
        assert_eq!(calendar.entries.len(), 1);
        assert_eq!(calendar.range_start, "2026-10-02");
        assert_eq!(calendar.sources.len(), 3);
        let now = chrono::Utc::now();
        super::super::release_wishlist::insert_watch(
            &*lib.connection().unwrap(),
            &calendar.entries[0].title,
            "calendar",
            now,
            now.date_naive(),
        )
        .unwrap();
        assert!(
            lib.server_calendar_from(&document(), &status())
                .unwrap()
                .entries[0]
                .watched
        );
        assert!(lib
            .server_calendar_from(&document(), &Value::Null)
            .unwrap()
            .sources
            .is_empty());
    }

    #[test]
    fn server_release_calendar_fixture_public_entries_round_trip_into_titles() {
        let fixture: Value =
            serde_json::from_str(include_str!("fixtures/release_calendar.json")).unwrap();
        let mut count = 0;
        for case in fixture["cases"].as_array().unwrap() {
            for entry in case["expectedEntries"].as_array().unwrap() {
                let title = serde_json::from_value::<PublishedTitle>(entry.clone())
                    .unwrap()
                    .into_title()
                    .unwrap();
                assert_eq!(title.id, entry["id"].as_str().unwrap());
                assert_eq!(title.title, entry["title"].as_str().unwrap());
                count += 1;
            }
        }
        assert!(count > 0);
    }

    #[test]
    fn server_release_calendar_hysteresis_keeps_transient_off_and_fences_real_off_until_fresh_fetch(
    ) {
        let (_temp, lib, authority) = fixture();
        adopt(&lib, &authority, json!({"works":[work("w",1)]}));
        advertise(&lib, FEATURE);
        assert!(lib.server_release_calendar_enabled_at(1000).unwrap());
        advertise(&lib, "");
        for at in [1001, 1001, 1100, 1180] {
            assert!(lib.server_release_calendar_enabled_at(at).unwrap());
        }
        advertise(&lib, FEATURE);
        assert!(lib.server_release_calendar_enabled_at(1181).unwrap());
        advertise(&lib, "");
        assert!(lib.server_release_calendar_enabled_at(1200).unwrap());
        assert!(!lib.server_release_calendar_enabled_at(1380).unwrap());
        let now = chrono::DateTime::from_timestamp(1380, 0).unwrap();
        assert!(!lib.local_calendar_publication_ready(now).unwrap());
        for provider in ["igdb", "tmdb", "tmdb_tv"] {
            assert!(lib.local_calendar_fetch_due(provider, now).unwrap());
            lib.connection().unwrap().execute(
                "INSERT INTO release_calendar_cache(provider,fetched_at,entries_json) VALUES(?1,?2,'[]')",
                rusqlite::params![provider, now.to_rfc3339()]).unwrap();
        }
        lib.connection().unwrap().execute("UPDATE release_calendar_cache SET error_code='unavailable' WHERE provider='tmdb_tv'", []).unwrap();
        assert!(!lib.local_calendar_publication_ready(now).unwrap());
        lib.connection()
            .unwrap()
            .execute("UPDATE release_calendar_cache SET error_code=NULL", [])
            .unwrap();
        assert!(lib.local_calendar_publication_ready(now).unwrap());
        // A failed PUT has not reclaimed ownership: an old retry must fetch again.
        assert!(!lib
            .local_calendar_publication_ready(now + chrono::Duration::days(181))
            .unwrap());
        lib.local_calendar_publication_confirmed().unwrap();
        assert!(lib
            .local_calendar_publication_ready(now + chrono::Duration::days(181))
            .unwrap());
        advertise(&lib, FEATURE);
        assert!(lib.server_release_calendar_enabled_at(1381).unwrap());
    }

    #[test]
    fn server_release_calendar_cache_revalidates_etag_and_survives_status_failure_and_reopen() {
        let (temp, lib, _) = fixture();
        let key = lib.server_cache_key().unwrap();
        assert!(lib
            .refresh_server_calendar_cache_with(
                &key,
                &|etag| {
                    assert_eq!(etag, None);
                    Ok(Some((document(), Some("\"v4\"".into()))))
                },
                &|| Ok(status())
            )
            .unwrap());
        assert_eq!(
            lib.server_calendar().unwrap().entries[0].title.title,
            "Server entry"
        );
        assert!(lib
            .refresh_server_calendar_cache_with(
                &key,
                &|etag| {
                    assert_eq!(etag, Some("\"v4\""));
                    Ok(None)
                },
                &|| Err(LibraryError::CloudRequestUnavailable)
            )
            .unwrap());
        let calendar = lib.server_calendar().unwrap();
        assert_eq!(calendar.entries.len(), 1);
        assert!(calendar.sources.is_empty());
        assert!(lib
            .refresh_server_calendar_cache_with(
                &key,
                &|_| Err(LibraryError::CloudRequestUnavailable),
                &|| Ok(status())
            )
            .is_err());
        drop(lib);
        let reopened = Library::open(temp.path()).unwrap();
        assert_eq!(
            reopened.server_calendar().unwrap().entries[0].title.title,
            "Server entry"
        );
    }

    #[test]
    fn server_release_calendar_run_maps_queued_limits_and_unavailability_without_local_work() {
        let (_temp, lib, status) = fixture();
        adopt(&lib, &status, json!({"works":[work("w",1)]}));
        let calls = Cell::new(0);
        let run = || {
            calls.set(calls.get() + 1);
            Ok(CalendarRun::Queued)
        };
        assert!(matches!(
            lib.request_server_release_calendar_with(&run).unwrap(),
            ServerCalendarRun::Local
        ));
        assert_eq!(calls.get(), 0);
        advertise(&lib, FEATURE);
        assert!(matches!(
            lib.request_server_release_calendar_with(&run).unwrap(),
            ServerCalendarRun::Queued
        ));
        assert_eq!(calls.get(), 1);
        assert!(matches!(
            lib.request_server_release_calendar_with(&|| Ok(CalendarRun::Unavailable))
                .unwrap(),
            ServerCalendarRun::Unavailable
        ));
        let limited = lib
            .request_server_release_calendar_with(&|| Ok(CalendarRun::RateLimited(Some(12))))
            .unwrap();
        assert_eq!(
            serde_json::to_value(limited).unwrap(),
            json!({"outcome":"rateLimited","retryAfterSeconds":12})
        );
        assert!(lib
            .request_server_release_calendar_with(&|| Err(LibraryError::CloudRequestUnavailable))
            .is_err());
    }
}

/// Public snapshots omit provider internals. Rebuild a baseline from their headline
/// and visible platforms; later wishlist checks still read the exact provider ID.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PublishedTitle {
    id: String,
    kind: ReleaseKind,
    title: String,
    original_title: Option<String>,
    date: Option<String>,
    precision: DatePrecision,
    region: Option<String>,
    platforms: Vec<String>,
    cover: Option<Value>,
    popularity: Option<f64>,
    #[serde(default)]
    port: bool,
}

impl PublishedTitle {
    pub(crate) fn into_title(self) -> Result<ReleaseTitle, LibraryError> {
        let (provider, external) = self
            .id
            .split_once(':')
            .ok_or(LibraryError::InvalidCloudResponse)?;
        if provider != self.kind.provider()
            || external.is_empty()
            || (self.kind == ReleaseKind::Anime) != external.starts_with("tv:")
            || self.title.trim().is_empty()
            || self.title.chars().count() > 500
            || (self.precision == DatePrecision::Tbd) != self.date.is_none()
            || self
                .date
                .as_deref()
                .is_some_and(|d| chrono::NaiveDate::parse_from_str(d, "%Y-%m-%d").is_err())
        {
            return Err(LibraryError::InvalidCloudResponse);
        }
        let cover = self
            .cover
            .as_ref()
            .and_then(|c| c["url"].as_str())
            .and_then(|url| {
                if provider == "igdb" {
                    url.strip_prefix("https://images.igdb.com/igdb/image/upload/t_cover_big/")
                        .and_then(|s| s.strip_suffix(".jpg"))
                        .filter(|s| {
                            !s.is_empty()
                                && s.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_')
                        })
                } else {
                    url.strip_prefix("https://image.tmdb.org/t/p/w342")
                        .filter(|s| {
                            s.starts_with('/')
                                && !s.contains("..")
                                && s.bytes()
                                    .all(|c| c.is_ascii_alphanumeric() || b"/_.-".contains(&c))
                        })
                }
            })
            .map(str::to_owned);
        let platforms = if self.platforms.is_empty() {
            vec![String::new()]
        } else {
            self.platforms.clone()
        };
        let dates = platforms
            .into_iter()
            .map(|platform| ProviderReleaseDate {
                platform,
                region: self.region.clone().unwrap_or_default(),
                date: self.date.clone(),
                precision: self.precision,
            })
            .collect();
        Ok(ReleaseTitle {
            provider: provider.into(),
            external_id: external.into(),
            id: self.id,
            kind: self.kind,
            title: self.title,
            original_title: self.original_title,
            date: self.date,
            precision: self.precision,
            region: self.region,
            platforms: self.platforms,
            cover,
            popularity: self.popularity.unwrap_or(0.0),
            dates,
            port: self.port,
        })
    }
}

impl Library {
    pub fn server_release_calendar_enabled(&self) -> bool {
        self.server_release_calendar_enabled_at(chrono::Utc::now().timestamp())
            .unwrap_or(true)
    }

    pub(super) fn server_release_calendar_enabled_at(
        &self,
        clock: i64,
    ) -> Result<bool, LibraryError> {
        let db = self.connection()?;
        let advertised = collection_write_status(&db)?;
        let advertised = advertised.active && advertised.features.iter().any(|f| f == FEATURE);
        let mut mode: CalendarMode = load(&db, MODE_KEY)?;
        let previous = serde_json::to_string(&mode).unwrap();
        if advertised {
            mode.server = true;
            mode.absent_since = None;
            mode.local_fetch_after = None;
        } else if mode.server {
            let since = *mode.absent_since.get_or_insert(clock);
            if clock - since >= ABSENT_SECONDS {
                mode.server = false;
                mode.local_fetch_after = Some(clock);
                mode.absent_since = None;
            }
        }
        if previous != serde_json::to_string(&mode).unwrap() {
            save(&db, MODE_KEY, &mode)?;
            self.publication_inputs.signal(&[8]);
        }
        Ok(mode.server)
    }

    /// A real OFF transition must not reclaim the document with the old PC cache.
    pub(super) fn local_calendar_publication_ready(
        &self,
        now: chrono::DateTime<chrono::Utc>,
    ) -> Result<bool, LibraryError> {
        let db = self.connection()?;
        let mode: CalendarMode = load(&db, MODE_KEY)?;
        let Some(after) = mode.local_fetch_after else {
            return Ok(true);
        };
        for provider in ["igdb", "tmdb", "tmdb_tv"] {
            let row: Option<(Option<String>, Option<String>)> = db
                .query_row(
                    "SELECT fetched_at,error_code FROM release_calendar_cache WHERE provider=?1",
                    [provider],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?;
            let Some((Some(fetched), None)) = row else {
                return Ok(false);
            };
            let Ok(fetched) = chrono::DateTime::parse_from_rfc3339(&fetched) else {
                return Ok(false);
            };
            if fetched.timestamp() < after
                || now.signed_duration_since(fetched) >= chrono::Duration::hours(24)
            {
                return Ok(false);
            }
        }
        Ok(true)
    }

    pub(super) fn local_calendar_publication_confirmed(&self) -> Result<(), LibraryError> {
        let db = self.connection()?;
        let mut mode: CalendarMode = load(&db, MODE_KEY)?;
        if mode.local_fetch_after.take().is_some() {
            save(&db, MODE_KEY, &mode)?;
        }
        Ok(())
    }

    fn server_cache_key(&self) -> Result<String, LibraryError> {
        let config = self.cloud_sync_config()?;
        Ok(format!(
            "serverReleaseCalendarCache:{}",
            crate::cloud::status_watch::endpoint_key(config.api_base_url.as_deref().unwrap_or(""))
        ))
    }

    pub(super) fn local_calendar_fetch_due(
        &self,
        provider: &str,
        now: chrono::DateTime<chrono::Utc>,
    ) -> Result<bool, LibraryError> {
        let db = self.connection()?;
        let mode: CalendarMode = load(&db, MODE_KEY)?;
        let Some(after) = mode.local_fetch_after else {
            return Ok(false);
        };
        let row: Option<(Option<String>, Option<String>)> = db
            .query_row(
                "SELECT fetched_at,attempted_at FROM release_calendar_cache WHERE provider=?1",
                [provider],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let Some((fetched, attempted)) = row else {
            return Ok(true);
        };
        let parse =
            |s: Option<String>| s.and_then(|s| chrono::DateTime::parse_from_rfc3339(&s).ok());
        if parse(fetched).is_some_and(|at| at.timestamp() >= after) {
            return Ok(false);
        }
        Ok(!parse(attempted).is_some_and(|at| {
            at.timestamp() >= after && now.signed_duration_since(at) < chrono::Duration::hours(1)
        }))
    }

    pub fn server_release_calendar_status(&self) -> Result<Value, LibraryError> {
        let (client, token) = self
            .authority_client()?
            .ok_or(LibraryError::CloudRequestUnavailable)?;
        let status = client.calendar_read("/v1/home/upcoming/calendar/status", token.expose())?;
        if status["version"] != 1 || !status["sources"].is_array() || !status["busy"].is_boolean() {
            return Err(LibraryError::InvalidCloudResponse);
        }
        Ok(status)
    }

    pub fn request_server_release_calendar(&self) -> Result<ServerCalendarRun, LibraryError> {
        self.request_server_release_calendar_with(&|| {
            let (client, token) = self
                .authority_client()?
                .ok_or(LibraryError::CloudRequestUnavailable)?;
            client.calendar_run(token.expose())
        })
    }

    fn request_server_release_calendar_with(
        &self,
        run: &dyn Fn() -> Result<CalendarRun, LibraryError>,
    ) -> Result<ServerCalendarRun, LibraryError> {
        if !self.server_release_calendar_enabled() {
            return Ok(ServerCalendarRun::Local);
        }
        Ok(match run()? {
            CalendarRun::Queued => ServerCalendarRun::Queued,
            CalendarRun::Unavailable => ServerCalendarRun::Unavailable,
            CalendarRun::RateLimited(retry_after_seconds) => ServerCalendarRun::RateLimited {
                retry_after_seconds,
            },
        })
    }

    pub(super) fn server_calendar(&self) -> Result<ReleaseCalendar, LibraryError> {
        let key = self.server_cache_key()?;
        let cache: ServerCache = load(&*self.connection()?, &key)?;
        let empty = serde_json::json!({"version":1,"entries":[]});
        self.server_calendar_from(
            cache.document.as_ref().unwrap_or(&empty),
            cache.status.as_ref().unwrap_or(&Value::Null),
        )
    }

    /// Read commands serve disk immediately; their background task revalidates here.
    pub fn refresh_server_calendar_cache(&self, force: bool) -> Result<bool, LibraryError> {
        if !self.server_release_calendar_enabled() {
            return Ok(false);
        }
        let Ok(mut last) = self.server_calendar_refresh.try_lock() else {
            return Ok(false);
        };
        if !force && last.is_some_and(|at| at.elapsed() < std::time::Duration::from_secs(30)) {
            return Ok(false);
        }
        *last = Some(std::time::Instant::now());
        let (client, token) = self
            .authority_client()?
            .ok_or(LibraryError::CloudRequestUnavailable)?;
        let key = self.server_cache_key()?;
        self.refresh_server_calendar_cache_with(
            &key,
            &|etag| client.calendar_read_conditional("/v1/home/upcoming", token.expose(), etag),
            &|| self.server_release_calendar_status(),
        )
    }

    fn refresh_server_calendar_cache_with(
        &self,
        key: &str,
        read: &dyn Fn(Option<&str>) -> Result<Option<(Value, Option<String>)>, LibraryError>,
        status: &dyn Fn() -> Result<Value, LibraryError>,
    ) -> Result<bool, LibraryError> {
        let mut cache: ServerCache = load(&*self.connection()?, key)?;
        let previous = serde_json::to_string(&cache).unwrap();
        // Commit a valid document even if the independent status route is down.
        if let Some((document, etag)) = read(cache.etag.as_deref())? {
            self.server_calendar_from(&document, &Value::Null)?;
            cache.document = Some(document);
            cache.etag = etag;
        }
        cache.status = status().ok();
        let changed = previous != serde_json::to_string(&cache).unwrap();
        if changed {
            save(&*self.connection()?, key, &cache)?;
        }
        Ok(changed)
    }

    fn server_calendar_from(
        &self,
        document: &Value,
        status: &Value,
    ) -> Result<ReleaseCalendar, LibraryError> {
        if document["version"] != 1 {
            return Err(LibraryError::InvalidCloudResponse);
        }
        let public: Vec<PublishedTitle> = serde_json::from_value(document["entries"].clone())
            .map_err(|_| LibraryError::InvalidCloudResponse)?;
        let watched: std::collections::HashSet<_> = self
            .list_release_watch()?
            .into_iter()
            .map(|i| i.id)
            .collect();
        let entries = public
            .into_iter()
            .map(|p| {
                let title = p.into_title()?;
                Ok(CalendarItem {
                    watched: watched.contains(&title.id),
                    title,
                })
            })
            .collect::<Result<_, LibraryError>>()?;
        // A status failure blanks source labels, never the calendar itself.
        let sources: Vec<CalendarSourceStatus> =
            serde_json::from_value(status["sources"].clone()).unwrap_or_default();
        let today = chrono::Local::now().date_naive();
        let (start, end) = super::release_calendar::window(today);
        Ok(ReleaseCalendar {
            range_start: document["rangeStart"]
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| start.to_string()),
            range_end: document["rangeEnd"]
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| end.to_string()),
            entries,
            sources,
        })
    }

    pub(super) fn server_calendar_title(
        &self,
        id: &str,
    ) -> Result<Option<ReleaseTitle>, LibraryError> {
        Ok(self
            .server_calendar()?
            .entries
            .into_iter()
            .find(|i| i.title.id == id)
            .map(|i| i.title))
    }
}
