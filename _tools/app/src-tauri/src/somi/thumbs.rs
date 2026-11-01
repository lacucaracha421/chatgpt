use std::{
    io::Read,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        OnceLock,
    },
    time::Duration,
};
static ROOT: OnceLock<PathBuf> = OnceLock::new();
pub(crate) static AUTHENTICATED: AtomicBool = AtomicBool::new(false);
const LIMIT: usize = 2 * 1024 * 1024;
// manga.css uses a 148 px minimum card width and a 148 / 208 frame; save at 2x.
const COVER_WIDTH: u32 = 296;
const COVER_HEIGHT: u32 = 416;
fn shrink(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let image = image::load_from_memory(bytes).map_err(|_| "소미 표지 형식 오류")?;
    crate::library::ingestion::encode_webp(&image.thumbnail(COVER_WIDTH, COVER_HEIGHT))
        .map_err(|_| "소미 표지 변환 실패".into())
}
pub(crate) fn configure(root: PathBuf) {
    let _ = ROOT.set(root);
}
pub(crate) fn valid_key(key: &str) -> bool {
    key.len() == 64
        && key
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}
pub(crate) fn key_of(raw: &str) -> Option<String> {
    let u = url::Url::parse(raw).ok()?;
    if !allowed(&u) {
        return None;
    }
    let key = u.path().strip_prefix('/')?.get(..64)?;
    if !valid_key(key) {
        return None;
    }
    Some(key.into())
}
/// Page addresses may be shaped unlike covers; the host is what the reader's CSP admits.
pub(crate) fn page_allowed(raw: &str) -> bool {
    url::Url::parse(raw).is_ok_and(|u| allowed(&u))
}
fn allowed(u: &url::Url) -> bool {
    u.scheme() == "https"
        && u.host_str() == Some("gimel.mittere.io")
        && u.port_or_known_default() == Some(443)
        && u.username().is_empty()
        && u.password().is_none()
}
fn file(root: &Path, key: &str, ext: &str) -> PathBuf {
    root.join(&key[..2]).join(format!("{key}.{ext}"))
}
pub(crate) fn saved(key: &str) -> bool {
    valid_key(key)
        && ROOT
            .get()
            .is_some_and(|r| ["webp", "jpg"].iter().any(|e| file(r, key, e).is_file()))
}
fn format(bytes: &[u8]) -> Option<(&'static str, &'static str)> {
    if bytes.starts_with(&[255, 216, 255]) {
        Some(("jpg", "image/jpeg"))
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        Some(("webp", "image/webp"))
    } else {
        None
    }
}
pub(crate) fn read(key: &str) -> Option<(Vec<u8>, &'static str)> {
    if !AUTHENTICATED.load(Ordering::Acquire) || !valid_key(key) {
        return None;
    }
    let root = ROOT.get()?;
    for ext in ["webp", "jpg"] {
        if let Ok(f) = std::fs::File::open(file(root, key, ext)) {
            let mut b = Vec::new();
            f.take((LIMIT + 1) as u64).read_to_end(&mut b).ok()?;
            if b.len() > LIMIT {
                return None;
            }
            let (_, mime) = format(&b)?;
            return Some((b, mime));
        }
    }
    None
}
pub(crate) fn download(raw: &str) -> Result<(), String> {
    let key = key_of(raw).ok_or("소미 표지 주소 오류")?;
    if saved(&key) {
        return Ok(());
    }
    let root = ROOT.get().ok_or("소미 표지 저장소 오류")?;
    let agent = crate::http_agent::agent(
        ureq::Agent::config_builder()
            .max_redirects(0)
            .http_status_as_error(false)
            .timeout_global(Some(Duration::from_secs(30)))
            .build(),
    );
    let mut url = url::Url::parse(raw).map_err(|_| "소미 표지 주소 오류")?;
    for _ in 0..4 {
        if !AUTHENTICATED.load(Ordering::Acquire) {
            return Err("SOMI_LOGIN_REQUIRED".into());
        }
        if !allowed(&url) || key_of(url.as_str()).as_deref() != Some(&key) {
            return Err("소미 표지 주소 오류".into());
        }
        let mut response = agent
            .get(url.as_str())
            .call()
            .map_err(|_| "소미 표지를 받을 수 없습니다")?;
        if response.status().is_redirection() {
            let location = response
                .headers()
                .get("location")
                .and_then(|v| v.to_str().ok())
                .ok_or("소미 표지 주소 오류")?;
            url = url.join(location).map_err(|_| "소미 표지 주소 오류")?;
            continue;
        }
        if response.status() != 200 {
            return Err("소미 표지를 받을 수 없습니다".into());
        }
        let mut bytes = Vec::new();
        response
            .body_mut()
            .as_reader()
            .take((LIMIT + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|_| "소미 표지를 받을 수 없습니다")?;
        if bytes.len() > LIMIT {
            return Err("소미 표지 크기 초과".into());
        }
        let bytes = shrink(&bytes)?;
        let path = file(root, &key, "webp");
        let folder = path.parent().unwrap();
        std::fs::create_dir_all(folder).map_err(|_| "소미 표지 저장 실패")?;
        let mut temp =
            tempfile::NamedTempFile::new_in(folder).map_err(|_| "소미 표지 저장 실패")?;
        std::io::Write::write_all(&mut temp, &bytes).map_err(|_| "소미 표지 저장 실패")?;
        temp.persist_noclobber(path)
            .map_err(|_| "소미 표지 저장 실패")?;
        return Ok(());
    }
    Err("소미 표지 주소 오류".into())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn somi_shrink_saves_card_sized_webp() {
        let mut seed = 42u32;
        let source = image::RgbImage::from_fn(888, 1248, |x, y| {
            seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
            let noise = (seed >> 24) as u8 / 3;
            image::Rgb([
                (x / 4) as u8 / 2 + noise,
                (y / 6) as u8 / 2 + noise,
                ((x + y) / 8) as u8 / 2 + noise,
            ])
        });
        let mut original = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgb8(source)
            .write_to(&mut original, image::ImageFormat::Png)
            .unwrap();
        let bytes = shrink(original.get_ref()).unwrap();
        assert_eq!(format(&bytes), Some(("webp", "image/webp")));
        let image = image::load_from_memory(&bytes).unwrap();
        assert_eq!((image.width(), image.height()), (COVER_WIDTH, COVER_HEIGHT));
        eprintln!(
            "somi generated cover: {} bytes -> {} bytes WebP",
            original.get_ref().len(),
            bytes.len()
        );
        assert!(bytes.len() <= 40 * 1024, "{} bytes", bytes.len());
        assert!(shrink(b"not an image").is_err());
    }
    #[test]
    fn somi_thumb_keys() {
        let key = "ab".repeat(32);
        assert!(valid_key(&key));
        assert_eq!(
            key_of(&format!("https://gimel.mittere.io/{key}?signed=1")),
            Some(key.clone())
        );
        for s in ["../secret", "/absolute", &"A".repeat(64)] {
            assert!(!valid_key(s));
        }
        assert!(key_of(&format!("https://other.test/{key}")).is_none());
    }
}
