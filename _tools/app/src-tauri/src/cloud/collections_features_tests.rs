//! Replica features (`workRecord`, `coverFocus`, `people`, `portraitImage`): sent only when
//! advertised.
use super::*;
use crate::cloud::client::CollectionsStatus;
use serde_json::{json, Value};

const ALL: ReplicaFeatures = ReplicaFeatures {
    av: true,
    work_record: true,
    cover_focus: true,
    people: true,
    portrait_image: true,
};
const AV_ONLY: ReplicaFeatures = ReplicaFeatures {
    av: true,
    work_record: false,
    cover_focus: false,
    people: false,
    portrait_image: false,
};

fn fixture() -> (tempfile::TempDir, Library) {
    let temp = tempfile::tempdir().unwrap();
    let library = Library::open(temp.path()).unwrap();
    library.connection().unwrap().execute_batch(
        "INSERT INTO collections(id,name,type,created_at,updated_at) VALUES
            ('g','Game','game','t','t'),('m','Manga','manga','t','t'),('mv','Movie','movie','t','t'),
            ('av','AV','av','t','t'),('av2','AV 2','av','t','t');
         INSERT INTO collection_work_artworks(id,collection_id,provider,provider_image_id,kind,relative_path,mime_type,width,height,selected,created_at,updated_at) VALUES
            ('art','m','local','art','volume_cover','missing-art.png','image/png',4,6,0,'t','t'),
            ('art2','m','local','art2','volume_cover','missing-art2.png','image/png',4,6,0,'t','t'),
            ('front','av','local','front','cover','missing-front.png','image/png',4,6,1,'t','t');
         INSERT INTO collection_volumes(id,collection_id,volume_number,edition_index,sort_order,cover_artwork_id,created_at,updated_at) VALUES
            ('v','m',1,0,1,'art','t','t'),('w','m',2,0,2,'art2','t','t'),('x','m',3,0,3,'art','t','t');
         INSERT INTO collection_volume_cover_focus(volume_id,cover_artwork_id,focus_x,method) VALUES
            ('v','art',0.25,'head'),('w','art',0.5,'head'),('x','art',NULL,'none');
         INSERT INTO collection_pc_records(collection_id,status,owned_platform) VALUES
            ('g','playing','PS5'),('m','collecting',NULL),('mv','bogus',NULL),('av','watched','Shelf');
         INSERT INTO collection_people(id,display_name,memo,created_at,updated_at) VALUES
            ('p','Performer','memo','t','t'),('q','Quiet',NULL,'t','t'),('n','No profile',NULL,'t','t'),
            ('u','Unrelated','private','t','t');
         INSERT INTO collection_person_relations(collection_id,person_id,role,sort_order) VALUES
            ('av','p','performer',0),('av','q','performer',1),('av2','n','performer',0);
         INSERT INTO av_favorite_performers(person_id,created_at) VALUES('p','t'),('u','t');
         INSERT INTO collection_person_profiles(person_id,source,status,stashdb_id,name,aliases_json,birth_date,height_cm,band_in,waist_in,hip_in,cup,breast_type,career_start,career_end,urls_json,images_json,candidates_json,fetched_at) VALUES
            ('p','stashdb','matched','stash-p','Stash Name','[\"A1\",\"A2\"]','1999-01-02',160,32,24,34,'C','NATURAL',2018,2022,
             '[{\"url\":\"https://x.test/p\",\"site\":{\"name\":\"Twitter\"}},{\"bad\":1}]',
             '[{\"id\":\"i\",\"url\":\"https://img.test/secret.jpg\",\"width\":1,\"height\":1}]',
             '[{\"stashdbId\":\"c\",\"name\":\"Cand\",\"aliases\":[],\"birthDate\":null,\"imageUrl\":\"https://img.test/cand.jpg\"}]','t'),
            ('n','stashdb','none',NULL,NULL,'[]',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'[]','[]','[]','t');
         INSERT INTO collection_person_portraits(person_id,kind,image_bytes,mime,width,height,file_name,author,license,license_url,source_url,updated_at) VALUES
            ('p','commons',X'89504E47DEADBEEF','image/png',1,1,'p.png','Author','CC BY 4.0','https://license.test','https://commons.test/p','t');
         INSERT INTO collection_person_portraits(person_id,kind,artwork_id,x,y,w,h,updated_at) VALUES('n','crop','front',0.1,0.1,0.5,0.5,'t');",
    ).unwrap();
    (temp, library)
}

