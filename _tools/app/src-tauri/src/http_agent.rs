//! Shared ureq agents for the Cloud API, presigned storage and the catalog VPS.
//!
//! These hosts resolve to several addresses, and from some networks one of them never
//! answers (a Cloudflare R2 address was seen to drop every SYN from a home network while
//! its sibling connected in 0.1 s). ureq tries the addresses in DNS order and splits the
//! connect budget geometrically, so with a 30 s budget the dead address alone costs 20 s
//! on every fresh connection, and it is tried again on the next one.
//!
//! This connector replaces ureq's TCP step: every address except the last gets a short
//! fixed wait, and a process-wide memory of addresses that recently failed to connect
//! puts them last until the memory expires. The last address keeps the whole remaining
//! connect budget, so a host with a single address behaves exactly as before. Proxy,
//! TLS and every request/body timeout stay ureq's own.

use std::collections::HashMap;
use std::io;
use std::net::SocketAddr;
use std::sync::{Arc, LazyLock, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use ureq::unversioned::resolver::DefaultResolver;
use ureq::unversioned::transport::time::{Duration as UreqDuration, Instant as UreqInstant};
use ureq::unversioned::transport::{
    ConnectProxyConnector, ConnectionDetails, Connector, Either, NextTimeout, RustlsConnector,
    TcpConnector, Transport,
};

/// The wait for one address when another address is still left to try. A live address
/// on a normal network connects well within this, including one lost SYN.
const ATTEMPT_CAP: Duration = Duration::from_secs(3);
/// How long an address that failed to connect stays at the back of the order.
const FAILURE_TTL: Duration = Duration::from_secs(30 * 60);
/// Bound on remembered addresses; the oldest failure is dropped first.
const MAX_REMEMBERED: usize = 64;

static FAILED: LazyLock<Arc<Mutex<FailedAddresses>>> = LazyLock::new(Default::default);

/// An agent with `config` whose connections avoid recently unreachable addresses.
pub(crate) fn agent(config: ureq::config::Config) -> ureq::Agent {
    ureq::Agent::with_parts(config, connector(), DefaultResolver::default())
}

/// The connector chain `agent` uses, for callers that add their own transport layer.
pub(crate) fn connector() -> impl Connector<(), Out = Box<dyn Transport>> {
    chain(FailoverTcpConnector {
        failed: FAILED.clone(),
        attempt_cap: ATTEMPT_CAP,
    })
}

/// ureq's default chain (CONNECT proxy, TCP, rustls) with the TCP step replaced.
fn chain(tcp: FailoverTcpConnector) -> impl Connector<(), Out = Box<dyn Transport>> {
    ().chain(ConnectProxyConnector::default())
        .chain(tcp)
        .chain(RustlsConnector::default())
        .chain(Boxing)
}

#[derive(Debug, Default)]
struct FailedAddresses {
    failed_at: HashMap<SocketAddr, Instant>,
}

impl FailedAddresses {
    /// The try order: addresses without a recent failure in DNS order, then recently
    /// failed ones, the longest-ago failure first.
    fn order(&mut self, addrs: &[SocketAddr], now: Instant) -> Vec<SocketAddr> {
        self.forget_expired(now);
        let mut ordered = addrs.to_vec();
        ordered.sort_by_key(|addr| self.failed_at.get(addr).copied());
        ordered
    }

    fn record_failure(&mut self, addr: SocketAddr, now: Instant) {
        self.forget_expired(now);
        if self.failed_at.len() >= MAX_REMEMBERED && !self.failed_at.contains_key(&addr) {
            let oldest = self
                .failed_at
                .iter()
                .min_by_key(|(_, at)| **at)
                .map(|(addr, _)| *addr);
            if let Some(oldest) = oldest {
                self.failed_at.remove(&oldest);
            }
        }
        self.failed_at.insert(addr, now);
    }

    fn record_success(&mut self, addr: SocketAddr) {
        self.failed_at.remove(&addr);
    }

    fn forget_expired(&mut self, now: Instant) {
        self.failed_at
            .retain(|_, at| now.saturating_duration_since(*at) < FAILURE_TTL);
    }
}

/// The wait for one address: `None` means no limit. The last address gets whatever is
/// left of the connect budget; an earlier one at most `cap`.
fn attempt_budget(remaining: Option<Duration>, is_last: bool, cap: Duration) -> Option<Duration> {
    if is_last {
        remaining
    } else {
        Some(remaining.map_or(cap, |left| left.min(cap)))
    }
}

/// A connect failure that concerns only the address tried: a timeout, or the address
/// refusing or being unroutable (the same set ureq itself moves on from).
fn is_address_failure(error: &ureq::Error) -> bool {
    match error {
        ureq::Error::Timeout(_) => true,
        ureq::Error::Io(error) => {
            // A VPN or firewall on Windows can report a blocked address as WSAEACCES.
            #[cfg(windows)]
            if error.raw_os_error() == Some(10013) {
                return true;
            }
            matches!(
                error.kind(),
                io::ErrorKind::ConnectionRefused
                    | io::ErrorKind::HostUnreachable
                    | io::ErrorKind::NetworkUnreachable
                    | io::ErrorKind::AddrNotAvailable
            )
        }
        _ => false,
    }
}

#[derive(Debug)]
struct FailoverTcpConnector {
    failed: Arc<Mutex<FailedAddresses>>,
    attempt_cap: Duration,
}

impl FailoverTcpConnector {
    fn memory(&self) -> MutexGuard<'_, FailedAddresses> {
        self.failed
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Tries `addrs` one at a time in memory order until one connects. `remaining` is
    /// what is left of the connect budget (`None`: unlimited) and `reason` the timeout
    /// reported when it runs out.
    fn connect_in_order<T>(
        &self,
        addrs: &[SocketAddr],
        remaining: impl Fn() -> Option<Duration>,
        reason: ureq::Timeout,
        mut attempt: impl FnMut(SocketAddr, Option<Duration>) -> Result<T, ureq::Error>,
    ) -> Result<T, ureq::Error> {
        let order = self.memory().order(addrs, Instant::now());
        let mut last_error = None;
        for (index, addr) in order.iter().enumerate() {
            let left = remaining();
            if left == Some(Duration::ZERO) {
                return Err(ureq::Error::Timeout(reason));
            }
            let budget = attempt_budget(left, index + 1 == order.len(), self.attempt_cap);
            match attempt(*addr, budget) {
                Ok(connected) => {
                    self.memory().record_success(*addr);
                    return Ok(connected);
                }
                Err(error) if is_address_failure(&error) => {
                    self.memory().record_failure(*addr, Instant::now());
                    last_error = Some(error);
                }
                Err(error) => return Err(error),
            }
        }
        if remaining() == Some(Duration::ZERO) {
            return Err(ureq::Error::Timeout(reason));
        }
        Err(last_error.unwrap_or_else(|| {
            ureq::Error::Io(io::Error::new(
                io::ErrorKind::ConnectionRefused,
                "Connection refused",
            ))
        }))
    }
}

impl<In: Transport> Connector<In> for FailoverTcpConnector {
    type Out = Either<In, Box<dyn Transport>>;

    fn connect(
        &self,
        details: &ConnectionDetails,
        chained: Option<In>,
    ) -> Result<Option<Self::Out>, ureq::Error> {
        if chained.is_some() {
            // A proxy tunnel already stands in for the direct connection.
            return Ok(chained.map(Either::A));
        }
        let deadline = details.now + details.timeout.after;
        let remaining = || match (deadline, (details.current_time)()) {
            (UreqInstant::NotHappening, _) => None,
            (UreqInstant::Exact(deadline), UreqInstant::Exact(now)) => {
                Some(deadline.saturating_duration_since(now))
            }
            _ => Some(Duration::ZERO),
        };
        let reason = details.timeout.reason;
        let transport =
            self.connect_in_order(&details.addrs, remaining, reason, |addr, budget| {
                let mut single = details.resolver.empty();
                single.push(addr);
                let attempt = ConnectionDetails {
                    uri: details.uri,
                    addrs: single,
                    config: details.config,
                    request_level: details.request_level,
                    resolver: details.resolver,
                    now: (details.current_time)(),
                    timeout: NextTimeout {
                        after: budget.map_or(UreqDuration::NotHappening, UreqDuration::from),
                        reason,
                    },
                    current_time: details.current_time.clone(),
                    run_connector: details.run_connector.clone(),
                };
                Connector::<()>::connect(&TcpConnector::default(), &attempt, None)?
                    .map(|transport| Box::new(transport) as Box<dyn Transport>)
                    .ok_or_else(|| ureq::Error::Io(io::Error::other("no TCP transport")))
            })?;
        Ok(Some(Either::B(transport)))
    }
}

/// Ends the chain with one boxed transport type.
#[derive(Debug)]
struct Boxing;

impl<In: Transport> Connector<In> for Boxing {
    type Out = Box<dyn Transport>;

    fn connect(
        &self,
        _details: &ConnectionDetails,
        chained: Option<In>,
    ) -> Result<Option<Self::Out>, ureq::Error> {
        Ok(chained.map(|transport| Box::new(transport) as Box<dyn Transport>))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn addr(last: u8) -> SocketAddr {
        SocketAddr::from(([192, 0, 2, last], 443))
    }

    #[test]
    fn order_keeps_dns_order_until_an_address_fails() {
        let mut memory = FailedAddresses::default();
        let now = Instant::now();
        assert_eq!(
            memory.order(&[addr(1), addr(2), addr(3)], now),
            [addr(1), addr(2), addr(3)]
        );

        memory.record_failure(addr(1), now);
        assert_eq!(
            memory.order(&[addr(1), addr(2), addr(3)], now),
            [addr(2), addr(3), addr(1)]
        );

        // Among failed addresses the longest-ago failure is tried first.
        memory.record_failure(addr(2), now + Duration::from_secs(1));
        assert_eq!(
            memory.order(&[addr(2), addr(1), addr(3)], now + Duration::from_secs(1)),
            [addr(3), addr(1), addr(2)]
        );
    }

    #[test]
    fn failure_memory_expires_and_success_clears_it() {
        let mut memory = FailedAddresses::default();
        let now = Instant::now();
        memory.record_failure(addr(1), now);
        assert_eq!(
            memory.order(
                &[addr(1), addr(2)],
                now + FAILURE_TTL - Duration::from_secs(1)
            ),
            [addr(2), addr(1)]
        );
        assert_eq!(
            memory.order(&[addr(1), addr(2)], now + FAILURE_TTL),
            [addr(1), addr(2)]
        );
        assert!(memory.failed_at.is_empty());

        memory.record_failure(addr(1), now);
        memory.record_success(addr(1));
        assert_eq!(memory.order(&[addr(1), addr(2)], now), [addr(1), addr(2)]);
    }

    #[test]
    fn failure_memory_is_bounded() {
        let mut memory = FailedAddresses::default();
        let now = Instant::now();
        for index in 0..(MAX_REMEMBERED + 10) {
            let at = now + Duration::from_millis(index as u64);
            memory.record_failure(SocketAddr::from(([10, 0, 0, 1], index as u16)), at);
        }
        assert_eq!(memory.failed_at.len(), MAX_REMEMBERED);
        // The oldest failures were the ones dropped.
        assert!(!memory
            .failed_at
            .contains_key(&SocketAddr::from(([10, 0, 0, 1], 0))));
        assert!(memory.failed_at.contains_key(&SocketAddr::from((
            [10, 0, 0, 1],
            (MAX_REMEMBERED + 9) as u16
        ))));
    }

    #[test]
    fn only_the_last_address_gets_the_whole_budget() {
        let cap = Duration::from_secs(3);
        let left = Duration::from_secs(30);
        assert_eq!(attempt_budget(Some(left), false, cap), Some(cap));
        assert_eq!(attempt_budget(Some(left), true, cap), Some(left));
        assert_eq!(
            attempt_budget(Some(Duration::from_secs(1)), false, cap),
            Some(Duration::from_secs(1))
        );
        assert_eq!(attempt_budget(None, false, cap), Some(cap));
        assert_eq!(attempt_budget(None, true, cap), None);
    }

    #[test]
    fn a_silent_first_address_costs_one_short_wait_and_is_skipped_next_time() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let live = listener.local_addr().unwrap();
        let silent = addr(1);
        let cap = Duration::from_millis(150);
        let connector = FailoverTcpConnector {
            failed: Default::default(),
            attempt_cap: cap,
        };
        let silent_attempts = AtomicUsize::new(0);
        // The silent address never answers: it uses up its whole wait, like a dropped SYN.
        let attempt = |target: SocketAddr, budget: Option<Duration>| {
            if target == silent {
                silent_attempts.fetch_add(1, Ordering::SeqCst);
                assert_eq!(budget, Some(cap));
                std::thread::sleep(budget.unwrap());
                return Err(ureq::Error::Timeout(ureq::Timeout::Connect));
            }
            TcpStream::connect_timeout(&target, budget.unwrap()).map_err(ureq::Error::from)
        };
        let budget = || Some(Duration::from_secs(30));

        let started = Instant::now();
        let stream = connector
            .connect_in_order(&[silent, live], budget, ureq::Timeout::Global, attempt)
            .unwrap();
        assert_eq!(stream.peer_addr().unwrap(), live);
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "{:?}",
            started.elapsed()
        );
        assert_eq!(silent_attempts.load(Ordering::SeqCst), 1);

        let started = Instant::now();
        let stream = connector
            .connect_in_order(&[silent, live], budget, ureq::Timeout::Global, attempt)
            .unwrap();
        assert_eq!(stream.peer_addr().unwrap(), live);
        assert!(started.elapsed() < cap, "{:?}", started.elapsed());
        assert_eq!(silent_attempts.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn an_exhausted_budget_reports_the_request_timeout() {
        let connector = FailoverTcpConnector {
            failed: Default::default(),
            attempt_cap: ATTEMPT_CAP,
        };
        let error = connector
            .connect_in_order(
                &[addr(1), addr(2)],
                || Some(Duration::ZERO),
                ureq::Timeout::Global,
                |_, _| -> Result<(), ureq::Error> { panic!("no attempt without budget") },
            )
            .unwrap_err();
        assert!(matches!(error, ureq::Error::Timeout(ureq::Timeout::Global)));
    }

    #[derive(Debug)]
    struct FixedResolver(Vec<SocketAddr>);

    impl ureq::unversioned::resolver::Resolver for FixedResolver {
        fn resolve(
            &self,
            _uri: &ureq::http::Uri,
            _config: &ureq::config::Config,
            _timeout: NextTimeout,
        ) -> Result<ureq::unversioned::resolver::ResolvedSocketAddrs, ureq::Error> {
            let mut addrs = self.empty();
            for addr in &self.0 {
                addrs.push(*addr);
            }
            Ok(addrs)
        }
    }

    #[test]
    fn an_agent_reaches_the_second_address_and_prefers_it_afterwards() {
        let dead = {
            let closed = TcpListener::bind("127.0.0.1:0").unwrap();
            closed.local_addr().unwrap()
        };
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let live = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            for _ in 0..2 {
                let (mut stream, _) = listener.accept().unwrap();
                let mut request = Vec::new();
                let mut buffer = [0; 1024];
                while !request.ends_with(b"\r\n\r\n") {
                    let read = stream.read(&mut buffer).unwrap();
                    assert!(read > 0);
                    request.extend_from_slice(&buffer[..read]);
                }
                stream
                    .write_all(
                        b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok",
                    )
                    .unwrap();
            }
        });

        let failed: Arc<Mutex<FailedAddresses>> = Default::default();
        let config = ureq::Agent::config_builder()
            .proxy(None)
            .timeout_global(Some(Duration::from_secs(30)))
            .build();
        let agent = ureq::Agent::with_parts(
            config,
            chain(FailoverTcpConnector {
                failed: failed.clone(),
                attempt_cap: Duration::from_millis(150),
            }),
            FixedResolver(vec![dead, live]),
        );

        let started = Instant::now();
        let body = agent
            .get("http://lakomics.test/")
            .call()
            .unwrap()
            .body_mut()
            .read_to_string()
            .unwrap();
        assert_eq!(body, "ok");
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "{:?}",
            started.elapsed()
        );
        let first_failure = failed.lock().unwrap().failed_at.get(&dead).copied();
        assert!(first_failure.is_some());
        assert_eq!(
            failed.lock().unwrap().order(&[dead, live], Instant::now()),
            [live, dead]
        );

        let body = agent
            .get("http://lakomics.test/")
            .call()
            .unwrap()
            .body_mut()
            .read_to_string()
            .unwrap();
        assert_eq!(body, "ok");
        // The dead address was not tried again: its failure time is unchanged.
        assert_eq!(
            failed.lock().unwrap().failed_at.get(&dead).copied(),
            first_failure
        );
        server.join().unwrap();
    }
}
