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

    pub(in crate::codex) fn generation(&self) -> &str {
        &self.worker_generation
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
        let worker = self.config.lock().unwrap().worker_id.clone();
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
        let body = self
            .post(owner, server, "task-input-dispatch", &input, signal)
            .await?;
        let acknowledged = checked("taskInferenceInputDispatchResultSchema", &body)?;
        if acknowledged["receipt"].stringify() != input["receipt"].stringify()
            || acknowledged.get("nativeExecution") != input.get("nativeExecution")
            || acknowledged.get("nativeRuntimeGeneration") != input.get("nativeRuntimeGeneration")
        {
            bail!("Core acknowledged a different Task input or execution.");
        }
        Ok(())
    }

    pub(crate) async fn authorize_goal_cycle(
        &self,
        owner: &JsString,
        server: &JsString,
        parent: &Value,
        mut input: Value,
        signal: Signal,
    ) -> Result<Value> {
        let worker = self.config.lock().unwrap().worker_id.clone();
        if parent["workerId"].as_js_string() != Some(&worker) {
            bail!("The Task Goal parent belongs to another worker.");
        }
        input["workerId"] = json!(worker);
        input["workerGeneration"] = json!(self.worker_generation);
        input["serverId"] = json!(server);
        let input = checked("taskGoalCycleDispatchSchema", &input)?;
        let body = self
            .post(owner, server, "task-goal-cycle-dispatch", &input, signal)
            .await?;
        let receipt = checked("taskGoalCycleDispatchResultSchema", &body)?;
        let source = &receipt["suspensionSource"];
        if source["parent"] != *parent
            || source["runtimeGeneration"] != input["nativeRuntimeGeneration"]
            || [
                "sourceKey",
                "workerGeneration",
                "threadId",
                "turnId",
                "operationId",
                "cycle",
            ]
            .into_iter()
            .any(|key| source[key] != input[key])
        {
            bail!("Core acknowledged a different autonomous Task Goal execution.");
        }
        Ok(source.clone())
    }

    pub(in crate::codex) async fn reconcile_inference(
        &self,
        owner: &JsString,
        server: &JsString,
        record: &Value,
        challenge: Option<&Value>,
        signal: Signal,
    ) -> Result<Value> {
        let worker = self.config.lock().unwrap().worker_id.clone();
        let mut input = json!({
            "serverId":server,"workerId":worker,"workerGeneration":self.worker_generation,
            "record":record,
        });
        if let Some(challenge) = challenge {
            input["expectedGoalAdmission"] = challenge.clone();
        }
        let input = checked("nativeInferenceRecoverySchema", &input)?;
        let result = self
            .post(owner, server, "inference-recovery", &input, signal)
            .await?;
        checked("nativeInferenceRecoveryResultSchema", &result)
    }

    pub(in crate::codex) async fn authorize_resource(
        &self,
        scope: &(JsString, Value),
        target: &Value,
        signal: Signal,
    ) -> Result<()> {
        let (owner, server) = scope;
        let server = server
            .as_js_string()
            .ok_or_else(|| anyhow::anyhow!("Unverified worker server identity"))?;
        let worker = self.config.lock().unwrap().worker_id.clone();
        let input = checked(
            "nativeInferenceResourceAuthorizationSchema",
            &json!({
                "serverId":server,"ownerId":owner,"workerId":worker,
                "workerGeneration":self.worker_generation,"target":target,
            }),
        )?;
        let result = self
            .post(
                owner,
                server,
                "inference-resource-authorize",
                &input,
                signal.clone(),
            )
            .await?;
        let result = checked("nativeInferenceResourceAuthorizationResultSchema", &result)?;
        for field in [
            "serverId",
            "ownerId",
            "workerId",
            "workerGeneration",
            "target",
        ] {
            if result[field] != input[field] {
                bail!("Core authorized another inference resource or worker scope.");
            }
        }
        signal.check()
    }

    async fn post(
        &self,
        owner: &JsString,
        server: &JsString,
        operation: &str,
        input: &Value,
        signal: Signal,
    ) -> Result<Value> {
        let assert_owner = || {
            let (current_owner, bound_server) = self.encryption.bound_identity()?;
            if current_owner != *owner || bound_server.as_js_string() != Some(server) {
                bail!("The native command worker binding changed.");
            }
            Ok(())
        };
        assert_owner()?;
        let (url, token) = {
            let config = self.config.lock().unwrap();
            (
                url::Url::parse(&config.server_url)?
                    .join(&format!("/api/internal/native-commands/{operation}"))?,
                config.token.clone(),
            )
        };
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
                    .map_err(|_| anyhow::anyhow!("Invalid native command acknowledgment."))
            })
            .await?;
        assert_owner()?;
        Ok(body)
    }
}
