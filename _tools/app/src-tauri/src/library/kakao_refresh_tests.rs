//! The PC's real Kakao refresh against `fixtures/kakao_refresh.json`, the case table the
//! server's `collection_release_checks.plan_refresh` is tested against too
//! (`server/lakomics-api/tests/test_collection_release_checks.py`). The format is documented in
//! the fixture's top-level `comment`. Every case seeds a temporary library with the stored
//! binding, source rows, slots, subscription and volume range, runs
//! `BookFlow::refresh_aladin_items_at`, and compares what the PC stored.

use std::collections::BTreeMap;

use serde_json::{json, Value};

use super::{
    aladin::{classify_product, AladinItem},
    error::LibraryError,
    models::{CollectionType, CreateCollection, ExternalBindingInput},
    Library,
};

fn text(value: &Value) -> Option<String> {
    value.as_str().map(str::to_owned)
}

/// The raw document of a product: its optional `raw`, else `{"id": id}`.
fn raw_document(product: &Value) -> Value {
    match product.get("raw") {
        Some(raw) => raw.clone(),
        None => json!({ "id": product["id"] }),
    }
}

/// A search product as the Kakao parser builds it (`item_id` = id).
fn item(product: &Value) -> AladinItem {
    let title = product["title"].as_str().unwrap();
    let (volume_number, base_title) = classify_product(title)
        .into_volume()
        .unwrap_or_else(|| panic!("{title} is not a usable product"));
    let id = product["id"].as_str().unwrap();
    AladinItem {
        item_id: id.into(),
        title: title.into(),
        author: text(&product["author"]),
        publisher: text(&product["publisher"]),
        isbn13: text(&product["isbn13"]),
        publication_date: text(&product["date"]),
        item_url: text(&product["url"]),
        volume_number,
        base_title,
        snapshot_json: raw_document(product).to_string(),
    }
}

/// A stored source row of the fixture (`volume` ... `itemUrl`), as the table keeps it.
fn source_json(row: &Value) -> Value {
    json!({
        "volumeNumber": row["volume"],
        "providerItemId": row["providerItemId"],
        "title": row["title"],
        "author": row["author"],
        "publisher": row["publisher"],
        "isbn13": row["isbn13"],
        "publicationDate": row["publicationDate"],
        "itemUrl": row["itemUrl"],
        "data": row.get("data").cloned().unwrap_or_else(|| json!({ "id": row["providerItemId"] })),
    })
}

fn stored_sources(library: &Library, id: &str) -> BTreeMap<i64, Value> {
    let connection = library.connection().unwrap();
    let mut statement = connection
        .prepare(
            "SELECT volume_number, provider_item_id, title, author, publisher, isbn13,
                    publication_date, item_url, provider_data_json
             FROM collection_volume_sources
             WHERE collection_id = ?1 AND provider = 'kakao' ORDER BY volume_number",
        )
        .unwrap();
    statement
        .query_map([id], |row| {
            let volume: i64 = row.get(0)?;
            let data: String = row.get(8)?;
            Ok((
                volume,
                json!({
                    "volumeNumber": volume,
                    "providerItemId": row.get::<_, String>(1)?,
                    "title": row.get::<_, String>(2)?,
                    "author": row.get::<_, Option<String>>(3)?,
                    "publisher": row.get::<_, Option<String>>(4)?,
                    "isbn13": row.get::<_, Option<String>>(5)?,
                    "publicationDate": row.get::<_, Option<String>>(6)?,
                    "itemUrl": row.get::<_, Option<String>>(7)?,
                    "data": serde_json::from_str::<Value>(&data).unwrap(),
                }),
            ))
        })
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
}

