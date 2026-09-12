//! Shared pacing for automatic and manual metadata requests. Metrics are local to
//! the worker thread, so an unrelated UI search cannot inflate a batch's totals.
use std::{
    cell::{Cell, RefCell},
    sync::Mutex,
    time::{Duration, Instant},
};

#[derive(Clone, Copy, Default)]
pub(super) struct Metrics {
    pub requests: u64,
    pub network_ms: u64,
    pub throttle_ms: u64,
}
thread_local! { static METRICS: Cell<Metrics> = Cell::new(Metrics::default()); }
thread_local! { static FAILURE: RefCell<Option<Failure>> = const { RefCell::new(None) }; }

/// Only bounded categories and HTTP codes are retained. Never store request URLs,
/// queries, credentials, raw response bodies, or transport error strings.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Failure {
    pub kind: String,
    pub endpoint: String,
    pub http_status: Option<u16>,
    pub retry_after_seconds: Option<u64>,
}
impl Failure {
    pub(super) fn new(kind: &str, endpoint: &str) -> Self {
        Self {
            kind: kind.into(),
            endpoint: endpoint.into(),
            http_status: None,
            retry_after_seconds: None,
        }
    }
    pub(super) fn transport(error: &ureq::Error, endpoint: &str) -> Self {
        Self::new(
            match error {
                ureq::Error::HostNotFound => "dns",
                ureq::Error::Tls(_) | ureq::Error::Rustls(_) => "tls",
                ureq::Error::Timeout(_) => "timeout",
                _ => "connection",
            },
            endpoint,
        )
    }
    pub(super) fn http(code: u16, headers: &ureq::http::HeaderMap, endpoint: &str) -> Self {
        let now = chrono::Utc::now();
        let standard = headers
            .get("retry-after")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| {
                v.trim().parse::<u64>().ok().or_else(|| {
                    chrono::DateTime::parse_from_rfc2822(v)
                        .ok()
                        .map(|date| date.signed_duration_since(now).num_seconds().max(0) as u64)
                })
            });
        let mangadex = headers
            .get("x-ratelimit-retry-after")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<i64>().ok())
            .map(|epoch| epoch.saturating_sub(now.timestamp()).max(0) as u64);
        Self {
            http_status: Some(code),
            retry_after_seconds: standard
                .into_iter()
                .chain(mangadex)
                .max()
                .map(|v| v.clamp(1, 86400)),
            ..Self::new("http", endpoint)
        }
    }
}
pub(super) fn record_failure(failure: Failure) {
    FAILURE.with(|slot| *slot.borrow_mut() = Some(failure));
}
pub(super) fn take_failure() -> Option<Failure> {
    FAILURE.with(|slot| slot.borrow_mut().take())
}
static MANGADEX: Mutex<Option<Instant>> = Mutex::new(None);
static KAKAO: Mutex<Option<Instant>> = Mutex::new(None);
pub(super) fn metrics() -> Metrics {
    METRICS.with(Cell::get)
}
pub(super) struct Request(Instant);
impl Request {
    pub(super) fn start(provider: &str) -> Self {
        // 4 requests/s for MangaDex (documented global maximum: 5/s).
        // Kakao's 100ms spacing is our conservative pacing, not a claimed API quota.
        let (lock, spacing) = if provider == "mangadex" {
            (&MANGADEX, 250)
        } else {
            (&KAKAO, 100)
        };
        let started = Instant::now();
        let mut last = lock
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(previous) = *last {
            std::thread::sleep(Duration::from_millis(spacing).saturating_sub(previous.elapsed()));
        }
        *last = Some(Instant::now());
        drop(last);
        METRICS.with(|m| {
            let mut value = m.get();
            value.requests += 1;
            value.throttle_ms += started.elapsed().as_millis() as u64;
            m.set(value);
        });
        Self(Instant::now())
    }
}
impl Drop for Request {
    fn drop(&mut self) {
        METRICS.with(|m| {
            let mut value = m.get();
            value.network_ms += self.0.elapsed().as_millis() as u64;
            m.set(value);
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn retry_headers_support_seconds_http_dates_and_mangadex_epoch() {
        let mut headers = ureq::http::HeaderMap::new();
        headers.insert("retry-after", "75".parse().unwrap());
        assert_eq!(
            Failure::http(429, &headers, "covers").retry_after_seconds,
            Some(75)
        );
        let now = chrono::Utc::now();
        headers.insert(
            "retry-after",
            (now + chrono::Duration::seconds(90))
                .to_rfc2822()
                .parse()
                .unwrap(),
        );
        assert!((89..=90).contains(
            &Failure::http(503, &headers, "detail")
                .retry_after_seconds
                .unwrap()
        ));
        headers.insert(
            "x-ratelimit-retry-after",
            (now.timestamp() + 120).to_string().parse().unwrap(),
        );
        assert!((119..=120).contains(
            &Failure::http(429, &headers, "covers")
                .retry_after_seconds
                .unwrap()
        ));
        headers.insert("retry-after", "invalid".parse().unwrap());
        headers.remove("x-ratelimit-retry-after");
        assert_eq!(
            Failure::http(429, &headers, "covers").retry_after_seconds,
            None
        );
    }
    #[test]
    fn transport_diagnostics_never_copy_sensitive_error_payloads() {
        let error = ureq::Error::BadUri("https://example.test/?key=secret".into());
        let failure = Failure::transport(&error, "search");
        assert_eq!(failure.kind, "connection");
        assert!(!serde_json::to_string(&failure).unwrap().contains("secret"));
        record_failure(failure);
        assert!(take_failure().is_some());
        assert!(take_failure().is_none());
    }
}
