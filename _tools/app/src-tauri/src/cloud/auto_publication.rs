//! Quiet, restart-safe one-way publication. No provider refresh or library backfill.
use crate::library::{Library,error::LibraryError};
use rusqlite::params;
use std::sync::Mutex;
// Separate lanes prevent slow artwork uploads from blocking character/settings changes.
static RUNNING: [Mutex<()>;5] = [Mutex::new(()),Mutex::new(()),Mutex::new(()),Mutex::new(()),Mutex::new(())];
fn dispatch(running: &'static Mutex<()>, work: impl FnOnce()+Send+'static) -> std::io::Result<std::thread::JoinHandle<()>> {
    std::thread::Builder::new().name("mobile-publication".into()).spawn(move || {
        let Ok(_permit)=running.try_lock() else {return};
        work();
    })
}

/// Run both steps, then report the first error.
fn both(first: impl FnOnce()->Result<(),LibraryError>, second: impl FnOnce()->Result<(),LibraryError>) -> Result<(),LibraryError> {
    let first=first();
    let second=second();
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
    pub(crate) fn mobile_edit(&mut self, before: i64, after: i64, published: i64, now: std::time::Instant, light: bool) {
        if light && (before == published || self.generation == Some(before)) {
            self.generation = Some(after);
            self.since.get_or_insert(now);
        } else { *self = Self::default(); }
    }
    fn deferred(&mut self, generation: i64, now: std::time::Instant, light: bool) -> bool {
        if light && self.generation == Some(generation) && self.since.is_some_and(|since| now.duration_since(since) < std::time::Duration::from_secs(1800)) { true }
        else { *self = Self::default(); false }
    }
}

impl Library {
    pub(crate) fn save_mobile_navigation_order(&self, order_ids: Vec<String>) -> Result<(),LibraryError> {
        if order_ids.len()>20_000 || order_ids.iter().any(|s|s.len()>180) {return Err(LibraryError::InvalidCloudResponse)}
        let order=serde_json::to_string(&order_ids).map_err(|_|LibraryError::InvalidCloudResponse)?;
        self.connection()?.execute("UPDATE mobile_publication_state SET navigation_order=?1,generation=generation+1,first_dirty=CASE WHEN generation=published_generation THEN unixepoch() ELSE first_dirty END,last_dirty=unixepoch() WHERE kind='characters' AND navigation_order<>?1", [&order])?;
        Ok(())
    }
    pub(crate) fn run_saved_mobile_publications(&self) -> Result<(),LibraryError> {
        let config=self.cloud_sync_config()?;
        let endpoint=config.api_base_url.unwrap_or_default();
        if !config.enabled || endpoint.is_empty() {return Ok(())}
        self.connection()?.execute("UPDATE mobile_publication_state SET endpoint=?1,generation=generation+1,first_dirty=0,last_dirty=0,retry_after=0 WHERE endpoint<>?1",[&endpoint])?;
        for (slot,kind) in ["collections","characters","visibility","similarity","catalogDuplicates"].into_iter().enumerate() {
            let library=self.clone();let endpoint=endpoint.clone();
            // Return after dispatch so the native owner's next tick can service every free lane.
            dispatch(&RUNNING[slot],move || {
                // `similarity`: automatic comparison of newly materialized Assets, then mobile
                // similarity decisions and the pair feed (`similarity_review_sync.rs`).
                let _=match kind {
                    "visibility" => library.publish_due_catalog_visibility(&endpoint),
                    "similarity" => library.run_due_similarity_review(&endpoint).map_err(|error| {eprintln!("similarity review: {error}");error}),
                    // Manga Catalog duplicate editions (`catalog_duplicate_sync.rs`).
                    "catalogDuplicates" => library.run_due_catalog_duplicates(&endpoint).map_err(|error| {eprintln!("catalog duplicates: {error}");error}),
                    _ => library.publish_due_mobile_kind(kind,&endpoint),
                };
            }).map_err(|_|LibraryError::InvalidCloudResponse)?;
        }
        Ok(())
    }

