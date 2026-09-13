//! Quiet, restart-safe one-way publication. No provider refresh or library backfill.
use crate::library::{Library,error::LibraryError};
use rusqlite::params;
use std::sync::Mutex;
// Separate lanes prevent slow artwork uploads from blocking character/settings changes.
static RUNNING: [Mutex<()>;3] = [Mutex::new(()),Mutex::new(()),Mutex::new(())];
fn dispatch(running: &'static Mutex<()>, work: impl FnOnce()+Send+'static) -> std::io::Result<std::thread::JoinHandle<()>> {
    std::thread::Builder::new().name("mobile-publication".into()).spawn(move || {
        let Ok(_permit)=running.try_lock() else {return};
        work();
    })
}

impl Library {
    pub(crate) fn run_due_mobile_publications(&self, order_ids: Vec<String>) -> Result<(),LibraryError> {
        if order_ids.len()>20_000 || order_ids.iter().any(|s|s.len()>180) {return Err(LibraryError::InvalidCloudResponse)}
        let order=serde_json::to_string(&order_ids).map_err(|_|LibraryError::InvalidCloudResponse)?;
        let config=self.cloud_sync_config()?;
        let endpoint=config.api_base_url.unwrap_or_default();
        {
            let db=self.connection()?;
            db.execute("UPDATE mobile_publication_state SET navigation_order=?1,generation=generation+1,first_dirty=CASE WHEN generation=published_generation THEN unixepoch() ELSE first_dirty END,last_dirty=unixepoch() WHERE kind='characters' AND navigation_order<>?1",[&order])?;
            if !config.enabled || endpoint.is_empty() {return Ok(())}
            db.execute("UPDATE mobile_publication_state SET endpoint=?1,generation=generation+1,first_dirty=0,last_dirty=0,retry_after=0 WHERE endpoint<>?1",[&endpoint])?;
        }
        for (slot,kind) in ["collections","characters","visibility"].into_iter().enumerate() {
            let library=self.clone();let endpoint=endpoint.clone();
            // Return after dispatch so the frontend's next tick can service every free lane.
            dispatch(&RUNNING[slot],move || {
                let _=if kind=="visibility" {library.publish_due_catalog_visibility(&endpoint)} else {library.publish_due_mobile_kind(kind,&endpoint)};
            }).map_err(|_|LibraryError::InvalidCloudResponse)?;
        }
        Ok(())
    }

    fn publish_due_mobile_kind(&self,kind:&str,endpoint:&str)->Result<(),LibraryError> {
        let config=self.cloud_sync_config()?;
        if !config.enabled || config.api_base_url.as_deref()!=Some(endpoint){return Ok(())}
        let generation:Option<i64>={
            use rusqlite::OptionalExtension;
            self.connection()?.query_row("SELECT generation FROM mobile_publication_state WHERE kind=?1 AND endpoint=?2 AND generation<>published_generation AND retry_after<=unixepoch() AND (last_dirty<=unixepoch()-30 OR first_dirty<=unixepoch()-300)",params![kind,endpoint],|r|r.get(0)).optional()?
        };
        let Some(generation)=generation else {return Ok(())};
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
        client.publish_catalog_visibility(&body,&token)?;
        self.connection()?.execute("UPDATE mobile_catalog_visibility_state SET published_digest=?2,retry_after=0 WHERE endpoint=?1",params![endpoint,digest])?;
        Ok(())
    }
}
