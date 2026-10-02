use super::*;
use rusqlite::params;
fn fixture() -> (tempfile::TempDir, Library, PathBuf) {
    let temp = tempfile::tempdir().unwrap();
    let library = Library::open(temp.path().join("library")).unwrap();
    let root = temp.path().join("manga");
    library
        .set_manga_root(Some(root.to_str().unwrap()))
        .unwrap();
    (temp, library, root)
}
fn add_series(c: &Connection, id: &str, path: &str) {
    c.execute("INSERT INTO manga_series(id,relative_path,title,author,page_count,thumbnail_relative_path,scanned_at,modified_at) VALUES(?1,?2,?1,'artist',1,'thumb','now','now')",params![id,path]).unwrap();
}

#[test]
fn p0_empty_manga_root_never_offers_or_purges_indexed_series() {
    let (_temp, library, root) = fixture();
    add_series(&library.connection().unwrap(), "saved", "gone/a");
    // An unmounted mount point is still a readable directory; cached thumbnails
    // alone must not be considered evidence that the source disk is mounted.
    fs::create_dir(root.join(".lakomics-thumbs")).unwrap();
    let index = library.manga_local_index();
    let purge = library.purge_vanished_manga_folders(vec!["gone".into()]);
    assert!(index.is_err(), "empty root offered vanished folders");
    assert!(purge.is_err(), "empty root allowed metadata deletion");
    assert_eq!(library.list_manga_series().unwrap().len(), 1);
}

#[test]
fn p0_replaced_manga_root_is_rejected_even_when_nonempty() {
    let (_temp, library, root) = fixture();
    fs::create_dir(root.join("saved")).unwrap();
    image::DynamicImage::new_rgb8(4, 4)
        .save(root.join("saved/001.png"))
        .unwrap();
    assert_eq!(library.scan_manga().unwrap(), 1);
    fs::rename(&root, root.with_extension("original")).unwrap();
    fs::create_dir_all(root.join("unrelated")).unwrap();
    let index = library.manga_local_index();
    let purge = library.purge_vanished_manga_folders(vec!["saved".into()]);
    assert!(index.is_err(), "replaced root offered vanished folders");
    assert!(purge.is_err());
    assert_eq!(library.list_manga_series().unwrap().len(), 1);
}

#[test]
fn p0_root_replacement_during_backup_refuses_purge() {
    let (_temp, library, root) = fixture();
    fs::create_dir(root.join("keep")).unwrap();
    add_series(&library.connection().unwrap(), "saved", "gone/a");
    super::backup::set_before_verify_hook(move || {
        fs::rename(&root, root.with_extension("original")).unwrap();
        fs::create_dir_all(root.join("unrelated")).unwrap();
    });
    let error = library
        .purge_vanished_manga_folders(vec!["gone".into()])
        .unwrap_err();
    assert!(matches!(error, LibraryError::UnsafeMangaRoot(_)));
    assert_eq!(library.list_manga_series().unwrap().len(), 1);
    assert_eq!(library.list_backups().unwrap().len(), 1);
}

#[test]
fn p0_root_identity_survives_restart_in_machine_settings() {
    let (temp, library, root) = fixture();
    let settings = temp.path().join("machine.json");
    library.use_machine_settings(settings.clone());
    library
        .set_manga_root(Some(root.to_str().unwrap()))
        .unwrap();
    fs::create_dir(root.join("saved")).unwrap();
    image::DynamicImage::new_rgb8(4, 4)
        .save(root.join("saved/001.png"))
        .unwrap();
    assert_eq!(library.scan_manga().unwrap(), 1);
    drop(library);
    fs::rename(&root, root.with_extension("original")).unwrap();
    fs::create_dir_all(root.join("unrelated")).unwrap();
    let library = Library::open(temp.path().join("library")).unwrap();
    library.use_machine_settings(settings);
    assert!(matches!(
        library.manga_local_index(),
        Err(LibraryError::UnsafeMangaRoot(_))
    ));
    assert!(matches!(
        library.scan_manga(),
        Err(LibraryError::UnsafeMangaRoot(_))
    ));
    assert!(matches!(
        library.purge_vanished_manga_folders(vec!["saved".into()]),
        Err(LibraryError::UnsafeMangaRoot(_))
    ));
    assert_eq!(library.list_manga_series().unwrap().len(), 1);
    fs::remove_dir(root.join("unrelated")).unwrap();
    fs::remove_dir(&root).unwrap();
    fs::rename(root.with_extension("original"), &root).unwrap();
    assert!(library.manga_local_index().unwrap().vanished.is_empty());
}

