use super::{
    import_targeted_work,
    tests::{catalog, page},
    write_catalog_work, RemoteCatalogPage,
};
use rusqlite::{Connection, OpenFlags, OptionalExtension};

fn revision(connection: &Connection) -> String {
    connection
        .query_row(
            "SELECT Value FROM CrawlState WHERE Key='lakomics.catalog.contentRevision'",
            [],
            |row| row.get(0),
        )
        .optional()
        .unwrap()
        .unwrap_or_else(|| "legacy".into())
}

#[test]
fn content_revision_read_does_not_initialize_legacy_catalog() {
    let (_dir, path) = catalog();
    let connection = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();

    assert_eq!(
        super::super::catalog_revision::content_revision(&connection).unwrap(),
        "legacy"
    );
    assert_eq!(revision(&connection), "legacy");
    assert!(super::super::catalog_revision::initialize_content_revision(&connection).is_err());
    assert_eq!(revision(&connection), "legacy");
}

#[test]
fn content_revision_initialization_is_stable_across_calls_and_restarts() {
    let (_dir, path) = catalog();
    let connection = Connection::open(&path).unwrap();
    let first = super::super::catalog_revision::initialize_content_revision(&connection).unwrap();
    assert_ne!(first, "legacy");
    assert!(uuid::Uuid::parse_str(&first).is_ok());
    assert_eq!(
        super::super::catalog_revision::initialize_content_revision(&connection).unwrap(),
        first
    );
    drop(connection);

    let reopened = Connection::open(&path).unwrap();
    assert_eq!(
        super::super::catalog_revision::initialize_content_revision(&reopened).unwrap(),
        first
    );
    assert_eq!(revision(&reopened), first);
}

#[test]
fn content_revision_initialization_preserves_existing_revision() {
    let (_dir, path) = catalog();
    let connection = Connection::open(&path).unwrap();
    connection
        .execute(
            "INSERT INTO CrawlState(Key,Value) VALUES('lakomics.catalog.contentRevision','existing-revision')",
            [],
        )
        .unwrap();

    assert_eq!(
        super::super::catalog_revision::initialize_content_revision(&connection).unwrap(),
        "existing-revision"
    );
    assert_eq!(revision(&connection), "existing-revision");
}

#[test]
fn content_revision_initialization_replaces_persisted_legacy_sentinel_once() {
    let (_dir, path) = catalog();
    let connection = Connection::open(&path).unwrap();
    connection
        .execute(
            "INSERT INTO CrawlState(Key,Value) VALUES('lakomics.catalog.contentRevision','legacy')",
            [],
        )
        .unwrap();

    let initialized =
        super::super::catalog_revision::initialize_content_revision(&connection).unwrap();
    assert_ne!(initialized, "legacy");
    assert!(uuid::Uuid::parse_str(&initialized).is_ok());
    assert_eq!(
        super::super::catalog_revision::initialize_content_revision(&connection).unwrap(),
        initialized
    );
}

#[test]
fn content_revision_initialization_rolls_back_with_publication_transaction() {
    let (_dir, path) = catalog();
    let mut connection = Connection::open(&path).unwrap();
    let transaction = connection.transaction().unwrap();
    let initialized =
        super::super::catalog_revision::initialize_content_revision(&transaction).unwrap();
    assert_ne!(initialized, "legacy");
    transaction.rollback().unwrap();

    assert_eq!(revision(&connection), "legacy");
}

#[test]
fn catalog_revision_stays_legacy_for_empty_pages_and_status_changes() {
    let (_dir, path) = catalog();
    let connection = Connection::open(&path).unwrap();
    let language = super::CatalogLanguage::Japanese;
    let checkpoint =
        super::catalog_checkpoint::start(&path, language, "2026-09-05T00:00:00Z").unwrap();
    super::commit_stream_page(
        &path,
        language,
        &checkpoint,
        &RemoteCatalogPage::parse("[]").unwrap(),
        1,
    )
    .unwrap();
    super::catalog_checkpoint::record_error(&path, language, "fixture").unwrap();
    super::catalog_checkpoint::reset_japanese(&path).unwrap();
    assert_eq!(revision(&connection), "legacy");
    assert_eq!(
        super::super::catalog_revision::content_revision(&connection).unwrap(),
        "legacy"
    );
}

#[test]
fn catalog_revision_tracks_content_but_not_replay_or_transport_metadata() {
    let (_dir, path) = catalog();
    let mut connection = Connection::open(&path).unwrap();
    assert_eq!(revision(&connection), "legacy");
    let mut value: serde_json::Value = serde_json::from_str(&page(&[70])).unwrap();
    import_targeted_work(&path, &page(&[70]), 70).unwrap();
    let mut previous = revision(&connection);
    assert_ne!(previous, "legacy");
    for (field, value_change) in [
        ("views", serde_json::json!(35)),
        ("parent_gid", serde_json::json!(60)),
        ("title", serde_json::json!("changed")),
    ] {
        value[0][field] = value_change;
        let parsed = RemoteCatalogPage::parse(&value.to_string()).unwrap();
        let tx = connection.transaction().unwrap();
        write_catalog_work(&tx, &parsed.works[0], 1).unwrap();
        tx.commit().unwrap();
        let next = revision(&connection);
        assert_ne!(next, previous, "canonical change: {field}");
        assert!(uuid::Uuid::parse_str(&next).is_ok());
        previous = next;
    }
    value[0]["transport_only"] = serde_json::json!("ignored extra data");
    let parsed = RemoteCatalogPage::parse(&value.to_string()).unwrap();
    let tx = connection.transaction().unwrap();
    write_catalog_work(&tx, &parsed.works[0], 999).unwrap();
    tx.commit().unwrap();
    assert_eq!(revision(&connection), previous);
    value[0]["views"] = serde_json::json!(100);
    let parsed = RemoteCatalogPage::parse(&value.to_string()).unwrap();
    let tx = connection.transaction().unwrap();
    write_catalog_work(&tx, &parsed.works[0], 1000).unwrap();
    assert_ne!(revision(&tx), previous);
    tx.rollback().unwrap();
    assert_eq!(revision(&connection), previous);
}

#[test]
fn catalog_revision_targeted_recovery_tracks_tags_and_preserved_language_union() {
    let (_dir, path) = catalog();
    let connection = Connection::open(&path).unwrap();
    assert!(import_targeted_work(&path, &page(&[70]), 70).unwrap());
    let korean = revision(&connection);
    assert_ne!(korean, "legacy");
    let japanese = page(&[70]).replace("\"korean\"", "\"japanese\"");
    import_targeted_work(&path, &japanese, 70).unwrap();
    let merged = revision(&connection);
    assert_ne!(merged, korean);
    import_targeted_work(&path, &japanese, 70).unwrap();
    import_targeted_work(&path, &page(&[70]), 70).unwrap();
    assert_eq!(revision(&connection), merged);
    let retagged = page(&[70]).replace("artist-70", "new-artist");
    import_targeted_work(&path, &retagged, 70).unwrap();
    assert_ne!(revision(&connection), merged);
}
