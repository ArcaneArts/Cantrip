//! Authenticated history transport. No native input or execution authority.
mod pages;
use crate::{
    http::checked,
    metadata::{Guard, Signal},
};
use anyhow::{Result, bail};
use cantrip_history::projection::BatchRejected;
use cantrip_transport::lifecycle::owned;
use cantrip_wire::{JsString, Value, parse_json_text};
use futures::future::BoxFuture;
use std::sync::Arc;

pub struct Options {
    pub server_url: String,
    pub worker_id: JsString,
    pub token: Arc<dyn Fn() -> Result<String> + Send + Sync>,
    /// Lifetime of idempotent metadata publication, separate from a turn/input.
    pub metadata_signal: Option<Arc<dyn Fn() -> Option<Signal> + Send + Sync>>,
}
/// Public methods start owned work immediately. Abandoning the returned response
/// does not cancel accepted work; explicit signals and the metadata deadline do.
#[derive(Clone)]
pub struct Client {
    options: Arc<Options>,
    http: reqwest::Client,
}
#[derive(Debug)]
pub struct ServerRequestError {
    pub status: u16,
    pub code: Option<JsString>,
    action: &'static str,
}
impl std::fmt::Display for ServerRequestError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "Native history {} failed with HTTP {}.",
            self.action, self.status
        )
    }
}
impl std::error::Error for ServerRequestError {}
#[derive(Debug)]
struct FetchFailed;
impl std::fmt::Display for FetchFailed {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("fetch failed")
    }
}
impl std::error::Error for FetchFailed {}
fn retryable(error: &anyhow::Error) -> bool {
    error
        .downcast_ref::<ServerRequestError>()
        .is_some_and(|error| error.status >= 500 || matches!(error.status, 408 | 429))
        || error.is::<FetchFailed>()
}
fn request(schema: &str, input: &Value, worker: &JsString) -> Result<Value> {
    // Object spread preserves existing workerId position while overriding it.
    let mut body = match input {
        Value::Object(_) => input.clone(),
        Value::Array(values) => Value::object(
            values
                .iter()
                .enumerate()
                .map(|(n, value)| (n.to_string(), value.clone())),
        ),
        Value::String(value) => Value::object(
            value
                .units()
                .iter()
                .enumerate()
                .map(|(n, unit)| (n.to_string(), Value::String(JsString::new(vec![*unit])))),
        ),
        _ => Value::object([] as [(&str, Value); 0]),
    };
    body["workerId"] = Value::String(worker.clone());
    checked(schema, &body)
}
fn parse_body(body: &JsString) -> Result<Value> {
    let text = match body.as_str() {
        Some(text) => text.to_owned(),
        None => char::decode_utf16(body.units().iter().copied())
            .map(|scalar| match scalar {
                Ok(scalar) => scalar.to_string(),
                Err(error) => format!("\\u{:04x}", error.unpaired_surrogate()),
            })
            .collect(),
    };
    parse_json_text(&text).map_err(|error| anyhow::anyhow!("{}", error.lossy()))
}
impl Client {
    pub fn new(options: Options) -> Result<Self> {
        Ok(Self {
            options: Arc::new(options),
            http: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .gzip(true)
                .deflate(true)
                .brotli(true)
                .build()?,
        })
    }
    async fn post(
        &self,
        action: &'static str,
        body: &Value,
        schema: &'static str,
        guard: &Guard,
    ) -> Result<Value> {
        let url = url::Url::parse(&self.options.server_url)?
            .join(&format!("/api/internal/native-history/{action}"))?;
        let token = (self.options.token)()?;
        let authorization = reqwest::header::HeaderValue::from_str(&format!("Bearer {token}"))?;
        let request = self
            .http
            .post(url)
            .header(reqwest::header::AUTHORIZATION, authorization)
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(body.stringify())
            .build()?;
        let response = guard
            .run(async {
                self.http
                    .execute(request)
                    .await
                    .map_err(|_| FetchFailed.into())
            })
            .await?;
        let status = response.status();
        if matches!(status.as_u16(), 301 | 302 | 303 | 307 | 308)
            && response.headers().contains_key(reqwest::header::LOCATION)
        {
            return Err(FetchFailed.into());
        }
        // response.json().catch(() => null): malformed/unreadable bodies never
        // leak into error messages, and a successful malformed response is invalid.
        let payload = guard
            .run(async { Ok(response.bytes().await?) })
            .await
            .ok()
            .and_then(|bytes| {
                let text = String::from_utf8_lossy(&bytes);
                parse_json_text(text.strip_prefix('\u{feff}').unwrap_or(&text)).ok()
            })
            .unwrap_or(Value::Null);
        if !status.is_success() {
            let code = &payload["code"];
            if action == "ingest"
                && status.as_u16() == 409
                && let Some(rejection) = payload.get("rejection")
            {
                return Err(BatchRejected::verified(rejection, body, code)?.into());
            }
            return Err(ServerRequestError {
                status: status.as_u16(),
                code: code.as_js_string().cloned(),
                action,
            }
            .into());
        }
        checked(schema, &payload)
    }
    async fn metadata(
        &self,
        action: &'static str,
        body: &Value,
        schema: &'static str,
        caller: Option<Signal>,
    ) -> Result<Value> {
        let guard = Guard::metadata(
            caller,
            self.options
                .metadata_signal
                .as_ref()
                .and_then(|signal| signal()),
        );
        let mut backoff = 250;
        loop {
            guard.check()?;
            match self.post(action, body, schema, &guard).await {
                Ok(value) => return Ok(value),
                Err(error) => {
                    guard.check()?;
                    if !retryable(&error) {
                        return Err(error);
                    }
                    guard.delay(backoff).await?;
                    backoff = (backoff * 2).min(2000);
                }
            }
        }
    }
    pub fn open(&self, input: &Value, signal: Option<Signal>) -> BoxFuture<'static, Result<Value>> {
        let (this, input) = (self.clone(), input.clone());
        owned(async move {
            let request = request(
                "nativeHistoryBindingOpenSchema",
                &input,
                &this.options.worker_id,
            )?;
            let result = this
                .metadata(
                    "open",
                    &request,
                    "nativeHistoryBindingOpenResultSchema",
                    signal,
                )
                .await?;
            let binding = &result["binding"];
            if ["workerId", "chatId", "threadId"]
                .iter()
                .any(|key| binding[key] != request[key])
                || (request["provenance"]["kind"] == "binding"
                    && binding["id"] != request["provenance"]["bindingId"])
            {
                bail!("Native history returned an unrelated binding.");
            }
            Ok(binding.clone())
        })
    }
    pub fn resolve(
        &self,
        input: &Value,
        signal: Option<Signal>,
    ) -> BoxFuture<'static, Result<Value>> {
        let (this, input) = (self.clone(), input.clone());
        owned(async move {
            let request = request(
                "nativeHistoryResolveSchema",
                &input,
                &this.options.worker_id,
            )?;
            let result = this
                .metadata(
                    "resolve",
                    &request,
                    "nativeHistoryResolveResultSchema",
                    signal,
                )
                .await?;
            let items = result["items"].as_array().unwrap();
            let expected = request["items"].as_array().unwrap();
            if items.len() != expected.len()
                || items.iter().zip(expected).any(|(item, expected)| {
                    ["threadId", "turnId", "itemId", "component", "identityKind"]
                        .iter()
                        .any(|key| item["identity"][key] != expected["identity"][key])
                        || item["attachments"].as_array().is_some_and(|values| {
                            values.iter().any(|v| v["chatId"] != request["chatId"])
                        })
                        || (!item["preservedInput"].is_null()
                            && (item["preservedInput"]["id"] != item["messageId"]
                                || item["preservedInput"]["idempotencyKey"]
                                    != item["idempotencyKey"]))
                })
            {
                bail!("Native history returned unrelated item mappings.");
            }
            Ok(result["items"].clone())
        })
    }
    pub fn ingest(
        &self,
        input: &Value,
        signal: Option<Signal>,
    ) -> BoxFuture<'static, Result<Value>> {
        let (this, input) = (self.clone(), input.clone());
        owned(async move {
            let request = request("nativeHistoryIngestSchema", &input, &this.options.worker_id)?;
            let receipt = this
                .post(
                    "ingest",
                    &request,
                    "nativeHistoryCommitReceiptSchema",
                    &Guard::request(signal),
                )
                .await?;
            if ["streamId", "sequence", "recordId", "digest"]
                .iter()
                .any(|key| receipt[key] != request[key])
            {
                bail!("Native history returned an unrelated commit receipt.");
            }
            Ok(receipt)
        })
    }
    pub fn deliver(
        &self,
        scope: &Value,
        record: &Value,
        body: &JsString,
        signal: Option<Signal>,
    ) -> BoxFuture<'static, Result<Value>> {
        let (this, mut input, record, body) =
            (self.clone(), scope.clone(), record.clone(), body.clone());
        owned(async move {
            for key in [
                "streamId",
                "sequence",
                "recordId",
                "digest",
                "previousDigest",
            ] {
                input[key] = record[key].clone();
            }
            input["batch"] = checked("nativeHistoryPreparedBatchSchema", &parse_body(&body)?)?;
            this.ingest(&input, signal).await
        })
    }
}
