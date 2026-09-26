use std::cell::RefCell;

use chrono::{DateTime, NaiveDate, Utc};
use serde_json::{json, Value};

use super::*;
use crate::library::Library;

/// Answers provider requests from fixtures and records them; never touches the network.
#[derive(Default)]
pub(crate) struct MockTransport {
    pub(crate) igdb_pages: RefCell<Vec<Result<Value, LibraryError>>>,
    pub(crate) tmdb: RefCell<Vec<(String, Value)>>,
    pub(crate) tmdb_error: RefCell<Option<LibraryError>>,
    pub(crate) requests: RefCell<Vec<String>>,
}

impl ReleaseTransport for MockTransport {
    fn igdb(&self, body: &str) -> Result<String, LibraryError> {
        self.requests.borrow_mut().push(format!("igdb {body}"));
        let mut pages = self.igdb_pages.borrow_mut();
        if pages.is_empty() {
            return Ok("[]".into());
        }
        pages.remove(0).map(|value| value.to_string())
    }

    fn tmdb(&self, path: &str, query: &[(&str, String)]) -> Result<String, LibraryError> {
        let query = query
            .iter()
            .map(|(key, value)| format!("{key}={value}"))
            .collect::<Vec<_>>()
            .join("&");
        self.requests
            .borrow_mut()
            .push(format!("tmdb {path}?{query}"));
        if let Some(error) = self.tmdb_error.borrow_mut().take() {
            return Err(error);
        }
        self.tmdb
            .borrow()
            .iter()
            .find(|(prefix, _)| {
                path == prefix || format!("{path}?{query}").starts_with(prefix.as_str())
            })
            .map(|(_, value)| value.to_string())
            .ok_or(LibraryError::TmdbNotFound)
    }
}

pub(crate) fn day(value: &str) -> NaiveDate {
    NaiveDate::parse_from_str(value, "%Y-%m-%d").unwrap()
}

pub(crate) fn at(value: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(value)
        .unwrap()
        .with_timezone(&Utc)
}

fn ts(value: &str) -> i64 {
    day(value)
        .and_hms_opt(0, 0, 0)
        .unwrap()
        .and_utc()
        .timestamp()
}

pub(crate) fn igdb_game(id: i64, name: &str, releases: Value) -> Value {
    json!({"id": id, "name": name, "hypes": 12, "cover": {"image_id": format!("co{id}")},
           "game_type": {"type": "Main Game"}, "release_dates": releases})
}

fn release(date: &str, format: &str, region: &str, platform: i64) -> Value {
    let parsed = day(date);
    json!({"date": ts(date), "y": parsed.year(), "m": parsed.month(), "date_format": {"format": format},
           "release_region": {"region": region}, "platform": {"id": platform, "name": "Platform"}})
}

#[test]
fn igdb_precision_follows_the_date_format_and_the_deprecated_category() {
    let game = igdb_game(
        1,
        "Precise",
        json!([
            release("2026-11-20", "YYYYMMMMDD", "worldwide", 6),
            release("2026-10-31", "YYYYMMMM", "europe", 167),
            {"date": ts("2026-12-31"), "y": 2026, "category": 6, "region": 5, "platform": {"id": 130}},
            {"y": 2027, "date_format": {"format": "YYYY"}, "release_region": {"region": "north_america"}, "platform": {"id": 169}},
            {"date_format": {"format": "TBD"}, "release_region": {"region": "china"}, "platform": {"id": 49}},
        ]),
    );
    let title = igdb_title(&game, true).unwrap();
    let find = |region: &str| {
        title
            .dates
            .iter()
            .find(|row| row.region == region)
            .unwrap()
            .clone()
    };
    assert_eq!(
        (
            find("worldwide").date.as_deref(),
            find("worldwide").precision
        ),
        (Some("2026-11-20"), DatePrecision::Exact)
    );
    assert_eq!(
        (find("europe").date.as_deref(), find("europe").precision),
        (Some("2026-10-01"), DatePrecision::Month)
    );
    assert_eq!(
        (find("japan").date.as_deref(), find("japan").precision),
        (Some("2026-10-01"), DatePrecision::Quarter)
    );
    assert_eq!(
        (
            find("north_america").date.as_deref(),
            find("north_america").precision
        ),
        (Some("2027-01-01"), DatePrecision::Year)
    );
    assert_eq!(
        (find("china").date, find("china").precision),
        (None, DatePrecision::Tbd)
    );
    // No Korean or Asian date: worldwide is the headline.
    assert_eq!(
        (
            title.date.as_deref(),
            title.precision,
            title.region.as_deref()
        ),
        (Some("2026-11-20"), DatePrecision::Exact, Some("worldwide"))
    );
    assert_eq!(
        title.platforms,
        vec!["PC", "PS5", "Switch", "Xbox Series", "Xbox One"]
    );
    assert_eq!(
        period_token(Some("2026-10-01"), DatePrecision::Quarter),
        "2026-Q4"
    );
    assert_eq!(
        period_token(Some("2026-10-01"), DatePrecision::Month),
        "2026-10"
    );
    assert_eq!(period_token(None, DatePrecision::Tbd), "tbd");
}

