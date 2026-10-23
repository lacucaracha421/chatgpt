use std::{
    collections::{HashMap, VecDeque},
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::{Duration, SystemTime},
};

use tauri::http::{
    header::{ACCEPT_RANGES, CACHE_CONTROL, CONTENT_LENGTH, CONTENT_RANGE, CONTENT_TYPE},
    Method, Response, StatusCode,
};

mod preview;

use crate::library::{
    error::LibraryError,
    igdb::{IgdbClient, IgdbImageSize},
    mangadex,
    tmdb::{TmdbClient, TmdbImageSize},
    external_vault::{EncryptedVaultMedia, EncryptedVaultMediaVariant},
    Library, MediaVariant, MAX_WORK_ARTWORK_BYTES,
};

#[cfg(test)]
pub(crate) fn media_response(
    library: Option<&Library>,
    method: &Method,
    path: &str,
) -> Response<Vec<u8>> {
    media_response_with_range(library, method, path, None)
}

const PREVIEW_CACHE_CONTROL: &str = "private, max-age=86400";

#[cfg(test)]
mod manga_spine_protocol_tests {
    use super::*;
    #[test]
    fn manga_spine_route_serves_original_jpeg_and_rejects_other_parts() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let jpeg = include_bytes!("library/fixtures/yes24-side.jpg");
        library.save_spine_bytes("9780000000001", "side", jpeg).unwrap();
        let path = "/manga-spine-scan/9780000000001/side";
        let mut response = media_response(Some(&library), &Method::GET, path);
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[CONTENT_TYPE], "image/jpeg");
        assert_eq!(response.headers()[CACHE_CONTROL], PREVIEW_CACHE_CONTROL);
        assert_eq!(response.body(), jpeg);
        crate::collectible_cors::allow_cover_canvas(&mut response, Some("tauri://localhost"), path);
        assert_eq!(response.headers()["access-control-allow-origin"], "tauri://localhost");
        let mut external = media_response(Some(&library), &Method::GET, path);
        crate::collectible_cors::allow_cover_canvas(&mut external, Some("https://example.com"), path);
        assert!(!external.headers().contains_key("access-control-allow-origin"));
        assert_eq!(media_response(None, &Method::GET, path).status(), StatusCode::NOT_FOUND);
        assert_eq!(media_response(Some(&library), &Method::POST, path).status(), StatusCode::METHOD_NOT_ALLOWED);
        for path in ["/manga-spine-scan/9780000000001/front", "/manga-spine-scan/9780000000001/side/extra", "/manga-spine-scan/../side"] {
            assert_eq!(media_response(Some(&library), &Method::GET, path).status(), StatusCode::BAD_REQUEST);
        }
        assert_eq!(media_response(Some(&library), &Method::GET, "/manga-spine-scan/9780000000001/back").status(), StatusCode::NOT_FOUND);
    }
}
const PREVIEW_DISK_BYTES: u64 = 128 * 1024 * 1024;
const PREVIEW_DISK_ENTRIES: usize = 512;
const PREVIEW_DISK_AGE: Duration = Duration::from_secs(30 * 86400);
static PREVIEW_DISK: OnceLock<PathBuf> = OnceLock::new();
static PREVIEW_DISK_WRITE: Mutex<()> = Mutex::new(());

pub(crate) fn set_preview_disk_cache(path: PathBuf) {
    let _ = PREVIEW_DISK.set(path);
}

