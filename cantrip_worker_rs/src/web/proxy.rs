//! Loopback HTTP proxy owned by a private interactive Chromium session.
use super::{
    Service,
    network::{Connections, normalize, redirect},
    render::hop_header,
};
use anyhow::{Context, Result, ensure};
use bytes::Bytes;
use http_body_util::{BodyExt, Empty, Limited, StreamBody, combinators::UnsyncBoxBody};
use hyper::{
    Method, Request, Response, StatusCode, Uri,
    body::{Body, Frame, Incoming},
    client::conn::http1 as upstream_http,
    header::{self, HeaderMap, HeaderName},
    server::conn::http1,
    service::service_fn,
    upgrade::{self, OnUpgrade},
};
use hyper_util::rt::{TokioIo, TokioTimer};
use std::{
    convert::Infallible,
    io,
    net::{Ipv4Addr, SocketAddr, SocketAddrV4},
    sync::Arc,
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::{OwnedSemaphorePermit, mpsc},
    task::{JoinHandle, JoinSet},
    time::timeout,
};
use url::{Position, Url};

const TIMEOUT: Duration = Duration::from_secs(30);
const MAX_SOCKETS: usize = 32;
const MAX_UPLOAD: usize = 8_000_000;
const MAX_RESPONSE: usize = 20_000_000;
const MAX_TUNNEL: u64 = 50_000_000;

type BoxError = Box<dyn std::error::Error + Send + Sync>;
type ProxyBody = UnsyncBoxBody<Bytes, BoxError>;

pub(super) struct Proxy(JoinHandle<()>);

impl Proxy {
    pub(super) async fn start(service: Arc<Service>) -> Result<(Self, SocketAddrV4)> {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await?;
        let SocketAddr::V4(address) = listener.local_addr()? else {
            unreachable!("listener was bound to IPv4");
        };
        Ok((Self(tokio::spawn(serve(listener, service))), address))
    }
}

impl Drop for Proxy {
    fn drop(&mut self) {
        self.0.abort();
    }
}

async fn serve(listener: TcpListener, service: Arc<Service>) {
    let limits = Arc::new(Connections::default());
    let (tunnels, mut incoming) = mpsc::channel(8);
    let mut sockets = JoinSet::new();
    loop {
        tokio::select! {
            _ = sockets.join_next(), if !sockets.is_empty() => {}
            Some(tunnel) = incoming.recv() => {
                sockets.spawn(relay(tunnel));
            }
            accepted = listener.accept(), if sockets.len() < MAX_SOCKETS => {
                let Ok((socket, _)) = accepted else { return };
                let service = service.clone();
                let limits = limits.clone();
                let tunnels = tunnels.clone();
                sockets.spawn(async move {
                    let proxy = service_fn(move |request| {
                        let service = service.clone();
                        let limits = limits.clone();
                        let tunnels = tunnels.clone();
                        async move {
                            let response = forward(request, &service, &limits, &tunnels)
                                .await
                                .unwrap_or_else(|_| {
                                    let mut response = Response::new(empty());
                                    *response.status_mut() = StatusCode::BAD_GATEWAY;
                                    response
                                });
                            Ok::<_, Infallible>(response)
                        }
                    });
                    let _ = http1::Builder::new()
                        .timer(TokioTimer::new())
                        .header_read_timeout(TIMEOUT)
                        .serve_connection(TokioIo::new(socket), proxy)
                        .with_upgrades()
                        .await;
                });
            }
        }
    }
}

fn target(method: &Method, uri: &Uri) -> Result<Url> {
    if method == Method::CONNECT {
        ensure!(
            uri.scheme().is_none() && uri.path_and_query().is_none(),
            "CONNECT requires an authority."
        );
        let authority = uri.authority().context("CONNECT requires an authority.")?;
        let scheme = match authority.port_u16() {
            Some(443) => "https",
            Some(80) => "http",
            _ => anyhow::bail!("CONNECT requires a standard web port."),
        };
        return normalize(Url::parse(&format!("{scheme}://{authority}/"))?);
    }
    ensure!(uri.scheme_str() == Some("http"), "HTTPS requires CONNECT.");
    ensure!(
        !matches!(method.as_str(), "TRACE" | "TRACK"),
        "The browser request method is not allowed."
    );
    normalize(Url::parse(&uri.to_string())?)
}

