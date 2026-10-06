use super::*;
use std::cell::{Cell, RefCell};

const NOW: &str = "2026-10-06T00:00:00Z";
fn fixture() -> (tempfile::TempDir, Library, CollectionAuthorityStatus) {
    let temp = tempfile::tempdir().unwrap();
    let library = Library::open(temp.path()).unwrap();
    let status = CollectionAuthorityStatus {
        active: true,
        library_id: Some(library.library_id().unwrap()),
        epoch: Some(1),
        contract_version: Some(1),
        cursor: Some(0),
    };
    (temp, library, status)
}
fn work(id: &str, rev: i64) -> Value {
    json!({"workId":id,"type":"manga","legacyKind":null,"name":format!("Work {id}"),"fields":{"description":"server memo","coverAssetId":null,"year":2026,"myScore":4.5,"status":"collecting","ownedPlatform":null},"showcase":false,"showcaseOrder":null,"selection":{"work":null,"hero":null,"backdrop":null,"spine":null},"details":{"series":null,"film":null,"av":null},"derived":{"unreadReleaseCount":99},"avCredits":[],"lifecycle":"live","trashedAt":null,"entityRevision":rev,"createdAt":NOW,"updatedAt":NOW})
}
fn art() -> Value {
    use sha2::{Digest, Sha256};
    json!({"artworkId":"art","workId":"w","kind":"cover","provider":null,"providerImageId":null,"width":10,"height":20,"language":null,"original":{"sha256":Sha256::digest(b"image").iter().map(|b| format!("{b:02x}")).collect::<String>(),"sizeBytes":5,"contentType":"image/png","objectKey":"unused"},"thumbnail":null,"createdAt":NOW,"entityRevision":1})
}
fn volume() -> Value {
    json!({"volumeId":"v","workId":"w","volumeNumber":1,"editionIndex":0,"sortOrder":3,"displayLabel":"1","coverArtworkId":"art","sourceProvider":null,"sourceCoverId":null,"deleted":false,"entityRevision":1})
}
fn binding() -> Value {
    json!({"workId":"w","provider":"mangadex","externalId":"provider-work","config":{"language":"ja"},"snapshot":{"title":"server"},"values":{},"snapshotDigest":"digest","snapshotExternalId":"provider-work","lastSyncedAt":NOW,"bound":true,"entityRevision":1})
}
fn source() -> Value {
    json!({"workId":"w","volumeNumber":1,"provider":"kakao","providerItemId":"isbn","title":"Volume","author":null,"publisher":null,"isbn13":"123","publicationDate":"2026-10-06","itemUrl":null,"data":{},"deleted":false,"entityRevision":1})
}
fn membership(asset: &str, rev: i64, desired: bool) -> Value {
    json!({"workId":"w","assetId":asset,"desiredState":desired,"entityRevision":rev,"addedAt":NOW})
}
fn ownership() -> Value {
    json!({"workId":"w","volumeNumber":1,"editionIndex":0,"physical":true,"digital":false,"entityRevision":1})
}
fn envelope(status: &CollectionAuthorityStatus) -> Value {
    json!({"libraryId":status.library_id,"epoch":status.epoch,"contractVersion":status.contract_version})
}
fn manifest(status: &CollectionAuthorityStatus, entities: &Value) -> Value {
    let mut v = envelope(status);
    v["snapshotCursor"] = json!(status.cursor.unwrap());
    v["sections"] = json!(SECTIONS
        .iter()
        .map(|s| json!({"section":s,"count":entities[*s].as_array().map_or(0,Vec::len)}))
        .collect::<Vec<_>>());
    v
}
fn page(status: &CollectionAuthorityStatus, section: usize, items: Value) -> Value {
    let mut v = envelope(status);
    v["snapshotCursor"] = json!(status.cursor.unwrap());
    v["section"] = json!(SECTIONS[section]);
    v["items"] = items;
    v["nextAfter"] = Value::Null;
    v["hasMore"] = json!(false);
    v["complete"] = json!(section == 6);
    v["nextSection"] = json!(SECTIONS.get(section + 1));
    v
}
fn adopt(l: &Library, s: &CollectionAuthorityStatus, entities: Value) {
    l.begin_collection_baseline(s, &manifest(s, &entities))
        .unwrap();
    for (i, section) in SECTIONS.iter().enumerate() {
        assert_eq!(
            l.apply_collection_baseline_page(&page(
                s,
                i,
                entities[*section]
                    .as_array()
                    .map(|v| json!(v))
                    .unwrap_or(json!([]))
            ))
            .unwrap(),
            i == 6
        );
    }
}
fn changes(s: &CollectionAuthorityStatus, cursor: i64, items: Value) -> Value {
    let mut v = envelope(s);
    v["cursor"] = json!(cursor);
    v["nextAfter"] = json!(cursor);
    v["hasMore"] = json!(false);
    v["items"] = items;
    v
}
fn change(seq: i64, entities: Value) -> Value {
    json!({"sequence":seq,"authorityCursor":seq,"commandType":"updateWork","operationId":format!("op{seq}"),"changedAt":NOW,"entities":entities})
}
fn asset(l: &Library, id: &str) {
    l.connection().unwrap().execute("INSERT INTO assets(id,content_hash,media_kind,original_name,relative_path,thumbnail_relative_path,byte_size,width,height,collected_at) VALUES(?1,?1,'image',?1,?1,'thumb',1,10,20,'now')",[id]).unwrap();
}
fn count(l: &Library, table: &str) -> i64 {
    l.connection()
        .unwrap()
        .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
        .unwrap()
}

