//! Home links: bounded, cookie-free preview reads and explicit imports through normal ingestion.
use crate::commands::AppState;
use crate::library::{
    av_portrait::data_url,
    models::{
        ClassificationKind, CreateClassification, ImportSource, IngestMediaRequest, IngestOutcome,
    },
    Library,
};
use regex::Regex;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    io::{Cursor, Read, Write},
    sync::{LazyLock, Mutex},
    time::{Duration, Instant},
};
use url::Url;

const HTML_LIMIT: usize = 512 * 1024;
const IMAGE_LIMIT: usize = 2 * 1024 * 1024;
const TIMEOUT: Duration = Duration::from_secs(5);
static READ_SLOTS: LazyLock<tokio::sync::Semaphore> =
    LazyLock::new(|| tokio::sync::Semaphore::new(4));
const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
type Result<T> = std::result::Result<T, String>;
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    title: String,
    site_name: Option<String>,
    image_url: Option<String>,
}
#[derive(Serialize)]
pub struct ImportReport {
    imported: usize,
    message: Option<String>,
}

fn web_url(value: &str) -> Result<Url> {
    let url = Url::parse(value).map_err(|_| "URL을 확인해 주세요.")?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("http 또는 https URL만 사용할 수 있습니다.".into());
    }
    Ok(url)
}
struct Page {
    url: Url,
    content_type: String,
    bytes: Vec<u8>,
}
fn fetch(value: &str, image: bool, timeout: Duration) -> Result<Page> {
    let mut url = web_url(value)?;
    let deadline = Instant::now() + timeout;
    for redirects in 0..=5 {
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .ok_or("요청 시간이 초과되었습니다.")?;
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .max_redirects(0)
            .http_status_as_error(false)
            .timeout_global(Some(remaining))
            .build()
            .into();
        let mut response = agent
            .get(url.as_str())
            .header("User-Agent", UA)
            .header(
                "Accept",
                if image {
                    "image/*"
                } else {
                    "text/html,image/*;q=0.8"
                },
            )
            .call()
            .map_err(|e| e.to_string())?;
        if response.status().is_redirection() {
            if redirects == 5 {
                return Err("리디렉션이 너무 많습니다.".into());
            }
            let location = response
                .headers()
                .get("location")
                .and_then(|v| v.to_str().ok())
                .ok_or("이동 주소가 없습니다.")?;
            url = web_url(url.join(location).map_err(|e| e.to_string())?.as_str())?;
            continue;
        }
        if !response.status().is_success() {
            return Err("페이지를 가져오지 못했습니다.".into());
        }
        let content_type = response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_lowercase();
        // For a direct image preview, do not read or decode the image until the thumbnail is requested.
        if !image && content_type.starts_with("image/") {
            return Ok(Page {
                url,
                content_type,
                bytes: vec![],
            });
        }
        if image && !content_type.starts_with("image/") {
            return Err("이미지 주소가 아닙니다.".into());
        }
        let limit = if image { IMAGE_LIMIT } else { HTML_LIMIT };
        if response
            .headers()
            .get("content-length")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<usize>().ok())
            .is_some_and(|size| size > limit)
        {
            return Err("응답 크기 제한을 초과했습니다.".into());
        }
        let mut bytes = Vec::new();
        response
            .body_mut()
            .as_reader()
            .take((limit + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        if bytes.len() > limit {
            return Err("응답 크기 제한을 초과했습니다.".into());
        }
        if Instant::now() > deadline {
            return Err("요청 시간이 초과되었습니다.".into());
        }
        return Ok(Page {
            url,
            content_type,
            bytes,
        });
    }
    unreachable!()
}

static META: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?is)<meta\b(?:[^>"']|"[^"]*"|'[^']*')*>"#).unwrap());
static ATTR: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?is)([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))"#).unwrap()
});
static TITLE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?is)<title\b[^>]*>(.*?)</title\s*>").unwrap());
static HIDDEN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?is)<!--[\s\S]*?-->|<script\b[^>]*>[\s\S]*?</script\s*>|<style\b[^>]*>[\s\S]*?</style\s*>").unwrap()
});
fn attributes(tag: &str) -> HashMap<String, String> {
    ATTR.captures_iter(tag)
        .map(|c| {
            (
                c[1].to_lowercase(),
                c.get(2)
                    .or(c.get(3))
                    .or(c.get(4))
                    .unwrap()
                    .as_str()
                    .to_string(),
            )
        })
        .collect()
}
fn text(value: &str) -> String {
    // XML numeric references plus the common HTML title entities.
    let value = value
        .replace("&nbsp;", " ")
        .replace("&quot;", "\"")
        .replace("&apos;", "'");
    let decoded = quick_xml::escape::unescape(&value)
        .map(|v| v.into_owned())
        .unwrap_or(value);
    decoded
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(1024)
        .collect()
}
fn parse(html: &str, base: &Url) -> Preview {
    let html = HIDDEN.replace_all(html, "");
    let mut values = HashMap::new();
    for tag in META.find_iter(&html) {
        let attrs = attributes(tag.as_str());
        if let (Some(name), Some(value)) = (
            attrs.get("property").or(attrs.get("name")),
            attrs.get("content"),
        ) {
            if !value.trim().is_empty() {
                values
                    .entry(name.to_lowercase())
                    .or_insert_with(|| text(value));
            }
        }
    }
    let title = values
        .get("og:title")
        .cloned()
        .or_else(|| TITLE.captures(&html).map(|c| text(&c[1])))
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| base.host_str().unwrap_or("").into());
    let image_url = ["og:image", "twitter:image", "twitter:image:src"]
        .iter()
        .filter_map(|key| values.get(*key))
        .find_map(|value| {
            base.join(value)
                .ok()
                .and_then(|url| web_url(url.as_str()).ok())
                .map(|url| url.to_string())
        });
    Preview {
        title,
        site_name: values.remove("og:site_name"),
        image_url,
    }
}

