use serde_json::json;

use super::*;
use crate::library::release_calendar::tests::{at, day, igdb_game, MockTransport};

fn library() -> (tempfile::TempDir, Library) {
    let temp = tempfile::tempdir().unwrap();
    let library = Library::open(temp.path()).unwrap();
    (temp, library)
}

fn movie(id: i64, korean_date: Option<&str>) -> serde_json::Value {
    json!({"id": id, "title": "관심 영화", "original_title": "Wanted Movie", "poster_path": "/m.jpg",
           "release_date": "2026-12-01",
           "release_dates": {"results": korean_date.map(|date| json!([{"iso_3166_1": "KR",
               "release_dates": [{"release_date": format!("{date}T00:00:00.000Z"), "type": 3}]}])).unwrap_or(json!([]))}})
}

fn game_release(date: Option<&str>, format: &str) -> serde_json::Value {
    let mut release = json!({"date_format": {"format": format}, "release_region": {"region": "korea"}, "platform": {"id": 167}});
    if let Some(date) = date {
        release["date"] = json!(day(date)
            .and_hms_opt(0, 0, 0)
            .unwrap()
            .and_utc()
            .timestamp());
    }
    release
}

#[test]
fn schedule_checks_daily_six_hourly_near_release_and_stops_a_month_after() {
    let now = at("2026-09-26T00:00:00Z");
    let today = day("2026-09-26");
    let exact = DatePrecision::Exact;
    assert_eq!(
        next_check(now, today, Some("2026-12-01"), exact),
        Some(at("2026-09-27T00:00:00Z"))
    );
    assert_eq!(
        next_check(now, today, Some("2026-10-10"), exact),
        Some(at("2026-09-26T06:00:00Z"))
    );
    assert_eq!(
        next_check(now, today, Some("2026-09-01"), exact),
        Some(at("2026-09-26T06:00:00Z"))
    );
    assert_eq!(
        next_check(now, today, Some("2026-08-27"), exact),
        Some(at("2026-09-26T06:00:00Z"))
    );
    assert_eq!(next_check(now, today, Some("2026-08-26"), exact), None);
    // A month or quarter is never "near"; TBD keeps the daily check.
    assert_eq!(
        next_check(now, today, Some("2026-10-01"), DatePrecision::Month),
        Some(at("2026-09-27T00:00:00Z"))
    );
    assert_eq!(
        next_check(now, today, None, DatePrecision::Tbd),
        Some(at("2026-09-27T00:00:00Z"))
    );
}

#[test]
fn changes_are_classified_as_set_changed_and_released() {
    let today = day("2026-10-20");
    let exact = DatePrecision::Exact;
    assert_eq!(
        detect_changes(
            (None, DatePrecision::Tbd),
            (Some("2026-10-01"), DatePrecision::Quarter),
            false,
            today
        ),
        vec![("date_set", Some("tbd".into()), Some("2026-Q4".into()))]
    );
    // Narrowed to a day inside the stated month: the date is now set.
    assert_eq!(
        detect_changes(
            (Some("2026-11-01"), DatePrecision::Month),
            (Some("2026-11-12"), exact),
            false,
            today
        ),
        vec![(
            "date_set",
            Some("2026-11".into()),
            Some("2026-11-12".into())
        )]
    );
    assert_eq!(
        detect_changes(
            (Some("2026-11-12"), exact),
            (Some("2027-01-01"), DatePrecision::Quarter),
            false,
            today
        ),
        vec![(
            "date_changed",
            Some("2026-11-12".into()),
            Some("2027-Q1".into())
        )]
    );
    assert_eq!(
        detect_changes(
            (Some("2026-10-20"), exact),
            (Some("2026-10-20"), exact),
            false,
            today
        ),
        vec![("released", None, Some("2026-10-20".into()))]
    );
    assert!(detect_changes(
        (Some("2026-10-20"), exact),
        (Some("2026-10-20"), exact),
        true,
        today
    )
    .is_empty());
}

