//! Read-only owner-loop probes. Durable domain schedules remain the authority.
use crate::cloud::status_watch::{log_pending, LogKind, LogPosition};
use crate::library::{error::LibraryError, Library};
use rusqlite::{Connection, OptionalExtension};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Mutex,
};
use std::time::{Duration, Instant};

const DISPATCH_SAFETY_INTERVAL: Duration = Duration::from_secs(10 * 60);

#[derive(Debug, Default)]
struct DispatchHistory {
    endpoint: Option<String>,
    last_dispatched: [Option<Instant>; 12],
}

#[derive(Debug, Default)]
pub(crate) struct Inputs {
    dispatch_history: Mutex<DispatchHistory>,
    generations: [AtomicU64; 12],
    checked: [Mutex<Option<u64>>; 12],
    cached: [Mutex<Option<(u64, String, String)>>; 12],
    character_sources: Mutex<
        Option<(
            Vec<Option<(std::time::SystemTime, u64)>>,
            Option<std::collections::BTreeSet<String>>,
        )>,
    >,
}
impl Inputs {
    pub(crate) fn lanes_to_dispatch(
        &self,
        endpoint: &str,
        mut due: [bool; 12],
        now: Instant,
    ) -> [bool; 12] {
        let mut history = self
            .dispatch_history
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if history.endpoint.as_deref() != Some(endpoint) {
            history.endpoint = Some(endpoint.to_owned());
            history.last_dispatched = [None; 12];
        }
        for (lane, last) in history.last_dispatched.iter().enumerate() {
            // Predicates are hints. Each lane still checks its own durable due rules.
            due[lane] |= last.is_none_or(|at| now.duration_since(at) >= DISPATCH_SAFETY_INTERVAL);
        }
        due
    }

    pub(crate) fn dispatched(&self, endpoint: &str, lane: usize, now: Instant) {
        let mut history = self
            .dispatch_history
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if history.endpoint.as_deref() == Some(endpoint) {
            history.last_dispatched[lane] = Some(now);
        }
    }

    pub(crate) fn generation(&self, lane: usize) -> u64 {
        self.generations[lane].load(Ordering::Acquire)
    }
    pub(crate) fn checked(&self, lane: usize, generation: u64) {
        *self.checked[lane]
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(generation);
    }
    fn dirty(&self, lane: usize) -> bool {
        *self.checked[lane]
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            != Some(self.generation(lane))
    }
    pub(crate) fn changed_table(&self, table: &str) {
        // Scheduling tables are deliberately absent: a poll/build must not dirty its own input.
        let lanes: &[usize] = match table {
            "character_decisions"
            | "character_autotag_predictions"
            | "character_targets"
            | "character_autotag_control"
            | "mobile_character_review_sync" => &[1],
            "online_catalog_hidden_categories" | "online_catalog_blocked_tags" => &[2],
            "similarity_reviews" | "asset_authority_state" | "mobile_similarity_review_sync" => {
                &[3]
            }
            "release_watch_events" | "collections" => &[5],
            _ => &[],
        };
        for &lane in lanes {
            self.generations[lane].fetch_add(1, Ordering::Release);
        }
    }
    pub(crate) fn character_sources(&self, library: &Library) {
        // S36 writes a separate SQLite cache. Include its WAL; no cache connection or scan.
        let stamps = ["s36_shadow.sqlite", "s36_shadow.sqlite-wal"]
            .into_iter()
            .map(|name| {
                std::fs::metadata(library.root().join(".cache/characters").join(name))
                    .ok()
                    .and_then(|m| m.modified().ok().map(|at| (at, m.len())))
            })
            .collect();
        let source = (stamps, library.character_s36_series());
        let mut previous = self
            .character_sources
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if previous.as_ref() != Some(&source) {
            *previous = Some(source);
            self.generations[1].fetch_add(1, Ordering::Release);
        }
    }
    pub(crate) fn cached_input(
        &self,
        lane: usize,
        key: String,
        build: impl FnOnce() -> Result<String, LibraryError>,
    ) -> Result<String, LibraryError> {
        let generation = self.generation(lane);
        let mut cached = self.cached[lane]
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some((seen, previous_key, value)) = cached.as_ref() {
            if *seen == generation && previous_key == &key {
                return Ok(value.clone());
            }
        }
        let value = build()?;
        *cached = Some((generation, key, value.clone()));
        Ok(value)
    }
}

