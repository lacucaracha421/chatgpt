use std::{
    collections::HashMap,
    fs,
    sync::atomic::{AtomicUsize, Ordering},
    sync::Arc,
    thread,
    time::{Duration, Instant},
};

use super::*;
use crate::extension_api::{dispatch_with_picker, EXTENSION_ORIGIN};
use crate::library::models::{
    ClassificationKind, CreateClassification, EncryptedVaultItemKind, EncryptedVaultQuery,
};

const TOKEN: &str = "secret";
const BEARER: Option<&str> = Some("Bearer secret");
const OFF: Privacy = Privacy {
    privacy_mode: false,
    nsfw_filter: false,
};

fn folder(library: &Library, name: &str, parent: Option<&str>) -> String {
    library
        .create_classification(CreateClassification {
            kind: if parent.is_some() {
                ClassificationKind::Tag
            } else {
                ClassificationKind::Root
            },
            name: name.into(),
            parent_id: parent.map(str::to_owned),
        })
        .unwrap()
        .id
}

/// A row of the main library with real files under the library root.
fn add_asset(
    library: &Library,
    id: &str,
    kind: &str,
    status: &str,
    extension: &str,
    folders: &[&str],
) {
    let root = library.root().to_path_buf();
    fs::write(
        root.join("assets").join(format!("{id}.{extension}")),
        format!("original {id}"),
    )
    .unwrap();
    fs::write(
        root.join("thumbnails").join(format!("{id}.webp")),
        format!("thumbnail {id}"),
    )
    .unwrap();
    insert_row(library, id, kind, status, extension, folders);
}

fn insert_row(
    library: &Library,
    id: &str,
    kind: &str,
    status: &str,
    extension: &str,
    folders: &[&str],
) {
    let connection = library.connection().unwrap();
    connection
        .execute(
            "INSERT INTO assets (id, content_hash, media_kind, original_name, relative_path,
                thumbnail_relative_path, byte_size, width, height, collected_at, status)
             VALUES (?1, ?2, ?3, 'a', ?4, ?5, 12, 640, 480, '2026-10-01T00:00:00Z', ?6)",
            rusqlite::params![
                id,
                format!("hash-{id}"),
                kind,
                format!("assets/{id}.{extension}"),
                format!("thumbnails/{id}.webp"),
                status,
            ],
        )
        .unwrap();
    for folder in folders {
        connection
            .execute(
                "INSERT INTO asset_classifications(asset_id, classification_id) VALUES (?1, ?2)",
                [id, folder],
            )
            .unwrap();
    }
}

fn call(library: &Library, privacy: Privacy, request: ApiRequest) -> ApiResponse {
    dispatch_with_picker(request, Some(library), TOKEN, || Ok(privacy)).0
}

fn get(library: &Library, privacy: Privacy, path: &str) -> ApiResponse {
    call(
        library,
        privacy,
        ApiRequest::get(path, EXTENSION_ORIGIN, BEARER),
    )
}

fn post_batch(library: &Library, privacy: Privacy, body: serde_json::Value) -> ApiResponse {
    call(
        library,
        privacy,
        ApiRequest::post(
            "/v1/picker/batch",
            EXTENSION_ORIGIN,
            BEARER,
            body.to_string().as_bytes(),
        ),
    )
}

fn json(response: &ApiResponse) -> serde_json::Value {
    serde_json::from_slice(&response.body).unwrap()
}

fn code(response: &ApiResponse) -> String {
    json(response)["code"].as_str().unwrap().to_owned()
}

