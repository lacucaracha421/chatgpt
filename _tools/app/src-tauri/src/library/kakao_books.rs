use std::{
    collections::HashSet,
    io::Read,
    sync::OnceLock,
    time::{Duration, Instant},
};

use serde::Deserialize;
use sha2::{Digest, Sha256};
use url::Url;

use super::{
    aladin::{classify_product, normalize_search_query, AladinItem, SearchOutcome},
    error::LibraryError,
};

const SEARCH_URL: &str = "https://dapi.kakao.com/v3/search/book";
const MAX_JSON_BYTES: usize = 2 * 1024 * 1024;
const MAX_SEARCH_PAGES: u32 = 50;
const PAGE_SIZE: usize = 50;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
const SEARCH_BUDGET: Duration = Duration::from_secs(60);

#[derive(Debug)]
enum TransportError {
    Timeout,
    HttpStatus(u16),
    InvalidResponse,
    Unavailable,
}

#[derive(Deserialize)]
struct SearchResponse {
    meta: SearchMeta,
    documents: Vec<serde_json::Value>,
}

#[derive(Deserialize)]
struct SearchMeta {
    is_end: bool,
}

#[derive(Deserialize)]
struct BookDocument {
    title: String,
    authors: Vec<String>,
    publisher: String,
    isbn: String,
    datetime: String,
    url: String,
}

