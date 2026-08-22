use std::{
    io::Read,
    net::{SocketAddr, TcpStream},
    time::Duration,
};

use regex::Regex;
use serde::Deserialize;
use ureq::unversioned::{
    resolver::{DefaultResolver, ResolvedSocketAddrs, Resolver},
    transport::{DefaultConnector, NextTimeout},
};
use url::Url;

use super::error::LibraryError;

const SEARCH_URL: &str = "https://www.aladin.co.kr/ttb/api/ItemSearch.aspx";
const MAX_JSON_BYTES: usize = 2 * 1024 * 1024;
const MAX_SEARCH_PAGES: u64 = 10;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
const ADDRESS_PROBE_TIMEOUT: Duration = Duration::from_millis(300);

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

struct ParsedSearchPage {
    items: Vec<AladinItem>,
    total_results: u64,
    items_per_page: u64,
    raw_item_count: u64,
}

#[derive(Debug, Default)]
struct ReachableResolver {
    inner: DefaultResolver,
}

impl Resolver for ReachableResolver {
    fn resolve(
        &self,
        uri: &ureq::http::Uri,
        config: &ureq::config::Config,
        timeout: NextTimeout,
    ) -> Result<ResolvedSocketAddrs, ureq::Error> {
        let mut addresses = self.inner.resolve(uri, config, timeout)?;
        prioritize_reachable_address(&mut addresses, |address| {
            TcpStream::connect_timeout(address, ADDRESS_PROBE_TIMEOUT).is_ok()
        });
        Ok(addresses)
    }
}

