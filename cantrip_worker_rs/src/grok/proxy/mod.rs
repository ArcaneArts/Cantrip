//! The worker-owned loopback bridge used only by native model runtimes.
pub(super) mod account;
mod continuity;

use super::http::Http;
use anyhow::{Result, anyhow, bail};
use bytes::Bytes;
use cantrip_history::projection::Work;
use cantrip_wire::Value;
use continuity::{Continuity, Payload};
use futures::stream;
use http_body_util::{BodyExt, Full, Limited, StreamBody, combinators::UnsyncBoxBody};
use hyper::{
    Method, Request, Response, StatusCode,
    body::{Frame, Incoming},
    header::{HeaderMap, HeaderValue},
    server::conn::http1,
    service::service_fn,
};
use hyper_util::rt::{TokioIo, TokioTimer};
use std::{
    convert::Infallible,
    sync::{Arc, Mutex},
};
use tokio::{
    net::TcpListener,
    sync::watch,
    task::{JoinHandle, JoinSet},
};

const MAX_REQUEST: usize = 64 * 1024 * 1024;
const ERROR_PREFIX: usize = 1024 * 1024;
const STRIP_REQUEST: &[&str] = &[
    "authorization",
    "host",
    "content-length",
    "x-authenticateresponse",
    "x-email",
    "x-grok-client-identifier",
    "x-grok-client-mode",
    "x-grok-client-version",
    "x-grok-conv-id",
    "x-grok-agent-id",
    "x-grok-model-override",
    "x-grok-req-id",
    "x-grok-session-id",
    "x-grok-turn-idx",
    "x-grok-user-id",
    "x-userid",
    "x-xai-token-auth",
];
const HOP_HEADERS: &[&str] = &[
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "proxy-connection",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
];

type Body = UnsyncBoxBody<Bytes, reqwest::Error>;
pub(super) type Authorize = Arc<dyn Fn(Option<u64>) -> Work<Credential> + Send + Sync>;

pub(super) struct Credential {
    pub value: Value,
    /// Zero represents a worker-local credential. It can also be renewed.
    pub revision: u64,
}

pub(super) struct Proxy {
    pub url: String,
    stop: watch::Sender<bool>,
    task: JoinHandle<Result<()>>,
}

impl Proxy {
    pub(super) async fn start(http: Http, authorize: Authorize) -> Result<Self> {
        // The initial access determines whether the caller should use migration fallback.
        authorize(None).await?;
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).await?;
        let path = format!("/{}/v1", uuid::Uuid::new_v4());
        let url = format!("http://{}{}", listener.local_addr()?, path);
        let service = Arc::new(Service {
            path,
            http,
            authorize,
            continuity: Mutex::new(Continuity::new()),
        });
        let (stop, stopped) = watch::channel(false);
        let task = tokio::spawn(run(listener, service, stopped));
        Ok(Self { url, stop, task })
    }

    pub(super) fn is_live(&self) -> bool {
        !self.task.is_finished()
    }

    pub(super) async fn close(self) -> Result<()> {
        self.stop.send_replace(true);
        self.task.await?
    }
}

async fn run(
    listener: TcpListener,
    service: Arc<Service>,
    mut stop: watch::Receiver<bool>,
) -> Result<()> {
    let mut connections = JoinSet::new();
    let outcome = loop {
        tokio::select! {
            biased;
            _ = stop.changed() => break Ok(()),
            result = connections.join_next(), if !connections.is_empty() => {
                if let Some(Err(error)) = result {
                    break Err(error.into());
                }
            }
            accepted = listener.accept() => match accepted {
                Ok((socket, _)) => {
                    let service = service.clone();
                    connections.spawn(async move {
                        let _ = http1::Builder::new().timer(TokioTimer::new())
                            .serve_connection(TokioIo::new(socket), service_fn(move |request| {
                                let service = service.clone();
                                async move { Ok::<_, Infallible>(service.handle(request).await) }
                            })).await;
                    });
                }
                Err(error) => break Err(error.into()),
            },
        }
    };
    drop(listener);
    connections.shutdown().await;
    outcome
}

struct Service {
    path: String,
    http: Http,
    authorize: Authorize,
    continuity: Mutex<Continuity>,
}

impl Service {
    async fn handle(&self, incoming: Request<Incoming>) -> Response<Body> {
        match self.forward(incoming).await {
            Ok(response) => response.into_http(),
            Err(error)
                if error
                    .chain()
                    .any(|cause| cause.is::<http_body_util::LengthLimitError>()) =>
            {
                error_response(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "Grok proxy request exceeded 64 MiB.",
                )
            }
            Err(_) => error_response(
                StatusCode::BAD_GATEWAY,
                "Grok subscription proxy request failed.",
            ),
        }
    }

