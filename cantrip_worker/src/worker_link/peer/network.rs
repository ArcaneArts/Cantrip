//! WorkerLink route policy for ICE candidates, interface binding and packet I/O.
use anyhow::{Result, ensure};
use cantrip_wire::Value;
use rtc::{
    ice::url::{SchemeType, Url},
    mdns::MDNS_PORT,
    peer_connection::{
        configuration::{RTCConfiguration, RTCConfigurationBuilder, RTCIceServer},
        transport::{RTCIceCandidate, RTCIceCandidateType, RTCIceProtocol},
    },
    stun::{
        attributes::ATTR_USERNAME,
        message::{BINDING_ERROR, BINDING_REQUEST, BINDING_SUCCESS, Message, is_stun_message},
    },
};
use rtc_shared::ifaces::ifaces;
use std::{
    collections::{HashMap, HashSet},
    future::Future,
    io::{self, IoSliceMut},
    net::{IpAddr, Ipv4Addr, SocketAddr},
    pin::Pin,
    sync::{Arc, RwLock},
    task::{Context, Poll, ready},
    time::Duration,
};
use webrtc::runtime::{
    AsyncInterval, AsyncTcpListener, AsyncTcpStream, AsyncUdpSocket, JoinHandle, RecvMeta, Runtime,
    TokioRuntime, Transmit,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PeerRoute {
    Lan,
    Wan,
}

impl PeerRoute {
    pub fn name(self) -> &'static str {
        match self {
            Self::Lan => "lan",
            Self::Wan => "wan",
        }
    }

    pub(crate) fn configuration(self, policy: &Value) -> RTCConfiguration {
        let mut configuration = RTCConfigurationBuilder::new();
        if self == Self::Wan
            && let Some(url) = policy["stunUrls"]
                .as_array()
                .and_then(|urls| urls.iter().filter_map(Value::as_str).find_map(stun_url))
        {
            configuration = configuration.with_ice_servers(vec![RTCIceServer {
                urls: vec![url],
                ..Default::default()
            }]);
        }
        configuration.build()
    }

    pub(crate) fn remote_candidate_allowed(self, candidate: &str, trickled: bool) -> bool {
        let mut fields = candidate
            .trim()
            .trim_start_matches("a=")
            .split_ascii_whitespace();
        let prefix = fields.next().unwrap_or_default();
        let component = fields.next();
        let transport = fields.next();
        let priority = fields.next().and_then(|value| value.parse::<u32>().ok());
        let address = classify_address(fields.next().unwrap_or_default());
        let port = fields.next().and_then(|value| value.parse::<u16>().ok());
        let kind = fields.next();
        let candidate_type = fields.next().unwrap_or_default().to_ascii_lowercase();
        prefix.starts_with("candidate:")
            && component == Some("1")
            && transport.is_some_and(|value| value.eq_ignore_ascii_case("udp"))
            && priority.is_some()
            && port.is_some_and(|port| port > 0)
            && kind.is_some_and(|value| value.eq_ignore_ascii_case("typ"))
            && self.allows_remote(address, candidate_type.as_str().into(), trickled)
    }

    pub(crate) fn offer_allowed(self, sdp: &str) -> bool {
        sdp.lines().all(|line| {
            !(line.starts_with("a=candidate:") || line.starts_with("candidate:"))
                || self.remote_candidate_allowed(line, false)
        })
    }

    fn allows_remote(self, address: Address, kind: RTCIceCandidateType, trickled: bool) -> bool {
        let vpn = self == Self::Wan
            && (address == Address::Cgnat
                || (trickled && matches!(address, Address::Private | Address::Mdns)));
        self.allows_candidate(address, kind, vpn)
    }

    fn allows_candidate(self, address: Address, kind: RTCIceCandidateType, vpn: bool) -> bool {
        let host = matches!(kind, RTCIceCandidateType::Host | RTCIceCandidateType::Prflx);
        match self {
            Self::Lan => {
                host && (matches!(
                    address,
                    Address::Private | Address::LinkLocal | Address::Mdns
                ) || (vpn && address == Address::Cgnat))
            }
            Self::Wan if vpn => host && address != Address::Invalid,
            Self::Wan => address == Address::Public && (host || kind == RTCIceCandidateType::Srflx),
        }
    }

    fn allows_peer_ip(self, ip: IpAddr) -> bool {
        self.allows_remote(classify(ip), RTCIceCandidateType::Prflx, true)
    }
}

