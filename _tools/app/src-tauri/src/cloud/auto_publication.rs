//! Quiet, restart-safe one-way publication. No provider refresh or library backfill.
use crate::library::{error::LibraryError, Library};
use rusqlite::params;
use std::sync::Mutex;
mod schedule;
pub(crate) use schedule::Inputs;
// Separate lanes prevent slow artwork uploads from blocking character/settings changes.
static RUNNING: [Worker; 12] = [const { Worker::new() }; 12];

/// Lazily started, isolated single-flight workers sleep on their channels between jobs.
pub(crate) struct Worker {
    sender: Mutex<Option<std::sync::mpsc::Sender<Box<dyn FnOnce() + Send>>>>,
    busy: std::sync::atomic::AtomicBool,
}
impl Worker {
    pub(crate) const fn new() -> Self {
        Self {
            sender: Mutex::new(None),
            busy: std::sync::atomic::AtomicBool::new(false),
        }
    }
    pub(crate) fn submit(
        &'static self,
        name: &str,
        work: impl FnOnce() + Send + 'static,
    ) -> std::io::Result<bool> {
        use std::sync::atomic::Ordering;
        if self.busy.swap(true, Ordering::AcqRel) {
            return Ok(false);
        }
        let result = (|| {
            let mut sender = self
                .sender
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if sender.is_none() {
                let (tx, rx) = std::sync::mpsc::channel::<Box<dyn FnOnce() + Send>>();
                let busy = &self.busy;
                std::thread::Builder::new()
                    .name(name.into())
                    .spawn(move || {
                        for job in rx {
                            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(job));
                            busy.store(false, Ordering::Release);
                        }
                    })?;
                *sender = Some(tx);
            }
            if sender.as_ref().unwrap().send(Box::new(work)).is_err() {
                *sender = None;
                return Err(std::io::Error::other("publication worker stopped"));
            }
            Ok(true)
        })();
        if result.is_err() {
            self.busy.store(false, Ordering::Release);
        }
        result
    }
}

/// Run both steps, then report the first error.
fn both(
    first: impl FnOnce() -> Result<(), LibraryError>,
    second: impl FnOnce() -> Result<(), LibraryError>,
) -> Result<(), LibraryError> {
    let first = first();
    let second = second();
    first.and(second)
}

/// Tracks only generations produced by receiving mobile personal edits. A local
/// write changes the generation and immediately invalidates this deferral.
#[derive(Debug, Default)]
pub(crate) struct Deferral {
    generation: Option<i64>,
    since: Option<std::time::Instant>,
}
impl Deferral {
    pub(crate) fn mobile_edit(
        &mut self,
        before: i64,
        after: i64,
        published: i64,
        now: std::time::Instant,
        light: bool,
    ) {
        if light && (before == published || self.generation == Some(before)) {
            self.generation = Some(after);
            self.since.get_or_insert(now);
        } else {
            *self = Self::default();
        }
    }
    fn deferred(&mut self, generation: i64, now: std::time::Instant, light: bool) -> bool {
        if light
            && self.generation == Some(generation)
            && self.since.is_some_and(|since| {
                now.duration_since(since) < std::time::Duration::from_secs(1800)
            })
        {
            true
        } else {
            *self = Self::default();
            false
        }
    }
}

impl Library {
    pub(crate) fn save_mobile_navigation_order(
        &self,
        order_ids: Vec<String>,
    ) -> Result<(), LibraryError> {
        if order_ids.len() > 20_000 || order_ids.iter().any(|s| s.len() > 180) {
            return Err(LibraryError::InvalidCloudResponse);
        }
        let order =
            serde_json::to_string(&order_ids).map_err(|_| LibraryError::InvalidCloudResponse)?;
        self.connection()?.execute("UPDATE mobile_publication_state SET navigation_order=?1,generation=generation+1,first_dirty=CASE WHEN generation=published_generation THEN unixepoch() ELSE first_dirty END,last_dirty=unixepoch() WHERE kind='characters' AND navigation_order<>?1", [&order])?;
        Ok(())
    }
    /// Returns the number of jobs actually submitted (zero for a quiet tick).
    pub(crate) fn run_saved_mobile_publications(&self) -> Result<usize, LibraryError> {
        self.run_saved_mobile_publications_with(
            |slot, work| RUNNING[slot].submit("mobile-publication", work),
            Self::run_mobile_publication_lane,
        )
    }

