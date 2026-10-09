use std::{
    io::Read,
    net::{SocketAddr, TcpStream},
    time::Duration,
    sync::LazyLock,
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
    unparsed_count: u64,
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

/// How one product title reads as a volume of a series. Mirrored by
/// `server/lakomics-api/collection_bindings.py classify_product`; change both together.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ProductKind {
    /// A numbered volume ("던전밥 12권").
    Volume(ParsedVolumeProduct),
    /// A product with no volume number ("봇치 더 록!", "마법소녀를 (애장판)"): the base title
    /// is the cleaned title. Grouping turns it into volume 1 of its series, or of its own
    /// one-volume series (`UNNUMBERED_VOLUME`).
    Unnumbered(String),
    /// Not a volume: a set, box, guide, novel, range, split (상/하) or a number that cannot
    /// be read.
    Excluded,
}

/// `AladinItem::volume_number` of an unnumbered product until grouping resolves it to 1.
pub(crate) const UNNUMBERED_VOLUME: i64 = 0;

const EDITION_WORDS: &str = "초회한정판|초회판|초판|특별한정판|한정판|특별판|애장판|일반판|특장판|리커버판|리커버|완전판|신장판|개정증보판|개정판|통상판|소장판|보급판";
/// A trailing parenthesised or bracketed note that is an edition marker, not an alt title.
const EDITION_NOTE_STEMS: &str = "한정|특전|특별|초회|초판|리커버|애장|완전판|신장|개정|통상|일반판|특장|소장판|보급판|에디션|edition|special|limited";

static DECIMAL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\d+\.\d+").unwrap());
static EDITION_SUFFIX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"(?i)\s*(?:[-–—]\s*)?(?:\([^)]*(?:{notes})[^)]*\)|\[[^\]]*(?:{notes})[^\]]*\]|(?:(?:초회|초판)\s*)?(?:{words}))\s*$",
        notes = EDITION_NOTE_STEMS,
        words = EDITION_WORDS,
    ))
    .unwrap()
});
static EDITION_NOTE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!("(?i)(?:{EDITION_NOTE_STEMS})")).unwrap());
static SERIES_NOTE: LazyLock<Regex> = LazyLock::new(|| Regex::new(
    r"(?i)\d+\s*부|외전|시즌|번외|단편|리부트|신장|part|season|side story|extra|reboot|new edition|外伝|番外|短編|新装|シーズン|リブート"
).unwrap());
static COMPLETION_SUFFIX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\s*[\(\[]\s*완결\s*[\)\]]\s*$").unwrap());
static PART_MARK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[\(\[]\s*(?:상|중|하)(?:권)?\s*[\)\]]\s*$").unwrap());
static RANGE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\d+\s*[~∼～〜]\s*\d+|\d+\s*권?\s*[-–—]\s*\d+\s*권|\d+\s*[-–—]\s*\d+\s*$|전\s*\d+\s*권").unwrap()
});
static VOLUME_PATTERNS: LazyLock<[Regex; 3]> = LazyLock::new(|| {
    [
        r"(?i)(?:\s|^)(?:제\s*)?(\d+)\s*권\s*$",
        r"(?i)(?:\s|^)(?:vol(?:ume)?\.?)\s*(\d+)\s*$",
        r"(?:\s|-)(\d+)\s*$",
    ]
    .map(|pattern| Regex::new(pattern).unwrap())
});

/// Words that make a whole token a non-volume product. Compared on tokens (runs of
/// letters and digits), never as substrings, so "소설가의" is not "소설".
const EXCLUDED_TOKENS: &[&str] = &[
    "소설", "소설판", "소설책", "노벨", "라이트노벨", "화집", "화보집", "설정집", "팬북", "아트북",
    "일러스트북", "일러스트집", "가이드북", "셀렉션", "캘린더", "달력", "박스세트", "guide",
    "guidebook", "novel", "novels", "calendar", "artbook", "boxset",
];
/// Compound nouns that end in one of these are products too ("공식가이드북", "탁상캘린더").
const EXCLUDED_SUFFIXES: &[&str] = &[
    "가이드북", "설정집", "일러스트북", "일러스트집", "아트북", "화보집", "캘린더", "박스세트", "풀세트",
];
const SET_PRECEDERS: &[&str] = &["박스", "전권", "완결", "합본", "풀", "스페셜", "특별", "한정", "한정판"];
const BOX_FOLLOWERS: &[&str] = &["세트", "에디션", "패키지", "한정판", "특별판"];
const GUIDE_PRECEDERS: &[&str] = &["공식", "공략", "완전", "비주얼", "캐릭터", "오피셜", "팬", "퍼펙트"];

