//! The game/movie/anime wishlist (관심 목록): titles the user picked from the 발매 캘린더 (or added by
//! provider id), tracked like manga releases.
//!
//! A due-runner re-reads each watched title every 24 hours, every 6 hours within 14 days of an
//! exact release date, and stops 30 days after release. Changes of the headline date become
//! `release_watch_item_events` (`date_set`, `date_changed`, `released`), which stay unread until
//! acknowledged by exact id. Watched titles are never Collections.

use chrono::{DateTime, Duration, NaiveDate, Utc};
use rusqlite::{params, OptionalExtension};
use serde::{Serialize, Deserialize};

use super::{
    error::LibraryError,
    release_calendar::{
        cached_title, error_code, fetch_anime, fetch_games, fetch_movie, headline, period, period_token,
        DatePrecision, ProviderReleaseDate, ReleaseKind, ReleaseTitle, ReleaseTransport,
    },
    Library,
};

const CHECK_INTERVAL_HOURS: i64 = 24;
const NEAR_RELEASE_INTERVAL_HOURS: i64 = 6;
const NEAR_RELEASE_DAYS: i64 = 14;
const STOP_AFTER_RELEASE_DAYS: i64 = 30;
/// Titles checked per run; the hourly scheduler continues with the rest.
const RUN_LIMIT: usize = 40;
const IGDB_BATCH: usize = 10;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchEvent {
    pub id: String,
    pub item_id: String,
    pub kind: String,
    pub previous_value: Option<String>,
    pub current_value: Option<String>,
    pub detected_at: String,
    pub read_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchItem {
    pub id: String,
    pub kind: ReleaseKind,
    pub provider: String,
    pub external_id: String,
    pub title: String,
    pub original_title: Option<String>,
    pub cover: Option<String>,
    pub platforms: Vec<String>,
    pub date: Option<String>,
    pub precision: DatePrecision,
    pub region: Option<String>,
    pub dates: Vec<ProviderReleaseDate>,
    pub source: String,
    pub added_at: String,
    pub muted: bool,
    pub last_checked_at: Option<String>,
    pub next_check_at: Option<String>,
    pub released: bool,
    pub unread: Vec<WatchEvent>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchRunResult {
    pub checked: usize,
    pub changed: usize,
    pub remaining: usize,
    /// Error code of the first provider failure; the other provider still runs.
    pub stop_reason: Option<String>,
}

/// When to check a title next: None once it was released more than 30 days ago.
pub(crate) fn next_check(
    now: DateTime<Utc>,
    today: NaiveDate,
    date: Option<&str>,
    precision: DatePrecision,
) -> Option<DateTime<Utc>> {
    if precision == DatePrecision::Exact {
        if let Some((day, _)) = period(date, precision) {
            let until = (day - today).num_days();
            if until < -STOP_AFTER_RELEASE_DAYS {
                return None;
            }
            if until <= NEAR_RELEASE_DAYS {
                return Some(now + Duration::hours(NEAR_RELEASE_INTERVAL_HOURS));
            }
        }
    }
    Some(now + Duration::hours(CHECK_INTERVAL_HOURS))
}

/// The events one check records: the headline moved (`date_set` when it became dated or was
/// narrowed to a day inside the stated period, else `date_changed`), and `released` once an
/// exact date is reached.
pub(crate) fn detect_changes(
    previous: (Option<&str>, DatePrecision),
    current: (Option<&str>, DatePrecision),
    already_released: bool,
    today: NaiveDate,
) -> Vec<(&'static str, Option<String>, Option<String>)> {
    let before = period_token(previous.0, previous.1);
    let after = period_token(current.0, current.1);
    let mut events = Vec::new();
    if before != after {
        let narrowed = current.1 == DatePrecision::Exact
            && period(previous.0, previous.1)
                .zip(period(current.0, current.1))
                .is_some_and(|((from, until), (day, _))| day >= from && day < until);
        let kind =
            if previous.1 == DatePrecision::Tbd && current.1 != DatePrecision::Tbd || narrowed {
                "date_set"
            } else {
                "date_changed"
            };
        events.push((kind, Some(before), Some(after.clone())));
    }
    if !already_released && released_on(current.0, current.1, today) {
        events.push(("released", None, Some(after)));
    }
    events
}

fn released_on(date: Option<&str>, precision: DatePrecision, today: NaiveDate) -> bool {
    precision == DatePrecision::Exact
        && period(date, precision).is_some_and(|(day, _)| day <= today)
}

fn split_id(id: &str) -> Result<(ReleaseKind, i64, Option<i64>), LibraryError> {
    let (provider, external) = id
        .split_once(':')
        .ok_or(LibraryError::InvalidIgdbIdentity)?;
    if provider == "tmdb" && external.starts_with("tv:") {
        let (show, season) = external[3..]
            .split_once(":s")
            .ok_or(LibraryError::InvalidTmdbIdentity)?;
        let canonical = |value: &str| {
            value
                .parse::<i64>()
                .ok()
                .filter(|number| *number > 0 && number.to_string() == value)
                .ok_or(LibraryError::InvalidTmdbIdentity)
        };
        return Ok((
            ReleaseKind::Anime,
            canonical(show)?,
            Some(canonical(season)?),
        ));
    }
    let kind = match provider {
        "igdb" => ReleaseKind::Game,
        "tmdb" => ReleaseKind::Movie,
        _ => return Err(LibraryError::InvalidIgdbIdentity),
    };
    let number = external
        .parse::<i64>()
        .ok()
        .filter(|value| *value > 0 && value.to_string() == external)
        .ok_or(match kind {
            ReleaseKind::Game => LibraryError::InvalidIgdbIdentity,
            ReleaseKind::Movie | ReleaseKind::Anime => LibraryError::InvalidTmdbIdentity,
        })?;
    Ok((kind, number, None))
}

fn read_dates(
    transaction: &rusqlite::Connection,
    id: &str,
) -> Result<Vec<ProviderReleaseDate>, LibraryError> {
    let mut statement = transaction.prepare(
        "SELECT region, platform, date, precision FROM release_watch_dates WHERE item_id = ?1 ORDER BY region, platform",
    )?;
    let rows = statement
        .query_map([id], |row| {
            Ok(ProviderReleaseDate {
                region: row.get(0)?,
                platform: row.get(1)?,
                date: row.get(2)?,
                precision: DatePrecision::parse(&row.get::<_, String>(3)?),
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

fn write_title(
    transaction: &rusqlite::Connection,
    title: &ReleaseTitle,
    checked_at: &str,
) -> Result<(), LibraryError> {
    transaction.execute(
        "UPDATE release_watch_items SET title = ?2, original_title = ?3, cover = COALESCE(?4, cover),
           platforms_json = ?5 WHERE id = ?1",
        params![
            title.id,
            title.title,
            title.original_title,
            title.cover,
            serde_json::to_string(&title.platforms).unwrap_or_else(|_| "[]".into()),
        ],
    )?;
    transaction.execute(
        "DELETE FROM release_watch_dates WHERE item_id = ?1",
        [&title.id],
    )?;
    for row in &title.dates {
        transaction.execute(
            "INSERT OR REPLACE INTO release_watch_dates(item_id, region, platform, date, precision, checked_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![title.id, row.region, row.platform, row.date, row.precision.as_str(), checked_at],
        )?;
    }
    Ok(())
}

fn restrict_to_tracked_platforms(
    title: &ReleaseTitle,
    tracked_platforms: &[String],
) -> Option<ReleaseTitle> {
    let mut scoped = title.clone();
    scoped
        .dates
        .retain(|row| tracked_platforms.contains(&row.platform));
    if scoped.dates.is_empty() {
        return None;
    }
    scoped.platforms = tracked_platforms
        .iter()
        .filter(|platform| scoped.dates.iter().any(|row| &row.platform == *platform))
        .cloned()
        .collect();
    (scoped.date, scoped.precision, scoped.region) = headline(&scoped.dates);
    Some(scoped)
}

pub(crate) fn insert_watch(
    transaction: &rusqlite::Connection,
    title: &ReleaseTitle,
    source: &str,
    now: DateTime<Utc>,
    today: NaiveDate,
) -> Result<(), LibraryError> {
    let id = &title.id;
    let checked_at = now.to_rfc3339();
    let exists: bool = transaction.query_row(
        "SELECT EXISTS(SELECT 1 FROM release_watch_items WHERE id = ?1)",
        [id],
        |row| row.get(0),
    )?;
    if !exists {
        let released = released_on(title.date.as_deref(), title.precision, today);
        let tracked_platforms = (source == "calendar" && title.port)
            .then(|| serde_json::to_string(&title.platforms).unwrap_or_else(|_| "[]".into()));
        transaction.execute(
                "INSERT INTO release_watch_items(id, kind, provider, external_id, title, original_title, cover,
                   platforms_json, tracked_platforms_json, source, added_at, last_checked_at, next_check_at, released_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, '[]', ?8, ?9, ?10, ?10, ?11, ?12)",
                params![
                    title.id,
                    title.kind.as_str(),
                    title.kind.provider(),
                    title.external_id,
                    title.title,
                    title.original_title,
                    title.cover,
                    tracked_platforms,
                    source,
                    checked_at,
                    next_check(now, today, title.date.as_deref(), title.precision).map(|time| time.to_rfc3339()),
                    released.then(|| checked_at.clone()),
                ],
            )?;
        write_title(transaction, &title, &checked_at)?;
    }
    Ok(())
}

pub(crate) fn remove_watch(db: &rusqlite::Connection, id: &str) -> Result<(), LibraryError> {
    split_id(id)?;
    db.execute("DELETE FROM release_watch_items WHERE id = ?1", [id])?;
    Ok(())
}

pub(crate) fn mute_watch(
    db: &rusqlite::Connection,
    id: &str,
    muted: bool,
) -> Result<(), LibraryError> {
    split_id(id)?;
    db.execute(
        "UPDATE release_watch_items SET muted = ?2 WHERE id = ?1",
        params![id, muted],
    )?;
    Ok(())
}

pub(crate) fn acknowledge_watch(
    db: &rusqlite::Connection,
    event_ids: &[String],
) -> Result<(), LibraryError> {
    let read_at = Utc::now().to_rfc3339();
    for id in event_ids {
        db.execute(
            "UPDATE release_watch_item_events SET read_at = ?2 WHERE id = ?1 AND read_at IS NULL",
            params![id, read_at],
        )?;
    }
    Ok(())
}

impl Library {
    /// Add a title to the wishlist: from the cached calendar when it is there (source
    /// `calendar`), else read from its provider (source `manual`). Adding records no events;
    /// the stored dates are the baseline later checks compare with.
    pub fn add_release_watch(&self, id: &str) -> Result<WatchItem, LibraryError> {
        let transport = self.release_transport();
        self.add_release_watch_with(
            &transport,
            id,
            Utc::now(),
            chrono::Local::now().date_naive(),
        )
    }

    pub(crate) fn add_release_watch_with(
        &self,
        transport: &dyn ReleaseTransport,
        id: &str,
        now: DateTime<Utc>,
        today: NaiveDate,
    ) -> Result<WatchItem, LibraryError> {
        let _guard = self.release_wishlist_authority.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if self.server_release_wishlist_blocked()? {
            self.queue_wishlist_intent("add", id, &[])?;
            return self.server_wishlist_items()?.into_iter().find(|i|i.id == id).ok_or(LibraryError::IgdbNotFound);
        }
        let (kind, number, season) = split_id(id)?;
        let cached = if self.server_release_calendar_enabled() {
            self.server_calendar_title(id)?
        } else {
            cached_title(&*self.connection()?, id, now)?
        };
        let (title, source) = match cached {
            Some(title) => (title, "calendar"),
            None => {
                let title = match kind {
                    ReleaseKind::Game => fetch_games(transport, &[number])?
                        .into_iter()
                        .find(|title| title.id == id)
                        .ok_or(LibraryError::IgdbNotFound)?,
                    ReleaseKind::Movie => fetch_movie(transport, number)?,
                    ReleaseKind::Anime => fetch_anime(transport, number, season.unwrap())?,
                };
                (title, "manual")
            }
        };
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        insert_watch(&transaction, &title, source, now, today)?;
        transaction.commit()?;
        self.publication_inputs.signal(&[8]);
        drop(connection);
        self.release_watch_item(id)?
            .ok_or(LibraryError::IgdbNotFound)
    }

    pub fn remove_release_watch(&self, id: &str) -> Result<(), LibraryError> {
        let _guard = self.release_wishlist_authority.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if self.server_release_wishlist_blocked()? { return self.queue_wishlist_intent("remove", id, &[]); }
        remove_watch(&*self.connection()?, id)?;
        self.publication_inputs.signal(&[8]);
        Ok(())
    }

    pub fn set_release_watch_muted(&self, id: &str, muted: bool) -> Result<(), LibraryError> {
        let _guard = self.release_wishlist_authority.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if self.server_release_wishlist_blocked()? { return self.queue_wishlist_intent(if muted {"mute"} else {"unmute"}, id, &[]); }
        mute_watch(&*self.connection()?, id, muted)?;
        self.publication_inputs.signal(&[8]);
        Ok(())
    }

    /// Mark exactly these events read; later events stay unread.
    pub fn acknowledge_release_watch_events(
        &self,
        event_ids: &[String],
    ) -> Result<(), LibraryError> {
        let _guard = self.release_wishlist_authority.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if self.server_release_wishlist_blocked()? {
            let items = self.server_wishlist_items()?;
            for item in items {
                let ids: Vec<_> = item.unread.into_iter().filter(|e|event_ids.contains(&e.id)).map(|e|e.id).collect();
                for chunk in ids.chunks(100) { self.queue_wishlist_intent("acknowledge", &item.id, chunk)?; }
            }
            return Ok(());
        }
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        acknowledge_watch(&transaction, event_ids)?;
        transaction.commit()?;
        self.publication_inputs.signal(&[8]);
        Ok(())
    }

    fn release_watch_item(&self, id: &str) -> Result<Option<WatchItem>, LibraryError> {
        Ok(self.release_watch_items_where(Some(id))?.pop())
    }

    /// Every watched title with its headline date and unread events, soonest first.
    pub fn list_release_watch(&self) -> Result<Vec<WatchItem>, LibraryError> {
        if self.server_release_wishlist_blocked()? { return self.server_wishlist_items(); }
        self.local_release_watch_items()
    }

    pub(super) fn local_release_watch_items(&self) -> Result<Vec<WatchItem>, LibraryError> {
        self.release_watch_items_where(None)
    }

    pub(super) fn local_wishlist_public_title(&self, id: &str) -> Result<Option<serde_json::Value>, LibraryError> {
        let title = cached_title(&*self.connection()?, id, Utc::now())?;
        Ok(title.as_ref().map(super::home_publications::title))
    }

    fn release_watch_items_where(
        &self,
        only: Option<&str>,
    ) -> Result<Vec<WatchItem>, LibraryError> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT id, kind, provider, external_id, title, original_title, cover, platforms_json, source,
                    added_at, muted, last_checked_at, next_check_at, released_at
             FROM release_watch_items WHERE ?1 IS NULL OR id = ?1",
        )?;
        let rows = statement
            .query_map([only], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, Option<String>>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, String>(8)?,
                    row.get::<_, String>(9)?,
                    row.get::<_, bool>(10)?,
                    row.get::<_, Option<String>>(11)?,
                    row.get::<_, Option<String>>(12)?,
                    row.get::<_, Option<String>>(13)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let mut events = connection.prepare(
            "SELECT id, item_id, event_kind, previous_value, current_value, detected_at, read_at
             FROM release_watch_item_events WHERE item_id = ?1 AND read_at IS NULL ORDER BY detected_at, id",
        )?;
        let mut items = Vec::with_capacity(rows.len());
        for (
            id,
            kind,
            provider,
            external_id,
            title,
            original_title,
            cover,
            platforms,
            source,
            added_at,
            muted,
            last_checked_at,
            next_check_at,
            released_at,
        ) in rows
        {
            let dates = read_dates(&connection, &id)?;
            let (date, precision, region) = headline(&dates);
            let unread = events
                .query_map([&id], |row| {
                    Ok(WatchEvent {
                        id: row.get(0)?,
                        item_id: row.get(1)?,
                        kind: row.get(2)?,
                        previous_value: row.get(3)?,
                        current_value: row.get(4)?,
                        detected_at: row.get(5)?,
                        read_at: row.get(6)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            items.push(WatchItem {
                kind: match kind.as_str() {
                    "movie" => ReleaseKind::Movie,
                    "anime" => ReleaseKind::Anime,
                    _ => ReleaseKind::Game,
                },
                id,
                provider,
                external_id,
                title,
                original_title,
                cover,
                platforms: serde_json::from_str(&platforms).unwrap_or_default(),
                date,
                precision,
                region,
                dates,
                source,
                added_at,
                muted,
                last_checked_at,
                next_check_at,
                released: released_at.is_some(),
                unread,
            });
        }
        items.sort_by(|a, b| {
            (a.date.is_none(), &a.date, &a.title, &a.id).cmp(&(
                b.date.is_none(),
                &b.date,
                &b.title,
                &b.id,
            ))
        });
        Ok(items)
    }

    /// Check the watched titles that are due. Network requests run without the database lock.
    pub fn run_due_release_watchlist(&self) -> Result<WatchRunResult, LibraryError> {
        let transport = self.release_transport();
        self.run_due_release_watchlist_with(
            &transport,
            Utc::now(),
            chrono::Local::now().date_naive(),
        )
    }

    pub(crate) fn run_due_release_watchlist_with(
        &self,
        transport: &dyn ReleaseTransport,
        now: DateTime<Utc>,
        today: NaiveDate,
    ) -> Result<WatchRunResult, LibraryError> {
        let _guard = self.release_wishlist_authority.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if self.server_release_wishlist_blocked()? {
            return Ok(WatchRunResult { checked:0, changed:0, remaining:0, stop_reason:None });
        }
        let due: Vec<String> = {
            let connection = self.connection()?;
            let mut statement = connection.prepare(
                "SELECT id FROM release_watch_items
                 WHERE muted = 0 AND next_check_at IS NOT NULL AND next_check_at <= ?1
                 ORDER BY next_check_at, id",
            )?;
            let ids = statement
                .query_map([now.to_rfc3339()], |row| row.get(0))?
                .collect::<Result<_, _>>()?;
            ids
        };
        let remaining = due.len().saturating_sub(RUN_LIMIT);
        let due = &due[..due.len().min(RUN_LIMIT)];
        let mut result = WatchRunResult {
            checked: 0,
            changed: 0,
            remaining,
            stop_reason: None,
        };

        let games: Vec<i64> = due
            .iter()
            .filter_map(|id| split_id(id).ok())
            .filter(|(kind, _, _)| *kind == ReleaseKind::Game)
            .map(|(_, number, _)| number)
            .collect();
        for batch in games.chunks(IGDB_BATCH) {
            match fetch_games(transport, batch) {
                Ok(titles) => {
                    for number in batch {
                        let id = format!("igdb:{number}");
                        let title = titles.iter().find(|title| title.id == id);
                        result.changed +=
                            usize::from(self.apply_release_check(&id, title, now, today)?);
                        result.checked += 1;
                    }
                }
                Err(error) => {
                    result
                        .stop_reason
                        .get_or_insert_with(|| error_code(&error).to_owned());
                    break;
                }
            }
        }
        for id in due {
            let fetched = match split_id(id)? {
                (ReleaseKind::Movie, number, _) => fetch_movie(transport, number),
                (ReleaseKind::Anime, number, Some(season)) => fetch_anime(transport, number, season),
                _ => continue,
            };
            match fetched {
                Ok(title) => {
                    result.changed +=
                        usize::from(self.apply_release_check(id, Some(&title), now, today)?);
                    result.checked += 1;
                }
                // A removed movie or season keeps its last known dates and is checked again tomorrow.
                Err(LibraryError::TmdbNotFound) => {
                    self.apply_release_check(id, None, now, today)?;
                    result.checked += 1;
                }
                Err(error) => {
                    result
                        .stop_reason
                        .get_or_insert_with(|| error_code(&error).to_owned());
                    break;
                }
            }
        }
        Ok(result)
    }

    /// Store one check's result and its events. `None` (the provider no longer has the title)
    /// keeps the known dates. Returns whether any event was recorded.
    fn apply_release_check(
        &self,
        id: &str,
        fetched: Option<&ReleaseTitle>,
        now: DateTime<Utc>,
        today: NaiveDate,
    ) -> Result<bool, LibraryError> {
        if self.server_release_wishlist_blocked()? { return Ok(false); }
        let checked_at = now.to_rfc3339();
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        let stored: Option<(Option<String>, Option<String>)> = transaction
            .query_row(
                "SELECT released_at, tracked_platforms_json FROM release_watch_items WHERE id = ?1",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        // Removed from the wishlist while the request was in flight.
        let Some((released_at, tracked_platforms_json)) = stored else {
            return Ok(false);
        };
        let tracked_platforms = tracked_platforms_json
            .as_deref()
            .and_then(|value| serde_json::from_str::<Vec<String>>(value).ok());
        let previous = headline(&read_dates(&transaction, id)?);
        let scoped = fetched.and_then(|title| match &tracked_platforms {
            Some(platforms) => restrict_to_tracked_platforms(title, platforms),
            None => Some(title.clone()),
        });
        let current = match scoped {
            Some(title) => {
                write_title(&transaction, &title, &checked_at)?;
                (title.date.clone(), title.precision)
            }
            None => (previous.0.clone(), previous.1),
        };
        let events = detect_changes(
            (previous.0.as_deref(), previous.1),
            (current.0.as_deref(), current.1),
            released_at.is_some(),
            today,
        );
        for (kind, previous_value, current_value) in &events {
            transaction.execute(
                "INSERT INTO release_watch_item_events(id, item_id, event_kind, previous_value, current_value, detected_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![uuid::Uuid::new_v4().to_string(), id, kind, previous_value, current_value, checked_at],
            )?;
        }
        let now_released =
            released_at.is_some() || released_on(current.0.as_deref(), current.1, today);
        transaction.execute(
            "UPDATE release_watch_items SET last_checked_at = ?2, next_check_at = ?3,
               released_at = CASE WHEN ?4 THEN COALESCE(released_at, ?2) ELSE NULL END
             WHERE id = ?1",
            params![
                id,
                checked_at,
                next_check(now, today, current.0.as_deref(), current.1)
                    .map(|time| time.to_rfc3339()),
                now_released,
            ],
        )?;
        transaction.commit()?;
        self.publication_inputs.signal(&[8]);
        Ok(!events.is_empty())
    }
}

#[cfg(test)]
#[path = "release_wishlist_tests.rs"]
mod tests;