fn preview_disk_path(root: &Path, key: &PreviewCacheKey) -> PathBuf {
    use sha2::{Digest, Sha256};
    // Version and provider/size are part of the key; no request path becomes a filesystem path.
    let key = format!("v1:{:?}:{}", key.variant, key.image_path);
    let digest = Sha256::digest(key.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    root.join(format!("{digest}.preview"))
}

fn preview_disk_read(root: &Path, key: &PreviewCacheKey) -> Option<Response<Vec<u8>>> {
    let file = std::fs::File::open(preview_disk_path(root, key)).ok()?;
    let metadata = file.metadata().ok()?;
    if !metadata.is_file()
        || metadata.len() > (MAX_WORK_ARTWORK_BYTES + 64) as u64
        || metadata.modified().ok()?.elapsed().ok()? > PREVIEW_DISK_AGE
    {
        return None;
    }
    let mut stored = Vec::new();
    file.take((MAX_WORK_ARTWORK_BYTES + 65) as u64)
        .read_to_end(&mut stored)
        .ok()?;
    let split = stored.iter().position(|byte| *byte == b'\n')?;
    if split > 32 || stored.len() <= split + 1 || stored.len() - split - 1 > MAX_WORK_ARTWORK_BYTES
    {
        return None;
    }
    let mime = std::str::from_utf8(&stored[..split]).ok()?;
    if !matches!(mime, "image/jpeg" | "image/png" | "image/webp") {
        return None;
    }
    Some(preview_response(stored[split + 1..].to_vec(), mime))
}

fn preview_disk_write(root: &Path, key: &PreviewCacheKey, response: &Response<Vec<u8>>) {
    if response.status() != StatusCode::OK
        || response.body().is_empty()
        || response.body().len() > MAX_WORK_ARTWORK_BYTES
    {
        return;
    }
    let Some(mime) = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
    else {
        return;
    };
    if !matches!(mime, "image/jpeg" | "image/png" | "image/webp") {
        return;
    }
    let Ok(_guard) = PREVIEW_DISK_WRITE.lock() else {
        return;
    };
    if std::fs::create_dir_all(root).is_err() {
        return;
    }
    let path = preview_disk_path(root, key);
    let temp = root.join(format!("{}.tmp", uuid::Uuid::new_v4()));
    let mut stored = mime.as_bytes().to_vec();
    stored.push(b'\n');
    stored.extend_from_slice(response.body());
    if std::fs::write(&temp, stored).is_err() {
        let _ = std::fs::remove_file(&temp);
        return;
    }
    // Another request may already have cached the same immutable provider image.
    if preview_disk_read(root, key).is_some() {
        let _ = std::fs::remove_file(&temp);
        return;
    }
    let _ = std::fs::remove_file(&path);
    if std::fs::rename(&temp, &path).is_err() {
        let _ = std::fs::remove_file(&temp);
        return;
    }
    prune_preview_disk(root, PREVIEW_DISK_BYTES, PREVIEW_DISK_ENTRIES);
}

fn prune_preview_disk(root: &Path, max_bytes: u64, max_entries: usize) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    let mut files = entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            let name = path.file_name()?.to_str()?;
            let digest = name.strip_suffix(".preview")?;
            if digest.len() != 64 || !digest.bytes().all(|b| b.is_ascii_hexdigit()) {
                return None;
            }
            let metadata = entry.metadata().ok()?;
            if !metadata.is_file() {
                return None;
            }
            Some((
                metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH),
                path,
                metadata.len(),
            ))
        })
        .collect::<Vec<_>>();
    files.sort_by_key(|(modified, _, _)| *modified);
    let mut bytes: u64 = files.iter().map(|(_, _, size)| size).sum();
    let mut count = files.len();
    for (modified, path, size) in files {
        let expired = modified.elapsed().is_ok_and(|age| age > PREVIEW_DISK_AGE);
        if !expired && bytes <= max_bytes && count <= max_entries {
            break;
        }
        if std::fs::remove_file(path).is_ok() {
            bytes = bytes.saturating_sub(size);
            count -= 1;
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
enum PreviewVariant {
    IgdbCover,
    IgdbHero,
    TmdbPoster,
    TmdbBackdrop,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct PreviewCacheKey {
    variant: PreviewVariant,
    image_path: String,
}

impl PreviewCacheKey {
    fn new(variant: PreviewVariant, image_path: &str) -> Self {
        Self {
            variant,
            image_path: image_path.to_owned(),
        }
    }
}

struct PreviewCacheEntry {
    bytes: Vec<u8>,
    content_type: String,
}

struct PreviewCache {
    entries: HashMap<PreviewCacheKey, PreviewCacheEntry>,
    lru: VecDeque<PreviewCacheKey>,
    total_bytes: usize,
    max_bytes: usize,
}

impl PreviewCache {
    fn new(max_bytes: usize) -> Self {
        Self {
            entries: HashMap::new(),
            lru: VecDeque::new(),
            total_bytes: 0,
            max_bytes,
        }
    }

    fn get(&mut self, key: &PreviewCacheKey) -> Option<Response<Vec<u8>>> {
        let (bytes, content_type) = {
            let entry = self.entries.get(key)?;
            (entry.bytes.clone(), entry.content_type.clone())
        };
        self.touch(key);
        Some(preview_response(bytes, &content_type))
    }

    fn insert(&mut self, key: PreviewCacheKey, response: &Response<Vec<u8>>) {
        if response.status() != StatusCode::OK {
            return;
        }
        let Some(content_type) = response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned)
        else {
            return;
        };
        let bytes = response.body().clone();

        self.remove(&key);
        if bytes.len() > self.max_bytes {
            return;
        }
        while bytes.len() > self.max_bytes.saturating_sub(self.total_bytes) {
            let Some(oldest) = self.lru.pop_front() else {
                break;
            };
            if let Some(entry) = self.entries.remove(&oldest) {
                self.total_bytes -= entry.bytes.len();
            }
        }

        self.total_bytes += bytes.len();
        self.lru.push_back(key.clone());
        self.entries.insert(
            key,
            PreviewCacheEntry {
                bytes,
                content_type,
            },
        );
    }

    fn remove(&mut self, key: &PreviewCacheKey) {
        if let Some(entry) = self.entries.remove(key) {
            self.total_bytes -= entry.bytes.len();
        }
        if let Some(position) = self.lru.iter().position(|candidate| candidate == key) {
            self.lru.remove(position);
        }
    }

    fn touch(&mut self, key: &PreviewCacheKey) {
        if let Some(position) = self.lru.iter().position(|candidate| candidate == key) {
            self.lru.remove(position);
        }
        self.lru.push_back(key.clone());
    }
}

static PREVIEW_CACHE: OnceLock<Mutex<PreviewCache>> = OnceLock::new();

fn preview_cache() -> &'static Mutex<PreviewCache> {
    PREVIEW_CACHE.get_or_init(|| Mutex::new(PreviewCache::new(crate::performance::budgets().preview_cache_bytes)))
}

fn cached_preview(
    key: PreviewCacheKey,
    fetch: impl FnOnce() -> Response<Vec<u8>>,
) -> Response<Vec<u8>> {
    cached_preview_from(preview_cache(), key.clone(), || {
        cached_preview_disk_from(PREVIEW_DISK.get().map(PathBuf::as_path), &key, fetch)
    })
}

fn cached_preview_disk_from(
    root: Option<&Path>,
    key: &PreviewCacheKey,
    fetch: impl FnOnce() -> Response<Vec<u8>>,
) -> Response<Vec<u8>> {
    if let Some(response) = root.and_then(|root| preview_disk_read(root, key)) {
        crate::perf_log::startup_record("preview.cache", serde_json::json!({"source": "disk"}));
        return response;
    }
    crate::perf_log::startup_record("preview.cache", serde_json::json!({"source": "network"}));
    let response = fetch();
    if let Some(root) = root {
        preview_disk_write(root, key, &response);
    }
    response
}

fn cached_preview_from(
    cache: &Mutex<PreviewCache>,
    key: PreviewCacheKey,
    fetch: impl FnOnce() -> Response<Vec<u8>>,
) -> Response<Vec<u8>> {
    if let Ok(mut cache) = cache.lock() {
        if let Some(response) = cache.get(&key) {
            crate::perf_log::startup_record(
                "preview.cache",
                serde_json::json!({"source": "memory"}),
            );
            return response;
        }
    }

    let response = fetch();
    if response.status() == StatusCode::OK {
        if let Ok(mut cache) = cache.lock() {
            cache.insert(key, &response);
        }
    }
    response
}

fn preview_response(bytes: Vec<u8>, content_type: &str) -> Response<Vec<u8>> {
    Response::builder()
        .status(StatusCode::OK)
        .header(CONTENT_TYPE, content_type)
        .header(CACHE_CONTROL, PREVIEW_CACHE_CONTROL)
        .header(CONTENT_LENGTH, bytes.len().to_string())
        .body(bytes)
        .expect("preview image response is valid")
}

pub(crate) fn media_response_with_range(
    library: Option<&Library>,
    method: &Method,
    path: &str,
    range_header: Option<&str>,
) -> Response<Vec<u8>> {
    if let Some((variant, item_id)) = parse_encrypted_vault_path(path) {
        return encrypted_vault_response(library, method, &item_id, variant, range_header);
    }
    if method != Method::GET {
        return empty_response(StatusCode::METHOD_NOT_ALLOWED);
    }
    if let Some(rest) = path.strip_prefix("/manga-spine-scan/") {
        let Some((isbn, part)) = rest.split_once('/') else { return empty_response(StatusCode::BAD_REQUEST); };
        if !crate::library::manga_spine_scans::valid_isbn(isbn) || !matches!(part, "side" | "back") {
            return empty_response(StatusCode::BAD_REQUEST);
        }
        return match library.and_then(|lib| lib.spine_scan_path(isbn, part)).and_then(|path| std::fs::read(path).ok()) {
            Some(bytes) => Response::builder().status(StatusCode::OK)
                .header(CONTENT_TYPE, "image/jpeg").header(CONTENT_LENGTH, bytes.len().to_string())
                .header(CACHE_CONTROL, "private, max-age=86400").body(bytes).expect("scan response"),
            None => empty_response(StatusCode::NOT_FOUND),
        };
    }
    if let Some(rest) = path.strip_prefix("/av-link-jacket/") {
        // `<id>` is the jacket; `<id>/spine` is the DVD cover a borrowed spine is cut from.
        let (id, spine) = match rest.strip_suffix("/spine") { Some(id) => (id, true), None => (rest, false) };
        if uuid::Uuid::parse_str(id).is_err() { return empty_response(StatusCode::BAD_REQUEST); }
        return no_store(match library.and_then(|lib| (if spine { lib.av_link_spine_source(id) } else { lib.av_link_jacket(id) }).ok()) {
            Some((bytes, mime)) => Response::builder().status(StatusCode::OK)
                .header(CONTENT_TYPE, mime).header(CONTENT_LENGTH, bytes.len().to_string())
                .body(bytes).expect("AV jacket response is valid"),
            None => empty_response(StatusCode::NOT_FOUND),
        });
    }
    // The PC's own cutout copies (카드 누끼 만들기), keyed by asset id and model; no library needed.
    if let Some(asset_id) = path.strip_prefix("/card-cutout/") {
        if !crate::cloud::client::card_cutouts::valid_id(asset_id) {
            return empty_response(StatusCode::BAD_REQUEST);
        }
        return match crate::card_cutouts::protocol_file(asset_id) {
            Some((bytes, mime)) => Response::builder()
                .status(StatusCode::OK)
                .header(CONTENT_TYPE, mime)
                .header(CACHE_CONTROL, PREVIEW_CACHE_CONTROL)
                .header(CONTENT_LENGTH, bytes.len().to_string())
                .body(bytes)
                .expect("cutout response is valid"),
            None => empty_response(StatusCode::NOT_FOUND),
        };
    }
    if path.starts_with("/preview/") {
        let Some((asset_id, max)) = preview::parse(path) else {
            return empty_response(StatusCode::BAD_REQUEST);
        };
        return match library {
            Some(library) => preview::response(library, &asset_id, max),
            None => empty_response(StatusCode::NOT_FOUND),
        };
    }
    if path.starts_with("/igdb-image-preview/") {
        let Ok((variant, Some(image_id))) = parse_media_path(path) else {
            return empty_response(StatusCode::BAD_REQUEST);
        };
        if library.is_none() {
            return empty_response(StatusCode::NOT_FOUND);
        }
        return igdb_image_response(&image_id, variant);
    }
    if path.starts_with("/tmdb-image-preview/") {
        let Ok((variant, Some(file_path))) = parse_media_path(path) else {
            return empty_response(StatusCode::BAD_REQUEST);
        };
        if library.is_none() {
            return empty_response(StatusCode::NOT_FOUND);
        }
        return tmdb_image_response(&file_path, variant);
    }
    if path.starts_with("/remote-manga-") {
        let Some((work_id, page)) = parse_remote_manga_path(path) else {
            return empty_response(StatusCode::BAD_REQUEST);
        };
        let Some(library) = library else {
            return empty_response(StatusCode::NOT_FOUND);
        };
        return match crate::library::remote_media::load_remote_page(library.root(), work_id, page) {
            Ok(media) => Response::builder()
                .status(StatusCode::OK)
                .header(CONTENT_TYPE, media.mime)
                .header(CONTENT_LENGTH, media.bytes.len().to_string())
                .body(media.bytes)
                .expect("remote media response is valid"),
            Err(LibraryError::MediaNotFound) => empty_response(StatusCode::NOT_FOUND),
            Err(_) => empty_response(StatusCode::BAD_GATEWAY),
        };
    }
    if path.starts_with("/remote-catalog-thumbnail/") {
        let Some(identity) = parse_catalog_thumbnail_path(path) else {
            return empty_response(StatusCode::BAD_REQUEST);
        };
        let Some(library) = library else {
            return empty_response(StatusCode::NOT_FOUND);
        };
        return match library.online_catalog_thumbnail(&identity) {
            Ok(media) => Response::builder()
                .status(StatusCode::OK)
                .header(CONTENT_TYPE, media.mime)
                .header(CONTENT_LENGTH, media.bytes.len().to_string())
                .body(media.bytes)
                .expect("catalog thumbnail response is valid"),
            Err(LibraryError::MediaNotFound) => empty_response(StatusCode::NOT_FOUND),
            Err(_) => empty_response(StatusCode::BAD_GATEWAY),
        };
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
            Err(LibraryError::MangaDexRateLimited) => empty_response(StatusCode::TOO_MANY_REQUESTS),
            Err(LibraryError::InvalidMangaDexIdentity) => empty_response(StatusCode::BAD_REQUEST),
            Err(_) => empty_response(StatusCode::BAD_GATEWAY),
        };
    }

    let collection_media = match variant {
        MediaVariant::CollectionCover => {
            Some(library.collection_cover_media(&asset_id, &file_name.unwrap_or_default()))
        }
        MediaVariant::CollectionCoverThumbnail => Some(
            library.collection_cover_thumbnail_media(&asset_id, &file_name.unwrap_or_default()),
        ),
        MediaVariant::CollectionSourcePreview => {
            Some(library.collection_source_preview_media(&asset_id))
        }
        MediaVariant::CollectionSourceThumbnail => {
            Some(library.collection_source_thumbnail_media(&asset_id))
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

    // Encrypted Private Vault items are served only by the `/vault-*` routes above; the
    // shared routes never resolve them.
    match library.resolve_media_with_revision(&asset_id, variant) {
        Ok((media, _)) if matches!(variant, MediaVariant::Playback) => {
            playback_response(media, range_header)
        }
        Ok((mut media, current_revision)) => {
            let mut bytes = Vec::new();
            let read =
                crate::media_protocol_timing::stage(crate::media_protocol_timing::Stage::FileRead);
            let result = media.file.read_to_end(&mut bytes);
            drop(read);
            if result.is_err() {
                return empty_response(StatusCode::INTERNAL_SERVER_ERROR);
            }
            let mut response = Response::builder()
                .status(StatusCode::OK)
                .header(CONTENT_TYPE, media.mime)
                .header(CONTENT_LENGTH, media.length.to_string());
            if let Some(cache_control) = library_media_cache_control(
                variant,
                requested_revision(path),
                current_revision.as_deref(),
                bytes.len() as u64,
            ) {
                response = response.header(CACHE_CONTROL, cache_control);
            }
            response.body(bytes).expect("static media response is valid")
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

fn parse_remote_manga_path(path: &str) -> Option<(u64, u32)> {
    let segments = path.strip_prefix('/')?.split('/').collect::<Vec<_>>();
    let (work_id, page) = match segments.as_slice() {
        ["remote-manga-thumbnail", work_id] => (*work_id, "1"),
        ["remote-manga-page", "kHentai", work_id, page] => (*work_id, *page),
        _ => return None,
    };
    let work_id = work_id.parse::<u64>().ok().filter(|id| *id > 0)?;
    let page = page.parse::<u32>().ok().filter(|page| *page > 0)?;
    Some((work_id, page))
}

fn parse_catalog_thumbnail_path(
    path: &str,
) -> Option<crate::library::catalog_provider::CatalogWorkIdentity> {
    let segments = path.strip_prefix('/')?.split('/').collect::<Vec<_>>();
    let [route, provider, provider_work_id] = segments.as_slice() else {
        return None;
    };
    if *route != "remote-catalog-thumbnail" {
        return None;
    }
    let provider = crate::library::catalog_provider::CatalogProvider::from_tag(provider)?;
    let identity = crate::library::catalog_provider::CatalogWorkIdentity::new(
        provider,
        *provider_work_id,
    )
    .ok()?;
    if provider == crate::library::catalog_provider::CatalogProvider::KHentai
        && identity.khentai_numeric_id().is_err()
    {
        return None;
    }
    Some(identity)
}

fn parse_media_path(path: &str) -> Result<(MediaVariant, Option<String>), ()> {
    let segments = path
        .strip_prefix('/')
        .ok_or(())?
        .split('/')
        .collect::<Vec<_>>();
    let [route, size, encoded_image_path] = segments.as_slice() else {
        return Err(());
    };
    let image_path = percent_decode(encoded_image_path).ok_or(())?;
    match *route {
        "igdb-image-preview" => {
            let variant = match *size {
                "cover" => MediaVariant::IgdbImagePreviewCover,
                "hero" => MediaVariant::IgdbImagePreviewHero,
                _ => return Err(()),
            };
            let image_size = match variant {
                MediaVariant::IgdbImagePreviewCover => IgdbImageSize::CoverBig,
                MediaVariant::IgdbImagePreviewHero => IgdbImageSize::Hd1080p,
                _ => return Err(()),
            };
            IgdbClient::image_url(&image_path, image_size).map_err(|_| ())?;
            Ok((variant, Some(image_path)))
        }
        "tmdb-image-preview" => {
            let variant = match *size {
                "poster" => MediaVariant::TmdbImagePreviewPoster,
                "backdrop" => MediaVariant::TmdbImagePreviewBackdrop,
                _ => return Err(()),
            };
            let image_size = match variant {
                MediaVariant::TmdbImagePreviewPoster => TmdbImageSize::W342,
                MediaVariant::TmdbImagePreviewBackdrop => TmdbImageSize::W780,
                _ => return Err(()),
            };
            TmdbClient::image_url(&image_path, image_size).map_err(|_| ())?;
            Ok((variant, Some(image_path)))
        }
        _ => Err(()),
    }
}

fn igdb_image_response(image_id: &str, variant: MediaVariant) -> Response<Vec<u8>> {
    let (size, cache_variant) = match variant {
        MediaVariant::IgdbImagePreviewCover => {
            (IgdbImageSize::CoverBig, PreviewVariant::IgdbCover)
        }
        MediaVariant::IgdbImagePreviewHero => {
            (IgdbImageSize::Hd720p, PreviewVariant::IgdbHero)
        }
        _ => return empty_response(StatusCode::BAD_REQUEST),
    };
    let Ok(url) = IgdbClient::image_url(image_id, size) else {
        return empty_response(StatusCode::BAD_REQUEST);
    };
    cached_preview(PreviewCacheKey::new(cache_variant, image_id), || {
        let response = igdb_image_agent().get(&url).call();
        let mut response = match response {
            Ok(response) => response,
            Err(ureq::Error::StatusCode(404)) => return empty_response(StatusCode::NOT_FOUND),
            Err(ureq::Error::StatusCode(429)) => {
                return empty_response(StatusCode::TOO_MANY_REQUESTS);
            }
            Err(_) => return empty_response(StatusCode::BAD_GATEWAY),
        };
        let mut bytes = Vec::new();
        if response
            .body_mut()
            .as_reader()
            .take((MAX_WORK_ARTWORK_BYTES + 1) as u64)
            .read_to_end(&mut bytes)
            .is_err()
            || bytes.len() > MAX_WORK_ARTWORK_BYTES
        {
            return empty_response(StatusCode::BAD_GATEWAY);
        }
        preview_response(bytes, "image/jpeg")
    })
}

fn igdb_image_agent() -> &'static ureq::Agent {
    static AGENT: OnceLock<ureq::Agent> = OnceLock::new();
    AGENT.get_or_init(|| {
        ureq::Agent::config_builder()
            .https_only(true)
            .max_redirects(0)
            .timeout_global(Some(Duration::from_secs(20)))
            .build()
            .into()
    })
}

fn tmdb_image_response(file_path: &str, variant: MediaVariant) -> Response<Vec<u8>> {
    let (size, cache_variant) = match variant {
        MediaVariant::TmdbImagePreviewPoster => {
            (TmdbImageSize::W342, PreviewVariant::TmdbPoster)
        }
        MediaVariant::TmdbImagePreviewBackdrop => {
            (TmdbImageSize::W780, PreviewVariant::TmdbBackdrop)
        }
        _ => return empty_response(StatusCode::BAD_REQUEST),
    };
    let Ok(url) = TmdbClient::image_url(file_path, size) else {
        return empty_response(StatusCode::BAD_REQUEST);
    };
    let content_type = tmdb_image_mime(file_path);
    cached_preview(PreviewCacheKey::new(cache_variant, file_path), || {
        let response = tmdb_image_agent().get(&url).call();
        let mut response = match response {
            Ok(response) => response,
            Err(ureq::Error::StatusCode(404)) => return empty_response(StatusCode::NOT_FOUND),
            Err(ureq::Error::StatusCode(429)) => {
                return empty_response(StatusCode::TOO_MANY_REQUESTS);
            }
            Err(_) => return empty_response(StatusCode::BAD_GATEWAY),
        };
        let mut bytes = Vec::new();
        if response
            .body_mut()
            .as_reader()
            .take((MAX_WORK_ARTWORK_BYTES + 1) as u64)
            .read_to_end(&mut bytes)
            .is_err()
            || bytes.len() > MAX_WORK_ARTWORK_BYTES
        {
            return empty_response(StatusCode::BAD_GATEWAY);
        }
        preview_response(bytes, content_type)
    })
}

fn tmdb_image_agent() -> &'static ureq::Agent {
    static AGENT: OnceLock<ureq::Agent> = OnceLock::new();
    AGENT.get_or_init(|| {
        ureq::Agent::config_builder()
            .https_only(true)
            .max_redirects(0)
            .timeout_global(Some(Duration::from_secs(20)))
            .build()
            .into()
    })
}

fn tmdb_image_mime(file_path: &str) -> &'static str {
    match file_path.rsplit_once('.').map(|(_, extension)| extension) {
        Some("png") => "image/png",
        Some("webp") => "image/webp",
        _ => "image/jpeg",
    }
}

/// 단일 재생 응답이 메모리에 버퍼링할 최대 크기(8MiB). `bytes=0-` 같은
/// 열린 range가 오면 이 지점까지 잘라 반환하고, 플레이어가 후속 요청으로
/// 이어받는다(206의 Content-Range가 남은 구간을 정확히 안내).
const PLAYBACK_CHUNK_LIMIT: u64 = 8 * 1024 * 1024;

fn playback_response(
    mut media: crate::library::MediaResponse,
    range_header: Option<&str>,
) -> Response<Vec<u8>> {
    let Some((start, end)) = range_header.and_then(|value| parse_range(value, media.length)) else {
        return range_not_satisfiable(media.length);
    };
    // 열린 range(bytes=start-)는 청크 상한으로 잘라 반환한다. seek·재생이
    // 이어질 때 플레이어가 후속 range를 요청하므로 연속 재생에 지장이 없다.
    let end = end.min(start.saturating_add(PLAYBACK_CHUNK_LIMIT - 1));
    let length = end - start + 1;
    if media.file.seek(SeekFrom::Start(start)).is_err() {
        return empty_response(StatusCode::INTERNAL_SERVER_ERROR);
    }
    let mut bytes = Vec::with_capacity(length as usize);
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

/// `/vault-asset/<id>`, `/vault-thumbnail/<id>[/v<n>]` and `/vault-playback/<id>`: routes
/// that only ever serve the unlocked encrypted Private Vault and never touch the disk while
/// it is locked.
fn parse_encrypted_vault_path(path: &str) -> Option<(EncryptedVaultMediaVariant, String)> {
    let mut segments = path.strip_prefix('/')?.split('/');
    let variant = match segments.next()? {
        "vault-asset" => EncryptedVaultMediaVariant::Asset,
        "vault-thumbnail" => EncryptedVaultMediaVariant::Thumbnail,
        "vault-playback" => EncryptedVaultMediaVariant::Playback,
        _ => return None,
    };
    let item_id = segments.next()?.to_owned();
    if variant == EncryptedVaultMediaVariant::Thumbnail {
        if let Some(revision) = segments.next() {
            let number = revision.strip_prefix('v')?;
            if number.is_empty() || !number.bytes().all(|byte| byte.is_ascii_digit()) {
                return None;
            }
        }
    }
    (segments.next().is_none()).then_some((variant, item_id))
}

fn encrypted_vault_response(
    library: Option<&Library>,
    method: &Method,
    item_id: &str,
    variant: EncryptedVaultMediaVariant,
    range_header: Option<&str>,
) -> Response<Vec<u8>> {
    if method != Method::GET {
        return no_store(empty_response(StatusCode::METHOD_NOT_ALLOWED));
    }
    if uuid::Uuid::parse_str(item_id).is_err() {
        return no_store(empty_response(StatusCode::BAD_REQUEST));
    }
    let Some(library) = library else {
        return no_store(empty_response(StatusCode::NOT_FOUND));
    };
    match library.encrypted_vault_media(item_id, variant) {
        Ok(media) => encrypted_vault_media_response(media, range_header),
        Err(error) => encrypted_vault_error_response(&error),
    }
}

fn encrypted_vault_error_response(error: &LibraryError) -> Response<Vec<u8>> {
    no_store(empty_response(match error {
        LibraryError::EncryptedVaultLocked => StatusCode::LOCKED,
        LibraryError::AssetNotFound => StatusCode::NOT_FOUND,
        _ => StatusCode::INTERNAL_SERVER_ERROR,
    }))
}

/// Decrypts only what the response needs. Videos (and any request carrying a Range header)
/// use the same range rules as main-library playback, including the chunk limit.
fn encrypted_vault_media_response(
    mut media: EncryptedVaultMedia,
    range_header: Option<&str>,
) -> Response<Vec<u8>> {
    let total = media.len();
    if range_header.is_none() && !media.video {
        return match media.read_range(0, total) {
            Ok(bytes) if bytes.len() as u64 == total => no_store(
                Response::builder()
                    .status(StatusCode::OK)
                    .header(CONTENT_TYPE, media.mime)
                    .header(CONTENT_LENGTH, total.to_string())
                    .body(bytes)
                    .expect("vault media response is valid"),
            ),
            _ => no_store(empty_response(StatusCode::INTERNAL_SERVER_ERROR)),
        };
    }
    let Some((start, end)) = range_header.and_then(|value| parse_range(value, total)) else {
        return no_store(range_not_satisfiable(total));
    };
    let end = end.min(start.saturating_add(PLAYBACK_CHUNK_LIMIT - 1));
    let length = end - start + 1;
    match media.read_range(start, length) {
        Ok(bytes) if bytes.len() as u64 == length => no_store(
            Response::builder()
                .status(StatusCode::PARTIAL_CONTENT)
                .header(CONTENT_TYPE, media.mime)
                .header(ACCEPT_RANGES, "bytes")
                .header(CONTENT_LENGTH, length.to_string())
                .header(CONTENT_RANGE, format!("bytes {start}-{end}/{total}"))
                .body(bytes)
                .expect("vault range response is valid"),
        ),
        _ => no_store(empty_response(StatusCode::INTERNAL_SERVER_ERROR)),
    }
}

fn no_store(mut response: Response<Vec<u8>>) -> Response<Vec<u8>> {
    response.headers_mut().insert(
        CACHE_CONTROL,
        tauri::http::HeaderValue::from_static("no-store"),
    );
    response
}

pub(crate) fn parse_range(value: &str, total: u64) -> Option<(u64, u64)> {
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
    // Collections authority also materializes artworks under `source-<sha256>` ids.
    let authority_artwork = matches!(route, "work-artwork" | "work-artwork-thumbnail")
        && crate::library::work_artwork::is_authority_source_artwork_id(&asset_id);
    if uuid::Uuid::parse_str(&asset_id).is_err() && !authority_artwork {
        return None;
    }
    let (variant, file_name) = match route {
        "asset" if segments.next().is_none() => (MediaVariant::Asset, None),
        "trash-thumbnail" if segments.next().is_none() => (MediaVariant::TrashThumbnail, None),
        "thumbnail" => {
            if let Some(segment) = segments.next() {
                url_revision_number(segment)?;
                if segments.next().is_some() {
                    return None;
                }
            }
            (MediaVariant::Thumbnail, None)
        },
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
            if segments.next().is_some() || !is_single_file_name(&file_name) {
                return None;
            }
            (MediaVariant::CollectionCover, Some(file_name))
        }
        "collection-cover-thumbnail" => {
            let file_name = percent_decode(segments.next()?)?;
            if segments.next().is_some() || !is_single_file_name(&file_name) {
                return None;
            }
            (MediaVariant::CollectionCoverThumbnail, Some(file_name))
        }
        "collection-source-preview" if segments.next().is_none() => {
            (MediaVariant::CollectionSourcePreview, None)
        }
        "collection-source-thumbnail" if segments.next().is_none() => {
            (MediaVariant::CollectionSourceThumbnail, None)
        }
        "work-artwork" if segments.next().is_none() => (MediaVariant::WorkArtwork, None),
        "work-artwork-thumbnail" => match (segments.next(), segments.next()) {
            (None, None) => (MediaVariant::WorkArtworkThumbnail, None),
            (Some("spine"), None) => (MediaVariant::WorkArtworkSpine, None),
            _ => return None,
        },
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
            if let Some(segment) = segments.next() {
                url_revision_number(segment)?;
                if segments.next().is_some() {
                    return None;
                }
            }
            (MediaVariant::ScrubFrame(frame_index), None)
        }
        _ => return None,
    };
    Some((variant, asset_id, file_name))
}

/// The digits of a `v<digits>` revision segment.
fn url_revision_number(segment: &str) -> Option<&str> {
    let number = segment.strip_prefix('v')?;
    (!number.is_empty() && number.bytes().all(|byte| byte.is_ascii_digit())).then_some(number)
}

/// The revision a `/thumbnail/<id>/v<n>` or `/scrub-frame/<id>/<frame>/v<n>` URL carries.
/// Only call after `parse_path` accepted the path: an Asset id (a UUID) or a frame index
/// never starts with `v`, so a final `v<digits>` segment can only be the revision.
fn requested_revision(path: &str) -> Option<&str> {
    url_revision_number(path.rsplit('/').next()?)
}

/// Thumbnails and scrub frames are cached by the WebView only under a URL whose revision
/// still names the file being served (see `models::thumbnail_revision`); then repeats never
/// reach this handler or the database. Anything else keeps its previous policy: no-store
/// for thumbnails (regenerated in place under an unrevisioned URL), none for scrub frames.
fn library_media_cache_control(
    variant: MediaVariant,
    requested_revision: Option<&str>,
    current_revision: Option<&str>,
    length: u64,
) -> Option<&'static str> {
    match (variant, requested_revision) {
        (MediaVariant::Thumbnail | MediaVariant::ScrubFrame(_), Some(requested)) => {
            // An empty body is never frozen: install_thumbnail can still replace an
            // empty leftover file under the same content-addressed path.
            if Some(requested) == current_revision && length > 0 {
                Some(IMMUTABLE_CACHE_CONTROL)
            } else {
                Some("no-store")
            }
        }
        (MediaVariant::Thumbnail, None) => Some("no-store"),
        (MediaVariant::WorkArtworkSpine, _) => Some(PREVIEW_CACHE_CONTROL),
        _ => None,
    }
}

const IMMUTABLE_CACHE_CONTROL: &str = "private, max-age=31536000, immutable";

fn is_single_file_name(value: &str) -> bool {
    !value.is_empty() && value != "." && value != ".." && !value.contains(['/', '\\'])
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
#[path = "media_protocol_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "media_protocol_encrypted_vault_tests.rs"]
mod encrypted_vault_tests;
