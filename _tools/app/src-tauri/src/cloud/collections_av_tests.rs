use super::*;
use serde_json::{json, Value};

fn fixture() -> (tempfile::TempDir, Library) {
    let temp = tempfile::tempdir().unwrap();
    let library = Library::open(temp.path()).unwrap();
    library.connection().unwrap().execute_batch(
        "INSERT INTO collections(id,name,type,created_at,updated_at) VALUES
         ('av','AV work','av','2026','2026'), ('source','Source','av','2025','2025'),
         ('manga','Manga','manga','2026','2026');
         INSERT INTO collection_av_details(collection_id,product_code,title_ja,maker,label,series,genres_json,release_date)
         VALUES('av','TEST-001','作品','Maker','Label','Series','[\"Genre\"]','2024-02-29');
         INSERT INTO collection_people(id,display_name,name_ja,memo,created_at,updated_at) VALUES
         ('person','Performer','出演者','private memo','2026','2026'),
         ('director','Director',NULL,NULL,'2026','2026');
         INSERT INTO collection_person_relations(collection_id,person_id,role,sort_order) VALUES
         ('av','person','performer',0),('av','director','director',1);",
    ).unwrap();
    (temp, library)
}

fn artwork(library: &Library, id: &str, owner: &str, kind: &str, selected: bool) {
    library.connection().unwrap().execute(
        "INSERT INTO collection_work_artworks(id,collection_id,provider,provider_image_id,kind,relative_path,mime_type,width,height,selected,created_at,updated_at)
         VALUES(?1,?2,'local-manual',?1,?3,?4,'image/png',10,20,?5,'2026','2026')",
        rusqlite::params![id,owner,kind,format!("{id}.png"),selected],
    ).unwrap();
    std::fs::write(
        library.root().join(format!("{id}.png")),
        b"\x89PNG\r\n\x1a\nfixture",
    )
    .unwrap();
}

fn crop(library: &Library, id: &str) {
    library.connection().unwrap().execute(
        "INSERT OR REPLACE INTO collection_person_portraits(person_id,kind,artwork_id,x,y,w,h,updated_at)
         VALUES('person','crop',?1,0.1,0.2,0.3,0.4,'2026')", [id],
    ).unwrap();
}

fn snapshot(library: &Library) -> Snapshot {
    library
        .cloud_collections_snapshot_with_feature(None, None, true, &|_| {})
        .unwrap()
}

fn av_row(snapshot: &Snapshot) -> Value {
    serde_json::to_value(
        snapshot
            .replica
            .collections
            .iter()
            .find(|c| c.summary.id == "av")
            .unwrap(),
    )
    .unwrap()
}

#[test]
fn av_payload_matches_server_shape_and_publishes_all_three_surfaces() {
    let (_temp, library) = fixture();
    for (id, kind) in [("front", "cover"), ("spine", "spine"), ("back", "back")] {
        artwork(&library, id, "av", kind, true);
    }
    crop(&library, "front");
    let snapshot = snapshot(&library);
    let row = av_row(&snapshot);
    assert_eq!(row["type"], "av");
    assert_eq!(
        row["av"],
        json!({
            "productCode":"TEST-001", "titleJa":"作品", "maker":"Maker", "label":"Label",
            "series":"Series", "genres":["Genre"], "releaseDate":"2024-02-29",
            "people":[
                {"id":"person", "name":"Performer", "nameJa":"出演者", "role":"performer", "order":0,
                 "portraitCrop":{"artworkId":"front", "x":0.1,"y":0.2,"w":0.3,"h":0.4}},
                {"id":"director", "name":"Director", "nameJa":null, "role":"director", "order":1,"portraitCrop":null}
            ]
        })
    );
    let arts = row["artworks"].as_array().unwrap();
    assert_eq!(arts.len(), 3);
    for kind in ["cover", "spine", "back"] {
        let art = arts.iter().find(|a| a["kind"] == kind).unwrap();
        let hash = art["original"]["sha256"].as_str().unwrap();
        assert!(snapshot.files.contains_key(hash));
    }
    assert!(!row.to_string().contains("private memo"));
    let manga = snapshot
        .replica
        .collections
        .iter()
        .find(|c| c.summary.id == "manga")
        .unwrap();
    assert!(serde_json::to_value(manga).unwrap().get("av").is_none());
}