/// `volume number -> sort_order` of the edition-0 slots.
fn stored_slots(library: &Library, id: &str) -> BTreeMap<i64, i64> {
    let connection = library.connection().unwrap();
    let mut statement = connection
        .prepare(
            "SELECT volume_number, sort_order FROM collection_volumes
             WHERE collection_id = ?1 AND edition_index = 0",
        )
        .unwrap();
    statement
        .query_map([id], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
}

fn stored_events(library: &Library, id: &str) -> Vec<Value> {
    let connection = library.connection().unwrap();
    let mut statement = connection
        .prepare(
            "SELECT event_kind, volume_number, previous_value, current_value, detected_at,
                    read_at, provider
             FROM release_watch_events WHERE collection_id = ?1 ORDER BY rowid",
        )
        .unwrap();
    statement
        .query_map([id], |row| {
            Ok(json!({
                "kind": row.get::<_, String>(0)?,
                "volumeNumber": row.get::<_, i64>(1)?,
                "previousValue": row.get::<_, Option<String>>(2)?,
                "currentValue": row.get::<_, Option<String>>(3)?,
                "detectedAt": row.get::<_, String>(4)?,
                "readAt": row.get::<_, Option<String>>(5)?,
                "provider": row.get::<_, String>(6)?,
            }))
        })
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
}

/// `(external_id, provider_config_json, provider_data_json, last_synced_at)` of the binding.
fn stored_binding(library: &Library, id: &str) -> (String, Value, Value, Option<String>) {
    library
        .connection()
        .unwrap()
        .query_row(
            "SELECT external_id, provider_config_json, provider_data_json, last_synced_at
             FROM collection_external_bindings WHERE collection_id = ?1 AND provider = 'kakao'",
            [id],
            |row| {
                let config: String = row.get(1)?;
                let data: String = row.get(2)?;
                Ok((
                    row.get(0)?,
                    serde_json::from_str(&config).unwrap(),
                    serde_json::from_str(&data).unwrap(),
                    row.get(3)?,
                ))
            },
        )
        .unwrap()
}

/// `None` without a subscription, else its `last_checked_at`.
fn subscription(library: &Library, id: &str) -> Option<Option<String>> {
    let connection = library.connection().unwrap();
    let mut statement = connection
        .prepare(
            "SELECT last_checked_at FROM release_watch_subscriptions
             WHERE collection_id = ?1 AND provider = 'kakao'",
        )
        .unwrap();
    let rows: Vec<Option<String>> = statement
        .query_map([id], |row| row.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    rows.into_iter().next()
}

fn run_case(case: &Value) {
    let name = case["name"].as_str().unwrap();
    let temp = tempfile::tempdir().unwrap();
    let library = Library::open(temp.path()).unwrap();
    let id = library
        .create_collection(CreateCollection {
            name: "던전밥".into(),
            description: None,
            collection_type: CollectionType::Manga,
        })
        .unwrap()
        .id;
    library
        .upsert_collection_external_binding(
            &id,
            ExternalBindingInput {
                provider: "kakao".into(),
                external_id: case["binding"]["externalId"].as_str().unwrap().into(),
                provider_config_json: Some(case["binding"]["config"].to_string()),
                provider_data_json: Some("{}".into()),
                last_synced_at: None,
            },
        )
        .unwrap();
    let mut seeded: BTreeMap<i64, Value> = BTreeMap::new();
    {
        let connection = library.connection().unwrap();
        for row in case["existingSources"].as_array().unwrap() {
            let source = source_json(row);
            connection
                .execute(
                    "INSERT INTO collection_volume_sources (
                        collection_id, volume_number, provider, provider_item_id, title, author,
                        publisher, isbn13, publication_date, item_url, provider_data_json,
                        created_at, updated_at
                     ) VALUES (?1, ?2, 'kakao', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 't', 't')",
                    rusqlite::params![
                        id,
                        row["volume"].as_i64().unwrap(),
                        row["providerItemId"].as_str().unwrap(),
                        row["title"].as_str().unwrap(),
                        text(&row["author"]),
                        text(&row["publisher"]),
                        text(&row["isbn13"]),
                        text(&row["publicationDate"]),
                        text(&row["itemUrl"]),
                        source["data"].to_string(),
                    ],
                )
                .unwrap();
            seeded.insert(row["volume"].as_i64().unwrap(), source);
        }
        for slot in case["existingSlots"].as_array().unwrap() {
            let volume = slot.as_i64().unwrap();
            connection
                .execute(
                    "INSERT INTO collection_volumes (
                        id, collection_id, volume_number, edition_index, sort_order,
                        created_at, updated_at
                     ) VALUES (?1, ?2, ?3, 0, ?3, 't', 't')",
                    rusqlite::params![format!("slot-{volume}"), id, volume],
                )
                .unwrap();
        }
    }
    let gating = &case["gating"];
    if gating["tracksOwnership"].as_bool().unwrap() {
        library.set_owned_volume_count(&id, 0, 0).unwrap();
    }
    let (min, max) = (gating["minVolume"].as_i64(), gating["maxVolume"].as_i64());
    if min.is_some() || max.is_some() {
        library
            .set_collection_volume_range(&id, min, max, false)
            .unwrap();
    }
    let watched = gating["releaseWatch"].as_bool().unwrap();
    if watched {
        library.set_release_watch_enabled(&id, true).unwrap();
        library
            .connection()
            .unwrap()
            .execute(
                "UPDATE release_watch_subscriptions SET last_checked_at = ?2
                 WHERE collection_id = ?1",
                rusqlite::params![id, text(&case["previousCheckedAt"])],
            )
            .unwrap();
    }
    let seeded_slots = stored_slots(&library, &id);
    let expected = &case["expected"];
    let checked_at = case["checkedAt"].as_str().unwrap();
    let items = case["products"]
        .as_array()
        .unwrap()
        .iter()
        .map(item)
        .collect();

    let outcome = library
        .book_flow()
        .refresh_aladin_items_at(&id, items, checked_at);

    if expected["error"] == json!("ambiguousBinding") {
        assert!(
            matches!(outcome, Err(LibraryError::AmbiguousAladinBinding)),
            "{name}: expected AmbiguousAladinBinding"
        );
        let (external, config, _, synced) = stored_binding(&library, &id);
        assert_eq!(
            external,
            case["binding"]["externalId"].as_str().unwrap(),
            "{name}"
        );
        assert_eq!(
            config, case["binding"]["config"],
            "{name}: config untouched"
        );
        assert_eq!(synced, None, "{name}");
        assert_eq!(
            stored_sources(&library, &id),
            seeded,
            "{name}: sources untouched"
        );
        assert_eq!(
            stored_slots(&library, &id),
            seeded_slots,
            "{name}: slots untouched"
        );
        assert!(stored_events(&library, &id).is_empty(), "{name}");
        return;
    }
    assert_eq!(expected["error"], Value::Null, "{name}");
    let outcome = outcome.unwrap_or_else(|error| panic!("{name}: refresh failed: {error:?}"));

    let (external, config, snapshot, synced) = stored_binding(&library, &id);
    assert_eq!(
        json!(external),
        expected["externalId"],
        "{name}: externalId"
    );
    assert_eq!(config, expected["config"], "{name}: config");
    assert_eq!(snapshot, expected["snapshot"], "{name}: snapshot");
    assert_eq!(
        synced.as_deref(),
        Some(checked_at),
        "{name}: last_synced_at"
    );

    // Rows of volumes the search no longer offers are kept as they were.
    let mut sources = seeded;
    for row in expected["sources"].as_array().unwrap() {
        // The fixture omits `data` unless it matters: then it is `{"id": providerItemId}`.
        let mut row = row.clone();
        if row.get("data").is_none() {
            row["data"] = json!({ "id": row["providerItemId"] });
        }
        sources.insert(row["volumeNumber"].as_i64().unwrap(), row);
    }
    assert_eq!(stored_sources(&library, &id), sources, "{name}: sources");

    let mut slots = seeded_slots;
    for volume in expected["newSlots"].as_array().unwrap() {
        let volume = volume.as_i64().unwrap();
        slots.insert(volume, volume);
    }
    assert_eq!(stored_slots(&library, &id), slots, "{name}: slots");

    let events: Vec<Value> = expected["events"]
        .as_array()
        .unwrap()
        .iter()
        .map(|event| {
            let mut stored = event.clone();
            stored["detectedAt"] = json!(checked_at);
            stored["readAt"] = Value::Null;
            stored["provider"] = json!("kakao");
            stored
        })
        .collect();
    assert_eq!(stored_events(&library, &id), events, "{name}: events");
    assert_eq!(outcome.release_event_count, events.len() as u64, "{name}");

    assert_eq!(
        serde_json::to_value(&outcome.sync_result).unwrap(),
        expected["result"],
        "{name}: result"
    );
    assert_eq!(
        subscription(&library, &id),
        watched.then(|| Some(checked_at.to_owned())),
        "{name}: subscription"
    );
}

#[test]
fn kakao_refresh_matches_the_shared_fixture() {
    let fixture: Value = serde_json::from_str(include_str!("fixtures/kakao_refresh.json")).unwrap();
    let cases = fixture["cases"].as_array().unwrap();
    assert!(!cases.is_empty());
    // Run every case so one disagreement does not hide the others.
    let failed: Vec<&str> = cases
        .iter()
        .filter(|case| {
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| run_case(case))).is_err()
        })
        .map(|case| case["name"].as_str().unwrap())
        .collect();
    assert!(
        failed.is_empty(),
        "cases that disagree with the PC: {failed:?}"
    );
}