    fn run_saved_mobile_publications_with(
        &self,
        mut submit: impl FnMut(usize, Box<dyn FnOnce() + Send>) -> std::io::Result<bool>,
        run: fn(&Library, &str, &str) -> Result<(), LibraryError>,
    ) -> Result<usize, LibraryError> {
        let config = self.cloud_sync_config()?;
        let endpoint = config.api_base_url.unwrap_or_default();
        if !config.enabled || endpoint.is_empty() {
            return Ok(0);
        }
        {
            let c = self.connection()?;
            Self::update_publication_endpoint_on(&c, &endpoint)?;
        }
        let due = self.publication_lanes_due(
            &endpoint,
            chrono::Utc::now().timestamp(),
            crate::workload::is_lightweight(),
            crate::workload::is_restricted(),
        )?;
        let due =
            self.publication_inputs
                .lanes_to_dispatch(&endpoint, due, std::time::Instant::now());
        let mut dispatched = 0;
        for (slot, kind) in [
            "collections",
            "characters",
            "visibility",
            "similarity",
            "catalogDuplicates",
            "releases",
            "bindings",
            "metadata",
            "upcoming",
            "avPick",
            "artists",
            "autoTags",
        ]
        .into_iter()
        .enumerate()
        {
            if !due[slot]
                || (self.sync_held(&endpoint)
                    && matches!(
                        kind,
                        "visibility" | "bindings" | "metadata" | "avPick" | "autoTags"
                    ))
            {
                continue;
            }
            let library = self.clone();
            let worker_endpoint = endpoint.clone();
            let generation = library.publication_inputs.generation(slot);
            // Return after dispatch so the native owner's next tick can service every free lane.
            let started = submit(
                slot,
                Box::new(move || {
                    let endpoint = worker_endpoint;
                    let result = run(&library, kind, &endpoint);
                    if result.is_ok()
                        && !library.sync_held(&endpoint)
                        && slot != 2
                        && (slot != 5
                            || library.collection_release_sync_state(&endpoint).is_ok_and(
                                |state| state.retry_after <= chrono::Utc::now().timestamp(),
                            ))
                    {
                        library.publication_inputs.checked(slot, generation);
                    }
                }),
            )
            .map_err(|_| LibraryError::InvalidCloudResponse)?;
            if !started {
                // A log wake racing an active lane is retried by the owner next second.
                super::status_watch::wake_publications();
            } else {
                self.publication_inputs
                    .dispatched(&endpoint, slot, std::time::Instant::now());
                dispatched += 1;
            }
        }
        Ok(dispatched)
    }

    fn run_mobile_publication_lane(&self, kind: &str, endpoint: &str) -> Result<(), LibraryError> {
        if matches!(kind, "bindings" | "releases")
            && crate::library::collection_authority::collection_authority_active(&*self.connection()?)? {
            return Ok(());
        }
        match kind {
            "upcoming" | "avPick" | "artists" => self
                .run_due_home_publication(kind, endpoint)
                .map_err(|error| {
                    eprintln!("home publication {kind}: {error}");
                    error
                }),
            "autoTags" => self
                .run_due_auto_tag_publication(endpoint)
                .map_err(|error| {
                    eprintln!("auto tag publication: {error}");
                    error
                }),
            "visibility" => self.publish_due_catalog_visibility(endpoint),
            "similarity" => self.run_due_similarity_review(endpoint).map_err(|error| {
                eprintln!("similarity review: {error}");
                error
            }),
            // Manga Catalog duplicate editions (`catalog_duplicate_sync.rs`).
            "catalogDuplicates" => self.run_due_catalog_duplicates(endpoint).map_err(|error| {
                eprintln!("catalog duplicates: {error}");
                error
            }),
            // Manga release notifications shared with mobile (`collection_release_sync.rs`).
            "releases" => self.run_due_collection_releases(endpoint).map_err(|error| {
                eprintln!("collection releases: {error}");
                error
            }),
            // Tablet-requested MangaDex / Kakao connections (`collection_binding_sync.rs`).
            "bindings" => self.run_due_collection_bindings(endpoint).map_err(|error| {
                eprintln!("collection bindings: {error}");
                error
            }),
            // Classification / saved-X / Album read snapshots (`captures.rs`), no longer
            // tied to the capture poll's cadence.
            "metadata" => self.publish_due_cloud_metadata(endpoint),
            _ => self.publish_due_mobile_kind(kind, endpoint),
        }
    }

