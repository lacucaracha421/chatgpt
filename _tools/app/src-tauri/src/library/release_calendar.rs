//! The 발매 캘린더: upcoming games (IGDB) and movies (TMDB, Korean theatrical releases) for
//! roughly the next six months, cached locally and refreshed at most once a day.
//!
//! Sources and filters (see `docs/research/home-upcoming-sources-20260926.md`):
//!
//! * **Games — IGDB `/v4/games`.** A game is listed when one of its release dates falls in the
//!   window on a current major platform ([`IGDB_MAJOR_PLATFORMS`]), it has at least
//!   [`IGDB_MIN_HYPES`] hypes (IGDB follows before release, the only pre-release popularity
//!   signal IGDB exposes), it is not an edition (`version_parent = null`) or a DLC/expansion
//!   (`parent_game = null`), and its `game_type` is not an add-on type. That keeps the list to
//!   the few hundred titles people are waiting for instead of thousands of store uploads.
//!   The headline date prefers the Korean release, then Asia, then worldwide, then the
//!   earliest; its precision comes from `release_dates.date_format` (deprecated `category` as a
//!   fallback): exact day, month, quarter, year or TBD. Cancelled release dates are ignored.
//! * **Movies — TMDB Discover** with `region=KR`, `with_release_type=2|3` (theatrical limited
//!   or wide), `language=ko-KR`, sorted by popularity. Discover filters by the Korean date but
//!   returns the primary date, so the Korean theatrical date of the most popular
//!   [`TMDB_DETAIL_LIMIT`] titles is read from `/movie/{id}/release_dates`. Titles whose
//!   primary release is more than a year before the window are re-releases and are dropped.
//!   TMDB content is cached for at most [`TMDB_MAX_CACHE_DAYS`] days, as its terms require.
//!
//! Stable title ids are `provider:external_id` (`igdb:1942`, `tmdb:12345`).

use chrono::{DateTime, Datelike, Duration, NaiveDate, TimeZone, Utc};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{credential, error::LibraryError, igdb::IgdbClient, tmdb::TmdbClient, Library};

/// The calendar window: today and the following six months.
pub(crate) const CALENDAR_DAYS: i64 = 183;
const REFRESH_INTERVAL_HOURS: i64 = 24;
const RETRY_AFTER_FAILURE_MINUTES: i64 = 60;
pub(crate) const TMDB_MAX_CACHE_DAYS: i64 = 180;

/// Current major platforms: IGDB platform id and the short label shown in the calendar.
pub(crate) const IGDB_MAJOR_PLATFORMS: &[(i64, &str)] = &[
    (6, "PC"),
    (167, "PS5"),
    (48, "PS4"),
    (508, "Switch 2"),
    (130, "Switch"),
    (169, "Xbox Series"),
    (49, "Xbox One"),
];
/// Minimum IGDB hypes for a game to appear in the calendar.
pub(crate) const IGDB_MIN_HYPES: i64 = 3;
const IGDB_PAGE_SIZE: usize = 500;
const IGDB_MAX_PAGES: usize = 2;
/// IGDB `game_type` values that are add-ons rather than games of their own.
const IGDB_EXCLUDED_GAME_TYPES: &[&str] = &[
    "dlc",
    "dlc addon",
    "expansion",
    "bundle",
    "mod",
    "episode",
    "season",
    "fork",
    "pack",
    "update",
];
pub(crate) const IGDB_FIELDS: &str = "id,name,hypes,cover.image_id,game_type.type,\
release_dates.date,release_dates.y,release_dates.m,release_dates.date_format.format,\
release_dates.category,release_dates.release_region.region,release_dates.region,\
release_dates.platform.id,release_dates.platform.name,release_dates.status.name,\
game_localizations.name,game_localizations.region.identifier,game_localizations.region.name";

const TMDB_DISCOVER_PAGES: u32 = 3;
/// How many of the most popular Discover results get their Korean date looked up.
pub(crate) const TMDB_DETAIL_LIMIT: usize = 60;
const TMDB_RERELEASE_DAYS: i64 = 365;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DatePrecision {
    Exact,
    Month,
    Quarter,
    Year,
    Tbd,
}

impl DatePrecision {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Exact => "exact",
            Self::Month => "month",
            Self::Quarter => "quarter",
            Self::Year => "year",
            Self::Tbd => "tbd",
        }
    }

    pub(crate) fn parse(value: &str) -> Self {
        match value {
            "exact" => Self::Exact,
            "month" => Self::Month,
            "quarter" => Self::Quarter,
            "year" => Self::Year,
            _ => Self::Tbd,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReleaseKind {
    Game,
    Movie,
}

impl ReleaseKind {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Game => "game",
            Self::Movie => "movie",
        }
    }

    pub(crate) fn provider(self) -> &'static str {
        match self {
            Self::Game => "igdb",
            Self::Movie => "tmdb",
        }
    }
}