async fn forward(
    mut request: Request<Incoming>,
    service: &Service,
    limits: &Connections,
    tunnels: &mpsc::Sender<Tunnel>,
) -> Result<Response<ProxyBody>> {
    let url = target(request.method(), request.uri())?;
    let permits = limits.try_acquire(&url)?;
    let address = service.network.destination(&url).await?;
    let socket = timeout(TIMEOUT, TcpStream::connect(address)).await??;
    if request.method() == Method::CONNECT {
        tunnels.try_send(Tunnel {
            upgrade: upgrade::on(&mut request),
            socket,
            _permits: permits,
        })?;
        return Ok(Response::new(empty()));
    }

    let (mut parts, body) = request.into_parts();
    ensure!(
        body.size_hint().lower() <= MAX_UPLOAD as u64,
        "Upload is too large."
    );
    let is_head = parts.method == Method::HEAD;
    parts.uri = url[Position::BeforePath..].parse()?;
    strip_hop_headers(&mut parts.headers);
    parts.headers.insert(
        header::HOST,
        url[Position::BeforeHost..Position::AfterPort].parse()?,
    );

    let (mut sender, connection) = upstream_http::handshake(TokioIo::new(socket)).await?;
    let driver = Upstream(tokio::spawn(async move {
        let _ = connection.await;
    }));
    let request = Request::from_parts(parts, Limited::new(body, MAX_UPLOAD));
    let response = timeout(TIMEOUT, sender.send_request(request)).await??;
    ensure!(
        response.status().as_u16() >= 200,
        "Unsupported proxy response."
    );
    if response.status().is_redirection()
        && let Some(location) = response.headers().get(header::LOCATION)
    {
        redirect(&url, location.to_str()?)?;
    }

    let (mut parts, body) = response.into_parts();
    strip_hop_headers(&mut parts.headers);
    if is_head || body.is_end_stream() {
        return Ok(Response::from_parts(parts, empty()));
    }
    ensure!(
        body.size_hint().lower() <= MAX_RESPONSE as u64,
        "Response is too large."
    );
    let stream = futures::stream::try_unfold(
        (
            Limited::new(body, MAX_RESPONSE).into_data_stream(),
            driver,
            permits,
        ),
        async |(mut body, driver, permits)| {
            use futures::StreamExt;
            let Some(chunk) = timeout(TIMEOUT, body.next()).await? else {
                return Ok(None);
            };
            Ok::<_, BoxError>(Some((Frame::data(chunk?), (body, driver, permits))))
        },
    );
    Ok(Response::from_parts(
        parts,
        StreamBody::new(stream).boxed_unsync(),
    ))
}

fn empty() -> ProxyBody {
    Empty::new().map_err(|error| match error {}).boxed_unsync()
}

fn strip_hop_headers(headers: &mut HeaderMap) {
    let mut removed: Vec<_> = headers
        .get_all(header::CONNECTION)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .filter_map(|name| HeaderName::try_from(name.trim()).ok())
        .collect();
    removed.extend(headers.keys().filter(|name| hop_header(name)).cloned());
    for header in removed {
        headers.remove(header);
    }
}

struct Upstream(JoinHandle<()>);

impl Drop for Upstream {
    fn drop(&mut self) {
        self.0.abort();
    }
}

struct Tunnel {
    upgrade: OnUpgrade,
    socket: TcpStream,
    _permits: [OwnedSemaphorePermit; 2],
}

async fn relay(tunnel: Tunnel) {
    if let Ok(Ok(upgraded)) = timeout(TIMEOUT, tunnel.upgrade).await {
        let (client_read, client_write) = tokio::io::split(TokioIo::new(upgraded));
        let (origin_read, origin_write) = tunnel.socket.into_split();
        tokio::select! {
            _ = copy_bounded(client_read, origin_write) => {}
            _ = copy_bounded(origin_read, client_write) => {}
        }
    }
}

async fn copy_bounded(
    from: impl AsyncRead + Unpin,
    mut to: impl AsyncWrite + Unpin,
) -> io::Result<()> {
    let mut limited = from.take(MAX_TUNNEL);
    tokio::io::copy(&mut limited, &mut to).await?;
    if limited.limit() == 0 && limited.into_inner().read(&mut [0]).await? != 0 {
        return Err(io::Error::other("Browser tunnel exceeded its byte limit."));
    }
    to.shutdown().await
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncBufReadExt, BufReader};

    async fn connect(
        address: SocketAddrV4,
        authority: &str,
    ) -> Result<(String, BufReader<TcpStream>)> {
        let socket = TcpStream::connect(address).await?;
        let mut client = BufReader::new(socket);
        client
            .write_all(
                format!("CONNECT {authority} HTTP/1.1\r\nHost: {authority}\r\n\r\n").as_bytes(),
            )
            .await?;
        let mut status = String::new();
        client.read_line(&mut status).await?;
        loop {
            let mut header = String::new();
            ensure!(
                client.read_line(&mut header).await? > 0,
                "Proxy did not finish its response."
            );
            if header == "\r\n" {
                break;
            }
        }
        Ok((status, client))
    }

    #[tokio::test]
    async fn connect_validates_destination_and_closes_with_the_proxy() -> Result<()> {
        timeout(Duration::from_secs(5), async {
            let origin = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await?;
            let service = Service::with_fixture(None, None, origin.local_addr()?);
            let (proxy, address) = Proxy::start(service).await?;
            for authority in ["127.0.0.1:443", "page.example:81"] {
                let (status, _) = connect(address, authority).await?;
                assert!(status.starts_with("HTTP/1.1 502 "), "{status:?}");
            }

            let (status, mut client) = connect(address, "page.example:443").await?;
            assert!(status.starts_with("HTTP/1.1 200 "), "{status:?}");
            let (mut upstream, _) = origin.accept().await?;
            let mut received = [0; 4];
            client.write_all(b"ping").await?;
            upstream.read_exact(&mut received).await?;
            assert_eq!(&received, b"ping");
            upstream.write_all(b"pong").await?;
            client.read_exact(&mut received).await?;
            assert_eq!(&received, b"pong");

            drop(proxy);
            assert_eq!(client.read(&mut received).await?, 0);
            assert_eq!(upstream.read(&mut received).await?, 0);
            Ok(())
        })
        .await?
    }
}