    fn update_publication_endpoint_on(
        connection: &rusqlite::Connection,
        endpoint: &str,
    ) -> Result<(), LibraryError> {
        let changed: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM mobile_publication_state WHERE endpoint<>?1)",
            [endpoint],
            |r| r.get(0),
        )?;
        if changed {
            connection.execute("UPDATE mobile_publication_state SET endpoint=?1,generation=generation+1,first_dirty=0,last_dirty=0,retry_after=0 WHERE endpoint<>?1", [endpoint])?;
        }
        Ok(())
    }

    fn publish_due_mobile_kind(&self, kind: &str, endpoint: &str) -> Result<(), LibraryError> {
        self.publish_due_mobile_kind_with_receive(kind, endpoint, || {
            if kind == "characters" {
                // Receive even when no local changes have dirtied the publication. Order:
                // exclusions → mobile review decisions → snapshot → candidate feed. The two
                // receives are independent channels, so a failing exclusion pass must not starve
                // the review receive; the first error still ends this tick.
                both(
                    || self.run_due_character_exclusions(endpoint),
                    || self.run_due_character_review(endpoint),
                )?;
            } else if kind == "collections" {
                // Same for mobile personal edits (at most once a minute, durably throttled).
                // An applied edit dirties the lane through the 0074 triggers; the publication
                // itself receives again before it reads the snapshot.
                if !crate::library::collection_authority::collection_authority_active(&*self.connection()?)? {
                    self.run_due_collection_personal_edits(endpoint)?;
                }
            }
            Ok(())
        })
    }

    fn publish_due_mobile_kind_with_receive(
        &self,
        kind: &str,
        endpoint: &str,
        receive: impl FnOnce() -> Result<(), LibraryError>,
    ) -> Result<(), LibraryError> {
        let config = self.cloud_sync_config()?;
        if !config.enabled || config.api_base_url.as_deref() != Some(endpoint) {
            return Ok(());
        }
        receive()?;
        if self.sync_held(endpoint) { return Ok(()); }
        let generation: Option<i64> = {
            use rusqlite::OptionalExtension;
            // Collections are small to publish (the list query is ~6 ms) and a new or edited
            // collection should reach the tablet quickly, but creating one triggers a burst of
            // follow-up writes (cover, metadata) that kept resetting a 30 s quiet window until
            // the 5 min cap. Other lanes keep the longer debounce.
            let (quiet, cap) = if kind == "collections" {
                (5, 60)
            } else {
                (30, 300)
            };
            self.connection()?.query_row("SELECT generation FROM mobile_publication_state WHERE kind=?1 AND endpoint=?2 AND generation<>published_generation AND retry_after<=unixepoch() AND (last_dirty<=unixepoch()-?3 OR first_dirty<=unixepoch()-?4)",params![kind,endpoint,quiet,cap],|r|r.get(0)).optional()?
        };
        let Some(generation) = generation else {
            if kind == "characters" {
                // No snapshot is due, but the candidate feed has its own schedule (the S36
                // cache and saved B36 predictions change without dirtying this lane). A
                // publication that is due republishes the feed itself, right after it.
                if let Err(error) = self.publish_due_character_review_feed(endpoint) {
                    eprintln!("character review feed: {error}");
                }
            }
            return Ok(());
        };
        if kind == "collections"
            && self
                .collection_publication_defer
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .deferred(
                    generation,
                    std::time::Instant::now(),
                    crate::workload::is_lightweight(),
                )
        {
            return Ok(());
        }
        self.connection()?.execute(
            "UPDATE mobile_publication_state SET retry_after=unixepoch()+60 WHERE kind=?1",
            [kind],
        )?;
        let result = if kind == "collections" {
            self.push_cloud_collections(&|_| {}).map(|_| ())
        } else {
            self.push_cloud_characters(&|_| {}).map(|_| ())
        };
        if result.is_ok() {
            self.connection()?.execute("UPDATE mobile_publication_state SET published_generation=?2,retry_after=0,first_dirty=CASE WHEN generation=?2 THEN 0 ELSE unixepoch() END WHERE kind=?1 AND endpoint=?3",params![kind,generation,endpoint])?;
        }
        result
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn auto_publication_active_collection_replays_are_quiet_before_credentials_or_network() {
        let temp=tempfile::tempdir().unwrap();
        let library=crate::library::Library::open(temp.path()).unwrap();
        let id=library.library_id().unwrap();
        library.connection().unwrap().execute("INSERT INTO collection_authority_sync(singleton,library_id,epoch,contract_version,generation,updated_at) VALUES(1,?1,1,1,'fixture','t')",[id]).unwrap();
        library.run_mobile_publication_lane("bindings","https://fixture.invalid").unwrap();
        library.run_mobile_publication_lane("releases","https://fixture.invalid").unwrap();
    }
    use crate::library::Library;
    #[test]
    fn unchanged_publication_endpoint_tick_is_read_only() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let c = library.connection().unwrap();
        let endpoint = "https://fixture.invalid";
        Library::update_publication_endpoint_on(&c, endpoint).unwrap();
        let before = c.total_changes();
        assert!(before > 0);
        c.execute_batch("PRAGMA query_only=ON").unwrap();
        for _ in 0..12 {
            Library::update_publication_endpoint_on(&c, endpoint).unwrap();
        }
        assert_eq!(c.total_changes(), before);
        c.execute_batch("PRAGMA query_only=OFF").unwrap();
        assert!(!Library::catalog_visibility_tick_on(&c, endpoint, "unchanged").unwrap());
        c.execute(
            "UPDATE mobile_catalog_visibility_state SET published_digest=digest",
            [],
        )
        .unwrap();
        let before = c.total_changes();
        c.execute_batch("PRAGMA query_only=ON").unwrap();
        for _ in 0..12 {
            assert!(!Library::catalog_visibility_tick_on(&c, endpoint, "unchanged").unwrap());
        }
        assert_eq!(c.total_changes(), before);
    }

    #[test]
    fn blocked_collection_does_not_block_repeated_character_ticks_or_duplicate_work() {
        use std::sync::mpsc;
        use std::time::Duration;
        static COLLECTION: super::Worker = super::Worker::new();
        static CHARACTER: super::Worker = super::Worker::new();
        fn idle(worker: &super::Worker) {
            let start = std::time::Instant::now();
            while worker.busy.load(std::sync::atomic::Ordering::Acquire) {
                assert!(start.elapsed() < Duration::from_secs(2));
                std::thread::yield_now();
            }
        }
        let (started_tx, started_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        assert!(COLLECTION
            .submit("publication-test", move || {
                started_tx.send(std::thread::current().id()).unwrap();
                release_rx.recv().unwrap();
            })
            .unwrap());
        let first = started_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        assert!(!COLLECTION
            .submit("publication-test", || panic!(
                "duplicated in-flight collection"
            ))
            .unwrap());
        for _ in 0..2 {
            let (tx, rx) = mpsc::channel();
            assert!(CHARACTER
                .submit("publication-test", move || {
                    tx.send(()).unwrap();
                })
                .unwrap());
            rx.recv_timeout(Duration::from_secs(2))
                .expect("character tick waited for collection");
            idle(&CHARACTER);
        }
        release_tx.send(()).unwrap();
        idle(&COLLECTION);
        let (tx, rx) = mpsc::channel();
        assert!(COLLECTION
            .submit("publication-test", move || {
                tx.send(std::thread::current().id()).unwrap();
            })
            .unwrap());
        assert_eq!(rx.recv_timeout(Duration::from_secs(2)).unwrap(), first);
        idle(&COLLECTION);
    }
    #[test]
    fn character_review_runs_after_an_exclusion_failure_and_the_first_error_is_reported() {
        use crate::library::error::LibraryError;
        let mut review_ran = false;
        let result = super::both(
            || Err(LibraryError::CharacterExclusionUnsupported),
            || {
                review_ran = true;
                Err(LibraryError::CharacterReviewUnsupported)
            },
        );
        assert!(review_ran);
        assert!(matches!(
            result,
            Err(LibraryError::CharacterExclusionUnsupported)
        ));
        let result = super::both(|| Ok(()), || Err(LibraryError::CharacterReviewUnsupported));
        assert!(matches!(
            result,
            Err(LibraryError::CharacterReviewUnsupported)
        ));
        assert!(super::both(|| Ok(()), || Ok(())).is_ok());
    }
    #[test]
    fn catalog_visibility_is_debounced_and_remains_dirty_after_restart() {
        let dir = tempfile::tempdir().unwrap();
        let library = Library::open(dir.path()).unwrap();
        // The first tick only records the small settings snapshot, without network access.
        let endpoint = "https://example.invalid";
        library.publish_due_catalog_visibility(endpoint).unwrap();
        let db = library.connection().unwrap();
        let original: String = db
            .query_row(
                "SELECT digest FROM mobile_catalog_visibility_state",
                [],
                |r| r.get(0),
            )
            .unwrap();
        db.execute(
            "UPDATE mobile_catalog_visibility_state SET published_digest=digest",
            [],
        )
        .unwrap();
        drop(db);
        library
            .set_catalog_tag_blocked(
                crate::library::models::CatalogBlockedTag {
                    namespace: "tag".into(),
                    value: "blocked".into(),
                },
                true,
            )
            .unwrap();
        library.publish_due_catalog_visibility(endpoint).unwrap();
        let db = library.connection().unwrap();
        let changed: (String, String, i64) = db
            .query_row(
                "SELECT digest,published_digest,retry_after FROM mobile_catalog_visibility_state",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_ne!(changed.0, original);
        assert_eq!(changed.1, original);
        assert_eq!(changed.2, 0);
        drop(db);
        drop(library);
        let reopened = Library::open(dir.path()).unwrap();
        let dirty: bool = reopened
            .connection()
            .unwrap()
            .query_row(
                "SELECT digest<>published_digest FROM mobile_catalog_visibility_state",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(dirty);
    }
    #[test]
    fn publication_generation_survives_restart_and_late_changes() {
        let dir = tempfile::tempdir().unwrap();
        let library = Library::open(dir.path()).unwrap();
        let db = library.connection().unwrap();
        db.execute(
            "UPDATE mobile_publication_state SET published_generation=generation",
            [],
        )
        .unwrap();
        db.execute("INSERT INTO classification_entries(id,name,kind,created_at) VALUES('folder','Folder','tag','2026-09-13')",[]).unwrap();
        let captured: i64 = db
            .query_row(
                "SELECT generation FROM mobile_publication_state WHERE kind='characters'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        db.execute(
            "UPDATE classification_entries SET name='Changed' WHERE id='folder'",
            [],
        )
        .unwrap();
        db.execute(
            "UPDATE mobile_publication_state SET published_generation=?1 WHERE kind='characters'",
            [captured],
        )
        .unwrap();
        drop(db);
        drop(library);
        let reopened = Library::open(dir.path()).unwrap();
        let dirty:bool=reopened.connection().unwrap().query_row("SELECT generation>published_generation FROM mobile_publication_state WHERE kind='characters'",[],|r|r.get(0)).unwrap();
        assert!(dirty);
    }
}

impl Library {
    /// Run the character exclusion receive poll for this endpoint when its log head moved
    /// past the received cursor, at most every 30 minutes otherwise, and once a minute when
    /// the server reports no head (`cloud::status_watch::log_due`).
    ///
    /// Not gated on the publication being dirty: a correction the server accepted while this
    /// PC was idle is exactly the case where no local change would have made the lane dirty.
    ///
    /// A never-adopted endpoint is bootstrapped here rather than only during publication, so a
    /// server upgraded while this PC sat idle is discovered within the poll interval. The
    /// throttle is durable so a restart cannot stampede the log, and network work happens
    /// outside every database lock.
    pub(crate) fn run_due_character_exclusions(&self, endpoint: &str) -> Result<(), LibraryError> {
        use super::status_watch::{log_due, unix_now, LogKind, LogPosition};
        use rusqlite::OptionalExtension;
        let config = self.cloud_sync_config()?;
        if !config.enabled || config.api_base_url.as_deref() != Some(endpoint) {
            return Ok(());
        }
        let cursor = self
            .character_exclusion_adoption(endpoint)?
            .map(|(_, cursor)| cursor);
        let due = {
            let db = self.connection()?;
            let now = unix_now();
            let last: Option<i64> = db
                .query_row(
                    "SELECT last_checked FROM mobile_character_exclusion_poll WHERE endpoint=?1",
                    [endpoint],
                    |r| r.get(0),
                )
                .optional()?;
            let due = log_due(
                endpoint,
                LogKind::CharacterExclusions,
                LogPosition::cursor(cursor),
                last,
                now,
            );
            if due {
                db.execute("INSERT INTO mobile_character_exclusion_poll(endpoint,last_checked) VALUES(?1,?2) ON CONFLICT(endpoint) DO UPDATE SET last_checked=excluded.last_checked",rusqlite::params![endpoint, now])?;
            }
            due
        };
        if !due {
            return Ok(());
        }
        if self.character_exclusion_adoption(endpoint)?.is_none()
            && !self.bootstrap_character_exclusions(endpoint)?
        {
            return Ok(());
        }
        self.receive_character_exclusions(endpoint)?;
        Ok(())
    }

    fn catalog_visibility_tick_on(
        db: &rusqlite::Connection,
        endpoint: &str,
        digest: &str,
    ) -> Result<bool, LibraryError> {
        use rusqlite::OptionalExtension;
        let previous: Option<String> = db
            .query_row(
                "SELECT digest FROM mobile_catalog_visibility_state WHERE endpoint=?1",
                [endpoint],
                |r| r.get(0),
            )
            .optional()?;
        match previous {
            None => {
                db.execute("INSERT INTO mobile_catalog_visibility_state(endpoint,digest,first_dirty,last_dirty) VALUES(?1,?2,unixepoch(),unixepoch())",params![endpoint,digest])?;
            }
            Some(previous) if previous != digest => {
                db.execute("UPDATE mobile_catalog_visibility_state SET digest=?2,first_dirty=CASE WHEN digest=published_digest THEN unixepoch() ELSE first_dirty END,last_dirty=unixepoch() WHERE endpoint=?1 AND digest<>?2",params![endpoint,digest])?;
            }
            Some(_) => {}
        }
        let due:bool=db.query_row("SELECT digest<>published_digest AND retry_after<=unixepoch() AND (last_dirty<=unixepoch()-30 OR first_dirty<=unixepoch()-300) FROM mobile_catalog_visibility_state WHERE endpoint=?1",[endpoint],|r|r.get(0))?;
        if due {
            db.execute("UPDATE mobile_catalog_visibility_state SET retry_after=unixepoch()+60 WHERE endpoint=?1",[endpoint])?;
        }
        Ok(due)
    }

    fn publish_due_catalog_visibility(&self, endpoint: &str) -> Result<(), LibraryError> {
        self.ensure_send_to(endpoint)?;
        let generation = self.publication_inputs.generation(2);
        let (body, digest) = {
            let db = self.connection()?;
            let body = crate::library::mobile_catalog::visibility_snapshot(&db)?;
            let digest = crate::library::mobile_catalog::hash_json(&body)?;
            (body, digest)
        };
        let due = {
            let c = self.connection()?;
            Self::catalog_visibility_tick_on(&c, endpoint, &digest)?
        };
        // The digest is now durable even if the network attempt fails or is backed off.
        self.publication_inputs.checked(2, generation);
        if !due {
            return Ok(());
        }
        let client = self.cloud_client(endpoint)?;
        let token = crate::library::credential::read_cloud_api_token_os()?;
        let token = token.expose();
        client.publish_catalog_visibility(&body, &token)?;
        self.connection()?.execute("UPDATE mobile_catalog_visibility_state SET published_digest=?2,retry_after=0 WHERE endpoint=?1",params![endpoint,digest])?;
        Ok(())
    }
}

#[cfg(test)]
mod workload_tests {
    use super::*;
    #[test]
    fn workload_deferral_preserves_local_edits_and_has_deadline() {
        let now = std::time::Instant::now();
        let mut d = Deferral::default();
        d.mobile_edit(3, 5, 3, now, true);
        assert!(d.deferred(5, now, true));
        d.mobile_edit(5, 7, 3, now + std::time::Duration::from_secs(60), true);
        assert!(!d.deferred(7, now + std::time::Duration::from_secs(1800), true));
        d.mobile_edit(3, 5, 3, now, true);
        assert!(!d.deferred(6, now, true));
        d.mobile_edit(4, 5, 3, now, true);
        assert!(!d.deferred(5, now, true));
        d.mobile_edit(3, 5, 3, now, true);
        assert!(!d.deferred(5, now, false));
    }
    #[test]
    fn held_saved_publications_dispatch_only_receive_lanes_and_do_not_record_checked() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path().join("library")).unwrap();
        library.use_machine_settings(temp.path().join("machine.json"));
        library
            .set_cloud_sync_config(crate::cloud::models::CloudSyncConfig {
                enabled: true,
                api_base_url: Some("http://127.0.0.1".into()),
            })
            .unwrap();
        library
            .set_cloud_sync_hold("http://127.0.0.1", true)
            .unwrap();
        let mut slots = Vec::new();
        let count = library
            .run_saved_mobile_publications_with(
                |slot, job| {
                    slots.push(slot);
                    job();
                    Ok(true)
                },
                |_, kind, _| {
                    assert!(matches!(
                        kind,
                        "collections"
                            | "characters"
                            | "similarity"
                            | "catalogDuplicates"
                            | "releases"
                            | "upcoming"
                            | "artists"
                    ));
                    Ok(())
                },
            )
            .unwrap();
        assert_eq!(count, 7);
        assert_eq!(slots, [0, 1, 3, 4, 5, 8, 10]);
        for slot in 0..12 {
            assert_eq!(library.publication_inputs.checked_generation(slot), None);
        }
    }

    #[test]
    fn held_collection_lane_receives_then_stops_before_publication() {
        use crate::cloud::client::CloudClient;
        use serde_json::json;
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path().join("library")).unwrap();
        library.use_machine_settings(temp.path().join("machine.json"));
        let endpoint = "http://127.0.0.1";
        library
            .set_cloud_sync_config(crate::cloud::models::CloudSyncConfig {
                enabled: true,
                api_base_url: Some(endpoint.into()),
            })
            .unwrap();
        library.set_cloud_sync_hold(endpoint, true).unwrap();
        let id = library.library_id().unwrap();
        library
            .adopt_collection_personal_edit_library(endpoint, &id)
            .unwrap();
        library.connection().unwrap().execute("INSERT INTO collections(id,name,type,created_at,updated_at) VALUES('known','Known','game','now','now')", []).unwrap();
        Library::update_publication_endpoint_on(&library.connection().unwrap(), endpoint).unwrap();
        let (mut client, requests) = CloudClient::home_test_client(vec![
            json!({"version":1,"libraryId":id,"after":0,"nextCursor":1,"hasMore":false,"items":[{"sequence":1,"operationId":"op-1","collectionId":"known","field":"showcase","value":true,"previous":false,"createdAt":"2026-10-04T00:00:00Z"}]}),
        ]);
        client.gate = library.sync_gate(endpoint).unwrap();
        let before: i64 = library.connection().unwrap().query_row("SELECT published_generation FROM mobile_publication_state WHERE kind='collections'", [], |r| r.get(0)).unwrap();
        library
            .publish_due_mobile_kind_with_receive("collections", endpoint, || {
                library
                    .receive_collection_personal_edits_with(&client, "publisher", endpoint, 1)
                    .map(|_| ())
            })
            .unwrap();
        assert_eq!(
            library
                .collection_personal_edit_adoption(endpoint)
                .unwrap()
                .unwrap()
                .1,
            1
        );
        let db = library.connection().unwrap();
        assert!(db
            .query_row(
                "SELECT showcase FROM collections WHERE id='known'",
                [],
                |r| r.get::<_, bool>(0)
            )
            .unwrap());
        let (published, retry): (i64,i64) = db.query_row("SELECT published_generation,retry_after FROM mobile_publication_state WHERE kind='collections'", [], |r| Ok((r.get(0)?,r.get(1)?))).unwrap();
        assert_eq!((published, retry), (before, 0));
        let requests = requests.lock().unwrap();
        assert_eq!(requests.len(), 1);
        assert!(requests[0].starts_with(b"GET "));
    }
}