fn decode(bytes: &[u8], content_type: &str) -> Result<String> {
    let charset = Regex::new(r#"(?i)charset\s*=\s*["']?([a-zA-Z0-9_-]+)"#).unwrap();
    let head = String::from_utf8_lossy(&bytes[..bytes.len().min(4096)]);
    let label = charset
        .captures(content_type)
        .or_else(|| charset.captures(&head))
        .map(|c| c[1].to_lowercase())
        .unwrap_or_else(|| "utf-8".into());
    if bytes.starts_with(&[0xff, 0xfe])
        || bytes.starts_with(&[0xfe, 0xff])
        || label.starts_with("utf-16")
    {
        let be = bytes.starts_with(&[0xfe, 0xff]) || label == "utf-16be";
        let offset =
            usize::from(bytes.starts_with(&[0xff, 0xfe]) || bytes.starts_with(&[0xfe, 0xff])) * 2;
        return String::from_utf16(
            &bytes[offset..]
                .chunks_exact(2)
                .map(|c| {
                    if be {
                        u16::from_be_bytes([c[0], c[1]])
                    } else {
                        u16::from_le_bytes([c[0], c[1]])
                    }
                })
                .collect::<Vec<_>>(),
        )
        .map_err(|e| e.to_string());
    }
    if matches!(label.as_str(), "utf-8" | "utf8" | "us-ascii") {
        return Ok(String::from_utf8_lossy(bytes).into_owned());
    }
    decode_legacy(bytes, &label)
}
// Use the host's built-in converters; no extra dependency or runtime is installed.
#[cfg(windows)]
fn decode_legacy(bytes: &[u8], label: &str) -> Result<String> {
    #[link(name = "kernel32")]
    extern "system" {
        fn MultiByteToWideChar(
            codepage: u32,
            flags: u32,
            input: *const u8,
            len: i32,
            output: *mut u16,
            capacity: i32,
        ) -> i32;
    }
    let codepage = match label {
        "shift_jis" | "shift-jis" | "sjis" | "windows-31j" => 932,
        "euc-jp" => 51932,
        "euc-kr" | "ks_c_5601-1987" | "windows-949" => 949,
        "gbk" | "gb2312" => 936,
        "gb18030" => 54936,
        "big5" => 950,
        "windows-1252" | "iso-8859-1" | "latin1" => 1252,
        _ => return Err("지원하지 않는 문자 인코딩입니다.".into()),
    };
    let mut out = vec![0u16; bytes.len() * 2 + 2];
    let len = unsafe {
        MultiByteToWideChar(
            codepage,
            0,
            bytes.as_ptr(),
            bytes.len() as i32,
            out.as_mut_ptr(),
            out.len() as i32,
        )
    };
    if len == 0 {
        return Err("문자 인코딩을 읽지 못했습니다.".into());
    }
    String::from_utf16(&out[..len as usize]).map_err(|e| e.to_string())
}
#[cfg(target_os = "linux")]
fn decode_legacy(bytes: &[u8], label: &str) -> Result<String> {
    use std::ffi::CString;
    extern "C" {
        fn iconv_open(to: *const libc::c_char, from: *const libc::c_char) -> *mut libc::c_void;
        fn iconv(
            cd: *mut libc::c_void,
            input: *mut *mut libc::c_char,
            input_left: *mut usize,
            output: *mut *mut libc::c_char,
            output_left: *mut usize,
        ) -> usize;
        fn iconv_close(cd: *mut libc::c_void) -> libc::c_int;
    }
    let from = CString::new(label).map_err(|e| e.to_string())?;
    let to = CString::new("UTF-8").unwrap();
    unsafe {
        let cd = iconv_open(to.as_ptr(), from.as_ptr());
        if cd as isize == -1 {
            return Err("지원하지 않는 문자 인코딩입니다.".into());
        }
        let mut out = vec![0u8; bytes.len() * 4 + 4];
        let mut input = bytes.as_ptr() as *mut libc::c_char;
        let mut output = out.as_mut_ptr() as *mut libc::c_char;
        let mut input_left = bytes.len();
        let mut output_left = out.len();
        let result = iconv(
            cd,
            &mut input,
            &mut input_left,
            &mut output,
            &mut output_left,
        );
        iconv_close(cd);
        if result == usize::MAX {
            return Err("문자 인코딩을 읽지 못했습니다.".into());
        }
        out.truncate(out.len() - output_left);
        String::from_utf8(out).map_err(|e| e.to_string())
    }
}
fn preview(url: &str) -> Result<Preview> {
    let page = fetch(url, false, TIMEOUT)?;
    if page.content_type.starts_with("image/") {
        return Ok(Preview {
            title: page.url.host_str().unwrap_or("").into(),
            site_name: None,
            image_url: Some(page.url.to_string()),
        });
    }
    Ok(parse(&decode(&page.bytes, &page.content_type)?, &page.url))
}
fn image_bytes(url: &str) -> Result<(Vec<u8>, image::ImageFormat)> {
    let page = fetch(url, true, TIMEOUT)?;
    let format = image::guess_format(&page.bytes).map_err(|_| "지원하는 이미지가 아닙니다.")?;
    if !matches!(
        format,
        image::ImageFormat::Png
            | image::ImageFormat::Jpeg
            | image::ImageFormat::Gif
            | image::ImageFormat::WebP
    ) {
        return Err("지원하는 이미지가 아닙니다.".into());
    }
    Ok((page.bytes, format))
}
type ThumbnailCache = VecDeque<(String, String)>;
static THUMBNAILS: LazyLock<Mutex<ThumbnailCache>> = LazyLock::new(|| Mutex::new(VecDeque::new()));
fn thumbnail(url: &str) -> Result<String> {
    web_url(url)?;
    if let Some((_, value)) = THUMBNAILS
        .lock()
        .unwrap()
        .iter()
        .find(|(key, _)| key == url)
    {
        return Ok(value.clone());
    }
    let (bytes, format) = image_bytes(url)?;
    let mut reader = image::ImageReader::with_format(Cursor::new(bytes), format);
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(8192);
    limits.max_image_height = Some(8192);
    limits.max_alloc = Some(64 * 1024 * 1024);
    reader.limits(limits);
    let image = reader
        .decode()
        .map_err(|e| e.to_string())?
        .thumbnail(640, 360)
        .to_rgb8();
    let mut output = Cursor::new(Vec::new());
    image::DynamicImage::ImageRgb8(image)
        .write_to(&mut output, image::ImageFormat::Jpeg)
        .map_err(|e| e.to_string())?;
    if output.get_ref().len() > IMAGE_LIMIT {
        return Err("미리보기 크기 제한을 초과했습니다.".into());
    }
    let value = data_url("image/jpeg", output.get_ref());
    let mut cache = THUMBNAILS.lock().unwrap();
    while cache.len() >= 32 {
        cache.pop_front();
    }
    cache.push_back((url.into(), value.clone()));
    Ok(value)
}

fn import_images(library: &Library, url: &str, image_url: Option<&str>) -> Result<ImportReport> {
    web_url(url)?;
    let mut sources = Vec::new();
    if let Some(image_url) = image_url {
        sources.push(web_url(image_url)?.to_string());
    }
    // A page URL can itself be an image, even without a filename extension.
    if !sources.iter().any(|source| source == url) {
        sources.push(url.to_string());
    }
    let mut imported = 0;
    let mut failures = 0;
    let mut destination = None;
    let mut seen_images = HashSet::new();
    for source in sources {
        let (bytes, format) = match image_bytes(&source) {
            Ok(value) => value,
            Err(_) if source == url && image_url.is_some() => continue,
            Err(_) => {
                failures += 1;
                continue;
            }
        };
        if !seen_images.insert(Sha256::digest(&bytes).to_vec()) {
            continue;
        }
        if destination.is_none() {
            let existing = library
                .list_classifications()
                .map_err(|e| e.to_string())?
                .into_iter()
                .find(|c| {
                    c.parent_id.is_none() && c.name == "기타" && c.kind == ClassificationKind::Root
                });
            let folder = match existing {
                Some(folder) => folder,
                None => library
                    .create_classification(CreateClassification {
                        kind: ClassificationKind::Root,
                        name: "기타".into(),
                        parent_id: None,
                    })
                    .or_else(|error| {
                        // Another explicit import may have created the folder while this one fetched.
                        library
                            .list_classifications()?
                            .into_iter()
                            .find(|c| {
                                c.parent_id.is_none()
                                    && c.name == "기타"
                                    && c.kind == ClassificationKind::Root
                            })
                            .ok_or(error)
                    })
                    .map_err(|e| e.to_string())?,
            };
            destination = Some(folder.id);
        }
        let mut temp = tempfile::Builder::new()
            .prefix("lakomics-link-")
            .suffix(&format!(".{}", format.extensions_str()[0]))
            .tempfile()
            .map_err(|e| e.to_string())?;
        temp.write_all(&bytes).map_err(|e| e.to_string())?;
        temp.flush().map_err(|e| e.to_string())?;
        // Close the handle before ingestion moves the file on Windows; TempPath still cleans up errors.
        let temp = temp.into_temp_path();
        let request = IngestMediaRequest {
            source_path: temp.to_path_buf(),
            classification_id: destination.clone(),
            source_url: Some(url.into()),
            collected_at: None,
            replace_duplicate_metadata: false,
            source_published_at: None,
            creator_name: None,
            creator_handle: None,
            creator_url: None,
            import_source: ImportSource::Direct,
            import_batch_id: uuid::Uuid::new_v4().to_string(),
        };
        match library.ingest_media(request) {
            Ok(IngestOutcome::Added { .. } | IngestOutcome::ExactDuplicate { .. }) => imported += 1,
            _ => failures += 1,
        }
    }
    Ok(ImportReport {
        imported,
        message: if failures > 0 {
            Some("일부 이미지를 넣지 못했거나 중복 검토가 필요합니다.".into())
        } else if imported == 0 {
            Some("가져올 수 있는 이미지가 없습니다.".into())
        } else {
            None
        },
    })
}

#[tauri::command]
pub async fn home_link_preview(url: String) -> Result<Preview> {
    let _slot = READ_SLOTS.acquire().await.map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || preview(&url))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn home_link_thumbnail(url: String) -> Result<String> {
    let _slot = READ_SLOTS.acquire().await.map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || thumbnail(&url))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn home_link_import(
    root: String,
    url: String,
    image_url: Option<String>,
    state: tauri::State<'_, AppState>,
) -> Result<ImportReport> {
    let library = state
        .current_library()
        .ok_or("먼저 라이브러리를 선택해 주세요.")?;
    if library.root() != std::path::Path::new(&root) {
        return Err("라이브러리가 변경되었습니다. 다시 열어 주세요.".into());
    }
    let _slot = READ_SLOTS.acquire().await.map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        import_images(&library, &url, image_url.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    fn server(response: Vec<u8>, delay: Duration) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0; 4096];
            let _ = stream.read(&mut request);
            std::thread::sleep(delay);
            let _ = stream.write_all(&response);
        });
        format!("http://{address}/page")
    }
    #[test]
    fn parses_meta_order_entities_relative_images_and_missing_tags() {
        let base = Url::parse("https://example.org/path/page").unwrap();
        let result = parse(
            r#"<!-- <meta property='og:title' content='wrong'> --><title>fallback</title><META content='한글 &amp; &#65;' property='og:title'><meta content='../art.jpg' property='og:image'><meta name='og:site_name' content='site'>"#,
            &base,
        );
        assert_eq!(result.title, "한글 & A");
        assert_eq!(result.site_name.as_deref(), Some("site"));
        assert_eq!(
            result.image_url.as_deref(),
            Some("https://example.org/art.jpg")
        );
        assert_eq!(
            parse(
                "<title>A &quot;B&quot;</title><meta name='twitter:image' content='/t.png'>",
                &base
            )
            .image_url
            .as_deref(),
            Some("https://example.org/t.png")
        );
        assert_eq!(parse("<p>no metadata</p>", &base).title, "example.org");
        assert!(
            parse("<meta property='og:image' content='file:///secret'>", &base)
                .image_url
                .is_none()
        );
    }
    #[test]
    fn decodes_header_meta_utf16_and_legacy_charsets() {
        assert_eq!(
            decode(b"caf\xe9", "text/html; charset=windows-1252").unwrap(),
            "café"
        );
        assert!(decode(
            b"<meta charset='windows-1252'><title>caf\xe9</title>",
            "text/html"
        )
        .unwrap()
        .contains("café"));
        let mut utf16 = vec![0xff, 0xfe];
        for word in "한글".encode_utf16() {
            utf16.extend(word.to_le_bytes());
        }
        assert_eq!(decode(&utf16, "text/html").unwrap(), "한글");
        assert_eq!(
            decode(&[0x93, 0xfa, 0x96, 0x7b], "text/html; charset=shift_jis").unwrap(),
            "日本"
        );
    }
    #[test]
    fn fetch_rejects_schemes_size_and_timeout() {
        for url in [
            "file:///tmp/a",
            "data:text/html,a",
            "ftp://example.org",
            "https://user:pass@example.org",
        ] {
            assert!(fetch(url, false, TIMEOUT).is_err());
        }
        let url = server(
            b"HTTP/1.1 200 OK\r\nContent-Length: 524289\r\nConnection: close\r\n\r\n".to_vec(),
            Duration::ZERO,
        );
        assert!(matches!(fetch(&url, false, TIMEOUT), Err(message) if message.contains("크기")));
        let mut body = b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n".to_vec();
        body.extend(vec![b'a'; HTML_LIMIT + 1]);
        assert!(fetch(&server(body, Duration::ZERO), false, TIMEOUT).is_err());
        let url = server(
            b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n".to_vec(),
            Duration::from_millis(150),
        );
        assert!(fetch(&url, false, Duration::from_millis(30)).is_err());
    }

    #[test]
    fn image_fetch_is_bounded_and_redirects_validate_scheme() {
        let url = server(b"HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: 2097153\r\nConnection: close\r\n\r\n".to_vec(), Duration::ZERO);
        assert!(fetch(&url, true, TIMEOUT).is_err());
        let url = server(b"HTTP/1.1 302 Found\r\nLocation: file:///secret\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec(), Duration::ZERO);
        assert!(fetch(&url, false, TIMEOUT).is_err());
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/loop", listener.local_addr().unwrap());
        let worker = std::thread::spawn(move || {
            for _ in 0..6 {
                let (mut stream, _) = listener.accept().unwrap();
                let mut request = [0; 4096];
                stream.read(&mut request).unwrap();
                stream.write_all(b"HTTP/1.1 302 Found\r\nLocation: /loop\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
            }
        });
        assert!(fetch(&url, false, TIMEOUT).is_err());
        worker.join().unwrap();
    }

    #[test]
    fn explicit_image_import_uses_ingestion_and_top_level_other_folder() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path().join("library")).unwrap();
        let nested_root = library
            .create_classification(CreateClassification {
                kind: ClassificationKind::Root,
                name: "parent".into(),
                parent_id: None,
            })
            .unwrap();
        library
            .create_classification(CreateClassification {
                kind: ClassificationKind::Work,
                name: "기타".into(),
                parent_id: Some(nested_root.id),
            })
            .unwrap();
        let mut png = Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(64, 64)
            .write_to(&mut png, image::ImageFormat::Png)
            .unwrap();
        let mut response = format!("HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", png.get_ref().len()).into_bytes();
        response.extend(png.into_inner());
        let url = server(response, Duration::ZERO);
        let report = import_images(&library, &url, Some(&url)).unwrap();
        assert_eq!(report.imported, 1);
        assert!(report.message.is_none());
        let folder = library
            .list_classifications()
            .unwrap()
            .into_iter()
            .find(|entry| entry.name == "기타" && entry.parent_id.is_none())
            .unwrap();
        assert_eq!(folder.asset_count, 1);
        // Normal ingestion stores provenance and owns assignment/outbox behavior.
        let connection = library.connection().unwrap();
        let source: String = connection
            .query_row("SELECT source_url FROM assets", [], |r| r.get(0))
            .unwrap();
        assert_eq!(source, url);
    }
}