fn poll_pending(
    db: &Connection,
    endpoint: &str,
    kind: LogKind,
    sync: &str,
    poll: &str,
    now: i64,
) -> Result<bool, LibraryError> {
    // Identifiers are private constants at the call sites, never user input.
    let cursor: Option<i64> = db
        .query_row(
            &format!("SELECT received_cursor FROM {sync} WHERE endpoint=?1"),
            [endpoint],
            |r| r.get(0),
        )
        .optional()?;
    let last: Option<i64> = db
        .query_row(
            &format!("SELECT last_checked FROM {poll} WHERE endpoint=?1"),
            [endpoint],
            |r| r.get(0),
        )
        .optional()?;
    Ok(log_pending(
        endpoint,
        kind,
        LogPosition::cursor(cursor),
        last,
        now,
    ))
}

fn feed_due(db: &Connection, endpoint: &str, table: &str, now: i64) -> Result<bool, LibraryError> {
    Ok(db.query_row(&format!("SELECT retry_after<=?2 AND (published_input_digest IS NULL
        OR (input_digest IS NOT published_input_digest AND (last_dirty<=?2-30 OR first_dirty<=?2-300))
        OR built_at<=?2-300) FROM {table} WHERE endpoint=?1"),
        rusqlite::params![endpoint, now], |r| r.get(0)).optional()?.unwrap_or(true))
}

