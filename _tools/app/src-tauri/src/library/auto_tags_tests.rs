//! 자동 태그 tests: migration, import (replace keeps edits), edits and the asset filter.

use std::path::{Path, PathBuf};

use rusqlite::{params, Connection};

use super::auto_tags::{AutoTagEdit, AutoTagSource};
use super::error::LibraryError;
use super::models::{AssetQuery, AssetSort, AutoTagFilter};
use super::Library;

fn open_library(dir: &Path) -> Result<Library, LibraryError> {
    let root = dir.join("library");
    std::fs::create_dir_all(&root).unwrap();
    Library::open(&root)
}

fn fixture(ids: &[&str]) -> (tempfile::TempDir, Library) {
    let temp = tempfile::tempdir().unwrap();
    let library = open_library(temp.path()).unwrap();
    {
        let connection = library.connection().unwrap();
        for (index, id) in ids.iter().enumerate() {
            insert_asset(
                &connection,
                id,
                &format!("2026-09-{:02}T00:00:00Z", index + 1),
            );
        }
    }
    (temp, library)
}

fn insert_asset(connection: &Connection, id: &str, collected_at: &str) {
    connection
        .execute(
            "INSERT INTO assets (id, content_hash, media_kind, original_name, relative_path, thumbnail_relative_path,
                byte_size, width, height, collected_at)
             VALUES (?1, ?1, 'image', ?1, 'assets/' || ?1, 'thumbnails/' || ?1 || '.webp', 1, 10, 10, ?2)",
            params![id, collected_at],
        )
        .unwrap();
}

/// Writes an import file the way `auto_tags_export.py` does.
fn import_file(
    dir: &Path,
    name: &str,
    model: &str,
    vocabulary: &[(&str, &str)],
    rows: &[(&str, &str, f64)],
) -> PathBuf {
    let path = dir.join(name);
    let connection = Connection::open(&path).unwrap();
    connection
        .execute_batch(
            "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             CREATE TABLE vocabulary (tag TEXT PRIMARY KEY, category TEXT NOT NULL);
             CREATE TABLE asset_tags (asset_id TEXT NOT NULL, tag TEXT NOT NULL, score REAL NOT NULL, PRIMARY KEY (asset_id, tag));",
        )
        .unwrap();
    for (key, value) in [
        ("format", "lakomics-auto-tags"),
        ("version", "1"),
        ("model", model),
    ] {
        connection
            .execute("INSERT INTO meta VALUES (?1, ?2)", params![key, value])
            .unwrap();
    }
    for (tag, category) in vocabulary {
        connection
            .execute(
                "INSERT INTO vocabulary VALUES (?1, ?2)",
                params![tag, category],
            )
            .unwrap();
    }
    for (asset, tag, score) in rows {
        connection
            .execute(
                "INSERT INTO asset_tags VALUES (?1, ?2, ?3)",
                params![asset, tag, score],
            )
            .unwrap();
    }
    path
}

const VOCABULARY: &[(&str, &str)] = &[
    ("1girl", "general"),
    ("long_hair", "general"),
    ("glasses", "general"),
    ("school_uniform", "general"),
    ("hoshino_(blue_archive)", "character"),
];

fn effective(library: &Library, asset: &str) -> Vec<(String, AutoTagSource)> {
    let mut tags: Vec<_> = library
        .asset_auto_tags(asset)
        .unwrap()
        .tags
        .into_iter()
        .map(|tag| (tag.tag, tag.source))
        .collect();
    tags.sort_by(|left, right| left.0.cmp(&right.0));
    tags
}

fn ids(library: &Library, query: AssetQuery) -> (Vec<String>, u64) {
    let page = library.list_assets(query).unwrap();
    (
        page.items.into_iter().map(|asset| asset.id).collect(),
        page.total_count,
    )
}

fn filtered(include: &[&str], exclude: &[&str], sort: AssetSort) -> AssetQuery {
    AssetQuery {
        sort,
        limit: 50,
        auto_tags: Some(AutoTagFilter {
            include: include.iter().map(|tag| (*tag).to_owned()).collect(),
            exclude: exclude.iter().map(|tag| (*tag).to_owned()).collect(),
        }),
        ..Default::default()
    }
}

