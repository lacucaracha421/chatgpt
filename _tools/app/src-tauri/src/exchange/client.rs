//! Blocking HTTP client for `/v1/exchange` (server module `file_exchange.py`).
//!
//! Like `cloud::client`, it uses `ureq` with no redirects. Status codes are read, not
//! turned into transport errors, so the server's `{"detail":{"code":..}}` reaches the UI
//! as a specific message. Bytes never pass through the API: uploads and downloads go
//! straight to presigned R2 URLs, which are never logged.
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs::{File, OpenOptions},
    io::{self, Read, Write},
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};

const MAX_JSON_BYTES: usize = 1024 * 1024;
/// The server's inbox page size (`INBOX_LIMIT`).
pub(crate) const INBOX_PAGE: usize = 100;
const API_TIMEOUT: Duration = Duration::from_secs(30);
/// Presigned transfers have no total deadline, so a slow link can finish a 2 GiB file;
/// instead each socket read or write must make progress within this time.
pub(crate) const TRANSFER_IDLE: Duration = Duration::from_secs(30);

#[derive(Debug)]
pub(crate) enum ApiError {
    /// No response: offline, DNS or TLS. Retried with backoff.
    Network,
    /// A connection that stopped making progress. Retried, but only a few times in a row.
    TimedOut,
    /// A response with an error status and, when the server sent one, its code.
    Status {
        status: u16,
        code: Option<String>,
        state: Option<String>,
    },
    /// A response this client cannot use.
    Invalid,
    /// A local file could not be read or written.
    Local(io::Error),
    /// The received bytes do not match the declared size or SHA-256.
    Corrupt,
    /// Refused locally before any request, with the Korean message for the row.
    Refused(String),
    Cancelled,
}

impl ApiError {
    pub(crate) fn code(&self) -> Option<&str> {
        match self {
            Self::Status { code, .. } => code.as_deref(),
            _ => None,
        }
    }

    pub(crate) fn status(&self) -> Option<u16> {
        match self {
            Self::Status { status, .. } => Some(*status),
            _ => None,
        }
    }

    /// Worth retrying on its own: no answer, a gateway/server failure or a rate limit.
    pub(crate) fn transient(&self) -> bool {
        match self {
            Self::Network | Self::TimedOut => true,
            Self::Status { status, .. } => *status >= 500 || *status == 429 || *status == 408,
            _ => false,
        }
    }
}

