//! Direct (TRANSFER-001) sender: one file to one peer over its LAN, then Tailscale, under the
//! same transfer id the server path uses. The caller falls back to the server whenever
//! [`Sender::send`] answers [`Outcome::Fallback`].
//!
//! Every request is its own mutually pinned TLS 1.3 connection (the receiver serves one
//! request per connection): the peer certificate must hash to exactly the pin the server
//! published for the target device, and our own certificate is the client certificate.
//! Mirrors `android/.../LanSender.java` so both clients decide the same way.
use super::{addresses, http, identity::Identity, tls, LanAddress, LanPeer};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, ServerName};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::{self, Read, Write},
    net::{IpAddr, Shutdown, SocketAddr, TcpStream},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

const LAN_CONNECT: Duration = Duration::from_millis(1_500);
const TAILSCALE_CONNECT: Duration = Duration::from_millis(3_000);
/// TLS handshake plus the `/info` answer.
const PROBE: Duration = Duration::from_millis(3_000);
const REQUEST: Duration = Duration::from_millis(5_000);
const ROUTE_MEMO: Duration = Duration::from_secs(600);
const UNREACHABLE_MEMO: Duration = Duration::from_secs(60);
/// An upload that moves no byte for this long is dropped.
const IDLE: Duration = Duration::from_millis(15_000);
const MAX_ADDRESSES: usize = 4;
const MAX_MEMO: usize = 64;
const ROOT: &str = "/api/lakomics/lan/v1";

/// One file to send, with the ids the server path would use.
pub(in crate::exchange) struct Job<'a> {
    pub id: &'a str,
    pub batch: &'a str,
    pub from: &'a str,
    pub name: &'a str,
    pub size: u64,
    pub sha256: &'a str,
}

impl Job<'_> {
    fn prepare_body(&self) -> Value {
        json!({"transferId":self.id,"batchId":self.batch,"fromDevice":self.from,
            "fileName":self.name,"sizeBytes":self.size,"sha256":self.sha256})
    }
}

/// Opens the file positioned at the given offset.
pub(in crate::exchange) type Source<'a> = &'a dyn Fn(u64) -> io::Result<Box<dyn Read>>;

