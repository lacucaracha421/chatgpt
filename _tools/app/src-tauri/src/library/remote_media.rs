use std::{
    collections::{HashMap, HashSet},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Condvar, Mutex, OnceLock},
    time::Duration,
};

use super::{
    error::LibraryError,
    online_catalog::validated_thumbnail_url,
    remote_gallery::{manifest_path, RemoteGalleryManifest, RemotePageDescriptor},
};

const MAX_REMOTE_IMAGE_BYTES: usize = 100 * 1024 * 1024;
/// Bound concurrent outbound thumbnail fetches to `ehgt.org`, matching the tablet's six-slot cap.
const MAX_CATALOG_THUMB_CONCURRENCY: usize = 6;

pub(crate) struct RemoteMedia {
    pub(crate) bytes: Vec<u8>,
    pub(crate) mime: &'static str,
}

pub(crate) fn clear_remote_cache(root: &Path) -> Result<(), LibraryError> {
    let root = std::fs::canonicalize(root).map_err(|source| LibraryError::ReadMedia {
        path: root.into(),
        source,
    })?;
    let cache_parent = root.join("cache");
    if cache_parent.exists()
        && std::fs::symlink_metadata(&cache_parent)
            .map_err(|source| LibraryError::ReadMedia {
                path: cache_parent.clone(),
                source,
            })?
            .file_type()
            .is_symlink()
    {
        return Err(LibraryError::UnsafeMediaPath);
    }
    std::fs::create_dir_all(&cache_parent).map_err(|source| LibraryError::WriteAsset {
        path: cache_parent.clone(),
        source,
    })?;
    let cache_parent =
        std::fs::canonicalize(&cache_parent).map_err(|source| LibraryError::ReadMedia {
            path: cache_parent.clone(),
            source,
        })?;
    if cache_parent != root.join("cache") {
        return Err(LibraryError::UnsafeMediaPath);
    }
    let cache = cache_parent.join("remote-manga");
    if cache.exists() {
        if std::fs::symlink_metadata(&cache)
            .map_err(|source| LibraryError::ReadMedia {
                path: cache.clone(),
                source,
            })?
            .file_type()
            .is_symlink()
        {
            return Err(LibraryError::UnsafeMediaPath);
        }
        let resolved = std::fs::canonicalize(&cache).map_err(|source| LibraryError::ReadMedia {
            path: cache.clone(),
            source,
        })?;
        if resolved != cache || !resolved.starts_with(&root) {
            return Err(LibraryError::UnsafeMediaPath);
        }
        std::fs::remove_dir_all(&cache).map_err(|source| LibraryError::WriteAsset {
            path: cache.clone(),
            source,
        })?;
    }
    std::fs::create_dir_all(&cache).map_err(|source| LibraryError::WriteAsset {
        path: cache,
        source,
    })
}

pub(crate) fn load_remote_page(
    root: &Path,
    work_id: u64,
    page: u32,
) -> Result<RemoteMedia, LibraryError> {
    load_remote_page_with(root, work_id, page, fetch_remote_image)
}

fn load_remote_page_with<F>(
    root: &Path,
    work_id: u64,
    page: u32,
    fetch: F,
) -> Result<RemoteMedia, LibraryError>
where
    F: FnOnce(&RemotePageDescriptor) -> Result<Vec<u8>, LibraryError>,
{
    let cache_path = root
        .join("cache/remote-manga/pages")
        .join(work_id.to_string())
        .join(format!("{page}.bin"));
    if let Ok(bytes) = std::fs::read(&cache_path) {
        let mime = image_mime(&bytes).ok_or(LibraryError::UnsupportedImage)?;
        return Ok(RemoteMedia { bytes, mime });
    }
    let index = page.checked_sub(1).ok_or(LibraryError::MediaNotFound)? as usize;
    let manifest: RemoteGalleryManifest = serde_json::from_slice(
        &std::fs::read(manifest_path(root, work_id)).map_err(|_| LibraryError::MediaNotFound)?,
    )
    .map_err(|_| LibraryError::InvalidRemoteGallery)?;
    if manifest.work_id != work_id.to_string()
        || manifest.provider != super::remote_gallery::REMOTE_GALLERY_PROVIDER
    {
        return Err(LibraryError::InvalidRemoteGallery);
    }
    let descriptor = manifest
        .pages
        .get(index)
        .ok_or(LibraryError::MediaNotFound)?;
    if descriptor
        .expires_at
        .is_some_and(|expires| expires - 60 <= chrono::Utc::now().timestamp())
    {
        return Err(LibraryError::RemoteGalleryUnavailable);
    }
    let bytes = fetch(descriptor)?;
    publish_cached_image(&cache_path, bytes)
}