fn batch_ids(response: &ApiResponse) -> Vec<String> {
    json(response)["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["assetId"].as_str().unwrap().to_owned())
        .collect()
}

fn library() -> (tempfile::TempDir, Library) {
    let root = tempfile::tempdir().unwrap();
    let library = Library::open(root.path()).unwrap();
    (root, library)
}

#[test]
fn picker_routes_refuse_wrong_origin_missing_or_wrong_token() {
    let (_root, library) = library();
    let body = br#"{"folderId":"x"}"#;
    for (method, path) in [
        ("GET", "/v1/picker/folders"),
        ("POST", "/v1/picker/batch"),
        ("GET", "/v1/picker/thumbnail/a"),
        ("GET", "/v1/picker/original/a"),
    ] {
        let build = |origin: &str, authorization: Option<&str>| {
            if method == "POST" {
                ApiRequest::post(path, origin, authorization, body)
            } else {
                ApiRequest::get(path, origin, authorization)
            }
        };
        let forbidden = call(&library, OFF, build("https://arca.live", BEARER));
        assert_eq!(
            (forbidden.status, code(&forbidden).as_str()),
            (403, "forbidden_origin"),
            "{path}"
        );
        let missing = call(&library, OFF, build(EXTENSION_ORIGIN, None));
        assert_eq!(
            (missing.status, code(&missing).as_str()),
            (401, "unauthorized"),
            "{path}"
        );
        let wrong = call(&library, OFF, build(EXTENSION_ORIGIN, Some("Bearer nope")));
        assert_eq!(
            (wrong.status, code(&wrong).as_str()),
            (401, "unauthorized"),
            "{path}"
        );
        assert_eq!(wrong.header("Cache-Control"), Some("no-store"));
    }
    // Preflight: allowed origin only.
    let (preflight, _) = dispatch_with_picker(
        ApiRequest::options("/v1/picker/batch", EXTENSION_ORIGIN),
        None,
        TOKEN,
        || Ok(OFF),
    );
    assert_eq!(preflight.status, 204);
    // A wrong method on a picker route is an unknown route.
    let wrong_method = call(
        &library,
        OFF,
        ApiRequest::post("/v1/picker/folders", EXTENSION_ORIGIN, BEARER, b"{}"),
    );
    assert_eq!(
        (wrong_method.status, code(&wrong_method).as_str()),
        (404, "not_found")
    );
    // No library open.
    let (no_library, _) = dispatch_with_picker(
        ApiRequest::get("/v1/picker/folders", EXTENSION_ORIGIN, BEARER),
        None,
        TOKEN,
        || Ok(OFF),
    );
    assert_eq!(
        (no_library.status, code(&no_library).as_str()),
        (409, "library_not_open")
    );
}

#[test]
fn picker_folders_count_only_eligible_images_with_descendants() {
    let (_root, library) = library();
    let root = folder(&library, "Root", None);
    let child = folder(&library, "Child", Some(&root));
    let grand = folder(&library, "Grand", Some(&child));
    let empty = folder(&library, "Empty", Some(&root));
    add_asset(&library, "root-image", "image", "normal", "png", &[&root]);
    add_asset(&library, "child-image", "image", "normal", "jpg", &[&child]);
    add_asset(&library, "grand-gif", "gif", "normal", "gif", &[&grand]);
    // Linked in the child and its grandchild: one image for the child's total, not two.
    add_asset(
        &library,
        "both",
        "image",
        "normal",
        "webp",
        &[&child, &grand],
    );
    add_asset(&library, "trashed", "image", "trash", "png", &[&child]);
    add_asset(&library, "in-review", "image", "review", "png", &[&child]);
    add_asset(
        &library,
        "clip",
        "video",
        "normal",
        "mp4",
        &[&child, &grand],
    );

    let response = get(&library, OFF, "/v1/picker/folders");
    assert_eq!(response.status, 200);
    assert_eq!(response.header("Cache-Control"), Some("no-store"));
    let entries = json(&response)["entries"].as_array().unwrap().clone();
    let by_name: HashMap<String, serde_json::Value> = entries
        .into_iter()
        .map(|entry| (entry["name"].as_str().unwrap().to_owned(), entry))
        .collect();
    let counts = |name: &str| {
        let entry = &by_name[name];
        (
            entry["imageCount"].as_u64().unwrap(),
            entry["imageCountWithDescendants"].as_u64().unwrap(),
        )
    };
    assert_eq!(counts("Root"), (1, 4));
    assert_eq!(counts("Child"), (2, 3));
    assert_eq!(counts("Grand"), (2, 2));
    assert_eq!(counts("Empty"), (0, 0));
    assert_eq!(
        by_name["Grand"]["path"],
        serde_json::json!(["Root", "Child", "Grand"])
    );
    assert_eq!(by_name["Grand"]["parentId"], serde_json::json!(child));
    assert!(by_name["Root"]["parentId"].is_null());
    assert_eq!(by_name["Empty"]["id"], serde_json::json!(empty));
    // No filesystem path or file name in the tree.
    assert!(!String::from_utf8_lossy(&response.body).contains("assets/"));
}

#[test]
fn picker_batch_is_uniform_bounded_and_honours_exclude() {
    let (_root, library) = library();
    let parent = folder(&library, "Parent", None);
    let child = folder(&library, "Child", Some(&parent));
    for number in 0..30 {
        add_asset(
            &library,
            &format!("p{number:02}"),
            "image",
            "normal",
            "png",
            &[&parent],
        );
    }
    for number in 0..10 {
        add_asset(
            &library,
            &format!("c{number:02}"),
            "image",
            "normal",
            "png",
            &[&child],
        );
    }

    // Default 18, unique, with the fields the panel needs and no paths.
    let response = post_batch(&library, OFF, serde_json::json!({"folderId": parent}));
    assert_eq!(response.status, 200);
    let body = json(&response);
    let items = body["items"].as_array().unwrap();
    assert_eq!(items.len(), 18);
    assert_eq!(body["remaining"], 30);
    let first = &items[0];
    assert_eq!(first["width"], 640);
    assert_eq!(first["height"], 480);
    assert_eq!(first["byteSize"], 12);
    assert_eq!(first["mime"], "image/png");
    let id = first["assetId"].as_str().unwrap();
    assert_eq!(first["thumbnailUrl"], format!("/v1/picker/thumbnail/{id}"));
    assert!(!String::from_utf8_lossy(&response.body).contains("assets/"));
    let ids = batch_ids(&response);
    assert_eq!(ids.iter().collect::<HashSet<_>>().len(), 18);
    assert!(ids.iter().all(|id| id.starts_with('p')));

    // With descendants the child's images join the pool.
    let all = post_batch(
        &library,
        OFF,
        serde_json::json!({"folderId": parent, "includeDescendants": true, "limit": 24}),
    );
    assert_eq!(json(&all)["remaining"], 40);
    assert_eq!(batch_ids(&all).len(), 24);

    // Excluded ids never come back and shrink `remaining`; fewer left than the limit.
    let excluded: Vec<String> = (0..25)
        .map(|number| format!("p{number:02}"))
        .chain(["unknown".to_owned()])
        .collect();
    let rest = post_batch(
        &library,
        OFF,
        serde_json::json!({"folderId": parent, "exclude": excluded}),
    );
    assert_eq!(json(&rest)["remaining"], 5);
    let mut rest_ids = batch_ids(&rest);
    rest_ids.sort();
    assert_eq!(rest_ids, ["p25", "p26", "p27", "p28", "p29"]);
    let everything: Vec<String> = (0..30).map(|number| format!("p{number:02}")).collect();
    let none = post_batch(
        &library,
        OFF,
        serde_json::json!({"folderId": parent, "exclude": everything}),
    );
    assert_eq!(
        (json(&none)["remaining"].as_u64(), batch_ids(&none).len()),
        (Some(0), 0)
    );

    // Request validation.
    for limit in [0, 25] {
        let bad = post_batch(
            &library,
            OFF,
            serde_json::json!({"folderId": parent, "limit": limit}),
        );
        assert_eq!(
            (bad.status, code(&bad).as_str()),
            (400, "pickerInvalidRequest"),
            "limit {limit}"
        );
    }
    let too_many: Vec<String> = (0..2001).map(|number| format!("x{number}")).collect();
    let bad = post_batch(
        &library,
        OFF,
        serde_json::json!({"folderId": parent, "exclude": too_many}),
    );
    assert_eq!(code(&bad), "pickerInvalidRequest");
    let at_limit: Vec<String> = (0..2000).map(|number| format!("x{number}")).collect();
    let ok = post_batch(
        &library,
        OFF,
        serde_json::json!({"folderId": parent, "exclude": at_limit}),
    );
    assert_eq!(ok.status, 200);
    for body in [
        serde_json::json!({}),
        serde_json::json!({"folderId": "../x"}),
        serde_json::json!({"folderId": parent, "exclude": ["a/b"]}),
    ] {
        assert_eq!(
            code(&post_batch(&library, OFF, body)),
            "pickerInvalidRequest"
        );
    }
    let garbage = call(
        &library,
        OFF,
        ApiRequest::post("/v1/picker/batch", EXTENSION_ORIGIN, BEARER, b"not json"),
    );
    assert_eq!(code(&garbage), "pickerInvalidRequest");
    let missing = post_batch(&library, OFF, serde_json::json!({"folderId": "nope"}));
    assert_eq!(
        (missing.status, code(&missing).as_str()),
        (404, "classification_not_found")
    );
}

#[test]
fn picker_batch_draws_each_image_with_equal_chance_and_varies_by_seed() {
    let (_root, library) = library();
    let folder_id = folder(&library, "Pool", None);
    for number in 0..24 {
        add_asset(
            &library,
            &format!("u{number:02}"),
            "image",
            "normal",
            "png",
            &[&folder_id],
        );
    }
    let request: BatchRequest =
        serde_json::from_value(serde_json::json!({"folderId": folder_id, "limit": 6})).unwrap();
    let mut seen = HashMap::<String, u32>::new();
    let mut orders = HashSet::new();
    for seed in 0..400_u64 {
        let response = batch(
            &library,
            OFF,
            &serde_json::to_vec(&serde_json::json!({"folderId": request.folder_id, "limit": 6}))
                .unwrap(),
            seed.wrapping_mul(0x1234_5678_9ABC_DEF1) ^ 7,
        )
        .unwrap();
        let ids = batch_ids(&response);
        assert_eq!(ids.len(), 6);
        for id in &ids {
            *seen.entry(id.clone()).or_default() += 1;
        }
        orders.insert(ids);
    }
    // 400 batches x 6 draws over 24 images: 100 each on average.
    assert_eq!(seen.len(), 24);
    assert!(
        seen.values().all(|count| (60..=145).contains(count)),
        "{seen:?}"
    );
    assert!(orders.len() > 300);
    // The same seed repeats the same batch.
    let body = serde_json::to_vec(&serde_json::json!({"folderId": folder_id, "limit": 6})).unwrap();
    assert_eq!(
        batch_ids(&batch(&library, OFF, &body, 5).unwrap()),
        batch_ids(&batch(&library, OFF, &body, 5).unwrap())
    );
}

#[test]
fn picker_never_serves_trash_video_vault_or_assets_with_missing_files() {
    let (root, library) = library();
    let pool = folder(&library, "Pool", None);
    add_asset(&library, "good", "image", "normal", "png", &[&pool]);
    add_asset(&library, "trashed", "image", "trash", "png", &[&pool]);
    add_asset(&library, "in-review", "image", "review", "png", &[&pool]);
    add_asset(&library, "clip", "video", "normal", "mp4", &[&pool]);
    add_asset(&library, "no-original", "image", "normal", "png", &[&pool]);
    fs::remove_file(root.path().join("assets/no-original.png")).unwrap();
    add_asset(&library, "no-thumbnail", "image", "normal", "png", &[&pool]);
    fs::remove_file(root.path().join("thumbnails/no-thumbnail.webp")).unwrap();
    add_asset(&library, "document", "image", "normal", "pdf", &[&pool]);

    // An encrypted-vault image and a plain private-vault index are separate stores.
    let outside = tempfile::tempdir().unwrap();
    let vault = outside.path().join("vault-store");
    let source = outside.path().join("vault-source");
    fs::create_dir(&vault).unwrap();
    fs::create_dir(&source).unwrap();
    let png = image::RgbImage::from_pixel(8, 8, image::Rgb([9, 90, 190]));
    png.save(source.join("secret.png")).unwrap();
    library
        .create_encrypted_vault(&vault, "correct horse", false)
        .unwrap();
    library
        .import_into_encrypted_vault(&source, &mut |_| {})
        .unwrap();
    let vault_id = library
        .list_encrypted_vault_items(EncryptedVaultQuery {
            kind: Some(EncryptedVaultItemKind::Image),
            offset: 0,
            limit: 1,
            trashed: false,
            folder_id: None,
            unfiled_only: false,
        })
        .unwrap()
        .items[0]
        .id
        .clone();

    for _ in 0..5 {
        let response = post_batch(
            &library,
            OFF,
            serde_json::json!({"folderId": pool, "limit": 24}),
        );
        assert_eq!(batch_ids(&response), ["good"]);
        // Rows with a missing file still count as eligible rows; they are only skipped.
        assert_eq!(json(&response)["remaining"], 4);
    }
    let folders = json(&get(&library, OFF, "/v1/picker/folders"));
    // `no-original`, `no-thumbnail`, `document` and `good` are rows of an eligible kind.
    assert_eq!(folders["entries"][0]["imageCount"], 4);

    for id in [
        "trashed",
        "in-review",
        "clip",
        "no-original",
        "no-thumbnail",
        "document",
        vault_id.as_str(),
        "missing",
    ] {
        for route in ["thumbnail", "original"] {
            let response = get(&library, OFF, &format!("/v1/picker/{route}/{id}"));
            assert_eq!(
                (response.status, code(&response).as_str()),
                (404, "pickerAssetNotFound"),
                "{route}/{id}"
            );
            assert_eq!(response.header("Cache-Control"), Some("no-store"));
        }
    }
    for id in ["", "..", "a%2Fb", "a/b", "a.b"] {
        for route in ["thumbnail", "original"] {
            assert_eq!(
                get(&library, OFF, &format!("/v1/picker/{route}/{id}")).status,
                404,
                "{route}/{id}"
            );
        }
    }
    let too_long = "a".repeat(65);
    assert_eq!(
        get(&library, OFF, &format!("/v1/picker/original/{too_long}")).status,
        404
    );
    // The eligible one still works.
    assert_eq!(get(&library, OFF, "/v1/picker/thumbnail/good").status, 200);
}

#[test]
fn picker_files_have_their_own_content_type_and_cache_headers() {
    let (_root, library) = library();
    let pool = folder(&library, "Pool", None);
    for (id, extension) in [
        ("a", "png"),
        ("b", "jpg"),
        ("c", "gif"),
        ("d", "webp"),
        ("e", "jpeg"),
    ] {
        add_asset(
            &library,
            id,
            if extension == "gif" { "gif" } else { "image" },
            "normal",
            extension,
            &[&pool],
        );
    }
    for (id, mime) in [
        ("a", "image/png"),
        ("b", "image/jpeg"),
        ("c", "image/gif"),
        ("d", "image/webp"),
        ("e", "image/jpeg"),
    ] {
        let original = get(&library, OFF, &format!("/v1/picker/original/{id}"));
        assert_eq!(original.status, 200);
        assert_eq!(original.header("Content-Type"), Some(mime));
        assert_eq!(original.header("Cache-Control"), Some("no-store"));
        assert_eq!(original.header("X-Content-Type-Options"), Some("nosniff"));
        assert_eq!(
            original.header("Access-Control-Allow-Origin"),
            Some(EXTENSION_ORIGIN)
        );
        assert_eq!(original.body, format!("original {id}").into_bytes());

        let thumbnail = get(&library, OFF, &format!("/v1/picker/thumbnail/{id}"));
        assert_eq!(thumbnail.status, 200);
        assert_eq!(thumbnail.header("Content-Type"), Some("image/webp"));
        assert_eq!(
            thumbnail.header("Cache-Control"),
            Some("private, max-age=300")
        );
        assert_eq!(thumbnail.body, format!("thumbnail {id}").into_bytes());
    }
    let listed = post_batch(&library, OFF, serde_json::json!({"folderId": pool}));
    let mimes: HashMap<String, String> = json(&listed)["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| {
            (
                item["assetId"].as_str().unwrap().to_owned(),
                item["mime"].as_str().unwrap().to_owned(),
            )
        })
        .collect();
    assert_eq!(mimes["c"], "image/gif");
    assert_eq!(mimes["d"], "image/webp");
}

