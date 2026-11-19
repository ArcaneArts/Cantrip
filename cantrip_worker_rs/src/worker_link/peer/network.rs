//! Apply the LAN policy to candidate advertisement, binding and packet I/O.
use anyhow::{Result, ensure};
use cantrip_wire::Value;
use rtc_shared::ifaces::ifaces;
use std::{
    collections::HashSet,
    fmt,
    future::Future,
    io::{self, IoSliceMut},
    net::{IpAddr, SocketAddr},
    pin::Pin,
    sync::Arc,
    task::{Context, Poll, ready},
    time::Duration,
};
use webrtc::runtime::{
    AsyncInterval, AsyncTcpListener, AsyncTcpStream, AsyncUdpSocket, JoinHandle, RecvMeta, Runtime,
    TokioRuntime, Transmit,
};

pub(super) fn interfaces(config: &Value) -> Result<Vec<SocketAddr>> {
    let policy = &config["interfacePolicy"];
    let vpn = &config["vpnPolicy"]["lanAllowlist"];
    let mut seen = HashSet::new();
    let mut bound = Vec::new();
    for interface in ifaces()? {
        let Some(mut address) = interface.addr else {
            continue;
        };
        let name = interface.name.to_lowercase();
        let listed = named(&policy["interfaces"], &name);
        let allowed = match policy["mode"].as_str() {
            Some("allowlist") => listed,
            Some("denylist") => !listed,
            _ => true,
        };
        let kind = classify(address.ip());
        let vpn_only = kind == Address::Cgnat || is_vpn(&name);
        if allowed
            && (!vpn_only || named(vpn, &name))
            && matches!(kind, Address::Private | Address::LinkLocal | Address::Cgnat)
        {
            address.set_port(0);
            if seen.insert(address) {
                bound.push(address);
            }
        }
    }
    ensure!(
        !bound.is_empty(),
        "WorkerLink LAN has no eligible interface."
    );
    Ok(bound)
}

fn named(array: &Value, name: &str) -> bool {
    array.as_array().is_some_and(|rules| {
        rules.iter().any(|rule| {
            rule.as_str()
                .is_some_and(|rule| rule.to_lowercase() == name)
        })
    })
}

fn is_vpn(name: &str) -> bool {
    [
        "utun",
        "tun",
        "tap",
        "tailscale",
        "zt",
        "zerotier",
        "wg",
        "wireguard",
        "ppp",
        "ipsec",
        "vpn",
    ]
    .iter()
    .any(|prefix| name.starts_with(prefix))
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Address {
    Private,
    LinkLocal,
    Cgnat,
    Other,
}

fn classify(ip: IpAddr) -> Address {
    match ip {
        IpAddr::V4(v4) => {
            let [first, second, ..] = v4.octets();
            if first == 100 && (64..=127).contains(&second) {
                Address::Cgnat
            } else if v4.is_private() {
                Address::Private
            } else if v4.is_link_local() {
                Address::LinkLocal
            } else {
                Address::Other
            }
        }
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                classify(v4.into())
            } else if v6.is_unique_local() {
                Address::Private
            } else if v6.is_unicast_link_local() {
                Address::LinkLocal
            } else {
                Address::Other
            }
        }
    }
}

fn allows_ip(ip: IpAddr) -> bool {
    matches!(classify(ip), Address::Private | Address::LinkLocal)
}

fn is_mdns(address: &str) -> bool {
    let address = address.trim_end_matches('.').to_ascii_lowercase();
    address.strip_suffix(".local").is_some_and(|name| {
        name.split('.').all(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        })
    })
}

pub(super) fn candidate_allowed(candidate: &str, local: bool) -> bool {
    let mut fields = candidate.trim_start_matches("a=").split_ascii_whitespace();
    let prefix = fields.next().unwrap_or_default();
    let component = fields.next();
    let transport = fields.next();
    let priority = fields.next().and_then(|value| value.parse::<u32>().ok());
    let address = fields.next().unwrap_or_default();
    let port = fields.next().and_then(|value| value.parse::<u16>().ok());
    let kind = fields.next();
    let candidate_type = fields.next();
    prefix.starts_with("candidate:")
        && component == Some("1")
        && transport.is_some_and(|value| value.eq_ignore_ascii_case("udp"))
        && priority.is_some()
        && port.is_some_and(|port| port > 0)
        && kind.is_some_and(|value| value.eq_ignore_ascii_case("typ"))
        && candidate_type.is_some_and(|value| {
            value.eq_ignore_ascii_case("host") || value.eq_ignore_ascii_case("prflx")
        })
        && (is_mdns(address)
            || address
                .split('%')
                .next()
                .and_then(|value| value.parse().ok())
                .is_some_and(|ip| allows_ip(ip) || (local && classify(ip) == Address::Cgnat)))
}

