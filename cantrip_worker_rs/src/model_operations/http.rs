use super::{Failure, MAX_BYTES, error};
use anyhow::Result;
use cantrip_crypto::Zeroizing;
use cantrip_wire::{JsString, Value, parse_json_text};
use reqwest::{Client, redirect::Policy};
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
    operation: &str,
) -> Result<Value> {
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(error(
            "provider-error",
            format!("The {operation} provider request failed."),
        ));
    }
    let mut request = client
        .post(url)
        .header("content-type", "application/json")
        .header("accept", "application/json")
        .body(body.to_owned());
    if let Some(key) = key.filter(|key| !key.is_empty()) {
        request = request.bearer_auth(key.lossy());
    }
    let mut response = request.send().await.map_err(|_| {
        error(
            "provider-error",
            format!("The {operation} provider request failed."),
        )
    })?;
    let status = response.status().as_u16();
    if matches!(status, 301 | 302 | 303 | 307 | 308) {
        return Err(error(
            "provider-error",
            format!("The {operation} provider request failed."),
        ));
    }
    if !response.status().is_success() {
        return Err(Failure {
            code: "provider-error",
            message: format!("The {operation} provider returned HTTP {status}."),
            status: Some(status),
        }
        .into());
    }
    let invalid = || {
        error(
            "invalid-response",
            format!("The provider returned malformed {operation} data."),
        )
    };
    let mut bytes = Zeroizing::new(Vec::new());
    while let Some(chunk) = response.chunk().await.map_err(|_| invalid())? {
        if bytes.len() + chunk.len() > MAX_BYTES {
            return Err(error(
                "invalid-response",
                format!("The {operation} response exceeded 4 MiB."),
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    parse_json_text(&String::from_utf8_lossy(&bytes)).map_err(|_| invalid())
}