#[test]
fn picker_original_over_twenty_mib_is_refused() {
    let (root, library) = library();
    let pool = folder(&library, "Pool", None);
    add_asset(&library, "exact", "image", "normal", "png", &[&pool]);
    add_asset(&library, "large", "image", "normal", "png", &[&pool]);
    let set_length = |id: &str, length: u64| {
        fs::OpenOptions::new()
            .write(true)
            .open(root.path().join("assets").join(format!("{id}.png")))
            .unwrap()
            .set_len(length)
            .unwrap();
    };
    set_length("exact", MAX_ORIGINAL_BYTES);
    set_length("large", MAX_ORIGINAL_BYTES + 1);
    let large = get(&library, OFF, "/v1/picker/original/large");
    assert_eq!(
        (large.status, code(&large).as_str()),
        (413, "pickerOriginalTooLarge")
    );
    assert_eq!(
        get(&library, OFF, "/v1/picker/original/exact").body.len() as u64,
        MAX_ORIGINAL_BYTES
    );
}

fn rate(library: &Library, id: &str, tag: &str) {
    let connection = library.connection().unwrap();
    connection
        .execute(
            "INSERT OR IGNORE INTO auto_tag_vocabulary(tag, category) VALUES (?1, 'rating')",
            [tag],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO asset_auto_tags(asset_id, tag, score) VALUES (?1, ?2, 0.9)",
            [id, tag],
        )
        .unwrap();
}

