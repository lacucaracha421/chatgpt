use std::{io::Read, time::Duration};

use regex::Regex;
use serde::Deserialize;
use url::Url;

use super::error::LibraryError;

const SEARCH_URL: &str = "https://www.aladin.co.kr/ttb/api/ItemSearch.aspx";
const MAX_JSON_BYTES: usize = 2 * 1024 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Debug)]
enum AladinTransportError {
    Timeout,
    HttpStatus(u16),
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ParsedVolumeProduct {
    pub volume_number: i64,
    pub base_title: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AladinItem {
    pub item_id: String,
    pub title: String,
    pub author: Option<String>,
    pub publisher: Option<String>,
    pub isbn13: Option<String>,
    pub publication_date: Option<String>,
    pub item_url: Option<String>,
    pub volume_number: i64,
    pub base_title: String,
    pub snapshot_json: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AladinItemPayload {
    item_id: serde_json::Value,
    title: String,
    author: Option<String>,
    publisher: Option<String>,
    isbn13: Option<String>,
    #[serde(rename = "pubDate")]
    publication_date: Option<String>,
    #[serde(rename = "link")]
    item_url: Option<String>,
}

pub(crate) fn parse_volume_product(title: &str) -> Option<ParsedVolumeProduct> {
    let lower = title.to_ascii_lowercase();
    if [
        "세트",
        "박스",
        "가이드",
        "화집",
        "소설",
        "캘린더",
        "달력",
        "아트북",
        "guide",
        "novel",
        "calendar",
        "art book",
        "box set",
    ]
    .iter()
    .any(|term| lower.contains(term))
        || Regex::new(r"\d+\.\d+").unwrap().is_match(title)
    {
        return None;
    }

    for pattern in [
        r"(?i)(?:\s|^)(?:제\s*)?(\d+)\s*권\s*$",
        r"(?i)(?:\s|^)(?:vol(?:ume)?\.?)\s*(\d+)\s*$",
        r"(?:\s|-)(\d+)\s*$",
    ] {
        let regex = Regex::new(pattern).unwrap();
        let Some(captures) = regex.captures(title) else {
            continue;
        };
        let volume_number = captures.get(1)?.as_str().parse::<i64>().ok()?;
        if !(1..=999).contains(&volume_number) {
            return None;
        }
        let matched = captures.get(0)?;
        let base_title = title[..matched.start()]
            .trim_end_matches([' ', '-'])
            .trim()
            .to_owned();
        if base_title.is_empty() {
            return None;
        }
        return Some(ParsedVolumeProduct {
            volume_number,
            base_title,
        });
    }
    None
}

pub(crate) fn parse_search(json: &str) -> Result<Vec<AladinItem>, LibraryError> {
    let envelope: serde_json::Value =
        serde_json::from_str(json).map_err(|_| LibraryError::InvalidAladinResponse)?;
    if let Some(code) = envelope.get("errorCode") {
        let code = code
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| code.to_string());
        if !code.trim_matches('"').is_empty() && code.trim_matches('"') != "0" {
            return Err(LibraryError::InvalidAladinCredential);
        }
    }
    let Some(raw_items) = envelope.get("item") else {
        return Ok(Vec::new());
    };
    let raw_items = raw_items
        .as_array()
        .ok_or(LibraryError::InvalidAladinResponse)?;
    let mut items = Vec::new();
    for raw in raw_items {
        let payload: AladinItemPayload =
            serde_json::from_value(raw.clone()).map_err(|_| LibraryError::InvalidAladinResponse)?;
        let Some(parsed) = parse_volume_product(&payload.title) else {
            continue;
        };
        let item_id = match payload.item_id {
            serde_json::Value::Number(value) => value.to_string(),
            serde_json::Value::String(value) if !value.trim().is_empty() => value,
            _ => return Err(LibraryError::InvalidAladinResponse),
        };
        items.push(AladinItem {
            item_id,
            title: payload.title,
            author: non_empty(payload.author),
            publisher: non_empty(payload.publisher),
            isbn13: non_empty(payload.isbn13),
            publication_date: non_empty(payload.publication_date),
            item_url: non_empty(payload.item_url),
            volume_number: parsed.volume_number,
            base_title: parsed.base_title,
            snapshot_json: serde_json::to_string(raw)
                .map_err(|_| LibraryError::InvalidAladinResponse)?,
        });
    }
    Ok(items)
}

pub(crate) fn search(ttb_key: &str, query: &str) -> Result<Vec<AladinItem>, LibraryError> {
    search_with(ttb_key, query, |url, parameters| {
        let mut url = Url::parse(url).map_err(|_| AladinTransportError::Unavailable)?;
        url.query_pairs_mut()
            .extend_pairs(parameters.iter().copied());
        let config = ureq::Agent::config_builder()
            .timeout_global(Some(REQUEST_TIMEOUT))
            .build();
        let agent: ureq::Agent = config.into();
        let mut response = agent
            .get(url.as_str())
            .header(
                "User-Agent",
                format!("Lakomics/{}", env!("CARGO_PKG_VERSION")),
            )
            .call()
            .map_err(|error| match error {
                ureq::Error::StatusCode(code) => AladinTransportError::HttpStatus(code),
                ureq::Error::Timeout(_) => AladinTransportError::Timeout,
                _ => AladinTransportError::Unavailable,
            })?;
        let mut bytes = Vec::new();
        response
            .body_mut()
            .as_reader()
            .take((MAX_JSON_BYTES + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|error| {
                if error.kind() == std::io::ErrorKind::TimedOut {
                    AladinTransportError::Timeout
                } else {
                    AladinTransportError::Unavailable
                }
            })?;
        if bytes.len() > MAX_JSON_BYTES {
            return Err(AladinTransportError::Unavailable);
        }
        String::from_utf8(bytes).map_err(|_| AladinTransportError::Unavailable)
    })
}

fn search_with<F>(ttb_key: &str, query: &str, fetch: F) -> Result<Vec<AladinItem>, LibraryError>
where
    F: FnOnce(&str, &[(&str, &str)]) -> Result<String, AladinTransportError>,
{
    let query = query.trim();
    if query.chars().count() < 2 {
        return Err(LibraryError::InvalidAladinQuery);
    }
    if ttb_key.trim().is_empty() {
        return Err(LibraryError::InvalidAladinCredential);
    }
    let parameters = [
        ("ttbkey", ttb_key),
        ("Query", query),
        ("QueryType", "Title"),
        ("MaxResults", "50"),
        ("start", "1"),
        ("SearchTarget", "Book"),
        ("output", "js"),
        ("Version", "20131101"),
    ];
    let json = fetch(SEARCH_URL, &parameters).map_err(|error| match error {
        AladinTransportError::Timeout => LibraryError::AladinTimedOut,
        AladinTransportError::HttpStatus(429) => LibraryError::AladinRateLimited,
        AladinTransportError::HttpStatus(401 | 403) => LibraryError::InvalidAladinCredential,
        AladinTransportError::HttpStatus(_) | AladinTransportError::Unavailable => {
            LibraryError::AladinUnavailable
        }
    })?;
    parse_search(&json)
}

fn non_empty(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let trimmed = value.trim();
        (!trimmed.is_empty()).then(|| trimmed.to_owned())
    })
}

#[cfg(test)]
mod tests {
    use super::{parse_search, parse_volume_product, search_with, AladinTransportError};
    use crate::library::error::LibraryError;

