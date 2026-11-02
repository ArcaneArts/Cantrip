//! Public and observed console synchronization uses real admission and writers.
mod canonical;
mod notifications;
pub mod reconciliation;
use super::{
    Repository,
    live_mutations::{MessageOptions, Service as Live},
    message_queries::MessageKind,
    recovery,
    routing::ModelRouting,
    runtime_telemetry::RuntimeTelemetry,
    turn_runtime::stages::Operations,
};
use crate::{
    database::Database,
    operations::logging::Logger,
    wire::{Value, coercion::truthy, value::json},
    workers::command_bus::LimitedCommandBus,
};
use anyhow::{Context, Result, bail};
pub use canonical::canonical_messages;
use std::sync::Arc;

pub struct Dependencies {
    pub database: Arc<Database>,
    pub commands: Arc<LimitedCommandBus>,
    pub routing: Arc<ModelRouting>,
    pub live: Arc<Live>,
    pub recovery: Arc<recovery::Service>,
    pub telemetry: Arc<RuntimeTelemetry>,
    pub logger: Logger,
}
pub struct Service {
    dependencies: Dependencies,
    operations: Arc<Operations>,
    observations: Arc<reconciliation::Reconciler>,
}
fn text(value: &Value) -> Result<String> {
    Ok(value
        .as_js_string()
        .context("Thread synchronization identity")?
        .lossy()
        .into_owned())
}
impl Service {
    pub fn new(dependencies: Dependencies) -> Arc<Self> {
        let logger = dependencies.logger.clone();
        Arc::new(Self {
            dependencies,
            operations: Arc::default(),
            observations: reconciliation::Reconciler::new(
                Arc::new(move |error, key| {
                    logger(crate::operations::logging::LogCall::event(
                        "warn",
                        "Could not reconcile an observed Codex thread change",
                        json!({"err":crate::operations::logging::error_details(&error),"observationKey":key}),
                    ))
                }),
                4096,
            ),
        })
    }
    pub async fn reconcile(
        self: &Arc<Self>,
        owner: &str,
        context: &Value,
        resolved_runtime: Option<&Value>,
    ) -> Result<Value> {
        let (this, owner, context, runtime) = (
            self.clone(),
            owner.to_owned(),
            context.clone(),
            resolved_runtime.cloned(),
        );
        self.operations
            .run(async move { this.reconcile_one(&owner, &context, runtime.as_ref()).await })
            .await
    }
    async fn reconcile_one(
        self: &Arc<Self>,
        owner: &str,
        context: &Value,
        resolved_runtime: Option<&Value>,
    ) -> Result<Value> {
        if context["contextKind"] != "project" {
            bail!("Standalone Chats cannot synchronize with an external Codex console.");
        }
        if !truthy(context.get("threadId")) {
            return Ok(
                json!({"threadId":"unavailable","status":"idle","turns":Vec::<Value>::new()}),
            );
        }
        let worker = text(&context["workerId"])?;
        if !self.dependencies.commands.is_connected(&worker) {
            return Err(super::live_mutations::WorkerUnavailable.into());
        }
        let runtime = if let Some(runtime) = resolved_runtime {
            runtime.clone()
        } else if context["experience"] == "agent" && truthy(context.get("modelRouteId")) {
            self.dependencies
                .routing
                .bound_managed_runtime(owner, context)
                .await?
        } else {
            self.dependencies
                .routing
                .runtime_for_context(owner, context)
                .await?
                .context("Selected model was not found.")?
        };
        let command = json!({"type":"chat.sync","executionProfile":"ide","chatId":context["chatId"],"cwd":context["cwd"],"threadId":context["threadId"],"model":runtime["model"],"provider":runtime["provider"]});
        let reply = self
            .dependencies
            .commands
            .request(&worker, command, None, None)
            .await?;
        let sync = crate::settings::parse_response("agentThreadSyncSchema", reply.as_ref())?;
        let observes = sync["status"] == "running"
            || !sync["turns"].as_array().context("Native turns")?.is_empty()
            || sync["statusSource"] == "native-thread";
        let reconciliation = if observes {
            crate::native_commands::Repository::new(self.dependencies.database.clone())
                .reconcile_thread_observation(owner, context, &text(&sync["status"])?)
                .await?
        } else {
            json!({"applied":false,"execution":context})
        };
        let execution = &reconciliation["execution"];
        let attribution = (execution["contextKind"] == "project" && !execution["executionLaneId"].is_null()).then(||json!({"contextKind":"project","executionLaneId":execution["executionLaneId"],"worktreeId":execution["worktreeId"],"scratchRootId":Value::Null}));
        let chat = text(&context["chatId"])?;
        let options = json!({"idempotencyPrefix":"codex-sync","interruptedMessage":"Turn interrupted in the Codex console.","failedMessage":"The Codex console turn failed."});
        for entry in canonical_messages(&sync, &options, None)? {
            if entry["activity"]["type"] == "usage" {
                let turn = entry["activity"]["correlation"]
                    .get("turnId")
                    .filter(|v| !v.is_null())
                    .unwrap_or(&entry["turnId"]);
                let source = canonical::key(&json!("chat"), &context["chatId"], turn)?;
                let attempt = canonical::key(&json!("console-sync"), &context["chatId"], turn)?;
                self.dependencies.telemetry.record_usage(owner,source.as_js_string().expect("Usage source"),context,&runtime,entry["activity"].get("last"),&json!({"workerId":context["workerId"],"turnId":turn,"executionAttemptId":attempt,"attemptKind":"console-sync","attemptStatus":if sync["status"]=="running" {"running"}else{"completed"}})).await;
            }
            self.dependencies
                .live
                .write_message(
                    owner,
                    &chat,
                    &entry["message"],
                    MessageOptions {
                        attribution: attribution.as_ref(),
                        kind: MessageKind::Plain,
                        upsert: true,
                        routing: None,
                    },
                )
                .await?;
        }
        if reconciliation["applied"] == true {
            self.dependencies.live.publish_summary(
                owner,
                &context["chatId"],
                &context["projectId"],
            );
            if sync["status"] == "idle"
                && !self
                    .dependencies
                    .recovery
                    .continue_worktree_transition(owner, &chat)
                    .await?
            {
                drop(self.dependencies.recovery.dispatch(owner, &chat));
            }
        }
        Ok(sync)
    }
    pub fn close(&self) {
        self.observations.clear();
    }
    pub async fn drained(&self) {
        self.operations.drained().await;
        self.observations.drained().await;
    }
}