/// One known release date: a region, a platform ('' for movies), the first day of the stated
/// period (None for TBD) and how precise it is.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderReleaseDate {
    pub region: String,
    pub platform: String,
    pub date: Option<String>,
    pub precision: DatePrecision,
}

/// A game or movie with its headline date and every known date.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseTitle {
    pub id: String,
    pub kind: ReleaseKind,
    pub provider: String,
    pub external_id: String,
    pub title: String,
    pub original_title: Option<String>,
    /// IGDB image id or TMDB poster path; the UI loads it through the media protocol.
    pub cover: Option<String>,
    pub platforms: Vec<String>,
    pub date: Option<String>,
    pub precision: DatePrecision,
    pub region: Option<String>,
    pub popularity: f64,
    pub dates: Vec<ProviderReleaseDate>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarItem {
    #[serde(flatten)]
    pub title: ReleaseTitle,
    pub watched: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarSourceStatus {
    pub provider: String,
    pub fetched_at: Option<String>,
    pub attempted_at: Option<String>,
    pub error_code: Option<String>,
    /// A refresh is due (no data yet, or older than a day and not in a failure back-off).
    pub due: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseCalendar {
    pub range_start: String,
    pub range_end: String,
    pub entries: Vec<CalendarItem>,
    pub sources: Vec<CalendarSourceStatus>,
}

/// Provider requests, so the calendar and wishlist logic can be tested without a network.
pub(crate) trait ReleaseTransport {
    fn igdb(&self, body: &str) -> Result<String, LibraryError>;
    fn tmdb(&self, path: &str, query: &[(&str, String)]) -> Result<String, LibraryError>;
}

pub(crate) struct LiveReleaseTransport {
    igdb: IgdbClient,
    tmdb: TmdbClient,
}

impl ReleaseTransport for LiveReleaseTransport {
    fn igdb(&self, body: &str) -> Result<String, LibraryError> {
        let credentials = credential::read_igdb_credentials_os()?;
        self.igdb.query_games(&credentials, body)
    }

    fn tmdb(&self, path: &str, query: &[(&str, String)]) -> Result<String, LibraryError> {
        let credentials = credential::read_tmdb_token_os()?;
        self.tmdb.get_json(&credentials, path, query)
    }
}

/// A stable public code for a provider failure, shown by the UI.
pub(crate) fn error_code(error: &LibraryError) -> &'static str {
    match error {
        LibraryError::IgdbCredentialNotConfigured
        | LibraryError::TmdbCredentialNotConfigured
        | LibraryError::CredentialStoreUnavailable => "credential_not_configured",
        LibraryError::InvalidIgdbCredential
        | LibraryError::InvalidIgdbCredentialValue
        | LibraryError::InvalidTmdbCredentialValue
        | LibraryError::IgdbUnauthorized
        | LibraryError::TmdbUnauthorized => "invalid_credential",
        LibraryError::IgdbRateLimited | LibraryError::TmdbRateLimited => "rate_limited",
        LibraryError::IgdbTimedOut | LibraryError::TmdbTimedOut => "timed_out",
        LibraryError::IgdbUnavailable | LibraryError::TmdbUnavailable => "unavailable",
        _ => "invalid_response",
    }
}

// ---------------------------------------------------------------------------------------------
// Dates

/// The stated period `[start, end)` of a date, or None for TBD.
pub(crate) fn period(
    date: Option<&str>,
    precision: DatePrecision,
) -> Option<(NaiveDate, NaiveDate)> {
    let start = NaiveDate::parse_from_str(date?, "%Y-%m-%d").ok()?;
    let end = match precision {
        DatePrecision::Exact => start.succ_opt()?,
        DatePrecision::Month => add_months(start, 1)?,
        DatePrecision::Quarter => add_months(start, 3)?,
        DatePrecision::Year => add_months(start, 12)?,
        DatePrecision::Tbd => return None,
    };
    Some((start, end))
}

fn add_months(date: NaiveDate, months: u32) -> Option<NaiveDate> {
    date.checked_add_months(chrono::Months::new(months))
}

/// A canonical value for event history: `2026-10-15`, `2026-10`, `2026-Q4`, `2026` or `tbd`.
pub(crate) fn period_token(date: Option<&str>, precision: DatePrecision) -> String {
    let Some(parsed) = date.and_then(|date| NaiveDate::parse_from_str(date, "%Y-%m-%d").ok())
    else {
        return "tbd".into();
    };
    match precision {
        DatePrecision::Exact => parsed.format("%Y-%m-%d").to_string(),
        DatePrecision::Month => parsed.format("%Y-%m").to_string(),
        DatePrecision::Quarter => format!("{}-Q{}", parsed.year(), (parsed.month() - 1) / 3 + 1),
        DatePrecision::Year => parsed.year().to_string(),
        DatePrecision::Tbd => "tbd".into(),
    }
}

const REGION_PREFERENCE: &[&str] = &["korea", "asia", "worldwide"];

/// The headline date: the Korean release, then Asia, then worldwide, then the earliest dated
/// release anywhere; within a region the earliest period start. TBD when nothing is dated.
pub(crate) fn headline(
    dates: &[ProviderReleaseDate],
) -> (Option<String>, DatePrecision, Option<String>) {
    let earliest = |rows: &mut dyn Iterator<Item = &ProviderReleaseDate>| {
        rows.filter(|row| row.date.is_some() && row.precision != DatePrecision::Tbd)
            // Earliest start; at the same start the more precise statement wins.
            .min_by(|a, b| {
                a.date
                    .cmp(&b.date)
                    .then(rank(a.precision).cmp(&rank(b.precision)))
            })
            .cloned()
    };
    let chosen = REGION_PREFERENCE
        .iter()
        .find_map(|region| earliest(&mut dates.iter().filter(|row| row.region == *region)))
        .or_else(|| earliest(&mut dates.iter()));
    match chosen {
        Some(row) => (row.date, row.precision, Some(row.region)),
        None => (
            None,
            DatePrecision::Tbd,
            dates.first().map(|row| row.region.clone()),
        ),
    }
}

fn rank(precision: DatePrecision) -> u8 {
    match precision {
        DatePrecision::Exact => 0,
        DatePrecision::Month => 1,
        DatePrecision::Quarter => 2,
        DatePrecision::Year => 3,
        DatePrecision::Tbd => 4,
    }
}

fn overlaps(title: &ReleaseTitle, start: NaiveDate, end: NaiveDate) -> bool {
    period(title.date.as_deref(), title.precision)
        .is_some_and(|(from, until)| from < end && until > start)
}

pub(crate) fn window(today: NaiveDate) -> (NaiveDate, NaiveDate) {
    (today, today + Duration::days(CALENDAR_DAYS))
}

// ---------------------------------------------------------------------------------------------
// IGDB

fn igdb_platform_label(id: i64) -> Option<&'static str> {
    IGDB_MAJOR_PLATFORMS
        .iter()
        .find(|(platform, _)| *platform == id)
        .map(|(_, label)| *label)
}