impl Library {
    pub(crate) fn publication_lanes_due(
        &self,
        endpoint: &str,
        now: i64,
        light: bool,
        restricted: bool,
    ) -> Result<[bool; 12], LibraryError> {
        self.publication_inputs.character_sources(self);
        let db = self.connection()?;
        let mut due = [false; 12];
        for (slot, kind, quiet, cap) in [(0, "collections", 5, 60), (1, "characters", 30, 300)] {
            due[slot] = db
                .query_row(
                    "SELECT generation<>published_generation AND retry_after<=?3
                AND (last_dirty<=?3-?4 OR first_dirty<=?3-?5)
                FROM mobile_publication_state WHERE kind=?1 AND endpoint=?2",
                    rusqlite::params![kind, endpoint, now, quiet, cap],
                    |r| r.get(0),
                )
                .optional()?
                .unwrap_or(true);
        }
        due[0] |= poll_pending(
            &db,
            endpoint,
            LogKind::PersonalEdits,
            "mobile_collection_personal_edit_sync",
            "mobile_collection_personal_edit_poll",
            now,
        )?;
        due[1] |= poll_pending(
            &db,
            endpoint,
            LogKind::CharacterExclusions,
            "mobile_character_exclusion_sync",
            "mobile_character_exclusion_poll",
            now,
        )?;
        let characters_adopted: bool = db.query_row(
            "SELECT EXISTS(SELECT 1 FROM mobile_character_exclusion_sync WHERE endpoint=?1)",
            [endpoint],
            |r| r.get(0),
        )?;
        if characters_adopted {
            due[1] |= poll_pending(
                &db,
                endpoint,
                LogKind::CharacterReviewDecisions,
                "mobile_character_review_sync",
                "mobile_character_review_poll",
                now,
            )?;
            let review_adopted: bool = db.query_row(
                "SELECT EXISTS(SELECT 1 FROM mobile_character_review_sync WHERE endpoint=?1)",
                [endpoint],
                |r| r.get(0),
            )?;
            if review_adopted {
                due[1] |= self.publication_inputs.dirty(1)
                    || feed_due(&db, endpoint, "mobile_character_review_feed_state", now)?;
            }
        }
        due[2] = self.publication_inputs.dirty(2) || db.query_row(
            "SELECT digest<>published_digest AND retry_after<=?2 AND (last_dirty<=?2-30 OR first_dirty<=?2-300)
             FROM mobile_catalog_visibility_state WHERE endpoint=?1", rusqlite::params![endpoint, now], |r| r.get(0)).optional()?.unwrap_or(true);
        due[3] = poll_pending(
            &db,
            endpoint,
            LogKind::SimilarityDecisions,
            "mobile_similarity_review_sync",
            "mobile_similarity_review_poll",
            now,
        )?;
        let similarity_adopted: bool = db.query_row(
            "SELECT EXISTS(SELECT 1 FROM mobile_similarity_review_sync WHERE endpoint=?1)",
            [endpoint],
            |r| r.get(0),
        )?;
        if similarity_adopted {
            due[3] |= self.publication_inputs.dirty(3)
                || feed_due(&db, endpoint, "mobile_similarity_review_feed_state", now)?;
        }
        if !restricted {
            due[3] |= db.query_row(
                "SELECT EXISTS(SELECT 1 FROM similarity_auto_compare_queue)",
                [],
                |r| r.get::<_, bool>(0),
            )?;
        }
        if !restricted && self.root().join("catalogs/kdata.db").is_file() {
            due[4] = db
                .query_row(
                    "SELECT last_polled<=?2-60 FROM catalog_duplicate_sync WHERE endpoint=?1",
                    rusqlite::params![endpoint, now],
                    |r| r.get(0),
                )
                .optional()?
                .unwrap_or(true);
        }
        due[5] = crate::library::collection_release_sync::publication_due_on(
            &db,
            endpoint,
            now,
            self.publication_inputs.dirty(5),
        )
        .unwrap_or(true);
        due[6] = crate::library::collection_binding_sync::publication_due_on(&db, endpoint, now)
            .unwrap_or(true);
        due[7] = db.query_row(
            "SELECT EXISTS(SELECT 1 FROM cloud_metadata_publication_state
            WHERE (generation<>published_generation OR endpoint<>?1) AND retry_after<=?2)",
            rusqlite::params![endpoint, now],
            |r| r.get(0),
        )?;
        for (slot, kind) in [(8, "upcoming"), (9, "avPick"), (10, "artists")] {
            // A damaged checkpoint belongs to this lane, never to all twelve workers.
            due[slot] = Self::home_publication_due_on(&db, endpoint, kind, now).unwrap_or(true);
        }
        due[11] = !light && Self::auto_tag_publication_due_on(&db, endpoint, now).unwrap_or(true);
        Ok(due)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cloud::status_watch;
    use serde_json::json;

    struct Idle {
        _temp: tempfile::TempDir,
        library: Library,
        endpoint: String,
        now: i64,
    }
    fn idle() -> Idle {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let endpoint = format!(
            "https://{}.invalid/",
            temp.path()
                .file_name()
                .unwrap()
                .to_string_lossy()
                .replace('.', "")
        )
        .to_ascii_lowercase();
        let now = chrono::Utc::now().timestamp();
        library.publication_inputs.character_sources(&library);
        let library_id = library.library_id().unwrap();
        let db = library.connection().unwrap();
        db.execute(
            "UPDATE library_settings SET cloud_sync_enabled=1,cloud_api_base_url=?1",
            [&endpoint],
        )
        .unwrap();
        db.execute(
            "UPDATE mobile_publication_state SET endpoint=?1,published_generation=generation",
            [&endpoint],
        )
        .unwrap();
        db.execute("UPDATE cloud_metadata_publication_state SET endpoint=?1,published_generation=generation", [&endpoint]).unwrap();
        for table in [
            "mobile_collection_personal_edit_poll",
            "mobile_character_exclusion_poll",
            "mobile_character_review_poll",
            "mobile_similarity_review_poll",
        ] {
            db.execute(
                &format!("INSERT INTO {table}(endpoint,last_checked) VALUES(?1,?2)"),
                rusqlite::params![endpoint, now],
            )
            .unwrap();
        }
        for table in [
            "mobile_character_exclusion_sync",
            "mobile_character_review_sync",
            "mobile_similarity_review_sync",
        ] {
            db.execute(
                &format!(
                    "INSERT INTO {table}(endpoint,library_id,updated_at) VALUES(?1,?2,'fixture')"
                ),
                rusqlite::params![endpoint, library_id],
            )
            .unwrap();
        }
        for table in [
            "mobile_character_review_feed_state",
            "mobile_similarity_review_feed_state",
        ] {
            db.execute(&format!("INSERT INTO {table}(endpoint,library_id,input_digest,published_input_digest,built_at) VALUES(?1,?2,'same','same',?3)"),
                rusqlite::params![endpoint, library_id, now]).unwrap();
        }
        db.execute("INSERT INTO mobile_catalog_visibility_state(endpoint,digest,published_digest,first_dirty,last_dirty) VALUES(?1,'same','same',0,0)", [&endpoint]).unwrap();
        for (key, value) in [
            (
                format!("collectionReleaseSync:{endpoint}"),
                json!({"lastPolled":now,"uploaded":"same","uploadedAt":now}),
            ),
            (
                format!("collectionBindingSync:{endpoint}"),
                json!({"lastPolled":now}),
            ),
        ] {
            db.execute(
                "INSERT INTO notes_state(key,value) VALUES(?1,?2)",
                rusqlite::params![key, value.to_string()],
            )
            .unwrap();
        }
        for kind in ["upcoming", "avPick", "artists"] {
            db.execute(
                "INSERT INTO home_publication_state(endpoint,kind,state_json) VALUES(?1,?2,?3)",
                rusqlite::params![
                    endpoint,
                    kind,
                    json!({"next_build":now+300,"last_poll":now}).to_string()
                ],
            )
            .unwrap();
        }
        db.execute(
            "INSERT INTO auto_tag_publication_state(endpoint,state_json) VALUES(?1,?2)",
            rusqlite::params![endpoint, json!({"retry_after":now+300}).to_string()],
        )
        .unwrap();
        drop(db);
        for lane in 0..12 {
            library
                .publication_inputs
                .checked(lane, library.publication_inputs.generation(lane));
        }
        // The idle fixture represents lanes that have already received their startup check.
        let started = Instant::now();
        library
            .publication_inputs
            .lanes_to_dispatch(&endpoint, [false; 12], started);
        for lane in 0..12 {
            library
                .publication_inputs
                .dispatched(&endpoint, lane, started);
        }
        Idle {
            _temp: temp,
            library,
            endpoint,
            now,
        }
    }

    #[test]
    fn false_predicates_dispatch_every_lane_at_startup_and_after_endpoint_changes() {
        let inputs = Inputs::default();
        let now = Instant::now();
        let first = "https://first.invalid/";
        let second = "https://second.invalid/";
        assert_eq!(
            inputs.lanes_to_dispatch(first, [false; 12], now),
            [true; 12]
        );
        // A busy or failed submission has not dispatched; its startup check stays pending.
        inputs.dispatched(first, 0, now);
        let due = inputs.lanes_to_dispatch(first, [false; 12], now);
        assert!(!due[0]);
        assert!(due[1..].iter().all(|due| *due));
        for lane in 1..12 {
            inputs.dispatched(first, lane, now);
        }
        assert_eq!(
            inputs.lanes_to_dispatch(first, [false; 12], now),
            [false; 12]
        );
        assert_eq!(
            inputs.lanes_to_dispatch(second, [false; 12], now),
            [true; 12]
        );
        for lane in 0..12 {
            inputs.dispatched(second, lane, now);
        }
        assert_eq!(
            inputs.lanes_to_dispatch(second, [false; 12], now),
            [false; 12]
        );
        assert_eq!(
            inputs.lanes_to_dispatch(first, [false; 12], now),
            [true; 12]
        );
    }

    #[test]
    fn false_predicates_dispatch_after_ten_minutes_but_not_before() {
        let inputs = Inputs::default();
        let endpoint = "https://watchdog.invalid/";
        let now = Instant::now();
        inputs.lanes_to_dispatch(endpoint, [false; 12], now);
        for lane in 0..12 {
            inputs.dispatched(endpoint, lane, now);
        }
        let deadline = now + DISPATCH_SAFETY_INTERVAL;
        assert_eq!(
            inputs.lanes_to_dispatch(endpoint, [false; 12], deadline - Duration::from_nanos(1)),
            [false; 12]
        );
        assert_eq!(
            inputs.lanes_to_dispatch(endpoint, [false; 12], deadline),
            [true; 12]
        );
        inputs.dispatched(endpoint, 2, deadline);
        let due = inputs.lanes_to_dispatch(endpoint, [false; 12], deadline);
        assert!(!due[2]);
        assert!(due.iter().enumerate().all(|(lane, due)| lane == 2 || *due));
        assert!(inputs.lanes_to_dispatch(endpoint, [true; 12], deadline)[2]);
    }

    #[test]
    fn catalog_settings_writes_invalidate_the_visibility_lane() {
        let f = idle();
        let due = || {
            f.library
                .publication_lanes_due(&f.endpoint, f.now, false, false)
                .unwrap()[2]
        };
        let checked = || {
            f.library
                .publication_inputs
                .checked(2, f.library.publication_inputs.generation(2))
        };
        assert!(!due());
        f.library.set_catalog_category_hidden(2, true).unwrap();
        assert!(due());
        checked();
        f.library.set_catalog_category_hidden(2, true).unwrap();
        assert!(!due()); // A no-op does not invalidate the inputs.
        f.library.set_catalog_category_hidden(2, false).unwrap();
        assert!(due());
        checked();
        let tag = || crate::library::models::CatalogBlockedTag {
            namespace: "tag".into(),
            value: "blocked".into(),
        };
        f.library.set_catalog_tag_blocked(tag(), true).unwrap();
        assert!(due());
        checked();
        f.library.set_catalog_tag_blocked(tag(), true).unwrap();
        assert!(!due());
        f.library.set_catalog_tag_blocked(tag(), false).unwrap();
        assert!(due());
    }

    #[test]
    fn idle_ticks_dispatch_zero_lanes_and_build_zero_snapshots() {
        let f = idle();
        let mut dispatches = 0;
        let mut builds = 0;
        for offset in [0, 10, 20, 30, 40, 50] {
            let due = f
                .library
                .publication_lanes_due(&f.endpoint, f.now + offset, false, false)
                .unwrap();
            for _ in due.into_iter().filter(|due| *due) {
                dispatches += 1;
                builds += 1; // The fake worker builds a snapshot whenever dispatched.
            }
        }
        assert_eq!((dispatches, builds), (0, 0));
        // Exercise the real dispatcher too: no credential/network preparation is reachable.
        assert_eq!(f.library.run_saved_mobile_publications().unwrap(), 0);
    }

    #[test]
    fn dirty_due_retry_mode_and_endpoint_schedules_are_preserved() {
        let f = idle();
        let due = |at, light| {
            f.library
                .publication_lanes_due(&f.endpoint, at, light, light)
                .unwrap()
        };
        assert!(!due(f.now, false)[0]);
        f.library.connection().unwrap().execute("UPDATE mobile_publication_state SET generation=generation+1,first_dirty=?1,last_dirty=?1 WHERE kind='collections'", [f.now]).unwrap();
        assert!(!due(f.now + 4, false)[0]);
        assert!(due(f.now + 5, false)[0]);
        f.library
            .connection()
            .unwrap()
            .execute(
                "UPDATE mobile_publication_state SET retry_after=?1 WHERE kind='collections'",
                [f.now + 100],
            )
            .unwrap();
        f.library
            .connection()
            .unwrap()
            .execute(
                "UPDATE mobile_collection_personal_edit_poll SET last_checked=?1",
                [f.now + 100],
            )
            .unwrap();
        assert!(!due(f.now + 99, false)[0]);
        assert!(due(f.now + 100, false)[0]);
        f.library
            .set_catalog_tag_blocked(
                crate::library::models::CatalogBlockedTag {
                    namespace: "tag".into(),
                    value: "blocked".into(),
                },
                true,
            )
            .unwrap();
        assert!(due(f.now, false)[2]);
        assert!(due(f.now + 300, false)[8]);
        assert!(due(f.now + 300, false)[11]);
        assert!(!due(f.now + 300, true)[11]);
        f.library
            .connection()
            .unwrap()
            .execute(
                "UPDATE home_publication_state SET state_json=?1 WHERE kind='artists'",
                [json!({"next_build":0,"retry_after":f.now+600}).to_string()],
            )
            .unwrap();
        assert!(!due(f.now + 599, false)[10]);
        assert!(due(f.now + 600, false)[10]);
        let other = "https://changed.invalid/";
        assert!(
            f.library
                .publication_lanes_due(other, f.now, false, false)
                .unwrap()[8]
        );
    }

    #[test]
    fn publication_wake_observes_a_moved_log_without_consuming_its_claim() {
        let f = idle();
        // No adoption is required for the bindings channel; its cursor is in notes_state.
        let status = status_watch::tests::status_with(Some(status_watch::tests::logs(1, 0)));
        status_watch::observe(&f.endpoint, &status, f.now, status_watch::Source::Watcher);
        let due = f
            .library
            .publication_lanes_due(&f.endpoint, f.now, false, false)
            .unwrap();
        assert!(due[6]);
        for _ in 0..2 {
            assert!(status_watch::log_pending(
                &f.endpoint,
                LogKind::Bindings,
                LogPosition::cursor(Some(0)),
                Some(f.now),
                f.now
            ));
        }
        assert!(status_watch::log_due(
            &f.endpoint,
            LogKind::Bindings,
            LogPosition::cursor(Some(0)),
            Some(f.now),
            f.now
        ));
        assert!(!status_watch::log_pending(
            &f.endpoint,
            LogKind::Bindings,
            LogPosition::cursor(Some(0)),
            Some(f.now),
            f.now
        ));
    }

    #[test]
    fn input_digest_cache_builds_once_then_invalidates_on_writes_and_cursor_changes() {
        let f = idle();
        let mut builds = 0;
        for _ in 0..6 {
            f.library
                .publication_inputs
                .cached_input(3, "cursor0".into(), || {
                    builds += 1;
                    Ok("digest".into())
                })
                .unwrap();
        }
        assert_eq!(builds, 1);
        f.library
            .publication_inputs
            .changed_table("asset_authority_state");
        f.library
            .publication_inputs
            .cached_input(3, "cursor0".into(), || {
                builds += 1;
                Ok("new".into())
            })
            .unwrap();
        f.library
            .publication_inputs
            .cached_input(3, "cursor1".into(), || {
                builds += 1;
                Ok("cursor".into())
            })
            .unwrap();
        assert_eq!(builds, 3);
        let generation = f.library.publication_inputs.generation(3);
        f.library
            .publication_inputs
            .changed_table("mobile_similarity_review_poll");
        f.library
            .publication_inputs
            .changed_table("mobile_similarity_review_feed_state");
        assert_eq!(generation, f.library.publication_inputs.generation(3));
    }

    #[test]
    fn a_change_during_a_build_is_not_consumed_and_restart_keeps_durable_deadlines() {
        let f = idle();
        let captured = f.library.publication_inputs.generation(3);
        f.library
            .publication_inputs
            .cached_input(3, "cursor".into(), || {
                f.library
                    .publication_inputs
                    .changed_table("similarity_reviews");
                Ok("first".into())
            })
            .unwrap();
        f.library.publication_inputs.checked(3, captured);
        assert!(f.library.publication_inputs.dirty(3));
        let mut builds = 0;
        f.library
            .publication_inputs
            .cached_input(3, "cursor".into(), || {
                builds += 1;
                Ok("second".into())
            })
            .unwrap();
        assert_eq!(builds, 1);
        let root = f.library.root().to_owned();
        let endpoint = f.endpoint.clone();
        let now = f.now;
        drop(f.library);
        let reopened = Library::open(&root).unwrap();
        let due = reopened
            .publication_lanes_due(&endpoint, now, false, false)
            .unwrap();
        assert!(!due[8]); // next_build survives the process-local input cache.
        assert!(!due[11]); // auto-tag retry_after also survives.
        assert!(due[2]); // Cold inputs are checked once rather than trusted across restart.
        assert!(due[5]);
    }

    #[test]
    fn a_bad_home_checkpoint_does_not_starve_other_lanes() {
        let f = idle();
        f.library
            .connection()
            .unwrap()
            .execute(
                "UPDATE home_publication_state SET state_json='broken' WHERE kind='artists'",
                [],
            )
            .unwrap();
        let due = f
            .library
            .publication_lanes_due(&f.endpoint, f.now, false, false)
            .unwrap();
        assert!(due[10]); // Its worker reports/retries the invalid checkpoint.
        assert!(!due[8]);
        assert!(!due[9]);
    }
}
