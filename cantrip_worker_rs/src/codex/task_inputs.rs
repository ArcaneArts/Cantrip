//! Canonical server ownership of Task inputs is separate from local capacity.
use crate::{
    config::Config,
    encryption::Service,
    http::checked,
    metadata::{Guard, Signal},
};
use anyhow::{Result, bail};
use cantrip_wire::{JsString, Value, parse_json_text, value::json};
use std::sync::{Arc, Mutex};

#[derive(Clone)]
pub(crate) struct Client {
    config: Arc<Mutex<Config>>,
    encryption: Arc<Service>,
    worker_generation: String,
    http: reqwest::Client,
}

impl Client {
    pub(crate) fn new(
        config: Arc<Mutex<Config>>,
        encryption: Arc<Service>,
        worker_generation: String,
    ) -> Result<Self> {
        let http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .timeout(std::time::Duration::from_secs(15))
            .build()?;
        Ok(Self {
            config,
            encryption,
            worker_generation,
            http,
        })
    }

    pub(crate) async fn authorize(
        &self,
        owner: &JsString,
        server: &JsString,
        receipt: &Value,
        phase: &str,
        native: Option<(Value, JsString)>,
        signal: Signal,
    ) -> Result<()> {
        let assert_owner = || {
            let (current_owner, bound_server) = self.encryption.bound_identity()?;
            if current_owner != *owner || bound_server.as_js_string() != Some(server) {
                bail!("The Task input worker binding changed.");
            }
            Ok(())
        };
        assert_owner()?;
        let (url, token, worker) = {
            let config = self.config.lock().unwrap();
            (
                url::Url::parse(&config.server_url)?
                    .join("/api/internal/native-commands/task-input-dispatch")?,
                config.token.clone(),
                config.worker_id.clone(),
            )
        };
        if receipt["workerId"].as_js_string() != Some(&worker) {
            bail!("The Task receipt belongs to another worker.");
        }
        let mut input = json!({
            "serverId": server, "workerId": worker, "workerGeneration": self.worker_generation,
            "phase": phase, "receipt": receipt,
        });
        if let Some((execution, generation)) = native {
            input["nativeExecution"] = execution;
            input["nativeRuntimeGeneration"] = json!(generation);
        }
        let input = checked("taskInferenceInputDispatchSchema", &input)?;
        let guard = Guard::metadata(Some(signal), None);
        let body = guard
            .run(async {
                let response = self
                    .http
                    .post(url)
                    .bearer_auth(token)
                    .header("content-type", "application/json")
                    .body(input.stringify())
                    .send()
                    .await?
                    .error_for_status()?;
                let bytes = response.bytes().await?;
                parse_json_text(&String::from_utf8_lossy(&bytes))
                    .map_err(|_| anyhow::anyhow!("Invalid Task input acknowledgment."))
            })
            .await?;
        let acknowledged = checked("taskInferenceInputDispatchResultSchema", &body)?;
        if acknowledged["receipt"].stringify() != input["receipt"].stringify()
            || acknowledged.get("nativeExecution") != input.get("nativeExecution")
            || acknowledged.get("nativeRuntimeGeneration") != input.get("nativeRuntimeGeneration")
        {
            bail!("Core acknowledged a different Task input or execution.");
        }
        assert_owner()
    }
}