#[test]
fn migration_creates_the_auto_tag_tables_and_upgrades_from_101() {
    let temp = tempfile::tempdir().unwrap();
    {
        let library = open_library(temp.path()).unwrap();
        let connection = library.connection().unwrap();
        for table in [
            "asset_auto_tags",
            "auto_tag_vocabulary",
            "asset_auto_tag_edits",
            "auto_tag_import",
        ] {
            let exists: bool = connection
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
                    [table],
                    |row| row.get(0),
                )
                .unwrap();
            assert!(exists, "{table}");
        }
        // Simulate a version 101 library.
        connection
            .execute_batch(
                "DROP TABLE asset_auto_tags; DROP TABLE auto_tag_vocabulary; DROP TABLE asset_auto_tag_edits; DROP TABLE auto_tag_import;
                 PRAGMA user_version = 101;",
            )
            .unwrap();
    }
    let library = open_library(temp.path()).unwrap();
    let connection = library.connection().unwrap();
    let version: i64 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap();
    assert_eq!(version, 102);
    let indexed: bool = connection
        .query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'asset_auto_tags_by_tag')", [], |row| row.get(0))
        .unwrap();
    assert!(indexed);
}

#[test]
fn import_replaces_machine_rows_keeps_edits_and_skips_unknown_assets() {
    let (temp, library) = fixture(&["a", "b"]);
    let first = import_file(
        temp.path(),
        "first.sqlite",
        "pixai-v0.9",
        VOCABULARY,
        &[
            ("a", "1girl", 0.99),
            ("a", "glasses", 0.6),
            ("b", "long_hair", 0.9),
            ("gone", "1girl", 0.9),
        ],
    );
    let summary = library.import_auto_tags(&first).unwrap();
    assert_eq!(
        (
            summary.tagged_assets,
            summary.tag_rows,
            summary.skipped_assets
        ),
        (2, 3, 1)
    );
    assert_eq!(summary.model, "pixai-v0.9");
    assert_eq!(summary.source_name, "first.sqlite");

    library
        .edit_asset_auto_tag("a", "glasses", AutoTagEdit::Remove)
        .unwrap();
    library
        .edit_asset_auto_tag("b", "school_uniform", AutoTagEdit::Add)
        .unwrap();

    // Another model still emits glasses for a; the removal must survive, and b keeps its addition.
    let second = import_file(
        temp.path(),
        "second.sqlite",
        "wd-eva02",
        &[
            ("1girl", "general"),
            ("glasses", "general"),
            ("school_uniform", "general"),
        ],
        &[
            ("a", "1girl", 0.97),
            ("a", "glasses", 0.8),
            ("b", "1girl", 0.5),
        ],
    );
    let summary = library.import_auto_tags(&second).unwrap();
    assert_eq!(
        (
            summary.tagged_assets,
            summary.tag_rows,
            summary.skipped_assets
        ),
        (2, 3, 0)
    );
    assert_eq!(
        effective(&library, "a"),
        vec![("1girl".to_owned(), AutoTagSource::Model)]
    );
    assert_eq!(
        effective(&library, "b"),
        vec![
            ("1girl".to_owned(), AutoTagSource::Model),
            ("school_uniform".to_owned(), AutoTagSource::Added)
        ]
    );
    // long_hair from the first model is gone with its vocabulary.
    let vocabulary = library.auto_tag_vocabulary().unwrap();
    assert!(vocabulary.iter().all(|entry| entry.tag != "long_hair"));
    assert_eq!(
        library.auto_tag_import_summary().unwrap().unwrap().model,
        "wd-eva02"
    );
}

#[test]
fn import_rejects_foreign_files_without_changing_the_library() {
    let (temp, library) = fixture(&["a"]);
    let good = import_file(
        temp.path(),
        "good.sqlite",
        "pixai-v0.9",
        VOCABULARY,
        &[("a", "1girl", 0.9)],
    );
    library.import_auto_tags(&good).unwrap();

    let foreign = temp.path().join("foreign.sqlite");
    Connection::open(&foreign)
        .unwrap()
        .execute_batch("CREATE TABLE something (x);")
        .unwrap();
    assert!(matches!(
        library.import_auto_tags(&foreign),
        Err(LibraryError::InvalidAutoTag(_))
    ));

    let bad_category = import_file(
        temp.path(),
        "bad.sqlite",
        "m",
        &[("x", "species")],
        &[("a", "x", 0.5)],
    );
    assert!(matches!(
        library.import_auto_tags(&bad_category),
        Err(LibraryError::InvalidAutoTag(_))
    ));

    assert_eq!(
        effective(&library, "a"),
        vec![("1girl".to_owned(), AutoTagSource::Model)]
    );
}