#[test]
fn picker_follows_the_pc_privacy_mode_and_nsfw_filter() {
    let (_root, library) = library();
    let pool = folder(&library, "Pool", None);
    for id in ["safe", "explicit", "unrated"] {
        add_asset(&library, id, "image", "normal", "png", &[&pool]);
    }
    rate(&library, "safe", "rating:g");
    rate(&library, "explicit", "rating:e");

    // Privacy mode: nothing is served, whatever the route.
    let locked = Privacy {
        privacy_mode: true,
        nsfw_filter: false,
    };
    let requests = [
        ApiRequest::get("/v1/picker/folders", EXTENSION_ORIGIN, BEARER),
        ApiRequest::post(
            "/v1/picker/batch",
            EXTENSION_ORIGIN,
            BEARER,
            br#"{"folderId":"x"}"#,
        ),
        ApiRequest::get("/v1/picker/thumbnail/safe", EXTENSION_ORIGIN, BEARER),
        ApiRequest::get("/v1/picker/original/safe", EXTENSION_ORIGIN, BEARER),
    ];
    for request in requests {
        let path = request.path.clone();
        let response = call(&library, locked, request);
        assert_eq!(
            (response.status, code(&response).as_str()),
            (423, "pickerLibraryLocked"),
            "{path}"
        );
        assert_eq!(response.header("Cache-Control"), Some("no-store"));
    }

    // Unknown privacy state is treated as locked.
    let (unknown, _) = dispatch_with_picker(
        ApiRequest::get("/v1/picker/folders", EXTENSION_ORIGIN, BEARER),
        Some(&library),
        TOKEN,
        || Err(ApiError::PickerPrivacyUnavailable),
    );
    assert_eq!(
        (unknown.status, code(&unknown).as_str()),
        (423, "pickerPrivacyUnavailable")
    );
    // ...but only after authorization.
    let (unauthorized, _) = dispatch_with_picker(
        ApiRequest::get("/v1/picker/folders", EXTENSION_ORIGIN, None),
        Some(&library),
        TOKEN,
        || Err(ApiError::PickerPrivacyUnavailable),
    );
    assert_eq!(unauthorized.status, 401);

    // NSFW filter: only `g`; unrated and others stay hidden everywhere.
    let filtered = Privacy {
        privacy_mode: false,
        nsfw_filter: true,
    };
    assert_eq!(
        json(&get(&library, filtered, "/v1/picker/folders"))["entries"][0]["imageCount"],
        1
    );
    assert_eq!(
        json(&get(&library, OFF, "/v1/picker/folders"))["entries"][0]["imageCount"],
        3
    );
    let response = post_batch(&library, filtered, serde_json::json!({"folderId": pool}));
    assert_eq!(batch_ids(&response), ["safe"]);
    assert_eq!(json(&response)["remaining"], 1);
    for route in ["thumbnail", "original"] {
        assert_eq!(
            get(&library, filtered, &format!("/v1/picker/{route}/safe")).status,
            200
        );
        for id in ["explicit", "unrated"] {
            assert_eq!(
                get(&library, filtered, &format!("/v1/picker/{route}/{id}")).status,
                404
            );
            assert_eq!(
                get(&library, OFF, &format!("/v1/picker/{route}/{id}")).status,
                200
            );
        }
    }
}