type Result<T> = std::result::Result<T, ApiError>;

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Device {
    pub device_id: String,
    pub name: String,
    pub kind: String,
    #[serde(default)]
    pub last_seen_at: Option<String>,
    #[serde(rename = "self", default)]
    pub is_self: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Transfer {
    pub transfer_id: String,
    #[serde(default)]
    pub to_name: Option<String>,
    pub file_name: String,
    pub size_bytes: u64,
    pub state: String,
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub failure: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InboxItem {
    pub transfer_id: String,
    #[serde(default)]
    pub from_name: Option<String>,
    pub file_name: String,
    pub size_bytes: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Upload {
    pub method: String,
    pub url: String,
    #[serde(default)]
    pub required_headers: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Created {
    #[serde(flatten)]
    pub transfer: Transfer,
    #[serde(default)]
    pub upload: Option<Upload>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Ticket {
    pub url: String,
    pub size_bytes: u64,
    pub sha256: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CreateRequest<'a> {
    pub transfer_id: &'a str,
    pub batch_id: &'a str,
    pub to_device: &'a str,
    pub file_name: &'a str,
    pub size_bytes: u64,
    pub sha256: &'a str,
}

#[derive(Deserialize)]
struct Items<T> {
    #[serde(default = "Vec::new")]
    items: Vec<T>,
}

#[derive(Deserialize)]
struct Devices {
    devices: Vec<Device>,
}

#[derive(Clone)]
pub(crate) struct ExchangeClient {
    agent: ureq::Agent,
    base: url::Url,
    authorization: String,
    device_id: String,
}

fn agent(send_body: Duration, recv_body: Duration) -> ureq::Agent {
    ureq::Agent::config_builder()
        .max_redirects(0)
        .http_status_as_error(false)
        .timeout_connect(Some(API_TIMEOUT))
        .timeout_send_request(Some(API_TIMEOUT))
        .timeout_send_body(Some(send_body))
        .timeout_recv_response(Some(Duration::from_secs(120)))
        .timeout_recv_body(Some(recv_body))
        .build()
        .into()
}

mod idle {
    //! A transport wrapper that caps every socket wait at an idle limit. ureq's own
    //! body timeouts are total deadlines; clamping each read/write turns them into
    //! "no progress for `limit`" timeouts.
    use std::time::Duration;
    use ureq::unversioned::transport::{
        Buffers, ConnectionDetails, Connector, NextTimeout, Transport,
    };

    #[derive(Debug)]
    pub(super) struct IdleConnector(pub(super) Duration);

    #[derive(Debug)]
    pub(super) struct IdleTransport {
        inner: Box<dyn Transport>,
        limit: Duration,
    }

    impl IdleTransport {
        fn clamp(&self, timeout: NextTimeout) -> NextTimeout {
            NextTimeout {
                after: timeout.after.min(self.limit.into()),
                reason: timeout.reason,
            }
        }
    }

    impl Connector<Box<dyn Transport>> for IdleConnector {
        type Out = IdleTransport;

        fn connect(
            &self,
            _details: &ConnectionDetails,
            chained: Option<Box<dyn Transport>>,
        ) -> Result<Option<Self::Out>, ureq::Error> {
            Ok(chained.map(|inner| IdleTransport {
                inner,
                limit: self.0,
            }))
        }
    }

    impl Transport for IdleTransport {
        fn buffers(&mut self) -> &mut dyn Buffers {
            self.inner.buffers()
        }
        fn transmit_output(
            &mut self,
            amount: usize,
            timeout: NextTimeout,
        ) -> Result<(), ureq::Error> {
            let timeout = self.clamp(timeout);
            self.inner.transmit_output(amount, timeout)
        }
        fn maybe_await_input(&mut self, timeout: NextTimeout) -> Result<bool, ureq::Error> {
            let timeout = self.clamp(timeout);
            self.inner.maybe_await_input(timeout)
        }
        fn await_input(&mut self, timeout: NextTimeout) -> Result<bool, ureq::Error> {
            let timeout = self.clamp(timeout);
            self.inner.await_input(timeout)
        }
        fn is_open(&mut self) -> bool {
            self.inner.is_open()
        }
        fn is_tls(&self) -> bool {
            self.inner.is_tls()
        }
    }
}

/// An agent for presigned transfers: no total body deadline, an idle limit instead.
fn transfer_agent(idle: Duration) -> ureq::Agent {
    use ureq::unversioned::transport::{Connector, DefaultConnector};
    let config = ureq::Agent::config_builder()
        .max_redirects(0)
        .http_status_as_error(false)
        .timeout_connect(Some(API_TIMEOUT))
        .timeout_send_request(Some(API_TIMEOUT))
        .timeout_send_body(None)
        .timeout_recv_response(Some(Duration::from_secs(120)))
        .timeout_recv_body(None)
        .build();
    let connector = DefaultConnector::new().chain(idle::IdleConnector(idle));
    ureq::Agent::with_parts(
        config,
        connector,
        ureq::unversioned::resolver::DefaultResolver::default(),
    )
}

/// Presigned R2 URLs must be https; plain http is accepted only for a loopback host
/// (local tests and development servers).
fn presigned(url: &str) -> Result<url::Url> {
    let parsed = url::Url::parse(url).map_err(|_| ApiError::Invalid)?;
    let loopback = match parsed.host() {
        Some(url::Host::Domain(host)) => host.eq_ignore_ascii_case("localhost"),
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        None => false,
    };
    let scheme_ok = parsed.scheme() == "https" || (parsed.scheme() == "http" && loopback);
    if !scheme_ok || !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(ApiError::Invalid);
    }
    Ok(parsed)
}

/// A body read error: ureq wraps its own timeout in an `Other` I/O error.
fn read_error(error: io::Error) -> ApiError {
    let wrapped_timeout = error
        .get_ref()
        .and_then(|inner| inner.downcast_ref::<ureq::Error>())
        .is_some_and(|inner| matches!(inner, ureq::Error::Timeout(_)));
    if wrapped_timeout || error.kind() == io::ErrorKind::TimedOut {
        ApiError::TimedOut
    } else {
        ApiError::Network
    }
}

fn network(error: ureq::Error) -> ApiError {
    match error {
        ureq::Error::Timeout(_) => ApiError::TimedOut,
        ureq::Error::Io(error) if error.kind() == io::ErrorKind::TimedOut => ApiError::TimedOut,
        _ => ApiError::Network,
    }
}

fn read_limited(response: &mut ureq::http::Response<ureq::Body>) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    response
        .body_mut()
        .as_reader()
        .take(MAX_JSON_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| ApiError::Network)?;
    if bytes.len() > MAX_JSON_BYTES {
        return Err(ApiError::Invalid);
    }
    Ok(bytes)
}

/// `{"detail":{"code":"..","state":".."}}` from a FastAPI `HTTPException`.
fn status_error(status: u16, body: &[u8]) -> ApiError {
    let detail = serde_json::from_slice::<serde_json::Value>(body)
        .ok()
        .and_then(|value| value.get("detail").cloned());
    let field = |name: &str| {
        detail
            .as_ref()
            .and_then(|detail| detail.get(name))
            .and_then(|value| value.as_str())
            .map(str::to_owned)
    };
    ApiError::Status {
        status,
        code: field("code"),
        state: field("state"),
    }
}

fn json<T: serde::de::DeserializeOwned>(
    mut response: ureq::http::Response<ureq::Body>,
) -> Result<T> {
    let status = response.status().as_u16();
    let body = read_limited(&mut response)?;
    if !(200..300).contains(&status) {
        return Err(status_error(status, &body));
    }
    serde_json::from_slice(&body).map_err(|_| ApiError::Invalid)
}

impl ExchangeClient {
    pub(crate) fn new(base_url: &str, token: &str, device_id: &str) -> Result<Self> {
        let base = url::Url::parse(base_url.trim()).map_err(|_| ApiError::Invalid)?;
        if !matches!(base.scheme(), "http" | "https") || !base.username().is_empty() {
            return Err(ApiError::Invalid);
        }
        let token = token.trim();
        if token.is_empty() || token.contains(['\r', '\n']) {
            return Err(ApiError::Invalid);
        }
        Ok(Self {
            agent: agent(API_TIMEOUT, API_TIMEOUT),
            base,
            authorization: format!("Bearer {token}"),
            device_id: device_id.to_owned(),
        })
    }

    fn url(&self, path: &str) -> Result<String> {
        self.base
            .join(path)
            .map(|url| url.to_string())
            .map_err(|_| ApiError::Invalid)
    }

    fn get(&self, path: &str) -> Result<ureq::RequestBuilder<ureq::typestate::WithoutBody>> {
        Ok(self
            .agent
            .get(self.url(path)?)
            .header("Authorization", &self.authorization)
            .header("X-Lakomics-Device", &self.device_id))
    }

    fn post(&self, path: &str) -> Result<ureq::RequestBuilder<ureq::typestate::WithBody>> {
        Ok(self
            .agent
            .post(self.url(path)?)
            .header("Authorization", &self.authorization)
            .header("X-Lakomics-Device", &self.device_id))
    }

    /// Register or rename this device (`kind: "pc"`).
    pub(crate) fn register(&self, name: &str) -> Result<Device> {
        let body = serde_json::json!({ "name": name, "kind": "pc" }).to_string();
        let response = self
            .agent
            .put(self.url(&format!("/v1/exchange/devices/{}", self.device_id))?)
            .header("Authorization", &self.authorization)
            .content_type("application/json")
            .send(body.as_bytes())
            .map_err(network)?;
        json(response)
    }

    pub(crate) fn devices(&self) -> Result<Vec<Device>> {
        Ok(json::<Devices>(self.get("/v1/exchange/devices")?.call().map_err(network)?)?.devices)
    }

    /// The `exchange.revision` counter from `/v1/sync/status`, read conditionally.
    ///
    /// `cache` holds the last ETag and value, so an unchanged server costs one `304`.
    /// `None` means the server reports no exchange for this credential. With `wait` (and a
    /// cached ETag) a long-poll capable server holds the request until the document changes
    /// or the wait ends. The second value is the server's advertised `Lakomics-Status-Wait`
    /// (absent on a server without long-poll).
    pub(crate) fn revision(
        &self,
        cache: &mut Option<(String, Option<i64>)>,
        wait: Option<u64>,
    ) -> Result<(Option<i64>, Option<u64>)> {
        let mut url = url::Url::parse(&self.url("/v1/sync/status")?).map_err(|_| ApiError::Invalid)?;
        if let (Some(wait), Some(_)) = (wait, cache.as_ref()) {
            url.query_pairs_mut().append_pair("wait", &wait.to_string());
        }
        let mut request = self
            .agent
            .get(url.as_str())
            .header("Authorization", &self.authorization);
        if let Some((etag, _)) = cache {
            request = request.header("If-None-Match", etag.as_str());
        }
        let mut response = request.call().map_err(network)?;
        let status = response.status().as_u16();
        let advertised = response
            .headers()
            .get(crate::cloud::client::STATUS_WAIT_HEADER)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.trim().parse::<f64>().ok())
            .filter(|value| value.is_finite() && *value >= 1.0)
            .map(|value| value as u64);
        if status == 304 {
            return cache
                .as_ref()
                .map(|(_, value)| (*value, advertised))
                .ok_or(ApiError::Invalid);
        }
        let etag = response
            .headers()
            .get("etag")
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned);
        let body = read_limited(&mut response)?;
        if !(200..300).contains(&status) {
            return Err(status_error(status, &body));
        }
        let value: serde_json::Value =
            serde_json::from_slice(&body).map_err(|_| ApiError::Invalid)?;
        let revision = value
            .get("exchange")
            .and_then(|exchange| exchange.get("revision"))
            .and_then(|revision| revision.as_i64());
        *cache = etag
            .filter(|etag| etag.len() <= 256)
            .map(|etag| (etag, revision));
        Ok((revision, advertised))
    }

    pub(crate) fn inbox(&self) -> Result<Vec<InboxItem>> {
        Ok(
            json::<Items<InboxItem>>(self.get("/v1/exchange/inbox")?.call().map_err(network)?)?
                .items,
        )
    }

    pub(crate) fn outbox(&self) -> Result<Vec<Transfer>> {
        Ok(
            json::<Items<Transfer>>(self.get("/v1/exchange/outbox")?.call().map_err(network)?)?
                .items,
        )
    }

    /// Idempotent on `transferId`: a retry with the same body returns the same row
    /// and a fresh upload URL while the upload is still open.
    pub(crate) fn create(&self, request: &CreateRequest<'_>) -> Result<Created> {
        let body = serde_json::to_vec(request).map_err(|_| ApiError::Invalid)?;
        let response = self
            .post("/v1/exchange/transfers")?
            .content_type("application/json")
            .send(&body[..])
            .map_err(network)?;
        json(response)
    }

    pub(crate) fn complete(&self, transfer_id: &str) -> Result<Transfer> {
        let response = self
            .post(&format!("/v1/exchange/transfers/{transfer_id}/complete"))?
            .send_empty()
            .map_err(network)?;
        json(response)
    }

    pub(crate) fn ticket(&self, transfer_id: &str) -> Result<Ticket> {
        let response = self
            .post(&format!("/v1/exchange/transfers/{transfer_id}/ticket"))?
            .send_empty()
            .map_err(network)?;
        json(response)
    }

    pub(crate) fn ack(&self, transfer_id: &str, sha256: &str) -> Result<Transfer> {
        let body = serde_json::json!({ "sha256": sha256 }).to_string();
        let response = self
            .post(&format!("/v1/exchange/transfers/{transfer_id}/ack"))?
            .content_type("application/json")
            .send(body.as_bytes())
            .map_err(network)?;
        json(response)
    }

    /// Withdraw (sender) or decline (receiver); idempotent once the transfer is final.
    pub(crate) fn cancel(&self, transfer_id: &str) -> Result<Transfer> {
        let response = self
            .agent
            .delete(self.url(&format!("/v1/exchange/transfers/{transfer_id}"))?)
            .header("Authorization", &self.authorization)
            .header("X-Lakomics-Device", &self.device_id)
            .call()
            .map_err(network)?;
        json(response)
    }
}

/// Stream `source` to a presigned PUT with an explicit `Content-Length` (R2 rejects
/// chunked uploads). `source` reports progress and may fail with `Interrupted` on cancel.
pub(crate) fn upload(upload: &Upload, source: impl Read + Send + 'static, size: u64) -> Result<()> {
    if upload.method != "PUT" {
        return Err(ApiError::Invalid);
    }
    let url = presigned(&upload.url)?;
    let mut request = transfer_agent(TRANSFER_IDLE)
        .put(url.as_str())
        .header("Content-Length", size.to_string());
    for (name, value) in &upload.required_headers {
        if name.eq_ignore_ascii_case("content-length") || name.eq_ignore_ascii_case("host") {
            continue;
        }
        let name = ureq::http::header::HeaderName::try_from(name.as_str())
            .map_err(|_| ApiError::Invalid)?;
        let value = ureq::http::header::HeaderValue::try_from(value.as_str())
            .map_err(|_| ApiError::Invalid)?;
        request = request.header(name, value);
    }
    // A cancel surfaces here as a failed read; the caller checks its cancel flag first.
    let mut response = request
        .send(ureq::SendBody::from_owned_reader(source))
        .map_err(network)?;
    let status = response.status().as_u16();
    if !(200..300).contains(&status) {
        let _ = read_limited(&mut response);
        return Err(ApiError::Status {
            status,
            code: None,
            state: None,
        });
    }
    Ok(())
}

/// Download a ticket into `part`, resuming at `offset` with `Range`. A server that
/// ignores the range (200) restarts the part from zero. Never writes past `size`.
pub(crate) fn download(
    ticket: &Ticket,
    part: &Path,
    offset: u64,
    size: u64,
    cancel: &AtomicBool,
    progress: impl FnMut(u64),
) -> Result<()> {
    download_with(
        transfer_agent(TRANSFER_IDLE),
        ticket,
        part,
        offset,
        size,
        cancel,
        progress,
    )
}

fn download_with(
    agent: ureq::Agent,
    ticket: &Ticket,
    part: &Path,
    offset: u64,
    size: u64,
    cancel: &AtomicBool,
    mut progress: impl FnMut(u64),
) -> Result<()> {
    let url = presigned(&ticket.url)?;
    let mut request = agent.get(url.as_str());
    if offset > 0 {
        request = request.header("Range", format!("bytes={offset}-"));
    }
    let mut response = request.call().map_err(network)?;
    let status = response.status().as_u16();
    let (mut file, mut written) = match status {
        206 if offset > 0 => {
            let range = response
                .headers()
                .get("content-range")
                .and_then(|value| value.to_str().ok())
                .unwrap_or("");
            if !range.starts_with(&format!("bytes {offset}-")) {
                return Err(ApiError::Invalid);
            }
            let file = OpenOptions::new()
                .append(true)
                .open(part)
                .map_err(ApiError::Local)?;
            (file, offset)
        }
        200 => (File::create(part).map_err(ApiError::Local)?, 0),
        _ => {
            let _ = read_limited(&mut response);
            return Err(ApiError::Status {
                status,
                code: None,
                state: None,
            });
        }
    };
    let mut reader = response.body_mut().as_reader();
    let mut buffer = vec![0u8; 256 * 1024];
    loop {
        if cancel.load(Ordering::Acquire) {
            return Err(ApiError::Cancelled);
        }
        let read = reader.read(&mut buffer).map_err(read_error)?;
        if read == 0 {
            break;
        }
        if written + read as u64 > size {
            return Err(ApiError::Invalid);
        }
        file.write_all(&buffer[..read]).map_err(ApiError::Local)?;
        written += read as u64;
        progress(written);
    }
    file.sync_all().map_err(ApiError::Local)?;
    if written != size {
        // A short body: keep the part and resume next time.
        return Err(ApiError::Network);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn server_error_codes_are_read_from_the_detail_object() {
        let error = status_error(
            403,
            br#"{"detail":{"code":"exchangeDeviceTokenRequired","message":"x"}}"#,
        );
        assert_eq!(error.code(), Some("exchangeDeviceTokenRequired"));
        assert_eq!(error.status(), Some(403));
        assert!(!error.transient());
        let gone = status_error(
            410,
            br#"{"detail":{"code":"transferGone","state":"expired"}}"#,
        );
        assert!(matches!(gone, ApiError::Status { state: Some(ref s), .. } if s == "expired"));
        let plain = status_error(404, br#"{"detail":"Not Found"}"#);
        assert_eq!(plain.code(), None);
        assert!(status_error(503, b"").transient());
    }

    #[test]
    fn the_status_read_asks_to_be_held_only_with_a_tag_and_reads_the_wait_header() {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let base = format!("http://{}", server.server_addr());
        let handle = std::thread::spawn(move || {
            let mut seen = Vec::new();
            for status in [200, 304, 304] {
                let request = server.recv().unwrap();
                let tag = request
                    .headers()
                    .iter()
                    .find(|header| header.field.equiv("If-None-Match"))
                    .map(|header| header.value.as_str().to_owned());
                seen.push((request.url().to_owned(), tag));
                let body = if status == 200 {
                    r#"{"exchange":{"revision":4}}"#
                } else {
                    ""
                };
                let mut response = tiny_http::Response::from_string(body)
                    .with_status_code(status)
                    .with_header(tiny_http::Header::from_bytes("ETag", "\"t1\"").unwrap());
                if seen.len() < 3 {
                    response.add_header(
                        tiny_http::Header::from_bytes("Lakomics-Status-Wait", "50").unwrap(),
                    );
                }
                request.respond(response).unwrap();
            }
            seen
        });
        let client = ExchangeClient::new(&base, "device-token", "device-1").unwrap();
        let mut cache = None;
        // No tag yet: a hold could not be honoured, so none is asked for.
        assert_eq!(client.revision(&mut cache, Some(50)).unwrap(), (Some(4), Some(50)));
        assert_eq!(client.revision(&mut cache, Some(50)).unwrap(), (Some(4), Some(50)));
        // An older server answers without the header: the receiver stops asking.
        assert_eq!(client.revision(&mut cache, None).unwrap(), (Some(4), None));
        let seen = handle.join().unwrap();
        assert_eq!(
            seen,
            vec![
                ("/v1/sync/status".to_owned(), None),
                ("/v1/sync/status?wait=50".to_owned(), Some("\"t1\"".to_owned())),
                ("/v1/sync/status".to_owned(), Some("\"t1\"".to_owned())),
            ]
        );
        // Idle against a long-poll server: well inside the 19-per-quarter-hour budget.
        let quarter = std::time::Duration::from_secs(15 * 60);
        assert_eq!(super::super::idle_status_requests(quarter, false), 17);
        assert_eq!(super::super::idle_status_requests(quarter, true), 14);
    }

    #[test]
    fn create_response_keeps_the_transfer_and_optional_upload() {
        let created: Created = serde_json::from_str(
            r#"{"transferId":"t","batchId":"b","fromDevice":"f","fromName":"PC","toDevice":"d","toName":"Tab",
               "fileName":"a.txt","sizeBytes":3,"sha256":"x","contentTypeHint":null,"state":"uploading",
               "createdAt":"2026-09-25T00:00:00Z","readyAt":null,"expiresAt":"z","deliveredAt":null,
               "finishedAt":null,"failure":null,
               "upload":{"method":"PUT","url":"https://r2/x","expiresIn":900,
                         "requiredHeaders":{"Content-Type":"application/octet-stream"}}}"#,
        )
        .unwrap();
        assert_eq!(created.transfer.state, "uploading");
        assert_eq!(created.transfer.to_name.as_deref(), Some("Tab"));
        assert_eq!(
            created.upload.unwrap().required_headers["Content-Type"],
            "application/octet-stream"
        );
        let finished: Created = serde_json::from_str(
            r#"{"transferId":"t","fileName":"a","sizeBytes":1,"state":"ready","upload":null}"#,
        )
        .unwrap();
        assert!(finished.upload.is_none());
    }

    /// A presigned GET stand-in: honours `Range` unless `ranges` is false.
    fn serve(
        body: &'static [u8],
        ranges: bool,
        requests: usize,
    ) -> (String, std::thread::JoinHandle<Vec<Option<String>>>) {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let url = format!("http://{}/object", server.server_addr().to_ip().unwrap());
        let handle = std::thread::spawn(move || {
            let mut seen = Vec::new();
            for _ in 0..requests {
                let request = server.recv().unwrap();
                let range = request
                    .headers()
                    .iter()
                    .find(|header| header.field.equiv("Range"))
                    .map(|header| header.value.as_str().to_owned());
                let start = range
                    .as_deref()
                    .filter(|_| ranges)
                    .and_then(|value| value.strip_prefix("bytes="))
                    .and_then(|value| value.trim_end_matches('-').parse::<usize>().ok());
                let response = match start {
                    Some(start) => tiny_http::Response::from_data(body[start..].to_vec())
                        .with_status_code(206)
                        .with_header(
                            tiny_http::Header::from_bytes(
                                "Content-Range",
                                format!("bytes {start}-{}/{}", body.len() - 1, body.len()),
                            )
                            .unwrap(),
                        ),
                    None => tiny_http::Response::from_data(body.to_vec()),
                };
                request.respond(response).unwrap();
                seen.push(range);
            }
            seen
        });
        (url, handle)
    }

    fn ticket(url: String, body: &[u8]) -> Ticket {
        Ticket {
            url,
            size_bytes: body.len() as u64,
            sha256: crate::exchange::files::sha256_reader(body, |_| {}).unwrap(),
        }
    }

    #[test]
    fn download_resumes_a_part_file_with_range() {
        const BODY: &[u8] = b"hello exchange";
        let (url, server) = serve(BODY, true, 1);
        let dir = tempfile::tempdir().unwrap();
        let part = dir.path().join("p");
        std::fs::write(&part, &BODY[..6]).unwrap();
        let mut last = 0;
        download(
            &ticket(url, BODY),
            &part,
            6,
            BODY.len() as u64,
            &AtomicBool::new(false),
            |done| last = done,
        )
        .unwrap();
        assert_eq!(std::fs::read(&part).unwrap(), BODY);
        assert_eq!(last, BODY.len() as u64);
        assert_eq!(server.join().unwrap(), [Some("bytes=6-".to_owned())]);
    }

    #[test]
    fn a_server_ignoring_range_restarts_the_part() {
        const BODY: &[u8] = b"whole object";
        let (url, server) = serve(BODY, false, 1);
        let dir = tempfile::tempdir().unwrap();
        let part = dir.path().join("p");
        std::fs::write(&part, b"stale").unwrap();
        download(
            &ticket(url, BODY),
            &part,
            5,
            BODY.len() as u64,
            &AtomicBool::new(false),
            |_| {},
        )
        .unwrap();
        assert_eq!(std::fs::read(&part).unwrap(), BODY);
        server.join().unwrap();
    }

    #[test]
    fn a_longer_body_than_declared_is_refused() {
        const BODY: &[u8] = b"more bytes than promised";
        let (url, server) = serve(BODY, true, 1);
        let dir = tempfile::tempdir().unwrap();
        let part = dir.path().join("p");
        let mut short = ticket(url, BODY);
        short.size_bytes = 4;
        assert!(matches!(
            download(&short, &part, 0, 4, &AtomicBool::new(false), |_| {}),
            Err(ApiError::Invalid)
        ));
        server.join().unwrap();
    }

    #[test]
    fn presigned_urls_must_be_https_except_on_loopback() {
        assert!(presigned("https://bucket.r2.example/x?sig=1").is_ok());
        assert!(presigned("http://127.0.0.1:9000/x").is_ok());
        assert!(presigned("http://[::1]/x").is_ok());
        assert!(presigned("http://localhost/x").is_ok());
        assert!(presigned("http://bucket.r2.example/x").is_err());
        assert!(presigned("http://10.0.0.1/x").is_err());
        assert!(presigned("ftp://127.0.0.1/x").is_err());
        assert!(presigned("https://user:pw@bucket.example/x").is_err());
    }

    /// Sends part of the body, then stalls longer than the idle limit.
    #[test]
    fn a_stalled_download_times_out_without_a_total_deadline() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/object", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut request = [0u8; 1024];
            let _ = socket.read(&mut request);
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nabc")
                .unwrap();
            std::thread::sleep(Duration::from_secs(3));
        });
        let dir = tempfile::tempdir().unwrap();
        let part = dir.path().join("p");
        let started = std::time::Instant::now();
        let ticket = Ticket {
            url,
            size_bytes: 10,
            sha256: "0".repeat(64),
        };
        let result = download_with(
            transfer_agent(Duration::from_millis(500)),
            &ticket,
            &part,
            0,
            10,
            &AtomicBool::new(false),
            |_| {},
        );
        assert!(matches!(result, Err(ApiError::TimedOut)), "{result:?}");
        assert!(started.elapsed() < Duration::from_secs(3));
        server.join().unwrap();
    }

    #[test]
    fn a_cancelled_download_stops() {
        const BODY: &[u8] = b"cancel me";
        let (url, server) = serve(BODY, true, 1);
        let dir = tempfile::tempdir().unwrap();
        let part = dir.path().join("p");
        let result = download(
            &ticket(url, BODY),
            &part,
            0,
            BODY.len() as u64,
            &AtomicBool::new(true),
            |_| {},
        );
        assert!(matches!(result, Err(ApiError::Cancelled)));
        server.join().unwrap();
    }
}