#[test]
fn crop_requires_selected_av_cover_bytes_in_the_complete_snapshot() {
    let (_temp, library) = fixture();
    // Source is ordered after the target: the crop must resolve across collections.
    artwork(&library, "source-cover", "source", "cover", true);
    crop(&library, "source-cover");
    assert_eq!(
        av_row(&snapshot(&library))["av"]["people"][0]["portraitCrop"]["artworkId"],
        "source-cover"
    );
    for change in [
        "UPDATE collection_work_artworks SET selected=0 WHERE id='source-cover'",
        "UPDATE collection_work_artworks SET selected=1, kind='spine' WHERE id='source-cover'",
        "UPDATE collection_work_artworks SET kind='cover'; UPDATE collections SET type='movie' WHERE id='source'",
        "UPDATE collections SET type='av', legacy_kind='gacha' WHERE id='source'",
        "UPDATE collections SET legacy_kind=NULL WHERE id='source'; UPDATE collection_work_artworks SET relative_path='missing.png'",
    ] {
        library.connection().unwrap().execute_batch(change).unwrap();
        assert!(av_row(&snapshot(&library))["av"]["people"][0]["portraitCrop"].is_null(), "{change}");
    }
    // A published thumbnail alone is sufficient; the original may be unavailable.
    let thumbs = library.root().join("work-artwork-thumbnails/source");
    std::fs::create_dir_all(&thumbs).unwrap();
    std::fs::write(
        thumbs.join("source-cover.webp"),
        b"\x89PNG\r\n\x1a\nfixture",
    )
    .unwrap();
    assert!(av_row(&snapshot(&library))["av"]["people"][0]["portraitCrop"].is_object());
}

#[test]
fn av_stashdb_profiles_and_portraits_stay_private() {
    let (_temp, library) = fixture();
    library.connection().unwrap().execute_batch(
        "INSERT INTO collection_person_profiles(person_id,source,status,name,fetched_at)
         VALUES('person','stashdb','none','Private profile marker','t');
         INSERT INTO collection_person_portraits(person_id,kind,image_bytes,mime,width,height,file_name,source_url,updated_at)
         VALUES('person','stashdb',X'010203','image/jpeg',10,20,'secret.jpg','https://stashdb.org/images/private','t');"
    ).unwrap();
    let result = snapshot(&library);
    assert!(av_row(&result)["av"]["people"][0]["portraitCrop"].is_null());
    assert!(result.files.is_empty());
    let text = serde_json::to_string(&result.replica).unwrap();
    assert!(!text.contains("Private profile marker"));
    assert!(!text.contains("stashdb.org"));
}

#[test]
fn commons_portraits_stay_private_and_missing_details_are_optional() {
    let (_temp, library) = fixture();
    library.connection().unwrap().execute_batch(
        "INSERT INTO collection_person_portraits(person_id,kind,image_bytes,mime,width,height,file_name,source_url,updated_at)
         VALUES('person','commons',X'010203','image/png',10,20,'secret.png','https://private.example','2026')",
    ).unwrap();
    let result = snapshot(&library);
    let row = av_row(&result);
    assert!(row["av"]["people"][0]["portraitCrop"].is_null());
    assert!(result.files.is_empty());
    assert!(!serde_json::to_string(&result.replica)
        .unwrap()
        .contains("private.example"));
    let source = result
        .replica
        .collections
        .iter()
        .find(|c| c.summary.id == "source")
        .unwrap();
    assert_eq!(
        serde_json::to_value(source).unwrap()["av"],
        json!({
            "productCode":null,"titleJa":null,"maker":null,"label":null,"series":null,
            "releaseDate":null,"genres":[],"people":[]
        })
    );
}