#[test]
fn igdb_headline_prefers_korea_then_asia_and_uses_the_korean_title() {
    let mut game = igdb_game(
        2,
        "Global Name",
        json!([
            release("2026-10-01", "YYYYMMMMDD", "worldwide", 6),
            release("2026-10-08", "YYYYMMMMDD", "asia", 167),
            release("2026-10-15", "YYYYMMMMDD", "korea", 167),
            {"date": ts("2026-09-30"), "date_format": {"format": "YYYYMMMMDD"}, "release_region": {"region": "korea"},
             "platform": {"id": 6}, "status": {"name": "Cancelled"}},
        ]),
    );
    game["game_localizations"] =
        json!([{"name": "한국어 제목", "region": {"identifier": "ko_KR", "name": "Korea"}}]);
    let title = igdb_title(&game, true).unwrap();
    assert_eq!(
        title.date.as_deref(),
        Some("2026-10-15"),
        "the cancelled Korean date is ignored"
    );
    assert_eq!(title.region.as_deref(), Some("korea"));
    assert_eq!(title.title, "한국어 제목");
    assert_eq!(title.original_title.as_deref(), Some("Global Name"));
    assert_eq!(title.id, "igdb:2");
    assert_eq!(title.cover.as_deref(), Some("co2"));
}

#[test]
fn igdb_calendar_drops_add_ons_minor_platforms_and_out_of_window_titles() {
    let mut dlc = igdb_game(
        3,
        "DLC",
        json!([release("2026-10-10", "YYYYMMMMDD", "worldwide", 6)]),
    );
    dlc["game_type"] = json!({"type": "DLC Addon"});
    let minor = igdb_game(
        4,
        "Minor platform",
        json!([release("2026-10-10", "YYYYMMMMDD", "worldwide", 999)]),
    );
    let late = igdb_game(
        5,
        "Too late",
        json!([release("2027-06-01", "YYYYMMMMDD", "worldwide", 6)]),
    );
    let quarter = igdb_game(
        6,
        "Quarter overlapping",
        json!([release("2027-01-01", "YYYYQ1", "worldwide", 167)]),
    );
    let kept = igdb_game(
        7,
        "Kept",
        json!([release("2026-10-10", "YYYYMMMMDD", "worldwide", 6)]),
    );
    let transport = MockTransport::default();
    transport
        .igdb_pages
        .borrow_mut()
        .push(Ok(json!([dlc, minor, late, quarter, kept])));
    let titles = fetch_upcoming_games(&transport, day("2026-09-26"), day("2027-03-28")).unwrap();
    assert_eq!(
        titles
            .iter()
            .map(|title| title.id.as_str())
            .collect::<Vec<_>>(),
        vec!["igdb:6", "igdb:7"]
    );
    let requests = transport.requests.borrow();
    assert_eq!(requests.len(), 1, "a short page ends the pagination");
    let body = &requests[0];
    for part in [
        &format!("release_dates.date >= {}", ts("2026-09-26")),
        &format!("release_dates.date < {}", ts("2027-03-28")),
        "release_dates.platform = (6,167,48,508,130,169,49)",
        "hypes >= 3",
        "version_parent = null",
        "parent_game = null",
        "sort hypes desc",
        "release_dates.date_format.format",
        "release_dates.release_region.region",
        "release_dates.status.name",
    ] {
        assert!(body.contains(part), "{part} in {body}");
    }
}