fn body(library: &Library, features: ReplicaFeatures) -> String {
    let snapshot = library
        .cloud_collections_snapshot_with_features(None, None, features, &|_| {})
        .unwrap();
    serde_json::to_string(&snapshot.replica).unwrap()
}

fn item(value: &Value, id: &str) -> Value {
    value["collections"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["id"] == id)
        .unwrap()
        .clone()
}

#[test]
fn replica_features_follow_the_status_advertisement() {
    for (raw, expected) in [
        (json!({"revision": "r"}), ReplicaFeatures::default()),
        (
            json!({"collectionTypes": ["av"], "replicaFeatures": []}),
            AV_ONLY,
        ),
        (
            json!({"replicaFeatures": ["workRecord", "people", "unknownLater"]}),
            ReplicaFeatures {
                work_record: true,
                people: true,
                ..ReplicaFeatures::default()
            },
        ),
        (
            json!({"collectionTypes": ["av"], "replicaFeatures": ["workRecord", "coverFocus", "people", "portraitImage"]}),
            ALL,
        ),
    ] {
        let status: CollectionsStatus = serde_json::from_value(raw.clone()).unwrap();
        assert_eq!(ReplicaFeatures::from_status(&status), expected, "{raw}");
    }
    assert_eq!(
        ReplicaFeatures::from_status(&CollectionsStatus::default()),
        ReplicaFeatures::default()
    );
}

#[test]
fn without_features_the_payload_is_byte_identical_to_one_without_pc_data() {
    let (_temp, library) = fixture();
    let with_data = body(&library, AV_ONLY);
    let value: Value = serde_json::from_str(&with_data).unwrap();
    assert!(value.get("people").is_none());
    for collection in value["collections"].as_array().unwrap() {
        assert!(collection.get("status").is_none() && collection.get("ownedPlatform").is_none());
        for volume in collection["volumes"].as_array().unwrap() {
            assert!(volume.get("coverFocusX").is_none());
        }
    }
    library
        .connection()
        .unwrap()
        .execute_batch(
            "DELETE FROM collection_pc_records; DELETE FROM collection_volume_cover_focus;
         DELETE FROM av_favorite_performers; DELETE FROM collection_person_profiles;
         DELETE FROM collection_person_portraits; UPDATE collection_people SET memo=NULL;",
        )
        .unwrap();
    assert_eq!(body(&library, AV_ONLY), with_data);
    // The volume wrapper serializes exactly as the PC volume did before it existed.
    let volume = CollectionVolume {
        id: "v".into(),
        volume_number: 1,
        edition_index: 0,
        display_label: "1".into(),
        cover_artwork_id: Some("art".into()),
        local_release_date: None,
        isbn13: None,
        contents: None,
        price: None,
        publisher: None,
        release_status: None,
    };
    assert_eq!(
        serde_json::to_string(&ReplicaVolume {
            volume: volume.clone(),
            cover_focus_x: None
        })
        .unwrap(),
        serde_json::to_string(&volume).unwrap()
    );
}