#[derive(Debug, PartialEq, Eq)]
pub(in crate::exchange) enum Outcome {
    /// The receiver has the file and a durable receipt.
    Saved { route: &'static str },
    /// The server takes over under the same id. `refresh`: the cached peer data may be
    /// stale (pin or identity refused), so re-read the device list.
    Fallback {
        route: Option<&'static str>,
        reason: String,
        refresh: bool,
    },
    /// The receiving side declined or cancelled it: nothing may reach the server.
    PeerCancelled { route: Option<&'static str> },
    /// The user cancelled here.
    Cancelled,
}

#[derive(Debug)]
pub(in crate::exchange) enum Fail {
    Cancelled,
    /// Our own file could not be read; never a reason to try the server.
    Local(&'static str),
    Refused {
        status: u16,
        code: String,
    },
    /// Handshake, certificate or pin trouble.
    Tls(io::Error),
    Io(io::Error),
}

#[derive(Debug, PartialEq, Eq)]
pub(in crate::exchange) enum Step {
    Resume,
    Fallback,
    Stop,
}

/// What to do after a failed request. `mid_transfer` is true once the upload PUT started;
/// `resumes` counts direct resumes already used (network loss, offset mismatch) and
/// `digests` the digest mismatches already retried: one of each, then the server takes over.
pub(in crate::exchange) fn decide(
    failure: &Fail,
    mid_transfer: bool,
    resumes: u8,
    digests: u8,
) -> Step {
    match failure {
        Fail::Cancelled | Fail::Local(_) => Step::Stop,
        Fail::Refused { status, code, .. } => match (*status, code.as_str()) {
            (410, _) | (_, "cancelled") => Step::Stop,
            (409, "offsetMismatch") if mid_transfer && resumes < 1 => Step::Resume,
            (422, "digestMismatch") if mid_transfer && digests < 1 => Step::Resume,
            // busy, notReceiving, any 5xx, deviceMismatch, invalidRequest, fileTooLarge, unknown.
            _ => Step::Fallback,
        },
        Fail::Io(_) | Fail::Tls(_) if mid_transfer && resumes < 1 => Step::Resume,
        Fail::Io(_) | Fail::Tls(_) => Step::Fallback,
    }
}

fn describe(failure: &Fail) -> String {
    match failure {
        Fail::Cancelled => "cancelled".into(),
        Fail::Local(code) => (*code).into(),
        Fail::Refused { status, code, .. } => format!("{status} {code}"),
        Fail::Tls(error) => format!("tls: {error}"),
        Fail::Io(error) => format!("io: {error}"),
    }
}

fn route_of(address: &LanAddress) -> &'static str {
    if address.kind == "lan" {
        "lan"
    } else {
        "tailscale"
    }
}

fn connect_timeout(address: &LanAddress) -> Duration {
    if address.kind == "lan" {
        LAN_CONNECT
    } else {
        TAILSCALE_CONNECT
    }
}

/// The receiver verifies and publishes after the last byte, so its answer takes time
/// proportional to the file.
fn reply_timeout(size: u64) -> Duration {
    Duration::from_millis(30_000 + size / 4096)
}

fn peer_key(peer: &LanPeer) -> String {
    format!(
        "{}|{}|{}",
        peer.device_id, peer.report.cert_sha256, peer.report.port
    )
}

/// LAN addresses first, then Tailscale, at most [`MAX_ADDRESSES`]; only literal private or
/// CGNAT IPv4 matching their kind. The route that worked recently goes first. A malformed
/// pin or port yields no candidates at all.
pub(in crate::exchange) fn candidates(
    peer: &LanPeer,
    remembered: Option<&LanAddress>,
) -> Vec<LanAddress> {
    let pin = &peer.report.cert_sha256;
    let valid_pin = pin.len() == 64
        && pin
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    if !valid_pin || peer.report.port < 1024 {
        return Vec::new();
    }
    let (mut lan, mut tailscale) = (Vec::<LanAddress>::new(), Vec::<LanAddress>::new());
    for address in &peer.report.addresses {
        if !addresses::allowed(&address.kind, address.ip) {
            continue;
        }
        let target = if address.kind == "lan" {
            &mut lan
        } else {
            &mut tailscale
        };
        if !target.contains(address) {
            target.push(address.clone());
        }
    }
    lan.extend(tailscale);
    lan.truncate(MAX_ADDRESSES);
    if let Some(index) = remembered
        .and_then(|known| lan.iter().position(|address| address == known))
        .filter(|index| *index > 0)
    {
        let first = lan.remove(index);
        lan.insert(0, first);
    }
    lan
}

/// Why a reachable, recognised peer cannot take this file right now (`None`: go ahead).
fn refusal(info: &Value, peer: &LanPeer, size: u64) -> Option<&'static str> {
    if info["protocol"].as_u64() != Some(1) {
        return Some("protocol");
    }
    if info["deviceId"].as_str() != Some(peer.device_id.as_str()) {
        return Some("device");
    }
    if info["receiving"].as_bool() != Some(true) {
        return Some("notReceiving");
    }
    match info["maxFileBytes"].as_u64() {
        Some(limit) if size <= limit => None,
        _ => Some("fileTooLarge"),
    }
}

/// Short-lived route knowledge shared by the files of a batch.
#[derive(Default)]
pub(in crate::exchange) struct Memo {
    inner: Mutex<MemoInner>,
}

#[derive(Default)]
struct MemoInner {
    wins: HashMap<String, (LanAddress, Instant)>,
    down: HashMap<String, Instant>,
}

impl Memo {
    fn inner(&self) -> std::sync::MutexGuard<'_, MemoInner> {
        self.inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
    pub(in crate::exchange) fn winner(&self, key: &str) -> Option<LanAddress> {
        let mut inner = self.inner();
        match inner.wins.get(key) {
            Some((address, until)) if Instant::now() < *until => Some(address.clone()),
            Some(_) => {
                inner.wins.remove(key);
                None
            }
            None => None,
        }
    }
    fn win(&self, key: &str, address: &LanAddress) {
        let mut inner = self.inner();
        let now = Instant::now();
        inner.wins.retain(|_, (_, until)| now < *until);
        if inner.wins.len() >= MAX_MEMO {
            inner.wins.clear();
        }
        inner
            .wins
            .insert(key.into(), (address.clone(), now + ROUTE_MEMO));
        inner.down.remove(key);
    }
    fn forget_winner(&self, key: &str) {
        self.inner().wins.remove(key);
    }
    fn unreachable(&self, key: &str) {
        let mut inner = self.inner();
        let now = Instant::now();
        inner.wins.remove(key);
        inner.down.retain(|_, until| now < *until);
        if inner.down.len() >= MAX_MEMO {
            inner.down.clear();
        }
        inner.down.insert(key.into(), now + UNREACHABLE_MEMO);
    }
    pub(in crate::exchange) fn is_unreachable(&self, key: &str) -> bool {
        let mut inner = self.inner();
        match inner.down.get(key) {
            Some(until) if Instant::now() < *until => true,
            Some(_) => {
                inner.down.remove(key);
                false
            }
            None => false,
        }
    }
}

// --- wire -------------------------------------------------------------------------

fn io_fail(error: io::Error) -> Fail {
    if error
        .get_ref()
        .is_some_and(|inner| inner.is::<rustls::Error>())
    {
        Fail::Tls(error)
    } else {
        Fail::Io(error)
    }
}

fn head(method: &str, target: &str, host: &str, length: Option<u64>) -> Vec<u8> {
    let mut text = format!(
        "{method} {ROOT}/{target} HTTP/1.1\r\nHost: {host}\r\nAccept: application/json\r\n"
    );
    if let Some(length) = length {
        let kind = if method == "PUT" {
            "application/octet-stream"
        } else {
            "application/json"
        };
        text.push_str(&format!(
            "Content-Type: {kind}\r\nContent-Length: {length}\r\n"
        ));
    }
    text.push_str("Connection: close\r\n\r\n");
    text.into_bytes()
}

/// The receiver always answers with a JSON object and an explicit Content-Length.
fn read_reply(reader: &mut impl Read) -> io::Result<(u16, Value)> {
    let bad = || io::Error::new(io::ErrorKind::InvalidData, "invalid reply");
    let mut bytes = Vec::new();
    while !bytes.ends_with(b"\r\n\r\n") {
        if bytes.len() >= http::LIMIT {
            return Err(bad());
        }
        let mut byte = [0];
        reader.read_exact(&mut byte)?;
        bytes.push(byte[0]);
    }
    let mut headers = [httparse::EMPTY_HEADER; 64];
    let mut reply = httparse::Response::new(&mut headers);
    if !reply.parse(&bytes).map_err(|_| bad())?.is_complete() {
        return Err(bad());
    }
    let status = reply.code.ok_or_else(bad)?;
    let mut length = None;
    for header in reply.headers.iter() {
        if header.name.eq_ignore_ascii_case("transfer-encoding") {
            return Err(bad());
        }
        if header.name.eq_ignore_ascii_case("content-length") {
            let raw = std::str::from_utf8(header.value).map_err(|_| bad())?;
            if length.is_some() || raw.is_empty() || !raw.bytes().all(|b| b.is_ascii_digit()) {
                return Err(bad());
            }
            length = Some(raw.parse::<u64>().map_err(|_| bad())?);
        }
    }
    let length = length
        .filter(|n| *n <= http::LIMIT as u64)
        .ok_or_else(bad)?;
    let mut body = vec![0; length as usize];
    reader.read_exact(&mut body)?;
    if body.is_empty() {
        return Ok((status, json!({})));
    }
    let value: Value = serde_json::from_slice(&body).map_err(|_| bad())?;
    if !value.is_object() {
        return Err(bad());
    }
    Ok((status, value))
}

fn ok(status: u16, body: Value) -> Result<Value, Fail> {
    if status == 200 {
        return Ok(body);
    }
    Err(Fail::Refused {
        status,
        code: body["error"].as_str().unwrap_or("unknown").to_owned(),
    })
}

struct Conn {
    stream: rustls::StreamOwned<rustls::ClientConnection, TcpStream>,
    /// For timeouts and for closing a stuck transfer from the watchdog.
    raw: TcpStream,
}

impl Conn {
    fn timeouts(&self, limit: Duration) {
        let limit = Some(limit.max(Duration::from_millis(1)));
        let _ = self.raw.set_read_timeout(limit);
        let _ = self.raw.set_write_timeout(limit);
    }
}

/// TLS 1.3 only, our certificate as the client certificate, the target's certificate
/// pinned exactly.
pub(in crate::exchange) struct Tls {
    certificate: CertificateDer<'static>,
    key: PrivateKeyDer<'static>,
    configs: Mutex<HashMap<String, Arc<rustls::ClientConfig>>>,
    /// Where to connect; a seam so tests can reach a loopback receiver.
    target: Box<dyn Fn(&LanAddress, u16) -> SocketAddr + Send + Sync>,
}

impl Tls {
    pub(in crate::exchange) fn new(identity: &Identity) -> Self {
        Self {
            certificate: identity.certificate.clone(),
            key: identity.key.clone_key(),
            configs: Mutex::new(HashMap::new()),
            target: Box::new(|address, port| SocketAddr::new(IpAddr::V4(address.ip), port)),
        }
    }