#[test]
fn authenticated_status_gates_av_independently_of_personal_edit_handshake() {
    use crate::library::collection_personal_edits::tests::{configure, scripted};
    for (status, expected) in [
        (json!({}), false),
        (json!({"collectionTypes":["game","manga","movie"]}), false),
        (
            json!({"collectionTypes":["game","manga","movie","av"]}),
            true,
        ),
    ] {
        let (_temp, library) = fixture();
        let (base, handle) = scripted(vec![
            ("/v1/collections/status", 200, status.to_string()),
            (
                "/v1/collections?limit=1",
                200,
                json!({"revision":"r1"}).to_string(),
            ),
            (
                "/v1/collections/replica",
                200,
                json!({"revision":"r2"}).to_string(),
            ),
        ]);
        configure(&library, &base);
        library
            .push_cloud_collections_with(
                &CloudClient::new(&base).unwrap(),
                &base,
                "shared",
                None,
                &|_| {},
            )
            .unwrap();
        let seen = handle.join().unwrap();
        assert_eq!(seen[0].1.as_deref(), Some("Bearer shared"));
        let body: Value = serde_json::from_str(&seen[2].2).unwrap();
        assert!(body.get("personalEditVersion").is_none());
        assert_eq!(
            body["collections"]
                .as_array()
                .unwrap()
                .iter()
                .any(|c| c["type"] == "av"),
            expected
        );
    }
}

#[test]
fn av_never_gets_manga_tracking_payloads_or_release_board_entries() {
    let (_temp, library) = fixture();
    let endpoint = "https://sync.example.test";
    let library_id = library.library_id().unwrap();
    library
        .adopt_collection_personal_edit_library(endpoint, &library_id)
        .unwrap();
    let feature = PersonalEditFeature {
        endpoint: endpoint.into(),
        library_id,
        edit_version: 2,
    };
    let result = library
        .cloud_collections_snapshot_with_feature(None, Some(&feature), true, &|_| {})
        .unwrap();
    let row = av_row(&result);
    for field in ["releaseWatch", "ownedVolumes", "releaseSchedule"] {
        assert!(row.get(field).is_none());
    }
    let board = release_board(&library.connection().unwrap()).unwrap();
    assert!(!serde_json::to_string(&board).unwrap().contains("\"av\""));
}

#[test]
fn decoded_status_capability_controls_snapshot_rows_without_a_personal_edit_handshake() {
    use crate::cloud::client::CollectionsStatus;
    let (_temp, library) = fixture();
    for (raw, expected) in [
        (json!({}), false),
        (json!({"collectionTypes":[]}), false),
        (json!({"collectionTypes":["game","manga","movie"]}), false),
        (
            json!({"capabilities":{"collectionPersonalEdit":true,"collectionTrackingEdit":true}}),
            false,
        ),
        (json!({"collectionTypes":["av"]}), true),
        (
            json!({"collectionTypes":["game","av"],"capabilities":{"collectionPersonalEdit":false}}),
            true,
        ),
    ] {
        let status: CollectionsStatus = serde_json::from_value(raw).unwrap();
        let result = library
            .cloud_collections_snapshot_with_feature(
                None,
                None,
                status.supports_av_collections(),
                &|_| {},
            )
            .unwrap();
        assert_eq!(
            result
                .replica
                .collections
                .iter()
                .any(|c| c.summary.collection_type == crate::library::models::CollectionType::Av),
            expected
        );
        assert!(result
            .replica
            .collections
            .iter()
            .any(|c| c.summary.id == "manga"));
    }
    // The client's 404 fallback uses Default, so a server without the route is safe too.
    assert!(!CollectionsStatus::default().supports_av_collections());
}