#[test]
fn adding_from_the_calendar_or_a_provider_records_a_baseline_without_events() {
    let (_temp, library) = library();
    let now = at("2026-09-26T03:00:00Z");
    let today = day("2026-09-26");
    let transport = MockTransport::default();
    transport.igdb_pages.borrow_mut().push(Ok(json!([igdb_game(
        7,
        "Calendar game",
        json!([game_release(Some("2026-11-20"), "YYYYMMMMDD")])
    )])));
    transport.tmdb.borrow_mut().push((
        "/discover/movie".into(),
        json!({"results": [], "total_pages": 1}),
    ));
    library
        .refresh_release_calendar_with(&transport, false, now, today)
        .unwrap();
    transport
        .tmdb
        .borrow_mut()
        .push(("/movie/55".into(), movie(55, Some("2026-10-02"))));
    let before = transport.requests.borrow().len();

    let game = library
        .add_release_watch_with(&transport, "igdb:7", now, today)
        .unwrap();
    assert_eq!(
        transport.requests.borrow().len(),
        before,
        "a calendar title needs no request"
    );
    assert_eq!(
        (game.source.as_str(), game.date.as_deref(), game.precision),
        ("calendar", Some("2026-11-20"), DatePrecision::Exact)
    );
    assert_eq!(
        game.next_check_at.as_deref(),
        Some("2026-09-27T03:00:00+00:00")
    );

    let film = library
        .add_release_watch_with(&transport, "tmdb:55", now, today)
        .unwrap();
    assert_eq!(
        (
            film.source.as_str(),
            film.title.as_str(),
            film.date.as_deref(),
            film.region.as_deref()
        ),
        ("manual", "관심 영화", Some("2026-10-02"), Some("korea"))
    );
    assert_eq!(
        film.next_check_at.as_deref(),
        Some("2026-09-26T09:00:00+00:00"),
        "six-hourly within 14 days"
    );
    // Adding again is idempotent.
    library
        .add_release_watch_with(&transport, "igdb:7", now, today)
        .unwrap();
    let items = library.list_release_watch().unwrap();
    assert_eq!(
        items
            .iter()
            .map(|item| item.id.as_str())
            .collect::<Vec<_>>(),
        vec!["tmdb:55", "igdb:7"]
    );
    assert!(items.iter().all(|item| item.unread.is_empty()));
    assert!(library
        .add_release_watch_with(&transport, "steam:1", now, today)
        .is_err());
    assert!(library
        .add_release_watch_with(&transport, "igdb:007", now, today)
        .is_err());
    // Watched titles are never Collections.
    let collections: i64 = library
        .connection()
        .unwrap()
        .query_row("SELECT COUNT(*) FROM collections", [], |row| row.get(0))
        .unwrap();
    assert_eq!(collections, 0);
}

#[test]
fn the_due_runner_records_date_changes_and_release_then_stops_and_acknowledges_exact_ids() {
    let (_temp, library) = library();
    let today = day("2026-09-26");
    let now = at("2026-09-26T03:00:00Z");
    let transport = MockTransport::default();
    transport.igdb_pages.borrow_mut().push(Ok(json!([igdb_game(
        7,
        "Delayed",
        json!([game_release(None, "TBD")])
    )])));
    library
        .add_release_watch_with(&transport, "igdb:7", now, today)
        .unwrap();
    transport
        .tmdb
        .borrow_mut()
        .push(("/movie/55".into(), movie(55, Some("2026-10-02"))));
    library
        .add_release_watch_with(&transport, "tmdb:55", now, today)
        .unwrap();

    // Not due yet: nothing is requested.
    let before = transport.requests.borrow().len();
    let idle = library
        .run_due_release_watchlist_with(&transport, at("2026-09-26T04:00:00Z"), today)
        .unwrap();
    assert_eq!(
        (idle.checked, transport.requests.borrow().len()),
        (0, before)
    );

    // A day later the game got a month and the movie moved.
    transport.igdb_pages.borrow_mut().push(Ok(json!([igdb_game(
        7,
        "Delayed",
        json!([game_release(Some("2026-12-01"), "YYYYMMMM")])
    )])));
    transport.tmdb.borrow_mut().clear();
    transport
        .tmdb
        .borrow_mut()
        .push(("/movie/55".into(), movie(55, Some("2026-10-09"))));
    let run = library
        .run_due_release_watchlist_with(&transport, at("2026-09-27T04:00:00Z"), day("2026-09-27"))
        .unwrap();
    assert_eq!((run.checked, run.changed, run.stop_reason), (2, 2, None));
    let items = library.list_release_watch().unwrap();
    let game = items.iter().find(|item| item.id == "igdb:7").unwrap();
    let film = items.iter().find(|item| item.id == "tmdb:55").unwrap();
    assert_eq!(
        game.unread
            .iter()
            .map(|event| (event.kind.as_str(), event.current_value.as_deref()))
            .collect::<Vec<_>>(),
        vec![("date_set", Some("2026-12"))]
    );
    assert_eq!(
        film.unread
            .iter()
            .map(|event| (
                event.kind.as_str(),
                event.previous_value.as_deref(),
                event.current_value.as_deref()
            ))
            .collect::<Vec<_>>(),
        vec![("date_changed", Some("2026-10-02"), Some("2026-10-09"))]
    );

    // Release day: one `released` event, and never a second one.
    transport
        .tmdb
        .borrow_mut()
        .push(("/movie/55".into(), movie(55, Some("2026-10-09"))));
    library
        .run_due_release_watchlist_with(&transport, at("2026-10-09T01:00:00Z"), day("2026-10-09"))
        .unwrap();
    library
        .run_due_release_watchlist_with(&transport, at("2026-10-09T08:00:00Z"), day("2026-10-09"))
        .unwrap();
    let film = library
        .list_release_watch()
        .unwrap()
        .into_iter()
        .find(|item| item.id == "tmdb:55")
        .unwrap();
    assert!(film.released);
    assert_eq!(
        film.unread
            .iter()
            .filter(|event| event.kind == "released")
            .count(),
        1
    );

    // Acknowledging exact ids leaves later events unread.
    let first = film.unread[0].id.clone();
    library
        .acknowledge_release_watch_events(&[first.clone()])
        .unwrap();
    let film = library
        .list_release_watch()
        .unwrap()
        .into_iter()
        .find(|item| item.id == "tmdb:55")
        .unwrap();
    assert!(film.unread.iter().all(|event| event.id != first));
    assert_eq!(film.unread.len(), 1);

    // More than 30 days after release the title is no longer checked.
    library
        .run_due_release_watchlist_with(&transport, at("2026-11-09T12:00:00Z"), day("2026-11-09"))
        .unwrap();
    let film = library
        .list_release_watch()
        .unwrap()
        .into_iter()
        .find(|item| item.id == "tmdb:55")
        .unwrap();
    assert_eq!(film.next_check_at, None);
}