#[derive(Default)]
struct CatalogThumbState {
    active: usize,
    next_seq: u64,
    in_flight: HashSet<PathBuf>,
    /// Uncached keys waiting for a network slot, mapped to `(latest_seq, waiter_count)`.
    waiters: HashMap<PathBuf, (u64, usize)>,
}

impl CatalogThumbState {
    fn drop_waiter(&mut self, cache_path: &Path) {
        if let Some(entry) = self.waiters.get_mut(cache_path) {
            if entry.1 <= 1 {
                self.waiters.remove(cache_path);
            } else {
                entry.1 -= 1;
            }
        }
    }

    fn is_newest_waiter(&self, cache_path: &Path) -> bool {
        let Some(&(target_seq, _)) = self.waiters.get(cache_path) else {
            return false;
        };
        self.waiters.values().all(|&(seq, _)| seq <= target_seq)
    }
}

struct CatalogThumbLimiter {
    limit: usize,
    state: Mutex<CatalogThumbState>,
    ready: Condvar,
}

impl CatalogThumbLimiter {
    fn new(limit: usize) -> Self {
        Self {
            limit: limit.max(1),
            state: Mutex::new(CatalogThumbState::default()),
            ready: Condvar::new(),
        }
    }

    fn global() -> &'static Self {
        static LIMITER: OnceLock<CatalogThumbLimiter> = OnceLock::new();
        LIMITER.get_or_init(|| Self::new(MAX_CATALOG_THUMB_CONCURRENCY))
    }

    #[cfg(test)]
    fn waiting_keys(&self) -> usize {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .waiters
            .len()
    }

    /// Wait until either no other request is downloading `key`, then acquire a network slot
    /// only if the file is still absent on disk. Saturated queues wake the newest request first
    /// so covers currently on screen do not wait behind cards already scrolled past.
    fn acquire_if_uncached(&self, cache_path: &Path) -> Option<CatalogThumbGuard<'_>> {
        let mut guard = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut registered = false;
        loop {
            if guard.in_flight.contains(cache_path) {
                if registered {
                    guard.drop_waiter(cache_path);
                    registered = false;
                }
                guard = self
                    .ready
                    .wait(guard)
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                continue;
            }
            if cache_path.is_file() {
                if registered {
                    guard.drop_waiter(cache_path);
                    if guard.active < self.limit && !guard.waiters.is_empty() {
                        self.ready.notify_all();
                    }
                }
                return None;
            }
            if !registered && guard.active < self.limit && guard.waiters.is_empty() {
                guard.active += 1;
                guard.in_flight.insert(cache_path.to_path_buf());
                return Some(CatalogThumbGuard {
                    limiter: self,
                    key: cache_path.to_path_buf(),
                });
            }
            if !registered {
                guard.next_seq += 1;
                let seq = guard.next_seq;
                let entry = guard
                    .waiters
                    .entry(cache_path.to_path_buf())
                    .or_insert((seq, 0));
                entry.0 = seq;
                entry.1 += 1;
                registered = true;
            }
            if guard.active < self.limit && guard.is_newest_waiter(cache_path) {
                guard.waiters.remove(cache_path);
                guard.active += 1;
                guard.in_flight.insert(cache_path.to_path_buf());
                if guard.active < self.limit && !guard.waiters.is_empty() {
                    self.ready.notify_all();
                }
                return Some(CatalogThumbGuard {
                    limiter: self,
                    key: cache_path.to_path_buf(),
                });
            }
            guard = self
                .ready
                .wait(guard)
                .unwrap_or_else(std::sync::PoisonError::into_inner);
        }
    }
}

struct CatalogThumbGuard<'a> {
    limiter: &'a CatalogThumbLimiter,
    key: PathBuf,
}

impl Drop for CatalogThumbGuard<'_> {
    fn drop(&mut self) {
        let mut guard = self
            .limiter
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        guard.active = guard.active.saturating_sub(1);
        guard.in_flight.remove(&self.key);
        self.limiter.ready.notify_all();
    }
}

