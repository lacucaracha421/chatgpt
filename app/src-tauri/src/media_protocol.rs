use std::io::{Read, Seek, SeekFrom};

use tauri::http::{
    header::{ACCEPT_RANGES, CONTENT_LENGTH, CONTENT_RANGE, CONTENT_TYPE},
    Method, Response, StatusCode,
};

use crate::library::{error::LibraryError, mangadex, Library, MediaVariant};

#[cfg(test)]
pub(crate) fn media_response(
    library: Option<&Library>,
    method: &Method,
    path: &str,
) -> Response<Vec<u8>> {
    media_response_with_range(library, method, path, None)
}

pub(crate) fn media_response_with_range(
    library: Option<&Library>,
    method: &Method,
    path: &str,
    range_header: Option<&str>,
) -> Response<Vec<u8>> {
    if method != Method::GET {
        return empty_response(StatusCode::METHOD_NOT_ALLOWED);
    }
    let Some((variant, asset_id, file_name)) = parse_path(path) else {
        return empty_response(StatusCode::BAD_REQUEST);
    };
    let Some(library) = library else {
        return empty_response(StatusCode::NOT_FOUND);
    };

    if matches!(variant, MediaVariant::MangaDexCoverPreview) {
        return match mangadex::cover_preview(&asset_id, &file_name.unwrap_or_default()) {
            Ok(image) => Response::builder()
                .status(StatusCode::OK)
                .header(CONTENT_TYPE, image.mime)
                .header(CONTENT_LENGTH, image.bytes.len().to_string())
                .body(image.bytes)
                .expect("remote image response is valid"),
            Err(LibraryError::MangaDexNotFound) => empty_response(StatusCode::NOT_FOUND),
            Err(LibraryError::MangaDexRateLimited) => {
                empty_response(StatusCode::TOO_MANY_REQUESTS)
            }
            Err(LibraryError::InvalidMangaDexIdentity) => {
                empty_response(StatusCode::BAD_REQUEST)
            }
            Err(_) => empty_response(StatusCode::BAD_GATEWAY),
        };
    }

    let collection_media = match variant {
        MediaVariant::CollectionCover => Some(
            library.collection_cover_media(&asset_id, &file_name.unwrap_or_default()),
        ),
        MediaVariant::CollectionSourcePreview => {
            Some(library.collection_source_preview_media(&asset_id))
        }
        _ => None,
    };
    if let Some(collection_media) = collection_media {
        return match collection_media {
            Ok(mut media) => {
                let mut bytes = Vec::new();
                if media.file.read_to_end(&mut bytes).is_err() {
                    return empty_response(StatusCode::INTERNAL_SERVER_ERROR);
                }
                Response::builder()
                    .status(StatusCode::OK)
                    .header(CONTENT_TYPE, media.mime)
                    .header(CONTENT_LENGTH, media.length.to_string())
                    .body(bytes)
                    .expect("static media response is valid")
            }
            Err(
                LibraryError::AssetNotFound
                | LibraryError::MediaNotFound
                | LibraryError::UnsafeMediaPath
                | LibraryError::MangaRootNotSet
                | LibraryError::MangaSeriesNotFound
                | LibraryError::CollectionSourceRootNotSet
                | LibraryError::CollectionSourcePathNotSet
                | LibraryError::CollectionNotFound,
            ) => empty_response(StatusCode::NOT_FOUND),
            Err(_) => empty_response(StatusCode::INTERNAL_SERVER_ERROR),
        };
    }

    match library.resolve_media(&asset_id, variant) {
        Ok(media) if matches!(variant, MediaVariant::Playback) => {
            playback_response(media, range_header)
        }
        Ok(mut media) => {
            let mut bytes = Vec::new();
            if media.file.read_to_end(&mut bytes).is_err() {
                return empty_response(StatusCode::INTERNAL_SERVER_ERROR);
            }
            Response::builder()
                .status(StatusCode::OK)
                .header(CONTENT_TYPE, media.mime)
                .header(CONTENT_LENGTH, media.length.to_string())
                .body(bytes)
                .expect("static media response is valid")
        }
        Err(
            LibraryError::AssetNotFound
            | LibraryError::MediaNotFound
            | LibraryError::UnsafeMediaPath
            | LibraryError::MangaRootNotSet
            | LibraryError::MangaSeriesNotFound
            | LibraryError::CollectionSourceRootNotSet
            | LibraryError::CollectionSourcePathNotSet,
        ) => empty_response(StatusCode::NOT_FOUND),
        Err(_) => empty_response(StatusCode::INTERNAL_SERVER_ERROR),
    }
}