#[test]
fn edits_add_remove_and_reset_with_counts() {
    let (temp, library) = fixture(&["a", "b", "c"]);
    let file = import_file(
        temp.path(),
        "tags.sqlite",
        "pixai-v0.9",
        VOCABULARY,
        &[
            ("a", "1girl", 0.99),
            ("a", "hoshino_(blue_archive)", 0.91),
            ("b", "1girl", 0.95),
            ("c", "glasses", 0.5),
        ],
    );
    library.import_auto_tags(&file).unwrap();

    let tags = library.asset_auto_tags("a").unwrap();
    assert!(!tags.has_confirmed_character);
    let hoshino = tags
        .tags
        .iter()
        .find(|tag| tag.tag == "hoshino_(blue_archive)")
        .unwrap();
    assert_eq!(hoshino.category, "character");
    assert_eq!(tags.tags[0].tag, "1girl", "highest score first");

    library
        .edit_asset_auto_tag("b", "1girl", AutoTagEdit::Remove)
        .unwrap();
    library
        .edit_asset_auto_tag("c", "1girl", AutoTagEdit::Add)
        .unwrap();
    library
        .edit_asset_auto_tag("c", "glasses", AutoTagEdit::Remove)
        .unwrap();
    let count = |tag: &str| {
        library
            .auto_tag_vocabulary()
            .unwrap()
            .into_iter()
            .find(|entry| entry.tag == tag)
            .unwrap()
            .count
    };
    assert_eq!(count("1girl"), 2, "a keeps it, b removed, c added");
    assert_eq!(count("glasses"), 0);
    assert_eq!(
        count("long_hair"),
        0,
        "vocabulary tags without assets stay listed"
    );
    let added = library.asset_auto_tags("c").unwrap();
    assert_eq!(added.tags.len(), 1);
    assert_eq!(
        (added.tags[0].source, added.tags[0].score),
        (AutoTagSource::Added, None)
    );

    // Undo: reset brings the machine tag back; the added tag goes away when removed.
    library
        .edit_asset_auto_tag("b", "1girl", AutoTagEdit::Reset)
        .unwrap();
    assert_eq!(
        effective(&library, "b"),
        vec![("1girl".to_owned(), AutoTagSource::Model)]
    );
    library
        .edit_asset_auto_tag("c", "1girl", AutoTagEdit::Remove)
        .unwrap();
    assert!(effective(&library, "c").is_empty());

    assert!(matches!(
        library.edit_asset_auto_tag("a", "not_a_known_tag", AutoTagEdit::Add),
        Err(LibraryError::InvalidAutoTag(_))
    ));
    assert!(matches!(
        library.edit_asset_auto_tag("missing", "1girl", AutoTagEdit::Add),
        Err(LibraryError::AssetNotFound)
    ));
    assert!(matches!(
        library.edit_asset_auto_tag("a", " 1girl", AutoTagEdit::Add),
        Err(LibraryError::InvalidAutoTag(_))
    ));
}

#[test]
fn a_confirmed_character_is_reported() {
    let (temp, library) = fixture(&["a", "b"]);
    {
        let connection = library.connection().unwrap();
        connection
            .execute_batch(
                "INSERT INTO classification_entries(id,kind,name,parent_id,created_at) VALUES ('r','root','Root',NULL,'2026'),('s','tag','Series','r','2026');
                 INSERT INTO character_series(classification_id,auto_classify) VALUES('s',0);
                 INSERT INTO character_targets(id,series_classification_id,display_name,enabled,manual_only,created_at,updated_at) VALUES('c','s','C',1,0,'2026','2026');
                 INSERT INTO character_learned_references(target_id,asset_id,asset_hash,created_at) VALUES('c','a','a','2026');",
            )
            .unwrap();
    }
    let file = import_file(
        temp.path(),
        "tags.sqlite",
        "m",
        VOCABULARY,
        &[("a", "1girl", 0.9)],
    );
    library.import_auto_tags(&file).unwrap();
    assert!(
        library
            .asset_auto_tags("a")
            .unwrap()
            .has_confirmed_character
    );
    assert!(
        !library
            .asset_auto_tags("b")
            .unwrap()
            .has_confirmed_character
    );
}

