//! Forward the legacy CLI wire request using the current worker credential.
use crate::{config::Config, http::checked};
use anyhow::{Context, Result, anyhow, ensure};
use cantrip_wire::{JsString, Value, parse_json_text, value::json};
use reqwest::{Client, StatusCode, Url, header};
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

const MAX_RESPONSE: usize = 8 * 1024 * 1024;

pub(super) struct Server {
    client: Client,
    endpoint: Url,
    worker: JsString,
    configuration: Arc<Mutex<Config>>,
}

#[derive(Debug)]
pub(super) struct Rejected {
    pub status: StatusCode,
    pub code: Option<JsString>,
    pub message: JsString,
}

impl std::fmt::Display for Rejected {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.message.fmt(formatter)
    }
}
impl std::error::Error for Rejected {}

impl Server {
    pub(super) fn new(
        server_url: &str,
        worker: JsString,
        configuration: Arc<Mutex<Config>>,
    ) -> Result<Self> {
        Ok(Self {
            client: Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(10))
                .build()?,
            endpoint: Url::parse(server_url)?.join("/api/internal/cli")?,
            worker,
            configuration,
        })
    }

    pub(super) async fn execute(&self, mut request: Value, id: &str) -> Result<Value> {
        request["chatContext"] = Value::Null;
        request["requestId"] = json!(id);
        request["workerId"] = json!(self.worker);
        let mut call = checked("workerCliCommandCallSchema", &request)?;
        if call["context"]["selection"] == "auto" {
            let context = &call["context"];
            call["context"] = json!({
                "codexThreadId":context["codexThreadId"],"terminalId":context["terminalId"],"cwd":context["cwd"],
            });
        }
        let token = self.configuration.lock().unwrap().token.clone();
        let mut response = self
            .client
            .post(self.endpoint.clone())
            .bearer_auth(token)
            .header(header::CONTENT_TYPE, "application/json")
            .body(call.stringify())
            .send()
            .await
            .map_err(|_| anyhow!("Cantrip CLI server request failed."))?;
        ensure!(
            response
                .content_length()
                .is_none_or(|size| size <= MAX_RESPONSE as u64),
            "Cantrip CLI server response is too large."
        );
        let status = response.status();
        let mut raw = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| anyhow!("Cantrip CLI server response could not be read."))?
        {
            ensure!(
                chunk.len() <= MAX_RESPONSE - raw.len(),
                "Cantrip CLI server response is too large."
            );
            raw.extend(chunk);
        }
        let text = String::from_utf8_lossy(&raw);
        let payload = parse_json_text(text.strip_prefix('\u{feff}').unwrap_or(&text))
            .ok()
            .context("Cantrip CLI server returned invalid JSON.")?;
        if !status.is_success() {
            return Err(Rejected {
                status,
                code: payload["code"].as_js_string().cloned(),
                message: payload["error"].as_js_string().cloned().unwrap_or_else(|| {
                    format!("Cantrip CLI command failed with HTTP {}.", status.as_u16()).into()
                }),
            }
            .into());
        }
        checked("cantripCliCommandResultSchema", &payload)
    }
}