fn igdb_region_name(value: &Value) -> String {
    if let Some(name) = value
        .get("release_region")
        .and_then(|region| region.get("region"))
        .and_then(Value::as_str)
        .filter(|name| !name.trim().is_empty())
    {
        return name.trim().to_ascii_lowercase().replace(' ', "_");
    }
    match value.get("region").and_then(Value::as_i64) {
        Some(1) => "europe",
        Some(2) => "north_america",
        Some(3) => "australia",
        Some(4) => "new_zealand",
        Some(5) => "japan",
        Some(6) => "china",
        Some(7) => "asia",
        Some(8) => "worldwide",
        Some(9) => "korea",
        Some(10) => "brazil",
        _ => "worldwide",
    }
    .into()
}

/// Precision and, for quarters, the quarter number, from `date_format.format` or the
/// deprecated `category` enum (same order: day, month, year, Q1–Q4, TBD).
fn igdb_precision(value: &Value) -> (DatePrecision, Option<u32>) {
    let format = value
        .get("date_format")
        .and_then(|format| format.get("format"))
        .and_then(Value::as_str)
        .map(|format| format.trim().to_ascii_uppercase());
    let format = format.or_else(|| {
        value
            .get("category")
            .and_then(Value::as_i64)
            .map(|category| {
                match category {
                    0 => "YYYYMMMMDD",
                    1 => "YYYYMMMM",
                    2 => "YYYY",
                    3 => "YYYYQ1",
                    4 => "YYYYQ2",
                    5 => "YYYYQ3",
                    6 => "YYYYQ4",
                    _ => "TBD",
                }
                .to_owned()
            })
    });
    match format.as_deref() {
        Some("YYYYMMMMDD") => (DatePrecision::Exact, None),
        Some("YYYYMMMM") => (DatePrecision::Month, None),
        Some("YYYY") => (DatePrecision::Year, None),
        Some(quarter) if quarter.starts_with("YYYYQ") => {
            match quarter[5..]
                .parse::<u32>()
                .ok()
                .filter(|q| (1..=4).contains(q))
            {
                Some(q) => (DatePrecision::Quarter, Some(q)),
                None => (DatePrecision::Tbd, None),
            }
        }
        Some(_) => (DatePrecision::Tbd, None),
        // No format at all: a timestamp alone is a day.
        None if value.get("date").and_then(Value::as_i64).is_some() => (DatePrecision::Exact, None),
        None => (DatePrecision::Tbd, None),
    }
}