/// The REST key is sent only to Kakao in a header, never in a URL or diagnostic.
pub(crate) fn search(api_key: &str, query: &str) -> Result<SearchOutcome, LibraryError> {
    static AGENT: OnceLock<ureq::Agent> = OnceLock::new();
    let agent = AGENT.get_or_init(|| {
        ureq::Agent::config_builder()
            .https_only(true)
            .max_redirects(0)
            .http_status_as_error(false)
            .timeout_global(Some(REQUEST_TIMEOUT))
            .build()
            .into()
    });
    search_with_clock(api_key, query, |url, authorization, timeout| {
        let _request = super::provider_requests::Request::start("kakao");
        let mut response = agent
            .get(url.as_str())
            .header("Authorization", authorization)
            .config()
            .timeout_global(Some(timeout))
            .build()
            .call()
            .map_err(|error| {
                super::provider_requests::record_failure(
                    super::provider_requests::Failure::transport(&error, "search"),
                );
                match error {
                    ureq::Error::StatusCode(code) => TransportError::HttpStatus(code),
                    ureq::Error::Timeout(_) => TransportError::Timeout,
                    _ => TransportError::Unavailable,
                }
            })?;
        if !response.status().is_success() {
            super::provider_requests::record_failure(super::provider_requests::Failure::http(
                response.status().as_u16(),
                response.headers(),
                "search",
            ));
            return Err(TransportError::HttpStatus(response.status().as_u16()));
        }
        let mut bytes = Vec::new();
        response
            .body_mut()
            .as_reader()
            .take((MAX_JSON_BYTES + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|error| {
                super::provider_requests::record_failure(super::provider_requests::Failure::new(
                    if error.kind() == std::io::ErrorKind::TimedOut {
                        "timeout"
                    } else {
                        "body"
                    },
                    "search",
                ));
                match error.kind() {
                    std::io::ErrorKind::TimedOut => TransportError::Timeout,
                    _ => TransportError::Unavailable,
                }
            })?;
        if bytes.len() > MAX_JSON_BYTES {
            return Err(TransportError::InvalidResponse);
        }
        String::from_utf8(bytes).map_err(|_| TransportError::InvalidResponse)
    }, Instant::now)
}

#[cfg(test)]
fn search_with(
    api_key: &str,
    query: &str,
    mut fetch: impl FnMut(&Url, &str) -> Result<String, TransportError>,
) -> Result<SearchOutcome, LibraryError> {
    search_with_clock(api_key, query, |url, authorization, _| fetch(url, authorization), Instant::now)
}

fn search_with_clock(
    api_key: &str,
    query: &str,
    mut fetch: impl FnMut(&Url, &str, Duration) -> Result<String, TransportError>,
    mut now: impl FnMut() -> Instant,
) -> Result<SearchOutcome, LibraryError> {
    let api_key = api_key.trim();
    if api_key.is_empty() || !api_key.bytes().all(|byte| byte.is_ascii_graphic()) {
        return Err(LibraryError::InvalidAladinCredential);
    }
    let query = query.trim();
    if query.chars().count() < 2 {
        return Err(LibraryError::InvalidAladinQuery);
    }
    let authorization = format!("KakaoAK {api_key}");
    let deadline = now() + SEARCH_BUDGET;
    let mut outcome = search_query_pages(&authorization, query, deadline, &mut fetch, &mut now)?;
    // Titles with `~ ~`, `&`, quotes or commas often find nothing as typed (the same retry
    // as the Aladin search): once more with the punctuation turned into spaces.
    let normalized = normalize_search_query(query);
    if outcome.items.is_empty() && normalized != query && normalized.chars().count() >= 2 {
        outcome = search_query_pages(&authorization, &normalized, deadline, &mut fetch, &mut now)?;
    }
    Ok(outcome)
}

fn search_query_pages(
    authorization: &str,
    query: &str,
    deadline: Instant,
    fetch: &mut impl FnMut(&Url, &str, Duration) -> Result<String, TransportError>,
    now: &mut impl FnMut() -> Instant,
) -> Result<SearchOutcome, LibraryError> {
    let mut items = Vec::new();
    let mut unparsed_count = 0;
    let mut seen = HashSet::new();
    for page in 1..=MAX_SEARCH_PAGES {
        let remaining = deadline.saturating_duration_since(now());
        if remaining.is_zero() {
            return Err(LibraryError::AladinTimedOut);
        }
        let mut url = Url::parse(SEARCH_URL).expect("static Kakao endpoint");
        url.query_pairs_mut()
            .append_pair("query", query)
            .append_pair("target", "title")
            .append_pair("sort", "latest")
            .append_pair("size", &PAGE_SIZE.to_string())
            .append_pair("page", &page.to_string());
        let json = fetch(&url, authorization, REQUEST_TIMEOUT.min(remaining))
            .map_err(map_transport_error)?;
        if now() >= deadline {
            return Err(LibraryError::AladinTimedOut);
        }
        if json.len() > MAX_JSON_BYTES {
            return Err(LibraryError::InvalidAladinResponse);
        }
        let response: SearchResponse =
            serde_json::from_str(&json).map_err(|_| LibraryError::InvalidAladinResponse)?;
        if response.documents.len() > PAGE_SIZE
            || (response.documents.is_empty() && !response.meta.is_end)
        {
            return Err(LibraryError::InvalidAladinResponse);
        }
        for raw in response.documents {
            match parse_document(raw)? {
                Some(item) => {
                    if seen.insert(item.item_id.clone()) {
                        items.push(item);
                    }
                }
                None => unparsed_count += 1,
            }
        }
        if response.meta.is_end {
            return Ok(SearchOutcome {
                items,
                unparsed_count,
            });
        }
    }
    // Never apply an incomplete search as if it were the complete release list.
    Err(LibraryError::InvalidAladinResponse)
}

fn parse_document(raw: serde_json::Value) -> Result<Option<AladinItem>, LibraryError> {
    let book: BookDocument =
        serde_json::from_value(raw.clone()).map_err(|_| LibraryError::InvalidAladinResponse)?;
    let Some((volume_number, base_title)) = classify_product(&book.title).into_volume() else {
        return Ok(None);
    };
    let isbn13 = book
        .isbn
        .split_whitespace()
        .find(|isbn| isbn.len() == 13 && isbn.bytes().all(|byte| byte.is_ascii_digit()));
    let isbn10 = book.isbn.split_whitespace().find(|isbn| {
        isbn.len() == 10
            && isbn.as_bytes()[..9]
                .iter()
                .all(|byte| byte.is_ascii_digit())
            && matches!(isbn.as_bytes()[9], b'0'..=b'9' | b'x' | b'X')
    });
    let item_url = if book.url.trim().is_empty() {
        None
    } else {
        Some(canonical_book_url(&book.url)?)
    };
    let item_id = if let Some(isbn) = isbn13 {
        format!("isbn13:{isbn}")
    } else if let Some(isbn) = isbn10 {
        format!("isbn10:{}", isbn.to_ascii_uppercase())
    } else if let Some(url) = &item_url {
        let hash: String = Sha256::digest(url.as_bytes())
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        format!("url:{hash}")
    } else {
        return Err(LibraryError::InvalidAladinResponse);
    };
    let publication_date = if book.datetime.is_empty() {
        None
    } else {
        let date = chrono::DateTime::parse_from_rfc3339(&book.datetime)
            .map_err(|_| LibraryError::InvalidAladinResponse)?;
        Some(date.format("%Y-%m-%d").to_string())
    };
    Ok(Some(AladinItem {
        item_id,
        title: book.title,
        author: non_empty(&book.authors.join(", ")),
        publisher: non_empty(&book.publisher),
        isbn13: isbn13.map(str::to_owned),
        publication_date,
        item_url,
        volume_number,
        base_title,
        snapshot_json: serde_json::to_string(&raw)
            .map_err(|_| LibraryError::InvalidAladinResponse)?,
    }))
}

fn canonical_book_url(raw: &str) -> Result<String, LibraryError> {
    let url = Url::parse(raw).map_err(|_| LibraryError::InvalidAladinResponse)?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str() != Some("search.daum.net")
        || url.path() != "/search"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || !url
            .query_pairs()
            .any(|(key, value)| key == "w" && value == "bookpage")
    {
        return Err(LibraryError::InvalidAladinResponse);
    }
    let book_id = url
        .query_pairs()
        .find(|(key, value)| key == "bookId" && !value.is_empty())
        .map(|(_, value)| value.into_owned())
        .ok_or(LibraryError::InvalidAladinResponse)?;
    let mut canonical = Url::parse("https://search.daum.net/search").unwrap();
    canonical
        .query_pairs_mut()
        .append_pair("w", "bookpage")
        .append_pair("bookId", &book_id);
    Ok(canonical.into())
}

fn non_empty(value: &str) -> Option<String> {
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_owned())
}

