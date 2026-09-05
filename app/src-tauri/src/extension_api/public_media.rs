use std::{net::IpAddr, time::Duration};
use ureq::unversioned::{
    resolver::{DefaultResolver, ResolvedSocketAddrs, Resolver},
    transport::{DefaultConnector, NextTimeout},
};

// Validate the addresses actually handed to the connector, rather than doing a
// separate DNS check followed by a second lookup at download time.
#[derive(Debug)]
struct PublicMediaResolver;

impl Resolver for PublicMediaResolver {
    fn resolve(
        &self,
        uri: &ureq::http::Uri,
        config: &ureq::config::Config,
        timeout: NextTimeout,
    ) -> Result<ResolvedSocketAddrs, ureq::Error> {
        let addresses = DefaultResolver::default().resolve(uri, config, timeout)?;
        if addresses.iter().any(|address| !public_ip(address.ip())) {
            return Err(ureq::Error::HostNotFound);
        }
        Ok(addresses)
    }
}

pub(super) fn agent() -> ureq::Agent {
    let config = ureq::Agent::config_builder()
        .https_only(true)
        .max_redirects(0)
        // A proxy can resolve the destination itself and bypass our resolver.
        .proxy(None)
        .timeout_global(Some(Duration::from_secs(300)))
        .build();
    ureq::Agent::with_parts(config, DefaultConnector::default(), PublicMediaResolver)
}

pub(super) fn valid_url(value: &str) -> Result<url::Url, ()> {
    let url = url::Url::parse(value).map_err(|_| ())?;
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() || url.port().is_some() {
        return Err(());
    }
    match url.host().ok_or(())? {
        url::Host::Ipv4(ip) if !public_ip(ip.into()) => return Err(()),
        url::Host::Ipv6(ip) if !public_ip(ip.into()) => return Err(()),
        url::Host::Domain(host) if !host.contains('.') || host.ends_with(".localhost") || host.ends_with(".local") => return Err(()),
        _ => {}
    }
    Ok(url)
}

fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let [a, b, c, _] = ip.octets();
            !(a == 0 || a == 10 || a == 127 || a >= 224
                || (a == 100 && (64..=127).contains(&b))
                || (a == 169 && b == 254) || (a == 172 && (16..=31).contains(&b))
                || (a == 192 && ((b == 168) || (b == 0 && (c == 0 || c == 2)) || (b == 88 && c == 99)))
                || (a == 198 && (b == 18 || b == 19 || (b == 51 && c == 100)))
                || (a == 203 && b == 0 && c == 113))
        }
        IpAddr::V6(ip) => {
            // Only ordinary global unicast. Exclude transition/special-use and
            // documentation ranges; mapped IPv4 and local addresses fail here.
            let segments = ip.segments();
            (segments[0] & 0xe000) == 0x2000
                && !(segments[0] == 0x2001 && (segments[1] <= 0x1ff || segments[1] == 0xdb8))
                && segments[0] != 0x2002
                && !(segments[0] == 0x3fff && segments[1] <= 0x0fff)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_public_destinations_are_allowed() {
        for address in ["127.0.0.1", "10.0.0.1", "169.254.169.254", "192.168.1.1", "172.16.0.1",
            "100.76.119.29", "0.0.0.0", "198.18.0.1", "224.0.0.1", "::1", "::ffff:127.0.0.1",
            "fc00::1", "fe80::1", "2001:db8::1", "2002:7f00:1::", "3fff::1"] {
            assert!(!public_ip(address.parse().unwrap()), "{address}");
        }
        for address in ["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111", "2001:4860:4860::8888"] {
            assert!(public_ip(address.parse().unwrap()), "{address}");
        }
    }

    #[test]
    fn generic_urls_reject_credentials_local_destinations_and_other_schemes() {
        for value in ["https://127.0.0.1/a.jpg", "https://[::1]/a.jpg", "https://localhost/a.jpg",
            "https://server.local/a.jpg", "https://example.com:8443/a.jpg", "https://user:secret@example.com/a.jpg",
            "http://example.com/a.jpg", "file:///a.jpg"] {
            assert!(valid_url(value).is_err(), "{value}");
        }
        assert!(valid_url("https://cdn.example.com/image?id=123").is_ok());
    }

    #[test]
    fn resolver_blocks_private_address_before_opening_a_connection() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = format!("https://127.0.0.1:{}/image.jpg", listener.local_addr().unwrap().port());
        assert!(matches!(agent().get(&url).call(), Err(ureq::Error::HostNotFound)));
        assert_eq!(listener.accept().unwrap_err().kind(), std::io::ErrorKind::WouldBlock);
    }
}