#[test]
fn tmdb_calendar_uses_the_korean_theatrical_date_and_skips_rereleases() {
    let transport = MockTransport::default();
    transport.tmdb.borrow_mut().extend([
        (
            "/discover/movie".to_owned(),
            json!({"page": 1, "total_pages": 1, "results": [
                {"id": 11, "title": "한국 개봉작", "original_title": "Korean Release", "poster_path": "/p11.jpg", "release_date": "2026-09-01", "popularity": 80.0},
                {"id": 12, "title": "재개봉", "original_title": "Classic", "poster_path": "/p12.jpg", "release_date": "1999-01-01", "popularity": 50.0},
                {"id": 13, "title": "Same", "original_title": "Same", "release_date": "2026-11-01", "popularity": 10.0},
            ]}),
        ),
        (
            "/movie/11/release_dates".to_owned(),
            json!({"results": [
                {"iso_3166_1": "US", "release_dates": [{"release_date": "2026-09-01T00:00:00.000Z", "type": 3}]},
                {"iso_3166_1": "KR", "release_dates": [
                    {"release_date": "2026-10-22T00:00:00.000Z", "type": 3},
                    {"release_date": "2026-10-20T00:00:00.000Z", "type": 1},
                    {"release_date": "2027-01-10T00:00:00.000Z", "type": 4}]}]}),
        ),
        ("/movie/13/release_dates".to_owned(), json!({"results": []})),
    ]);
    let titles = fetch_upcoming_movies(&transport, day("2026-09-26"), day("2027-03-28")).unwrap();
    assert_eq!(titles.len(), 2);
    let korean = &titles[0];
    assert_eq!(
        (
            korean.id.as_str(),
            korean.date.as_deref(),
            korean.region.as_deref()
        ),
        ("tmdb:11", Some("2026-10-22"), Some("korea"))
    );
    assert_eq!(
        (
            korean.title.as_str(),
            korean.original_title.as_deref(),
            korean.cover.as_deref()
        ),
        ("한국 개봉작", Some("Korean Release"), Some("/p11.jpg"))
    );
    // No Korean theatrical date: the primary date stands in; an identical original title is not repeated.
    assert_eq!(
        (
            titles[1].date.as_deref(),
            titles[1].region.as_deref(),
            titles[1].original_title.as_deref()
        ),
        (Some("2026-11-01"), Some("worldwide"), None)
    );
    let requests = transport.requests.borrow();
    let discover = &requests[0];
    for part in [
        "region=KR",
        "with_release_type=2|3",
        "language=ko-KR",
        "release_date.gte=2026-09-26",
        "release_date.lte=2027-03-27",
        "sort_by=popularity.desc",
    ] {
        assert!(discover.contains(part), "{part} in {discover}");
    }
    assert!(
        !requests
            .iter()
            .any(|request| request.contains("/movie/12/")),
        "re-releases are not looked up"
    );
}

fn library() -> (tempfile::TempDir, Library) {
    let temp = tempfile::tempdir().unwrap();
    let library = Library::open(temp.path()).unwrap();
    (temp, library)
}