fn igdb_release_date(value: &Value) -> Option<(ProviderReleaseDate, Option<i64>)> {
    let status = value
        .get("status")
        .and_then(|status| status.get("name"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    if status.eq_ignore_ascii_case("cancelled") || status.eq_ignore_ascii_case("canceled") {
        return None;
    }
    let platform = value.get("platform");
    let platform_id = platform
        .and_then(|platform| platform.get("id"))
        .and_then(Value::as_i64);
    let platform_label = platform_id
        .and_then(igdb_platform_label)
        .map(str::to_owned)
        .or_else(|| {
            platform
                .and_then(|platform| platform.get("name"))
                .and_then(Value::as_str)
                .map(|name| name.trim().to_owned())
        })
        .unwrap_or_default();
    let timestamp_date = value
        .get("date")
        .and_then(Value::as_i64)
        .and_then(|timestamp| Utc.timestamp_opt(timestamp, 0).single())
        .map(|date| date.date_naive());
    let year = value
        .get("y")
        .and_then(Value::as_i64)
        .and_then(|year| i32::try_from(year).ok())
        .or_else(|| timestamp_date.map(|date| date.year()));
    let month = value
        .get("m")
        .and_then(Value::as_i64)
        .and_then(|month| u32::try_from(month).ok())
        .filter(|month| (1..=12).contains(month))
        .or_else(|| timestamp_date.map(|date| date.month()));
    let (precision, quarter) = igdb_precision(value);
    let date = match precision {
        DatePrecision::Exact => timestamp_date,
        DatePrecision::Month => year
            .zip(month)
            .and_then(|(y, m)| NaiveDate::from_ymd_opt(y, m, 1)),
        DatePrecision::Quarter => year
            .zip(quarter)
            .and_then(|(y, q)| NaiveDate::from_ymd_opt(y, (q - 1) * 3 + 1, 1)),
        DatePrecision::Year => year.and_then(|y| NaiveDate::from_ymd_opt(y, 1, 1)),
        DatePrecision::Tbd => None,
    };
    let precision = if date.is_none() {
        DatePrecision::Tbd
    } else {
        precision
    };
    Some((
        ProviderReleaseDate {
            region: igdb_region_name(value),
            platform: platform_label,
            date: date.map(|date| date.format("%Y-%m-%d").to_string()),
            precision,
        },
        platform_id,
    ))
}

fn korean_localization(game: &Value) -> Option<String> {
    game.get("game_localizations")?
        .as_array()?
        .iter()
        .find_map(|localization| {
            let region = localization.get("region")?;
            let identifier = region
                .get("identifier")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let name = region
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let korean = identifier.to_ascii_uppercase().contains("KR")
                || name.to_ascii_lowercase().contains("korea");
            korean
                .then(|| localization.get("name").and_then(Value::as_str))
                .flatten()
                .map(str::trim)
                .filter(|title| !title.is_empty())
                .map(str::to_owned)
        })
}

/// Normalize one IGDB game. With `major_only`, only releases on major platforms count toward
/// the headline and platform list (the calendar); otherwise every release counts (a watched
/// title the user picked). None for add-on types or unusable records.
pub(crate) fn igdb_title(game: &Value, major_only: bool) -> Option<ReleaseTitle> {
    let id = game
        .get("id")
        .and_then(Value::as_i64)
        .filter(|id| *id > 0)?;
    let name = game
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty())?;
    let game_type = game
        .get("game_type")
        .and_then(|kind| kind.get("type"))
        .and_then(Value::as_str)
        .map(|kind| kind.trim().to_ascii_lowercase().replace('_', " "));
    if game_type
        .as_deref()
        .is_some_and(|kind| IGDB_EXCLUDED_GAME_TYPES.contains(&kind))
    {
        return None;
    }
    let mut dates: Vec<ProviderReleaseDate> = Vec::new();
    for (row, platform_id) in game
        .get("release_dates")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(igdb_release_date)
    {
        if major_only && platform_id.and_then(igdb_platform_label).is_none() {
            continue;
        }
        // One row per region and platform: keep the earliest (most precise on ties).
        match dates
            .iter_mut()
            .find(|known| known.region == row.region && known.platform == row.platform)
        {
            Some(known) => {
                let better = match (&row.date, &known.date) {
                    (Some(_), None) => true,
                    (Some(new), Some(old)) => {
                        new < old || (new == old && rank(row.precision) < rank(known.precision))
                    }
                    _ => false,
                };
                if better {
                    *known = row;
                }
            }
            None => dates.push(row),
        }
    }
    let mut platforms: Vec<String> = Vec::new();
    for row in &dates {
        if !row.platform.is_empty() && !platforms.contains(&row.platform) {
            platforms.push(row.platform.clone());
        }
    }
    let order = |label: &String| {
        IGDB_MAJOR_PLATFORMS
            .iter()
            .position(|(_, known)| known == label)
            .unwrap_or(usize::MAX)
    };
    platforms.sort_by_key(order);
    let (date, precision, region) = headline(&dates);
    let korean = korean_localization(game);
    Some(ReleaseTitle {
        id: format!("igdb:{id}"),
        kind: ReleaseKind::Game,
        provider: "igdb".into(),
        external_id: id.to_string(),
        title: korean.clone().unwrap_or_else(|| name.to_owned()),
        original_title: korean.map(|_| name.to_owned()),
        cover: game
            .get("cover")
            .and_then(|cover| cover.get("image_id"))
            .and_then(Value::as_str)
            .filter(|image| !image.is_empty())
            .map(str::to_owned),
        platforms,
        date,
        precision,
        region,
        popularity: game.get("hypes").and_then(Value::as_f64).unwrap_or(0.0),
        dates,
    })
}

pub(crate) fn igdb_calendar_body(start: NaiveDate, end: NaiveDate, offset: usize) -> String {
    let timestamp = |date: NaiveDate| {
        date.and_hms_opt(0, 0, 0)
            .expect("midnight")
            .and_utc()
            .timestamp()
    };
    let platforms = IGDB_MAJOR_PLATFORMS
        .iter()
        .map(|(id, _)| id.to_string())
        .collect::<Vec<_>>()
        .join(",");
    format!(
        "fields {IGDB_FIELDS}; where release_dates.date >= {} & release_dates.date < {} \
         & release_dates.platform = ({platforms}) & hypes >= {IGDB_MIN_HYPES} \
         & version_parent = null & parent_game = null; sort hypes desc; limit {IGDB_PAGE_SIZE}; \
         offset {offset};",
        timestamp(start),
        timestamp(end),
    )
}

pub(crate) fn igdb_titles_body(ids: &[i64]) -> String {
    let ids = ids.iter().map(i64::to_string).collect::<Vec<_>>().join(",");
    format!("fields {IGDB_FIELDS}; where id = ({ids}); limit 50;")
}

fn parse_array(json: &str, invalid: LibraryError) -> Result<Vec<Value>, LibraryError> {
    match serde_json::from_str::<Value>(json) {
        Ok(Value::Array(values)) => Ok(values),
        _ => Err(invalid),
    }
}

pub(crate) fn fetch_upcoming_games(
    transport: &dyn ReleaseTransport,
    start: NaiveDate,
    end: NaiveDate,
) -> Result<Vec<ReleaseTitle>, LibraryError> {
    let mut titles: Vec<ReleaseTitle> = Vec::new();
    for page in 0..IGDB_MAX_PAGES {
        let games = parse_array(
            &transport.igdb(&igdb_calendar_body(start, end, page * IGDB_PAGE_SIZE))?,
            LibraryError::IgdbInvalidResponse,
        )?;
        let count = games.len();
        for title in games.iter().filter_map(|game| igdb_title(game, true)) {
            if overlaps(&title, start, end) && !titles.iter().any(|known| known.id == title.id) {
                titles.push(title);
            }
        }
        if count < IGDB_PAGE_SIZE {
            break;
        }
    }
    Ok(titles)
}

pub(crate) fn fetch_games(
    transport: &dyn ReleaseTransport,
    ids: &[i64],
) -> Result<Vec<ReleaseTitle>, LibraryError> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let games = parse_array(
        &transport.igdb(&igdb_titles_body(ids))?,
        LibraryError::IgdbInvalidResponse,
    )?;
    // Watched games use the calendar's major-platform dates, so the first check after adding
    // one from the calendar does not report a spurious change; a game only on other platforms
    // falls back to all of them.
    Ok(games
        .iter()
        .filter_map(|game| {
            igdb_title(game, true)
                .filter(|title| !title.dates.is_empty())
                .or_else(|| igdb_title(game, false))
        })
        .collect())
}

