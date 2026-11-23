use super::{Failure, MAX_BYTES, Operation, error};
use anyhow::{Context, Result};
use cantrip_crypto::Zeroizing;
use cantrip_wire::{JsString, Value, parse_json_text};
use reqwest::{Client, redirect::Policy};
use std::time::Duration;
use url::Url;

pub(super) fn client() -> Result<Client> {
    Ok(Client::builder()
        .redirect(Policy::none())
        .retry(reqwest::retry::never())
        .gzip(true)
        .deflate(true)
        .brotli(true)
        .build()?)
}

pub(super) async fn post(
    client: &Client,
    url: Url,
    body: &str,
    key: Option<&JsString>,
    operation: Operation,
    typesafe_images: bool,
) -> Result<Value> {
    let name = operation.name();
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(error(
            "provider-error",
            format!("The {name} provider request failed."),
        ));
    }
    let mut request = client
        .post(url)
        .header("content-type", "application/json")
        .header("accept", "application/json")
        .body(body.to_owned());
    if typesafe_images {
        request = request.header("TypeSafe-Danger-Zone-Images", "true");
    }
    if let Some(key) = key.filter(|key| !key.is_empty()) {
        request = request.bearer_auth(key.lossy());
    }
    let mut response = request.send().await.map_err(|_| {
        error(
            "provider-error",
            format!("The {name} provider request failed."),
        )
    })?;
    let status = response.status().as_u16();
    if matches!(status, 301 | 302 | 303 | 307 | 308) {
        return Err(error(
            "provider-error",
            format!("The {name} provider request failed."),
        ));
    }
    if !response.status().is_success() {
        return Err(Failure {
            code: "provider-error",
            message: format!("The {name} provider returned HTTP {status}."),
            status: Some(status),
        }
        .into());
    }
    let invalid = || operation.malformed();
    let mut bytes = Zeroizing::new(Vec::new());
    while let Some(chunk) = response.chunk().await.map_err(|_| invalid())? {
        if bytes.len() + chunk.len() > MAX_BYTES {
            return Err(error(
                "invalid-response",
                match operation {
                    Operation::Embedding => "The embedding response exceeded 4 MiB.",
                    Operation::Decision => "The decision response exceeds 4 MiB.",
                },
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    parse_json_text(&String::from_utf8_lossy(&bytes)).map_err(|_| invalid())
}

pub(super) fn timeout(options: &Value) -> Result<Duration> {
    let delay = u32::try_from(options["timeoutMs"].as_u64().unwrap_or(120_000))
        .context("The model operation timeout exceeds the supported timer range.")?;
    // Node timers use a 1 ms delay when an accepted u32 exceeds i32::MAX.
    Ok(Duration::from_millis(if i32::try_from(delay).is_ok() {
        u64::from(delay)
    } else {
        1
    }))
}
