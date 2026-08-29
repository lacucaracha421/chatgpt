use std::{io::Read, path::Path, sync::OnceLock, time::Duration};

use super::{
    error::LibraryError,
    remote_gallery::{manifest_path, RemoteGalleryManifest, RemotePageDescriptor},
};

const MAX_REMOTE_IMAGE_BYTES: usize = 100 * 1024 * 1024;

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
    if manifest.work_id != work_id.to_string() || manifest.provider != "kHentai" {
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
    let mime = image_mime(&bytes).ok_or(LibraryError::UnsupportedImage)?;
    let parent = cache_path.parent().expect("remote page cache has a parent");
    std::fs::create_dir_all(parent).map_err(|source| LibraryError::WriteAsset {
        path: parent.into(),
        source,
    })?;
    let partial = cache_path.with_extension("bin.partial");
    std::fs::write(&partial, &bytes).map_err(|source| LibraryError::WriteAsset {
        path: partial.clone(),
        source,
    })?;
    std::fs::rename(&partial, &cache_path).map_err(|source| LibraryError::WriteAsset {
        path: cache_path,
        source,
    })?;
    Ok(RemoteMedia { bytes, mime })
}

/// 카탈로그 표지(게시판 썸네일)를 `cache/remote-manga/catalog-thumbs`에
/// 디스크 캐시한다. kHentai 검색 결과 카드가 CDN 직접 URL 대신 이 캐시를 쓴다.
pub(crate) fn load_catalog_thumbnail(
    root: &Path,
    work_id: u64,
    url: &str,
) -> Result<RemoteMedia, LibraryError> {
    // URL은 카탈로그 DB에서 검증된 ehgt.org 값만 들어온다(online_catalog::validated_thumbnail_url).
    let digest = format!("{:x}", url_hash(url.as_bytes()));
    let cache_path = root
        .join("cache/remote-manga/catalog-thumbs")
        .join(format!("{work_id}-{digest}.bin"));
    if let Ok(bytes) = std::fs::read(&cache_path) {
        let mime = image_mime(&bytes).ok_or(LibraryError::UnsupportedImage)?;
        return Ok(RemoteMedia { bytes, mime });
    }
    let mut response = image_agent().get(url).call().map_err(|_| LibraryError::RemoteGalleryUnavailable)?;
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
    let mime = image_mime(&bytes).ok_or(LibraryError::UnsupportedImage)?;
    let parent = cache_path.parent().expect("catalog thumb cache has a parent");
    std::fs::create_dir_all(parent).map_err(|source| LibraryError::WriteAsset {
        path: parent.into(),
        source,
    })?;
    let partial = cache_path.with_extension("bin.partial");
    std::fs::write(&partial, &bytes).map_err(|source| LibraryError::WriteAsset {
        path: partial.clone(),
        source,
    })?;
    std::fs::rename(&partial, &cache_path).map_err(|source| LibraryError::WriteAsset {
        path: cache_path,
        source,
    })?;
    Ok(RemoteMedia { bytes, mime })
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

    use super::{clear_remote_cache, load_remote_page_with};
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
}