pub(super) fn has_forbidden_candidate(sdp: &str) -> bool {
    sdp.lines().any(|line| {
        (line.starts_with("a=candidate:") || line.starts_with("candidate:"))
            && !candidate_allowed(line, false)
    })
}

#[derive(Debug)]
pub(super) struct LanRuntime;

impl Runtime for LanRuntime {
    fn spawn(&self, future: Pin<Box<dyn Future<Output = ()> + Send>>) -> Box<dyn JoinHandle> {
        TokioRuntime.spawn(future)
    }

    fn wrap_udp_socket(&self, socket: std::net::UdpSocket) -> io::Result<Arc<dyn AsyncUdpSocket>> {
        Ok(Arc::new(LanSocket(TokioRuntime.wrap_udp_socket(socket)?)))
    }

    fn wrap_tcp_listener(&self, _: std::net::TcpListener) -> io::Result<Arc<dyn AsyncTcpListener>> {
        Err(io::ErrorKind::Unsupported.into())
    }

    fn connect_tcp<'a>(
        &'a self,
        _: SocketAddr,
    ) -> Pin<Box<dyn Future<Output = io::Result<Arc<dyn AsyncTcpStream>>> + Send + 'a>> {
        Box::pin(async { Err(io::ErrorKind::Unsupported.into()) })
    }

    fn resolve_host<'a>(
        &'a self,
        host: &'a str,
    ) -> Pin<Box<dyn Future<Output = io::Result<Vec<SocketAddr>>> + Send + 'a>> {
        TokioRuntime.resolve_host(host)
    }

    fn sleep(&self, duration: Duration) -> Pin<Box<dyn Future<Output = ()> + Send>> {
        TokioRuntime.sleep(duration)
    }

    fn interval(&self, period: Duration) -> Box<dyn AsyncInterval> {
        TokioRuntime.interval(period)
    }

    fn block_on(&self, future: Pin<Box<dyn Future<Output = ()> + '_>>) {
        TokioRuntime.block_on(future);
    }
}

struct LanSocket(Arc<dyn AsyncUdpSocket>);

impl fmt::Debug for LanSocket {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("LanSocket")
    }
}

impl AsyncUdpSocket for LanSocket {
    fn local_addr(&self) -> io::Result<SocketAddr> {
        self.0.local_addr()
    }

    fn poll_send(&self, cx: &mut Context<'_>, transmit: &Transmit<'_>) -> Poll<io::Result<usize>> {
        if !allows_ip(transmit.destination.ip()) {
            return Poll::Ready(Err(io::ErrorKind::PermissionDenied.into()));
        }
        self.0.poll_send(cx, transmit)
    }

    fn poll_recv(
        &self,
        cx: &mut Context<'_>,
        bufs: &mut [IoSliceMut<'_>],
        meta: &mut [RecvMeta],
    ) -> Poll<io::Result<usize>> {
        if bufs.is_empty() || meta.is_empty() {
            return Poll::Ready(Ok(0));
        }
        // Check the source before ICE can create a peer-reflexive candidate.
        // Limit each poll so unrelated incoming packets cannot monopolize it.
        for _ in 0..16 {
            let received = ready!(self.0.poll_recv(cx, &mut bufs[..1], &mut meta[..1]))?;
            if received == 0 || allows_ip(meta[0].addr.ip()) {
                return Poll::Ready(Ok(received));
            }
        }
        cx.waker().wake_by_ref();
        Poll::Pending
    }

    fn max_gso_segments(&self) -> usize {
        self.0.max_gso_segments()
    }

    fn max_gro_segments(&self) -> usize {
        self.0.max_gro_segments()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lan_admission_applies_to_sdp_and_peer_reflexive_packets() {
        for address in [
            "10.1.2.3",
            "192.168.2.3",
            "169.254.2.3",
            "fe80::3",
            "fd01::3",
        ] {
            assert!(allows_ip(address.parse().unwrap()));
            assert!(candidate_allowed(
                &format!("candidate:1 1 udp 123 {address} 1234 typ host"),
                false
            ));
        }
        assert!(candidate_allowed(
            "candidate:1 1 udp 1 browser.local 1234 typ host",
            false
        ));
        for address in ["127.0.0.1", "::1", "8.8.8.8", "100.64.2.3", "224.0.0.251"] {
            assert!(!allows_ip(address.parse().unwrap()));
            assert!(has_forbidden_candidate(&format!(
                "a=candidate:1 1 udp 123 {address} 1234 typ host\r\n"
            )));
        }
        assert!(!candidate_allowed(
            "candidate:1 1 udp 1 10.0.0.1 1234 typ relay",
            false
        ));
        assert!(!candidate_allowed(
            "candidate:1 1 tcp 1 10.0.0.1 1234 typ host",
            false
        ));
    }
}
