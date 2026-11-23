//! Provider reads precede dispatch transactions; the admitted resolver reads only
//! this snapshot and rejects changed placement or model configuration fences.
use super::*;
use crate::workers::transport::WorkerTransport;
use crate::{
    chats::{
        Repository as Chats,
        routing::{Connected, ModelRouting},
        runtime_telemetry::RuntimeTelemetry,
        turn_runtime::stages::{Operations, TaskLaunchStageTimeout},
    },
    operations::logging::{self, LogCall, Logger},
    settings::reasoning::ConfigurationFailure,
    task_dispatch,
    workers::repository::WorkerRepository,
};
use futures::{FutureExt, future::BoxFuture};
pub const PREFLIGHT_TIMEOUT_MS: f64 = 30_000.0;

#[derive(Clone)]
struct Entry {
    physical_worker: Value,
    project: Value,
    worktree: Value,
    configuration: Value,
    fence: Value,
    resolution: Value,
    runtime: Option<Value>,
}
type Key = JsString;
fn unavailable() -> Value {
    json!({"eligible":false,"code":"placement-unavailable"})
}

#[derive(Clone)]
pub struct PreparedDispatch {
    entries: Arc<HashMap<Key, Entry>>,
}
impl PreparedDispatch {
    pub fn resolve(&self, input: &Value) -> Value {
        let entry = input["cycle"]["id"]
            .as_js_string()
            .cloned()
            .and_then(|key| self.entries.get(&key));
        match entry {
            Some(entry)
                if entry.project == input["projectId"]
                    && entry.physical_worker == input["physicalWorkerId"]
                    && entry.worktree == input["worktreeId"]
                    && entry.configuration == input["modelConfiguration"]
                    && entry.fence == input["cycle"]["fencingToken"] =>
            {
                entry.resolution.clone()
            }
            _ => unavailable(),
        }
    }
    pub fn resolver(&self) -> task_dispatch::Eligibility {
        let prepared = self.clone();
        Arc::new(move |input| futures::future::ready(Ok(prepared.resolve(&input))).boxed())
    }
    pub fn runtime_for_claim(&self, claim: &Value) -> Option<Value> {
        let cycle = &claim["cycle"];
        let runtime = self
            .entries
            .get(cycle["id"].as_js_string()?)?
            .runtime
            .as_ref()?;
        (runtime.get("routeId") == cycle.get("modelRouteId")
            && runtime["provider"].get("accountId") == cycle.get("providerAccountId"))
        .then(|| runtime.clone())
    }
}
pub struct Service {
    database: Arc<Database>,
    routing: Arc<ModelRouting>,
    connected: Connected,
    logger: Logger,
    timeout_ms: f64,
    operations: Arc<Operations>,
}
impl Service {
    pub fn new(
        database: Arc<Database>,
        routing: Arc<ModelRouting>,
        bridge: Arc<dyn WorkerTransport>,
    ) -> Arc<Self> {
        Self::with_dependencies(
            database,
            routing,
            Arc::new(move |worker| bridge.is_connected(worker)),
            logging::server_logger(),
            PREFLIGHT_TIMEOUT_MS,
        )
    }
    pub fn with_dependencies(
        database: Arc<Database>,
        routing: Arc<ModelRouting>,
        connected: Connected,
        logger: Logger,
        timeout_ms: f64,
    ) -> Arc<Self> {
        Arc::new(Self {
            database,
            routing,
            connected,
            logger,
            timeout_ms,
            operations: Arc::default(),
        })
    }
    pub fn prepare_dispatch(
        self: &Arc<Self>,
        owner: String,
    ) -> BoxFuture<'static, Result<PreparedDispatch>> {
        let service = self.clone();
        self.operations
            .run(async move { service.dispatch(&owner).await })
    }
    pub fn prepare_resume(
        self: &Arc<Self>,
        owner: String,
    ) -> BoxFuture<'static, Result<task_dispatch::Eligibility>> {
        let service = self.clone();
        self.operations
            .run(async move { service.resume(&owner).await })
    }
    pub async fn drained(&self) {
        self.operations.drained().await;
    }
    fn warn_timeout(&self, error: &anyhow::Error, cycle: &Value, context: &Value, resume: bool) {
        let Some(timeout) = error.downcast_ref::<TaskLaunchStageTimeout>() else {
            return;
        };
        let mut fields = json!({"event":if resume{"task.scheduler.resume-eligibility-timeout"}else{"task.scheduler.eligibility-timeout"},"subsystem":"task-scheduler","operation":if resume{"resolve-resume-eligibility"}else{"resolve-eligibility"},"status":"failed","reasonCode":"runtime-resolution-timeout","chatId":cycle["chatId"],"cycleId":cycle["id"],"workerId":context["workerId"],"durationMs":timeout.timeout_ms,"err":logging::error_details(error)});
        fields["err"]["name"] = json!("TaskLaunchStageTimeoutError");
        (self.logger)(LogCall::event(
            "warn",
            if resume {
                "Paused Task runtime eligibility resolution timed out"
            } else {
                "Task runtime eligibility resolution timed out"
            },
            fields,
        ));
    }
    async fn dispatch(&self, owner: &str) -> Result<PreparedDispatch> {
        let dispatch = task_dispatch::Repository::new(self.database.clone());
        let cycles = dispatch.list(owner).await?;
        let (pending_routes, route_changes) = crate::tasks::Repository::new(self.database.clone())
            .inference_route_scheduling(owner)
            .await?;
        let chats = Chats::new(self.database.clone());
        let physical = WorkerRepository::new(self.database.clone());
        let mut entries = HashMap::new();
        for cycle in cycles.as_array().context("Task dispatch cycles")? {
            if cycle["state"] != "queued" {
                continue;
            }
            let Some(context) = chats
                .execution_context(owner, &text(&cycle["chatId"])?)
                .await?
            else {
                continue;
            };
            if context["contextKind"] != "project" || context["experience"] != "task" {
                continue;
            }
            let task = crate::tasks::Repository::new(self.database.clone())
                .get(owner, &text(&cycle["chatId"])?)
                .await?;
            let configuration = task
                .as_ref()
                .and_then(|t| t.get("modelConfiguration"))
                .unwrap_or(&cycle["modelConfiguration"]);
            let physical_worker = physical
                .get_worker(owner, &text(&context["workerId"])?)
                .await?;
            let route_change = route_changes.get(&text(&cycle["id"])?).cloned();
            let route_pending = pending_routes.contains(&text(&cycle["chatId"])?);
            {
                let mut runtime = None;
                let resolution = if route_pending {
                    json!({"eligible":false,"code":"provider-transfer-pending"})
                } else if route_change.is_none() && !(self.connected)(&text(&context["workerId"])?)
                {
                    json!({"eligible":false,"code":"worker-offline"})
                } else if route_change.is_none()
                    && !physical_worker.as_ref().is_some_and(|w| {
                        w["encryption"]["grants"].as_array().is_some_and(|grants| {
                            grants
                                .iter()
                                .any(|grant| grant["component"] == "task-content")
                        })
                    })
                {
                    json!({"eligible":false,"code":"encryption-grant-unavailable"})
                } else if !truthy(configuration.get("modelId")) {
                    json!({"eligible":false,"code":"model-unavailable"})
                } else {
                    let (routing, owner, mut configuration_context, configuration) = (
                        self.routing.clone(),
                        owner.to_owned(),
                        context.clone(),
                        configuration.clone(),
                    );
                    configuration_context["providerAccountId"] = Value::Null;
                    match self
                        .operations
                        .with_timeout("resolve-runtime", self.timeout_ms, async move {
                            let roots = if let Some(change) = route_change {
                                let mut target_context = configuration_context.clone();
                                target_context["modelRouteId"] =
                                    change["targetModelRouteId"].clone();
                                target_context["providerAccountId"] =
                                    change["targetProviderAccountId"].clone();
                                Some(vec![
                                    routing
                                        .configured_managed_runtime(
                                            &owner,
                                            &target_context,
                                            &configuration["modelId"],
                                        )
                                        .await?,
                                ])
                            } else {
                                None
                            };
                            routing
                                .route_pairs(
                                    &owner,
                                    &configuration_context,
                                    &configuration,
                                    roots.as_deref(),
                                )
                                .await
                        })
                        .await
                    {
                        Ok(pairs) => {
                            runtime = pairs
                                .first()
                                .and_then(|p| p["root"].get("runtime"))
                                .cloned();
                            match &runtime {
                                Some(selected) => {
                                    json!({"eligible":true,"modelRouteId":selected["routeId"],"providerAccountId":selected["provider"]["accountId"],"codexThreadId":if truthy(context.get("threadId")) && RuntimeTelemetry::can_resume(&context,selected){context["threadId"].clone()}else{Value::Null}})
                                }
                                None => json!({"eligible":false,"code":"model-unavailable"}),
                            }
                        }
                        Err(error) => {
                            self.warn_timeout(&error, cycle, &context, false);
                            let code = error
                                .downcast_ref::<ConfigurationFailure>()
                                .map(|f| &f.0["code"]);
                            json!({"eligible":false,"code":if code.is_some_and(|c|c=="worker-offline"){"worker-offline"}else if code.is_some_and(|c|c=="provider-route-incompatible"){"provider-route-unavailable"}else{"model-unavailable"}})
                        }
                    }
                };
                entries.insert(
                    cycle["id"]
                        .as_js_string()
                        .context("Task eligibility identity")?
                        .clone(),
                    Entry {
                        physical_worker: context["workerId"].clone(),
                        project: context["projectId"].clone(),
                        worktree: context["worktreeId"].clone(),
                        configuration: configuration.clone(),
                        fence: cycle["fencingToken"].clone(),
                        resolution,
                        runtime,
                    },
                );
            }
        }
        Ok(PreparedDispatch {
            entries: Arc::new(entries),
        })
    }
    async fn resume(&self, owner: &str) -> Result<task_dispatch::Eligibility> {
        let cycles = task_dispatch::Repository::new(self.database.clone())
            .list(owner)
            .await?;
        let (pending_routes, _) = crate::tasks::Repository::new(self.database.clone())
            .inference_route_scheduling(owner)
            .await?;

        let chats = Chats::new(self.database.clone());
        let mut resolutions = HashMap::new();
        for cycle in cycles.as_array().context("Task dispatch cycles")? {
            if cycle["state"] != "paused" {
                continue;
            }
            if pending_routes.contains(&text(&cycle["chatId"])?) {
                resolutions.insert(
                    cycle["id"]
                        .as_js_string()
                        .context("Task cycle identity")?
                        .clone(),
                    json!({"eligible":false,"code":"provider-transfer-pending"}),
                );
                continue;
            }
            let context = chats
                .execution_context(owner, &text(&cycle["chatId"])?)
                .await?;
            let resolution = if context.as_ref().is_none_or(|c| {
                c["experience"] != "task"
                    || !truthy(cycle["modelConfiguration"].get("modelId"))
                    || !truthy(cycle.get("modelRouteId"))
                    || !truthy(cycle.get("physicalWorkerId"))
                    || !truthy(cycle.get("worktreeId"))
                    || c["workerId"] != cycle["physicalWorkerId"]
                    || c["worktreeId"] != cycle["worktreeId"]
            }) {
                unavailable()
            } else if !(self.connected)(&text(&cycle["physicalWorkerId"])?) {
                json!({"eligible":false,"code":"worker-offline"})
            } else {
                let (routing, owner, route_context, model) = (
                    self.routing.clone(),
                    owner.to_owned(),
                    json!({"workerId":cycle["physicalWorkerId"],"providerAccountId":cycle["providerAccountId"]}),
                    text(&cycle["modelConfiguration"]["modelId"])?,
                );
                match self
                    .operations
                    .with_timeout("resolve-runtime", self.timeout_ms, async move {
                        routing
                            .available_runtimes(&owner, &route_context, &model)
                            .await
                    })
                    .await
                {
                    Ok(runtimes) => {
                        if runtimes.iter().any(|r| {
                            r.get("routeId") == cycle.get("modelRouteId")
                                && r["provider"].get("accountId") == cycle.get("providerAccountId")
                        }) {
                            json!({"eligible":true})
                        } else {
                            json!({"eligible":false,"code":"provider-route-unavailable"})
                        }
                    }
                    Err(error) => {
                        self.warn_timeout(&error, cycle, context.as_ref().unwrap(), true);
                        json!({"eligible":false,"code":"model-unavailable"})
                    }
                }
            };
            resolutions.insert(
                cycle["id"]
                    .as_js_string()
                    .context("Task cycle identity")?
                    .clone(),
                resolution,
            );
        }
        Ok(Arc::new(move |cycle| {
            futures::future::ready(Ok(cycle["id"]
                .as_js_string()
                .and_then(|id| resolutions.get(id))
                .cloned()
                .unwrap_or_else(unavailable)))
            .boxed()
        }))
    }
}