fn prioritize_reachable_address(
    addresses: &mut [SocketAddr],
    mut is_reachable: impl FnMut(&SocketAddr) -> bool,
) {
    if let Some(index) = addresses.iter().position(&mut is_reachable) {
        addresses.rotate_left(index);
    }
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

    let edition_suffix = Regex::new(
        r"(?i)\s*(?:[-–—]\s*)?(?:\([^)]*(?:특별판|한정판|초판)[^)]*\)|\[[^\]]*(?:특별판|한정판|초판)[^\]]*\]|(?:초판\s*)?(?:한정판|특별판))\s*$",
    )
    .unwrap();
    let volume_title = edition_suffix.replace(title, "");

    for pattern in [
        r"(?i)(?:\s|^)(?:제\s*)?(\d+)\s*권\s*$",
        r"(?i)(?:\s|^)(?:vol(?:ume)?\.?)\s*(\d+)\s*$",
        r"(?:\s|-)(\d+)\s*$",
    ] {
        let regex = Regex::new(pattern).unwrap();
        let Some(captures) = regex.captures(&volume_title) else {
            continue;
        };
        let volume_number = captures.get(1)?.as_str().parse::<i64>().ok()?;
        if !(1..=999).contains(&volume_number) {
            return None;
        }
        let matched = captures.get(0)?;
        let base_title = volume_title[..matched.start()]
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

#[cfg(test)]
pub(crate) fn parse_search(json: &str) -> Result<Vec<AladinItem>, LibraryError> {
    Ok(parse_search_page(json)?.items)
}

fn parse_search_page(json: &str) -> Result<ParsedSearchPage, LibraryError> {
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
        return Ok(ParsedSearchPage {
            items: Vec::new(),
            total_results: 0,
            items_per_page: 0,
            raw_item_count: 0,
        });
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
    let raw_item_count = raw_items.len() as u64;
    Ok(ParsedSearchPage {
        items,
        total_results: envelope
            .get("totalResults")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(raw_item_count),
        items_per_page: envelope
            .get("itemsPerPage")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(raw_item_count),
        raw_item_count,
    })
}

pub(crate) fn search(ttb_key: &str, query: &str) -> Result<Vec<AladinItem>, LibraryError> {
    let config = ureq::Agent::config_builder()
        .timeout_global(Some(REQUEST_TIMEOUT))
        .build();
    let agent = ureq::Agent::with_parts(
        config,
        DefaultConnector::default(),
        ReachableResolver::default(),
    );
    search_with(ttb_key, query, move |url, parameters| {
        let mut url = Url::parse(url).map_err(|_| AladinTransportError::Unavailable)?;
        url.query_pairs_mut()
            .extend_pairs(parameters.iter().copied());
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

fn search_with<F>(ttb_key: &str, query: &str, mut fetch: F) -> Result<Vec<AladinItem>, LibraryError>
where
    F: FnMut(&str, &[(&str, &str)]) -> Result<String, AladinTransportError>,
{
    let query = query.trim();
    if query.chars().count() < 2 {
        return Err(LibraryError::InvalidAladinQuery);
    }
    if ttb_key.trim().is_empty() {
        return Err(LibraryError::InvalidAladinCredential);
    }
    let normalized = normalize_search_query(query);
    for search_target in ["Book", "eBook"] {
        let mut items = search_query_pages(ttb_key, query, search_target, &mut fetch)?;
        if items.is_empty() && normalized != query && normalized.chars().count() >= 2 {
            items = search_query_pages(ttb_key, &normalized, search_target, &mut fetch)?;
        }
        if !items.is_empty() {
            return Ok(items);
        }
    }
    Ok(Vec::new())
}

fn search_query_pages<F>(
    ttb_key: &str,
    query: &str,
    search_target: &str,
    fetch: &mut F,
) -> Result<Vec<AladinItem>, LibraryError>
where
    F: FnMut(&str, &[(&str, &str)]) -> Result<String, AladinTransportError>,
{
    let mut items = Vec::new();
    for page_number in 1..=MAX_SEARCH_PAGES {
        let start = page_number.to_string();
        let parameters = [
            ("ttbkey", ttb_key),
            ("Query", query),
            ("QueryType", "Title"),
            ("MaxResults", "50"),
            ("start", start.as_str()),
            ("SearchTarget", search_target),
            ("output", "js"),
            ("Version", "20131101"),
        ];
        let json = fetch(SEARCH_URL, &parameters).map_err(map_transport_error)?;
        let page = parse_search_page(&json)?;
        let is_last_page = page.raw_item_count == 0
            || page.items_per_page == 0
            || page_number.saturating_mul(page.items_per_page) >= page.total_results;
        items.extend(page.items);
        if is_last_page {
            break;
        }
    }
    Ok(items)
}

fn map_transport_error(error: AladinTransportError) -> LibraryError {
    match error {
        AladinTransportError::Timeout => LibraryError::AladinTimedOut,
        AladinTransportError::HttpStatus(429) => LibraryError::AladinRateLimited,
        AladinTransportError::HttpStatus(401 | 403) => LibraryError::InvalidAladinCredential,
        AladinTransportError::HttpStatus(_) | AladinTransportError::Unavailable => {
            LibraryError::AladinUnavailable
        }
    }
}

fn normalize_search_query(query: &str) -> String {
    query
        .chars()
        .map(|character| {
            if character.is_alphanumeric() || character.is_whitespace() {
                character
            } else {
                ' '
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn non_empty(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let trimmed = value.trim();
        (!trimmed.is_empty()).then(|| trimmed.to_owned())
    })
}

#[cfg(test)]
mod tests {
    use std::{cell::RefCell, net::SocketAddr};

    use super::{
        parse_search, parse_volume_product, prioritize_reachable_address, search_with,
        AladinTransportError,
    };
    use crate::library::error::LibraryError;

    #[test]
    fn puts_a_reachable_address_before_a_blocked_dns_result() {
        let blocked: SocketAddr = "192.0.2.1:443".parse().unwrap();
        let reachable: SocketAddr = "192.0.2.2:443".parse().unwrap();
        let mut addresses = [blocked, reachable];

        prioritize_reachable_address(&mut addresses, |address| *address == reachable);

        assert_eq!(addresses, [reachable, blocked]);
    }

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
    fn parses_volume_numbers_before_edition_suffixes() {
        for (title, volume_number) in [
            ("던전밥 3권 특별판", 3),
            ("던전밥 4 - 초판 한정판", 4),
            ("던전밥 Vol. 5 (한정판)", 5),
        ] {
            let parsed = parse_volume_product(title).unwrap();
            assert_eq!(parsed.base_title, "던전밥", "{title}");
            assert_eq!(parsed.volume_number, volume_number, "{title}");
        }
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

    #[test]
    fn searches_ebooks_when_the_paper_book_search_is_empty() {
        let targets = RefCell::new(Vec::new());
        let items = search_with(
            "super-secret",
            "미안하지만 나는 백합이 아니야",
            |_, parameters| {
                let target = parameters
                    .iter()
                    .find(|(name, _)| *name == "SearchTarget")
                    .unwrap()
                    .1;
                targets.borrow_mut().push(target.to_owned());
                if target == "eBook" {
                    Ok(serde_json::json!({
                        "totalResults": 1,
                        "startIndex": 1,
                        "itemsPerPage": 1,
                        "item": [{
                            "title": "[고화질] 미안하지만 나는 백합이 아니야 09",
                            "itemId": 399360954
                        }]
                    })
                    .to_string())
                } else {
                    Ok("{}".into())
                }
            },
        )
        .unwrap();

        assert_eq!(items.len(), 1);
        assert_eq!(items[0].item_id, "399360954");
        assert_eq!(targets.into_inner(), ["Book", "eBook"]);
    }

    #[test]
    fn retries_without_punctuation_and_collects_all_search_pages() {
        let requests = RefCell::new(Vec::new());
        let items = search_with(
            "super-secret",
            "공주님, '고문'의 시간입니다",
            |_, parameters| {
                let query = parameters
                    .iter()
                    .find(|(name, _)| *name == "Query")
                    .unwrap()
                    .1;
                let start = parameters
                    .iter()
                    .find(|(name, _)| *name == "start")
                    .unwrap()
                    .1;
                requests
                    .borrow_mut()
                    .push((query.to_owned(), start.to_owned()));
                let item = match (query, start) {
                    ("공주님 고문 의 시간입니다", "1") => serde_json::json!([{
                        "title": "공주님 '고문'의 시간입니다 1",
                        "itemId": 101
                    }]),
                    ("공주님 고문 의 시간입니다", "2") => serde_json::json!([{
                        "title": "공주님 '고문'의 시간입니다 2",
                        "itemId": 102
                    }]),
                    _ => serde_json::json!([]),
                };
                let total_results = if query == "공주님 고문 의 시간입니다" {
                    2
                } else {
                    0
                };
                Ok(serde_json::json!({
                    "totalResults": total_results,
                    "startIndex": start.parse::<u64>().unwrap(),
                    "itemsPerPage": 1,
                    "item": item
                })
                .to_string())
            },
        )
        .unwrap();

        assert_eq!(
            items
                .iter()
                .map(|item| item.item_id.as_str())
                .collect::<Vec<_>>(),
            ["101", "102"]
        );
        assert_eq!(
            requests.into_inner(),
            [
                ("공주님, '고문'의 시간입니다".into(), "1".into()),
                ("공주님 고문 의 시간입니다".into(), "1".into()),
                ("공주님 고문 의 시간입니다".into(), "2".into()),
            ]
        );
    }
}