// ---------------------------------------------------------------------------------------------
// TMDB

fn tmdb_text(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
}

fn tmdb_day(value: Option<&str>) -> Option<NaiveDate> {
    let value = value?.trim();
    NaiveDate::parse_from_str(value.get(..10)?, "%Y-%m-%d").ok()
}

/// Korean theatrical (type 2 limited, 3 wide) and primary release dates of a movie.
fn tmdb_dates(movie: &Value, release_dates: Option<&Value>) -> Vec<ProviderReleaseDate> {
    let mut dates = Vec::new();
    let korean = release_dates
        .and_then(|value| value.get("results"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|country| country.get("iso_3166_1").and_then(Value::as_str) == Some("KR"))
        .flat_map(|country| {
            country
                .get("release_dates")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
        })
        .filter(|release| matches!(release.get("type").and_then(Value::as_i64), Some(2 | 3)))
        .filter_map(|release| tmdb_day(release.get("release_date").and_then(Value::as_str)))
        .min();
    if let Some(date) = korean {
        dates.push(ProviderReleaseDate {
            region: "korea".into(),
            platform: String::new(),
            date: Some(date.format("%Y-%m-%d").to_string()),
            precision: DatePrecision::Exact,
        });
    }
    let primary = tmdb_day(movie.get("release_date").and_then(Value::as_str));
    dates.push(ProviderReleaseDate {
        region: "worldwide".into(),
        platform: String::new(),
        date: primary.map(|date| date.format("%Y-%m-%d").to_string()),
        precision: if primary.is_some() {
            DatePrecision::Exact
        } else {
            DatePrecision::Tbd
        },
    });
    dates
}

/// Normalize a TMDB movie (a Discover result or a `/movie/{id}` detail) with its release dates
/// (`/movie/{id}/release_dates`, or the detail's appended `release_dates`).
pub(crate) fn tmdb_title(movie: &Value, release_dates: Option<&Value>) -> Option<ReleaseTitle> {
    let id = movie
        .get("id")
        .and_then(Value::as_i64)
        .filter(|id| *id > 0)?;
    let original = tmdb_text(movie, "original_title");
    let title = tmdb_text(movie, "title").or_else(|| original.clone())?;
    let dates = tmdb_dates(movie, release_dates.or_else(|| movie.get("release_dates")));
    let (date, precision, region) = headline(&dates);
    Some(ReleaseTitle {
        id: format!("tmdb:{id}"),
        kind: ReleaseKind::Movie,
        provider: "tmdb".into(),
        external_id: id.to_string(),
        original_title: original.filter(|original| *original != title),
        title,
        cover: tmdb_text(movie, "poster_path").filter(|path| path.starts_with('/')),
        platforms: Vec::new(),
        date,
        precision,
        region,
        popularity: movie
            .get("popularity")
            .and_then(Value::as_f64)
            .unwrap_or(0.0),
        dates,
    })
}

fn tmdb_object(json: &str) -> Result<Value, LibraryError> {
    match serde_json::from_str::<Value>(json) {
        Ok(value @ Value::Object(_)) => Ok(value),
        _ => Err(LibraryError::TmdbInvalidResponse),
    }
}

pub(crate) fn fetch_upcoming_movies(
    transport: &dyn ReleaseTransport,
    start: NaiveDate,
    end: NaiveDate,
) -> Result<Vec<ReleaseTitle>, LibraryError> {
    let mut discovered: Vec<Value> = Vec::new();
    for page in 1..=TMDB_DISCOVER_PAGES {
        let response = tmdb_object(&transport.tmdb(
            "/discover/movie",
            &[
                ("region", "KR".into()),
                ("with_release_type", "2|3".into()),
                ("release_date.gte", start.format("%Y-%m-%d").to_string()),
                (
                    "release_date.lte",
                    (end - Duration::days(1)).format("%Y-%m-%d").to_string(),
                ),
                ("language", "ko-KR".into()),
                ("sort_by", "popularity.desc".into()),
                ("include_adult", "false".into()),
                ("include_video", "false".into()),
                ("page", page.to_string()),
            ],
        )?)?;
        let results = response
            .get("results")
            .and_then(Value::as_array)
            .ok_or(LibraryError::TmdbInvalidResponse)?;
        discovered.extend(results.iter().cloned());
        let pages = response
            .get("total_pages")
            .and_then(Value::as_u64)
            .unwrap_or(1);
        if u64::from(page) >= pages {
            break;
        }
    }
    let rerelease_before = start - Duration::days(TMDB_RERELEASE_DAYS);
    let mut titles: Vec<ReleaseTitle> = Vec::new();
    for movie in discovered.iter().take(TMDB_DETAIL_LIMIT) {
        let Some(id) = movie.get("id").and_then(Value::as_i64).filter(|id| *id > 0) else {
            continue;
        };
        if titles
            .iter()
            .any(|known| known.external_id == id.to_string())
        {
            continue;
        }
        if tmdb_day(movie.get("release_date").and_then(Value::as_str))
            .is_some_and(|primary| primary < rerelease_before)
        {
            continue;
        }
        let release_dates =
            tmdb_object(&transport.tmdb(&format!("/movie/{id}/release_dates"), &[])?)?;
        if let Some(title) = tmdb_title(movie, Some(&release_dates)) {
            if overlaps(&title, start, end) {
                titles.push(title);
            }
        }
    }
    Ok(titles)
}

pub(crate) fn fetch_movie(
    transport: &dyn ReleaseTransport,
    id: i64,
) -> Result<ReleaseTitle, LibraryError> {
    if id <= 0 {
        return Err(LibraryError::InvalidTmdbIdentity);
    }
    let movie = tmdb_object(&transport.tmdb(
        &format!("/movie/{id}"),
        &[
            ("language", "ko-KR".into()),
            ("append_to_response", "release_dates".into()),
        ],
    )?)?;
    if movie.get("id").and_then(Value::as_i64) != Some(id) {
        return Err(LibraryError::InvalidTmdbIdentity);
    }
    tmdb_title(&movie, None).ok_or(LibraryError::TmdbInvalidResponse)
}

// ---------------------------------------------------------------------------------------------
// Cache

struct CacheRow {
    fetched_at: Option<DateTime<Utc>>,
    attempted_at: Option<DateTime<Utc>>,
    error_code: Option<String>,
    entries: Vec<ReleaseTitle>,
}

fn parse_time(value: Option<String>) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value?.as_str())
        .ok()
        .map(|time| time.with_timezone(&Utc))
}

