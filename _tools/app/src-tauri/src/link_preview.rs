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
use ureq::unversioned::{
    resolver::{DefaultResolver, ResolvedSocketAddrs, Resolver},
    transport::{DefaultConnector, NextTimeout},
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
fn public_ip(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(ip) => {
            let [a, b, c, _] = ip.octets();
            !(ip.is_private()
                || ip.is_loopback()
                || ip.is_link_local()
                || ip.is_broadcast()
                || ip.is_documentation()
                || a == 0
                || a >= 224
                || (a == 100 && (64..=127).contains(&b))
                || (a == 192 && b == 0 && c == 0)
                || (a == 198 && (b == 18 || b == 19)))
        }
        std::net::IpAddr::V6(ip) => ip
            .to_ipv4_mapped()
            .map(|v| public_ip(v.into()))
            .unwrap_or_else(|| {
                let s = ip.segments();
                // Only global unicast; exclude documentation and transition ranges.
                (s[0] & 0xe000) == 0x2000
                    && s[0] != 0x2002
                    && !(s[0] == 0x2001 && (s[1] < 0x200 || s[1] == 0xdb8))
            }),
    }
}
#[derive(Debug)]
struct PublicResolver;
impl Resolver for PublicResolver {
    fn resolve(
        &self,
        uri: &ureq::http::Uri,
        config: &ureq::config::Config,
        timeout: NextTimeout,
    ) -> std::result::Result<ResolvedSocketAddrs, ureq::Error> {
        let addresses = DefaultResolver::default().resolve(uri, config, timeout)?;
        if addresses
            .iter()
            .any(|address| !public_ip(address.ip()) && !(cfg!(test) && address.ip().is_loopback()))
        {
            return Err(ureq::Error::HostNotFound);
        }
        Ok(addresses)
    }
}
fn network_url(value: &str) -> Result<Url> {
    let url = web_url(value)?;
    let local_test = cfg!(test) && url.host_str() == Some("127.0.0.1");
    if url.scheme() != "https" && !local_test {
        return Err("HTTPS 주소만 가져올 수 있습니다.".into());
    }
    Ok(url)
}
fn fetch(value: &str, image: bool, timeout: Duration) -> Result<Page> {
    fetch_with_referer(value, image, timeout, None)
}
fn fetch_with_referer(
    value: &str,
    image: bool,
    timeout: Duration,
    referer: Option<&str>,
) -> Result<Page> {
    let mut url = network_url(value)?;
    let deadline = Instant::now() + timeout;
    for redirects in 0..=5 {
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .ok_or("요청 시간이 초과되었습니다.")?;
        let config = ureq::Agent::config_builder()
            .proxy(None)
            .max_redirects(0)
            .http_status_as_error(false)
            .timeout_global(Some(remaining))
            .build();
        let agent = ureq::Agent::with_parts(config, DefaultConnector::default(), PublicResolver);
        let mut request = agent.get(url.as_str()).header("User-Agent", UA).header(
            "Accept",
            if image {
                "image/*"
            } else {
                "text/html,application/json;q=0.9,image/*;q=0.8"
            },
        );
        if let Some(referer) = referer.filter(|_| url.host_str() == Some("www.pixiv.net")) {
            request = request.header("Referer", referer);
        }
        let mut response = request.call().map_err(|e| e.to_string())?;
        if response.status().is_redirection() {
            if redirects == 5 {
                return Err("리디렉션이 너무 많습니다.".into());
            }
            let location = response
                .headers()
                .get("location")
                .and_then(|v| v.to_str().ok())
                .ok_or("이동 주소가 없습니다.")?;
            url = network_url(url.join(location).map_err(|e| e.to_string())?.as_str())?;
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
        // Metadata is in the head: keep a bounded prefix of large HTML pages.
        let html_prefix = !image && content_type.starts_with("text/html");
        if !html_prefix
            && response
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
            .take((limit + usize::from(!html_prefix)) as u64)
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
    static ENTITY: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"&(?:#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]+);").unwrap()
    });
    // Decode independently so an unknown entity cannot prevent decoding the rest.
    let decoded = ENTITY.replace_all(value, |c: &regex::Captures<'_>| {
        quick_xml::escape::unescape_with(&c[0], |name| match name {
            "nbsp" => Some(" "),
            "copy" => Some("©"),
            "reg" => Some("®"),
            "trade" => Some("™"),
            "hellip" => Some("…"),
            "ndash" => Some("–"),
            "mdash" => Some("—"),
            "lsquo" => Some("‘"),
            "rsquo" => Some("’"),
            "ldquo" => Some("“"),
            "rdquo" => Some("”"),
            "laquo" => Some("«"),
            "raquo" => Some("»"),
            "middot" => Some("·"),
            "bull" => Some("•"),
            "eacute" => Some("é"),
            "egrave" => Some("è"),
            "aacute" => Some("á"),
            "ouml" => Some("ö"),
            "uuml" => Some("ü"),
            "auml" => Some("ä"),
            "times" => Some("×"),
            "divide" => Some("÷"),
            "yen" => Some("¥"),
            "euro" => Some("€"),
            _ => quick_xml::escape::resolve_predefined_entity(name),
        })
        .map(|v| v.into_owned())
        .unwrap_or_else(|_| c[0].to_string())
    });
    decoded.split_whitespace().collect::<Vec<_>>().join(" ")
}
fn title_text(value: &str) -> String {
    text(value).chars().take(200).collect()
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
            let value = text(value);
            if !value.is_empty() {
                values.entry(name.to_lowercase()).or_insert(value);
            }
        }
    }
    let title = values
        .get("og:title")
        .or_else(|| values.get("twitter:title"))
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
        title: title.chars().take(200).collect(),
        site_name: values.remove("og:site_name"),
        image_url,
    }
}