    fn config(&self, pin: &str) -> Result<Arc<rustls::ClientConfig>, Fail> {
        let mut configs = self
            .configs
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(known) = configs.get(pin) {
            return Ok(known.clone());
        }
        let config = Arc::new(
            tls::client(&self.certificate, &self.key, pin.to_owned())
                .map_err(|error| Fail::Tls(io::Error::other(error)))?,
        );
        if configs.len() >= 16 {
            configs.clear();
        }
        configs.insert(pin.to_owned(), config.clone());
        Ok(config)
    }

    fn open(
        &self,
        pin: &str,
        address: &LanAddress,
        port: u16,
        connect: Duration,
        handshake: Duration,
    ) -> Result<Conn, Fail> {
        let config = self.config(pin)?;
        let mut tcp =
            TcpStream::connect_timeout(&(self.target)(address, port), connect).map_err(Fail::Io)?;
        let _ = tcp.set_nodelay(true);
        let mut conn =
            rustls::ClientConnection::new(config, ServerName::from(IpAddr::V4(address.ip)))
                .map_err(|error| Fail::Tls(io::Error::other(error)))?;
        let deadline = Instant::now() + handshake;
        while conn.is_handshaking() {
            let left = deadline
                .checked_duration_since(Instant::now())
                .filter(|left| !left.is_zero())
                .ok_or_else(|| {
                    Fail::Io(io::Error::new(
                        io::ErrorKind::TimedOut,
                        "TLS handshake timed out",
                    ))
                })?;
            let _ = tcp.set_read_timeout(Some(left));
            let _ = tcp.set_write_timeout(Some(left));
            conn.complete_io(&mut tcp).map_err(io_fail)?;
        }
        // The verifier already refused anything else; check the negotiated result once more.
        let seen = conn
            .peer_certificates()
            .and_then(|chain| chain.first())
            .map(tls::fingerprint);
        if seen.as_deref() != Some(pin) {
            return Err(Fail::Tls(io::Error::other(
                "LAN certificate does not match the pin",
            )));
        }
        if conn.protocol_version() != Some(rustls::ProtocolVersion::TLSv1_3) {
            return Err(Fail::Tls(io::Error::other("TLS 1.3 required")));
        }
        let raw = tcp.try_clone().map_err(Fail::Io)?;
        Ok(Conn {
            stream: rustls::StreamOwned::new(conn, tcp),
            raw,
        })
    }
}

/// Closes the socket when no byte moved for [`IDLE`] (blocking writes have no deadline of
/// their own) or when the user cancels.
struct Guard {
    started: Instant,
    last: AtomicU64,
    idle_check: AtomicBool,
    stopped: AtomicBool,
    finished: AtomicBool,
}

impl Guard {
    fn new() -> Self {
        Self {
            started: Instant::now(),
            last: AtomicU64::new(0),
            idle_check: AtomicBool::new(true),
            stopped: AtomicBool::new(false),
            finished: AtomicBool::new(false),
        }
    }
    fn touch(&self) {
        self.last
            .store(self.started.elapsed().as_millis() as u64, Ordering::Release);
    }
    fn watch(&self, raw: &TcpStream, cancel: &AtomicBool) {
        while !self.finished.load(Ordering::Acquire) {
            let quiet = (self.started.elapsed().as_millis() as u64)
                .saturating_sub(self.last.load(Ordering::Acquire));
            if cancel.load(Ordering::Acquire)
                || (self.idle_check.load(Ordering::Acquire) && quiet >= IDLE.as_millis() as u64)
            {
                self.stopped.store(true, Ordering::Release);
                let _ = raw.shutdown(Shutdown::Both);
                return;
            }
            std::thread::park_timeout(Duration::from_millis(250));
        }
    }
}

// --- sender -----------------------------------------------------------------------

pub(in crate::exchange) struct Sender {
    tls: Tls,
    memo: Memo,
}

impl Sender {
    pub(in crate::exchange) fn new(tls: Tls) -> Self {
        Self {
            tls,
            memo: Memo::default(),
        }
    }

    #[cfg(test)]
    fn memo(&self) -> &Memo {
        &self.memo
    }