    async fn forward(&self, incoming: Request<Incoming>) -> Result<Upstream> {
        let (parts, incoming) = incoming.into_parts();
        let path = parts.uri.path();
        let relative = path
            .strip_prefix(&self.path)
            .and_then(|suffix| suffix.strip_prefix('/'));
        let Some(relative) = relative.filter(|relative| {
            parts.uri.scheme().is_none()
                && parts.uri.authority().is_none()
                && !relative.starts_with(['/', '\\'])
        }) else {
            bail!("Grok proxy rejected a path outside /v1.");
        };
        let mut resource = relative.to_owned();
        if let Some(query) = parts.uri.query() {
            resource.push('?');
            resource.push_str(query);
        }
        let mut headers = filtered(parts.headers, STRIP_REQUEST);
        let carries_body = !matches!(parts.method, Method::GET | Method::HEAD);
        let body = if carries_body {
            Limited::new(incoming, MAX_REQUEST)
                .collect()
                .await
                .map_err(anyhow::Error::from_boxed)?
                .to_bytes()
        } else {
            Bytes::new()
        };
        let mut payload = Payload::new(body);
        let (identity, stateless) = self
            .continuity
            .lock()
            .unwrap()
            .prepare(&mut payload, &mut headers)?;
        let mut request = Forward {
            method: parts.method,
            resource,
            headers,
            carries_body,
        };
        let mut response = self.send(&request, &payload).await?;
        if stateless || !response.reasoning_failure().await {
            return Ok(response);
        }

        let rejected = payload.keys();
        if payload.strip(None) {
            drop(response);
            response = self.send(&request, &payload).await?;
            if !response.reasoning_failure().await {
                self.continuity
                    .lock()
                    .unwrap()
                    .quarantine(&identity, rejected);
                return Ok(response);
            }
        }
        if !payload.stateless() {
            return Ok(response);
        }
        drop(response);
        let request_id = Continuity::stateless_headers(&mut request.headers)?;
        let response = self.send(&request, &payload).await?;
        if response.response.status().is_success() {
            self.continuity
                .lock()
                .unwrap()
                .commit_stateless(&identity, request_id);
        }
        Ok(response)
    }

    async fn send(&self, request: &Forward, payload: &Payload) -> Result<Upstream> {
        let send = |credential: Credential| -> Result<reqwest::RequestBuilder> {
            let headers = request.headers.clone();
            let mut upstream = self.http.subscription_request(
                request.method.clone(),
                &request.resource,
                &credential.value,
            )?;
            upstream = upstream.headers(headers);
            if request.carries_body {
                upstream = upstream.body(payload.bytes.clone());
            }
            Ok(upstream)
        };
        let credential = (self.authorize)(None).await?;
        let revision = credential.revision;
        let mut response = send(credential)?
            .send()
            .await
            .map_err(|_| anyhow!("Grok subscription request failed."))?;
        if response.status() == StatusCode::UNAUTHORIZED {
            drop(response);
            response = send((self.authorize)(Some(revision)).await?)?
                .send()
                .await
                .map_err(|_| anyhow!("Grok subscription request failed."))?;
        }
        Ok(Upstream {
            response,
            prefix: Vec::new(),
            error: None,
        })
    }
}

struct Forward {
    method: Method,
    resource: String,
    headers: HeaderMap,
    carries_body: bool,
}

struct Upstream {
    response: reqwest::Response,
    prefix: Vec<Bytes>,
    error: Option<reqwest::Error>,
}

impl Upstream {
    async fn reasoning_failure(&mut self) -> bool {
        if self.response.status() != StatusCode::BAD_REQUEST {
            return false;
        }
        let mut inspected = Vec::new();
        while inspected.len() < ERROR_PREFIX {
            match self.response.chunk().await {
                Ok(Some(chunk)) => {
                    inspected.extend_from_slice(
                        &chunk[..chunk.len().min(ERROR_PREFIX - inspected.len())],
                    );
                    self.prefix.push(chunk);
                }
                Ok(None) => break,
                Err(error) => {
                    self.error = Some(error);
                    break;
                }
            }
        }
        let text = String::from_utf8_lossy(&inspected).to_ascii_lowercase();
        [
            "could not decode the compaction blob",
            "could not decrypt the provided encrypted_content",
        ]
        .into_iter()
        .any(|marker| text.contains(marker))
    }

    fn into_http(self) -> Response<Body> {
        let status = self.response.status();
        let headers = filtered(
            self.response.headers().clone(),
            &["content-encoding", "content-length"],
        );
        let buffered = self
            .prefix
            .into_iter()
            .map(|chunk| Ok(Frame::data(chunk)))
            .chain(self.error.into_iter().map(Err));
        let streaming = stream::unfold(Some(self.response), |response| async {
            let mut response = response?;
            match response.chunk().await {
                Ok(Some(chunk)) => Some((Ok(Frame::data(chunk)), Some(response))),
                Ok(None) => None,
                Err(error) => Some((Err(error), None)),
            }
        });
        use futures::StreamExt;
        let body = StreamBody::new(stream::iter(buffered).chain(streaming)).boxed_unsync();
        let mut response = Response::new(body);
        *response.status_mut() = status;
        *response.headers_mut() = headers;
        response
    }
}

fn filtered(mut headers: HeaderMap, excluded: &[&str]) -> HeaderMap {
    let dynamic: Vec<hyper::header::HeaderName> = headers
        .get_all("connection")
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .filter_map(|name| name.trim().parse().ok())
        .collect();
    for name in dynamic {
        headers.remove(name);
    }
    for name in HOP_HEADERS.iter().chain(excluded) {
        headers.remove(*name);
    }
    headers
}

fn error_response(status: StatusCode, message: &'static str) -> Response<Body> {
    let content = cantrip_wire::value::json!({"error":message}).stringify();
    let body = Full::new(Bytes::from(content))
        .map_err(|never| match never {})
        .boxed_unsync();
    let mut response = Response::new(body);
    *response.status_mut() = status;
    response
        .headers_mut()
        .insert("content-type", HeaderValue::from_static("application/json"));
    response
}