#[test]
fn p0_empty_root_during_backup_keeps_series() {
    let (_temp, library, root) = fixture();
    fs::create_dir(root.join("keep")).unwrap();
    add_series(&library.connection().unwrap(), "saved", "gone/a");
    super::backup::set_before_verify_hook(move || {
        fs::remove_dir(root.join("keep")).unwrap();
    });
    assert!(matches!(
        library.purge_vanished_manga_folders(vec!["gone".into()]),
        Err(LibraryError::UnsafeMangaRoot(_))
    ));
    assert_eq!(library.list_manga_series().unwrap().len(), 1);
}

#[test]
fn p0_legacy_root_is_adopted_by_a_read_before_any_purge() {
    let (temp, library, root) = fixture();
    fs::create_dir(root.join("keep")).unwrap();
    add_series(&library.connection().unwrap(), "saved", "gone/a");
    library.use_machine_settings(temp.path().join("machine.json"));
    // A root never checked on this PC cannot be purged blind ...
    assert!(matches!(
        library.purge_vanished_manga_folders(vec!["gone".into()]),
        Err(LibraryError::UnsafeMangaRoot(_))
    ));
    // ... but a non-empty root is adopted by the index read (no re-selection after the update).
    assert_eq!(library.manga_local_index().unwrap().vanished.len(), 1);
    // Once adopted, an emptied (unmounted) root is still refused.
    fs::remove_dir(root.join("keep")).unwrap();
    assert!(matches!(
        library.manga_local_index(),
        Err(LibraryError::UnsafeMangaRoot(_))
    ));
}
fn pin(namespace: &str, value: &str) -> MangaIndexIdentity {
    MangaIndexIdentity {
        kind: if namespace == "artist" {
            "artist"
        } else {
            "tag"
        }
        .into(),
        namespace: namespace.into(),
        value: value.into(),
        label: value.into(),
    }
}
fn catalog(library: &Library, works: usize) {
    let path = library.root.join("catalogs");
    fs::create_dir_all(&path).unwrap();
    let mut c = Connection::open(path.join("kdata.db")).unwrap();
    c.execute_batch("CREATE TABLE Works(Id INTEGER PRIMARY KEY, Category INTEGER);
        CREATE TABLE Tags(WorkId INTEGER, Namespace TEXT, Value TEXT, PRIMARY KEY(WorkId,Namespace,Value)) WITHOUT ROWID;").unwrap();
    let t = c.transaction().unwrap();
    for i in 1..=works {
        t.execute("INSERT INTO Works VALUES(?1,1)", [i as i64])
            .unwrap();
        for (ns, v) in [("female", "tag"), ("artist", "someone")] {
            t.execute(
                "INSERT INTO Tags VALUES(?1,?2,?3)",
                params![i as i64, ns, v],
            )
            .unwrap();
        }
    }
    t.commit().unwrap();
    fs::write(path.join("tag-ko.json"), r#"{"female:tag":"female:태그"}"#).unwrap();
}
#[test]
fn migration_and_pins_are_library_data_and_idempotent() {
    let (temp, library, _) = fixture();
    assert_eq!(
        library
            .connection()
            .unwrap()
            .pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
            .unwrap(),
        super::super::db::SCHEMA_VERSION
    );
    let a = pin("female", "same");
    library.add_manga_index_pin(a.clone()).unwrap();
    library.add_manga_index_pin(a.clone()).unwrap();
    library.add_manga_index_pin(pin("male", "same")).unwrap();
    library.add_manga_index_pin(pin("artist", "same")).unwrap();
    assert_eq!(library.list_manga_index_pins().unwrap().len(), 3);
    let invalid = MangaIndexIdentity {
        kind: "tag".into(),
        ..pin("artist", "same")
    };
    assert!(library.add_manga_index_pin(invalid).is_err());
    drop(library);
    let library = Library::open(temp.path().join("library")).unwrap();
    assert_eq!(library.list_manga_index_pins().unwrap().len(), 3);
    library.remove_manga_index_pin(a.clone()).unwrap();
    library.remove_manga_index_pin(a).unwrap();
    assert_eq!(library.list_manga_index_pins().unwrap().len(), 2);
}
#[test]
fn counts_use_only_canonical_bookmarks_and_visibility_with_catalog_labels() {
    let (_temp, library, _) = fixture();
    catalog(&library, 4);
    library.connection().unwrap().execute_batch("INSERT INTO online_catalog_bookmarks VALUES('kHentai','1','now'),('kHentai','2','now'),('kHentai','03','now');
        INSERT INTO online_catalog_hidden_categories VALUES(2,'now');").unwrap();
    let c = Connection::open(library.root.join("catalogs/kdata.db")).unwrap();
    c.execute_batch(
        "UPDATE Works SET Category=2 WHERE Id=2; INSERT INTO Tags VALUES(4,'female','unsaved');",
    )
    .unwrap();
    let result = library.manga_frequent_index(None, None).unwrap();
    assert_eq!(result.bookmark_count, 3);
    assert_eq!(result.tags[0].count, 1);
    assert_eq!(result.tags[0].identity.label, "태그");
    assert_eq!(result.artists[0].count, 1);
    library
        .connection()
        .unwrap()
        .execute_batch("INSERT INTO online_catalog_blocked_tags VALUES('female','tag','now')")
        .unwrap();
    assert!(library
        .manga_frequent_index(None, None)
        .unwrap()
        .tags
        .is_empty());
}
#[test]
fn synthetic_2000_bookmarks_cost() {
    let (_temp, library, _) = fixture();
    catalog(&library, 2500);
    library.connection().unwrap().execute_batch("WITH RECURSIVE n(i) AS(VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<2000) INSERT INTO online_catalog_bookmarks SELECT 'kHentai',CAST(i AS TEXT),'now' FROM n").unwrap();
    let start = std::time::Instant::now();
    for _ in 0..10 {
        let r = library.manga_frequent_index(None, None).unwrap();
        assert_eq!(r.tags[0].count, 2000);
        assert_eq!(r.artists[0].count, 2000);
    }
    eprintln!(
        "manga index: 2,000 bookmarks / 2,500 catalog works, 10 full reads: {:?}; mean {:?}",
        start.elapsed(),
        start.elapsed() / 10
    );
    let c = library.connection().unwrap();
    c.execute(
        "ATTACH DATABASE ?1 AS catalog",
        [library
            .root
            .join("catalogs/kdata.db")
            .to_string_lossy()
            .as_ref()],
    )
    .unwrap();
    let mut q=c.prepare("EXPLAIN QUERY PLAN SELECT tag.Namespace,tag.Value,COUNT(DISTINCT work.Id) FROM online_catalog_bookmarks bookmark CROSS JOIN catalog.Works work ON work.Id=CAST(bookmark.work_id AS INTEGER) JOIN catalog.Tags tag ON tag.WorkId=work.Id WHERE bookmark.provider='kHentai' AND bookmark.work_id=CAST(work.Id AS TEXT) GROUP BY tag.Namespace,tag.Value").unwrap();
    let plan = q
        .query_map([], |r| r.get::<_, String>(3))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert!(
        plan.iter()
            .any(|p| p.contains("SEARCH work USING INTEGER PRIMARY KEY")),
        "{plan:?}"
    );
    assert!(
        !plan
            .iter()
            .any(|p| p.contains("SCAN work") || p.contains("SCAN tag")),
        "{plan:?}"
    );
}
#[test]
fn local_listing_and_vanished_detection_are_first_level_and_fail_closed() {
    let (_temp, library, root) = fixture();
    fs::create_dir(root.join("exists")).unwrap();
    fs::create_dir(root.join("empty")).unwrap();
    fs::create_dir(root.join(".lakomics-thumbs")).unwrap();
    {
        let c = library.connection().unwrap();
        add_series(&c, "a", "exists/a");
        add_series(&c, "b", "exists\\b");
        add_series(&c, "gone", "missing/a");
        add_series(&c, "unsafe", "../outside");
    }
    let result = library.manga_local_index().unwrap();
    assert_eq!(result.folders.len(), 2);
    assert_eq!(
        result
            .folders
            .iter()
            .find(|f| f.name == "exists")
            .unwrap()
            .series_count,
        2
    );
    assert_eq!(result.vanished[0].relative_path, "missing");
    fs::rename(&root, root.with_extension("moved")).unwrap();
    assert!(library.manga_local_index().is_err());
    assert!(library
        .purge_vanished_manga_folders(vec!["missing".into()])
        .is_err());
}
#[test]
fn purge_backs_up_before_removing_only_selected_metadata_and_never_files() {
    let (_temp, library, root) = fixture();
    fs::create_dir(root.join("keep")).unwrap();
    fs::write(root.join("keep/page.jpg"), b"keep").unwrap();
    {
        let c = library.connection().unwrap();
        add_series(&c, "a", "gone/a");
        add_series(&c, "b", "gone/b");
        add_series(&c, "other", "other/a");
        add_series(&c, "keep", "keep/a");
    }
    let result = library
        .purge_vanished_manga_folders(vec!["gone".into(), "gone".into()])
        .unwrap();
    assert_eq!(result.removed_series_count, 2);
    let backup = Connection::open(result.backup_path).unwrap();
    assert_eq!(
        backup
            .query_row("SELECT COUNT(*) FROM manga_series", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        4
    );
    assert_eq!(
        backup
            .pragma_query_value(None, "quick_check", |r| r.get::<_, String>(0))
            .unwrap(),
        "ok"
    );
    assert_eq!(
        library
            .connection()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM manga_series", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        2
    );
    assert_eq!(fs::read(root.join("keep/page.jpg")).unwrap(), b"keep");
}
#[test]
fn purge_refuses_reappeared_paths_and_rolls_back_the_whole_selection() {
    let (_temp, library, root) = fixture();
    fs::create_dir(root.join("keep")).unwrap();
    {
        let c = library.connection().unwrap();
        add_series(&c, "a", "gone/a");
        add_series(&c, "b", "gone/b");
    }
    fs::create_dir(root.join("gone")).unwrap();
    assert!(library
        .purge_vanished_manga_folders(vec!["gone".into()])
        .is_err());
    fs::remove_dir(root.join("gone")).unwrap();
    assert!(library
        .purge_vanished_manga_folders(vec!["../gone".into()])
        .is_err());
    library.connection().unwrap().execute_batch("CREATE TRIGGER stop_purge BEFORE DELETE ON manga_series WHEN OLD.id='b' BEGIN SELECT RAISE(ABORT,'test failure'); END;").unwrap();
    assert!(library
        .purge_vanished_manga_folders(vec!["gone".into()])
        .is_err());
    assert_eq!(
        library
            .connection()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM manga_series", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        2
    );
    assert_eq!(library.list_backups().unwrap().len(), 1);
}
#[test]
fn backup_failure_does_not_delete_records() {
    let (_temp, library, root) = fixture();
    fs::create_dir(root.join("keep")).unwrap();
    add_series(&library.connection().unwrap(), "a", "gone");
    fs::remove_dir(library.root.join("backups")).unwrap();
    fs::write(library.root.join("backups"), b"blocked").unwrap();
    assert!(library
        .purge_vanished_manga_folders(vec!["gone".into()])
        .is_err());
    assert_eq!(
        library
            .connection()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM manga_series", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
}

#[test]
fn purge_refuses_a_folder_restored_during_backup_verification() {
    let (_temp, library, root) = fixture();
    fs::create_dir(root.join("keep")).unwrap();
    add_series(&library.connection().unwrap(), "a", "gone/a");
    super::backup::set_before_verify_hook(move || {
        fs::create_dir(root.join("gone")).unwrap();
    });
    assert!(library
        .purge_vanished_manga_folders(vec!["gone".into()])
        .is_err());
    assert_eq!(
        library
            .connection()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM manga_series", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(library.list_backups().unwrap().len(), 1);
}
#[test]
fn purge_verification_failure_leaves_library_records_intact() {
    let (_temp, library, root) = fixture();
    fs::create_dir(root.join("keep")).unwrap();
    add_series(&library.connection().unwrap(), "a", "gone/a");
    let backups = library.root.join("backups");
    super::backup::set_before_verify_hook(move || {
        let file = fs::read_dir(backups)
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        fs::write(file, b"corrupt test snapshot").unwrap();
    });
    assert!(library
        .purge_vanished_manga_folders(vec!["gone".into()])
        .is_err());
    assert_eq!(
        library
            .connection()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM manga_series", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert!(library.list_backups().unwrap().is_empty());
}