/// 카탈로그 표지(게시판 썸네일)를 `cache/remote-manga/catalog-thumbs`에
/// 디스크 캐시한다. kHentai 검색 결과 카드가 CDN 직접 URL 대신 이 캐시를 쓴다.
pub(crate) fn load_catalog_thumbnail(
    root: &Path,
    identity: &super::catalog_provider::CatalogWorkIdentity,
    url: &str,
) -> Result<RemoteMedia, LibraryError> {
    load_catalog_thumbnail_with(root, identity, url, fetch_catalog_thumbnail_bytes)
}

fn load_catalog_thumbnail_with<F>(
    root: &Path,
    identity: &super::catalog_provider::CatalogWorkIdentity,
    url: &str,
    fetch: F,
) -> Result<RemoteMedia, LibraryError>
where
    F: FnMut(&str) -> Result<Vec<u8>, LibraryError>,
{
    load_catalog_thumbnail_with_limiter(CatalogThumbLimiter::global(), root, identity, url, fetch)
}

fn load_catalog_thumbnail_with_limiter<F>(
    limiter: &CatalogThumbLimiter,
    root: &Path,
    identity: &super::catalog_provider::CatalogWorkIdentity,
    url: &str,
    mut fetch: F,
) -> Result<RemoteMedia, LibraryError>
where
    F: FnMut(&str) -> Result<Vec<u8>, LibraryError>,
{
    // URL은 카탈로그 DB에서 검증된 ehgt.org 값만 들어온다(online_catalog::validated_thumbnail_url).
    let digest = format!("{:x}", url_hash(url.as_bytes()));
    let cache_path = root
        .join("cache/remote-manga/catalog-thumbs")
        .join(identity.provider.as_str())
        .join(format!("{}-{digest}.bin", identity.provider_work_id));
    if let Ok(bytes) = std::fs::read(&cache_path) {
        let mime = image_mime(&bytes).ok_or(LibraryError::UnsupportedImage)?;
        return Ok(RemoteMedia { bytes, mime });
    }
    let _permit = limiter.acquire_if_uncached(&cache_path);
    if let Ok(bytes) = std::fs::read(&cache_path) {
        let mime = image_mime(&bytes).ok_or(LibraryError::UnsupportedImage)?;
        return Ok(RemoteMedia { bytes, mime });
    }
    let bytes = fetch(url)?;
    publish_cached_image(&cache_path, bytes)
}

fn fetch_catalog_thumbnail_bytes(url: &str) -> Result<Vec<u8>, LibraryError> {
    let mut last_error = LibraryError::RemoteGalleryUnavailable;
    for attempt in 0..2 {
        match fetch_catalog_thumbnail_once(url) {
            Ok(bytes) => return Ok(bytes),
            Err(LibraryError::MediaNotFound) => return Err(LibraryError::MediaNotFound),
            Err(LibraryError::UnsupportedImage) => return Err(LibraryError::UnsupportedImage),
            Err(error) => {
                last_error = error;
                if attempt == 0 {
                    std::thread::sleep(Duration::from_millis(350));
                }
            }
        }
    }
    Err(last_error)
}

fn fetch_catalog_thumbnail_once(initial_url: &str) -> Result<Vec<u8>, LibraryError> {
    let mut current = initial_url.to_owned();
    for _ in 0..3 {
        let mut response = catalog_thumb_agent()
            .get(&current)
            .header(
                "User-Agent",
                format!("Lakomics/{}", env!("CARGO_PKG_VERSION")),
            )
            .call()
            .map_err(|_| LibraryError::RemoteGalleryUnavailable)?;
        let status = response.status().as_u16();
        if matches!(status, 301 | 302 | 303 | 307 | 308) {
            let location = response
                .headers()
                .get("location")
                .and_then(|value| value.to_str().ok())
                .ok_or(LibraryError::RemoteGalleryUnavailable)?;
            let next = url::Url::parse(&current)
                .and_then(|base| base.join(location))
                .map_err(|_| LibraryError::RemoteGalleryUnavailable)?;
            current = validated_thumbnail_url(Some(next.to_string()))
                .ok_or(LibraryError::RemoteGalleryUnavailable)?;
            continue;
        }
        if matches!(status, 404 | 410) {
            return Err(LibraryError::MediaNotFound);
        }
        if status != 200 {
            return Err(LibraryError::RemoteGalleryUnavailable);
        }
        let mut bytes = Vec::new();
        response
            .body_mut()
            .as_reader()
            .take((MAX_REMOTE_IMAGE_BYTES + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|_| LibraryError::RemoteGalleryUnavailable)?;
        if bytes.len() > MAX_REMOTE_IMAGE_BYTES {
            return Err(LibraryError::UnsupportedImage);
        }
        return Ok(bytes);
    }
    Err(LibraryError::RemoteGalleryUnavailable)
}

fn catalog_thumb_agent() -> &'static ureq::Agent {
    static AGENT: OnceLock<ureq::Agent> = OnceLock::new();
    AGENT.get_or_init(|| {
        ureq::Agent::config_builder()
            .https_only(true)
            .max_redirects(0)
            .http_status_as_error(false)
            .timeout_global(Some(Duration::from_secs(30)))
            .build()
            .into()
    })
}

