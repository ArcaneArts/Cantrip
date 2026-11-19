//! Bounded model discovery over the worker's own provider connections.
mod endpoint;
mod litellm;
mod normalize;
mod ollama;
mod snapshot;

use crate::{
    encryption::Service, logging::Logs, metadata::Signal, protected_secrets::open_runtime_provider,
};
use anyhow::{Result, anyhow, bail};
use cantrip_wire::{Value, parse_json_text, value::json};
use reqwest::{Client, redirect::Policy};
use std::{sync::Arc, time::Duration};
use url::Url;

pub(crate) fn handles(command: &str) -> bool {
    matches!(command, "model.endpoint.catalog" | "model.ollama.catalog")
}

const MAX_HTTP_BYTES: usize = 16 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES: usize = 32 * 1024 * 1024;
const MAX_MODELS: usize = 50_000;

pub(crate) struct Catalog {
    encryption: Arc<Service>,
    http: Client,
    logs: Arc<Logs>,
    snapshots: Arc<snapshot::Store>,
}

impl Catalog {
    pub(crate) fn new(encryption: Arc<Service>, logs: Arc<Logs>) -> Result<Self> {
        Ok(Self {
            encryption,
            logs,
            http: Client::builder()
                .redirect(Policy::none())
                .retry(reqwest::retry::never())
                .gzip(true)
                .deflate(true)
                .brotli(true)
                .timeout(Duration::from_secs(20))
                .build()?,
            snapshots: Arc::new(snapshot::Store::default()),
        })
    }

    pub(crate) async fn execute(&self, command: &Value, signal: Signal) -> Result<Value> {
        let scope = self.encryption.bound_identity()?;
        let provider = open_runtime_provider(&self.encryption, &command["provider"])?;
        if self.encryption.bound_identity()? != scope {
            bail!("The worker binding changed while opening the endpoint configuration.");
        }
        let key = cantrip_wire::payload_digest(&json!({
            "ownerId":scope.0,"serverId":scope.1,"workerId":self.encryption.worker_id(),
            "providerId":provider["id"],"kind":provider["kind"],"baseUrl":provider["baseUrl"],"apiKey":provider["apiKey"],
        }));
        let client = self.http.clone();
        let logs = self.logs.clone();
        let result = self
            .snapshots
            .read(
                key,
                command.get("catalogPage"),
                signal,
                move |signal| async move {
                    if provider["kind"] == "ollama" {
                        ollama::discover(&client, &provider, signal, &logs).await
                    } else {
                        endpoint::discover(&client, &provider, signal).await
                    }
                },
            )
            .await?;
        if self.encryption.bound_identity()? != scope {
            bail!("The worker binding changed during endpoint model discovery.");
        }
        Ok(result)
    }
}

async fn fetch_json(client: &Client, url: Url, key: &Value, body: Option<Value>) -> Result<Value> {
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        bail!("Invalid model catalog endpoint URL.");
    }
    let mut request = match body {
        Some(body) => client
            .post(url)
            .header("content-type", "application/json")
            .body(body.stringify()),
        None => client.get(url),
    }
    .header("accept", "application/json");
    if let Some(key) = key.as_js_string().filter(|key| !key.is_empty()) {
        request = request.bearer_auth(key.lossy());
    }
    let mut response = request.send().await.map_err(|error| {
        if error.is_timeout() {
            anyhow!("Model catalog request timed out.")
        } else {
            anyhow!("Model catalog request failed.")
        }
    })?;
    if !response.status().is_success() {
        bail!(
            "Model catalog request returned HTTP {}.",
            response.status().as_u16()
        );
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| anyhow!("Model catalog response could not be read."))?
    {
        if bytes.len() + chunk.len() > MAX_HTTP_BYTES {
            bail!("Model catalog response exceeded 16 MiB.");
        }
        bytes.extend_from_slice(&chunk);
    }
    parse_json_text(&String::from_utf8_lossy(&bytes))
        .map_err(|_| anyhow!("Model catalog response was not valid JSON."))
}
