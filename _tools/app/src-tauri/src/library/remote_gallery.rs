use std::{
    io::Read,
    path::{Path, PathBuf},
};

use regex::Regex;
use serde::{Deserialize, Serialize};

use super::error::LibraryError;

const MAX_GALLERY_HTML_BYTES: usize = 5 * 1024 * 1024;

/// 원본 갤러리 매니페스트에 기록하는 provider 태그. 매니페스트 캐시 경로명과
/// 검증 모두 이 값 하나로 결정된다.
pub(crate) const REMOTE_GALLERY_PROVIDER: &str = super::catalog_provider::LEGACY_VCK_PROVIDER;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemotePageDescriptor {
    pub(crate) url: String,
    pub(crate) name: Option<String>,
    pub(crate) width: Option<u32>,
    pub(crate) height: Option<u32>,
    pub(crate) expires_at: Option<i64>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteGalleryManifest {
    pub(crate) provider: String,
    pub(crate) work_id: String,
    pub(crate) pages: Vec<RemotePageDescriptor>,
}

impl RemoteGalleryManifest {
    pub(crate) fn khentai(work_id: u64, pages: Vec<RemotePageDescriptor>) -> Self {
        Self {
            provider: super::catalog_provider::LEGACY_VCK_PROVIDER.into(),
            work_id: work_id.to_string(),
            pages,
        }
    }
}

#[derive(Deserialize)]
struct GalleryPayload {
    files: Vec<GalleryFile>,
}

#[derive(Deserialize)]
struct GalleryFile {
    name: Option<String>,
    image: Option<GalleryImage>,
}

#[derive(Deserialize)]
struct GalleryImage {
    url: String,
    width: Option<u32>,
    height: Option<u32>,
}

pub(crate) fn parse_khentai_gallery(html: &str) -> Result<Vec<RemotePageDescriptor>, LibraryError> {
    let pattern = Regex::new(r"(?is)const\s+gallery\s*=\s*(\{.*?\});\s*</script>")
        .expect("static gallery pattern is valid");
    let json = pattern
        .captures(html)
        .and_then(|captures| captures.get(1))
        .ok_or(LibraryError::InvalidRemoteGallery)?
        .as_str();
    let gallery: GalleryPayload =
        serde_json::from_str(json).map_err(|_| LibraryError::InvalidRemoteGallery)?;
    let mut pages = Vec::with_capacity(gallery.files.len());
    for file in gallery.files {
        let Some(image) = file.image else {
            continue;
        };
        let url = url::Url::parse(&image.url).map_err(|_| LibraryError::InvalidRemoteGallery)?;
        if url.scheme() != "https"
            || !url
                .host_str()
                .is_some_and(|host| host == "siam-cdn.net" || host.ends_with(".siam-cdn.net"))
        {
            return Err(LibraryError::InvalidRemoteGallery);
        }
        let expires_at = url
            .query_pairs()
            .find_map(|(key, value)| (key == "expires").then(|| value.parse().ok()).flatten());
        pages.push(RemotePageDescriptor {
            url: image.url,
            name: file.name.filter(|name| name.len() <= 1_000),
            width: image.width,
            height: image.height,
            expires_at,
        });
    }
    if pages.is_empty() {
        return Err(LibraryError::InvalidRemoteGallery);
    }
    Ok(pages)
}

/// k-hentai에 (PC가) 직접 닿는 레거시 경로. WebView2 carrier에서만 쓴다.
/// VPS carrier는 이 함수를 우회한다 — 한국 네트워크에 의존하지 않기 위함.
pub(crate) fn fetch_gallery_html_direct(work_id: u64) -> Result<String, LibraryError> {
    let mut response = crate::catalog_source::gallery_agent()
        .get(format!("https://k-hentai.org/r/{work_id}"))
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
        .take((MAX_GALLERY_HTML_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| LibraryError::RemoteGalleryUnavailable)?;
    if bytes.len() > MAX_GALLERY_HTML_BYTES {
        return Err(LibraryError::InvalidRemoteGallery);
    }
    String::from_utf8(bytes).map_err(|_| LibraryError::InvalidRemoteGallery)
}

/// 갤러리 HTML을 운영 전송원에서 가져온다. `source`는 k-hentai 직접 전송
/// (WebView2/직접 ureq)이거나 일본 VPS 프록시다. 응답 본문 형식은 양쪽 동일.
pub(crate) fn fetch_khentai_gallery(
    work_id: u64,
    source: &dyn crate::catalog_source::CatalogSource,
) -> Result<Vec<RemotePageDescriptor>, LibraryError> {
    let html = source.fetch_gallery(work_id)?;
    parse_khentai_gallery(&html)
}


pub(crate) fn load_valid_manifest(
    root: &Path,
    work_id: u64,
) -> Result<Option<RemoteGalleryManifest>, LibraryError> {
    let Ok(bytes) = std::fs::read(manifest_path(root, work_id)) else {
        return Ok(None);
    };
    let Ok(manifest) = serde_json::from_slice::<RemoteGalleryManifest>(&bytes) else {
        return Ok(None);
    };
    let valid = manifest.provider == super::catalog_provider::LEGACY_VCK_PROVIDER
        && manifest.work_id == work_id.to_string()
        && !manifest.pages.is_empty()
        && manifest.pages.iter().all(|page| {
            page.expires_at
                .is_none_or(|expires| expires - 60 > chrono::Utc::now().timestamp())
        });
    Ok(valid.then_some(manifest))
}

pub(crate) fn manifest_path(root: &Path, work_id: u64) -> PathBuf {
    root.join("cache/remote-manga/manifests")
        .join(format!("khentai-{work_id}.json"))
}

pub(crate) fn write_manifest(
    root: &Path,
    manifest: &RemoteGalleryManifest,
) -> Result<(), LibraryError> {
    let work_id = manifest
        .work_id
        .parse()
        .map_err(|_| LibraryError::InvalidRemoteGallery)?;
    let path = manifest_path(root, work_id);
    let parent = path.parent().expect("manifest path has a parent");
    std::fs::create_dir_all(parent).map_err(|source| LibraryError::WriteAsset {
        path: parent.into(),
        source,
    })?;
    let partial = path.with_extension("json.partial");
    let bytes = serde_json::to_vec(manifest).map_err(|_| LibraryError::InvalidRemoteGallery)?;
    std::fs::write(&partial, bytes).map_err(|source| LibraryError::WriteAsset {
        path: partial.clone(),
        source,
    })?;
    std::fs::rename(&partial, &path).map_err(|source| LibraryError::WriteAsset {
        path: path.clone(),
        source,
    })
}

#[cfg(test)]
mod tests {
    use super::{
        load_valid_manifest, manifest_path, parse_khentai_gallery, write_manifest,
        RemoteGalleryManifest,
    };

    const HTML: &str = r#"
      <html><script>
        const gallery = {"files":[
          {"name":"001.webp","image":{"url":"https://a.siam-cdn.net/1.webp?expires=1800000100","width":1200,"height":1800}},
          {"name":"002.webp","image":{"url":"https://a.siam-cdn.net/2.webp?expires=1800000000","width":1200,"height":1800}}
        ]};
      </script></html>
    "#;

    #[test]
    fn parses_signed_khentai_pages_and_earliest_expiry() {
        let pages = parse_khentai_gallery(HTML).unwrap();
        assert_eq!(pages.len(), 2);
        assert_eq!(pages[0].name.as_deref(), Some("001.webp"));
        assert_eq!(pages[0].width, Some(1200));
        assert_eq!(pages[1].expires_at, Some(1_800_000_000));
    }

    #[test]
    fn rejects_missing_or_empty_gallery_data() {
        assert!(parse_khentai_gallery("<html>404</html>").is_err());
        assert!(
            parse_khentai_gallery(r#"<script>const gallery = {"files":[]};</script>"#).is_err()
        );
    }

    #[test]
    fn writes_the_manifest_atomically_under_the_remote_cache() {
        let root = tempfile::tempdir().unwrap();
        let pages = parse_khentai_gallery(HTML).unwrap();
        let manifest = RemoteGalleryManifest::khentai(42, pages);

        write_manifest(root.path(), &manifest).unwrap();

        let path = manifest_path(root.path(), 42);
        assert!(path.is_file());
        assert!(!path.with_extension("json.partial").exists());
        let stored: RemoteGalleryManifest =
            serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        assert_eq!(stored.work_id, "42");
        assert_eq!(stored.pages.len(), 2);
        assert_eq!(
            load_valid_manifest(root.path(), 42)
                .unwrap()
                .unwrap()
                .pages
                .len(),
            2
        );
    }

    #[test]
    fn expired_manifest_is_not_reused() {
        let root = tempfile::tempdir().unwrap();
        let html = format!(
            r#"<script>const gallery = {{"files":[{{"image":{{"url":"https://a.siam-cdn.net/1.webp?expires={}"}}}}]}};</script>"#,
            chrono::Utc::now().timestamp()
        );
        let manifest = RemoteGalleryManifest::khentai(42, parse_khentai_gallery(&html).unwrap());
        write_manifest(root.path(), &manifest).unwrap();

        assert!(load_valid_manifest(root.path(), 42).unwrap().is_none());
    }
}
