use std::{
    io::{Read, Seek, SeekFrom},
    sync::{Condvar, Mutex, MutexGuard, PoisonError, OnceLock},
    time::Duration,
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

/// 미디어 응답의 동시 실행 수를 제한한다. 썸네일 생성처럼 원본 이미지를
/// 디코딩하는 요청이 수백 개 동시에 들어와도 메모리와 CPU가 폭증하지 않게 한다.
const MEDIA_MAX_CONCURRENT: usize = 6;
static MEDIA_ACTIVE: Mutex<usize> = Mutex::new(0);
static MEDIA_AVAILABLE: Condvar = Condvar::new();

/// 로컬 파일을 읽지 않고 외부 네트워크만 오가는 라우트. 20~60초 걸릴 수
/// 있어 로컬 미디어의 6슬롯 퍼밋을 점유하면 썸네일·재생 전반이 정체되므로
/// 퍼밋 밖에서 실행한다.
fn is_remote_media_path(path: &str) -> bool {
    ["/igdb-image-preview/", "/tmdb-image-preview/", "/remote-manga-", "/remote-catalog-thumbnail/"]
        .iter()
        .any(|prefix| path.starts_with(prefix))
        || path.starts_with("/mangadex-cover-preview/")
}

pub(crate) fn media_response_gated(
    library: Option<&Library>,
    method: &Method,
    path: &str,
    range_header: Option<&str>,
) -> Response<Vec<u8>> {
    // MangaDex 커버는 parse_path 통과 후에 식별되므로 접두어로 직접 판정한다.
    with_media_permit(path, || media_response_with_range(library, method, path, range_header))
}

fn with_media_permit<T>(path: &str, work: impl FnOnce() -> T) -> T {
    let _permit = (!is_remote_media_path(path)).then(MediaPermit::acquire);
    work()
}

struct MediaPermit;

impl MediaPermit {
    fn acquire() -> MediaPermit {
        let mut active = lock_media_active();
        while *active >= MEDIA_MAX_CONCURRENT {
            active = MEDIA_AVAILABLE
                .wait(active)
                .unwrap_or_else(PoisonError::into_inner);
        }
        *active += 1;
        MediaPermit
    }
}

impl Drop for MediaPermit {
    fn drop(&mut self) {
        let mut active = lock_media_active();
        *active -= 1;
        MEDIA_AVAILABLE.notify_one();
    }
}

fn lock_media_active() -> MutexGuard<'static, usize> {
    MEDIA_ACTIVE.lock().unwrap_or_else(PoisonError::into_inner)
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
            if media.file.read_to_end(&mut bytes).is_err() {
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
    let size = match variant {
        MediaVariant::IgdbImagePreviewCover => IgdbImageSize::CoverBig,
        MediaVariant::IgdbImagePreviewHero => IgdbImageSize::Hd720p,
        _ => return empty_response(StatusCode::BAD_REQUEST),
    };
    let Ok(url) = IgdbClient::image_url(image_id, size) else {
        return empty_response(StatusCode::BAD_REQUEST);
    };
    let response = igdb_image_agent().get(&url).call();
    let mut response = match response {
        Ok(response) => response,
        Err(ureq::Error::StatusCode(404)) => return empty_response(StatusCode::NOT_FOUND),
        Err(ureq::Error::StatusCode(429)) => return empty_response(StatusCode::TOO_MANY_REQUESTS),
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
    Response::builder()
        .status(StatusCode::OK)
        .header(CONTENT_TYPE, "image/jpeg")
        .header("Cache-Control", "private, max-age=86400")
        .header(CONTENT_LENGTH, bytes.len().to_string())
        .body(bytes)
        .expect("IGDB image response is valid")
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
    let size = match variant {
        MediaVariant::TmdbImagePreviewPoster => TmdbImageSize::W342,
        MediaVariant::TmdbImagePreviewBackdrop => TmdbImageSize::W780,
        _ => return empty_response(StatusCode::BAD_REQUEST),
    };
    let Ok(url) = TmdbClient::image_url(file_path, size) else {
        return empty_response(StatusCode::BAD_REQUEST);
    };
    let response = tmdb_image_agent().get(&url).call();
    let mut response = match response {
        Ok(response) => response,
        Err(ureq::Error::StatusCode(404)) => return empty_response(StatusCode::NOT_FOUND),
        Err(ureq::Error::StatusCode(429)) => return empty_response(StatusCode::TOO_MANY_REQUESTS),
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
    Response::builder()
        .status(StatusCode::OK)
        .header(CONTENT_TYPE, tmdb_image_mime(file_path))
        .header("Cache-Control", "private, max-age=86400")
        .header(CONTENT_LENGTH, bytes.len().to_string())
        .body(bytes)
        .expect("TMDB image response is valid")
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
    if uuid::Uuid::parse_str(&asset_id).is_err() {
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

    use image::{DynamicImage, ImageFormat};
    use rusqlite::params;
    use tauri::http::{
        header::{ACCEPT_RANGES, CACHE_CONTROL, CONTENT_LENGTH, CONTENT_RANGE, CONTENT_TYPE},
        Method, Response, StatusCode,
    };

    use crate::library::{error::LibraryError, models::thumbnail_revision, Library, MediaVariant};

    use super::{
        media_response, media_response_with_range, parse_catalog_thumbnail_path,
        parse_media_path, parse_path, parse_remote_manga_path,
    };

    const ASSET_ID: &str = "00000000-0000-4000-8000-000000000001";
    const MISSING_ID: &str = "00000000-0000-4000-8000-000000000002";
    const REVIEW_ID: &str = "00000000-0000-4000-8000-000000000003";
    const TRASH_ID: &str = "00000000-0000-4000-8000-000000000004";
    const SERIES_ID: &str = "00000000-0000-4000-8000-000000000005";
    const COLLECTION_ID: &str = "00000000-0000-4000-8000-000000000006";
    const ARTWORK_ID: &str = "00000000-0000-4000-8000-000000000007";

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

        let thumbnail = media_response(
            Some(&library),
            &Method::GET,
            &format!("/work-artwork-thumbnail/{ARTWORK_ID}"),
        );
        assert_eq!(thumbnail.status(), StatusCode::OK);
        assert_eq!(thumbnail.headers()[CONTENT_TYPE], "image/webp");
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
mod permit_tests {
    #[test]
    fn twelve_local_jobs_hold_six_slots_through_work_and_release_on_errors() {
        use std::sync::{Arc, Mutex, Condvar, mpsc};
        use std::time::Duration;
        let release = Arc::new((Mutex::new(false),Condvar::new()));
        let (entered, receive) = mpsc::channel();
        let mut jobs = Vec::new();
        for i in 0..12 {
            let release = release.clone(); let entered = entered.clone();
            jobs.push(std::thread::spawn(move || super::with_media_permit("/asset/local", || {
                entered.send(i).unwrap();
                let (lock, notify) = &*release;
                let mut ready = lock.lock().unwrap();
                while !*ready { ready = notify.wait(ready).unwrap(); }
                if i % 2 == 0 { Ok(()) } else { Err(()) }
            })));
        }
        for _ in 0..6 { receive.recv_timeout(Duration::from_secs(5)).unwrap(); }
        assert!(receive.recv_timeout(Duration::from_millis(100)).is_err());
        assert_eq!(super::with_media_permit("/remote-manga-page/x", || 7),7);
        *release.0.lock().unwrap() = true; release.1.notify_all();
        for job in jobs { let _ = job.join().unwrap(); }
        assert_eq!(*super::lock_media_active(),0);
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