#[test]
fn work_record_publishes_valid_status_and_game_platform_only() {
    let (_temp, library) = fixture();
    let value: Value = serde_json::from_str(&body(
        &library,
        ReplicaFeatures {
            work_record: true,
            ..AV_ONLY
        },
    ))
    .unwrap();
    let fields = |id: &str| {
        let item = item(&value, id);
        (
            item.get("status").cloned(),
            item.get("ownedPlatform").cloned(),
        )
    };
    assert_eq!(fields("g"), (Some(json!("playing")), Some(json!("PS5"))));
    assert_eq!(fields("m"), (Some(json!("collecting")), None));
    // Not in the movie list: omitted rather than rejected by the server.
    assert_eq!(fields("mv"), (None, None));
    // Platforms belong to games only.
    assert_eq!(fields("av"), (Some(json!("watched")), None));
    assert_eq!(fields("av2"), (None, None));
    assert!(value.get("people").is_none());
    assert!(item(&value, "m")["volumes"]
        .as_array()
        .unwrap()
        .iter()
        .all(|v| v.get("coverFocusX").is_none()));
}

#[test]
fn cover_focus_applies_only_to_the_cover_it_was_measured_on() {
    let (_temp, library) = fixture();
    let value: Value = serde_json::from_str(&body(
        &library,
        ReplicaFeatures {
            cover_focus: true,
            ..AV_ONLY
        },
    ))
    .unwrap();
    let manga = item(&value, "m");
    let focus: Vec<_> = manga["volumes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| {
            (
                v["id"].as_str().unwrap().to_owned(),
                v.get("coverFocusX").cloned(),
            )
        })
        .collect();
    // v: measured on its cover. w: measured on a cover it no longer shows. x: method none.
    assert_eq!(
        focus,
        vec![
            ("v".into(), Some(json!(0.25))),
            ("w".into(), None),
            ("x".into(), None)
        ]
    );
    assert!(manga.get("status").is_none());
    // A changed cover drops the stale focus until it is measured again.
    library
        .connection()
        .unwrap()
        .execute(
            "UPDATE collection_volumes SET cover_artwork_id='art2' WHERE id='v'",
            [],
        )
        .unwrap();
    let value: Value = serde_json::from_str(&body(
        &library,
        ReplicaFeatures {
            cover_focus: true,
            ..AV_ONLY
        },
    ))
    .unwrap();
    assert!(item(&value, "m")["volumes"]
        .as_array()
        .unwrap()
        .iter()
        .all(|v| v.get("coverFocusX").is_none()));
}

#[test]
fn people_are_the_performers_of_published_av_works_in_the_contract_shape() {
    let (_temp, library) = fixture();
    let encoded = body(
        &library,
        ReplicaFeatures {
            people: true,
            ..AV_ONLY
        },
    );
    let value: Value = serde_json::from_str(&encoded).unwrap();
    assert_eq!(
        value["people"],
        json!([
            {"id": "p", "memo": "memo", "favorite": true,
             "profile": {"source": "stashdb", "name": "Stash Name", "aliases": ["A1", "A2"], "birthDate": "1999-01-02",
                         "heightCm": 160, "bandIn": 32, "waistIn": 24, "hipIn": 34, "cup": "C", "breastType": "NATURAL",
                         "careerStart": 2018, "careerEnd": 2022, "urls": [{"site": "Twitter", "url": "https://x.test/p"}]},
             "portrait": {"source": "commons", "author": "Author", "license": "CC BY 4.0",
                          "licenseUrl": "https://license.test", "sourceUrl": "https://commons.test/p"}},
            // An unmatched profile is not published; a crop portrait is labelled as the cover.
            {"id": "n", "memo": null, "favorite": false, "profile": null,
             "portrait": {"source": "cover", "author": null, "license": null, "licenseUrl": null, "sourceUrl": null}},
            {"id": "q", "memo": null, "favorite": false, "profile": null, "portrait": null},
        ])
    );
    for secret in [
        "secret.jpg",
        "cand.jpg",
        "images",
        "candidates",
        "stash-p",
        "stashdbId",
        "p.png",
        "private",
        "\"u\"",
    ] {
        assert!(!encoded.contains(secret), "{secret}");
    }
    // Without published AV works there are no related people.
    let value: Value = serde_json::from_str(&body(
        &library,
        ReplicaFeatures {
            people: true,
            ..ReplicaFeatures::default()
        },
    ))
    .unwrap();
    assert_eq!(value["people"], json!([]));
}

