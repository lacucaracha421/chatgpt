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
    if let Some(id) = path.strip_prefix("/av-link-jacket/") {
        if uuid::Uuid::parse_str(id).is_err() { return empty_response(StatusCode::BAD_REQUEST); }
        return no_store(match library.and_then(|lib| lib.av_link_jacket(id).ok()) {
            Some((bytes, mime)) => Response::builder().status(StatusCode::OK)
                .header(CONTENT_TYPE, mime).header(CONTENT_LENGTH, bytes.len().to_string())
                .body(bytes).expect("AV jacket response is valid"),
            None => empty_response(StatusCode::NOT_FOUND),
        });
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
        "work-artwork-thumbnail" if segments.next().is_none() => {
            (MediaVariant::WorkArtworkThumbnail, None)
        }
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
mod tests {
    use std::io::Cursor;
    use std::time::{Duration, SystemTime};

    use image::{DynamicImage, ImageFormat};
    use rusqlite::params;
    use tauri::http::{
        header::{ACCEPT_RANGES, CACHE_CONTROL, CONTENT_LENGTH, CONTENT_RANGE, CONTENT_TYPE},
        Method, Response, StatusCode,
    };

    use crate::library::{error::LibraryError, models::thumbnail_revision, Library, MediaVariant};

    use super::{
        cached_preview_from, media_response, media_response_with_range,
        parse_catalog_thumbnail_path, parse_media_path, parse_path, parse_remote_manga_path,
        PreviewCache, PreviewCacheKey, PreviewVariant,
    };

    const ASSET_ID: &str = "00000000-0000-4000-8000-000000000001";
    const MISSING_ID: &str = "00000000-0000-4000-8000-000000000002";
    const REVIEW_ID: &str = "00000000-0000-4000-8000-000000000003";
    const TRASH_ID: &str = "00000000-0000-4000-8000-000000000004";
    const SERIES_ID: &str = "00000000-0000-4000-8000-000000000005";
    const COLLECTION_ID: &str = "00000000-0000-4000-8000-000000000006";
    const ARTWORK_ID: &str = "00000000-0000-4000-8000-000000000007";

    fn preview_test_response(status: StatusCode, bytes: &[u8]) -> Response<Vec<u8>> {
        Response::builder()
            .status(status)
            .header(CONTENT_TYPE, "image/png")
            .body(bytes.to_vec())
            .unwrap()
    }

    #[test]
    fn preview_disk_cache_survives_memory_reset_and_separates_provider_sizes() {
        let directory = tempfile::tempdir().unwrap();
        let key = PreviewCacheKey::new(PreviewVariant::TmdbPoster, "/cover.png");
        cached_preview_from(
            &std::sync::Mutex::new(PreviewCache::new(32)),
            key.clone(),
            || {
                super::cached_preview_disk_from(Some(directory.path()), &key, || {
                    preview_test_response(StatusCode::OK, b"disk")
                })
            },
        );
        let warm = cached_preview_from(
            &std::sync::Mutex::new(PreviewCache::new(32)),
            key.clone(),
            || {
                super::cached_preview_disk_from(Some(directory.path()), &key, || {
                    panic!("warm restart must not fetch")
                })
            },
        );
        assert_eq!(warm.body(), b"disk");
        assert_eq!(warm.headers()[CONTENT_TYPE], "image/png");
        for variant in [
            PreviewVariant::TmdbBackdrop,
            PreviewVariant::IgdbCover,
            PreviewVariant::IgdbHero,
        ] {
            assert!(super::preview_disk_read(
                directory.path(),
                &PreviewCacheKey::new(variant, "/cover.png")
            )
            .is_none());
        }
    }

    #[test]
    fn preview_disk_cache_recovers_corruption_and_never_caches_failures() {
        let directory = tempfile::tempdir().unwrap();
        let key = PreviewCacheKey::new(PreviewVariant::IgdbCover, "cover");
        let path = super::preview_disk_path(directory.path(), &key);
        std::fs::write(&path, b"invalid").unwrap();
        let response = super::cached_preview_disk_from(Some(directory.path()), &key, || {
            preview_test_response(StatusCode::OK, b"recovered")
        });
        assert_eq!(response.body(), b"recovered");
        assert_eq!(
            super::preview_disk_read(directory.path(), &key)
                .unwrap()
                .body(),
            b"recovered"
        );
        let old = SystemTime::now() - super::PREVIEW_DISK_AGE - Duration::from_secs(1);
        std::fs::File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_times(std::fs::FileTimes::new().set_modified(old))
            .unwrap();
        assert!(super::preview_disk_read(directory.path(), &key).is_none());
        super::cached_preview_disk_from(Some(directory.path()), &key, || {
            preview_test_response(StatusCode::OK, b"renewed")
        });
        assert_eq!(
            super::preview_disk_read(directory.path(), &key)
                .unwrap()
                .body(),
            b"renewed"
        );
        let missing = PreviewCacheKey::new(PreviewVariant::TmdbPoster, "/missing.png");
        for _ in 0..2 {
            assert_eq!(
                super::cached_preview_disk_from(Some(directory.path()), &missing, || {
                    preview_test_response(StatusCode::NOT_FOUND, b"")
                })
                .status(),
                StatusCode::NOT_FOUND
            );
            assert!(!super::preview_disk_path(directory.path(), &missing).exists());
        }
    }

    #[test]
    fn preview_disk_cache_bounds_bytes_and_entries_without_touching_other_files() {
        let directory = tempfile::tempdir().unwrap();
        let other = directory.path().join("other.txt");
        std::fs::write(&other, b"keep").unwrap();
        for name in ["a", "b", "c"] {
            super::preview_disk_write(
                directory.path(),
                &PreviewCacheKey::new(PreviewVariant::IgdbCover, name),
                &preview_test_response(StatusCode::OK, b"123456"),
            );
        }
        super::prune_preview_disk(directory.path(), 32, 1);
        let files = std::fs::read_dir(directory.path())
            .unwrap()
            .flatten()
            .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "preview"))
            .collect::<Vec<_>>();
        assert!(files.len() <= 1);
        assert!(
            files
                .iter()
                .map(|entry| entry.metadata().unwrap().len())
                .sum::<u64>()
                <= 32
        );
        assert_eq!(std::fs::read(other).unwrap(), b"keep");
    }

    #[test]
    fn preview_cache_hit_returns_stored_bytes_without_fetching() {
        let cache = std::sync::Mutex::new(PreviewCache::new(32));
        let key = PreviewCacheKey::new(PreviewVariant::IgdbCover, "cover-1");
        let mut fetches = 0;

        cached_preview_from(&cache, key.clone(), || {
            fetches += 1;
            preview_test_response(StatusCode::OK, b"cached")
        });
        let response = cached_preview_from(&cache, key, || {
            fetches += 1;
            preview_test_response(StatusCode::OK, b"fresh")
        });

        assert_eq!(fetches, 1);
        assert_eq!(response.body(), b"cached");
        assert_eq!(response.headers()[CONTENT_TYPE], "image/png");
        assert_eq!(response.headers()[CACHE_CONTROL], "private, max-age=86400");
        assert_eq!(response.headers()[CONTENT_LENGTH], "6");
    }

    #[test]
    fn preview_cache_does_not_store_errors() {
        let cache = std::sync::Mutex::new(PreviewCache::new(32));
        let key = PreviewCacheKey::new(PreviewVariant::TmdbPoster, "poster-1");
        let mut fetches = 0;

        for _ in 0..2 {
            let response = cached_preview_from(&cache, key.clone(), || {
                fetches += 1;
                preview_test_response(StatusCode::NOT_FOUND, b"")
            });
            assert_eq!(response.status(), StatusCode::NOT_FOUND);
        }

        assert_eq!(fetches, 2);
    }

    #[test]
    fn preview_cache_evicts_the_oldest_entry_over_budget() {
        let cache = std::sync::Mutex::new(PreviewCache::new(5));
        let oldest = PreviewCacheKey::new(PreviewVariant::IgdbCover, "oldest");
        let newest = PreviewCacheKey::new(PreviewVariant::IgdbHero, "newest");

        cached_preview_from(&cache, oldest.clone(), || {
            preview_test_response(StatusCode::OK, b"123")
        });
        cached_preview_from(&cache, newest.clone(), || {
            preview_test_response(StatusCode::OK, b"456")
        });

        let newest_response = cached_preview_from(&cache, newest, || {
            panic!("the newest entry should remain cached")
        });
        assert_eq!(newest_response.body(), b"456");

        let mut refetched = 0;
        let oldest_response = cached_preview_from(&cache, oldest, || {
            refetched += 1;
            preview_test_response(StatusCode::OK, b"789")
        });
        assert_eq!(refetched, 1);
        assert_eq!(oldest_response.body(), b"789");
    }

    #[test]
    fn remote_manga_routes_accept_only_closed_numeric_paths() {
        assert_eq!(
            parse_remote_manga_path("/remote-manga-page/kHentai/42/3"),
            Some((42, 3))
        );
        assert_eq!(
            parse_remote_manga_path("/remote-manga-thumbnail/42"),
            Some((42, 1))
        );
        for path in [
            "/remote-manga-page/hitomi/42/3",
            "/remote-manga-page/kHentai/42/0",
            "/remote-manga-page/kHentai/../3",
            "/remote-manga-thumbnail/42/extra",
        ] {
            assert_eq!(parse_remote_manga_path(path), None, "{path}");
        }
    }

    #[test]
    fn catalog_thumbnail_route_requires_a_provider_qualified_identity() {
        let identity = parse_catalog_thumbnail_path("/remote-catalog-thumbnail/kHentai/42").unwrap();
        assert_eq!(identity.provider, crate::library::catalog_provider::CatalogProvider::KHentai);
        assert_eq!(identity.provider_work_id, "42");
        for path in [
            "/remote-catalog-thumbnail/42",
            "/remote-catalog-thumbnail/unknown/42",
            "/remote-catalog-thumbnail/0",
            "/remote-catalog-thumbnail/-1",
            "/remote-catalog-thumbnail/abc",
            "/remote-catalog-thumbnail/kHentai/42/extra",
            "/remote-catalog-thumbnail/",
        ] {
            assert_eq!(parse_catalog_thumbnail_path(path), None, "{path}");
        }
    }

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

    fn collection_thumbnail_library() -> (tempfile::TempDir, Library) {
        let (temp, library) = collection_source_library(false);
        let collection_dir = temp.path().join("source").join("series");
        std::fs::create_dir_all(collection_dir.join("covers")).unwrap();
        DynamicImage::new_rgb8(1200, 800)
            .save(collection_dir.join("thumbnail.png"))
            .unwrap();
        DynamicImage::new_rgb8(800, 1200)
            .save(collection_dir.join("covers").join("vol_1_cover.png"))
            .unwrap();
        (temp, library)
    }

    #[test]
    fn collection_thumbnail_routes_serve_bounded_webp() {
        let (_temp, library) = collection_thumbnail_library();

        let source = media_response(
            Some(&library),
            &Method::GET,
            &format!("/collection-source-thumbnail/{COLLECTION_ID}"),
        );
        assert_eq!(source.status(), StatusCode::OK);
        assert_eq!(source.headers()[CONTENT_TYPE], "image/webp");

        let cover = media_response(
            Some(&library),
            &Method::GET,
            &format!(
                "/collection-cover-thumbnail/{COLLECTION_ID}/vol_1_cover.png"
            ),
        );
        assert_eq!(cover.status(), StatusCode::OK);
        assert_eq!(cover.headers()[CONTENT_TYPE], "image/webp");
    }

    #[test]
    fn collection_thumbnail_routes_reject_open_or_traversal_paths() {
        let (temp, library) = collection_thumbnail_library();
        DynamicImage::new_rgb8(400, 400)
            .save(temp.path().join("source").join("series").join("outside.png"))
            .unwrap();

        for path in [
            "/collection-source-thumbnail/not-a-uuid".to_string(),
            format!("/collection-cover-thumbnail/{COLLECTION_ID}"),
            format!("/collection-cover-thumbnail/{COLLECTION_ID}/..%2Foutside.png"),
        ] {
            assert_eq!(
                media_response(Some(&library), &Method::GET, &path).status(),
                StatusCode::BAD_REQUEST,
                "{path}",
            );
        }
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
        let mut artwork_bytes = Cursor::new(Vec::new());
        DynamicImage::new_rgb8(900, 1350)
            .write_to(&mut artwork_bytes, ImageFormat::Png)
            .unwrap();
        let artwork_bytes = artwork_bytes.into_inner();
        std::fs::write(&absolute_path, &artwork_bytes).unwrap();
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
        assert_eq!(response.body(), &artwork_bytes);

        let cold_started = std::time::Instant::now();
        let thumbnail = media_response(
            Some(&library),
            &Method::GET,
            &format!("/work-artwork-thumbnail/{ARTWORK_ID}"),
        );
        let cold_elapsed = cold_started.elapsed();
        assert_eq!(thumbnail.status(), StatusCode::OK);
        assert_eq!(thumbnail.headers()[CONTENT_TYPE], "image/webp");
        let decoded = image::load_from_memory(thumbnail.body()).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (240, 360));
        // A warm request must only read the small cached file, even if the original
        // cannot be decoded. This also guards against moving resizing into the WebView.
        std::fs::write(&absolute_path, b"not an image").unwrap();
        let warm_started = std::time::Instant::now();
        for _ in 0..20 {
            let warm = media_response(
                Some(&library),
                &Method::GET,
                &format!("/work-artwork-thumbnail/{ARTWORK_ID}"),
            );
            assert_eq!(warm.status(), StatusCode::OK);
            assert_eq!(warm.body(), thumbnail.body());
        }
        eprintln!(
            "w5 fixture: cold={cold_elapsed:?}, 20 warm requests={:?}",
            warm_started.elapsed()
        );
        assert!(library
            .root()
            .join(format!(
                "work-artwork-thumbnails/{COLLECTION_ID}/{ARTWORK_ID}.webp"
            ))
            .exists());
        assert_eq!(
            media_response(
                Some(&library),
                &Method::GET,
                "/work-artwork-thumbnail/not-a-uuid",
            )
            .status(),
            StatusCode::BAD_REQUEST,
        );
        assert_eq!(
            media_response(
                Some(&library),
                &Method::GET,
                &format!("/work-artwork-thumbnail/{ARTWORK_ID}/more"),
            )
            .status(),
            StatusCode::BAD_REQUEST,
        );
    }

    #[test]
    fn authority_work_artwork_cover_is_listed_and_served() {
        // Authority preserves imported UUIDs and also creates source-<sha> IDs.
        for artwork_id in [ARTWORK_ID.to_string(), format!("source-{}", "e5".repeat(32))] {
            let (_temp, library) = collection_source_library(false);
            let relative_path = format!(
                "work-artwork/authority/{COLLECTION_ID}/{artwork_id}-{}.webp",
                "2f".repeat(32)
            );
            let path = library.root().join(&relative_path);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            let mut bytes = Cursor::new(Vec::new());
            DynamicImage::new_rgb8(300, 450)
                .write_to(&mut bytes, ImageFormat::WebP)
                .unwrap();
            std::fs::write(&path, bytes.get_ref()).unwrap();
            library.connection().unwrap().execute(
                "INSERT INTO collection_work_artworks (
                    id, collection_id, provider, provider_image_id, kind, relative_path,
                    mime_type, width, height, selected, created_at, updated_at
                 ) VALUES (?1, ?2, 'authority', ?1, 'cover', ?3,
                    'image/webp', 300, 450, 1, 't', 't')",
                params![artwork_id, COLLECTION_ID, relative_path],
            ).unwrap();
            let summary = library.list_collections().unwrap().into_iter()
                .find(|work| work.id == COLLECTION_ID).unwrap();
            assert_eq!(summary.selected_work_artwork_id.as_deref(), Some(artwork_id.as_str()));
            let original = media_response(Some(&library), &Method::GET,
                &format!("/work-artwork/{artwork_id}"));
            assert_eq!(original.status(), StatusCode::OK, "{artwork_id}");
            assert_eq!(original.body(), bytes.get_ref());
            let thumbnail = media_response(Some(&library), &Method::GET,
                &format!("/work-artwork-thumbnail/{artwork_id}"));
            assert_eq!(thumbnail.status(), StatusCode::OK, "{artwork_id}");
            assert_eq!(thumbnail.headers()[CONTENT_TYPE], "image/webp");
            let image = image::load_from_memory(thumbnail.body()).unwrap();
            assert_eq!((image.width(), image.height()), (240, 360));
            // The existing materialized thumbnail is served without opening the original.
            std::fs::remove_file(&path).unwrap();
            let warm = media_response(Some(&library), &Method::GET,
                &format!("/work-artwork-thumbnail/{artwork_id}"));
            assert_eq!(warm.status(), StatusCode::OK);
            assert_eq!(warm.body(), thumbnail.body());
        }
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
    fn parses_igdb_image_preview_routes() {
        let (variant, image_id) = parse_media_path("/igdb-image-preview/cover/co1abc").unwrap();
        assert!(matches!(variant, MediaVariant::IgdbImagePreviewCover));
        assert_eq!(image_id.as_deref(), Some("co1abc"));
        assert!(parse_media_path("/igdb-image-preview/hero/..%2Fsecret").is_err());
    }

    #[test]
    fn parses_tmdb_image_preview_routes() {
        let (variant, path) =
            parse_media_path("/tmdb-image-preview/poster/%2Fabcd1234.jpg").unwrap();
        assert!(matches!(variant, MediaVariant::TmdbImagePreviewPoster));
        assert_eq!(path.as_deref(), Some("/abcd1234.jpg"));
        let (variant, path) =
            parse_media_path("/tmdb-image-preview/backdrop/%2Fabcd1234.webp").unwrap();
        assert!(matches!(variant, MediaVariant::TmdbImagePreviewBackdrop));
        assert_eq!(path.as_deref(), Some("/abcd1234.webp"));
        assert!(parse_media_path("/tmdb-image-preview/backdrop/..%2Fsecret.jpg").is_err());
    }

    fn cache_control(response: &Response<Vec<u8>>) -> Option<&str> {
        response
            .headers()
            .get(CACHE_CONTROL)
            .and_then(|value| value.to_str().ok())
    }

    const IMMUTABLE: &str = "private, max-age=31536000, immutable";

    #[test]
    fn only_a_current_thumbnail_revision_is_served_as_immutable() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path().join("library")).unwrap();
        insert_asset(
            &library,
            ASSET_ID,
            "assets/image.png",
            "thumbnails/aa/old.webp",
        );
        std::fs::create_dir_all(library.root().join("thumbnails/aa")).unwrap();
        std::fs::write(
            library.root().join("thumbnails/aa/old.webp"),
            b"old thumbnail",
        )
        .unwrap();
        let old_revision = thumbnail_revision("thumbnails/aa/old.webp");
        let get = |path: String| media_response(Some(&library), &Method::GET, &path);

        let current = get(format!("/thumbnail/{ASSET_ID}/v{old_revision}"));
        assert_eq!(current.status(), StatusCode::OK);
        assert_eq!(current.body(), b"old thumbnail");
        assert_eq!(cache_control(&current), Some(IMMUTABLE));
        // Unrevisioned and foreign-revision URLs keep the regenerate-in-place policy.
        assert_eq!(
            cache_control(&get(format!("/thumbnail/{ASSET_ID}"))),
            Some("no-store")
        );
        assert_eq!(
            cache_control(&get(format!("/thumbnail/{ASSET_ID}/v7"))),
            Some("no-store")
        );

        // A regenerated thumbnail is a new file: the old URL no longer freezes anything and
        // the new revision names the new bytes.
        std::fs::write(
            library.root().join("thumbnails/aa/new.webp"),
            b"new thumbnail",
        )
        .unwrap();
        library
            .connection()
            .unwrap()
            .execute(
                "UPDATE assets SET thumbnail_relative_path = 'thumbnails/aa/new.webp' WHERE id = ?1",
                [ASSET_ID],
            )
            .unwrap();
        let stale = get(format!("/thumbnail/{ASSET_ID}/v{old_revision}"));
        assert_eq!(stale.body(), b"new thumbnail");
        assert_eq!(cache_control(&stale), Some("no-store"));
        let new_revision = thumbnail_revision("thumbnails/aa/new.webp");
        assert_ne!(new_revision, old_revision);
        let fresh = get(format!("/thumbnail/{ASSET_ID}/v{new_revision}"));
        assert_eq!(fresh.body(), b"new thumbnail");
        assert_eq!(cache_control(&fresh), Some(IMMUTABLE));
    }

    #[test]
    fn revisioned_thumbnails_of_trash_or_empty_files_are_never_cached() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path().join("library")).unwrap();
        std::fs::create_dir_all(library.root().join("thumbnails")).unwrap();
        insert_asset_with_status(
            &library,
            TRASH_ID,
            "assets/t.png",
            "thumbnails/t.webp",
            "trash",
        );
        std::fs::write(library.root().join("thumbnails/t.webp"), b"trashed").unwrap();
        insert_asset(&library, ASSET_ID, "assets/e.png", "thumbnails/e.webp");
        std::fs::write(library.root().join("thumbnails/e.webp"), b"").unwrap();

        let trashed = media_response(
            Some(&library),
            &Method::GET,
            &format!(
                "/thumbnail/{TRASH_ID}/v{}",
                thumbnail_revision("thumbnails/t.webp")
            ),
        );
        assert_eq!(trashed.status(), StatusCode::NOT_FOUND);
        assert_eq!(cache_control(&trashed), None);
        let empty = media_response(
            Some(&library),
            &Method::GET,
            &format!(
                "/thumbnail/{ASSET_ID}/v{}",
                thumbnail_revision("thumbnails/e.webp")
            ),
        );
        assert_eq!(empty.status(), StatusCode::OK);
        assert_eq!(cache_control(&empty), Some("no-store"));
    }

    #[test]
    fn scrub_frames_are_immutable_only_under_the_current_revision() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path().join("library")).unwrap();
        insert_prepared_video(&library, ASSET_ID, "normal");
        let revision = thumbnail_revision(&format!("video-media/{ASSET_ID}/poster.webp"));
        let get = |path: String| media_response(Some(&library), &Method::GET, &path);

        let frame = get(format!("/scrub-frame/{ASSET_ID}/0/v{revision}"));
        assert_eq!(frame.status(), StatusCode::OK);
        assert_eq!(frame.body(), b"scrub-frame");
        assert_eq!(cache_control(&frame), Some(IMMUTABLE));
        assert_eq!(
            cache_control(&get(format!("/scrub-frame/{ASSET_ID}/0/v1"))),
            Some("no-store")
        );
        assert_eq!(
            cache_control(&get(format!("/scrub-frame/{ASSET_ID}/0"))),
            None
        );
        let poster = get(format!("/thumbnail/{ASSET_ID}/v{revision}"));
        assert_eq!(poster.body(), b"poster");
        assert_eq!(cache_control(&poster), Some(IMMUTABLE));
        for path in [
            format!("/scrub-frame/{ASSET_ID}/0/7"),
            format!("/scrub-frame/{ASSET_ID}/0/v"),
            format!("/scrub-frame/{ASSET_ID}/0/v1/more"),
        ] {
            assert_eq!(
                get(path.clone()).status(),
                StatusCode::BAD_REQUEST,
                "{path}"
            );
        }
    }

    #[test]
    fn originals_and_other_library_media_keep_their_cache_policy() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path().join("library")).unwrap();
        insert_asset(
            &library,
            ASSET_ID,
            "assets/image.png",
            "thumbnails/image.webp",
        );
        std::fs::write(library.root().join("assets/image.png"), b"asset bytes").unwrap();
        let original = media_response(Some(&library), &Method::GET, &format!("/asset/{ASSET_ID}"));
        assert_eq!(original.status(), StatusCode::OK);
        assert_eq!(cache_control(&original), None);
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
    fn trash_thumbnail_route_only_exposes_trashed_thumbnails() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path().join("library")).unwrap();
        for (id, status) in [(ASSET_ID, "normal"), (REVIEW_ID, "review"), (TRASH_ID, "trash")] {
            let thumbnail = format!("thumbnails/{id}.webp");
            insert_asset_with_status(&library, id, &format!("assets/{id}.png"), &thumbnail, status);
            std::fs::write(library.root().join(thumbnail), b"thumbnail bytes").unwrap();
            let response = media_response(Some(&library), &Method::GET, &format!("/trash-thumbnail/{id}"));
            assert_eq!(response.status(), if status == "trash" { StatusCode::OK } else { StatusCode::NOT_FOUND });
            if status == "trash" { assert_eq!(response.body(), b"thumbnail bytes"); }
        }
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
    fn open_playback_range_is_bounded_by_the_chunk_limit() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path().join("library")).unwrap();
        insert_prepared_video(&library, ASSET_ID, "normal");
        // 픽스처 36바이트는 8MiB 상한보다 작다: 열린 range도 잘리지 않고
        // 전체 구간이 정확히 서빙된다(기존 동작 불변).
        let response = media_response_with_range(
            Some(&library),
            &Method::GET,
            &format!("/playback/{ASSET_ID}"),
            Some("bytes=0-1048575"),
        );
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.headers().get(CONTENT_LENGTH).unwrap(), "36");
        assert_eq!(response.headers().get(CONTENT_RANGE).unwrap(), "bytes 0-35/36");
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
            (format!("/manga-cover/{MISSING_ID}"), StatusCode::NOT_FOUND),
            (format!("/manga-page/{MISSING_ID}/1"), StatusCode::NOT_FOUND),
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
        let response = media_response(None, &Method::GET, &format!("/manga-cover/{SERIES_ID}"));
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    fn thumbnail(library: &Library, id: &str) -> Response<Vec<u8>> {
        media_response(Some(library), &Method::GET, &format!("/thumbnail/{id}"))
    }

    fn set_thumbnail(library: &Library, id: &str, relative_path: &str, bytes: &[u8]) {
        let path = library.root().join(relative_path);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, bytes).unwrap();
        library
            .connection()
            .unwrap()
            .execute(
                "UPDATE assets SET thumbnail_relative_path = ?2 WHERE id = ?1",
                params![id, relative_path],
            )
            .unwrap();
    }

    #[test]
    fn thumbnail_lookups_read_the_current_row_on_every_request() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path().join("library")).unwrap();
        insert_asset(&library, ASSET_ID, "assets/a.png", "thumbnails/aa/old.webp");
        set_thumbnail(&library, ASSET_ID, "thumbnails/aa/old.webp", b"old");
        assert_eq!(thumbnail(&library, ASSET_ID).body(), b"old");

        // A replaced thumbnail is served from the next request on.
        set_thumbnail(&library, ASSET_ID, "thumbnails/aa/new.webp", b"new");
        assert_eq!(thumbnail(&library, ASSET_ID).body(), b"new");

        // Trash hides it at once; restore brings it back.
        library.trash_assets(&[ASSET_ID.to_owned()]).unwrap();
        assert_eq!(
            thumbnail(&library, ASSET_ID).status(),
            StatusCode::NOT_FOUND
        );
        library.restore_assets(&[ASSET_ID.to_owned()]).unwrap();
        let restored = thumbnail(&library, ASSET_ID);
        assert_eq!(restored.status(), StatusCode::OK);
        assert_eq!(restored.body(), b"new");

        // Review keeps it, any other status hides it, and a deleted row is gone.
        for (status, expected) in [
            ("review", StatusCode::OK),
            ("trash", StatusCode::NOT_FOUND),
            ("normal", StatusCode::OK),
        ] {
            library
                .connection()
                .unwrap()
                .execute(
                    "UPDATE assets SET status = ?2 WHERE id = ?1",
                    params![ASSET_ID, status],
                )
                .unwrap();
            assert_eq!(thumbnail(&library, ASSET_ID).status(), expected, "{status}");
        }
        library
            .connection()
            .unwrap()
            .execute("DELETE FROM assets WHERE id = ?1", [ASSET_ID])
            .unwrap();
        assert_eq!(
            thumbnail(&library, ASSET_ID).status(),
            StatusCode::NOT_FOUND
        );
        // The reads reuse a bounded set of connections instead of opening one each.
        assert_eq!(library.media_reads_idle(), 1);
    }

    #[test]
    fn an_asset_without_a_thumbnail_answers_not_found_until_one_is_installed() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path().join("library")).unwrap();
        insert_asset(&library, ASSET_ID, "assets/v.webm", "thumbnails/v.webp");
        // Like every video in the real library: a video Asset with no poster yet.
        library
            .connection()
            .unwrap()
            .execute(
                "UPDATE assets SET media_kind = 'video', thumbnail_relative_path = NULL
                 WHERE id = ?1",
                [ASSET_ID],
            )
            .unwrap();
        for _ in 0..3 {
            let response = thumbnail(&library, ASSET_ID);
            assert_eq!(response.status(), StatusCode::NOT_FOUND);
            assert!(response.body().is_empty());
            assert_eq!(cache_control(&response), None);
        }

        set_thumbnail(&library, ASSET_ID, "thumbnails/v.webp", b"poster");
        let installed = thumbnail(&library, ASSET_ID);
        assert_eq!(installed.status(), StatusCode::OK);
        assert_eq!(installed.body(), b"poster");
    }

    #[test]
    fn thumbnail_lookups_never_cross_libraries() {
        let temp = tempfile::tempdir().unwrap();
        let first = Library::open(temp.path().join("first")).unwrap();
        let second = Library::open(temp.path().join("second")).unwrap();
        insert_asset(&first, ASSET_ID, "assets/a.png", "thumbnails/a.webp");
        set_thumbnail(&first, ASSET_ID, "thumbnails/a.webp", b"first");
        assert_eq!(thumbnail(&first, ASSET_ID).body(), b"first");
        assert_eq!(thumbnail(&second, ASSET_ID).status(), StatusCode::NOT_FOUND);

        insert_asset(&second, ASSET_ID, "assets/a.png", "thumbnails/a.webp");
        set_thumbnail(&second, ASSET_ID, "thumbnails/a.webp", b"second");
        drop(first);
        assert_eq!(thumbnail(&second, ASSET_ID).body(), b"second");
    }

    #[test]
    fn thumbnail_lookups_do_not_wait_for_the_database_lock_or_see_uncommitted_rows() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path().join("library")).unwrap();
        insert_asset(&library, ASSET_ID, "assets/a.png", "thumbnails/old.webp");
        set_thumbnail(&library, ASSET_ID, "thumbnails/old.webp", b"old");
        std::fs::write(library.root().join("thumbnails/new.webp"), b"new").unwrap();

        // Hold the database lock inside an open write transaction that replaces the thumbnail.
        let mut connection = library.connection().unwrap();
        let transaction = connection.transaction().unwrap();
        transaction
            .execute(
                "UPDATE assets SET thumbnail_relative_path = 'thumbnails/new.webp' WHERE id = ?1",
                [ASSET_ID],
            )
            .unwrap();
        let (sender, receiver) = std::sync::mpsc::channel();
        std::thread::scope(|scope| {
            for _ in 0..4 {
                let sender = sender.clone();
                let library = &library;
                scope.spawn(move || sender.send(thumbnail(library, ASSET_ID)).unwrap());
            }
            for _ in 0..4 {
                let response = receiver
                    .recv_timeout(std::time::Duration::from_secs(10))
                    .expect("a thumbnail lookup waited for the database lock");
                assert_eq!(response.status(), StatusCode::OK);
                assert_eq!(response.body(), b"old");
            }
        });
        transaction.commit().unwrap();
        drop(connection);
        assert_eq!(thumbnail(&library, ASSET_ID).body(), b"new");
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

#[cfg(test)]
mod encrypted_vault_tests {
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
}