#[test]
fn the_asset_filter_combines_included_and_excluded_tags_in_every_sort() {
    let (temp, library) = fixture(&["a", "b", "c", "d"]);
    let file = import_file(
        temp.path(),
        "tags.sqlite",
        "pixai-v0.9",
        VOCABULARY,
        &[
            ("a", "1girl", 0.9),
            ("a", "school_uniform", 0.8),
            ("b", "1girl", 0.9),
            ("b", "school_uniform", 0.8),
            ("b", "glasses", 0.7),
            ("c", "1girl", 0.9),
            ("d", "school_uniform", 0.6),
        ],
    );
    library.import_auto_tags(&file).unwrap();
    // A user addition counts; a removal hides the machine tag.
    library
        .edit_asset_auto_tag("c", "school_uniform", AutoTagEdit::Add)
        .unwrap();
    library
        .edit_asset_auto_tag("a", "school_uniform", AutoTagEdit::Remove)
        .unwrap();

    for sort in [
        AssetSort::Newest,
        AssetSort::Oldest,
        AssetSort::Favorites,
        AssetSort::Random,
    ] {
        let (mut found, total) = ids(&library, filtered(&["1girl", "school_uniform"], &[], sort));
        found.sort();
        assert_eq!(
            (found, total),
            (vec!["b".to_owned(), "c".to_owned()], 2),
            "{sort:?}"
        );
        let (mut found, total) = ids(
            &library,
            filtered(&["1girl", "school_uniform"], &["glasses"], sort),
        );
        found.sort();
        assert_eq!((found, total), (vec!["c".to_owned()], 1), "{sort:?}");
    }
    let (found, total) = ids(&library, filtered(&[], &["1girl"], AssetSort::Newest));
    assert_eq!((found, total), (vec!["d".to_owned()], 1));
    // A quote in a tag name stays a literal.
    let (found, total) = ids(
        &library,
        filtered(&["it's'); DROP TABLE assets; --"], &[], AssetSort::Newest),
    );
    assert_eq!((found.len(), total), (0, 0));

    // Paging under a filter keeps the filter.
    let mut query = filtered(&["1girl", "school_uniform"], &[], AssetSort::Newest);
    query.limit = 1;
    let first = library.list_assets(query.clone()).unwrap();
    assert_eq!(first.total_count, 2);
    query.after = first.next_cursor;
    let second = library.list_assets(query.clone()).unwrap();
    assert_eq!(second.items.len(), 1);
    assert_ne!(first.items[0].id, second.items[0].id);
    assert!(second.next_cursor.is_none());

    // refresh_assets applies the same predicate.
    let refreshed = library
        .refresh_assets(
            filtered(&["glasses"], &[], AssetSort::Newest),
            vec!["a".into(), "b".into()],
        )
        .unwrap();
    assert_eq!(
        refreshed
            .into_iter()
            .map(|asset| asset.id)
            .collect::<Vec<_>>(),
        vec!["b".to_owned()]
    );

    // A small classification scope takes the membership-driven plan and still filters.
    {
        let connection = library.connection().unwrap();
        connection
            .execute_batch(
                "INSERT INTO classification_entries(id,kind,name,parent_id,created_at) VALUES ('r','root','Root',NULL,'2026'),('f','tag','Folder','r','2026');
                 INSERT INTO asset_classifications VALUES('a','f'),('b','f');",
            )
            .unwrap();
    }
    let mut scoped = filtered(&["1girl"], &[], AssetSort::Newest);
    scoped.classification_id = Some("f".into());
    let (found, total) = ids(&library, scoped);
    assert_eq!((found.len(), total), (2, 2));
    let mut scoped = filtered(&["glasses"], &[], AssetSort::Newest);
    scoped.classification_id = Some("f".into());
    assert_eq!(ids(&library, scoped), (vec!["b".to_owned()], 1));

    let too_many: Vec<&str> = vec!["1girl"; 9];
    assert!(matches!(
        library.list_assets(filtered(&too_many, &[], AssetSort::Newest)),
        Err(LibraryError::InvalidAutoTag(_))
    ));
}