fn playback_response(
    mut media: crate::library::MediaResponse,
    range_header: Option<&str>,
) -> Response<Vec<u8>> {
    let Some((start, end)) = range_header.and_then(|value| parse_range(value, media.length)) else {
        return range_not_satisfiable(media.length);
    };
    let length = end - start + 1;
    if media.file.seek(SeekFrom::Start(start)).is_err() {
        return empty_response(StatusCode::INTERNAL_SERVER_ERROR);
    }
    let mut bytes = Vec::new();
    if media.file.take(length).read_to_end(&mut bytes).is_err() || bytes.len() as u64 != length {
        return empty_response(StatusCode::INTERNAL_SERVER_ERROR);
    }
    Response::builder()
        .status(StatusCode::PARTIAL_CONTENT)
        .header(CONTENT_TYPE, media.mime)
        .header(ACCEPT_RANGES, "bytes")
        .header(CONTENT_LENGTH, length.to_string())
        .header(
            CONTENT_RANGE,
            format!("bytes {start}-{end}/{}", media.length),
        )
        .body(bytes)
        .expect("validated range response is valid")
}

fn parse_range(value: &str, total: u64) -> Option<(u64, u64)> {
    if total == 0 || value.contains(',') {
        return None;
    }
    let range = value.strip_prefix("bytes=")?;
    let (start, end) = range.split_once('-')?;
    match (start.is_empty(), end.is_empty()) {
        (false, false) => {
            let start = start.parse::<u64>().ok()?;
            let end = end.parse::<u64>().ok()?.min(total - 1);
            (start < total && start <= end).then_some((start, end))
        }
        (false, true) => {
            let start = start.parse::<u64>().ok()?;
            (start < total).then_some((start, total - 1))
        }
        (true, false) => {
            let suffix = end.parse::<u64>().ok()?;
            (suffix > 0).then(|| (total - suffix.min(total), total - 1))
        }
        (true, true) => None,
    }
}

fn parse_path(path: &str) -> Option<(MediaVariant, String, Option<String>)> {
    let mut segments = path.strip_prefix('/')?.split('/');
    let route = segments.next()?;
    let asset_id = percent_decode(segments.next()?)?;
    if uuid::Uuid::parse_str(&asset_id).is_err() {
        return None;
    }
    let (variant, file_name) = match route {
        "asset" if segments.next().is_none() => (MediaVariant::Asset, None),
        "thumbnail" if segments.next().is_none() => (MediaVariant::Thumbnail, None),
        "playback" if segments.next().is_none() => (MediaVariant::Playback, None),
        "manga-cover" if segments.next().is_none() => (MediaVariant::MangaCover, None),
        "manga-page" => {
            let page_index = segments.next()?.parse::<u32>().ok()?;
            if segments.next().is_some() {
                return None;
            }
            (MediaVariant::MangaPage(page_index), None)
        }
        "collection-cover" => {
            let file_name = percent_decode(segments.next()?)?;
            if segments.next().is_some() {
                return None;
            }
            (MediaVariant::CollectionCover, Some(file_name))
        }
        "collection-source-preview" if segments.next().is_none() => {
            (MediaVariant::CollectionSourcePreview, None)
        }
        "work-artwork" if segments.next().is_none() => (MediaVariant::WorkArtwork, None),
        "mangadex-cover-preview" => {
            let file_name = percent_decode(segments.next()?)?;
            if segments.next().is_some()
                || mangadex::validate_cover_identity(&asset_id, &file_name).is_err()
            {
                return None;
            }
            (MediaVariant::MangaDexCoverPreview, Some(file_name))
        }
        "scrub-frame" => {
            let frame_index = segments.next()?.parse::<u32>().ok()?;
            if segments.next().is_some() {
                return None;
            }
            (MediaVariant::ScrubFrame(frame_index), None)
        }
        _ => return None,
    };
    Some((variant, asset_id, file_name))
}

fn percent_decode(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let high = hex_digit(*bytes.get(index + 1)?)?;
            let low = hex_digit(*bytes.get(index + 2)?)?;
            decoded.push((high << 4) | low);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(decoded).ok()
}