    fn publish_due_mobile_kind(&self,kind:&str,endpoint:&str)->Result<(),LibraryError> {
        let config=self.cloud_sync_config()?;
        if !config.enabled || config.api_base_url.as_deref()!=Some(endpoint){return Ok(())}
        if kind == "characters" {
            // Receive even when no local changes have dirtied the publication. Order:
            // exclusions → mobile review decisions → snapshot → candidate feed. The two
            // receives are independent channels, so a failing exclusion pass must not starve
            // the review receive; the first error still ends this tick.
            both(|| self.run_due_character_exclusions(endpoint), || self.run_due_character_review(endpoint))?;
        } else if kind == "collections" {
            // Same for mobile personal edits (at most once a minute, durably throttled).
            // An applied edit dirties the lane through the 0074 triggers; the publication
            // itself receives again before it reads the snapshot.
            self.run_due_collection_personal_edits(endpoint)?;
        }
        let generation:Option<i64>={
            use rusqlite::OptionalExtension;
            self.connection()?.query_row("SELECT generation FROM mobile_publication_state WHERE kind=?1 AND endpoint=?2 AND generation<>published_generation AND retry_after<=unixepoch() AND (last_dirty<=unixepoch()-30 OR first_dirty<=unixepoch()-300)",params![kind,endpoint],|r|r.get(0)).optional()?
        };
        let Some(generation)=generation else {
            if kind=="characters" {
                // No snapshot is due, but the candidate feed has its own schedule (the S36
                // cache and saved B36 predictions change without dirtying this lane). A
                // publication that is due republishes the feed itself, right after it.
                if let Err(error)=self.publish_due_character_review_feed(endpoint) {eprintln!("character review feed: {error}");}
            }
            return Ok(())
        };
        if kind == "collections" && self.collection_publication_defer.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
            .deferred(generation, std::time::Instant::now(), crate::workload::is_lightweight()) { return Ok(()); }
        self.connection()?.execute("UPDATE mobile_publication_state SET retry_after=unixepoch()+60 WHERE kind=?1",[kind])?;
        let result=if kind=="collections" {self.push_cloud_collections(&|_|{}).map(|_|())} else {self.push_cloud_characters(&|_|{}).map(|_|())};
        if result.is_ok() {
            self.connection()?.execute("UPDATE mobile_publication_state SET published_generation=?2,retry_after=0,first_dirty=CASE WHEN generation=?2 THEN 0 ELSE unixepoch() END WHERE kind=?1 AND endpoint=?3",params![kind,generation,endpoint])?;
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use crate::library::Library;
    #[test]
    fn blocked_collection_does_not_block_repeated_character_ticks_or_duplicate_work() {
        use std::sync::{Mutex,mpsc};
        use std::time::Duration;
        static COLLECTION:Mutex<()>=Mutex::new(());
        static CHARACTER:Mutex<()>=Mutex::new(());
        let (started_tx,started_rx)=mpsc::channel();
        let (release_tx,release_rx)=mpsc::channel();
        let collection=super::dispatch(&COLLECTION,move || {started_tx.send(()).unwrap();release_rx.recv().unwrap();}).unwrap();
        started_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        super::dispatch(&COLLECTION,||panic!("duplicated in-flight collection")).unwrap().join().unwrap();
        for _ in 0..2 {
            let (tx,rx)=mpsc::channel();
            let character=super::dispatch(&CHARACTER,move || {tx.send(()).unwrap();}).unwrap();
            rx.recv_timeout(Duration::from_secs(2)).expect("character tick waited for collection");
            character.join().unwrap();
        }
        release_tx.send(()).unwrap();collection.join().unwrap();
        let (tx,rx)=mpsc::channel();
        super::dispatch(&COLLECTION,move || {tx.send(()).unwrap();}).unwrap().join().unwrap();
        rx.recv_timeout(Duration::from_secs(2)).unwrap();
    }
    #[test]
    fn character_review_runs_after_an_exclusion_failure_and_the_first_error_is_reported() {
        use crate::library::error::LibraryError;
        let mut review_ran=false;
        let result=super::both(|| Err(LibraryError::CharacterExclusionUnsupported), || {review_ran=true;Err(LibraryError::CharacterReviewUnsupported)});
        assert!(review_ran);
        assert!(matches!(result,Err(LibraryError::CharacterExclusionUnsupported)));
        let result=super::both(|| Ok(()), || Err(LibraryError::CharacterReviewUnsupported));
        assert!(matches!(result,Err(LibraryError::CharacterReviewUnsupported)));
        assert!(super::both(|| Ok(()), || Ok(())).is_ok());
    }
    #[test]
    fn catalog_visibility_is_debounced_and_remains_dirty_after_restart() {
        let dir=tempfile::tempdir().unwrap();
        let library=Library::open(dir.path()).unwrap();
        // The first tick only records the small settings snapshot, without network access.
        let endpoint="https://example.invalid";
        library.publish_due_catalog_visibility(endpoint).unwrap();
        let db=library.connection().unwrap();
        let original:String=db.query_row("SELECT digest FROM mobile_catalog_visibility_state",[],|r|r.get(0)).unwrap();
        db.execute("UPDATE mobile_catalog_visibility_state SET published_digest=digest",[]).unwrap();
        db.execute("INSERT INTO online_catalog_blocked_tags(namespace,value,created_at) VALUES('tag','blocked','2026-09-13')",[]).unwrap();
        drop(db);
        library.publish_due_catalog_visibility(endpoint).unwrap();
        let db=library.connection().unwrap();
        let changed:(String,String,i64)=db.query_row("SELECT digest,published_digest,retry_after FROM mobile_catalog_visibility_state",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).unwrap();
        assert_ne!(changed.0,original);assert_eq!(changed.1,original);assert_eq!(changed.2,0);
        drop(db);drop(library);
        let reopened=Library::open(dir.path()).unwrap();
        let dirty:bool=reopened.connection().unwrap().query_row("SELECT digest<>published_digest FROM mobile_catalog_visibility_state",[],|r|r.get(0)).unwrap();
        assert!(dirty);
    }
    #[test]
    fn publication_generation_survives_restart_and_late_changes() {
        let dir=tempfile::tempdir().unwrap();
        let library=Library::open(dir.path()).unwrap();
        let db=library.connection().unwrap();
        db.execute("UPDATE mobile_publication_state SET published_generation=generation",[]).unwrap();
        db.execute("INSERT INTO classification_entries(id,name,kind,created_at) VALUES('folder','Folder','tag','2026-09-13')",[]).unwrap();
        let captured:i64=db.query_row("SELECT generation FROM mobile_publication_state WHERE kind='characters'",[],|r|r.get(0)).unwrap();
        db.execute("UPDATE classification_entries SET name='Changed' WHERE id='folder'",[]).unwrap();
        db.execute("UPDATE mobile_publication_state SET published_generation=?1 WHERE kind='characters'",[captured]).unwrap();
        drop(db);drop(library);
        let reopened=Library::open(dir.path()).unwrap();
        let dirty:bool=reopened.connection().unwrap().query_row("SELECT generation>published_generation FROM mobile_publication_state WHERE kind='characters'",[],|r|r.get(0)).unwrap();
        assert!(dirty);
    }
}

impl Library {
    /// Run the character exclusion receive poll for this endpoint, at most once a minute.
    ///
    /// Not gated on the publication being dirty: a correction the server accepted while this
    /// PC was idle is exactly the case where no local change would have made the lane dirty.
    ///
    /// A never-adopted endpoint is bootstrapped here rather than only during publication, so a
    /// server upgraded while this PC sat idle is discovered within the poll interval. The
    /// throttle is durable so a restart cannot stampede the log, and network work happens
    /// outside every database lock.
    pub(crate) fn run_due_character_exclusions(&self, endpoint: &str) -> Result<(), LibraryError> {
        use rusqlite::OptionalExtension;
        let config = self.cloud_sync_config()?;
        if !config.enabled || config.api_base_url.as_deref() != Some(endpoint) {
            return Ok(());
        }
        let due = {
            let db = self.connection()?;
            let due:bool=db.query_row("SELECT last_checked<=unixepoch()-60 FROM mobile_character_exclusion_poll WHERE endpoint=?1",[endpoint],|r|r.get(0)).optional()?.unwrap_or(true);
            if due {
                db.execute("INSERT INTO mobile_character_exclusion_poll(endpoint,last_checked) VALUES(?1,unixepoch()) ON CONFLICT(endpoint) DO UPDATE SET last_checked=excluded.last_checked",[endpoint])?;
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

    fn publish_due_catalog_visibility(&self,endpoint:&str)->Result<(),LibraryError>{
        let (body,digest)={let db=self.connection()?;let body=crate::library::mobile_catalog::visibility_snapshot(&db)?;let digest=crate::library::mobile_catalog::hash_json(&body)?;(body,digest)};
        let due={let db=self.connection()?;
            db.execute("INSERT OR IGNORE INTO mobile_catalog_visibility_state(endpoint,digest,first_dirty,last_dirty) VALUES(?1,?2,unixepoch(),unixepoch())",params![endpoint,digest])?;
            db.execute("UPDATE mobile_catalog_visibility_state SET digest=?2,first_dirty=CASE WHEN digest=published_digest THEN unixepoch() ELSE first_dirty END,last_dirty=unixepoch() WHERE endpoint=?1 AND digest<>?2",params![endpoint,digest])?;
            let due:bool=db.query_row("SELECT digest<>published_digest AND retry_after<=unixepoch() AND (last_dirty<=unixepoch()-30 OR first_dirty<=unixepoch()-300) FROM mobile_catalog_visibility_state WHERE endpoint=?1",[endpoint],|r|r.get(0))?;
            if due{db.execute("UPDATE mobile_catalog_visibility_state SET retry_after=unixepoch()+60 WHERE endpoint=?1",[endpoint])?;}due
        };
        if !due{return Ok(())}
        let client=super::client::CloudClient::new(endpoint)?;
        let token=crate::library::credential::read_cloud_api_token_os()?;
        let token = token.expose();
        client.publish_catalog_visibility(&body,&token)?;
        self.connection()?.execute("UPDATE mobile_catalog_visibility_state SET published_digest=?2,retry_after=0 WHERE endpoint=?1",params![endpoint,digest])?;
        Ok(())
    }
}

#[cfg(test)]
mod workload_tests {
    use super::*;
    #[test]
    fn workload_deferral_preserves_local_edits_and_has_deadline() {
        let now = std::time::Instant::now(); let mut d = Deferral::default();
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
}