fn stun_url(value: &str) -> Option<String> {
    let value = value.split('?').next()?;
    let (scheme, address) = value.split_once(':')?;
    let url = Url::parse_url(&format!("{scheme}:{}", address.trim_start_matches("//"))).ok()?;
    if !matches!(url.scheme, SchemeType::Stun | SchemeType::Stuns) || url.port == 0 {
        return None;
    }
    // The Node peer used the first valid STUN endpoint and sent UDP binding
    // requests for both spellings, using port 5349 by default for stuns.
    let host = if url.host.contains(':') {
        format!("[{}]", url.host)
    } else {
        url.host
    };
    Some(format!("stun:{host}:{}", url.port))
}

#[derive(Debug)]
pub(crate) struct PeerRuntime {
    route: PeerRoute,
    // Ports are assigned by the driver. Keep the interface classification by
    // IP for host and server-reflexive candidate admission.
    interfaces: HashMap<IpAddr, bool>,
    stun: Arc<RwLock<HashSet<SocketAddr>>>,
}

impl PeerRuntime {
    pub(crate) fn bind(route: PeerRoute, config: &Value) -> Result<(Self, Vec<SocketAddr>)> {
        let policy = &config["interfacePolicy"];
        let lan_allowlist = &config["vpnPolicy"]["lanAllowlist"];
        let mut bound = Vec::new();
        let mut interfaces = HashMap::new();
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
            let ip = address.ip();
            let kind = classify(ip);
            let vpn = kind == Address::Cgnat || is_vpn(&name);
            let eligible = match route {
                PeerRoute::Lan => {
                    (!vpn || named(lan_allowlist, &name))
                        && route.allows_candidate(kind, RTCIceCandidateType::Host, vpn)
                }
                PeerRoute::Wan => {
                    matches!(kind, Address::Private | Address::Public | Address::Cgnat)
                }
            };
            if allowed && eligible {
                address.set_port(0);
                if !bound.contains(&address) {
                    bound.push(address);
                }
                interfaces
                    .entry(ip)
                    .and_modify(|seen| *seen &= vpn)
                    .or_insert(vpn);
            }
        }
        ensure!(
            !bound.is_empty(),
            "WorkerLink {} has no eligible interface.",
            route.name().to_ascii_uppercase()
        );
        Ok((
            Self {
                route,
                interfaces,
                stun: Arc::default(),
            },
            bound,
        ))
    }

    pub(super) fn pair_allowed(&self, local: &RTCIceCandidate, remote: &RTCIceCandidate) -> bool {
        self.allow_local_udp_candidate(local)
            && remote.protocol == RTCIceProtocol::Udp
            && self
                .route
                .allows_remote(classify_address(&remote.address), remote.typ, true)
    }
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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Address {
    Private,
    LinkLocal,
    Cgnat,
    Public,
    Mdns,
    Invalid,
}

fn classify(ip: IpAddr) -> Address {
    match ip {
        IpAddr::V4(v4) => match v4.octets() {
            [0 | 127 | 224..=255, ..]
            | [192, 0, 0, _]
            | [198, 18 | 19, ..]
            | [198, 51, 100, _]
            | [203, 0, 113, _] => Address::Invalid,
            [100, 64..=127, ..] => Address::Cgnat,
            _ if v4.is_private() => Address::Private,
            _ if v4.is_link_local() => Address::LinkLocal,
            _ => Address::Public,
        },
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                classify(v4.into())
            } else if v6.is_unique_local() {
                Address::Private
            } else if v6.is_unicast_link_local() {
                Address::LinkLocal
            } else if v6.segments()[0] & 0xe000 == 0x2000 {
                Address::Public
            } else {
                Address::Invalid
            }
        }
    }
}

fn parse_ip(address: &str) -> Option<IpAddr> {
    address
        .trim_matches(['[', ']'])
        .split('%')
        .next()?
        .parse()
        .ok()
}

fn classify_address(address: &str) -> Address {
    if let Some(ip) = parse_ip(address) {
        classify(ip)
    } else if is_mdns(address) {
        Address::Mdns
    } else {
        Address::Invalid
    }
}

fn is_mdns(address: &str) -> bool {
    let address = address
        .strip_suffix('.')
        .unwrap_or(address)
        .to_ascii_lowercase();
    address.strip_suffix(".local").is_some_and(|name| {
        name.split('.').all(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        })
    })
}

