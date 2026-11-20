use super::carrier::DeliveryUnknown;
use crate::filesystem::Scope;
use anyhow::{Context, Result, anyhow, bail, ensure};
use bytes::Bytes;
use cantrip_wire::{Value, parse_json_text};
use http_body_util::{BodyExt, Full, Limited};
use hyper::{Method, Request, Response, StatusCode, body::Incoming, client::conn::http1};
use hyper_util::rt::TokioIo;
use percent_encoding::{NON_ALPHANUMERIC, utf8_percent_encode};
use std::{env, ffi::OsStr, fmt::Display, time::Duration};
use tokio::{
    io::{AsyncRead, AsyncWrite},
    task::JoinSet,
    time::timeout,
};

#[derive(PartialEq, Eq)]
pub(super) struct Identity {
    pub id: String,
    started_at: String,
}

#[derive(Debug)]
pub(super) struct DockerApiError {
    pub status: StatusCode,
    message: String,
}

impl std::fmt::Display for DockerApiError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "Docker HTTP {}: {}", self.status, self.message)
    }
}

impl std::error::Error for DockerApiError {}

pub(super) fn segment(value: &str) -> impl Display + '_ {
    utf8_percent_encode(value, NON_ALPHANUMERIC)
}

pub(super) struct LocalDocker(String);

pub(super) struct ImageExport {
    body: Incoming,
    _connection: JoinSet<Result<(), hyper::Error>>,
}

impl ImageExport {
    pub async fn next(&mut self, scope: &Scope) -> Result<Option<Bytes>> {
        loop {
            let frame = tokio::select! {
                biased;
                _ = scope.stopped() => bail!("Worker stopped during Docker image export."),
                frame = timeout(Duration::from_secs(300), self.body.frame()) => frame?,
            };
            let Some(frame) = frame else { return Ok(None) };
            if let Ok(data) = frame?.into_data() {
                return Ok(Some(data));
            }
        }
    }
}

impl LocalDocker {
    pub async fn current(scope: &Scope) -> Result<Self> {
        let configured = env::var("DOCKER_HOST").ok().filter(|host| {
            !host.is_empty() && env::var_os("DOCKER_CONTEXT").is_none_or(|value| value.is_empty())
        });
        let endpoint = match configured {
            Some(endpoint) => endpoint,
            None => {
                let args = ["context".into(), "inspect".into()];
                let result = scope
                    .capture_timeout(
                        OsStr::new("docker"),
                        &args,
                        1024 * 1024,
                        Duration::from_secs(60),
                    )
                    .await?;
                ensure!(
                    result.code == Some(0) && result.overflow.is_none() && !result.timed_out,
                    "Docker context inspection failed."
                );
                let data = parse_json_text(std::str::from_utf8(&result.stdout)?)
                    .map_err(|_| anyhow!("Docker returned invalid context information."))?;
                data.as_array()
                    .and_then(|entries| entries.first())
                    .and_then(|entry| entry["Endpoints"]["docker"]["Host"].as_str())
                    .context("Docker context has no endpoint.")?
                    .to_owned()
            }
        };
        #[cfg(unix)]
        if endpoint.starts_with("unix://") {
            let parsed = url::Url::parse(&endpoint)?;
            return Ok(Self(
                percent_encoding::percent_decode_str(parsed.path())
                    .decode_utf8()?
                    .into_owned(),
            ));
        }
        #[cfg(windows)]
        if let Some(endpoint) = endpoint.strip_prefix("npipe://") {
            return Ok(Self(endpoint.replace('/', "\\")));
        }
        bail!("Docker context does not expose a local Engine socket.");
    }

    pub async fn inspect(&self, container: &str, scope: &Scope) -> Result<Identity> {
        let data = self.record(container, scope).await?;
        Ok(Identity {
            id: data["Id"]
                .as_str()
                .filter(|value| !value.is_empty())
                .context("Docker container identity")?
                .to_owned(),
            started_at: data["State"]["StartedAt"]
                .as_str()
                .context("Docker container start time")?
                .to_owned(),
        })
    }

    pub async fn record(&self, container: &str, scope: &Scope) -> Result<Value> {
        self.request(
            Method::GET,
            &format!("/containers/{}/json", segment(container)),
            None,
            Duration::from_secs(60),
            scope,
        )
        .await
    }