#[test]
fn collection_authority_empty_adoption_projects_all_seven_sections() {
    let (_temp, l, s) = fixture();
    asset(&l, "asset");
    let mut w = work("w", 1);
    w["selection"]["work"] = json!("art");
    adopt(
        &l,
        &s,
        json!({"works":[w],"bindings":[binding()],"artworks":[art()],"volumes":[volume()],"volumeSources":[source()],"ownership":[ownership()],"memberships":[membership("asset",1,true)]}),
    );
    assert!(ensure_collection_write_ready(&*l.connection().unwrap(), &s).unwrap());
    for table in [
        "collections",
        "collection_external_bindings",
        "collection_work_artworks",
        "collection_volumes",
        "collection_volume_sources",
        "collection_volume_ownership",
        "collection_assets",
        "collection_authority_materialization",
    ] {
        assert_eq!(count(&l, table), 1, "{table}");
    }
    assert_eq!(count(&l, "collection_authority_revisions"), 7);
    let db = l.connection().unwrap();
    assert_eq!(
        db.query_row(
            "SELECT selected FROM collection_work_artworks WHERE id='art'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        1
    );
    assert_eq!(
        db.query_row(
            "SELECT status FROM collection_pc_records WHERE collection_id='w'",
            [],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        "collecting"
    );
    assert_eq!(
        db.query_row("SELECT cover_artwork_id FROM collection_volumes", [], |r| r
            .get::<_, String>(0))
            .unwrap(),
        "art"
    );
}

#[test]
fn collection_authority_populated_adoption_preserves_local_paths_thumbnails_activity_workers_and_focus(
) {
    let (temp, l, s) = fixture();
    l.connection().unwrap().execute_batch("INSERT INTO collections(id,name,type,source_path,created_at,updated_at) VALUES('w','Old','manga','source folder','old','old'),('orphan','Local only','manga',NULL,'old','old');
        INSERT INTO collection_work_artworks(id,collection_id,provider,provider_image_id,kind,relative_path,mime_type,width,height,created_at,updated_at) VALUES('art','w','local','art','cover','local/original.png','image/png',10,20,'old','old');
        INSERT INTO collection_volumes(id,collection_id,volume_number,edition_index,sort_order,source_file_name,created_at,updated_at) VALUES('v','w',1,0,1,'local volume.png','old','old');
        INSERT INTO collection_volume_cover_focus VALUES('v','art',0.25,'head');
        INSERT INTO collection_external_bindings(collection_id,provider,external_id,created_at,updated_at) VALUES('w','mangadex','old','old','old');
        INSERT INTO collection_update_attempts VALUES('w','mangadex','later');
        INSERT INTO collection_activity(collection_id,open_count,last_opened_at) VALUES('w',7,'old');
        INSERT INTO collection_ownership_tracking VALUES('w',0);").unwrap();
    std::fs::create_dir_all(temp.path().join("local")).unwrap();
    std::fs::write(temp.path().join("local/original.png"), b"local").unwrap();
    std::fs::write(temp.path().join("local/thumb.webp"), b"thumbnail").unwrap();
    adopt(
        &l,
        &s,
        json!({"works":[work("w",1)],"bindings":[binding()],"artworks":[art()],"volumes":[volume()],"ownership":[ownership()]}),
    );
    let db = l.connection().unwrap();
    assert_eq!(
        db.query_row(
            "SELECT name,source_path FROM collections WHERE id='w'",
            [],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        )
        .unwrap(),
        ("Work w".into(), "source folder".into())
    );
    assert_eq!(
        db.query_row(
            "SELECT relative_path FROM collection_work_artworks",
            [],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        "local/original.png"
    );
    assert_eq!(
        db.query_row("SELECT source_file_name FROM collection_volumes", [], |r| r
            .get::<_, String>(0))
            .unwrap(),
        "local volume.png"
    );
    assert_eq!(
        db.query_row("SELECT open_count FROM collection_activity", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        7
    );
    assert_eq!(
        db.query_row("SELECT retry_at FROM collection_update_attempts", [], |r| r
            .get::<_, String>(0))
            .unwrap(),
        "later"
    );
    assert_eq!(
        db.query_row(
            "SELECT focus_x FROM collection_volume_cover_focus",
            [],
            |r| r.get::<_, f64>(0)
        )
        .unwrap(),
        0.25
    );
    assert_eq!(
        db.query_row(
            "SELECT lifecycle FROM collection_authority_trash WHERE work_id='orphan'",
            [],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        "absent"
    );
    drop(db);
    assert_eq!(count(&l, "collection_authority_materialization"), 0);
    assert_eq!(count(&l, "collection_ownership_tracking"), 1);
    assert_eq!(
        std::fs::read(temp.path().join("local/original.png")).unwrap(),
        b"local"
    );
    assert_eq!(
        std::fs::read(temp.path().join("local/thumb.webp")).unwrap(),
        b"thumbnail"
    );
}

#[test]
fn collection_authority_pages_are_transactional_resumable_counted_and_fenced_until_complete() {
    let (_temp, l, s) = fixture();
    let entities = json!({"works":[work("w",1),work("x",1)]});
    l.begin_collection_baseline(&s, &manifest(&s, &entities))
        .unwrap();
    assert!(matches!(
        ensure_collection_write_ready(&*l.connection().unwrap(), &s),
        Err(LibraryError::CollectionAuthorityNotAdopted)
    ));
    let mut first = page(&s, 0, json!([work("w", 1)]));
    first["hasMore"] = json!(true);
    first["nextAfter"] = json!("[\"w\"]");
    first["nextSection"] = Value::Null;
    l.apply_collection_baseline_page(&first).unwrap();
    assert_eq!(
        local(&*l.connection().unwrap())
            .unwrap()
            .unwrap()
            .after
            .as_deref(),
        Some("[\"w\"]")
    );
    assert!(l.apply_collection_baseline_page(&first).is_err());
    assert_eq!(count(&l, "collections"), 1);
    let mut invalid = page(&s, 0, json!([work("x", 1)]));
    invalid["complete"] = json!(true);
    assert!(l.apply_collection_baseline_page(&invalid).is_err());
    assert_eq!(count(&l, "collections"), 1);
    l.apply_collection_baseline_page(&page(&s, 0, json!([work("x", 1)])))
        .unwrap();
    for i in 1..7 {
        l.apply_collection_baseline_page(&page(&s, i, json!([])))
            .unwrap();
    }
    assert!(local(&*l.connection().unwrap()).unwrap().unwrap().adopted);
}

#[test]
fn collection_authority_changes_are_idempotent_revision_checked_ordered_and_atomic() {
    let (_temp, l, s) = fixture();
    adopt(&l, &s, json!({"works":[work("w",1)]}));
    asset(&l, "a");
    let mut w = work("w", 2);
    w["name"] = json!("Updated");
    w["selection"]["work"] = json!("art");
    let p = changes(
        &s,
        1,
        json!([change(
            1,
            json!({"works":[w],"bindings":[binding()],"artworks":[art()],"volumes":[volume()],"volumeSources":[source()],"ownership":[ownership()],"memberships":[membership("a",1,true)]})
        )]),
    );
    assert_eq!(l.apply_collection_changes(&p).unwrap(), 7);
    assert_eq!(l.apply_collection_changes(&p).unwrap(), 0);
    assert_eq!(
        local(&*l.connection().unwrap()).unwrap().unwrap().id.cursor,
        1
    );
    let stale = changes(&s, 2, json!([change(2, json!({"works":[work("w",1)]}))]));
    assert_eq!(l.apply_collection_changes(&stale).unwrap(), 0);
    assert_eq!(l.apply_collection_changes(&p).unwrap(), 0);
    assert_eq!(
        l.connection()
            .unwrap()
            .query_row("SELECT name FROM collections WHERE id='w'", [], |r| r
                .get::<_, String>(0))
            .unwrap(),
        "Updated"
    );
    let gap = changes(&s, 4, json!([change(4, json!({"works":[work("w",3)]}))]));
    assert!(l.apply_collection_changes(&gap).is_err());
    let reversed = changes(&s, 4, json!([change(4, json!({})), change(3, json!({}))]));
    assert!(l.apply_collection_changes(&reversed).is_err());
    let malformed = changes(
        &s,
        3,
        json!([change(
            3,
            json!({"works":[work("w",3)],"bindings":[{"workId":"w"}]})
        )]),
    );
    assert!(l.apply_collection_changes(&malformed).is_err());
    assert_eq!(
        local(&*l.connection().unwrap()).unwrap().unwrap().id.cursor,
        2
    );
    let mut b = binding();
    b["bound"] = json!(false);
    b["entityRevision"] = json!(2);
    let mut v = volume();
    v["deleted"] = json!(true);
    v["entityRevision"] = json!(2);
    l.apply_collection_changes(&changes(
        &s,
        3,
        json!([change(
            3,
            json!({"bindings":[b],"volumes":[v],"memberships":[membership("a",2,false)]})
        )]),
    ))
    .unwrap();
    assert_eq!(count(&l, "collection_assets"), 0);
    assert_eq!(count(&l, "collection_external_bindings"), 0);
    assert_eq!(count(&l, "collection_volumes"), 0);
    assert_eq!(count(&l, "assets"), 1);
}

#[test]
fn collection_authority_trash_tombstone_and_restore_preserve_files_assets_and_local_subtree() {
    let (temp, l, s) = fixture();
    asset(&l, "a");
    adopt(
        &l,
        &s,
        json!({"works":[work("w",1)],"artworks":[art()],"volumes":[volume()],"memberships":[membership("a",1,true)]}),
    );
    std::fs::write(temp.path().join("keep.png"), b"keep").unwrap();
    let mut w = work("w", 2);
    w["lifecycle"] = json!("trashed");
    w["trashedAt"] = json!(NOW);
    l.apply_collection_changes(&changes(&s, 1, json!([change(1, json!({"works":[w]}))])))
        .unwrap();
    let retain: String = l
        .connection()
        .unwrap()
        .query_row(
            "SELECT retain_until FROM collection_authority_trash",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(retain.starts_with("2026-11-05"));
    let mut w = work("w", 3);
    w["lifecycle"] = json!("tombstoned");
    w["trashedAt"] = json!(NOW);
    l.apply_collection_changes(&changes(&s, 2, json!([change(2, json!({"works":[w]}))])))
        .unwrap();
    assert_eq!(count(&l, "assets"), 1);
    assert_eq!(count(&l, "collection_work_artworks"), 0);
    assert_eq!(count(&l, "collection_volumes"), 0);
    assert!(temp.path().join("keep.png").exists());
    assert_eq!(count(&l, "collections"), 0);
    l.apply_collection_changes(&changes(
        &s,
        3,
        json!([change(3, json!({"works":[work("w",4)]}))]),
    ))
    .unwrap();
    assert_eq!(count(&l, "collection_authority_trash"), 0);
    assert_eq!(count(&l, "collection_work_artworks"), 1);
    assert_eq!(count(&l, "collection_volumes"), 1);
}

#[test]
fn collection_authority_missing_assets_materialize_later_without_advancing_cursor() {
    let (_temp, l, s) = fixture();
    let mut w = work("w", 1);
    w["fields"]["coverAssetId"] = json!("later");
    adopt(
        &l,
        &s,
        json!({"works":[w],"memberships":[membership("later",1,true)]}),
    );
    assert_eq!(count(&l, "collection_assets"), 0);
    asset(&l, "later");
    let mut db = l.connection().unwrap();
    let tx = db.transaction().unwrap();
    selections(&tx).unwrap();
    tx.commit().unwrap();
    drop(db);
    assert_eq!(count(&l, "collection_assets"), 1);
    assert_eq!(
        local(&*l.connection().unwrap()).unwrap().unwrap().id.cursor,
        0
    );
}

fn enqueue(l: &Library, s: &CollectionAuthorityStatus, command: &str) -> String {
    let mut db = l.connection().unwrap();
    let tx = db.transaction().unwrap();
    let id = enqueue_collection_command(&tx, s, command, "w", json!({"workId":"w"})).unwrap();
    tx.commit().unwrap();
    id
}
#[test]
fn collection_authority_outbox_fifo_receipts_conflicts_drops_and_backoff() {
    let (_temp, l, s) = fixture();
    adopt(&l, &s, json!({"works":[work("w",1)]}));
    let ids: Vec<_> = (0..4).map(|_| enqueue(&l, &s, "updateWork")).collect();
    let calls = RefCell::new(Vec::new());
    let retry = Cell::new(true);
    let send = |body: &Value| -> Result<CollectionDelivery, LibraryError> {
        let op = text(body, "operationId")?.to_owned();
        calls.borrow_mut().push(body.clone());
        Ok(if op == ids[0] {
            let mut receipt = envelope(&s);
            receipt["commandType"] = body["commandType"].clone();
            receipt["operationId"] = body["operationId"].clone();
            receipt["changed"] = json!(true);
            receipt["authorityCursor"] = json!(1);
            receipt["entities"] = json!({"works":[work("w",2)]});
            CollectionDelivery::Accepted(receipt)
        } else if op == ids[1] {
            CollectionDelivery::Conflict(
                json!({"code":"revisionConflict","current":{"works":[work("w",2)]}}),
            )
        } else if op == ids[2] {
            CollectionDelivery::Dropped(json!({"code":"workDeleted"}))
        } else if retry.get() {
            CollectionDelivery::Retry
        } else {
            let mut receipt = envelope(&s);
            receipt["commandType"] = body["commandType"].clone();
            receipt["operationId"] = body["operationId"].clone();
            receipt["changed"] = json!(false);
            receipt["authorityCursor"] = json!(1);
            receipt["entities"] = json!({});
            CollectionDelivery::Accepted(receipt)
        })
    };
    assert!(l.flush_collection_outbox_with(&s, &send, 100).unwrap());
    assert_eq!(calls.borrow().len(), 2);
    assert!(!l.flush_collection_outbox_with(&s, &send, 100).unwrap());
    assert_eq!(calls.borrow().len(), 2);
    assert_eq!(
        l.connection()
            .unwrap()
            .query_row(
                "SELECT state FROM collection_authority_outbox WHERE operation_id=?1",
                [&ids[1]],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
        "blocked"
    );
    // Simulate an explicit conflict dismissal by a later batch's UI. Until that
    // decision, no dependent command is allowed to overtake the blocked head.
    l.connection().unwrap().execute("UPDATE collection_authority_outbox SET state='dropped',drop_reason='userDiscarded' WHERE operation_id=?1",[&ids[1]]).unwrap();
    assert!(!l.flush_collection_outbox_with(&s, &send, 100).unwrap());
    assert_eq!(calls.borrow().len(), 4);
    assert!(!l.flush_collection_outbox_with(&s, &send, 104).unwrap());
    assert_eq!(calls.borrow().len(), 4);
    retry.set(false);
    assert!(l.flush_collection_outbox_with(&s, &send, 105).unwrap());
    assert_eq!(calls.borrow()[3], calls.borrow()[4]);
    let db = l.connection().unwrap();
    let states: Vec<String> = db
        .prepare("SELECT state FROM collection_authority_outbox ORDER BY seq")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(states, ["accepted", "dropped", "dropped", "accepted"]);
    assert_eq!(
        db.query_row(
            "SELECT drop_reason FROM collection_authority_outbox WHERE operation_id=?1",
            [&ids[2]],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        "workDeleted"
    );
    assert_eq!(local(&db).unwrap().unwrap().id.cursor, 0);
}

#[test]
fn collection_authority_rejects_mismatched_receipt_and_keeps_intent() {
    let (_temp, l, s) = fixture();
    adopt(&l, &s, json!({"works":[work("w",1)]}));
    enqueue(&l, &s, "updateWork");
    assert!(l
        .flush_collection_outbox_with(
            &s,
            &|_| Ok(CollectionDelivery::Accepted(json!({"libraryId":"wrong"}))),
            0
        )
        .is_err());
    assert_eq!(
        l.connection()
            .unwrap()
            .query_row("SELECT state FROM collection_authority_outbox", [], |r| {
                r.get::<_, String>(0)
            })
            .unwrap(),
        "pending"
    );
}

#[test]
fn collection_authority_inactive_gate_does_no_transport_database_or_file_work() {
    let (_temp, l, s) = fixture();
    let mut inactive = s.clone();
    inactive.active = false;
    assert!(!ensure_collection_write_ready(&*l.connection().unwrap(), &inactive).unwrap());
    assert!(!l
        .flush_collection_outbox_with(&inactive, &|_| panic!("inactive delivery"), 0)
        .unwrap());
    assert_eq!(
        l.materialize_collection_artwork_with(
            &inactive,
            &|_, _, _, _, _, _| panic!("inactive download"),
            0,
            2
        )
        .unwrap(),
        0
    );
    let (client, requests) = CloudClient::home_test_client(vec![]);
    let aggregate = SyncStatus {
        protocol_version: 1,
        active: false,
        library_id: None,
        domains: vec![],
        publisher_logs: None,
    };
    let before = l.connection().unwrap().total_changes();
    assert_eq!(
        l.sync_collection_authority(&client, "token", None, &aggregate, false)
            .unwrap(),
        (false, false)
    );
    assert!(requests.lock().unwrap().is_empty());
    assert_eq!(l.connection().unwrap().total_changes(), before);
    assert_eq!(count(&l, "collection_authority_sync"), 0);
    assert!(matches!(
        ensure_collection_write_ready(&*l.connection().unwrap(), &s),
        Err(LibraryError::CollectionAuthorityNotAdopted)
    ));
    let mut other = s.clone();
    other.library_id = Some("another".into());
    assert!(matches!(
        ensure_collection_write_ready(&*l.connection().unwrap(), &other),
        Err(LibraryError::CollectionAuthorityMismatch)
    ));
}

#[test]
fn collection_authority_materialization_resumes_validates_hash_and_recovers_after_rename() {
    let (_temp, l, s) = fixture();
    adopt(&l, &s, json!({"works":[work("w",1)],"artworks":[art()]}));
    let calls = Cell::new(0);
    let fail = |_: &str, _: &str, _: &str, _: u64, _: &str, path: &Path| {
        calls.set(calls.get() + 1);
        std::fs::write(path, b"part").unwrap();
        Err(LibraryError::CloudRequestUnavailable)
    };
    assert_eq!(
        l.materialize_collection_artwork_with(&s, &fail, 100, 2)
            .unwrap(),
        0
    );
    assert_eq!(
        l.materialize_collection_artwork_with(&s, &fail, 104, 2)
            .unwrap(),
        0
    );
    assert_eq!(calls.get(), 1);
    let bad = |_: &str, _: &str, _: &str, _: u64, _: &str, path: &Path| {
        std::fs::write(path, b"wrong").unwrap();
        Ok(())
    };
    assert_eq!(
        l.materialize_collection_artwork_with(&s, &bad, 105, 2)
            .unwrap(),
        0
    );
    let good = |_: &str, _: &str, _: &str, _: u64, _: &str, path: &Path| {
        std::fs::write(path, b"image").unwrap();
        Ok(())
    };
    assert_eq!(
        l.materialize_collection_artwork_with(&s, &good, 115, 2)
            .unwrap(),
        1
    );
    l.connection()
        .unwrap()
        .execute(
            "UPDATE collection_authority_materialization SET state='pending'",
            [],
        )
        .unwrap();
    assert_eq!(
        l.materialize_collection_artwork_with(
            &s,
            &|_, _, _, _, _, _| panic!("valid file already present"),
            200,
            2
        )
        .unwrap(),
        1
    );
    assert_eq!(
        l.materialize_collection_artwork_with(&s, &good, 201, 2)
            .unwrap(),
        0
    );
}

#[test]
fn collection_authority_trash_frees_names_and_restores_latest_children_and_local_state() {
    let (_temp, l, s) = fixture();
    adopt(
        &l,
        &s,
        json!({"works":[work("w",1)],"bindings":[binding()],"artworks":[art()],"volumes":[volume()]}),
    );
    l.connection().unwrap().execute_batch("UPDATE collections SET source_path='keep';INSERT INTO collection_activity VALUES('w','before',7);INSERT INTO collection_update_attempts VALUES('w','mangadex','later');").unwrap();
    let mut w = work("w", 2);
    w["lifecycle"] = json!("trashed");
    w["trashedAt"] = json!(NOW);
    l.apply_collection_changes(&changes(&s, 1, json!([change(1, json!({"works":[w]}))])))
        .unwrap();
    let mut x = work("x", 1);
    x["name"] = json!("Work w");
    let mut b = binding();
    b["externalId"] = json!("changed while trashed");
    b["entityRevision"] = json!(2);
    l.apply_collection_changes(&changes(
        &s,
        2,
        json!([change(2, json!({"works":[x],"bindings":[b]}))]),
    ))
    .unwrap();
    let mut restored = work("w", 3);
    restored["name"] = json!("Restored");
    l.apply_collection_changes(&changes(
        &s,
        3,
        json!([change(3, json!({"works":[restored]}))]),
    ))
    .unwrap();
    let db = l.connection().unwrap();
    assert_eq!(
        db.query_row(
            "SELECT source_path FROM collections WHERE id='w'",
            [],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        "keep"
    );
    assert_eq!(
        db.query_row(
            "SELECT external_id FROM collection_external_bindings WHERE collection_id='w'",
            [],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        "changed while trashed"
    );
    assert_eq!(
        db.query_row(
            "SELECT open_count FROM collection_activity WHERE collection_id='w'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        7
    );
    assert_eq!(
        db.query_row(
            "SELECT retry_at FROM collection_update_attempts WHERE collection_id='w'",
            [],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        "later"
    );
}

#[test]
fn collection_authority_baseline_removes_stale_shared_rows_and_can_restart_at_lower_revisions() {
    let (_temp, l, s) = fixture();
    asset(&l, "a");
    adopt(
        &l,
        &s,
        json!({"works":[work("w",5)],"bindings":[binding()],"volumes":[volume()],"volumeSources":[source()],"ownership":[ownership()],"memberships":[membership("a",1,true)]}),
    );
    // A fresh epoch adopts lower entity revisions instead of reusing old lineage.
    let mut next = s.clone();
    next.epoch = Some(2);
    adopt(&l, &next, json!({"works":[work("w",1)]}));
    for table in [
        "collection_external_bindings",
        "collection_volumes",
        "collection_volume_sources",
        "collection_volume_ownership",
        "collection_assets",
    ] {
        assert_eq!(count(&l, table), 0, "{table}");
    }
    assert_eq!(count(&l, "assets"), 1);
    assert_eq!(count(&l, "collection_authority_revisions"), 1);
    assert!(ensure_collection_write_ready(&*l.connection().unwrap(), &next).unwrap());
    assert!(matches!(
        ensure_collection_write_ready(&*l.connection().unwrap(), &s),
        Err(LibraryError::CollectionAuthorityNotAdopted)
    ));
}

#[path = "collection_authority_writer_guard.rs"]
mod writer_guard;
