use super::{catalog::CatalogUpdate, repository::SettingsRepository};
use crate::{
    auth::now,
    wire::{self, JsString, Value},
    workers::{command_bus::LimitedCommandBus, repository::WorkerRepository},
};
use anyhow::{Context, Result};
use futures::FutureExt;
use serde_json::{Value as Json, json};
use std::{collections::HashSet, sync::Arc};

fn positive_integer(value: &Value) -> Option<f64> {
    value
        .as_f64()
        .filter(|number| number.is_finite() && *number > 0.0)
        .map(super::round_nonnegative)
        .filter(|number| *number != 0.0)
}
fn context_window(model: &Value) -> Value {
    let info = model["modelInfo"]
        .as_object()
        .expect("validated Ollama model info");
    if let Some(architecture) = info
        .get(&JsString::from("general.architecture"))
        .and_then(Value::as_js_string)
        .filter(|value| !value.is_empty())
    {
        let mut key = architecture.units().to_vec();
        key.extend(".context_length".encode_utf16());
        if let Some(number) = info.get(&JsString::new(key)).and_then(positive_integer) {
            return Value::Number(number);
        }
    }
    let suffix: Vec<_> = ".context_length".encode_utf16().collect();
    for (key, value) in info {
        let units = key.units();
        if units.len() > suffix.len()
            && units.ends_with(&suffix)
            && !units[..units.len() - suffix.len()].contains(&u16::from(b'.'))
            && let Some(number) = positive_integer(value)
        {
            return Value::Number(number);
        }
    }
    Value::Null
}
pub fn normalize_model(model: &Value) -> Value {
    let capabilities: HashSet<_> = model["capabilities"]
        .as_array()
        .expect("validated Ollama capabilities")
        .iter()
        .map(|value| {
            value
                .as_js_string()
                .expect("validated capability")
                .lowercase()
        })
        .collect();
    let has = |name: &str| capabilities.contains(&JsString::from(name));
    let mut modalities = Vec::new();
    if has("completion") {
        modalities.push("text");
    }
    if has("embedding") {
        modalities.push("embeddings");
    }
    if has("decision") {
        modalities.push("decisions");
    }
    let status = |cap: &str| if has(cap) { "supported" } else { "unsupported" };
    let operation_capabilities = if modalities.is_empty() {
        json!({})
    } else {
        json!({
            "language": {"status":status("completion"),"source":"ollama","inputModalities":if has("vision") {json!(["text","image"])} else {json!(["text"])}},
            "embedding": {"status":status("embedding"),"source":"ollama","adapter":"ollama-embed","inputModalities":["text"],"modelRevision":model["digest"]},
            "decision": {"status":status("decision"),"source":"ollama","adapter":"system-one","inputModalities":if has("vision") {json!(["text","image","json"])} else {json!(["text","json"])},"questionTypes":["predicate","choice","score"]}
        })
    };
    let mut output = Value::object([
        (
            "operationCapabilities",
            Value::from_serialize(&operation_capabilities),
        ),
        ("nativeModelId", model["name"].clone()),
        ("canonicalModelId", Value::Null),
        ("displayName", model["name"].clone()),
        ("description", Value::Null),
        ("contextWindow", context_window(model)),
        ("maxOutputTokens", Value::Null),
        (
            "inputModalities",
            Value::from_serialize(&if has("vision") {
                json!(["text", "image"])
            } else {
                json!(["text"])
            }),
        ),
        ("outputModalities", Value::from_serialize(&modalities)),
        ("supportsTools", Value::Bool(has("tools"))),
        (
            "supportsParallelTools",
            if has("tools") {
                Value::Null
            } else {
                Value::Bool(false)
            },
        ),
        (
            "supportsStructuredOutput",
            if has("completion") {
                Value::Bool(true)
            } else {
                Value::Null
            },
        ),
        ("supportsVision", Value::Bool(has("vision"))),
        ("supportsReasoning", Value::Bool(has("thinking"))),
        ("supportedReasoningEfforts", Value::Array(vec![])),
        ("defaultReasoningEffort", Value::Null),
        ("reasoningMandatory", Value::Null),
        ("family", model["family"].clone()),
        ("parameterSize", model["parameterSize"].clone()),
        ("quantization", model["quantization"].clone()),
        ("digest", model["digest"].clone()),
        ("metadataSource", Value::String("ollama".into())),
        ("matchConfidenceBasisPoints", Value::Null),
    ]);
    output["rawMetadata"] = Value::object(
        [
            "capabilities",
            "families",
            "modelInfo",
            "modifiedAt",
            "sizeBytes",
        ]
        .map(|key| (key, model[key].clone())),
    );
    output
}
impl SettingsRepository {
    pub async fn get_ollama_provider_catalog(
        &self,
        owner: &str,
        provider: &str,
        worker: &str,
        force: bool,
        commands: &Arc<LimitedCommandBus>,
    ) -> Result<Option<Json>> {
        self.get_ollama_provider_catalog_for_key(owner, provider, worker, force, commands, true)
            .boxed()
            .await
    }
    pub(super) async fn get_ollama_provider_catalog_for_key(
        &self,
        owner: &str,
        provider: &str,
        worker: &str,
        force: bool,
        commands: &Arc<LimitedCommandBus>,
        worker_key_is_string: bool,
    ) -> Result<Option<Json>> {
        let worker_repository = WorkerRepository::new(self.database.clone());
        let (runtime, owned_worker) = tokio::try_join!(
            self.get_provider_catalog_runtime(owner, provider),
            worker_repository.get_worker(owner, worker)
        )?;
        let Some(runtime) = runtime else {
            return Ok(None);
        };
        anyhow::ensure!(owned_worker.is_some(), "Worker not found.");
        anyhow::ensure!(
            super::endpoint_providers::worker_catalog_provider(&runtime),
            "Provider does not use worker endpoint discovery."
        );
        let revision = runtime["connectionRevision"]
            .as_i64()
            .context("catalog connection revision")?;
        let connection = json!({"ownerId":owner,"connectionRevision":revision});
        let scope = format!("worker:{worker}");
        let existing = self
            .get_provider_model_catalog(owner, provider, false)
            .await?;
        let sync = existing
            .as_ref()
            .and_then(|existing| existing["syncStates"].as_array())
            .and_then(|states| states.iter().find(|state| state["scopeKey"] == scope));
        if !force
            && sync.is_some_and(|state| {
                state["status"] == "current"
                    && state["lastSuccessAt"]
                        .as_str()
                        .and_then(|stamp| wire::date_milliseconds(&stamp.into()))
                        .is_some_and(|stamp| now().timestamp_millis() - stamp < 300_000)
            })
        {
            return Ok(existing);
        }
        let has_models = existing.as_ref().is_some_and(|existing| {
            existing["models"]
                .as_array()
                .is_some_and(|models| !models.is_empty())
        });
        if !worker_key_is_string || !commands.is_connected(worker) {
            if !self.set_provider_catalog_sync_state(provider, &json!({"connection":connection,"scopeKey":scope,"workerId":worker,"status":"stale","errorCode":"worker-offline"})).await? { return self.get_provider_model_catalog(owner, provider, false).await; }
            if has_models {
                return self.get_provider_model_catalog(owner, provider, true).await;
            }
            anyhow::bail!("Worker is offline.");
        }
        if !self.set_provider_catalog_sync_state(provider, &json!({"connection":connection,"scopeKey":scope,"workerId":worker,"status":"refreshing","errorCode":null,"refreshStartedAt":now()})).await? { return self.get_provider_model_catalog(owner, provider, false).await; }
        let refresh: Result<Option<Json>> = async {
            let mut runtime = Value::from_serialize(&runtime);
            let kind = runtime["kind"].as_str().context("stored provider kind")?.to_owned();
            let ollama = kind == "ollama";
            runtime["name"] = Value::String(super::endpoint_providers::label(&kind).into());
            runtime["accountId"] = Value::Null;
            runtime["credentialHomeKey"] = Value::Null;
            let models = super::worker_catalog_pages::read(commands,worker,runtime,ollama).boxed().await?;
            let available = models.iter().map(|model|model["nativeModelId"].as_js_string().expect("validated model ID").clone()).collect();
            let accepted = self.reconcile_provider_model_catalog(owner,provider,CatalogUpdate { connection_revision: Some(revision),
                models, available, availability_scope:scope.clone(), auto_create:true, auto_create_native_ids:None,
                worker_id:Some(worker.into()), account_id:None, default_native_id:None,
            }).boxed().await?;
            if !accepted { return self.get_provider_model_catalog(owner, provider, false).await; }
            self.set_provider_catalog_sync_state(provider, &json!({"connection":connection,"scopeKey":scope,"workerId":worker,"status":"current","errorCode":null,"lastSuccessAt":now()})).await?;
            self.get_provider_model_catalog(owner,provider,false).await
        }.boxed().await;
        match refresh {
            Ok(result) => Ok(result),
            Err(error) => {
                let accepted = self.set_provider_catalog_sync_state(provider,&json!({"connection":connection,"scopeKey":scope,"workerId":worker,"status":if has_models {"stale"} else {"failed"},"errorCode":if runtime["kind"]=="ollama" {"ollama-catalog-refresh-failed"} else {"endpoint-catalog-refresh-failed"}})).await?;
                if !accepted {
                    return self
                        .get_provider_model_catalog(owner, provider, false)
                        .await;
                }
                if has_models {
                    self.get_provider_model_catalog(owner, provider, true).await
                } else {
                    Err(error)
                }
            }
        }
    }
}
