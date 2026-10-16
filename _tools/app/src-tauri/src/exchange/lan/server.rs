//! Blocking mutual-TLS receiver with bounded connection concurrency.
use super::{
    http::{self, Reply},
    identity::Identity,
    tls, LanPeer,
};
use serde::Deserialize;
use std::{
    io::{self, Read, Write},
    net::{IpAddr, Shutdown, TcpListener, TcpStream},
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Prepare {
    pub transfer_id: String,
    pub batch_id: String,
    pub from_device: String,
    pub file_name: String,
    pub size_bytes: u64,
    pub sha256: String,
    pub content_type_hint: Option<String>,
}
pub(super) trait LanSink: Send + Sync + 'static {
    fn peer(&self, pin: &str) -> Option<LanPeer>;
    fn info(&self) -> serde_json::Value;
    fn prepare(&self, peer: &LanPeer, request: Prepare, via: &str) -> Reply;
    fn upload(
        &self,
        peer: &LanPeer,
        id: &str,
        offset: u64,
        length: u64,
        body: &mut dyn Read,
    ) -> Reply;
    fn cancel(&self, peer: &LanPeer, id: &str) -> Reply;
}
pub(super) fn dispatch<S: LanSink>(
    sink: &S,
    peer: &LanPeer,
    via: &str,
    stream: &mut (impl Read + Write),
) -> io::Result<()> {
    let reply = (|| {
        let request = http::head(stream)?;
        let prefix = "/api/lakomics/lan/v1";
        match (request.method.as_str(), request.path.strip_prefix(prefix)) {
            ("GET", Some("/info")) => Ok(Reply::ok(sink.info())),
            ("POST", Some("/prepare-upload")) => {
                let req: Prepare = http::body(stream, request.length)?;
                if req.from_device != peer.device_id {
                    return Err(Reply::error(403, "deviceMismatch"));
                }
                if uuid::Uuid::parse_str(&req.transfer_id).is_err()
                    || uuid::Uuid::parse_str(&req.batch_id).is_err()
                    || req.file_name.trim().is_empty()
                    || req.file_name.len() > 1024
                    || !super::super::valid_sha256(&req.sha256)
                {
                    return Err(Reply::error(422, "invalidRequest"));
                }
                if req.size_bytes > super::super::MAX_FILE_BYTES {
                    return Err(Reply::error(413, "fileTooLarge"));
                }
                Ok(sink.prepare(peer, req, via))
            }
            ("POST", Some("/cancel")) => {
                #[derive(Deserialize)]
                #[serde(rename_all = "camelCase", deny_unknown_fields)]
                struct Cancel {
                    transfer_id: String,
                }
                let req: Cancel = http::body(stream, request.length)?;
                Ok(sink.cancel(peer, &req.transfer_id))
            }
            ("PUT", Some(path)) if path.starts_with("/upload?") => {
                let params: Vec<_> = url::form_urlencoded::parse(path[8..].as_bytes()).collect();
                if params.len() != 2 {
                    return Err(Reply::error(422, "invalidRequest"));
                }
                let id = params
                    .iter()
                    .find(|(k, _)| k == "transferId")
                    .map(|(_, v)| v.as_ref())
                    .ok_or_else(|| Reply::error(422, "invalidRequest"))?;
                let offset = params
                    .iter()
                    .find(|(k, _)| k == "offset")
                    .and_then(|(_, v)| v.parse::<u64>().ok())
                    .ok_or_else(|| Reply::error(422, "invalidRequest"))?;
                Ok(sink.upload(peer, id, offset, request.length.unwrap(), stream))
            }
            _ => Ok(Reply::error(404, "notFound")),
        }
    })()
    .unwrap_or_else(|reply| reply);
    http::respond(stream, reply)
}
/// Total time an unauthenticated peer may spend on the TLS handshake.
const HANDSHAKE: Duration = Duration::from_secs(10);
/// A peer that goes silent mid-request for this long is dropped.
const IDLE: Duration = Duration::from_secs(30);
/// After answering, unread request bytes are drained for at most this long so a close
/// does not reset the connection before the peer has read the (error) answer.
const LINGER: Duration = Duration::from_secs(2);
const MAX_CONNECTIONS: usize = 4;