#[test]
fn calendar_refreshes_at_most_daily_backs_off_after_failures_and_expires_old_tmdb_data() {
    let (_temp, library) = library();
    let today = day("2026-09-26");
    let now = at("2026-09-26T03:00:00Z");
    let transport = MockTransport::default();
    transport.igdb_pages.borrow_mut().push(Ok(json!([igdb_game(
        7,
        "Kept",
        json!([release("2026-10-10", "YYYYMMMMDD", "korea", 6)])
    )])));
    *transport.tmdb_error.borrow_mut() = Some(LibraryError::TmdbCredentialNotConfigured);

    let calendar = library
        .refresh_release_calendar_with(&transport, false, now, today)
        .unwrap();
    assert_eq!(calendar.entries.len(), 1);
    assert_eq!(
        (calendar.range_start.as_str(), calendar.range_end.as_str()),
        ("2026-09-26", "2027-03-28")
    );
    let tmdb = calendar
        .sources
        .iter()
        .find(|source| source.provider == "tmdb")
        .unwrap();
    assert_eq!(
        (tmdb.error_code.as_deref(), tmdb.due),
        (Some("credential_not_configured"), false)
    );
    let igdb = calendar
        .sources
        .iter()
        .find(|source| source.provider == "igdb")
        .unwrap();
    assert!(igdb.fetched_at.is_some() && !igdb.due && igdb.error_code.is_none());

    // Within the day (and the failure back-off) nothing is requested again, even when forced.
    let before = transport.requests.borrow().len();
    library
        .refresh_release_calendar_with(&transport, false, at("2026-09-26T03:30:00Z"), today)
        .unwrap();
    library
        .refresh_release_calendar_with(&transport, true, at("2026-09-26T03:30:00Z"), today)
        .unwrap();
    assert_eq!(transport.requests.borrow().len(), before);

    // After the back-off the failed provider is retried; the fresh one is not.
    library
        .refresh_release_calendar_with(&transport, false, at("2026-09-26T04:05:00Z"), today)
        .unwrap();
    let requests = transport.requests.borrow()[before..].to_vec();
    assert!(
        requests.iter().all(|request| request.starts_with("tmdb ")),
        "{requests:?}"
    );

    // The next day both refresh; content older than the TMDB limit is never served.
    let stale = library
        .release_calendar_at(at("2026-09-27T03:00:00Z"), day("2026-09-27"))
        .unwrap();
    assert!(
        stale
            .sources
            .iter()
            .find(|source| source.provider == "igdb")
            .unwrap()
            .due
    );
    let expired = library
        .release_calendar_at(at("2027-04-01T00:00:00Z"), day("2026-09-26"))
        .unwrap();
    assert!(expired.entries.is_empty());
}

#[test]
fn calendar_marks_watched_titles_and_orders_by_date_then_popularity() {
    let (_temp, library) = library();
    let today = day("2026-09-26");
    let now = at("2026-09-26T03:00:00Z");
    let transport = MockTransport::default();
    let mut popular = igdb_game(
        8,
        "Popular",
        json!([release("2026-10-01", "YYYYMMMM", "korea", 6)]),
    );
    popular["hypes"] = json!(99);
    transport.igdb_pages.borrow_mut().push(Ok(json!([
        igdb_game(
            7,
            "Exact",
            json!([release("2026-10-01", "YYYYMMMMDD", "korea", 6)])
        ),
        igdb_game(
            9,
            "Quiet month",
            json!([release("2026-10-01", "YYYYMMMM", "korea", 6)])
        ),
        popular,
    ])));
    transport.tmdb.borrow_mut().push((
        "/discover/movie".into(),
        json!({"results": [], "total_pages": 1}),
    ));
    library
        .refresh_release_calendar_with(&transport, false, now, today)
        .unwrap();
    library
        .add_release_watch_with(&transport, "igdb:9", now, today)
        .unwrap();
    let calendar = library.release_calendar_at(now, today).unwrap();
    let order = calendar
        .entries
        .iter()
        .map(|item| (item.title.id.as_str(), item.watched))
        .collect::<Vec<_>>();
    assert_eq!(
        order,
        vec![("igdb:7", false), ("igdb:8", false), ("igdb:9", true)]
    );
    let serialized = serde_json::to_value(&calendar.entries[0]).unwrap();
    assert_eq!(serialized["externalId"], "7");
    assert_eq!(serialized["precision"], "exact");
    assert_eq!(serialized["watched"], false);
}

#[test]
fn provider_failures_map_to_public_codes() {
    assert_eq!(
        error_code(&LibraryError::IgdbCredentialNotConfigured),
        "credential_not_configured"
    );
    assert_eq!(
        error_code(&LibraryError::TmdbUnauthorized),
        "invalid_credential"
    );
    assert_eq!(error_code(&LibraryError::IgdbRateLimited), "rate_limited");
    assert_eq!(error_code(&LibraryError::TmdbTimedOut), "timed_out");
    assert_eq!(
        error_code(&LibraryError::TmdbInvalidResponse),
        "invalid_response"
    );
}