fn hex_digit(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

fn range_not_satisfiable(total: u64) -> Response<Vec<u8>> {
    Response::builder()
        .status(StatusCode::RANGE_NOT_SATISFIABLE)
        .header(ACCEPT_RANGES, "bytes")
        .header(CONTENT_RANGE, format!("bytes */{total}"))
        .body(Vec::new())
        .expect("range error response is valid")
}

fn empty_response(status: StatusCode) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .body(Vec::new())
        .expect("static empty response is valid")
}

#[cfg(test)]
mod tests {
    use rusqlite::params;
    use tauri::http::{
        header::{ACCEPT_RANGES, CONTENT_LENGTH, CONTENT_RANGE, CONTENT_TYPE},
        Method, StatusCode,
    };

    use crate::library::{error::LibraryError, Library, MediaVariant};

    use super::{media_response, media_response_with_range, parse_path};

    const ASSET_ID: &str = "00000000-0000-4000-8000-000000000001";
    const MISSING_ID: &str = "00000000-0000-4000-8000-000000000002";
    const REVIEW_ID: &str = "00000000-0000-4000-8000-000000000003";
    const TRASH_ID: &str = "00000000-0000-4000-8000-000000000004";
    const SERIES_ID: &str = "00000000-0000-4000-8000-000000000005";
    const COLLECTION_ID: &str = "00000000-0000-4000-8000-000000000006";
    const ARTWORK_ID: &str = "00000000-0000-4000-8000-000000000007";