#[test]
fn picker_privacy_gate_asks_once_and_fails_closed() {
    let privacy = Privacy {
        privacy_mode: true,
        nsfw_filter: true,
    };

    // The page answers the pending question; a second reader within the fresh window reuses it.
    let gate = Arc::new(PrivacyGate::default());
    let asked = Arc::new(AtomicUsize::new(0));
    let answer = {
        let gate = gate.clone();
        let asked = asked.clone();
        move |nonce: &str| {
            asked.fetch_add(1, Ordering::SeqCst);
            let gate = gate.clone();
            let nonce = nonce.to_owned();
            thread::spawn(move || {
                thread::sleep(Duration::from_millis(30));
                assert!(!gate.report("forged", Privacy::default()));
                assert!(gate.report(&nonce, privacy));
                assert!(
                    !gate.report(&nonce, Privacy::default()),
                    "an answer works once"
                );
            });
            true
        }
    };
    let (first, second) = thread::scope(|scope| {
        let first =
            scope.spawn(|| gate.read(&answer, Duration::from_secs(5), Duration::from_secs(5)));
        let second =
            scope.spawn(|| gate.read(&answer, Duration::from_secs(5), Duration::from_secs(5)));
        (first.join().unwrap(), second.join().unwrap())
    });
    assert_eq!((first, second), (Ok(privacy), Ok(privacy)));
    assert_eq!(
        gate.read(&answer, Duration::from_secs(5), Duration::from_secs(5)),
        Ok(privacy)
    );
    assert_eq!(asked.load(Ordering::SeqCst), 1);

    // A stale answer is asked again.
    let stale = PrivacyGate::default();
    let later = Privacy {
        privacy_mode: false,
        nsfw_filter: true,
    };
    thread::scope(|scope| {
        let answer_with = |value: Privacy| {
            let stale = &stale;
            move |nonce: &str| {
                let nonce = nonce.to_owned();
                scope.spawn(move || assert!(stale.report(&nonce, value)));
                true
            }
        };
        assert_eq!(
            stale.read(answer_with(privacy), Duration::ZERO, Duration::from_secs(5)),
            Ok(privacy)
        );
        assert_eq!(
            stale.read(answer_with(later), Duration::ZERO, Duration::from_secs(5)),
            Ok(later)
        );
    });

    // No answer in time, or no way to ask, is "unavailable"; a later question still works.
    let silent = PrivacyGate::default();
    let started = Instant::now();
    assert_eq!(
        silent.read(|_| true, Duration::from_secs(5), Duration::from_millis(80)),
        Err(ApiError::PickerPrivacyUnavailable)
    );
    assert!(started.elapsed() >= Duration::from_millis(70));
    assert_eq!(
        silent.read(|_| false, Duration::from_secs(5), Duration::from_secs(5)),
        Err(ApiError::PickerPrivacyUnavailable)
    );
    thread::scope(|scope| {
        let answered = silent.read(
            |nonce| {
                let nonce = nonce.to_owned();
                let silent = &silent;
                scope.spawn(move || assert!(silent.report(&nonce, Privacy::default())));
                true
            },
            Duration::from_secs(5),
            Duration::from_secs(5),
        );
        assert_eq!(answered, Ok(Privacy::default()));
    });
}