    fn open(
        &self,
        peer: &LanPeer,
        address: &LanAddress,
        handshake: Duration,
    ) -> Result<Conn, Fail> {
        // The policy is enforced again right before connecting, whatever produced the address.
        if !addresses::allowed(&address.kind, address.ip) {
            return Err(Fail::Io(io::Error::other("not a LAN peer")));
        }
        self.tls.open(
            &peer.report.cert_sha256,
            address,
            peer.report.port,
            connect_timeout(address),
            handshake,
        )
    }

    /// One short request on its own connection; `budget` bounds the handshake and the answer.
    fn exchange(
        &self,
        peer: &LanPeer,
        address: &LanAddress,
        method: &str,
        route: &str,
        json: Option<&Value>,
        budget: Duration,
    ) -> Result<Value, Fail> {
        let started = Instant::now();
        let mut conn = self.open(peer, address, budget)?;
        let body = json.map(|value| serde_json::to_vec(value).unwrap_or_default());
        let host = format!("{}:{}", address.ip, peer.report.port);
        let mut request = head(method, route, &host, body.as_ref().map(|b| b.len() as u64));
        request.extend_from_slice(body.as_deref().unwrap_or_default());
        conn.stream.write_all(&request).map_err(io_fail)?;
        conn.stream.flush().map_err(io_fail)?;
        conn.timeouts(
            budget
                .saturating_sub(started.elapsed())
                .max(Duration::from_millis(500)),
        );
        let (status, value) = read_reply(&mut conn.stream).map_err(io_fail)?;
        ok(status, value)
    }

    /// `/info` unless this route just worked, then `/prepare-upload`.
    /// The inner `Err` is a reachable peer that cannot take the file right now.
    fn begin(
        &self,
        peer: &LanPeer,
        address: &LanAddress,
        job: &Job,
        probe: bool,
    ) -> Result<Result<Value, &'static str>, Fail> {
        if probe {
            let info = self.exchange(peer, address, "GET", "info", None, PROBE)?;
            if let Some(reason) = refusal(&info, peer, job.size) {
                return Ok(Err(reason));
            }
        }
        self.exchange(
            peer,
            address,
            "POST",
            "prepare-upload",
            Some(&job.prepare_body()),
            REQUEST,
        )
        .map(Ok)
    }