fn publish_cached_image(cache_path: &Path, bytes: Vec<u8>) -> Result<RemoteMedia, LibraryError> {
    let mime = image_mime(&bytes).ok_or(LibraryError::UnsupportedImage)?;
    let write_error = |source| LibraryError::WriteAsset {
        path: cache_path.into(),
        source,
    };
    let parent = cache_path
        .parent()
        .expect("remote image cache has a parent");
    std::fs::create_dir_all(parent).map_err(write_error)?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent).map_err(write_error)?;
    temporary.write_all(&bytes).map_err(write_error)?;
    match temporary.persist_noclobber(cache_path) {
        Ok(_) => Ok(RemoteMedia { bytes, mime }),
        Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => {
            // Another request published first. Drop our private temporary file and
            // return the same complete image that future cache hits will receive.
            let bytes = std::fs::read(cache_path).map_err(|source| LibraryError::ReadMedia {
                path: cache_path.into(),
                source,
            })?;
            let mime = image_mime(&bytes).ok_or(LibraryError::UnsupportedImage)?;
            Ok(RemoteMedia { bytes, mime })
        }
        Err(error) => Err(write_error(error.error)),
    }
}

fn url_hash(bytes: &[u8]) -> u128 {
    // 보안 해시가 필요한 자리가 아니라 캐시 파일명 용도다. FNV-1a 128비트 변형.
    let mut hash: u128 = 0xcbf2_9ce4_8422_2325_9368_93ba_a7d3_c8d4;
    for &byte in bytes {
        hash ^= byte as u128;
        hash = hash.wrapping_mul(0x1000_0000_0000_0000_0000_0000_0000_013b);
    }
    hash
}

fn fetch_remote_image(descriptor: &RemotePageDescriptor) -> Result<Vec<u8>, LibraryError> {
    let mut response = image_agent()
        .get(&descriptor.url)
        .header(
            "User-Agent",
            format!("Lakomics/{}", env!("CARGO_PKG_VERSION")),
        )
        .call()
        .map_err(|_| LibraryError::RemoteGalleryUnavailable)?;
    let mut bytes = Vec::new();
    response
        .body_mut()
        .as_reader()
        .take((MAX_REMOTE_IMAGE_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| LibraryError::RemoteGalleryUnavailable)?;
    if bytes.len() > MAX_REMOTE_IMAGE_BYTES {
        return Err(LibraryError::UnsupportedImage);
    }
    Ok(bytes)
}

fn image_agent() -> &'static ureq::Agent {
    static AGENT: OnceLock<ureq::Agent> = OnceLock::new();
    AGENT.get_or_init(|| {
        ureq::Agent::config_builder()
            .https_only(true)
            .max_redirects(0)
            .timeout_global(Some(Duration::from_secs(60)))
            .build()
            .into()
    })
}