fn decode(bytes: &[u8], content_type: &str) -> Result<String> {
    let charset = Regex::new(r#"(?i)charset\s*=\s*["']?([a-zA-Z0-9_-]+)"#).unwrap();
    let head = String::from_utf8_lossy(&bytes[..bytes.len().min(8192)]);
    let head = HIDDEN.replace_all(&head, "");
    let meta_charset = META.find_iter(&head).find_map(|tag| {
        let attrs = attributes(tag.as_str());
        attrs.get("charset").cloned().or_else(|| {
            attrs
                .get("http-equiv")
                .filter(|v| v.eq_ignore_ascii_case("content-type"))?;
            charset
                .captures(attrs.get("content")?)
                .map(|c| c[1].to_string())
        })
    });
    let label = charset
        .captures(content_type)
        .map(|c| c[1].to_lowercase())
        .or_else(|| meta_charset.map(|v| v.to_lowercase()))
        .unwrap_or_else(|| "utf-8".into());
    if bytes.starts_with(&[0xef, 0xbb, 0xbf]) {
        return Ok(String::from_utf8_lossy(&bytes[3..]).into_owned());
    }
    if bytes.starts_with(&[0xff, 0xfe])
        || bytes.starts_with(&[0xfe, 0xff])
        || label.starts_with("utf-16")
    {
        let be = bytes.starts_with(&[0xfe, 0xff])
            || (!bytes.starts_with(&[0xff, 0xfe]) && label == "utf-16be");
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
#[derive(Debug, PartialEq)]
enum Provider {
    Twitter,
    Youtube,
    Pixiv,
}
fn fallback_url(url: &Url) -> Option<(Provider, Url)> {
    let host = url.host_str()?.trim_start_matches("www.");
    let path: Vec<_> = url.path_segments()?.collect();
    let digits = |value: &str| !value.is_empty() && value.bytes().all(|b| b.is_ascii_digit());
    if matches!(
        host,
        "x.com" | "twitter.com" | "mobile.twitter.com" | "mobile.x.com"
    ) {
        let index = path.iter().position(|v| *v == "status")?;
        let id = *path.get(index + 1)?;
        if !digits(id) {
            return None;
        }
        let mut endpoint = Url::parse("https://publish.twitter.com/oembed").ok()?;
        endpoint
            .query_pairs_mut()
            .append_pair("url", &format!("https://twitter.com/i/status/{id}"))
            .append_pair("omit_script", "true")
            .append_pair("dnt", "true");
        return Some((Provider::Twitter, endpoint));
    }
    if matches!(
        host,
        "youtube.com" | "m.youtube.com" | "music.youtube.com" | "youtu.be"
    ) {
        let id = if host == "youtu.be" {
            path.first()?.to_string()
        } else if matches!(path.first().copied(), Some("shorts" | "embed" | "live")) {
            path.get(1)?.to_string()
        } else if url.path() == "/watch" {
            url.query_pairs().find(|(k, _)| k == "v")?.1.into_owned()
        } else {
            return None;
        };
        if id.is_empty()
            || !id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        {
            return None;
        }
        let mut endpoint = Url::parse("https://www.youtube.com/oembed").ok()?;
        endpoint
            .query_pairs_mut()
            .append_pair("url", &format!("https://www.youtube.com/watch?v={id}"))
            .append_pair("format", "json");
        return Some((Provider::Youtube, endpoint));
    }
    if host == "pixiv.net" {
        let index = path.iter().position(|v| *v == "artworks")?;
        let id = *path.get(index + 1)?;
        if digits(id) {
            return Some((
                Provider::Pixiv,
                Url::parse(&format!("https://www.pixiv.net/ajax/illust/{id}")).ok()?,
            ));
        }
    }
    None
}
fn fallback_preview(provider: &Provider, bytes: &[u8]) -> Result<Preview> {
    let value: serde_json::Value = serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
    let string = |key: &str| value.get(key).and_then(|v| v.as_str()).unwrap_or("");
    let title = match provider {
        Provider::Twitter => {
            static PARAGRAPH: LazyLock<Regex> =
                LazyLock::new(|| Regex::new(r"(?is)<p\b[^>]*>(.*?)</p\s*>").unwrap());
            static TAG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?is)<[^>]*>").unwrap());
            static BR: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?is)<br\s*/?>").unwrap());
            let html = HIDDEN.replace_all(string("html"), "");
            let body = PARAGRAPH
                .captures(&html)
                .map(|c| text(&TAG.replace_all(&BR.replace_all(&c[1], " "), "")))
                .unwrap_or_default();
            if body.is_empty() {
                String::new()
            } else {
                let author = text(string("author_name"));
                if author.is_empty() {
                    body
                } else {
                    format!("{author}: {body}")
                }
            }
        }
        Provider::Youtube => title_text(string("title")),
        Provider::Pixiv => {
            if value.get("error").and_then(|v| v.as_bool()) == Some(true) {
                return Err("작품 정보를 가져오지 못했습니다.".into());
            }
            title_text(
                value
                    .pointer("/body/title")
                    .and_then(|v| v.as_str())
                    .unwrap_or(""),
            )
        }
    };
    if title.is_empty() {
        return Err("제목이 없습니다.".into());
    }
    Ok(Preview {
        title: title.chars().take(200).collect(),
        site_name: match provider {
            Provider::Twitter => Some("X".into()),
            Provider::Youtube => Some("YouTube".into()),
            Provider::Pixiv => Some("pixiv".into()),
        },
        image_url: web_url(string("thumbnail_url")).ok().map(|v| v.to_string()),
    })
}
fn preview(url: &str) -> Result<Preview> {
    let original = network_url(url)?;
    let fallback = fallback_url(&original);
    let deadline = Instant::now() + TIMEOUT;
    let mut result = fetch(
        url,
        false,
        if fallback.is_some() {
            TIMEOUT / 2
        } else {
            TIMEOUT
        },
    )
    .and_then(|page| {
        if page.content_type.starts_with("image/") {
            return Ok(Preview {
                title: page.url.host_str().unwrap_or("").into(),
                site_name: None,
                image_url: Some(page.url.to_string()),
            });
        }
        Ok(parse(&decode(&page.bytes, &page.content_type)?, &page.url))
    });
    // Public APIs also work when the HTML request is blocked or only serves an app shell.
    if let Some((provider, endpoint)) = fallback {
        let generic = result
            .as_ref()
            .map(|p| {
                let title = p.title.to_lowercase();
                title.trim_start_matches("www.")
                    == original.host_str().unwrap_or("").trim_start_matches("www.")
                    || matches!(
                        title.as_str(),
                        "x" | "twitter"
                            | "x / ?"
                            | "youtube"
                            | "- youtube"
                            | "pixiv"
                            | "x.com"
                            | "twitter.com"
                            | "www.youtube.com"
                            | "youtube.com"
                            | "www.pixiv.net"
                            | "pixiv.net"
                    )
            })
            .unwrap_or(true);
        if generic {
            if let Some(remaining) = deadline.checked_duration_since(Instant::now()) {
                let fallback = fetch_with_referer(
                    endpoint.as_str(),
                    false,
                    remaining.min(TIMEOUT),
                    Some("https://www.pixiv.net/"),
                )
                .and_then(|page| fallback_preview(&provider, &page.bytes));
                if let Ok(mut fallback) = fallback {
                    if let Ok(previous) = &result {
                        fallback.image_url = previous.image_url.clone().or(fallback.image_url);
                    }
                    result = Ok(fallback);
                }
            }
        }
    }
    result
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
    fn title_priority_entities_whitespace_and_length() {
        let base = Url::parse("https://example.org/").unwrap();
        assert_eq!(parse("<title>Document</title><meta name='twitter:title' content='Twitter'><meta property='og:title' content='Open Graph'>", &base).title, "Open Graph");
        assert_eq!(parse("<title>Document</title><meta name='twitter:title' content=' Twitter &amp; &#x1f600; &hellip; &unknown; &#65; '> ", &base).title, "Twitter & 😀 … &unknown; A");
        assert_eq!(parse("<meta property='og:title' content=' &nbsp; '><meta name='twitter:title' content='  '><title> A\n  B &copy; </title>", &base).title, "A B ©");
        assert_eq!(parse("<title>&amp;lt;</title>", &base).title, "&lt;");
        assert_eq!(
            parse(&format!("<title>{}</title>", "한".repeat(250)), &base)
                .title
                .chars()
                .count(),
            200
        );
        assert!(decode(
            b"<script>charset=bad</script><meta charset=windows-1252><title>caf\xe9</title>",
            "text/html"
        )
        .unwrap()
        .contains("café"));
        assert_eq!(
            decode(
                b"caf\xe9<meta charset=utf-8>",
                "text/html; charset=windows-1252"
            )
            .unwrap(),
            "café<meta charset=utf-8>"
        );
    }
    #[test]
    fn maps_only_known_public_provider_urls() {
        for url in [
            "https://x.com/person/status/123?s=20",
            "https://twitter.com/i/web/status/123",
        ] {
            let (provider, endpoint) = fallback_url(&Url::parse(url).unwrap()).unwrap();
            assert_eq!(provider, Provider::Twitter);
            assert_eq!(endpoint.host_str(), Some("publish.twitter.com"));
            assert!(endpoint
                .query_pairs()
                .any(|(k, v)| k == "url" && v == "https://twitter.com/i/status/123"));
        }
        for url in [
            "https://youtu.be/abc-123?t=1",
            "https://www.youtube.com/watch?v=abc-123",
            "https://youtube.com/shorts/abc-123",
        ] {
            let (provider, endpoint) = fallback_url(&Url::parse(url).unwrap()).unwrap();
            assert_eq!(provider, Provider::Youtube);
            assert!(endpoint
                .query_pairs()
                .any(|(k, v)| k == "url" && v == "https://www.youtube.com/watch?v=abc-123"));
        }
        let (provider, endpoint) =
            fallback_url(&Url::parse("https://www.pixiv.net/en/artworks/123").unwrap()).unwrap();
        assert_eq!(provider, Provider::Pixiv);
        assert_eq!(endpoint.as_str(), "https://www.pixiv.net/ajax/illust/123");
        for url in [
            "https://x.com/user",
            "https://x.com/user/status/bad",
            "https://x.com.evil.org/user/status/123",
            "https://youtube.com/",
            "https://pixiv.net/artworks/not-an-id",
        ] {
            assert!(fallback_url(&Url::parse(url).unwrap()).is_none());
        }
    }
    #[test]
    fn reads_provider_responses_with_bounded_local_fetch() {
        let cases = [
            (
                Provider::Twitter,
                serde_json::json!({"author_name":"작성자", "html":"<blockquote><p>본문 &amp; <a href='https://example.org'>링크</a><br>다음 줄</p>날짜</blockquote><script>bad()</script>"}),
                "작성자: 본문 & 링크 다음 줄",
            ),
            (
                Provider::Youtube,
                serde_json::json!({"title":"영상 &quot;제목&quot;", "thumbnail_url":"https://example.org/t.jpg"}),
                "영상 \"제목\"",
            ),
            (
                Provider::Pixiv,
                serde_json::json!({"error":false,"body":{"title":"작품 제목"}}),
                "작품 제목",
            ),
        ];
        for (provider, value, expected) in cases {
            let body = serde_json::to_vec(&value).unwrap();
            let mut response = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).into_bytes();
            response.extend(body);
            let page = fetch(&server(response, Duration::ZERO), false, TIMEOUT).unwrap();
            assert_eq!(
                fallback_preview(&provider, &page.bytes).unwrap().title,
                expected
            );
        }
        assert!(fallback_preview(&Provider::Twitter, br#"{"html":"<p></p>"}"#).is_err());
        assert!(fallback_preview(
            &Provider::Pixiv,
            br#"{"error":true,"body":{"title":"bad"}}"#
        )
        .is_err());
    }
    #[test]
    fn large_html_keeps_head_and_network_policy_rejects_private_ips() {
        let body = format!("<title>Head title</title>{}", "x".repeat(HTML_LIMIT));
        let response = format!("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
        assert_eq!(
            preview(&server(response.into_bytes(), Duration::ZERO))
                .unwrap()
                .title,
            "Head title"
        );
        assert!(network_url("http://example.org").is_err());
        for ip in [
            "127.0.0.1",
            "10.0.0.1",
            "192.168.0.1",
            "169.254.169.254",
            "100.64.0.1",
            "::1",
            "::ffff:127.0.0.1",
            "fc00::1",
            "fe80::1",
        ] {
            assert!(!public_ip(ip.parse().unwrap()), "{ip}");
        }
        assert!(public_ip("8.8.8.8".parse().unwrap()));
        assert!(public_ip("2606:4700:4700::1111".parse().unwrap()));
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