#[test]
fn picker_privacy_probe_reads_only_the_saved_preferences() {
    let script = privacy_probe_script("abc123");
    assert!(script.contains("lakomics.uiPreferences.v1"));
    assert!(script.contains("nonce:'abc123'"));
    assert!(script.contains("report_picker_privacy"));
    assert!(script.contains("privacyMode===true"));
}

#[test]
fn picker_batch_body_limit_fits_two_thousand_ids_and_no_more() {
    let ids: Vec<String> = (0..2000).map(|_| "a".repeat(64)).collect();
    let body = serde_json::json!({"folderId": "f", "exclude": ids}).to_string();
    assert!(body.len() < MAX_BATCH_JSON_BYTES);
    assert!(
        crate::extension_api::read_json_with_limit(body.as_bytes(), MAX_BATCH_JSON_BYTES).is_ok()
    );
    let huge = vec![b' '; MAX_BATCH_JSON_BYTES + 1];
    assert_eq!(
        crate::extension_api::read_json_with_limit(huge.as_slice(), MAX_BATCH_JSON_BYTES),
        Err(ApiError::BodyTooLarge)
    );
}

/// Latency on a ~50k-asset library: `cargo test picker_latency -- --ignored --nocapture`.
#[test]
#[ignore = "measurement on a generated 50k-asset temp library"]
fn picker_latency_on_a_fifty_thousand_asset_library() {
    let (_root, library) = library();
    let library_root = library.root().to_path_buf();
    let top = folder(&library, "Top", None);
    let mut leaves = Vec::new();
    for number in 0..10 {
        let branch = folder(&library, &format!("Branch {number}"), Some(&top));
        for leaf in 0..10 {
            leaves.push(folder(
                &library,
                &format!("Leaf {number}-{leaf}"),
                Some(&branch),
            ));
        }
    }
    let started = Instant::now();
    {
        let mut connection = library.connection().unwrap();
        let transaction = connection.transaction().unwrap();
        {
            let mut asset = transaction
                .prepare(
                    "INSERT INTO assets (id, content_hash, media_kind, original_name, relative_path,
                        thumbnail_relative_path, byte_size, width, height, collected_at, status)
                     VALUES (?1, ?2, ?3, 'a', ?4, ?5, 100000, 1000, 1500, '2026-10-01T00:00:00Z', ?6)",
                )
                .unwrap();
            let mut link = transaction
                .prepare("INSERT INTO asset_classifications(asset_id, classification_id) VALUES (?1, ?2)")
                .unwrap();
            let mut rating = transaction
                .prepare("INSERT INTO asset_auto_tags(asset_id, tag, score) VALUES (?1, 'rating:g', 0.9)")
                .unwrap();
            transaction
                .execute("INSERT OR IGNORE INTO auto_tag_vocabulary(tag, category) VALUES ('rating:g', 'rating')", [])
                .unwrap();
            for number in 0..50_000_usize {
                let id = format!(
                    "{:08x}-0000-4000-8000-{number:012x}",
                    number.wrapping_mul(2_654_435_761)
                );
                let (kind, status) = match number % 50 {
                    0 => ("video", "normal"),
                    1 => ("image", "trash"),
                    _ => ("image", "normal"),
                };
                asset
                    .execute(rusqlite::params![
                        id,
                        format!("h{number}"),
                        kind,
                        format!("assets/{number}.jpg"),
                        format!("thumbnails/{number}.webp"),
                        status
                    ])
                    .unwrap();
                link.execute([&id, &leaves[number % leaves.len()]]).unwrap();
                fs::write(library_root.join(format!("assets/{number}.jpg")), b"x").unwrap();
                fs::write(library_root.join(format!("thumbnails/{number}.webp")), b"x").unwrap();
                if number % 7 == 0 {
                    link.execute([&id, &leaves[(number + 13) % leaves.len()]])
                        .ok();
                }
                if number % 3 == 0 {
                    rating.execute([&id]).unwrap();
                }
            }
        }
        transaction.commit().unwrap();
    }
    eprintln!("fixture: 50000 assets in {:?}", started.elapsed());

    let measure = |label: &str, privacy: Privacy, body: serde_json::Value| {
        let mut times = Vec::new();
        let mut last = None;
        for _ in 0..7 {
            let started = Instant::now();
            let response = post_batch(&library, privacy, body.clone());
            times.push(started.elapsed());
            assert_eq!(response.status, 200, "{label}");
            last = Some(response);
        }
        times.sort();
        let response = json(&last.unwrap());
        eprintln!(
            "{label}: median {:?}, max {:?}, remaining {}, items {}",
            times[3],
            times[6],
            response["remaining"],
            response["items"].as_array().unwrap().len()
        );
    };
    let excluded: Vec<String> = (0..2000)
        .map(|number| {
            format!(
                "{:08x}-0000-4000-8000-{number:012x}",
                number * 2_654_435_761_usize
            )
        })
        .collect();
    measure("leaf, 18", OFF, serde_json::json!({"folderId": leaves[0]}));
    measure(
        "branch with descendants, 18",
        OFF,
        serde_json::json!({"folderId": library.list_classifications().unwrap().iter().find(|e| e.name == "Branch 0").unwrap().id, "includeDescendants": true}),
    );
    measure(
        "top with descendants (all 50k), 18",
        OFF,
        serde_json::json!({"folderId": top, "includeDescendants": true}),
    );
    measure(
        "top with descendants, 24, 2000 excluded",
        OFF,
        serde_json::json!({"folderId": top, "includeDescendants": true, "limit": 24, "exclude": excluded}),
    );
    measure(
        "top with descendants, NSFW filter",
        Privacy {
            privacy_mode: false,
            nsfw_filter: true,
        },
        serde_json::json!({"folderId": top, "includeDescendants": true}),
    );
    for (label, privacy) in [
        ("folders", OFF),
        (
            "folders, NSFW filter",
            Privacy {
                privacy_mode: false,
                nsfw_filter: true,
            },
        ),
    ] {
        let mut times = Vec::new();
        for _ in 0..5 {
            let started = Instant::now();
            assert_eq!(get(&library, privacy, "/v1/picker/folders").status, 200);
            times.push(started.elapsed());
        }
        times.sort();
        eprintln!("{label}: median {:?}, max {:?}", times[2], times[4]);
    }
}