fn is_count_token(token: &str) -> bool {
    let digits = token.strip_prefix('전').unwrap_or(token);
    digits
        .strip_suffix('권')
        .is_some_and(|number| !number.is_empty() && number.chars().all(|c| c.is_ascii_digit()))
}

fn is_excluded_product(title: &str) -> bool {
    let lower = title.to_lowercase();
    let tokens: Vec<&str> = lower
        .split(|character: char| !character.is_alphanumeric())
        .filter(|token| !token.is_empty())
        .collect();
    let last = tokens.len().saturating_sub(1);
    for (index, token) in tokens.iter().copied().enumerate() {
        let previous = index.checked_sub(1).map(|i| tokens[i]);
        let next = tokens.get(index + 1).copied();
        if EXCLUDED_TOKENS.contains(&token)
            || EXCLUDED_SUFFIXES.iter().any(|suffix| token.ends_with(suffix))
        {
            return true;
        }
        match token {
            // A set marker only ends the title or follows a count / box word; a title that
            // merely contains "세트" before its volume number ("우리들의 세트 2") is a series.
            "세트"
                if index == last
                    || previous.is_some_and(|p| SET_PRECEDERS.contains(&p) || is_count_token(p)) =>
            {
                return true
            }
            "박스" if index == last || next.is_some_and(|n| BOX_FOLLOWERS.contains(&n)) => {
                return true
            }
            "가이드" if index == last || previous.is_some_and(|p| GUIDE_PRECEDERS.contains(&p)) => {
                return true
            }
            "box" if next == Some("set") => return true,
            "art" if next == Some("book") => return true,
            _ => {}
        }
        if token.chars().count() > 2 && token.ends_with("세트") {
            return true;
        }
    }
    false
}

/// Whether the text inside a trailing `(...)` is an edition marker rather than an alt title.
pub(crate) fn is_edition_note(note: &str) -> bool {
    EDITION_NOTE.is_match(note)
}

/// Parts, side stories, seasons and new editions can identify different series.
/// Preserve them even when a provider also calls the same note a special edition.
pub(crate) fn is_series_note(note: &str) -> bool {
    SERIES_NOTE.is_match(note)
}

/// Strips trailing completion and edition markers ("24(완결)", "3권 특별판", "(애장판)").
fn strip_trailing_markers(title: &str) -> String {
    let mut current = title.trim().to_owned();
    for _ in 0..4 {
        let without_completion = COMPLETION_SUFFIX.replace(&current, "");
        let stripped = match EDITION_SUFFIX.find(&without_completion) {
            Some(note) if !is_series_note(note.as_str()) =>
                without_completion[..note.start()].trim_end().to_owned(),
            _ => without_completion.trim_end().to_owned(),
        };
        if stripped == current {
            break;
        }
        current = stripped;
    }
    current
}

pub(crate) fn classify_product(title: &str) -> ProductKind {
    if DECIMAL.is_match(title) {
        return ProductKind::Excluded;
    }
    let cleaned = strip_trailing_markers(title);
    if cleaned.is_empty()
        || RANGE.is_match(&cleaned)
        || PART_MARK.is_match(&cleaned)
        || is_excluded_product(&cleaned)
    {
        return ProductKind::Excluded;
    }
    for regex in VOLUME_PATTERNS.iter() {
        let Some(captures) = regex.captures(&cleaned) else {
            continue;
        };
        let Some(volume_number) = captures
            .get(1)
            .and_then(|digits| digits.as_str().parse::<i64>().ok())
            .filter(|number| (1..=999).contains(number))
        else {
            return ProductKind::Excluded;
        };
        let Some(matched) = captures.get(0) else {
            return ProductKind::Excluded;
        };
        let base_title = cleaned[..matched.start()]
            .trim_end_matches([' ', '-', '.'])
            .trim()
            .to_owned();
        if base_title.is_empty() {
            return ProductKind::Excluded;
        }
        return ProductKind::Volume(ParsedVolumeProduct {
            volume_number,
            base_title,
        });
    }
    ProductKind::Unnumbered(cleaned)
}

/// The numbered reading of a title, or `None` for anything else.
#[cfg(test)]
pub(crate) fn parse_volume_product(title: &str) -> Option<ParsedVolumeProduct> {
    match classify_product(title) {
        ProductKind::Volume(parsed) => Some(parsed),
        _ => None,
    }
}

impl ProductKind {
    /// `(volume number, base title)` of a usable product; `None` when excluded.
    pub(crate) fn into_volume(self) -> Option<(i64, String)> {
        match self {
            ProductKind::Volume(parsed) => Some((parsed.volume_number, parsed.base_title)),
            ProductKind::Unnumbered(base_title) => Some((UNNUMBERED_VOLUME, base_title)),
            ProductKind::Excluded => None,
        }
    }
}

