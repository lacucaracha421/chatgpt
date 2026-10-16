//! Route-selected IPv4 addresses; UDP connect chooses a route without sending data.
use super::LanAddress;
use std::net::{IpAddr, Ipv4Addr, UdpSocket};
pub(in crate::exchange) fn allowed(kind: &str, ip: Ipv4Addr) -> bool {
    let [a, b, _, _] = ip.octets();
    match kind {
        "lan" => a == 10 || (a == 172 && (16..=31).contains(&b)) || (a == 192 && b == 168),
        "tailscale" => a == 100 && (64..=127).contains(&b),
        _ => false,
    }
}
pub(in crate::exchange) fn discover() -> Vec<LanAddress> {
    [("lan", "8.8.8.8:53"), ("tailscale", "100.100.100.100:53")]
        .into_iter()
        .filter_map(|(kind, destination)| {
            let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
            socket.connect(destination).ok()?;
            let IpAddr::V4(ip) = socket.local_addr().ok()?.ip() else {
                return None;
            };
            allowed(kind, ip).then(|| LanAddress {
                kind: kind.into(),
                ip,
            })
        })
        .collect()
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn classifies_only_rfc1918_and_cgnat() {
        for (ip, lan, tailscale) in [
            ("10.0.0.1", true, false),
            ("172.16.0.1", true, false),
            ("172.31.255.255", true, false),
            ("192.168.1.1", true, false),
            ("172.15.255.255", false, false),
            ("172.32.0.0", false, false),
            ("100.64.0.0", false, true),
            ("100.127.255.255", false, true),
            ("100.63.255.255", false, false),
            ("100.128.0.0", false, false),
            ("8.8.8.8", false, false),
            ("127.0.0.1", false, false),
            ("169.254.1.1", false, false),
            ("0.0.0.0", false, false),
        ] {
            assert_eq!(allowed("lan", ip.parse().unwrap()), lan, "{ip}");
            assert_eq!(allowed("tailscale", ip.parse().unwrap()), tailscale, "{ip}");
        }
    }
}