fn read_cache(
    connection: &rusqlite::Connection,
    provider: &str,
    now: DateTime<Utc>,
) -> Result<CacheRow, LibraryError> {
    let row = connection
        .query_row(
            "SELECT fetched_at, attempted_at, error_code, entries_json FROM release_calendar_cache WHERE provider = ?1",
            [provider],
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, String>(3)?,
                ))
            },
        )
        .optional()?;
    let Some((fetched_at, attempted_at, error_code, entries_json)) = row else {
        return Ok(CacheRow {
            fetched_at: None,
            attempted_at: None,
            error_code: None,
            entries: Vec::new(),
        });
    };
    let fetched_at = parse_time(fetched_at);
    // Never serve provider content older than the TMDB cache limit.
    let expired =
        fetched_at.is_none_or(|fetched| now - fetched > Duration::days(TMDB_MAX_CACHE_DAYS));
    Ok(CacheRow {
        fetched_at: if expired { None } else { fetched_at },
        attempted_at: parse_time(attempted_at),
        error_code,
        entries: if expired {
            Vec::new()
        } else {
            serde_json::from_str(&entries_json).unwrap_or_default()
        },
    })
}

fn refresh_due(cache: &CacheRow, now: DateTime<Utc>) -> bool {
    let stale = cache
        .fetched_at
        .is_none_or(|fetched| now - fetched >= Duration::hours(REFRESH_INTERVAL_HOURS));
    let backing_off = cache.error_code.is_some()
        && cache.attempted_at.is_some_and(|attempted| {
            now - attempted < Duration::minutes(RETRY_AFTER_FAILURE_MINUTES)
        });
    stale && !backing_off
}