/// A provider search: the usable products and how many were left out as non-volumes.
#[derive(Debug, Default)]
pub(crate) struct SearchOutcome {
    pub items: Vec<AladinItem>,
    pub unparsed_count: u64,
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
            unparsed_count: 0,
            total_results: 0,
            items_per_page: 0,
            raw_item_count: 0,
        });
    };
    let raw_items = raw_items
        .as_array()
        .ok_or(LibraryError::InvalidAladinResponse)?;
    let mut items = Vec::new();
    let mut unparsed_count = 0;
    for raw in raw_items {
        let payload: AladinItemPayload =
            serde_json::from_value(raw.clone()).map_err(|_| LibraryError::InvalidAladinResponse)?;
        let Some((volume_number, base_title)) = classify_product(&payload.title).into_volume()
        else {
            unparsed_count += 1;
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
            volume_number,
            base_title,
            snapshot_json: serde_json::to_string(raw)
                .map_err(|_| LibraryError::InvalidAladinResponse)?,
        });
    }
    let raw_item_count = raw_items.len() as u64;
    Ok(ParsedSearchPage {
        items,
        unparsed_count,
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

pub(crate) fn search(ttb_key: &str, query: &str) -> Result<SearchOutcome, LibraryError> {
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

fn search_with<F>(ttb_key: &str, query: &str, mut fetch: F) -> Result<SearchOutcome, LibraryError>
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
        let mut outcome = search_query_pages(ttb_key, query, search_target, &mut fetch)?;
        if outcome.items.is_empty() && normalized != query && normalized.chars().count() >= 2 {
            outcome = search_query_pages(ttb_key, &normalized, search_target, &mut fetch)?;
        }
        if !outcome.items.is_empty() {
            return Ok(outcome);
        }
    }
    Ok(SearchOutcome::default())
}

fn search_query_pages<F>(
    ttb_key: &str,
    query: &str,
    search_target: &str,
    fetch: &mut F,
) -> Result<SearchOutcome, LibraryError>
where
    F: FnMut(&str, &[(&str, &str)]) -> Result<String, AladinTransportError>,
{
    let mut items = Vec::new();
    let mut unparsed_count = 0;
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
        unparsed_count += page.unparsed_count;
        if is_last_page {
            break;
        }
    }
    Ok(SearchOutcome {
        items,
        unparsed_count,
    })
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

/// The query with punctuation turned into spaces ("공주님, '고문'의 시간입니다" becomes
/// "공주님 고문 의 시간입니다"): the retry when the provider finds nothing for the exact text.
/// Mirrored by `collection_bindings.py normalize_search_query`.
pub(crate) fn normalize_search_query(query: &str) -> String {
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
        classify_product, parse_search, parse_volume_product, prioritize_reachable_address,
        search_with, AladinTransportError, ProductKind,
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
        assert!(empty.items.is_empty());

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
        .unwrap()
        .items;

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
        .unwrap()
        .items;

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
    #[test]
    fn korean_completion_and_dotted_volume_titles_are_recognized() {
        for (title, number) in [("스틸 볼 런 24(완결)", 24), ("스틸 볼 런. 23", 23)] {
            let parsed = parse_volume_product(title).unwrap();
            assert_eq!(parsed.volume_number, number);
            assert_eq!(parsed.base_title, "스틸 볼 런");
        }
        assert!(parse_volume_product("학생회에도 구멍은 있다! 공식 일러스트북").is_none());
        assert!(parse_volume_product("학생회에도 구멍은 있다! 공식 풀컬러판 구멍 셀렉션!").is_none());
    }

    fn volume(title: &str) -> (i64, String) {
        match classify_product(title) {
            ProductKind::Volume(parsed) => (parsed.volume_number, parsed.base_title),
            other => panic!("{title}: {other:?}"),
        }
    }

    #[test]
    fn edition_suffixes_are_stripped_from_numbered_and_unnumbered_titles() {
        for (title, expected) in [
            ("마법소녀를 3 (애장판)", (3, "마법소녀를")),
            ("마법소녀를 3권 (일반판)", (3, "마법소녀를")),
            ("마법소녀를 4 (특장판)", (4, "마법소녀를")),
            ("마법소녀를 5 리커버", (5, "마법소녀를")),
            ("마법소녀를 6 [완전판]", (6, "마법소녀를")),
            ("마법소녀를 7 (초회 한정 특전판)", (7, "마법소녀를")),
            ("마법소녀를 8 (특별판)(완결)", (8, "마법소녀를")),
            ("마법소녀를 9(완결) 한정판", (9, "마법소녀를")),
        ] {
            assert_eq!(volume(title), (expected.0, expected.1.to_owned()), "{title}");
        }
        for (title, base) in [
            ("마법소녀를 (애장판)", "마법소녀를"),
            ("마법소녀를 (일반판)", "마법소녀를"),
            ("마법소녀를 리커버", "마법소녀를"),
            ("봇치 더 록!", "봇치 더 록!"),
            ("위치 워치(Witch Watch)", "위치 워치(Witch Watch)"),
        ] {
            assert_eq!(
                classify_product(title),
                ProductKind::Unnumbered(base.to_owned()),
                "{title}"
            );
        }
    }

    /// The rows the server's `classify_product` is tested against too
    /// (`server/lakomics-api/tests/test_collection_bindings.py`).
    #[test]
    fn product_titles_match_the_shared_fixture() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("fixtures/product_titles.json")).unwrap();
        let cases = fixture["cases"].as_array().unwrap();
        assert!(cases.len() > 50);
        for case in cases {
            let title = case["title"].as_str().unwrap();
            let expected = match case["kind"].as_str().unwrap() {
                "volume" => ProductKind::Volume(super::ParsedVolumeProduct {
                    volume_number: case["volume"].as_i64().unwrap(),
                    base_title: case["base"].as_str().unwrap().to_owned(),
                }),
                "unnumbered" => ProductKind::Unnumbered(case["base"].as_str().unwrap().to_owned()),
                "excluded" => ProductKind::Excluded,
                other => panic!("{other}"),
            };
            assert_eq!(classify_product(title), expected, "{title}");
        }
    }

    #[test]
    fn alt_titles_in_parentheses_keep_the_volume_number() {
        assert_eq!(
            volume("위치 워치(Witch Watch) 2"),
            (2, "위치 워치(Witch Watch)".to_owned())
        );
    }

    #[test]
    fn excluded_words_match_whole_words_not_parts_of_real_titles() {
        for title in [
            "오타쿠 소설가의 일상 1",
            "가이드 걸 1",
            "우리들의 세트 2",
            "달력소녀 3",
            "박스 안의 고양이 4",
        ] {
            assert!(
                matches!(classify_product(title), ProductKind::Volume(_)),
                "{title}: {:?}",
                classify_product(title)
            );
        }
        for title in [
            "던전밥 1-5권 세트",
            "던전밥 박스 세트",
            "던전밥 박스세트 1",
            "던전밥 공식 가이드북",
            "던전밥 공식 가이드 1",
            "던전밥 소설판",
            "던전밥 소설 3",
            "던전밥 일러스트북",
            "던전밥 1~5",
            "던전밥 전 5권",
            "던전밥 (상)",
            "던전밥 (하)",
            "던전밥 1.5",
            "던전밥 1000",
            "던전밥 세트",
            "Dungeon Meshi Box Set",
            "Dungeon Meshi Art Book",
            "Dungeon Meshi Guide",
            "1권",
        ] {
            assert_eq!(classify_product(title), ProductKind::Excluded, "{title}");
        }
    }

    #[test]
    fn unnumbered_products_are_kept_with_their_cleaned_title() {
        let items = parse_search(
            r#"{"item":[
                {"title":"오타쿠 소설가의 일상 1","itemId":1},
                {"title":"단편 한 권짜리 이야기","itemId":2},
                {"title":"던전밥 (일반판)","itemId":3},
                {"title":"던전밥 박스 세트","itemId":4}
            ]}"#,
        )
        .unwrap();
        assert_eq!(
            items
                .iter()
                .map(|item| (item.volume_number, item.base_title.as_str()))
                .collect::<Vec<_>>(),
            [
                (1, "오타쿠 소설가의 일상"),
                (super::UNNUMBERED_VOLUME, "단편 한 권짜리 이야기"),
                (super::UNNUMBERED_VOLUME, "던전밥"),
            ]
        );
    }

    #[test]
    fn the_search_counts_products_it_leaves_out() {
        let outcome = search_with("super-secret", "던전밥", |_, _| {
            Ok(r#"{"totalResults":3,"itemsPerPage":3,"item":[
                {"title":"던전밥 1권","itemId":1},
                {"title":"던전밥 박스 세트","itemId":2},
                {"title":"던전밥 공식 가이드북","itemId":3}
            ]}"#
            .into())
        })
        .unwrap();
        assert_eq!((outcome.items.len(), outcome.unparsed_count), (1, 2));
    }
}
