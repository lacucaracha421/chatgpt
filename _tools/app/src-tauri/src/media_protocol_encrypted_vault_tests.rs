    use tauri::http::{
        header::{CACHE_CONTROL, CONTENT_RANGE, CONTENT_TYPE},
        Method, Response, StatusCode,
    };

    use super::{media_response, media_response_with_range, parse_encrypted_vault_path};
    use crate::library::{
        models::{EncryptedVaultItemKind, EncryptedVaultQuery},
        Library,
    };

    struct Fixture {
        _temp: tempfile::TempDir,
        library: Library,
        image_id: String,
        video_id: String,
        image: Vec<u8>,
        video: Vec<u8>,
    }

    fn fixture() -> Fixture {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path().join("library")).unwrap();
        let vault = temp.path().join("vault");
        let source = temp.path().join("source");
        std::fs::create_dir(&vault).unwrap();
        std::fs::create_dir(&source).unwrap();
        image::RgbImage::from_pixel(12, 8, image::Rgb([1, 2, 3]))
            .save(source.join("picture.png"))
            .unwrap();
        let video = (0..200_000_u32).map(|value| (value % 253) as u8).collect::<Vec<_>>();
        std::fs::write(source.join("clip.mp4"), &video).unwrap();
        library
            .create_encrypted_vault(&vault, "correct horse", false)
            .unwrap();
        library
            .import_into_encrypted_vault(&source, &mut |_| {})
            .unwrap();
        let id_of = |kind| {
            library
                .list_encrypted_vault_items(EncryptedVaultQuery {
                    kind: Some(kind),
                    offset: 0,
                    limit: 1,
                    trashed: false,
                    folder_id: None,
                    unfiled_only: false,
                })
                .unwrap()
                .items[0]
                .id
                .clone()
        };
        let image_id = id_of(EncryptedVaultItemKind::Image);
        let video_id = id_of(EncryptedVaultItemKind::Video);
        Fixture {
            image: std::fs::read(source.join("picture.png")).unwrap(),
            _temp: temp,
            library,
            image_id,
            video_id,
            video,
        }
    }

    fn get(library: &Library, path: &str, range: Option<&str>) -> Response<Vec<u8>> {
        let response = media_response_with_range(Some(library), &Method::GET, path, range);
        assert_eq!(
            response.headers().get(CACHE_CONTROL).and_then(|value| value.to_str().ok()),
            Some("no-store"),
            "{path} {range:?} -> {}",
            response.status()
        );
        response
    }

    #[test]
    fn vault_routes_parse_only_closed_paths() {
        let id = "00000000-0000-4000-8000-000000000009";
        assert!(parse_encrypted_vault_path(&format!("/vault-asset/{id}")).is_some());
        assert!(parse_encrypted_vault_path(&format!("/vault-thumbnail/{id}/v3")).is_some());
        assert!(parse_encrypted_vault_path(&format!("/vault-playback/{id}")).is_some());
        for path in [
            format!("/vault-asset/{id}/extra"),
            format!("/vault-thumbnail/{id}/x3"),
            format!("/vault-playback/{id}/1"),
            format!("/vault-other/{id}"),
        ] {
            assert!(parse_encrypted_vault_path(&path).is_none(), "{path}");
        }
    }

    #[test]
    fn serves_decrypted_media_with_ranges_and_no_store() {
        let fixture = fixture();
        let library = &fixture.library;
        let image = get(library, &format!("/vault-asset/{}", fixture.image_id), None);
        assert_eq!(image.status(), StatusCode::OK);
        assert_eq!(image.headers()[CONTENT_TYPE], "image/png");
        assert_eq!(image.body(), &fixture.image);

        let thumbnail = get(library, &format!("/vault-thumbnail/{}/v2", fixture.image_id), None);
        assert_eq!(thumbnail.status(), StatusCode::OK);
        assert_eq!(thumbnail.headers()[CONTENT_TYPE], "image/webp");
        assert!(image::load_from_memory(thumbnail.body()).is_ok());
        let poster = get(library, &format!("/vault-thumbnail/{}", fixture.video_id), None);
        assert_eq!(poster.status(), StatusCode::OK);

        let playback = format!("/vault-playback/{}", fixture.video_id);
        let middle = get(library, &playback, Some("bytes=70000-140000"));
        assert_eq!(middle.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(middle.headers()[CONTENT_TYPE], "video/mp4");
        assert_eq!(middle.headers()[CONTENT_RANGE], "bytes 70000-140000/200000");
        assert_eq!(middle.body(), &fixture.video[70_000..=140_000]);
        let suffix = get(library, &playback, Some("bytes=-10"));
        assert_eq!(suffix.body(), &fixture.video[199_990..]);
        let open = get(library, &playback, Some("bytes=0-"));
        assert_eq!(open.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(open.body(), &fixture.video);
        assert_eq!(
            get(library, &playback, None).status(),
            StatusCode::RANGE_NOT_SATISFIABLE
        );
        assert_eq!(
            get(library, &playback, Some("bytes=200000-")).status(),
            StatusCode::RANGE_NOT_SATISFIABLE
        );
        let image_range = get(
            library,
            &format!("/vault-asset/{}", fixture.image_id),
            Some("bytes=1-3"),
        );
        assert_eq!(image_range.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(image_range.body(), &fixture.image[1..=3]);

        // The shared routes never serve vault items, even while the vault is unlocked.
        for path in [
            format!("/asset/{}", fixture.image_id),
            format!("/thumbnail/{}", fixture.image_id),
            format!("/playback/{}", fixture.video_id),
        ] {
            let shared = media_response_with_range(Some(library), &Method::GET, &path, Some("bytes=0-99"));
            assert_eq!(shared.status(), StatusCode::NOT_FOUND, "{path}");
            assert!(shared.body().is_empty(), "{path}");
        }

        assert_eq!(
            get(library, &format!("/vault-playback/{}", fixture.image_id), Some("bytes=0-1")).status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            get(library, "/vault-asset/00000000-0000-4000-8000-000000000009", None).status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            get(library, "/vault-asset/not-a-uuid", None).status(),
            StatusCode::BAD_REQUEST
        );
        let post = super::media_response_with_range(
            Some(library),
            &Method::POST,
            &format!("/vault-asset/{}", fixture.image_id),
            None,
        );
        assert_eq!(post.status(), StatusCode::METHOD_NOT_ALLOWED);
        assert_eq!(post.headers()[CACHE_CONTROL], "no-store");
    }

    #[test]
    fn locked_vault_refuses_media() {
        let fixture = fixture();
        let library = &fixture.library;
        library.lock_encrypted_vault();
        for path in [
            format!("/vault-asset/{}", fixture.image_id),
            format!("/vault-thumbnail/{}", fixture.image_id),
            format!("/vault-playback/{}", fixture.video_id),
        ] {
            let response = get(library, &path, Some("bytes=0-9"));
            assert_eq!(response.status(), StatusCode::LOCKED, "{path}");
            assert!(response.body().is_empty());
        }
        let shared = media_response(Some(library), &Method::GET, &format!("/asset/{}", fixture.image_id));
        assert_eq!(shared.status(), StatusCode::NOT_FOUND);
        assert!(shared.body().is_empty());
    }