fn map_transport_error(error: TransportError) -> LibraryError {
    match error {
        TransportError::Timeout => LibraryError::AladinTimedOut,
        TransportError::HttpStatus(401 | 403) => LibraryError::InvalidAladinCredential,
        TransportError::HttpStatus(429) => LibraryError::AladinRateLimited,
        TransportError::InvalidResponse => LibraryError::InvalidAladinResponse,
        TransportError::HttpStatus(_) | TransportError::Unavailable => {
            LibraryError::AladinUnavailable
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn retry_and_pages_share_deadline_and_bound_requests_by_remaining_budget() {
        use std::cell::Cell;
        let start = Instant::now();
        let elapsed = Cell::new(Duration::ZERO);
        let mut timeouts = Vec::new();
        let result = search_with_clock("key", "Series!", |url, _, timeout| {
            timeouts.push(timeout);
            let query = url.query_pairs().find(|(key, _)| key == "query").unwrap().1.into_owned();
            if query == "Series!" {
                elapsed.set(Duration::from_secs(55));
                Ok(json!({"meta": {"is_end": true}, "documents": []}).to_string())
            } else {
                elapsed.set(Duration::from_secs(60));
                Ok(json!({"meta": {"is_end": true}, "documents": [book(1)]}).to_string())
            }
        }, || start + elapsed.get());
        assert!(matches!(result, Err(LibraryError::AladinTimedOut)));
        assert_eq!(timeouts, [REQUEST_TIMEOUT, Duration::from_secs(5)]);

        elapsed.set(Duration::ZERO);
        let mut calls = 0;
        let result = search_with_clock("key", "Series!", |_, _, _| {
            calls += 1;
            elapsed.set(SEARCH_BUDGET);
            Ok(json!({"meta": {"is_end": true}, "documents": []}).to_string())
        }, || start + elapsed.get());
        assert!(matches!(result, Err(LibraryError::AladinTimedOut)));
        assert_eq!(calls, 1);
    }

    fn book(volume: usize) -> serde_json::Value {
        json!({"title": format!("스틸 볼 런 {volume}"), "authors": ["아라키 히로히코"],
            "publisher": "문학동네", "isbn": "", "datetime": "2026-09-01T00:00:00.000+09:00",
            "url": format!("https://search.daum.net/search?w=bookpage&bookId={volume}&q=test"),
            "thumbnail": "https://search1.kakaocdn.net/thumb/example"})
    }

    #[test]
    fn fetches_all_54_results_and_keeps_key_out_of_url() {
        let mut calls = 0;
        let items = search_with("test-key", "스틸 볼 런", |url, authorization| {
            calls += 1;
            assert_eq!(authorization, "KakaoAK test-key");
            assert_eq!(url.host_str(), Some("dapi.kakao.com"));
            assert!(!url.as_str().contains("test-key"));
            assert!(url
                .query_pairs()
                .any(|(key, value)| key == "page" && value == calls.to_string()));
            let documents: Vec<_> = if calls == 1 {
                (1..=50).map(book).collect()
            } else {
                (51..=54).map(book).collect()
            };
            Ok(json!({"meta":{"is_end":calls == 2},"documents":documents}).to_string())
        })
        .unwrap()
        .items;
        assert_eq!(calls, 2);
        assert_eq!(items.len(), 54);
        assert!(items[0].snapshot_json.contains("thumbnail"));
        assert_eq!(items[0].publication_date.as_deref(), Some("2026-09-01"));
    }

    #[test]
    fn prefers_isbn13_and_retains_isbn10_fallback() {
        let mut raw = book(1);
        raw["isbn"] = json!("8954677533 9788954677530");
        let item = parse_document(raw.clone()).unwrap().unwrap();
        assert_eq!(item.item_id, "isbn13:9788954677530");
        assert_eq!(item.isbn13.as_deref(), Some("9788954677530"));
        raw["isbn"] = json!("8954677533");
        assert_eq!(
            parse_document(raw).unwrap().unwrap().item_id,
            "isbn10:8954677533"
        );
    }

    #[test]
    fn isbnless_identity_ignores_search_query_and_distinguishes_books() {
        let first = parse_document(book(1)).unwrap().unwrap();
        let mut raw = book(1);
        raw["url"] = json!("http://search.daum.net/search?q=changed&bookId=1&w=bookpage#fragment");
        assert_eq!(first.item_id, parse_document(raw).unwrap().unwrap().item_id);
        assert_ne!(
            first.item_id,
            parse_document(book(2)).unwrap().unwrap().item_id
        );
    }

    #[test]
    fn rejects_untrusted_item_url() {
        let mut raw = book(1);
        raw["url"] = json!("https://search.daum.net.evil.example/search?w=bookpage&bookId=1");
        assert!(matches!(
            parse_document(raw),
            Err(LibraryError::InvalidAladinResponse)
        ));
    }

    #[test]
    fn rejects_malformed_empty_nonterminal_and_oversized_responses() {
        for json in [
            "{}".to_owned(),
            "not json".to_owned(),
            json!({"meta":{"is_end":false},"documents":[]}).to_string(),
            " ".repeat(MAX_JSON_BYTES + 1),
        ] {
            assert!(matches!(
                search_with("key", "책 검색", |_, _| Ok(json.clone())),
                Err(LibraryError::InvalidAladinResponse)
            ));
        }
    }

    #[test]
    fn refuses_silent_truncation_at_page_limit() {
        let mut calls = 0;
        let result = search_with("key", "책 검색", |_, _| {
            calls += 1;
            Ok(json!({"meta":{"is_end":false},"documents":[book(calls)]}).to_string())
        });
        assert_eq!(calls, MAX_SEARCH_PAGES as usize);
        assert!(matches!(result, Err(LibraryError::InvalidAladinResponse)));
    }

    #[test]
    fn maps_authentication_quota_and_timeout_errors_without_secrets() {
        for status in [401, 403] {
            assert!(matches!(
                search_with("key", "책 검색", |_, _| Err(TransportError::HttpStatus(
                    status
                ))),
                Err(LibraryError::InvalidAladinCredential)
            ));
        }
        assert!(matches!(
            search_with("key", "책 검색", |_, _| Err(TransportError::HttpStatus(
                429
            ))),
            Err(LibraryError::AladinRateLimited)
        ));
        assert!(matches!(
            search_with("key", "책 검색", |_, _| Err(TransportError::Timeout)),
            Err(LibraryError::AladinTimedOut)
        ));
        for key in ["", "key\r\ninjected", "key with spaces"] {
            assert!(matches!(
                search_with(key, "책 검색", |_, _| panic!(
                    "invalid key must not send a request"
                )),
                Err(LibraryError::InvalidAladinCredential)
            ));
        }
    }

    fn book_titled(title: &str) -> serde_json::Value {
        let mut raw = book(1);
        raw["title"] = json!(title);
        raw["url"] = json!(format!(
            "https://search.daum.net/search?w=bookpage&bookId={}",
            title.len()
        ));
        raw
    }

    #[test]
    fn retries_once_without_punctuation_when_nothing_usable_is_found() {
        let queries = std::cell::RefCell::new(Vec::new());
        let outcome = search_with("key", "공주님, '고문'의 시간입니다 ~완결~", |url, _| {
            let query = url
                .query_pairs()
                .find(|(name, _)| name == "query")
                .unwrap()
                .1
                .into_owned();
            queries.borrow_mut().push(query.clone());
            let documents = if query == "공주님 고문 의 시간입니다 완결" {
                vec![
                    book_titled("공주님 '고문'의 시간입니다 1"),
                    book_titled("공주님 '고문'의 시간입니다 박스 세트"),
                ]
            } else {
                // Only a set came back for the exact text: nothing usable.
                vec![book_titled("공주님 '고문'의 시간입니다 박스 세트")]
            };
            Ok(json!({"meta":{"is_end":true},"documents":documents}).to_string())
        })
        .unwrap();
        assert_eq!(
            queries.into_inner(),
            [
                "공주님, '고문'의 시간입니다 ~완결~",
                "공주님 고문 의 시간입니다 완결"
            ]
        );
        assert_eq!((outcome.items.len(), outcome.unparsed_count), (1, 1));

        // A query with nothing to strip, or a first search that found something, is not repeated.
        let mut calls = 0;
        search_with("key", "던전밥", |_, _| {
            calls += 1;
            Ok(json!({"meta":{"is_end":true},"documents":[]}).to_string())
        })
        .unwrap();
        assert_eq!(calls, 1);
        let mut calls = 0;
        search_with("key", "던전밥, 1", |_, _| {
            calls += 1;
            Ok(json!({"meta":{"is_end":true},"documents":[book(1)]}).to_string())
        })
        .unwrap();
        assert_eq!(calls, 1);
    }

    #[test]
    fn keeps_unnumbered_products_and_drops_non_volumes() {
        let items = [
            "마법소녀를 (애장판)",
            "마법소녀를 2 (애장판)",
            "마법소녀를 공식 가이드북",
            "마법소녀를 (상)",
        ]
        .map(|title| parse_document(book_titled(title)).unwrap());
        assert_eq!(
            items
                .iter()
                .map(|item| item.as_ref().map(|i| (i.volume_number, i.base_title.as_str())))
                .collect::<Vec<_>>(),
            [
                Some((crate::library::aladin::UNNUMBERED_VOLUME, "마법소녀를")),
                Some((2, "마법소녀를")),
                None,
                None
            ]
        );
    }
}