#[test]
fn people_are_capped_with_favourites_and_recorded_people_first() {
    let temp = tempfile::tempdir().unwrap();
    let library = Library::open(temp.path()).unwrap();
    // 33 AV works x 64 performers = 2112 related people (64 is the per-work bound).
    library.connection().unwrap().execute_batch(
        "WITH RECURSIVE w(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM w WHERE i<32)
         INSERT INTO collections(id,name,type,created_at,updated_at) SELECT printf('cap-%02d',i),printf('Work %02d',i),'av','t','t' FROM w;
         WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<2111)
         INSERT INTO collection_people(id,display_name,created_at,updated_at) SELECT printf('person-%04d',i),'P','t','t' FROM n;
         WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<2111)
         INSERT INTO collection_person_relations(collection_id,person_id,role,sort_order)
         SELECT printf('cap-%02d',i/64),printf('person-%04d',i),'performer',i%64 FROM n;
         INSERT INTO av_favorite_performers(person_id,created_at) VALUES('person-2111','t');
         UPDATE collection_people SET memo='kept' WHERE id='person-2110';",
    ).unwrap();
    let value: Value = serde_json::from_str(&body(
        &library,
        ReplicaFeatures {
            people: true,
            ..AV_ONLY
        },
    ))
    .unwrap();
    let ids: Vec<_> = value["people"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["id"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(ids.len(), 2000);
    assert_eq!(&ids[..3], ["person-2111", "person-2110", "person-0000"]);
    assert_eq!(ids.last().unwrap(), "person-1997");
}

#[test]
fn publication_sends_new_fields_only_to_a_server_that_advertises_them() {
    use crate::library::collection_personal_edits::tests::{configure, scripted};
    let push = |status: Value| {
        let (_temp, library) = fixture();
        let (base, handle) = scripted(vec![
            ("/v1/collections/status", 200, status.to_string()),
            (
                "/v1/collections?limit=1",
                200,
                json!({"revision": "r1"}).to_string(),
            ),
            (
                "/v1/collections/replica",
                200,
                json!({"revision": "r2"}).to_string(),
            ),
        ]);
        configure(&library, &base);
        let client = CloudClient::new(&base).unwrap();
        library
            .push_cloud_collections_with(&client, &base, "shared", None, &|_| {})
            .unwrap();
        let sent = handle.join().unwrap().remove(2).2;
        let expected = library
            .cloud_collections_snapshot_with_features(Some("r1".into()), None, AV_ONLY, &|_| {})
            .unwrap();
        (sent, serde_json::to_string(&expected.replica).unwrap())
    };
    // An older server: exactly the body it accepted before these features existed.
    let (sent, old_body) =
        push(json!({"revision": "r1", "collectionTypes": ["game", "manga", "movie", "av"]}));
    assert_eq!(sent, old_body);
    let (sent, old_body) = push(
        json!({"revision": "r1", "collectionTypes": ["game", "manga", "movie", "av"],
        "replicaFeatures": ["workRecord", "coverFocus", "people"]}),
    );
    assert_ne!(sent, old_body);
    let value: Value = serde_json::from_str(&sent).unwrap();
    assert_eq!(value["version"], 1);
    assert_eq!(item(&value, "g")["ownedPlatform"], "PS5");
    assert_eq!(item(&value, "m")["volumes"][0]["coverFocusX"], 0.25);
    assert_eq!(value["people"].as_array().unwrap().len(), 3);
}

const PORTRAIT: ReplicaFeatures = ReplicaFeatures {
    portrait_image: true,
    ..AV_ONLY
};

fn png(width: u32, height: u32, shade: u8) -> Vec<u8> {
    let mut bytes = std::io::Cursor::new(Vec::new());
    image::RgbImage::from_pixel(width, height, image::Rgb([shade, 20, 30]))
        .write_to(&mut bytes, image::ImageFormat::Png)
        .unwrap();
    bytes.into_inner()
}

fn store_portrait(library: &Library, bytes: &[u8]) {
    library
        .connection()
        .unwrap()
        .execute(
            "UPDATE collection_person_portraits SET image_bytes=?1,width=3,height=2 WHERE person_id='p'",
            [bytes],
        )
        .unwrap();
}

fn av_people(value: &Value, id: &str) -> Vec<Value> {
    item(value, id)["av"]["people"].as_array().unwrap().clone()
}

/// Performer `p` (Commons portrait) appears in both AV works.
fn portrait_fixture() -> (tempfile::TempDir, Library, Vec<u8>) {
    let (temp, library) = fixture();
    library
        .connection()
        .unwrap()
        .execute_batch("INSERT INTO collection_person_relations(collection_id,person_id,role,sort_order) VALUES('av2','p','performer',1)")
        .unwrap();
    let bytes = png(3, 2, 200);
    store_portrait(&library, &bytes);
    (temp, library, bytes)
}

#[test]
fn portrait_image_is_the_stored_bytes_descriptor_once_per_person() {
    let (_temp, library, bytes) = portrait_fixture();
    let snapshot = library
        .cloud_collections_snapshot_with_features(None, None, PORTRAIT, &|_| {})
        .unwrap();
    let value = serde_json::to_value(&snapshot.replica).unwrap();
    let blob = blob_for(&bytes).unwrap();
    let expected = json!({"sha256": blob.sha256, "sizeBytes": bytes.len(), "contentType": "image/png", "width": 3, "height": 2});
    for work in ["av", "av2"] {
        let p = av_people(&value, work)
            .into_iter()
            .find(|person| person["id"] == "p")
            .unwrap();
        assert_eq!(p["portraitImage"], expected, "{work}");
    }
    // One upload for the person, read back from the library at upload time.
    assert_eq!(snapshot.files.len(), 1);
    let local = &snapshot.files[&blob.sha256];
    assert_eq!(local.descriptor, blob);
    assert!(matches!(&local.source, BlobSource::Portrait { person_id, .. } if person_id == "p"));
    // Crops and people without an image are exactly what the feature-less body carries.
    let plain = serde_json::to_value(
        &library
            .cloud_collections_snapshot_with_features(None, None, AV_ONLY, &|_| {})
            .unwrap()
            .replica,
    )
    .unwrap();
    for work in ["av", "av2"] {
        let mut people = av_people(&value, work);
        for person in &mut people {
            assert!(person["id"] == "p" || person.get("portraitImage").is_none());
            person.as_object_mut().unwrap().remove("portraitImage");
        }
        assert_eq!(people, av_people(&plain, work), "{work}");
    }
    assert!(av_people(&value, "av2")
        .iter()
        .any(|person| person["id"] == "n" && person.get("portraitCrop").is_some()));
}

#[test]
fn oversized_or_unrecognised_portraits_are_omitted_without_failing() {
    let (_temp, library, _) = portrait_fixture();
    let mut oversized = png(3, 2, 1);
    oversized.resize(5 * 1024 * 1024 + 1, 0);
    let mut gif = b"GIF89a".to_vec();
    gif.extend([0; 32]);
    for bytes in [oversized, gif, b"not an image".to_vec()] {
        store_portrait(&library, &bytes);
        let snapshot = library
            .cloud_collections_snapshot_with_features(None, None, PORTRAIT, &|_| {})
            .unwrap();
        let value = serde_json::to_value(&snapshot.replica).unwrap();
        for work in ["av", "av2"] {
            assert!(av_people(&value, work)
                .iter()
                .all(|person| person.get("portraitImage").is_none()));
        }
        assert!(snapshot.files.is_empty());
    }
}

#[test]
fn without_the_feature_portraits_add_no_field_and_no_upload() {
    let (_temp, library, _) = portrait_fixture();
    let with_image = body(&library, AV_ONLY);
    store_portrait(&library, b"not an image");
    assert_eq!(body(&library, AV_ONLY), with_image);
    store_portrait(&library, &png(3, 2, 7));
    let snapshot = library
        .cloud_collections_snapshot_with_features(None, None, ALL, &|_| {})
        .unwrap();
    assert_eq!(snapshot.files.len(), 1);
    let without = library
        .cloud_collections_snapshot_with_features(
            None,
            None,
            ReplicaFeatures {
                portrait_image: false,
                ..ALL
            },
            &|_| {},
        )
        .unwrap();
    assert!(without.files.is_empty());
    assert!(!serde_json::to_string(&without.replica)
        .unwrap()
        .contains("portraitImage"));
}

#[test]
fn portrait_upload_rereads_the_library_and_refuses_changed_bytes() {
    let (_temp, library, bytes) = portrait_fixture();
    let snapshot = library
        .cloud_collections_snapshot_with_features(None, None, PORTRAIT, &|_| {})
        .unwrap();
    let local = snapshot.files.values().next().unwrap();
    let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
    let client = CloudClient::new(&format!("http://{}", server.server_addr())).unwrap();
    let expected = local.descriptor.clone();
    let worker = std::thread::spawn(move || {
        let mut request = server
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap()
            .unwrap();
        assert_eq!(request.url(), "/v1/collections/artworks/prepare");
        let body: Value = serde_json::from_reader(request.as_reader()).unwrap();
        assert_eq!(
            body,
            json!({"sha256": expected.sha256, "sizeBytes": expected.size_bytes, "contentType": "image/png"})
        );
        request
            .respond(tiny_http::Response::from_string(
                json!({"objectKey": expected.object_key, "uploadUrl": null, "requiredHeaders": {}})
                    .to_string(),
            ))
            .unwrap();
        // Nothing else: the changed portrait below never reaches the server.
        assert!(server
            .recv_timeout(std::time::Duration::from_millis(300))
            .unwrap()
            .is_none());
    });
    assert!(!upload_local_blob(&client, "token", local).unwrap());
    assert_eq!(local.descriptor, blob_for(&bytes).unwrap());
    store_portrait(&library, &png(3, 2, 9));
    assert!(matches!(
        upload_local_blob(&client, "token", local),
        Err(LibraryError::InvalidWorkArtwork)
    ));
    library
        .connection()
        .unwrap()
        .execute(
            "DELETE FROM collection_person_portraits WHERE person_id='p'",
            [],
        )
        .unwrap();
    assert!(matches!(
        upload_local_blob(&client, "token", local),
        Err(LibraryError::InvalidWorkArtwork)
    ));
    worker.join().unwrap();
}

#[test]
fn an_advertising_server_receives_the_portrait_through_the_artwork_flow() {
    use crate::library::collection_personal_edits::tests::{configure, scripted};
    let (_temp, library, bytes) = portrait_fixture();
    let blob = blob_for(&bytes).unwrap();
    let (base, handle) = scripted(vec![
        (
            "/v1/collections/status",
            200,
            json!({"revision": "r1", "collectionTypes": ["game", "manga", "movie", "av"], "replicaFeatures": ["portraitImage"]}).to_string(),
        ),
        ("/v1/collections?limit=1", 200, json!({"revision": "r1"}).to_string()),
        ("/v1/collections/artworks/check", 200, json!({"missing": [blob.sha256]}).to_string()),
        (
            "/v1/collections/artworks/prepare",
            200,
            json!({"objectKey": blob.object_key, "uploadUrl": null, "requiredHeaders": {}}).to_string(),
        ),
        ("/v1/collections/replica", 200, json!({"revision": "r2"}).to_string()),
    ]);
    configure(&library, &base);
    let client = CloudClient::new(&base).unwrap();
    library
        .push_cloud_collections_with(&client, &base, "shared", None, &|_| {})
        .unwrap();
    let seen = handle.join().unwrap();
    let check: Value = serde_json::from_str(&seen[2].2).unwrap();
    assert_eq!(check["items"].as_array().unwrap().len(), 1);
    let sent: Value = serde_json::from_str(&seen[4].2).unwrap();
    assert_eq!(
        av_people(&sent, "av")
            .iter()
            .find(|person| person["id"] == "p")
            .unwrap()["portraitImage"]["sha256"],
        blob.sha256
    );
    assert!(sent.get("people").is_none());
}

/// The PC-built body with every feature, checked in at `tests/fixtures/collections-replica-pc.json`
/// and published through the server's real route by
/// `server/lakomics-api/tests/test_mobile_collections.py`, so a key the server's
/// `extra="forbid"` models reject cannot ship unnoticed. Regenerate the file with
/// `LAKOMICS_UPDATE_WIRE_FIXTURES=1` after an intended contract change.
#[test]
fn the_full_feature_body_is_the_server_cross_check_sample() {
    let (_temp, library, _) = portrait_fixture();
    // Desktop-only summary state (2026-10-01 production 422: `minVolume`, `maxVolume` and
    // `hideConnectionPrompt` were sent and the server rejected the whole snapshot).
    library
        .connection()
        .unwrap()
        .execute_batch(
            "INSERT INTO collection_volume_ranges(collection_id,min_volume,max_volume,hide_connection_prompt,updated_at)
             VALUES('m',1,2,1,'t');",
        )
        .unwrap();
    let value: Value = serde_json::from_str(&body(&library, ALL)).unwrap();
    let accepted: Vec<&str> = PUBLISHED_SUMMARY_KEYS
        .iter()
        .copied()
        .chain([
            "volumes",
            "series",
            "film",
            "av",
            "artworks",
            "releaseWatch",
            "ownedVolumes",
            "releaseSchedule",
            "status",
            "ownedPlatform",
        ])
        .collect();
    for collection in value["collections"].as_array().unwrap() {
        for key in collection.as_object().unwrap().keys() {
            assert!(
                accepted.contains(&key.as_str()),
                "{key} is not a replica field"
            );
        }
        for key in [
            "id",
            "name",
            "type",
            "createdAt",
            "updatedAt",
            "showcase",
            "assetCount",
        ] {
            assert!(
                collection.get(key).is_some(),
                "{key} must still be published"
            );
        }
    }
    // The range itself is applied to the published volumes.
    let volumes: Vec<_> = item(&value, "m")["volumes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v["id"].clone())
        .collect();
    assert_eq!(volumes, [json!("v"), json!("w")]);
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../tests/fixtures/collections-replica-pc.json");
    if std::env::var_os("LAKOMICS_UPDATE_WIRE_FIXTURES").is_some() {
        std::fs::write(&path, serde_json::to_string_pretty(&value).unwrap() + "\n").unwrap();
    }
    let sample: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(
        value,
        sample,
        "regenerate {} if this change is intended",
        path.display()
    );
}

#[test]
fn a_rejected_replica_is_reported_as_a_collection_publication_failure() {
    use crate::library::collection_personal_edits::tests::{configure, scripted};
    let (_temp, library) = fixture();
    let (base, handle) = scripted(vec![
        (
            "/v1/collections/status",
            200,
            json!({"revision": "r1"}).to_string(),
        ),
        (
            "/v1/collections?limit=1",
            200,
            json!({"revision": "r1"}).to_string(),
        ),
        (
            "/v1/collections/replica",
            422,
            json!({"detail": "Invalid collection snapshot"}).to_string(),
        ),
    ]);
    configure(&library, &base);
    let client = CloudClient::new(&base).unwrap();
    let error = library
        .push_cloud_collections_with(&client, &base, "shared", None, &|_| {})
        .unwrap_err();
    handle.join().unwrap();
    assert!(
        matches!(error, LibraryError::CloudCollectionsPublishRejected(422)),
        "{error:?}"
    );
    assert!(error.to_string().contains("모바일 컬렉션"), "{error}");
}