    fn collection_source_library(with_preview: bool) -> (tempfile::TempDir, Library) {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path().join("library")).unwrap();
        let source_root = temp.path().join("source");
        let collection_dir = source_root.join("series");
        std::fs::create_dir_all(&collection_dir).unwrap();
        if with_preview {
            std::fs::write(collection_dir.join("thumbnail.webp"), b"source preview").unwrap();
        }
        library
            .set_collection_source_root(Some(source_root.to_string_lossy().as_ref()))
            .unwrap();
        library
            .connection()
            .unwrap()
            .execute(
                "INSERT INTO collections (id, name, created_at, updated_at, source_path)
                 VALUES (?1, 'Series', '2026-08-20T00:00:00Z', '2026-08-20T00:00:00Z', 'series')",
                [COLLECTION_ID],
            )
            .unwrap();
        (temp, library)
    }

    #[test]
    fn collection_source_preview_route_serves_the_resolved_image() {
        let (_temp, library) = collection_source_library(true);

        let response = media_response(
            Some(&library),
            &Method::GET,
            &format!("/collection-source-preview/{COLLECTION_ID}"),
        );

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[CONTENT_TYPE], "image/webp");
        assert_eq!(response.body(), b"source preview");
    }

    #[test]
    fn collection_source_preview_route_returns_not_found_without_a_candidate() {
        let (_temp, library) = collection_source_library(false);

        let response = media_response(
            Some(&library),
            &Method::GET,
            &format!("/collection-source-preview/{COLLECTION_ID}"),
        );

        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[test]
    fn work_artwork_route_serves_only_the_id_resolved_file() {
        let (_temp, library) = collection_source_library(false);
        let relative_path = format!("work-artwork/{COLLECTION_ID}/{ARTWORK_ID}.png");
        let absolute_path = library.root().join(&relative_path);
        std::fs::create_dir_all(absolute_path.parent().unwrap()).unwrap();
        std::fs::write(&absolute_path, b"artwork bytes").unwrap();
        library
            .connection()
            .unwrap()
            .execute(
                "INSERT INTO collection_work_artworks (
                    id, collection_id, provider, provider_image_id, kind, relative_path,
                    mime_type, width, height, selected, created_at, updated_at
                 ) VALUES (?1, ?2, 'mangadex', 'cover-1', 'cover', ?3,
                    'image/png', 10, 15, 1,
                    '2026-08-20T00:00:00Z', '2026-08-20T00:00:00Z')",
                params![ARTWORK_ID, COLLECTION_ID, relative_path],
            )
            .unwrap();

        let response = media_response(
            Some(&library),
            &Method::GET,
            &format!("/work-artwork/{ARTWORK_ID}"),
        );

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[CONTENT_TYPE], "image/png");
        assert_eq!(response.body(), b"artwork bytes");
    }

    #[test]
    fn parses_mangadex_cover_preview_route() {
        let file_name = "a1b2c3d4-e5f6-47a8-9000-111122223333.jpg";
        let (variant, manga_id, parsed_file_name) = parse_path(&format!(
            "/mangadex-cover-preview/{COLLECTION_ID}/{file_name}"
        ))
        .unwrap();

        assert!(matches!(variant, MediaVariant::MangaDexCoverPreview));
        assert_eq!(manga_id, COLLECTION_ID);
        assert_eq!(parsed_file_name.as_deref(), Some(file_name));
    }

    #[test]
    fn protocol_serves_only_id_resolved_asset_and_thumbnail_bytes_with_mime() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path().join("library")).unwrap();
        insert_asset(
            &library,
            ASSET_ID,
            "assets/image.png",
            "thumbnails/image.webp",
        );
        std::fs::write(library.root().join("assets/image.png"), b"asset bytes").unwrap();
        std::fs::write(
            library.root().join("thumbnails/image.webp"),
            b"thumbnail bytes",
        )
        .unwrap();

        let asset = media_response(Some(&library), &Method::GET, &format!("/asset/{ASSET_ID}"));
        let thumbnail = media_response(
            Some(&library),
            &Method::GET,
            &format!("/thumbnail/{ASSET_ID}"),
        );

        assert_eq!(asset.status(), StatusCode::OK);
        assert_eq!(asset.headers()[CONTENT_TYPE], "image/png");
        assert_eq!(asset.body(), b"asset bytes");
        assert_eq!(thumbnail.status(), StatusCode::OK);
        assert_eq!(thumbnail.headers()[CONTENT_TYPE], "image/webp");
        assert_eq!(thumbnail.body(), b"thumbnail bytes");
    }

    #[test]
    fn protocol_rejects_non_get_and_every_path_other_than_variant_uuid() {
        let invalid_requests = [
            (
                Method::POST,
                format!("/asset/{ASSET_ID}"),
                StatusCode::METHOD_NOT_ALLOWED,
            ),
            (
                Method::GET,
                "/thumbnail/../secret".into(),
                StatusCode::BAD_REQUEST,
            ),
            (
                Method::GET,
                format!("/thumbnail/{ASSET_ID}/more"),
                StatusCode::BAD_REQUEST,
            ),
            (
                Method::GET,
                format!("/assets/{ASSET_ID}"),
                StatusCode::BAD_REQUEST,
            ),
            (
                Method::GET,
                "/asset/not-a-uuid".into(),
                StatusCode::BAD_REQUEST,
            ),
        ];

        for (method, path, expected) in invalid_requests {
            assert_eq!(media_response(None, &method, &path).status(), expected);
        }
    }

    #[test]
    fn protocol_returns_not_found_for_an_unknown_asset_id() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();

        let response = media_response(
            Some(&library),
            &Method::GET,
            &format!("/asset/{MISSING_ID}"),
        );

        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[test]
    fn review_media_is_available_without_exposing_trash() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path().join("library")).unwrap();
        for (id, status) in [(REVIEW_ID, "review"), (TRASH_ID, "trash")] {
            let asset_path = format!("assets/{id}.png");
            let thumbnail_path = format!("thumbnails/{id}.webp");
            insert_asset_with_status(&library, id, &asset_path, &thumbnail_path, status);
            std::fs::write(library.root().join(asset_path), b"asset bytes").unwrap();
            std::fs::write(library.root().join(thumbnail_path), b"thumbnail bytes").unwrap();
        }

        for variant in ["asset", "thumbnail"] {
            assert_eq!(
                media_response(
                    Some(&library),
                    &Method::GET,
                    &format!("/{variant}/{REVIEW_ID}"),
                )
                .status(),
                StatusCode::OK
            );
            assert_eq!(
                media_response(
                    Some(&library),
                    &Method::GET,
                    &format!("/{variant}/{TRASH_ID}"),
                )
                .status(),
                StatusCode::NOT_FOUND
            );
        }
    }

    #[test]
    fn resolve_media_rejects_a_canonical_path_outside_the_library_root() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path().join("library")).unwrap();
        std::fs::write(temp.path().join("outside.png"), b"outside bytes").unwrap();
        insert_asset(
            &library,
            ASSET_ID,
            "../outside.png",
            "thumbnails/missing.webp",
        );

        let error = library
            .resolve_media(ASSET_ID, MediaVariant::Asset)
            .unwrap_err();

        assert!(matches!(error, LibraryError::UnsafeMediaPath));
    }

    #[test]
    fn playback_serves_bounded_open_ended_and_suffix_ranges() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path().join("library")).unwrap();
        insert_prepared_video(&library, ASSET_ID, "normal");

        for (range, expected_range, expected_body) in [
            ("bytes=10-19", "bytes 10-19/36", b"abcdefghij".as_slice()),
            ("bytes=30-", "bytes 30-35/36", b"uvwxyz".as_slice()),
            ("bytes=-10", "bytes 26-35/36", b"qrstuvwxyz".as_slice()),
        ] {
            let response = media_response_with_range(
                Some(&library),
                &Method::GET,
                &format!("/playback/{ASSET_ID}"),
                Some(range),
            );
            assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
            assert_eq!(response.headers()[CONTENT_RANGE], expected_range);
            assert_eq!(response.headers()[ACCEPT_RANGES], "bytes");
            assert_eq!(
                response.headers()[CONTENT_LENGTH],
                expected_body.len().to_string()
            );
            assert_eq!(response.body(), expected_body);
        }
    }

    #[test]
    fn playback_rejects_unranged_unsatisfiable_and_multi_range_requests() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path().join("library")).unwrap();
        insert_prepared_video(&library, ASSET_ID, "normal");

        for range in [None, Some("bytes=99-120"), Some("bytes=0-1,4-5")] {
            let response = media_response_with_range(
                Some(&library),
                &Method::GET,
                &format!("/playback/{ASSET_ID}"),
                range,
            );
            assert_eq!(response.status(), StatusCode::RANGE_NOT_SATISFIABLE);
            assert_eq!(response.headers()[CONTENT_RANGE], "bytes */36");
            assert!(response.body().is_empty());
        }
    }

    #[test]
    fn scrub_frame_is_complete_but_missing_and_trashed_video_media_are_hidden() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path().join("library")).unwrap();
        insert_prepared_video(&library, ASSET_ID, "normal");
        insert_prepared_video(&library, TRASH_ID, "trash");

        let frame = media_response_with_range(
            Some(&library),
            &Method::GET,
            &format!("/scrub-frame/{ASSET_ID}/0"),
            None,
        );
        assert_eq!(frame.status(), StatusCode::OK);
        assert_eq!(frame.headers()[CONTENT_TYPE], "image/webp");
        assert_eq!(frame.body(), b"scrub-frame");
        assert_eq!(
            media_response_with_range(
                Some(&library),
                &Method::GET,
                &format!("/scrub-frame/{ASSET_ID}/1"),
                None,
            )
            .status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            media_response_with_range(
                Some(&library),
                &Method::GET,
                &format!("/playback/{TRASH_ID}"),
                Some("bytes=0-1"),
            )
            .status(),
            StatusCode::NOT_FOUND
        );
    }

    #[test]
    fn manga_page_route_rejects_out_of_range_page() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path().join("library")).unwrap();
        let manga_root = temp.path().join("manga");
        std::fs::create_dir_all(manga_root.join("series-a")).unwrap();
        write_test_png(&manga_root.join("series-a/1.png"));
        write_test_png(&manga_root.join("series-a/2.png"));
        library
            .set_manga_root(Some(manga_root.to_string_lossy().as_ref()))
            .unwrap();
        library.scan_manga().unwrap();
        let series = library.list_manga_series().unwrap();
        assert_eq!(series.len(), 1);
        let series_id = &series[0].id;

        let cover = media_response(
            Some(&library),
            &Method::GET,
            &format!("/manga-cover/{series_id}"),
        );
        assert_eq!(cover.status(), StatusCode::OK);
        assert_eq!(cover.headers()[CONTENT_TYPE], "image/webp");

        for page in [1, 2] {
            let response = media_response(
                Some(&library),
                &Method::GET,
                &format!("/manga-page/{series_id}/{page}"),
            );
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(response.headers()[CONTENT_TYPE], "image/png");
        }

        for page in [0, 3, 999] {
            let response = media_response(
                Some(&library),
                &Method::GET,
                &format!("/manga-page/{series_id}/{page}"),
            );
            assert_eq!(response.status(), StatusCode::NOT_FOUND);
        }
    }

    #[test]
    fn manga_routes_reject_unsafe_paths_and_malformed_requests() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path().join("library")).unwrap();
        let manga_root = temp.path().join("manga");
        std::fs::create_dir_all(manga_root.join("series-a")).unwrap();
        write_test_png(&manga_root.join("series-a/1.png"));
        library
            .set_manga_root(Some(manga_root.to_string_lossy().as_ref()))
            .unwrap();
        library.scan_manga().unwrap();
        let series_id = library.list_manga_series().unwrap()[0].id.clone();

        let cases = [
            (
                format!("/manga-page/{series_id}/not-a-number"),
                StatusCode::BAD_REQUEST,
            ),
            (
                format!("/manga-page/{series_id}/1/extra"),
                StatusCode::BAD_REQUEST,
            ),
            (
                format!("/manga-cover/{series_id}/extra"),
                StatusCode::BAD_REQUEST,
            ),
            (
                format!("/manga-cover/{MISSING_ID}"),
                StatusCode::NOT_FOUND,
            ),
            (
                format!("/manga-page/{MISSING_ID}/1"),
                StatusCode::NOT_FOUND,
            ),
        ];
        for (path, expected) in cases {
            assert_eq!(
                media_response(Some(&library), &Method::GET, &path).status(),
                expected
            );
        }
    }

    #[test]
    fn manga_routes_are_hidden_when_no_library_is_open() {
        let response = media_response(
            None,
            &Method::GET,
            &format!("/manga-cover/{SERIES_ID}"),
        );
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    fn write_test_png(path: &std::path::Path) {
        let image = image::RgbImage::from_pixel(8, 6, image::Rgb([10, 20, 30]));
        image
            .save_with_format(path, image::ImageFormat::Png)
            .unwrap();
    }

    fn insert_asset(
        library: &Library,
        id: &str,
        relative_path: &str,
        thumbnail_relative_path: &str,
    ) {
        insert_asset_with_status(
            library,
            id,
            relative_path,
            thumbnail_relative_path,
            "normal",
        );
    }

    fn insert_asset_with_status(
        library: &Library,
        id: &str,
        relative_path: &str,
        thumbnail_relative_path: &str,
        status: &str,
    ) {
        library
            .connection()
            .unwrap()
            .execute(
                "INSERT INTO assets (
                    id, content_hash, media_kind, original_name, relative_path,
                    thumbnail_relative_path, byte_size, width, height, collected_at, status
                 ) VALUES (?1, ?2, 'image', 'image.png', ?3, ?4, 11, 4, 3, ?5, ?6)",
                params![
                    id,
                    format!("hash-{id}"),
                    relative_path,
                    thumbnail_relative_path,
                    "2026-07-30T00:00:00Z",
                    status,
                ],
            )
            .unwrap();
    }

    fn insert_prepared_video(library: &Library, id: &str, status: &str) {
        let original = format!("assets/{id}.webm");
        let poster = format!("video-media/{id}/poster.webp");
        let scrub = format!("video-media/{id}/scrub");
        std::fs::create_dir_all(library.root().join(&scrub)).unwrap();
        std::fs::write(
            library.root().join(&original),
            b"0123456789abcdefghijklmnopqrstuvwxyz",
        )
        .unwrap();
        std::fs::write(library.root().join(&poster), b"poster").unwrap();
        std::fs::write(library.root().join(&scrub).join("000.webp"), b"scrub-frame").unwrap();
        let trashed_at = (status == "trash").then_some("2026-08-09T00:00:00Z");
        let connection = library.connection().unwrap();
        connection
            .execute(
                "INSERT INTO assets (
                    id, content_hash, media_kind, original_name, relative_path,
                    thumbnail_relative_path, byte_size, width, height, collected_at,
                    status, trashed_at
                 ) VALUES (?1, ?2, 'video', 'clip.webm', ?3, ?4, 36, 1280, 720,
                    '2026-08-09T00:00:00Z', ?5, ?6)",
                params![
                    id,
                    format!("hash-{id}"),
                    original,
                    poster,
                    status,
                    trashed_at
                ],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO video_assets (
                    asset_id, duration_ms, container, video_codec, audio_codec,
                    preparation_state, playback_kind, poster_relative_path,
                    scrub_relative_dir, scrub_frame_count
                 ) VALUES (?1, 5000, 'webm', 'vp9', 'opus', 'ready', 'original', ?2, ?3, 1)",
                params![id, poster, scrub],
            )
            .unwrap();
    }
}