pub(crate) fn cached_title(
    connection: &rusqlite::Connection,
    id: &str,
    now: DateTime<Utc>,
) -> Result<Option<ReleaseTitle>, LibraryError> {
    for provider in ["igdb", "tmdb"] {
        if let Some(title) = read_cache(connection, provider, now)?
            .entries
            .into_iter()
            .find(|title| title.id == id)
        {
            return Ok(Some(title));
        }
    }
    Ok(None)
}

impl Library {
    pub(crate) fn release_transport(&self) -> LiveReleaseTransport {
        LiveReleaseTransport {
            igdb: self.igdb_client(),
            tmdb: TmdbClient::new(),
        }
    }

    /// The cached calendar for today's window, with watched flags. No network access.
    pub fn release_calendar(&self) -> Result<ReleaseCalendar, LibraryError> {
        self.release_calendar_at(Utc::now(), chrono::Local::now().date_naive())
    }

    pub(crate) fn release_calendar_at(
        &self,
        now: DateTime<Utc>,
        today: NaiveDate,
    ) -> Result<ReleaseCalendar, LibraryError> {
        let connection = self.connection()?;
        let (start, end) = window(today);
        let watched: std::collections::HashSet<String> = connection
            .prepare("SELECT id FROM release_watch_items")?
            .query_map([], |row| row.get(0))?
            .collect::<Result<_, _>>()?;
        let mut entries = Vec::new();
        let mut sources = Vec::new();
        for provider in ["igdb", "tmdb"] {
            let cache = read_cache(&connection, provider, now)?;
            sources.push(CalendarSourceStatus {
                provider: provider.into(),
                fetched_at: cache.fetched_at.map(|time| time.to_rfc3339()),
                attempted_at: cache.attempted_at.map(|time| time.to_rfc3339()),
                error_code: cache.error_code.clone(),
                due: refresh_due(&cache, now),
            });
            entries.extend(
                cache
                    .entries
                    .into_iter()
                    .filter(|title| overlaps(title, start, end))
                    .map(|title| CalendarItem {
                        watched: watched.contains(&title.id),
                        title,
                    }),
            );
        }
        entries.sort_by(|a, b| {
            a.title
                .date
                .cmp(&b.title.date)
                .then(rank(a.title.precision).cmp(&rank(b.title.precision)))
                .then(b.title.popularity.total_cmp(&a.title.popularity))
                .then(a.title.id.cmp(&b.title.id))
        });
        Ok(ReleaseCalendar {
            range_start: start.format("%Y-%m-%d").to_string(),
            range_end: end.format("%Y-%m-%d").to_string(),
            entries,
            sources,
        })
    }