fn connection<S: LanSink>(
    mut socket: TcpStream,
    config: Arc<rustls::ServerConfig>,
    sink: &S,
) -> io::Result<()> {
    socket.set_write_timeout(Some(IDLE))?;
    let via = match socket.peer_addr()?.ip() {
        IpAddr::V4(ip) if ip.octets()[0] == 100 && (64..=127).contains(&ip.octets()[1]) => {
            "tailscale"
        }
        _ => "lan",
    };
    let mut conn = rustls::ServerConnection::new(config).map_err(io::Error::other)?;
    let deadline = Instant::now() + HANDSHAKE;
    while conn.is_handshaking() {
        let left = deadline
            .checked_duration_since(Instant::now())
            .filter(|left| !left.is_zero())
            .ok_or_else(|| io::Error::new(io::ErrorKind::TimedOut, "TLS handshake timed out"))?;
        socket.set_read_timeout(Some(left))?;
        conn.complete_io(&mut socket)?;
    }
    socket.set_read_timeout(Some(IDLE))?;
    let cert = conn
        .peer_certificates()
        .and_then(|c| c.first())
        .ok_or_else(|| io::Error::other("client certificate required"))?;
    let peer = sink
        .peer(&tls::fingerprint(cert))
        .ok_or_else(|| io::Error::other("peer revoked"))?;
    let result = {
        let mut stream = rustls::Stream::new(&mut conn, &mut socket);
        dispatch(sink, &peer, via, &mut stream)
    };
    // Close politely: TLS close_notify, FIN, then swallow whatever the peer still sends.
    conn.send_close_notify();
    while conn.wants_write() {
        if conn.write_tls(&mut socket).is_err() {
            break;
        }
    }
    let _ = socket.shutdown(Shutdown::Write);
    let linger = Instant::now() + LINGER;
    let mut sink_buffer = [0u8; 16 * 1024];
    let mut drained = 0usize;
    while drained < 1024 * 1024 {
        let Some(left) = linger
            .checked_duration_since(Instant::now())
            .filter(|left| !left.is_zero())
        else {
            break;
        };
        if socket.set_read_timeout(Some(left)).is_err() {
            break;
        }
        match socket.read(&mut sink_buffer) {
            Ok(0) | Err(_) => break,
            Ok(n) => drained += n,
        }
    }
    result
}

/// Accept connections on `listener`: one thread per connection, at most
/// [`MAX_CONNECTIONS`] alive; further connections are closed at once.
fn serve<S: LanSink>(
    listener: TcpListener,
    config: Arc<rustls::ServerConfig>,
    sink: Arc<S>,
) -> io::Result<()> {
    std::thread::Builder::new()
        .name("exchange-lan".into())
        .spawn(move || {
            let active = Arc::new(AtomicUsize::new(0));
            for socket in listener.incoming() {
                let Ok(socket) = socket else {
                    continue;
                };
                if active
                    .fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| {
                        (n < MAX_CONNECTIONS).then_some(n + 1)
                    })
                    .is_err()
                {
                    continue;
                }
                struct Slot(Arc<AtomicUsize>);
                impl Drop for Slot {
                    fn drop(&mut self) {
                        self.0.fetch_sub(1, Ordering::AcqRel);
                    }
                }
                let slot = Slot(active.clone());
                let sink = sink.clone();
                let config = config.clone();
                let spawned = std::thread::Builder::new()
                    .name("exchange-lan-connection".into())
                    .spawn(move || {
                        let _slot = slot;
                        let _ = connection(socket, config, sink.as_ref());
                    });
                // On a failed spawn the closure (and with it the slot) is dropped.
                drop(spawned);
            }
        })?;
    Ok(())
}