    /// Send one file. Network trouble never fails the call: the outcome says whether the
    /// direct send finished, was ended by the receiver or the user, or the server should take
    /// over with the same id. Only a problem with the local file is an `Err` (its code).
    pub(in crate::exchange) fn send(
        &self,
        peer: &LanPeer,
        job: &Job,
        source: Source,
        progress: &mut dyn FnMut(u64),
        cancel: &AtomicBool,
    ) -> Result<Outcome, &'static str> {
        let key = peer_key(peer);
        let fallback = |route, reason: &str, refresh| Outcome::Fallback {
            route,
            reason: reason.into(),
            refresh,
        };
        if self.memo.is_unreachable(&key) {
            return Ok(fallback(None, "unreachable", false));
        }
        let remembered = self.memo.winner(&key);
        let order = candidates(peer, remembered.as_ref());
        if order.is_empty() {
            return Ok(fallback(None, "noAddress", false));
        }
        let mut tls_failure = false;
        let mut chosen = None;
        for address in &order {
            if cancel.load(Ordering::Acquire) {
                return Ok(Outcome::Cancelled);
            }
            match self.begin(peer, address, job, remembered.as_ref() != Some(address)) {
                Ok(Ok(prepared)) => {
                    chosen = Some((address, prepared));
                    break;
                }
                Ok(Err(reason)) => return Ok(fallback(None, reason, false)),
                // Reachable but not taking it: the route itself is fine.
                Err(refused @ Fail::Refused { .. }) => {
                    self.memo.win(&key, address);
                    let step = decide(&refused, false, 0, 0);
                    return end(refused, step, None);
                }
                Err(unreachable) => {
                    tls_failure |= matches!(unreachable, Fail::Tls(_));
                    if remembered.as_ref() == Some(address) {
                        self.memo.forget_winner(&key);
                    }
                }
            }
        }
        let Some((address, mut prepared)) = chosen else {
            self.memo.unreachable(&key);
            return Ok(fallback(None, "unreachable", tls_failure));
        };
        self.memo.win(&key, address);
        let route = Some(route_of(address));
        let (mut resumes, mut digests) = (0u8, 0u8);
        loop {
            if prepared["state"] == "saved" {
                return Ok(Outcome::Saved {
                    route: route_of(address),
                });
            }
            let offset = match (prepared["state"].as_str(), prepared["offset"].as_u64()) {
                (Some("upload"), Some(offset)) if offset <= job.size => offset,
                _ => return Ok(fallback(route, "invalidReply", false)),
            };
            let failure = match self.upload(peer, address, job, offset, source, progress, cancel) {
                Ok(done) if done["state"] == "saved" => {
                    return Ok(Outcome::Saved {
                        route: route_of(address),
                    })
                }
                Ok(_) => Fail::Io(io::Error::other("unexpected upload reply")),
                Err(failure) => failure,
            };
            // The user's cancel always wins; nothing after it may reach the server.
            if cancel.load(Ordering::Acquire) {
                return Ok(Outcome::Cancelled);
            }
            let step = decide(&failure, true, resumes, digests);
            if step != Step::Resume {
                return end(failure, step, route);
            }
            match &failure {
                Fail::Refused { code, .. } if code == "digestMismatch" => digests += 1,
                _ => resumes += 1,
            }
            prepared = match self.exchange(
                peer,
                address,
                "POST",
                "prepare-upload",
                Some(&job.prepare_body()),
                REQUEST,
            ) {
                Ok(value) => value,
                Err(again) => {
                    if cancel.load(Ordering::Acquire) {
                        return Ok(Outcome::Cancelled);
                    }
                    let step = decide(&again, false, resumes, digests);
                    return end(again, step, route);
                }
            };
        }
    }

    /// Best effort: tell the receiver to drop its part. Failures change nothing.
    pub(in crate::exchange) fn cancel(&self, peer: &LanPeer, transfer_id: &str) {
        let key = peer_key(peer);
        if self.memo.is_unreachable(&key) {
            return;
        }
        let body = json!({ "transferId": transfer_id });
        for address in candidates(peer, self.memo.winner(&key).as_ref()) {
            match self.exchange(peer, &address, "POST", "cancel", Some(&body), PROBE) {
                Ok(_) | Err(Fail::Refused { .. }) => return,
                Err(_) => {}
            }
        }
    }

    /// PUT bytes [offset, size). A source that yields another count fails locally instead of
    /// sending different bytes.
    #[allow(clippy::too_many_arguments)]
    fn upload(
        &self,
        peer: &LanPeer,
        address: &LanAddress,
        job: &Job,
        offset: u64,
        source: Source,
        progress: &mut dyn FnMut(u64),
        cancel: &AtomicBool,
    ) -> Result<Value, Fail> {
        let mut conn = self.open(peer, address, PROBE)?;
        conn.timeouts(IDLE);
        let watcher = conn.raw.try_clone().map_err(Fail::Io)?;
        let guard = Guard::new();
        std::thread::scope(|scope| {
            let watch = scope.spawn(|| guard.watch(&watcher, cancel));
            let result = Self::transfer(
                &mut conn, peer, address, job, offset, source, progress, cancel, &guard,
            );
            guard.finished.store(true, Ordering::Release);
            watch.thread().unpark();
            result
        })
    }

    #[allow(clippy::too_many_arguments)]
    fn transfer(
        conn: &mut Conn,
        peer: &LanPeer,
        address: &LanAddress,
        job: &Job,
        offset: u64,
        source: Source,
        progress: &mut dyn FnMut(u64),
        cancel: &AtomicBool,
        guard: &Guard,
    ) -> Result<Value, Fail> {
        let length = job.size - offset;
        let sent = (|| -> Result<(), Fail> {
            let mut reader = source(offset).map_err(|_| Fail::Local("sourceUnavailable"))?;
            let target = format!("upload?transferId={}&offset={offset}", job.id);
            let host = format!("{}:{}", address.ip, peer.report.port);
            conn.stream
                .write_all(&head("PUT", &target, &host, Some(length)))
                .map_err(io_fail)?;
            let mut buffer = vec![0u8; 64 * 1024];
            let mut left = length;
            progress(offset);
            loop {
                if cancel.load(Ordering::Acquire) {
                    return Err(Fail::Cancelled);
                }
                let read = match reader.read(&mut buffer) {
                    Ok(read) => read,
                    Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                    Err(_) => return Err(Fail::Local("sourceUnavailable")),
                };
                if read == 0 {
                    break;
                }
                if read as u64 > left {
                    return Err(Fail::Local("sizeMismatch"));
                }
                conn.stream.write_all(&buffer[..read]).map_err(io_fail)?;
                left -= read as u64;
                guard.touch();
                progress(job.size - left);
            }
            if left != 0 {
                return Err(Fail::Local("sizeMismatch"));
            }
            conn.stream.flush().map_err(io_fail)
        })();
        match sent {
            Err(failure @ (Fail::Io(_) | Fail::Tls(_))) => {
                if cancel.load(Ordering::Acquire) {
                    return Err(Fail::Cancelled);
                }
                if guard.stopped.load(Ordering::Acquire) {
                    return Err(failure);
                }
                // A receiver that refused early (cancelled, offset, digest) may have answered
                // before it reset the connection.
                conn.timeouts(Duration::from_millis(1_500));
                if let Ok((status, body)) = read_reply(&mut conn.stream) {
                    return ok(status, body);
                }
                Err(failure)
            }
            Err(other) => Err(other),
            Ok(()) => {
                guard.idle_check.store(false, Ordering::Release);
                conn.timeouts(reply_timeout(job.size));
                match read_reply(&mut conn.stream) {
                    Ok((status, body)) => ok(status, body),
                    Err(_) if cancel.load(Ordering::Acquire) => Err(Fail::Cancelled),
                    Err(error) => Err(io_fail(error)),
                }
            }
        }
    }
}

