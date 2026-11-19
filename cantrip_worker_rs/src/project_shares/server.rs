//! A share owns a private loopback HTTP listener and its connections.
use super::{
    Binding,
    digest::Auth,
    filesystem::{ShareFs, metadata_name},
};
use anyhow::Result;
use dav_server::{DavHandler, body::Body, memls::MemLs};
use hyper::{
    Request, Response, StatusCode, Uri, body::Incoming, header, server::conn::http1,
    service::service_fn,
};
use hyper_util::rt::TokioIo;
use percent_encoding::percent_decode_str;
use std::{convert::Infallible, net::Ipv4Addr, path::PathBuf, sync::Arc, time::Duration};
use tokio::{
    net::TcpListener,
    sync::oneshot,
    task::{JoinHandle, JoinSet},
};

const MAX_CONNECTIONS: usize = 64;

pub(super) struct Listener {
    pub port: u16,
    stop: oneshot::Sender<()>,
    task: JoinHandle<()>,
}

struct Server {
    handler: DavHandler,
    auth: Auth,
    base: String,
}

impl Listener {
    pub async fn bind(root: PathBuf, binding: &Binding) -> Result<Self> {
        let auth = Auth::new(&binding.username, &binding.realm, &binding.password)?;
        let fs = tokio::task::spawn_blocking(move || ShareFs::new(&root)).await??;
        let server = Arc::new(Server {
            handler: DavHandler::builder()
                .strip_prefix(&binding.base)
                .principal(&binding.username)
                .filesystem(Box::new(fs))
                .locksystem(MemLs::new())
                .build_handler(),
            base: binding.base.clone(),
            auth,
        });
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await?;
        let port = listener.local_addr()?.port();
        let (stop, stopped) = oneshot::channel();
        let task = tokio::spawn(serve(listener, server, stopped));
        Ok(Self { port, stop, task })
    }

    pub fn running(&self) -> bool {
        !self.task.is_finished()
    }

    pub async fn close(self) {
        let _ = self.stop.send(());
        let _ = self.task.await;
    }
}

async fn serve(listener: TcpListener, server: Arc<Server>, mut stop: oneshot::Receiver<()>) {
    let mut connections = JoinSet::new();
    loop {
        tokio::select! {
            biased;
            _ = &mut stop => break,
            _ = connections.join_next(), if !connections.is_empty() => {}
            result = listener.accept(), if connections.len() < MAX_CONNECTIONS => {
                let Ok((socket, _)) = result else {
                    break;
                };
                let server = server.clone();
                connections.spawn(async move {
                    let _ = http1::Builder::new()
                        .timer(hyper_util::rt::TokioTimer::new())
                        .header_read_timeout(Duration::from_secs(30))
                        .serve_connection(TokioIo::new(socket), service_fn(move |request| {
                            let server = server.clone();
                            async move { Ok::<_, Infallible>(server.handle(request).await) }
                        }))
                        .await;
                });
            }
        }
    }
    drop(listener);
    connections.shutdown().await;
}

impl Server {
    async fn handle(&self, mut request: Request<Incoming>) -> Response<Body> {
        if !self.auth.verifies(&request) {
            let mut response = empty(StatusCode::UNAUTHORIZED);
            response
                .headers_mut()
                .insert(header::WWW_AUTHENTICATE, self.auth.challenge.clone());
            return response;
        }
        let requested = request.uri().path();
        let raw_destination = request.headers().get("destination");
        let destination = raw_destination
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<Uri>().ok());
        if raw_destination.is_some() && destination.is_none() {
            return empty(StatusCode::BAD_REQUEST);
        }
        if has_metadata(requested)
            || destination
                .as_ref()
                .is_some_and(|uri| has_metadata(uri.path()))
        {
            let mutating = matches!(
                request.method().as_str(),
                "COPY" | "DELETE" | "LOCK" | "MKCOL" | "MOVE" | "PROPPATCH" | "PUT" | "UNLOCK"
            );
            return empty(if mutating {
                StatusCode::FORBIDDEN
            } else {
                StatusCode::NOT_FOUND
            });
        }
        if !self.inside(requested)
            || destination
                .as_ref()
                .is_some_and(|uri| !self.inside(uri.path()))
        {
            return empty(StatusCode::FORBIDDEN);
        }
        // Finder's positive condition means the file is unlocked. The lock
        // engine's regular conditions still reject the operation if it is locked.
        let condition = request
            .headers()
            .get("if")
            .and_then(|value| value.to_str().ok())
            .filter(|value| value.contains("<DAV:no-lock>"))
            .and_then(|value| {
                header::HeaderValue::from_str(
                    &value.replace("<DAV:no-lock>", "<urn:cantrip:no-lock>"),
                )
                .ok()
            });
        if let Some(condition) = condition {
            request.headers_mut().insert("if", condition);
        }
        let mut response = self.handler.handle(request).await;
        response
            .headers_mut()
            .insert(header::SERVER, header::HeaderValue::from_static("Cantrip"));
        response
    }

    fn inside(&self, path: &str) -> bool {
        path.strip_prefix(&self.base)
            .is_some_and(|remainder| remainder.is_empty() || remainder.starts_with('/'))
    }
}

fn has_metadata(path: &str) -> bool {
    path.split('/')
        .any(|segment| metadata_name(&percent_decode_str(segment).collect::<Vec<_>>()))
}

fn empty(status: StatusCode) -> Response<Body> {
    Response::builder()
        .status(status)
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::SERVER, "Cantrip")
        .body(Body::empty())
        .expect("fixed share response headers")
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::{
        io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
        net::TcpStream,
        time::timeout,
    };
    use zeroize::Zeroizing;

    #[tokio::test]
    async fn closing_a_share_releases_its_live_http_connection() -> Result<()> {
        let root = tempfile::tempdir()?;
        let binding = Binding {
            base: format!("/project-shares/{}", "a".repeat(43)),
            username: "share-test".into(),
            password: Zeroizing::new("test-only".repeat(4)),
            realm: "Cantrip Share Test".into(),
        };
        let listener = Listener::bind(root.path().to_owned(), &binding).await?;
        let address = (Ipv4Addr::LOCALHOST, listener.port);
        let mut client = BufReader::new(TcpStream::connect(address).await?);
        client
            .write_all(
                format!("GET {}/ HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n", binding.base).as_bytes(),
            )
            .await?;
        let mut status = String::new();
        timeout(Duration::from_secs(3), client.read_line(&mut status)).await??;
        assert_eq!(status, "HTTP/1.1 401 Unauthorized\r\n");

        listener.close().await;
        timeout(Duration::from_secs(3), client.read_to_end(&mut Vec::new())).await??;
        assert!(TcpStream::connect(address).await.is_err());
        Ok(())
    }
}