pub(in crate::exchange) fn start<S: LanSink>(identity: &Identity, sink: Arc<S>) -> io::Result<()> {
    let verifier_sink = sink.clone();
    let config = Arc::new(
        tls::server(
            identity,
            tls::Pinned::new(move |pin| verifier_sink.peer(pin).is_some()),
        )
        .map_err(io::Error::other)?,
    );
    serve(TcpListener::bind(("0.0.0.0", super::PORT))?, config, sink)
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;
    use serde_json::{json, Value};
    pub(super) struct Wire {
        input: io::Cursor<Vec<u8>>,
        output: Vec<u8>,
    }
    impl Read for Wire {
        fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
            self.input.read(bytes)
        }
    }
    impl Write for Wire {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            self.output.extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    pub(in crate::exchange::lan) fn call(
        sink: &impl LanSink,
        peer: &LanPeer,
        request: Vec<u8>,
    ) -> (u16, Value) {
        let mut wire = Wire {
            input: io::Cursor::new(request),
            output: vec![],
        };
        dispatch(sink, peer, "lan", &mut wire).unwrap();
        let response = String::from_utf8(wire.output).unwrap();
        let (head, body) = response.split_once("\r\n\r\n").unwrap();
        (
            head.split_whitespace().nth(1).unwrap().parse().unwrap(),
            serde_json::from_str(body).unwrap(),
        )
    }
    pub(in crate::exchange::lan) fn peer() -> LanPeer {
        LanPeer {
            device_id: uuid::Uuid::new_v4().to_string(),
            name: "Tablet".into(),
            report: super::super::LanReport {
                cert_sha256: "a".repeat(64),
                port: super::super::PORT,
                addresses: vec![],
            },
        }
    }
    pub(in crate::exchange::lan) fn request(method: &str, route: &str, body: &[u8]) -> Vec<u8> {
        let mut bytes = format!(
            "{method} /api/lakomics/lan/v1{route} HTTP/1.1\r\nContent-Length: {}\r\n\r\n",
            body.len()
        )
        .into_bytes();
        bytes.extend_from_slice(body);
        bytes
    }
    struct FakeSink;
    impl LanSink for FakeSink {
        fn peer(&self, _: &str) -> Option<LanPeer> {
            Some(peer())
        }
        fn info(&self) -> Value {
            json!({"protocol":1})
        }
        fn prepare(&self, _: &LanPeer, _: Prepare, via: &str) -> Reply {
            assert_eq!(via, "lan");
            Reply::ok(json!({"state":"upload","offset":0}))
        }
        fn upload(&self, _: &LanPeer, _: &str, _: u64, _: u64, _: &mut dyn Read) -> Reply {
            Reply::ok(json!({"state":"saved"}))
        }
        fn cancel(&self, _: &LanPeer, _: &str) -> Reply {
            Reply::ok(json!({"state":"cancelled"}))
        }
    }
    /// One real TLS 1.3 request over loopback; returns the raw response text.
    fn tls_exchange(request: &[u8], chunks: usize) -> String {
        let server_id = tls::test_identity();
        let client_id = tls::test_identity();
        let (server_pin, client_pin) =
            (server_id.fingerprint.clone(), client_id.fingerprint.clone());
        let config = Arc::new(
            tls::server(&server_id, tls::Pinned::new(move |pin| pin == client_pin)).unwrap(),
        );
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        serve(listener, config, Arc::new(FakeSink)).unwrap();
        let client = rustls::ClientConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_protocol_versions(&[&rustls::version::TLS13])
        .unwrap()
        .dangerous()
        .with_custom_certificate_verifier(tls::Pinned::new(move |pin| pin == server_pin))
        .with_client_auth_cert(vec![client_id.certificate], client_id.key)
        .unwrap();
        let mut socket = TcpStream::connect(addr).unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut conn = rustls::ClientConnection::new(
            Arc::new(client),
            rustls::pki_types::ServerName::try_from("ignored.invalid").unwrap(),
        )
        .unwrap();
        let mut stream = rustls::Stream::new(&mut conn, &mut socket);
        for chunk in request.chunks(request.len().div_ceil(chunks)) {
            stream.write_all(chunk).unwrap();
        }
        let mut response = Vec::new();
        // A clean close_notify ends the read; a reset would surface as an error.
        stream.read_to_end(&mut response).unwrap();
        String::from_utf8(response).unwrap()
    }

    #[test]
    fn real_tls_connection_answers_and_closes_cleanly() {
        let ok = tls_exchange(&request("GET", "/info", b""), 3);
        assert!(ok.starts_with("HTTP/1.1 200"), "{ok}");
        assert!(ok.ends_with("{\"protocol\":1}"), "{ok}");
        // An answer sent before the whole body was read must still arrive intact.
        let unread = request("POST", "/unknown", &vec![b'x'; 12 * 1024]);
        assert!(tls_exchange(&unread, 1).starts_with("HTTP/1.1 404"));
        let oversized = tls_exchange(
            &format!(
                "GET / HTTP/1.1
X: {}

",
                "x".repeat(http::LIMIT)
            )
            .into_bytes(),
            1,
        );
        assert!(oversized.starts_with("HTTP/1.1 431"));
    }

    #[test]
    fn framing_and_validation_with_fake_sink() {
        let peer = peer();
        let sink = FakeSink;
        assert_eq!(
            call(&sink, &peer, request("GET", "/info", b"")),
            (200, json!({"protocol":1}))
        );
        let mut prepare = json!({"transferId":uuid::Uuid::new_v4().to_string(),"batchId":uuid::Uuid::new_v4().to_string(),"fromDevice":peer.device_id,"fileName":"a","sizeBytes":1,"sha256":"a".repeat(64)});
        assert_eq!(
            call(
                &sink,
                &peer,
                request("POST", "/prepare-upload", prepare.to_string().as_bytes())
            )
            .1,
            json!({"state":"upload","offset":0})
        );
        prepare["fromDevice"] = json!("other");
        assert_eq!(
            call(
                &sink,
                &peer,
                request("POST", "/prepare-upload", prepare.to_string().as_bytes())
            ),
            (403, json!({"error":"deviceMismatch"}))
        );
        prepare["fromDevice"] = json!(peer.device_id);
        prepare["sizeBytes"] = json!(super::super::super::MAX_FILE_BYTES + 1);
        assert_eq!(
            call(
                &sink,
                &peer,
                request("POST", "/prepare-upload", prepare.to_string().as_bytes())
            )
            .0,
            413
        );
        prepare["sizeBytes"] = json!(1);
        prepare["sha256"] = json!("bad");
        assert_eq!(
            call(
                &sink,
                &peer,
                request("POST", "/prepare-upload", prepare.to_string().as_bytes())
            )
            .0,
            422
        );
        for (raw, status) in [
            (format!("GET / HTTP/1.1\r\nX: {}\r\n\r\n","x".repeat(http::LIMIT)),431),
            ("POST /api/lakomics/lan/v1/prepare-upload HTTP/1.1\r\nContent-Length: 16385\r\n\r\n".into(),413),
            ("PUT /api/lakomics/lan/v1/upload?transferId=a&offset=0 HTTP/1.1\r\n\r\n".into(),411),
            ("PUT / HTTP/1.1\r\nTransfer-Encoding: chunked\r\nContent-Length: 1\r\n\r\n".into(),422),
            ("PUT / HTTP/1.1\r\nContent-Length: 1\r\nContent-Length: 1\r\n\r\n".into(),422),
            ("POST /api/lakomics/lan/v1/prepare-upload HTTP/1.1\r\nContent-Length: 2\r\n\r\n{".into(),422),
        ] { assert_eq!(call(&sink,&peer,raw.into_bytes()).0,status); }
        let body = vec![b' '; http::LIMIT + 1];
        assert_eq!(
            http::body::<Value>(&mut &body[..], Some(body.len() as u64))
                .unwrap_err()
                .0,
            413
        );
    }
}