fn end(failure: Fail, step: Step, route: Option<&'static str>) -> Result<Outcome, &'static str> {
    if let Fail::Local(code) = failure {
        return Err(code);
    }
    if step == Step::Stop {
        return Ok(if matches!(failure, Fail::Cancelled) {
            Outcome::Cancelled
        } else {
            Outcome::PeerCancelled { route }
        });
    }
    let refresh = matches!(failure, Fail::Tls(_) | Fail::Refused { status: 403, .. });
    Ok(Outcome::Fallback {
        route,
        reason: describe(&failure),
        refresh,
    })
}

#[cfg(test)]
mod tests {
    use super::super::{http::Reply, server::LanSink, server::Prepare, LanReport};
    use super::*;
    use sha2::{Digest, Sha256};
    use std::{net::TcpListener, sync::atomic::AtomicUsize};

    const SENDER_ID: &str = "11111111-1111-4111-8111-111111111111";
    const TARGET_ID: &str = "22222222-2222-4222-8222-222222222222";

    fn hex(data: &[u8]) -> String {
        Sha256::digest(data)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect()
    }

    /// The receiving device, without the app: keeps the part like the real sink does and
    /// answers every protocol case the sender has to handle.
    #[derive(Default)]
    struct Fake {
        sender: Option<LanPeer>,
        expected: Mutex<String>,
        part: Mutex<Vec<u8>>,
        saved: Mutex<Option<Vec<u8>>>,
        offsets: Mutex<Vec<u64>>,
        /// Held while an upload is being read, so a prepare waits for a dropped one to settle.
        busy: Mutex<()>,
        corrupt: AtomicUsize,
        decline: AtomicBool,
        not_receiving: AtomicBool,
    }

    impl LanSink for Fake {
        fn peer(&self, pin: &str) -> Option<LanPeer> {
            self.sender
                .clone()
                .filter(|peer| peer.report.cert_sha256 == pin)
        }
        fn info(&self) -> Value {
            json!({"protocol":1,"deviceId":TARGET_ID,"name":"Tablet","kind":"tablet",
                "receiving":!self.not_receiving.load(Ordering::Acquire),
                "maxFileBytes":crate::exchange::MAX_FILE_BYTES})
        }
        fn prepare(&self, _: &LanPeer, request: Prepare, _: &str) -> Reply {
            let _idle = self.busy.lock().unwrap();
            *self.expected.lock().unwrap() = request.sha256;
            if self.saved.lock().unwrap().is_some() {
                return Reply::ok(json!({"state":"saved"}));
            }
            Reply::ok(json!({"state":"upload","offset":self.part.lock().unwrap().len()}))
        }
        fn upload(
            &self,
            _: &LanPeer,
            _: &str,
            offset: u64,
            length: u64,
            body: &mut dyn Read,
        ) -> Reply {
            let _busy = self.busy.lock().unwrap();
            self.offsets.lock().unwrap().push(offset);
            if self.decline.load(Ordering::Acquire) {
                return Reply::error(410, "cancelled");
            }
            let mut part = self.part.lock().unwrap();
            if offset != part.len() as u64 {
                return Reply(409, json!({"error":"offsetMismatch","offset":part.len()}));
            }
            let mut left = length;
            let mut buffer = [0u8; 16 * 1024];
            while left > 0 {
                let count = left.min(buffer.len() as u64) as usize;
                match body.read(&mut buffer[..count]) {
                    Ok(0) | Err(_) => return Reply::error(503, "notReceiving"),
                    Ok(n) => {
                        part.extend_from_slice(&buffer[..n]);
                        left -= n as u64;
                    }
                }
            }
            let mut bytes = part.clone();
            if self
                .corrupt
                .fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| n.checked_sub(1))
                .is_ok()
            {
                bytes[0] ^= 1;
            }
            if hex(&bytes) != *self.expected.lock().unwrap() {
                part.clear();
                return Reply::error(422, "digestMismatch");
            }
            *self.saved.lock().unwrap() = Some(bytes);
            Reply::ok(json!({"state":"saved"}))
        }
        fn cancel(&self, _: &LanPeer, _: &str) -> Reply {
            Reply::ok(json!({"state":"cancelled"}))
        }
    }

    struct Rig {
        fake: Arc<Fake>,
        server: SocketAddr,
        client: Identity,
        peer: LanPeer,
    }

    fn lan_address(kind: &str, ip: &str) -> LanAddress {
        LanAddress {
            kind: kind.into(),
            ip: ip.parse().unwrap(),
        }
    }

    impl Rig {
        fn new() -> Self {
            let (server_id, client) = (tls::test_identity(), tls::test_identity());
            let fake = Arc::new(Fake {
                sender: Some(LanPeer {
                    device_id: SENDER_ID.into(),
                    name: "PC".into(),
                    report: LanReport {
                        cert_sha256: client.fingerprint.clone(),
                        port: 53318,
                        addresses: vec![],
                    },
                }),
                ..Fake::default()
            });
            let verifier = fake.clone();
            let config = Arc::new(
                tls::server(
                    &server_id,
                    tls::Pinned::new(move |pin| verifier.peer(pin).is_some()),
                )
                .unwrap(),
            );
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let server = listener.local_addr().unwrap();
            super::super::server::serve(listener, config, fake.clone()).unwrap();
            let peer = LanPeer {
                device_id: TARGET_ID.into(),
                name: "Tablet".into(),
                report: LanReport {
                    cert_sha256: server_id.fingerprint,
                    port: 53318,
                    addresses: vec![
                        lan_address("lan", "192.168.1.20"),
                        lan_address("tailscale", "100.64.0.7"),
                    ],
                },
            };
            Self {
                fake,
                server,
                client,
                peer,
            }
        }

        fn sender(
            &self,
            target: impl Fn(&LanAddress) -> SocketAddr + Send + Sync + 'static,
        ) -> Sender {
            let mut tls = Tls::new(&self.client);
            tls.target = Box::new(move |address, _| target(address));
            Sender::new(tls)
        }

        fn send(
            &self,
            sender: &Sender,
            data: &[u8],
            cancel: &AtomicBool,
        ) -> Result<Outcome, &'static str> {
            self.send_with(sender, data, cancel, &mut |_| {})
        }

        fn send_with(
            &self,
            sender: &Sender,
            data: &[u8],
            cancel: &AtomicBool,
            progress: &mut dyn FnMut(u64),
        ) -> Result<Outcome, &'static str> {
            let data = Arc::new(data.to_vec());
            let sha = hex(&data);
            let job = Job {
                id: "33333333-3333-4333-8333-333333333333",
                batch: "44444444-4444-4444-8444-444444444444",
                from: SENDER_ID,
                name: "photo.bin",
                size: data.len() as u64,
                sha256: &sha,
            };
            let source = move |offset: u64| -> io::Result<Box<dyn Read>> {
                Ok(Box::new(io::Cursor::new(data[offset as usize..].to_vec())))
            };
            sender.send(&self.peer, &job, &source, progress, cancel)
        }
    }

    fn data(len: usize) -> Vec<u8> {
        (0..len).map(|i| (i * 31 + i / 7) as u8).collect()
    }

    fn closed_port() -> SocketAddr {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.local_addr().unwrap()
    }

    /// Forwards to the receiver, and drops the first `cuts` connections that carry more than
    /// `threshold` bytes towards it: a network loss in the middle of an upload.
    fn flaky(server: SocketAddr, cuts: usize, threshold: usize) -> SocketAddr {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let cuts = Arc::new(AtomicUsize::new(cuts));
        std::thread::spawn(move || {
            for client in listener.incoming().flatten() {
                let cuts = cuts.clone();
                std::thread::spawn(move || {
                    let Ok(upstream) = TcpStream::connect(server) else {
                        return;
                    };
                    let (mut back_to, mut back_from) =
                        (client.try_clone().unwrap(), upstream.try_clone().unwrap());
                    std::thread::spawn(move || {
                        let _ = io::copy(&mut back_from, &mut back_to);
                    });
                    let (mut client, mut upstream) = (client, upstream);
                    let (mut seen, mut buffer) = (0, [0u8; 8192]);
                    loop {
                        match client.read(&mut buffer) {
                            Ok(0) | Err(_) => break,
                            Ok(n) => {
                                if upstream.write_all(&buffer[..n]).is_err() {
                                    break;
                                }
                                seen += n;
                                if seen > threshold
                                    && cuts
                                        .fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| {
                                            n.checked_sub(1)
                                        })
                                        .is_ok()
                                {
                                    let _ = client.shutdown(Shutdown::Both);
                                    let _ = upstream.shutdown(Shutdown::Both);
                                    return;
                                }
                            }
                        }
                    }
                    let _ = upstream.shutdown(Shutdown::Write);
                });
            }
        });
        address
    }

    #[test]
    fn lan_candidate_wins_and_the_file_arrives_intact() {
        let rig = Rig::new();
        let (server, dead) = (rig.server, closed_port());
        let sender = rig.sender(move |a| if a.kind == "lan" { server } else { dead });
        let bytes = data(300_000);
        let mut last = 0;
        let outcome = rig
            .send_with(&sender, &bytes, &AtomicBool::new(false), &mut |done| {
                last = done
            })
            .unwrap();
        assert_eq!(outcome, Outcome::Saved { route: "lan" });
        assert_eq!(rig.fake.saved.lock().unwrap().as_deref(), Some(&bytes[..]));
        assert_eq!(last, bytes.len() as u64);
        assert_eq!(
            sender.memo().winner(&peer_key(&rig.peer)),
            Some(lan_address("lan", "192.168.1.20"))
        );
    }

    #[test]
    fn a_refused_lan_address_moves_on_to_tailscale() {
        let rig = Rig::new();
        let (server, dead) = (rig.server, closed_port());
        let sender = rig.sender(move |a| if a.kind == "lan" { dead } else { server });
        let outcome = rig
            .send(&sender, &data(10_000), &AtomicBool::new(false))
            .unwrap();
        assert_eq!(outcome, Outcome::Saved { route: "tailscale" });
    }

    #[test]
    fn unreachable_peer_falls_back_fast_and_later_files_skip_the_attempt() {
        let rig = Rig::new();
        let dead = closed_port();
        let sender = rig.sender(move |_| dead);
        let started = Instant::now();
        let first = rig
            .send(&sender, &data(1_000), &AtomicBool::new(false))
            .unwrap();
        assert!(started.elapsed() < LAN_CONNECT + TAILSCALE_CONNECT);
        assert_eq!(
            first,
            Outcome::Fallback {
                route: None,
                reason: "unreachable".into(),
                refresh: false
            }
        );
        assert!(sender.memo().is_unreachable(&peer_key(&rig.peer)));
        let second_started = Instant::now();
        let second = rig
            .send(&sender, &data(1_000), &AtomicBool::new(false))
            .unwrap();
        assert_eq!(first, second);
        assert!(second_started.elapsed() < Duration::from_millis(100));
    }

    #[test]
    fn a_certificate_that_is_not_the_pinned_one_falls_back_and_asks_for_a_device_refresh() {
        let mut rig = Rig::new();
        rig.peer.report.cert_sha256 = "0".repeat(64);
        let server = rig.server;
        let sender = rig.sender(move |_| server);
        let outcome = rig
            .send(&sender, &data(1_000), &AtomicBool::new(false))
            .unwrap();
        assert_eq!(
            outcome,
            Outcome::Fallback {
                route: None,
                reason: "unreachable".into(),
                refresh: true
            }
        );
        assert!(rig.fake.offsets.lock().unwrap().is_empty());
    }

    #[test]
    fn a_receiver_that_is_not_receiving_sends_the_file_to_the_server() {
        let rig = Rig::new();
        rig.fake.not_receiving.store(true, Ordering::Release);
        let server = rig.server;
        let sender = rig.sender(move |_| server);
        let outcome = rig
            .send(&sender, &data(1_000), &AtomicBool::new(false))
            .unwrap();
        assert!(matches!(
            outcome,
            Outcome::Fallback { ref reason, refresh: false, .. } if reason == "notReceiving"
        ));
        assert!(!sender.memo().is_unreachable(&peer_key(&rig.peer)));
    }

    #[test]
    fn a_connection_lost_mid_upload_resumes_once_from_the_kept_part() {
        let rig = Rig::new();
        let proxy = flaky(rig.server, 1, 100_000);
        let sender = rig.sender(move |_| proxy);
        let bytes = data(600_000);
        let outcome = rig.send(&sender, &bytes, &AtomicBool::new(false)).unwrap();
        assert_eq!(outcome, Outcome::Saved { route: "lan" });
        assert_eq!(rig.fake.saved.lock().unwrap().as_deref(), Some(&bytes[..]));
        let offsets = rig.fake.offsets.lock().unwrap().clone();
        assert_eq!(offsets.len(), 2);
        assert!(
            offsets[1] > 0 && offsets[1] < bytes.len() as u64,
            "{offsets:?}"
        );
    }

    #[test]
    fn a_second_loss_hands_the_file_to_the_server() {
        let rig = Rig::new();
        let proxy = flaky(rig.server, 2, 100_000);
        let sender = rig.sender(move |_| proxy);
        let outcome = rig
            .send(&sender, &data(600_000), &AtomicBool::new(false))
            .unwrap();
        assert!(matches!(
            outcome,
            Outcome::Fallback {
                route: Some("lan"),
                refresh: false,
                ..
            }
        ));
        assert!(rig.fake.saved.lock().unwrap().is_none());
        assert_eq!(rig.fake.offsets.lock().unwrap().len(), 2);
    }

    #[test]
    fn a_corrupt_upload_is_retried_once_then_falls_back() {
        let rig = Rig::new();
        let server = rig.server;
        let sender = rig.sender(move |_| server);
        let bytes = data(50_000);
        rig.fake.corrupt.store(1, Ordering::Release);
        assert_eq!(
            rig.send(&sender, &bytes, &AtomicBool::new(false)).unwrap(),
            Outcome::Saved { route: "lan" }
        );
        assert_eq!(*rig.fake.offsets.lock().unwrap(), vec![0, 0]);

        let rig = Rig::new();
        let server = rig.server;
        let sender = rig.sender(move |_| server);
        rig.fake.corrupt.store(2, Ordering::Release);
        let outcome = rig.send(&sender, &bytes, &AtomicBool::new(false)).unwrap();
        assert!(matches!(
            outcome,
            Outcome::Fallback { ref reason, .. } if reason == "422 digestMismatch"
        ));
        assert!(rig.fake.saved.lock().unwrap().is_none());
    }

    #[test]
    fn a_receiver_that_cancelled_ends_the_send_without_the_server() {
        let rig = Rig::new();
        rig.fake.decline.store(true, Ordering::Release);
        let server = rig.server;
        let sender = rig.sender(move |_| server);
        let outcome = rig
            .send(&sender, &data(50_000), &AtomicBool::new(false))
            .unwrap();
        assert_eq!(outcome, Outcome::PeerCancelled { route: Some("lan") });
    }

    #[test]
    fn the_user_cancelling_stops_the_upload_without_the_server() {
        let rig = Rig::new();
        let server = rig.server;
        let sender = rig.sender(move |_| server);
        let cancel = AtomicBool::new(false);
        let outcome = rig
            .send_with(&sender, &data(8 * 1024 * 1024), &cancel, &mut |done| {
                if done > 0 {
                    cancel.store(true, Ordering::Release);
                }
            })
            .unwrap();
        assert_eq!(outcome, Outcome::Cancelled);
        assert!(rig.fake.saved.lock().unwrap().is_none());
    }

    #[test]
    fn an_unreadable_source_is_a_local_error_not_a_fallback() {
        let rig = Rig::new();
        let server = rig.server;
        let sender = rig.sender(move |_| server);
        let job = Job {
            id: "33333333-3333-4333-8333-333333333333",
            batch: "44444444-4444-4444-8444-444444444444",
            from: SENDER_ID,
            name: "gone.bin",
            size: 10,
            sha256: &"a".repeat(64),
        };
        let source = |_: u64| -> io::Result<Box<dyn Read>> { Err(io::ErrorKind::NotFound.into()) };
        let outcome = sender.send(
            &rig.peer,
            &job,
            &source,
            &mut |_| {},
            &AtomicBool::new(false),
        );
        assert_eq!(outcome, Err("sourceUnavailable"));
    }

    #[test]
    fn decision_table() {
        let refused = |status, code: &str| Fail::Refused {
            status,
            code: code.into(),
        };
        let lost = || Fail::Io(io::ErrorKind::ConnectionReset.into());
        // Local cancel and local file errors never go to the server.
        assert_eq!(decide(&Fail::Cancelled, true, 0, 0), Step::Stop);
        assert_eq!(decide(&Fail::Local("sizeMismatch"), true, 0, 0), Step::Stop);
        // The receiving side cancelled.
        assert_eq!(decide(&refused(410, "cancelled"), true, 0, 0), Step::Stop);
        // A loss mid-upload resumes once; before the upload it goes straight to the server.
        assert_eq!(decide(&lost(), true, 0, 0), Step::Resume);
        assert_eq!(decide(&lost(), true, 1, 0), Step::Fallback);
        assert_eq!(decide(&lost(), false, 0, 0), Step::Fallback);
        assert_eq!(
            decide(&Fail::Tls(io::Error::other("pin")), false, 0, 0),
            Step::Fallback
        );
        // Offset mismatch resumes once, digest mismatch retries once.
        assert_eq!(
            decide(&refused(409, "offsetMismatch"), true, 0, 0),
            Step::Resume
        );
        assert_eq!(
            decide(&refused(409, "offsetMismatch"), true, 1, 0),
            Step::Fallback
        );
        assert_eq!(
            decide(&refused(422, "digestMismatch"), true, 0, 0),
            Step::Resume
        );
        assert_eq!(
            decide(&refused(422, "digestMismatch"), true, 0, 1),
            Step::Fallback
        );
        // Everything else the receiver refuses is the server's job.
        for (status, code) in [
            (503, "notReceiving"),
            (409, "busy"),
            (500, "internal"),
            (403, "deviceMismatch"),
            (422, "invalidRequest"),
            (413, "fileTooLarge"),
            (404, "notFound"),
        ] {
            assert_eq!(
                decide(&refused(status, code), true, 0, 0),
                Step::Fallback,
                "{status} {code}"
            );
        }
    }

    #[test]
    fn candidates_are_ordered_lan_first_deduplicated_and_the_winner_leads() {
        let mut peer = Rig::new().peer;
        peer.report.addresses = vec![
            lan_address("tailscale", "100.64.0.7"),
            lan_address("lan", "192.168.1.20"),
            lan_address("lan", "192.168.1.20"),
            lan_address("lan", "8.8.8.8"),
            lan_address("tailscale", "192.168.1.9"),
        ];
        let tailscale = lan_address("tailscale", "100.64.0.7");
        assert_eq!(
            candidates(&peer, None),
            vec![lan_address("lan", "192.168.1.20"), tailscale.clone()]
        );
        assert_eq!(candidates(&peer, Some(&tailscale))[0], tailscale);
        peer.report.cert_sha256 = "not a pin".into();
        assert!(candidates(&peer, None).is_empty());
    }
}
