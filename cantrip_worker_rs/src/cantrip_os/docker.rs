use crate::filesystem::Scope;
use anyhow::{Context, Result, anyhow, bail, ensure};
use bytes::Bytes;
use cantrip_wire::{Value, parse_json_text};
use http_body_util::{BodyExt, Empty, Limited};
use hyper::{Request, client::conn::http1};
use hyper_util::rt::TokioIo;
use percent_encoding::{NON_ALPHANUMERIC, utf8_percent_encode};
use std::{env, ffi::OsStr, time::Duration};
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

pub(super) struct LocalDocker(String);
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
        tokio::select! {
            biased;
            _ = scope.stopped() => bail!("CantripOS observation stopped."),
            result = timeout(Duration::from_secs(60), self.read_identity(container)) => result.context("Docker observation timed out.")?,
        }
    }

    async fn read_identity(&self, container: &str) -> Result<Identity> {
        #[cfg(unix)]
        let socket = tokio::net::UnixStream::connect(&self.0).await?;
        #[cfg(windows)]
        let socket = tokio::net::windows::named_pipe::ClientOptions::new().open(&self.0)?;
        let data = inspect(socket, container).await?;
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
}

async fn inspect(
    socket: impl AsyncRead + AsyncWrite + Unpin + Send + 'static,
    container: &str,
) -> Result<Value> {
    let (mut requests, connection) = http1::handshake(TokioIo::new(socket)).await?;
    let mut owned = JoinSet::new();
    owned.spawn(connection);
    let request = Request::get(format!(
        "/v1.41/containers/{}/json",
        utf8_percent_encode(container, NON_ALPHANUMERIC)
    ))
    .header("host", "localhost")
    .header("connection", "close")
    .body(Empty::<Bytes>::new())?;
    let response = requests.send_request(request).await?;
    ensure!(
        response.status().is_success(),
        "Docker container inspection failed ({}).",
        response.status()
    );
    let bytes = Limited::new(response.into_body(), 4 * 1024 * 1024)
        .collect()
        .await
        .map_err(|_| anyhow::anyhow!("Docker inspection response could not be read."))?
        .to_bytes();
    parse_json_text(std::str::from_utf8(&bytes)?)
        .map_err(|_| anyhow!("Docker returned an invalid inspection receipt."))
}