    #[test]
    fn parses_integer_volume_suffixes() {
        assert_eq!(
            parse_volume_product("던전밥 12권").unwrap().volume_number,
            12
        );
        assert_eq!(
            parse_volume_product("던전밥 Vol. 12")
                .unwrap()
                .volume_number,
            12
        );
        assert_eq!(
            parse_volume_product("던전밥 제12권").unwrap().volume_number,
            12
        );
        assert_eq!(
            parse_volume_product("던전밥 Volume 12")
                .unwrap()
                .volume_number,
            12
        );
    }

    #[test]
    fn rejects_special_products_and_fractional_volumes() {
        for title in [
            "던전밥 박스 세트",
            "던전밥 공식 가이드북",
            "던전밥 10.5권",
            "던전밥 화집 2",
            "던전밥 소설 3권",
            "던전밥 1000권",
        ] {
            assert_eq!(parse_volume_product(title), None, "{title}");
        }
    }

    #[test]
    fn parses_typed_search_items_and_ignores_non_volumes() {
        let items = parse_search(include_str!("fixtures/aladin_search.json")).unwrap();

        assert_eq!(items.len(), 4);
        assert_eq!(items[0].item_id, "101");
        assert_eq!(items[0].base_title, "던전밥");
        assert_eq!(items[0].volume_number, 1);
        assert_eq!(items[0].author.as_deref(), Some("쿠이 료코"));
        assert_eq!(items[0].publisher.as_deref(), Some("소미미디어"));
        assert_eq!(items[0].isbn13.as_deref(), Some("9780000000001"));
        assert_eq!(items[0].publication_date.as_deref(), Some("2024-01-10"));
        assert_eq!(items[3].isbn13, None);
        assert_eq!(items[3].publication_date, None);
        assert!(!items[0].snapshot_json.contains("ttbkey"));
    }

    #[test]
    fn validates_queries_and_maps_transport_failures_without_leaking_the_key() {
        let short = search_with("super-secret", " a ", |_, _| {
            panic!("short queries must not make a request")
        });
        assert!(matches!(short, Err(LibraryError::InvalidAladinQuery)));

        let timeout = search_with("super-secret", "던전밥", |_, _| {
            Err(AladinTransportError::Timeout)
        });
        assert!(matches!(&timeout, Err(LibraryError::AladinTimedOut)));
        assert!(!timeout.unwrap_err().to_string().contains("super-secret"));

        let limited = search_with("super-secret", "던전밥", |_, _| {
            Err(AladinTransportError::HttpStatus(429))
        });
        assert!(matches!(limited, Err(LibraryError::AladinRateLimited)));
    }

    #[test]
    fn maps_provider_errors_and_empty_results() {
        let invalid_key = search_with("super-secret", "던전밥", |_, _| {
            Ok(r#"{"errorCode":"100","errorMessage":"bad key"}"#.into())
        });
        assert!(matches!(
            invalid_key,
            Err(LibraryError::InvalidAladinCredential)
        ));

        let empty = search_with("super-secret", "던전밥", |_, _| Ok("{}".into())).unwrap();
        assert!(empty.is_empty());

        let malformed = search_with("super-secret", "던전밥", |_, _| Ok("not-json".into()));
        assert!(matches!(
            malformed,
            Err(LibraryError::InvalidAladinResponse)
        ));
    }
}