impl Runtime for PeerRuntime {
    fn allow_local_udp_candidate(&self, candidate: &RTCIceCandidate) -> bool {
        let address = classify_address(&candidate.address);
        let base = if candidate.related_address.is_empty() {
            &candidate.address
        } else {
            &candidate.related_address
        };
        candidate.protocol == RTCIceProtocol::Udp
            && parse_ip(base)
                .and_then(|ip| self.interfaces.get(&ip))
                .is_some_and(|&vpn| {
                    self.route.allows_candidate(
                        address,
                        candidate.typ,
                        vpn || address == Address::Cgnat,
                    )
                })
    }

    fn spawn(&self, future: Pin<Box<dyn Future<Output = ()> + Send>>) -> Box<dyn JoinHandle> {
        TokioRuntime.spawn(future)
    }

    fn wrap_udp_socket(&self, socket: std::net::UdpSocket) -> io::Result<Arc<dyn AsyncUdpSocket>> {
        let address = socket.local_addr()?;
        Ok(Arc::new(PeerSocket {
            inner: TokioRuntime.wrap_udp_socket(socket)?,
            route: self.route,
            mdns: address.port() == MDNS_PORT
                && (address.ip().is_unspecified() || address.ip() == MDNS_GROUP),
            stun: self.stun.clone(),
        }))
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
        Box::pin(async {
            // Only the configured STUN gatherer calls the runtime resolver.
            let addresses = TokioRuntime.resolve_host(host).await?;
            self.stun.write().unwrap().extend(addresses.iter().copied());
            Ok(addresses)
        })
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

#[derive(Debug)]
struct PeerSocket {
    inner: Arc<dyn AsyncUdpSocket>,
    route: PeerRoute,
    mdns: bool,
    stun: Arc<RwLock<HashSet<SocketAddr>>>,
}

const MDNS_GROUP: Ipv4Addr = Ipv4Addr::new(224, 0, 0, 251);

fn stun_packet(packet: &[u8], incoming: bool) -> bool {
    if !is_stun_message(packet) {
        return false;
    }
    let mut message = Message::new();
    message.unmarshal_binary(packet).is_ok()
        && !message.contains(ATTR_USERNAME)
        && if incoming {
            matches!(message.typ, BINDING_SUCCESS | BINDING_ERROR)
        } else {
            message.typ == BINDING_REQUEST
        }
}

impl PeerSocket {
    fn allows_stun(&self, remote: SocketAddr, packet: &[u8], incoming: bool) -> bool {
        self.route == PeerRoute::Wan
            && self.stun.read().unwrap().contains(&remote)
            && stun_packet(packet, incoming)
    }
}

impl AsyncUdpSocket for PeerSocket {
    fn local_addr(&self) -> io::Result<SocketAddr> {
        self.inner.local_addr()
    }

    fn poll_send(&self, cx: &mut Context<'_>, transmit: &Transmit<'_>) -> Poll<io::Result<usize>> {
        let remote = transmit.destination;
        let allowed = if self.mdns {
            remote == SocketAddr::from((MDNS_GROUP, MDNS_PORT))
        } else {
            self.route.allows_peer_ip(remote.ip())
                || (transmit.segment_size.is_none()
                    && self.allows_stun(remote, transmit.contents, false))
        };
        if !allowed {
            return Poll::Ready(Err(io::ErrorKind::PermissionDenied.into()));
        }
        self.inner.poll_send(cx, transmit)
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
            let received = ready!(self.inner.poll_recv(cx, &mut bufs[..1], &mut meta[..1]))?;
            if received == 0 {
                return Poll::Ready(Ok(0));
            }
            let packet = &meta[0];
            let allowed = if self.mdns {
                packet.addr.port() == MDNS_PORT
                    && matches!(
                        classify(packet.addr.ip()),
                        Address::Private | Address::LinkLocal | Address::Cgnat | Address::Public
                    )
            } else {
                self.route.allows_peer_ip(packet.addr.ip())
                    || (packet.stride >= packet.len
                        && bufs[0]
                            .get(..packet.len)
                            .is_some_and(|bytes| self.allows_stun(packet.addr, bytes, true)))
            };
            if allowed {
                return Poll::Ready(Ok(received));
            }
        }
        cx.waker().wake_by_ref();
        Poll::Pending
    }

    fn max_gso_segments(&self) -> usize {
        self.inner.max_gso_segments()
    }

    fn max_gro_segments(&self) -> usize {
        self.inner.max_gro_segments()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lan_admission_applies_to_sdp_and_peer_reflexive_packets() {
        let route = PeerRoute::Lan;
        for address in [
            "10.1.2.3",
            "192.168.2.3",
            "169.254.2.3",
            "fe80::3",
            "fd01::3",
        ] {
            assert!(route.allows_peer_ip(address.parse().unwrap()));
            assert!(route.remote_candidate_allowed(
                &format!("candidate:1 1 udp 123 {address} 1234 typ host"),
                false
            ));
        }
        assert!(
            route
                .remote_candidate_allowed("candidate:1 1 udp 1 browser.local 1234 typ host", false)
        );
        for address in ["127.0.0.1", "::1", "8.8.8.8", "100.64.2.3", "224.0.0.251"] {
            assert!(!route.allows_peer_ip(address.parse().unwrap()));
            assert!(!route.offer_allowed(&format!(
                "a=candidate:1 1 udp 123 {address} 1234 typ host
"
            )));
        }
        assert!(
            !route.remote_candidate_allowed("candidate:1 1 udp 1 10.0.0.1 1234 typ relay", false)
        );
        assert!(
            !route.remote_candidate_allowed("candidate:1 1 tcp 1 10.0.0.1 1234 typ host", false)
        );
    }

    #[test]
    fn wan_candidate_policy_distinguishes_embedded_trickled_and_local_candidates() {
        let route = PeerRoute::Wan;
        for address in ["10.1.2.3", "fd00::1", "browser.local"] {
            let candidate = format!("candidate:1 1 udp 123 {address} 1234 typ host");
            assert!(route.remote_candidate_allowed(&candidate, true));
            assert!(!route.offer_allowed(&format!("a={candidate}")));
        }
        for (address, kind) in [
            ("8.8.8.8", "srflx"),
            ("2001:4860::8888", "host"),
            ("100.64.10.2", "host"),
        ] {
            assert!(route.offer_allowed(&format!(
                "a=candidate:1 1 udp 123 {address} 1234 typ {kind}"
            )));
        }
        for address in [
            "127.0.0.1",
            "::ffff:127.0.0.1",
            "169.254.1.2",
            "192.0.0.10",
            "224.1.2.3",
        ] {
            assert!(!route.allows_peer_ip(address.parse().unwrap()));
        }
        assert!(
            !route.remote_candidate_allowed("candidate:1 1 udp 123 8.8.8.8 1234 typ relay", true)
        );
        assert!(
            !route
                .remote_candidate_allowed("candidate:1 1 udp 123 100.64.10.2 1234 typ srflx", true)
        );

        let runtime = PeerRuntime {
            route,
            interfaces: HashMap::from([
                ("10.0.0.1".parse().unwrap(), false),
                ("10.0.0.2".parse().unwrap(), true),
            ]),
            stun: Arc::default(),
        };
        let mut local = RTCIceCandidate {
            address: "10.0.0.1".into(),
            typ: RTCIceCandidateType::Host,
            protocol: RTCIceProtocol::Udp,
            ..Default::default()
        };
        assert!(!runtime.allow_local_udp_candidate(&local));
        local.address = "10.0.0.2".into();
        assert!(runtime.allow_local_udp_candidate(&local));
        local.typ = RTCIceCandidateType::Srflx;
        local.address = "8.8.8.8".into();
        assert!(!runtime.allow_local_udp_candidate(&local));
        local.related_address = "10.0.0.2".into();
        assert!(!runtime.allow_local_udp_candidate(&local));
        local.related_address = "10.0.0.1".into();
        assert!(runtime.allow_local_udp_candidate(&local));
    }

    #[test]
    fn stun_endpoints_keep_the_node_ports_and_udp_behavior() {
        assert_eq!(
            stun_url("stun:example.com"),
            Some("stun:example.com:3478".into())
        );
        assert_eq!(
            stun_url("stuns:[::1]?transport=udp"),
            Some("stun:[::1]:5349".into())
        );
        assert_eq!(stun_url("turn:example.com"), None);
        assert_eq!(stun_url("stun:example.com:0"), None);
    }
}