fn image_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else if bytes.len() >= 12 && &bytes[4..8] == b"ftyp" && &bytes[8..12] == b"avif" {
        Some("image/avif")
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use std::{cell::Cell, io::Cursor};

    use image::{DynamicImage, ImageFormat};

    use super::{
        clear_remote_cache, load_catalog_thumbnail_with, load_catalog_thumbnail_with_limiter,
        load_remote_page_with, CatalogThumbLimiter,
    };
    use crate::library::catalog_provider::CatalogWorkIdentity;
    use crate::library::remote_gallery::{
        parse_khentai_gallery, write_manifest, RemoteGalleryManifest,
    };

    fn fixture() -> (tempfile::TempDir, Vec<u8>) {
        let root = tempfile::tempdir().unwrap();
        let html = r#"<script>const gallery = {"files":[{"name":"1.webp","image":{"url":"https://a.siam-cdn.net/1.webp"}}]};</script>"#;
        let manifest = RemoteGalleryManifest::khentai(42, parse_khentai_gallery(html).unwrap());
        write_manifest(root.path(), &manifest).unwrap();
        let mut png = Cursor::new(Vec::new());
        DynamicImage::new_rgb8(2, 2)
            .write_to(&mut png, ImageFormat::Png)
            .unwrap();
        (root, png.into_inner())
    }

    #[test]
    fn caches_a_valid_remote_image_after_the_first_fetch() {
        let (root, png) = fixture();
        let calls = Cell::new(0);
        let first = load_remote_page_with(root.path(), 42, 1, |_| {
            calls.set(calls.get() + 1);
            Ok(png.clone())
        })
        .unwrap();
        let second = load_remote_page_with(root.path(), 42, 1, |_| {
            calls.set(calls.get() + 1);
            Ok(Vec::new())
        })
        .unwrap();

        assert_eq!(calls.get(), 1);
        assert_eq!(first.bytes, second.bytes);
        assert_eq!(first.mime, "image/png");
    }

    #[test]
    fn reuses_a_cache_published_while_another_fetch_is_in_flight() {
        let (root, png) = fixture();
        let mut published = png.clone();
        published.extend_from_slice(b"published first");
        let result = load_remote_page_with(root.path(), 42, 1, |_| {
            load_remote_page_with(root.path(), 42, 1, |_| Ok(published.clone()))?;
            Ok(png)
        })
        .unwrap();
        assert_eq!(result.bytes, published);
        assert_eq!(
            std::fs::read(root.path().join("cache/remote-manga/pages/42/1.bin")).unwrap(),
            published
        );
    }

    #[test]
    fn concurrent_uncached_requests_all_read_the_published_image() {
        let (root, png) = fixture();
        let barrier = std::sync::Barrier::new(8);
        std::thread::scope(|scope| {
            let requests: Vec<_> = (0..8)
                .map(|index| {
                    let (root, png, barrier) = (&root, &png, &barrier);
                    scope.spawn(move || {
                        load_remote_page_with(root.path(), 42, 1, |_| {
                            barrier.wait();
                            let mut bytes = png.clone();
                            bytes.push(index);
                            Ok(bytes)
                        })
                    })
                })
                .collect();
            let images: Vec<_> = requests
                .into_iter()
                .map(|r| r.join().unwrap().unwrap())
                .collect();
            let directory = root.path().join("cache/remote-manga/pages/42");
            let published = std::fs::read(directory.join("1.bin")).unwrap();
            assert!(images
                .iter()
                .all(|image| image.bytes == published && image.mime == "image/png"));
            assert_eq!(std::fs::read_dir(directory).unwrap().count(), 1);
        });
    }

    #[test]
    fn rejects_non_image_data_without_caching_it() {
        let (root, _) = fixture();
        assert!(
            load_remote_page_with(root.path(), 42, 1, |_| Ok(b"not an image".to_vec())).is_err()
        );
        assert!(!root
            .path()
            .join("cache/remote-manga/pages/42/1.bin")
            .exists());
    }

    #[test]
    fn rejects_zero_and_out_of_range_pages() {
        let (root, png) = fixture();
        assert!(load_remote_page_with(root.path(), 42, 0, |_| Ok(png.clone())).is_err());
        assert!(load_remote_page_with(root.path(), 42, 2, |_| Ok(png.clone())).is_err());
    }

    #[test]
    fn clears_only_the_remote_manga_cache_and_recreates_it() {
        let root = tempfile::tempdir().unwrap();
        let remote = root.path().join("cache/remote-manga");
        std::fs::create_dir_all(&remote).unwrap();
        std::fs::write(remote.join("page.bin"), b"page").unwrap();
        std::fs::write(root.path().join("keep.txt"), b"keep").unwrap();

        clear_remote_cache(root.path()).unwrap();

        assert!(remote.is_dir());
        assert!(!remote.join("page.bin").exists());
        assert!(root.path().join("keep.txt").is_file());
    }

    #[cfg(windows)]
    #[test]
    fn rejects_a_remote_cache_link_to_an_internal_directory() {
        use std::os::windows::fs::symlink_dir;

        let root = tempfile::tempdir().unwrap();
        let assets = root.path().join("assets");
        let cache_parent = root.path().join("cache");
        std::fs::create_dir_all(&assets).unwrap();
        std::fs::create_dir_all(&cache_parent).unwrap();
        std::fs::write(assets.join("keep.txt"), b"keep").unwrap();
        if symlink_dir(&assets, cache_parent.join("remote-manga")).is_err() {
            return;
        }

        assert!(clear_remote_cache(root.path()).is_err());
        assert!(assets.join("keep.txt").is_file());
    }

    #[cfg(windows)]
    #[test]
    fn rejects_a_cache_parent_link_to_an_internal_directory() {
        use std::os::windows::fs::symlink_dir;

        let root = tempfile::tempdir().unwrap();
        let assets = root.path().join("assets");
        std::fs::create_dir_all(assets.join("remote-manga")).unwrap();
        std::fs::write(assets.join("remote-manga/keep.txt"), b"keep").unwrap();
        if symlink_dir(&assets, root.path().join("cache")).is_err() {
            return;
        }

        assert!(clear_remote_cache(root.path()).is_err());
        assert!(assets.join("remote-manga/keep.txt").is_file());
    }

    #[test]
    fn concurrent_catalog_thumbnail_requests_share_one_network_fetch() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let (root, png) = fixture();
        let identity = CatalogWorkIdentity::khentai(99);
        let url = "https://ehgt.org/w/00/099/cover.png";
        let calls = AtomicUsize::new(0);
        let barrier = std::sync::Barrier::new(6);
        std::thread::scope(|scope| {
            let handles: Vec<_> = (0..6)
                .map(|_| {
                    let (root, identity, png, calls, barrier) =
                        (&root, &identity, &png, &calls, &barrier);
                    scope.spawn(move || {
                        barrier.wait();
                        load_catalog_thumbnail_with(root.path(), identity, url, |_| {
                            calls.fetch_add(1, Ordering::SeqCst);
                            std::thread::sleep(std::time::Duration::from_millis(30));
                            Ok(png.clone())
                        })
                    })
                })
                .collect();
            for handle in handles {
                let media = handle.join().unwrap().unwrap();
                assert_eq!(media.bytes, png);
                assert_eq!(media.mime, "image/png");
            }
        });
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn prioritizes_most_recently_requested_catalog_thumbnails_when_saturated() {
        use std::sync::{mpsc, Mutex};

        let (root, png) = fixture();
        let limiter = CatalogThumbLimiter::new(1);
        let order = Mutex::new(Vec::new());
        let (started_tx, started_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();

        std::thread::scope(|scope| {
            let first = {
                let (limiter, root, png, order) = (&limiter, &root, &png, &order);
                scope.spawn(move || {
                    let id = CatalogWorkIdentity::khentai(1);
                    load_catalog_thumbnail_with_limiter(
                        limiter,
                        root.path(),
                        &id,
                        "https://ehgt.org/w/00/001/cover.png",
                        |_| {
                            order.lock().unwrap().push(1_u64);
                            started_tx.send(()).unwrap();
                            release_rx.recv().unwrap();
                            Ok(png.clone())
                        },
                    )
                })
            };
            started_rx.recv().unwrap();

            let mut queued = Vec::new();
            for (expected_waiting, work_id) in [(1, 2_u64), (2, 3_u64), (3, 4_u64)] {
                let (limiter, root, png, order) = (&limiter, &root, &png, &order);
                queued.push(scope.spawn(move || {
                    let id = CatalogWorkIdentity::khentai(work_id);
                    let url = format!("https://ehgt.org/w/00/{work_id:03}/cover.png");
                    load_catalog_thumbnail_with_limiter(limiter, root.path(), &id, &url, |_| {
                        order.lock().unwrap().push(work_id);
                        Ok(png.clone())
                    })
                }));
                while limiter.waiting_keys() < expected_waiting {
                    std::thread::yield_now();
                }
            }

            release_tx.send(()).unwrap();
            first.join().unwrap().unwrap();
            for handle in queued {
                handle.join().unwrap().unwrap();
            }
        });

        assert_eq!(*order.lock().unwrap(), vec![1, 4, 3, 2]);
    }
}
