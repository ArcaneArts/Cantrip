use super::{archive_io::hexadecimal, carrier::DeliveryUnknown};
use crate::filesystem::Scope;
use anyhow::{Context, Result, anyhow, bail, ensure};
use bytes::Bytes;
use cantrip_wire::{Value, parse_json_text};
use http_body_util::{BodyExt, Full, Limited, StreamBody, combinators::UnsyncBoxBody};
use hyper::{
    Method, Request, Response, StatusCode,
    body::{Frame, Incoming},
    client::conn::http1,
};
use hyper_util::rt::TokioIo;
use percent_encoding::{NON_ALPHANUMERIC, utf8_percent_encode};
use sha2::{Digest, Sha256};
use std::{
    env,
    ffi::OsStr,
    fmt::Display,
    io,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite},
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

#[derive(Debug)]
pub(super) struct ImageUploadChanged;

impl std::fmt::Display for ImageUploadChanged {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("The staged system archive changed during upload; no root was activated.")
    }
}

impl std::error::Error for ImageUploadChanged {}

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
        let mut request = request_builder(method, path);
        let payload = if let Some(body) = body {
            request = request.header("content-type", "application/json");
            Bytes::from(body.stringify())
        } else {
            Bytes::new()
        };
        let body = Full::new(payload)
            .map_err(|never| match never {})
            .boxed_unsync();
        self.send(request.body(body)?).await
    }

    async fn send(
        &self,
        request: Request<UnsyncBoxBody<Bytes, io::Error>>,
    ) -> Result<(Response<Incoming>, JoinSet<Result<(), hyper::Error>>)> {
        #[cfg(unix)]
        let socket = tokio::net::UnixStream::connect(&self.0).await?;
        #[cfg(windows)]
        let socket = tokio::net::windows::named_pipe::ClientOptions::new().open(&self.0)?;
        response(socket, request).await
    }

    pub async fn load_image(
        &self,
        file: tokio::fs::File,
        size: u64,
        sha256: &str,
        scope: &Scope,
    ) -> Result<()> {
        scope.check()?;
        let proof = Arc::new(Mutex::new((0_u64, Sha256::new())));
        let stream =
            futures::stream::try_unfold((file, proof.clone()), |(mut file, proof)| async {
                let mut buffer = vec![0; 64 * 1024];
                let size = file.read(&mut buffer).await?;
                if size == 0 {
                    return Ok::<_, io::Error>(None);
                }
                buffer.truncate(size);
                {
                    let mut proof = proof.lock().expect("image upload proof");
                    proof.0 += size as u64;
                    proof.1.update(&buffer);
                }
                Ok(Some((Frame::data(Bytes::from(buffer)), (file, proof))))
            });
        let request = request_builder(Method::POST, "/images/load?quiet=true")
            .header("content-type", "application/x-tar")
            .header("content-length", size)
            .body(StreamBody::new(stream).boxed_unsync())?;
        let exchange = async {
            let (response, _connection) = self.send(request).await?;
            let status = response.status();
            let reply = collect(response).await?;
            ensure!(
                status == StatusCode::OK,
                "Docker image load returned HTTP {status}."
            );
            let text = std::str::from_utf8(&reply)?;
            for line in text.lines().filter(|line| !line.trim().is_empty()) {
                let event = parse_json_text(line)
                    .map_err(|_| anyhow!("Docker returned an invalid image-load receipt."))?;
                ensure!(
                    event.is_object() && event["error"].is_null() && event["errorDetail"].is_null(),
                    "Docker reported an incomplete image load."
                );
            }
            let (received, hash) = &*proof.lock().expect("image upload proof");
            ensure!(
                *received == size && hexadecimal(hash.clone()) == sha256,
                ImageUploadChanged
            );
            Ok(())
        };
        tokio::select! {
            biased;
            _ = scope.stopped() => bail!("Worker stopped during Docker image load."),
            result = timeout(Duration::from_secs(300), exchange) => result?,
        }
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

fn request_builder(method: Method, path: &str) -> hyper::http::request::Builder {
    Request::builder()
        .method(method)
        .uri(format!("/v1.41{path}"))
        .header("host", "localhost")
        .header("connection", "close")
}

async fn response(
    socket: impl AsyncRead + AsyncWrite + Unpin + Send + 'static,
    request: Request<UnsyncBoxBody<Bytes, io::Error>>,
) -> Result<(Response<Incoming>, JoinSet<Result<(), hyper::Error>>)> {
    let (mut requests, connection) = http1::handshake(TokioIo::new(socket)).await?;
    let mut owned = JoinSet::new();
    owned.spawn(connection);
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