/// Timing probe on a library-sized synthetic set (≈9k assets, ≈480k tag rows).
/// Run with `cargo test --lib auto_tags_scale_probe -- --ignored --nocapture`.
#[test]
#[ignore]
fn auto_tags_scale_probe() {
    use std::time::Instant;
    const ASSETS: usize = 9_000;
    const TAGS_PER_ASSET: usize = 54;
    const VOCABULARY_SIZE: usize = 12_000;
    let temp = tempfile::tempdir().unwrap();
    let library = open_library(temp.path()).unwrap();
    let path = temp.path().join("scale.sqlite");
    {
        let connection = library.connection().unwrap();
        let transaction = connection.unchecked_transaction().unwrap();
        for index in 0..ASSETS {
            insert_asset(
                &transaction,
                &format!("asset-{index:05}"),
                &format!(
                    "2026-{:02}-{:02}T{:02}:00:00Z",
                    1 + index % 12,
                    1 + index % 28,
                    index % 24
                ),
            );
        }
        transaction.commit().unwrap();
        let source = Connection::open(&path).unwrap();
        source
            .execute_batch(
                "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                 CREATE TABLE vocabulary (tag TEXT PRIMARY KEY, category TEXT NOT NULL);
                 CREATE TABLE asset_tags (asset_id TEXT NOT NULL, tag TEXT NOT NULL, score REAL NOT NULL, PRIMARY KEY (asset_id, tag));
                 INSERT INTO meta VALUES ('format','lakomics-auto-tags'),('version','1'),('model','probe');
                 BEGIN;",
            )
            .unwrap();
        for tag in 0..VOCABULARY_SIZE {
            source
                .execute(
                    "INSERT INTO vocabulary VALUES (?1, 'general')",
                    [format!("tag_{tag}")],
                )
                .unwrap();
        }
        let mut insert = source
            .prepare("INSERT OR IGNORE INTO asset_tags VALUES (?1, ?2, ?3)")
            .unwrap();
        for index in 0..ASSETS {
            for slot in 0..TAGS_PER_ASSET {
                // Skewed: low tag numbers are common, like 1girl or long_hair.
                let tag = (slot * slot * 7 + index * (slot + 1))
                    % (if slot < 10 { 40 } else { VOCABULARY_SIZE });
                insert
                    .execute(params![
                        format!("asset-{index:05}"),
                        format!("tag_{tag}"),
                        0.5
                    ])
                    .unwrap();
            }
        }
        drop(insert);
        source.execute_batch("COMMIT;").unwrap();
    }
    let started = Instant::now();
    let summary = library.import_auto_tags(&path).unwrap();
    eprintln!("import {} rows: {:?}", summary.tag_rows, started.elapsed());
    let started = Instant::now();
    let vocabulary = library.auto_tag_vocabulary().unwrap();
    eprintln!(
        "vocabulary {} entries: {:?}",
        vocabulary.len(),
        started.elapsed()
    );
    let started = Instant::now();
    let tags = library.asset_auto_tags("asset-00042").unwrap();
    eprintln!("asset tags {}: {:?}", tags.tags.len(), started.elapsed());
    for (include, exclude) in [
        (vec!["tag_3"], vec![]),
        (vec!["tag_11999"], vec![]),
        (vec!["tag_3", "tag_5"], vec!["tag_7"]),
    ] {
        let started = Instant::now();
        let page = library
            .list_assets(filtered(&include, &exclude, AssetSort::Newest))
            .unwrap();
        eprintln!(
            "filter {include:?} -{exclude:?}: {} items / {} total in {:?}",
            page.items.len(),
            page.total_count,
            started.elapsed()
        );
    }
    let started = Instant::now();
    let page = library
        .list_assets(AssetQuery {
            limit: 50,
            ..Default::default()
        })
        .unwrap();
    eprintln!(
        "unfiltered page {} / {} in {:?}",
        page.items.len(),
        page.total_count,
        started.elapsed()
    );
}

/// Imports a real export file (`auto_tags_export.py` output) into a scratch library whose
/// assets are the file's asset ids. Never point it at a real library.
/// Run with `AUTO_TAGS_PROBE_FILE=<file> cargo test --lib auto_tags_real_file_probe -- --ignored --nocapture`.
#[test]
#[ignore]
fn auto_tags_real_file_probe() {
    use std::time::Instant;
    let Ok(file) = std::env::var("AUTO_TAGS_PROBE_FILE") else {
        return;
    };
    let temp = tempfile::tempdir().unwrap();
    let library = open_library(temp.path()).unwrap();
    {
        let source =
            Connection::open_with_flags(&file, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        let mut statement = source
            .prepare("SELECT DISTINCT asset_id FROM asset_tags")
            .unwrap();
        let ids: Vec<String> = statement
            .query_map([], |row| row.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        let connection = library.connection().unwrap();
        let transaction = connection.unchecked_transaction().unwrap();
        for (index, id) in ids.iter().enumerate() {
            insert_asset(
                &transaction,
                id,
                &format!("2026-01-01T00:{:02}:{:02}Z", index / 60 % 60, index % 60),
            );
        }
        transaction.commit().unwrap();
    }
    let started = Instant::now();
    let summary = library.import_auto_tags(Path::new(&file)).unwrap();
    eprintln!("import {summary:?} in {:?}", started.elapsed());
    let started = Instant::now();
    let vocabulary = library.auto_tag_vocabulary().unwrap();
    eprintln!(
        "vocabulary {} entries in {:?}; top {:?}",
        vocabulary.len(),
        started.elapsed(),
        &vocabulary[..3]
    );
    let started = Instant::now();
    let page = library
        .list_assets(filtered(
            &["school_uniform"],
            &["glasses"],
            AssetSort::Newest,
        ))
        .unwrap();
    eprintln!(
        "filter school_uniform -glasses: {} total in {:?}",
        page.total_count,
        started.elapsed()
    );
}