    pub async fn request(
        &self,
        method: Method,
        path: &str,
        body: Option<&Value>,
        limit: Duration,
        scope: &Scope,
    ) -> Result<Value> {
        let bytes = self.read_response(method, path, body, limit, scope).await?;
        if bytes.is_empty() {
            return Ok(Value::Null);
        }
        std::str::from_utf8(&bytes)
            .ok()
            .and_then(|body| parse_json_text(body).ok())
            .ok_or_else(|| DeliveryUnknown("Docker returned an invalid receipt.".to_owned()).into())
    }

    pub async fn read_archive(&self, container: &str, path: &str, scope: &Scope) -> Result<Bytes> {
        self.read_response(
            Method::GET,
            &format!(
                "/containers/{}/archive?path={}",
                segment(container),
                segment(path)
            ),
            None,
            Duration::from_secs(60),
            scope,
        )
        .await
    }

    pub async fn export_image(&self, id: &str, scope: &Scope) -> Result<ImageExport> {
        scope.check()?;
        let path = format!("/images/{}/get", segment(id));
        let export = async {
            let (response, connection) = self.open(Method::GET, &path, None).await?;
            ensure!(
                response.status().is_success(),
                "Docker image export returned HTTP {}.",
                response.status()
            );
            Ok(ImageExport {
                body: response.into_body(),
                _connection: connection,
            })
        };
        tokio::select! {
            biased;
            _ = scope.stopped() => bail!("Worker stopped before Docker image export."),
            result = timeout(Duration::from_secs(300), export) => result?,
        }
    }

    async fn open(
        &self,
        method: Method,
        path: &str,
        body: Option<&Value>,
    ) -> Result<(Response<Incoming>, JoinSet<Result<(), hyper::Error>>)> {
        #[cfg(unix)]
        let socket = tokio::net::UnixStream::connect(&self.0).await?;
        #[cfg(windows)]
        let socket = tokio::net::windows::named_pipe::ClientOptions::new().open(&self.0)?;
        response(socket, method, path, body).await
    }

    async fn read_response(
        &self,
        method: Method,
        path: &str,
        body: Option<&Value>,
        limit: Duration,
        scope: &Scope,
    ) -> Result<Bytes> {
        scope.check()?;
        let exchange = async {
            let (response, _connection) = self.open(method, path, body).await?;
            collect(response).await
        };
        let result = tokio::select! {
            biased;
            _ = scope.stopped() => Err(anyhow!("Worker stopped while awaiting Docker.")),
            result = timeout(limit, exchange) => match result {
                Ok(receipt) => receipt,
                Err(_) => Err(anyhow!("Docker request timed out.")),
            },
        };
        result.map_err(|error| {
            if error.is::<DockerApiError>() {
                error
            } else {
                DeliveryUnknown(format!("Docker receipt is uncertain: {error}")).into()
            }
        })
    }
}

async fn response(
    socket: impl AsyncRead + AsyncWrite + Unpin + Send + 'static,
    method: Method,
    path: &str,
    body: Option<&Value>,
) -> Result<(Response<Incoming>, JoinSet<Result<(), hyper::Error>>)> {
    let (mut requests, connection) = http1::handshake(TokioIo::new(socket)).await?;
    let mut owned = JoinSet::new();
    owned.spawn(connection);
    let mut request = Request::builder()
        .method(method)
        .uri(format!("/v1.41{path}"))
        .header("host", "localhost")
        .header("connection", "close");
    let payload = if let Some(body) = body {
        request = request.header("content-type", "application/json");
        Bytes::from(body.stringify())
    } else {
        Bytes::new()
    };
    let request = request.body(Full::new(payload))?;
    Ok((requests.send_request(request).await?, owned))
}

async fn collect(response: Response<Incoming>) -> Result<Bytes> {
    let status = response.status();
    let bytes = Limited::new(response.into_body(), 4 * 1024 * 1024)
        .collect()
        .await
        .map_err(|_| anyhow!("Docker response could not be read."))?
        .to_bytes();
    if status.is_client_error() || status.is_server_error() {
        let receipt = if bytes.is_empty() {
            Value::Null
        } else {
            parse_json_text(std::str::from_utf8(&bytes)?)
                .map_err(|_| anyhow!("Docker returned an invalid receipt."))?
        };
        return Err(DockerApiError {
            status,
            message: receipt["message"]
                .as_str()
                .unwrap_or("request refused")
                .to_owned(),
        }
        .into());
    }
    Ok(bytes)
}
