//! Runtime route selection shared by consoles and later execution consumers.
use super::eligibility;
use crate::{
    database::Database,
    operations::logging::{self, LogCall, Logger},
    settings::{catalog_runtime::CatalogRuntime, reasoning, repository::SettingsRepository},
    wire::{JsString, Value, coercion::truthy, value::json},
    workers::{bridge::WorkerBridge, repository::WorkerRepository},
};
use anyhow::{Context, Result, bail};
use futures::future::BoxFuture;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

pub type Connected = Arc<dyn Fn(&str) -> bool + Send + Sync>;
pub type Hydrate =
    Arc<dyn Fn(String, Vec<Value>) -> BoxFuture<'static, Result<bool>> + Send + Sync>;
pub type Clock = Arc<dyn Fn() -> f64 + Send + Sync>;

#[derive(Debug)]
pub struct ModelSelectionRequired;
impl std::fmt::Display for ModelSelectionRequired {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Choose a model or configure a default model in Settings.")
    }
}
impl std::error::Error for ModelSelectionRequired {}

pub struct ModelRouting {
    database: Arc<Database>,
    connected: Connected,
    hydrate: Hydrate,
    clock: Clock,
    cooldowns: Mutex<HashMap<JsString, f64>>,
    logger: Logger,
}
fn wire(values: Vec<serde_json::Value>) -> Vec<Value> {
    values.iter().map(Value::from_serialize).collect()
}
fn text<'a>(value: &'a Value, key: &str) -> Result<std::borrow::Cow<'a, str>> {
    Ok(value[key]
        .as_js_string()
        .context("Runtime routing text")?
        .lossy())
}
fn failure(code: &str, message: String, field: &str, retryable: bool) -> anyhow::Error {
    reasoning::ConfigurationFailure(
        json!({"code":code,"error":message,"field":field,"retryable":retryable}),
    )
    .into()
}
pub fn cooldown_key(runtime: &Value) -> JsString {
    let mut units = runtime["routeId"]
        .as_js_string()
        .expect("Runtime route")
        .units()
        .to_vec();
    if eligibility::account_provider(&runtime["provider"]["kind"])
        && truthy(runtime["provider"].get("accountId"))
    {
        units.extend(":account:".encode_utf16());
        units.extend_from_slice(
            runtime["provider"]["accountId"]
                .as_js_string()
                .expect("Runtime account")
                .units(),
        );
    }
    JsString::new(units)
}
impl ModelRouting {
    pub fn new(
        database: Arc<Database>,
        catalogs: Arc<CatalogRuntime>,
        bridge: Arc<WorkerBridge>,
    ) -> Arc<Self> {
        Self::with_dependencies(
            database,
            Arc::new(move |worker| bridge.is_connected(worker)),
            Arc::new(move |owner, runtimes| {
                let catalogs = catalogs.clone();
                Box::pin(async move {
                    catalogs
                        .hydrate(&owner, &runtimes)
                        .await
                        .map_err(|error| anyhow::anyhow!(error.to_string()))
                })
            }),
            Arc::new(|| crate::auth::now().timestamp_millis() as f64),
        )
    }
    pub fn with_dependencies(
        database: Arc<Database>,
        connected: Connected,
        hydrate: Hydrate,
        clock: Clock,
    ) -> Arc<Self> {
        Self::with_logger(
            database,
            connected,
            hydrate,
            clock,
            logging::server_logger(),
        )
    }
    pub fn with_logger(
        database: Arc<Database>,
        connected: Connected,
        hydrate: Hydrate,
        clock: Clock,
        logger: Logger,
    ) -> Arc<Self> {
        Arc::new(Self {
            database,
            connected,
            hydrate,
            clock,
            cooldowns: Mutex::new(HashMap::new()),
            logger,
        })
    }
    pub fn set_cooldown(&self, runtime: &Value, until: Option<f64>) {
        self.set_cooldown_key(cooldown_key(runtime), until);
    }
    pub fn set_cooldown_key(&self, key: JsString, until: Option<f64>) {
        let mut cooldowns = self.cooldowns.lock().unwrap();
        if let Some(until) = until {
            cooldowns.insert(key, until);
        } else {
            cooldowns.remove(&key);
        }
    }
    fn cooling(&self, runtime: &Value, now: f64) -> bool {
        self.cooldowns
            .lock()
            .unwrap()
            .get(&cooldown_key(runtime))
            .copied()
            .unwrap_or(0.0)
            > now
    }
    pub async fn resolve_model_id(
        &self,
        owner: &str,
        context: &Value,
        requested: Option<&Value>,
    ) -> Result<Value> {
        let default = if truthy(context.get("modelId")) {
            Value::Null
        } else {
            let settings = SettingsRepository::new(self.database.clone())
                .get_user_settings(owner)
                .await?;
            Value::from_serialize(&settings["defaultModelId"])
        };
        let selected = requested
            .filter(|v| !v.is_null())
            .or_else(|| context.get("modelId").filter(|v| !v.is_null()))
            .unwrap_or(&default);
        if !truthy(Some(selected)) {
            return Err(ModelSelectionRequired.into());
        }
        Ok(selected.clone())
    }
    pub async fn available_runtimes(
        &self,
        owner: &str,
        context: &Value,
        model: &str,
    ) -> Result<Vec<Value>> {
        let repository = SettingsRepository::new(self.database.clone());
        let mut runtimes = wire(
            repository
                .get_model_runtimes(owner, Some(model), None, false, None)
                .await?,
        );
        if (self.hydrate)(owner.to_owned(), runtimes.clone()).await? {
            runtimes = wire(
                repository
                    .get_model_runtimes(owner, Some(model), None, false, None)
                    .await?,
            );
        }
        if runtimes.is_empty() {
            bail!("The selected model has no enabled provider routes.");
        }
        let now = (self.clock)();
        let configured = runtimes.len();
        let worker = text(context, "workerId")?;
        let (mut available, mut unavailable) = (Vec::new(), Vec::new());
        for runtime in runtimes {
            let provider = &runtime["provider"];
            let name = text(provider, "name")?;
            if !eligibility::account_provider(&provider["kind"]) {
                let catalog = if truthy(runtime["model"].get("providerModelId")) {
                    wire(
                        repository
                            .list_provider_model_availability(
                                owner,
                                &text(provider, "id")?,
                                &text(&runtime["model"], "providerModelId")?,
                            )
                            .await?,
                    )
                } else {
                    Vec::new()
                };
                let eligibility = eligibility::route_availability(&runtime, &catalog, &worker);
                if eligibility["available"] != true {
                    unavailable.push(format!(
                        "{name}: {}",
                        eligibility["reason"]
                            .as_str()
                            .unwrap_or("model unavailable")
                    ));
                } else if self.cooling(&runtime, now) {
                    unavailable.push(format!("{name} is cooling down"));
                } else {
                    available.push(runtime);
                }
            } else {
                let accounts = wire(
                    repository
                        .list_provider_account_runtimes(
                            owner,
                            &text(provider, "id")?,
                            &worker,
                            runtime["model"]["providerModelId"].as_str(),
                        )
                        .await?,
                );
                let (selected, diagnostic) = eligibility::account_routes_logged(
                    &runtime,
                    &accounts,
                    context.get("providerAccountId"),
                    &context["workerId"],
                );
                if let Some(diagnostic) = diagnostic {
                    (self.logger)(diagnostic);
                }
                unavailable.extend(
                    selected["unavailable"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|value| value.as_js_string().unwrap().lossy().into_owned()),
                );
                for candidate in selected["runtimes"].as_array().unwrap() {
                    if self.cooling(candidate, now)
                        && !(candidate["provider"]["kind"] == "chatgpt"
                            && eligibility::use_chatgpt_credits(&candidate["provider"]["credits"]))
                    {
                        unavailable.push(format!("{name} account is cooling down"));
                    } else {
                        available.push(candidate.clone());
                    }
                }
            }
        }
        if available.is_empty() {
            let automatic = json!("automatic");
            let account = context
                .get("providerAccountId")
                .filter(|v| !v.is_null())
                .unwrap_or(&automatic);
            (self.logger)(LogCall::repeated(
                logging::key(
                    "provider-routing-unavailable:",
                    &[&context["workerId"], account],
                ),
                "warn",
                "No provider route is currently available",
                json!({"event":"provider.routing.unavailable","subsystem":"provider-routing","operation":"resolve-routes","reasonCode":"no-eligible-routes","status":"unavailable","workerId":context["workerId"],"counts":json!({"configuredRoutes":configured,"unavailableRoutes":unavailable.len()})}),
                Some(json!({"summaryEvery":10,"windowMs":60_000})),
            ));
            bail!(
                "No provider route is currently available{}",
                if unavailable.is_empty() {
                    ".".to_owned()
                } else {
                    format!(": {}", unavailable.join("; "))
                }
            );
        }
        (self.logger)(LogCall::sampled(
            logging::key("provider-routing-resolved:", &[&context["workerId"]]),
            20,
            "debug",
            "Provider routes resolved",
            json!({"event":"provider.routing.resolved","subsystem":"provider-routing","operation":"resolve-routes","status":"ready","workerId":context["workerId"],"counts":json!({"configuredRoutes":configured,"availableRoutes":available.len(),"unavailableRoutes":unavailable.len()})}),
        ));
        Ok(available)
    }
    pub async fn route_pairs(
        &self,
        owner: &str,
        context: &Value,
        configuration: &Value,
        roots: Option<&[Value]>,
    ) -> Result<Vec<Value>> {
        let worker = text(context, "workerId")?;
        if !(self.connected)(&worker) {
            return reasoning::resolve_pairs(configuration, &[], &[], Some(false));
        }
        if !truthy(configuration.get("modelId")) {
            return reasoning::resolve_pairs(configuration, &[], &[], None);
        }
        if truthy(configuration.get("customSubagentModel")) {
            let worker = WorkerRepository::new(self.database.clone())
                .get_worker(owner, &worker)
                .await?;
            let worker = worker.as_ref().map(Value::from_serialize);
            let capability = worker
                .as_ref()
                .map(|v| &v["codexRuntime"]["nativeSubagents"]);
            if !capability.is_some_and(|v| v["available"] == true && v["protocolVersion"] == 1) {
                let message = if let Some(v) = capability.filter(|v| {
                    v["available"] == true && v.get("protocolVersion") != Some(&Value::Null)
                }) {
                    let version = v
                        .get("protocolVersion")
                        .map(|v| {
                            crate::wire::coercion::string(v)
                                .unwrap()
                                .lossy()
                                .into_owned()
                        })
                        .unwrap_or_else(|| "undefined".into());
                    format!(
                        "The selected worker reports native subagent protocol {version}, but this server supports protocol 1."
                    )
                } else {
                    capability
                        .and_then(|v| v["reason"].as_js_string())
                        .map(|v| v.lossy().into_owned())
                        .unwrap_or_else(|| {
                            "The selected worker does not support native subagents.".into()
                        })
                };
                return Err(failure(
                    "worker-subagents-unavailable",
                    message,
                    "customSubagentModel",
                    false,
                ));
            }
        }
        let roots = match roots {
            Some(roots) => roots.to_vec(),
            None => self
                .available_runtimes(owner, context, &text(configuration, "modelId")?)
                .await
                .map_err(|cause| {
                    failure(
                        "root-model-unavailable",
                        crate::settings::operation_error_message(&cause)
                            .lossy()
                            .into_owned(),
                        "modelId",
                        true,
                    )
                })?,
        };
        let mut subagents = Vec::new();
        if truthy(configuration.get("customSubagentModel"))
            && truthy(configuration.get("subagentModelId"))
        {
            let mut context = context.clone();
            context["providerAccountId"] = Value::Null;
            subagents = self
                .available_runtimes(owner, &context, &text(configuration, "subagentModelId")?)
                .await
                .map_err(|cause| {
                    failure(
                        "subagent-model-unavailable",
                        crate::settings::operation_error_message(&cause)
                            .lossy()
                            .into_owned(),
                        "subagentModelId",
                        true,
                    )
                })?;
        }
        reasoning::resolve_pairs(configuration, &roots, &subagents, None)
    }
    pub async fn runtime_for_context(&self, owner: &str, context: &Value) -> Result<Option<Value>> {
        let repository = SettingsRepository::new(self.database.clone());
        let effort = &context["reasoningEffort"];
        if truthy(context.get("modelRouteId")) {
            let active = wire(
                repository
                    .get_model_runtimes(
                        owner,
                        None,
                        Some(&text(context, "modelRouteId")?),
                        true,
                        None,
                    )
                    .await?,
            )
            .into_iter()
            .next();
            if let Some(active) = active {
                let selected = self
                    .available_runtimes(owner, context, &text(&active["model"], "id")?)
                    .await?
                    .into_iter()
                    .find(|r| r["routeId"] == active["routeId"]);
                return selected
                    .map(|selected| {
                        Ok(reasoning::prepare(&[selected], effort)?[0]["runtime"].clone())
                    })
                    .transpose();
            }
        }
        let model = self.resolve_model_id(owner, context, None).await?;
        let runtimes = self
            .available_runtimes(
                owner,
                context,
                model
                    .as_js_string()
                    .context("Selected model ID")?
                    .lossy()
                    .as_ref(),
            )
            .await?;
        Ok(reasoning::prepare(&runtimes, effort)?
            .first()
            .map(|v| v["runtime"].clone()))
    }
}
