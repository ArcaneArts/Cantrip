//! Durable turn admission and input persistence, shared by GUI and scheduled turns.
mod admitted;
mod preflight;
use super::stages::{Clock, Observer, Operations};
use crate::{
    chats::{
        Repository, execution_lanes::LaneRepository, live_mutations::Service as Live,
        managed_console::ManagedConsole, protect_input::InputProtection, routing::ModelRouting,
        turn_placement::TurnPlacement,
    },
    database::Database,
    native_commands::{
        Repository as NativeCommands,
        runtime::{finish_gui::finish_managed_gui, gui_admission::GuiAdmission},
    },
    operations::logging::{self, LogCall, Logger},
    wire::{Value, coercion::truthy, value::json},
    workers::{
        command_bus::{LimitedCommandBus, RequestTimeout},
        repository::WorkerRepository,
    },
};
use anyhow::{Context, Result};
use futures::{FutureExt, future::BoxFuture};
use std::sync::Arc;

pub struct Bootstrap {
    database: Arc<Database>,
    chats: Repository,
    pub(super) routing: Arc<ModelRouting>,
    console: Arc<ManagedConsole>,
    commands: Arc<LimitedCommandBus>,
    placement: TurnPlacement,
    protection: InputProtection,
    admission: GuiAdmission,
    live: Arc<Live>,
    pub operations: Arc<Operations>,
    logger: Logger,
    clock: Clock,
}
/// Everything needed by the worker stream is captured at the same boundaries
/// as Source. Later placement changes cannot rewrite a turn's attribution.
pub struct PreparedTurn {
    pub owner: String,
    pub input: Value,
    pub options: Value,
    pub started_at: i64,
    pub observer: Observer,
    pub execution: Value,
    pub native_receipt: Option<Value>,
    pub model_id: Value,
    pub requested_reasoning: Option<Value>,
    pub route_pairs: Vec<Value>,
    pub attachments: Vec<Value>,
    pub encrypted_chat: Option<Value>,
    pub encrypted_task: Option<Value>,
    pub task_relay: Option<Value>,
    pub task_conversation: bool,
    pub direct_task_operation: bool,
    pub turn_mode: Value,
    pub turn_plan_mode: Value,
    pub effective_policies: Value,
    pub standalone_policies: Value,
    pub mcp_servers: Vec<Value>,
    pub attribution: Value,
    pub protected_history: Vec<Value>,
    pub protected_plan: Option<Value>,
    pub user_message: Value,
    pub immediate_corrective_followup: bool,
    pub attributed_worker: Option<Value>,
}
pub(super) fn text<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value[key].as_str().context("Turn execution identity")
}
fn nullish(value: Option<&Value>, fallback: Value) -> Value {
    value.filter(|v| !v.is_null()).cloned().unwrap_or(fallback)
}
impl Bootstrap {
    pub fn new(
        database: Arc<Database>,
        routing: Arc<ModelRouting>,
        console: Arc<ManagedConsole>,
        commands: Arc<LimitedCommandBus>,
        live: Arc<Live>,
    ) -> Arc<Self> {
        Self::with_observation(
            database,
            routing,
            console,
            commands,
            live,
            logging::server_logger(),
            Arc::new(|| crate::auth::now().timestamp_millis()),
        )
    }
    pub fn with_observation(
        database: Arc<Database>,
        routing: Arc<ModelRouting>,
        console: Arc<ManagedConsole>,
        commands: Arc<LimitedCommandBus>,
        live: Arc<Live>,
        logger: Logger,
        clock: Clock,
    ) -> Arc<Self> {
        Arc::new(Self {
            chats: Repository::new(database.clone()),
            placement: TurnPlacement::new(database.clone(), commands.clone()),
            protection: InputProtection::new(commands.clone()),
            admission: GuiAdmission::new(database.clone()),
            database,
            routing,
            console,
            commands,
            live,
            logger,
            clock,
            operations: Arc::new(Operations::default()),
        })
    }
    pub fn prepare(
        self: &Arc<Self>,
        owner: &str,
        context: &Value,
        input: &Value,
        options: &Value,
    ) -> BoxFuture<'static, Result<PreparedTurn>> {
        let (this, owner, context, input, options) = (
            self.clone(),
            owner.to_owned(),
            context.clone(),
            input.clone(),
            options.clone(),
        );
        self.operations
            .run(async move { this.prepare_inner(owner, context, input, options).await })
    }
    fn prepare_inner(
        self: Arc<Self>,
        owner: String,
        context: Value,
        input: Value,
        options: Value,
    ) -> BoxFuture<'static, Result<PreparedTurn>> {
        async move {
        let started_at = (self.clock)();
        crate::chats::turn_configuration::validate(&context, &input, &options)?;
        let context = self.placement.reconcile(&owner, &context).await?;
        let observer = Observer::new(
            self.operations.clone(),
            &context,
            &options,
            self.logger.clone(),
            self.clock.clone(),
        );
        let mut turn = self
            .preflight(owner, context, input, options, started_at, observer)
            .await?;
        let protected_input = turn
            .encrypted_chat
            .as_ref()
            .map(|v| &v["userMessage"])
            .or_else(|| turn.encrypted_task.as_ref().map(|v| &v["userMessage"]))
            .or_else(|| turn.options["structuredResult"]["taskOperation"].get("userMessage"));
        let admitted = self
            .admission
            .acquire_observed(
                &turn.owner,
                &turn.execution,
                &turn.options,
                protected_input,
                Some(&turn.observer),
            )
            .await?;
        turn.execution = admitted["execution"].clone();
        turn.native_receipt = admitted.get("nativeCommandReceipt").cloned();
        self.live.publish_summary(
            &turn.owner,
            &turn.execution["chatId"],
            &turn.execution["projectId"],
        );
        turn.attribution = json!({"contextKind":turn.execution["contextKind"],"executionLaneId":turn.execution["executionLaneId"],"worktreeId":turn.execution["worktreeId"],"scratchRootId":turn.execution["scratchRootId"]});
        if let Err(error) = self.persist(&mut turn).await {
            self.finish(&turn, "failed", false).await?;
            self.live.publish_summary(
                &turn.owner,
                &turn.execution["chatId"],
                &turn.execution["projectId"],
            );
            return Err(error);
        }
        let (database, owner, worker) = (
            self.database.clone(),
            turn.owner.clone(),
            text(&turn.execution, "workerId")?.to_owned(),
        );
        turn.attributed_worker = turn
            .observer
            .run("load-worker-attribution", async move {
                Ok(WorkerRepository::new(database)
                    .get_worker(&owner, &worker)
                    .await?
                    .as_ref()
                    .map(Value::from_serialize))
            })
            .await?;
        Ok(turn)
        }.boxed()
    }
    pub async fn finish(
        &self,
        turn: &PreparedTurn,
        status: &str,
        pause_automation: bool,
    ) -> Result<bool> {
        let chat = text(&turn.execution, "chatId")?;
        if let Some(receipt) = &turn.native_receipt {
            let logger = self.logger.clone();
            finish_managed_gui(&NativeCommands::new(self.database.clone()),&self.commands,&turn.owner,text(&turn.execution,"workerId")?,receipt,status,&move |_| {
                (logger)(LogCall::event("warn","The worker did not acknowledge logical GUI completion.",json!({"event":"native-command.logical-completion-ack-failed","chatId":chat,"operationId":receipt["operationId"]})));
            }).await
        } else {
            let mut options = json!({"pauseAutomation":pause_automation});
            if pause_automation {
                options["expectedActivatedAt"] = turn.execution["executionLaneActivatedAt"].clone();
            }
            LaneRepository::new(self.database.clone())
                .finish(
                    chat,
                    text(&turn.execution, "executionLaneId")?,
                    status,
                    &options,
                )
                .await
        }
    }
    pub async fn drained(&self) {
        self.operations.drained().await;
    }
}