#[test]
fn muted_titles_are_skipped_provider_failures_stop_their_provider_and_removal_cascades() {
    let (_temp, library) = library();
    let today = day("2026-09-26");
    let now = at("2026-09-26T03:00:00Z");
    let transport = MockTransport::default();
    transport.igdb_pages.borrow_mut().push(Ok(json!([igdb_game(
        7,
        "Muted",
        json!([game_release(Some("2026-12-01"), "YYYYMMMMDD")])
    )])));
    library
        .add_release_watch_with(&transport, "igdb:7", now, today)
        .unwrap();
    transport
        .tmdb
        .borrow_mut()
        .push(("/movie/55".into(), movie(55, Some("2026-12-02"))));
    library
        .add_release_watch_with(&transport, "tmdb:55", now, today)
        .unwrap();
    library.set_release_watch_muted("igdb:7", true).unwrap();

    *transport.tmdb_error.borrow_mut() = Some(LibraryError::TmdbRateLimited);
    let before = transport.requests.borrow().len();
    let run = library
        .run_due_release_watchlist_with(&transport, at("2026-09-28T00:00:00Z"), day("2026-09-28"))
        .unwrap();
    assert_eq!(
        (run.checked, run.stop_reason.as_deref()),
        (0, Some("rate_limited"))
    );
    assert!(
        transport.requests.borrow()[before..]
            .iter()
            .all(|request| !request.starts_with("igdb")),
        "muted titles are not requested"
    );
    let film = library
        .list_release_watch()
        .unwrap()
        .into_iter()
        .find(|item| item.id == "tmdb:55")
        .unwrap();
    assert_eq!(
        film.last_checked_at.as_deref(),
        Some("2026-09-26T03:00:00+00:00"),
        "a failed check is retried"
    );

    library.remove_release_watch("tmdb:55").unwrap();
    let dates: i64 = library
        .connection()
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM release_watch_dates WHERE item_id = 'tmdb:55'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(dates, 0);
    assert_eq!(library.list_release_watch().unwrap().len(), 1);
}

#[test]
fn a_release_on_a_minor_platform_does_not_move_a_watched_game() {
    let (_temp, library) = library();
    let today = day("2026-09-26");
    let now = at("2026-09-26T03:00:00Z");
    let transport = MockTransport::default();
    let major = game_release(Some("2026-12-01"), "YYYYMMMMDD");
    transport.igdb_pages.borrow_mut().push(Ok(json!([igdb_game(
        7,
        "Major",
        json!([major.clone()])
    )])));
    library
        .add_release_watch_with(&transport, "igdb:7", now, today)
        .unwrap();
    let mut minor = game_release(Some("2026-10-01"), "YYYYMMMMDD");
    minor["platform"] = json!({"id": 3, "name": "Linux"});
    transport.igdb_pages.borrow_mut().push(Ok(json!([igdb_game(
        7,
        "Major",
        json!([major, minor])
    )])));
    let run = library
        .run_due_release_watchlist_with(&transport, at("2026-09-27T04:00:00Z"), day("2026-09-27"))
        .unwrap();
    assert_eq!((run.checked, run.changed), (1, 0));
    let game = library.list_release_watch().unwrap().pop().unwrap();
    assert_eq!(game.date.as_deref(), Some("2026-12-01"));
}