    /// Refresh each provider whose cache is due (older than a day), or every provider with
    /// `force` outside a failure back-off. Network requests run without the database lock.
    pub fn refresh_release_calendar(&self, force: bool) -> Result<ReleaseCalendar, LibraryError> {
        let transport = self.release_transport();
        self.refresh_release_calendar_with(
            &transport,
            force,
            Utc::now(),
            chrono::Local::now().date_naive(),
        )
    }

    pub(crate) fn refresh_release_calendar_with(
        &self,
        transport: &dyn ReleaseTransport,
        force: bool,
        now: DateTime<Utc>,
        today: NaiveDate,
    ) -> Result<ReleaseCalendar, LibraryError> {
        let (start, end) = window(today);
        for provider in ["igdb", "tmdb"] {
            let due = {
                let connection = self.connection()?;
                let cache = read_cache(&connection, provider, now)?;
                let recently_fetched = cache.fetched_at.is_some_and(|fetched| {
                    now - fetched < Duration::minutes(RETRY_AFTER_FAILURE_MINUTES)
                });
                if force {
                    !recently_fetched
                        && refresh_due(
                            &CacheRow {
                                fetched_at: None,
                                ..cache
                            },
                            now,
                        )
                } else {
                    refresh_due(&cache, now)
                }
            };
            if !due {
                continue;
            }
            let fetched = if provider == "igdb" {
                fetch_upcoming_games(transport, start, end)
            } else {
                fetch_upcoming_movies(transport, start, end)
            };
            let connection = self.connection()?;
            let attempted = now.to_rfc3339();
            match fetched {
                Ok(entries) => {
                    connection.execute(
                        "INSERT INTO release_calendar_cache(provider, fetched_at, range_start, range_end, entries_json, attempted_at, error_code)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?2, NULL)
                         ON CONFLICT(provider) DO UPDATE SET fetched_at = excluded.fetched_at,
                           range_start = excluded.range_start, range_end = excluded.range_end,
                           entries_json = excluded.entries_json, attempted_at = excluded.attempted_at,
                           error_code = NULL",
                        params![
                            provider,
                            attempted,
                            start.format("%Y-%m-%d").to_string(),
                            end.format("%Y-%m-%d").to_string(),
                            serde_json::to_string(&entries).map_err(|_| LibraryError::InvalidCloudResponse)?,
                        ],
                    )?;
                }
                Err(error) => {
                    connection.execute(
                        "INSERT INTO release_calendar_cache(provider, attempted_at, error_code) VALUES (?1, ?2, ?3)
                         ON CONFLICT(provider) DO UPDATE SET attempted_at = excluded.attempted_at, error_code = excluded.error_code",
                        params![provider, attempted, error_code(&error)],
                    )?;
                }
            }
        }
        self.release_calendar_at(now, today)
    }
}

#[cfg(test)]
#[path = "release_calendar_tests.rs"]
pub(crate) mod tests;
