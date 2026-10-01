//! Replica features (`workRecord`, `coverFocus`, `people`): sent only when advertised.
use super::*;
use crate::cloud::client::CollectionsStatus;
use serde_json::{json, Value};

const ALL: ReplicaFeatures = ReplicaFeatures {
    av: true,
    work_record: true,
    cover_focus: true,
    people: true,
};
const AV_ONLY: ReplicaFeatures = ReplicaFeatures {
    av: true,
    work_record: false,
    cover_focus: false,
    people: false,
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
            json!({"collectionTypes": ["av"], "replicaFeatures": ["workRecord", "coverFocus", "people"]}),
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
