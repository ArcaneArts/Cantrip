//! Complete fire-and-stream turn execution. The recovery/queue collaborator is
//! required; HTTP composition must supply the actual durable coordinator.
mod attempt;
mod failure;
mod outcome;
use super::{
    bootstrap::{Bootstrap, PreparedTurn},
    events::{self, EventSink, TurnState, identifier},
    stages::Operations,
};
use crate::{
    chats::{automatic_title::MessageTitles, routing::ModelRouting},
    native_commands::Repository as Commands,
    operations::logging::{self, LogCall, Logger},
    wire::{JsString, Value, coercion::truthy, value::json},
    workers::{bridge::CommandError, command_bus::CommandFailure},
};
use anyhow::{Context, Result};
use futures::{FutureExt, future::BoxFuture};
use std::sync::{Arc, Mutex};
use tokio::sync::oneshot;

pub trait Continuation: Send + Sync {
    fn cancel_outcome_recovery(&self, turn: &PreparedTurn);
    fn continue_worktree(&self, turn: Arc<PreparedTurn>) -> BoxFuture<'static, Result<bool>>;
    fn dispatch_queue(&self, turn: Arc<PreparedTurn>) -> BoxFuture<'static, Result<()>>;
}
#[derive(Clone)]
pub struct Completion {
    pub turn: Arc<PreparedTurn>,
    pub result: Value,
}
#[derive(Clone)]
pub struct Failure {
    pub turn: Arc<PreparedTurn>,
    pub error: Arc<anyhow::Error>,
}
pub type Completed = Arc<dyn Fn(Completion) -> BoxFuture<'static, Result<()>> + Send + Sync>;
pub type Failed = Arc<dyn Fn(Failure) -> BoxFuture<'static, Result<()>> + Send + Sync>;
pub struct Structured {
    pub completed: Completed,
    pub failed: Failed,
    pub after_completed: Option<Completed>,
}
#[derive(Default)]
pub struct Hooks {
    pub structured: Option<Structured>,
    pub after_completed: Option<Completed>,
    pub after_failed: Option<Failed>,
}
pub struct Dependencies {
    pub events: events::Dependencies,
    pub bootstrap: Arc<Bootstrap>,
    pub routing: Arc<ModelRouting>,
    pub titles: Arc<MessageTitles>,
    pub continuation: Arc<dyn Continuation>,
    pub logger: Logger,
    pub server_id: String,
}
pub struct Runtime {
    pub dependencies: Dependencies,
    operations: Arc<Operations>,
}
pub(super) fn message(error: &anyhow::Error) -> JsString {
    crate::settings::operation_error_message(error)
}
pub(super) fn unavailable(error: &anyhow::Error) -> bool {
    error
        .downcast_ref::<CommandFailure>()
        .is_some_and(|e| matches!(e,CommandFailure::Bridge(e) if e.unavailable))
        || error
            .downcast_ref::<CommandError>()
            .is_some_and(|e| e.unavailable)
        || error.is::<crate::chats::live_mutations::WorkerUnavailable>()
}
pub(super) fn worker_interrupted(turn: &PreparedTurn, error: &anyhow::Error) -> bool {
    turn.execution["experience"] == "task"
        && turn.user_message["mode"] == "goal"
        && unavailable(error)
}
fn event_error(error: anyhow::Error) -> CommandError {
    if let Some(CommandFailure::Bridge(error)) = error.downcast_ref::<CommandFailure>() {
        return error.clone();
    }
    if let Some(error) = error.downcast_ref::<CommandError>() {
        return error.clone();
    }
    CommandError {
        message: message(&error),
        code: error
            .downcast_ref::<crate::native_commands::CommandError>()
            .map(|e| e.code.clone()),
        unavailable: unavailable(&error),
        request_id: None,
        encoding_error: None,
    }
}
fn copy_error(error: Arc<anyhow::Error>) -> anyhow::Error {
    if let Some(error) = error.downcast_ref::<crate::settings::reasoning::ConfigurationFailure>() {
        return crate::settings::reasoning::ConfigurationFailure(error.0.clone()).into();
    }
    if let Some(error) = error.downcast_ref::<crate::settings::ResponseValidationError>() {
        return error.clone().into();
    }
    if let Some(e) = error.downcast_ref::<crate::native_commands::CommandError>() {
        return crate::native_commands::CommandError::new(
            e.code.clone(),
            Some(&e.message),
            e.status,
        )
        .into();
    }
    if let Some(CommandFailure::Bridge(e)) = error.downcast_ref::<CommandFailure>() {
        return CommandFailure::Bridge(e.clone()).into();
    }
    if let Some(e) = error.downcast_ref::<CommandError>() {
        return e.clone().into();
    }
    if let Some(e) = error.downcast_ref::<super::stages::TaskLaunchStageTimeout>() {
        return super::stages::TaskLaunchStageTimeout {
            stage: e.stage,
            timeout_ms: e.timeout_ms,
        }
        .into();
    }
    anyhow::anyhow!(error.to_string())
}
impl Runtime {
    pub fn new(dependencies: Dependencies) -> Arc<Self> {
        Arc::new(Self::from_dependencies(dependencies))
    }
    pub fn new_cyclic(build: impl FnOnce(&std::sync::Weak<Self>) -> Dependencies) -> Arc<Self> {
        Arc::new_cyclic(|weak| Self::from_dependencies(build(weak)))
    }
    fn from_dependencies(dependencies: Dependencies) -> Self {
        Self {
            dependencies,
            operations: Arc::new(Operations::default()),
        }
    }
    pub fn begin(
        self: &Arc<Self>,
        owner: &str,
        context: &Value,
        input: &Value,
        options: &Value,
        hooks: Hooks,
    ) -> BoxFuture<'static, Result<Value>> {
        let (this, owner, context, input, options) = (
            self.clone(),
            owner.to_owned(),
            context.clone(),
            input.clone(),
            options.clone(),
        );
        self.operations.run(async move {
            let turn=Arc::new(this.dependencies.bootstrap.prepare(&owner,&context,&input,&options).await?);
            if let Some(encrypted)=&turn.encrypted_chat && options.get("messageRole").filter(|v|!v.is_null()).is_none_or(|v|v=="user") {
                drop(this.dependencies.titles.generate_with_context(&owner,&events::text(&turn.execution["chatId"])?,&encrypted["userMessage"],Some(&turn.execution)));
            }
            let scheduled=truthy(turn.options.get("taskDispatchLease"));
            let (started,dispatched)=oneshot::channel();
            let (runtime,background)=(this.clone(),turn.clone());
            this.operations.spawn(async move {
                if let Err(error)=runtime.run(background.clone(),hooks,started).await {
                    (runtime.dependencies.logger)(LogCall::event("error","Could not settle a failed chat turn",json!({"chatId":background.execution["chatId"],"err":logging::error_details(&error)})));
                }
                Ok(())
            });
            if scheduled {dispatched.await.context("Scheduled Task bootstrap ended before worker dispatch.")?.map_err(copy_error)?;}
            let first=&turn.route_pairs[0]["root"];let runtime=&first["runtime"];
            let mut result=turn.user_message.clone();
            for (key,value) in [("modelId",turn.model_id.clone()),("modelRouteId",runtime["routeId"].clone()),("providerId",runtime["provider"]["id"].clone()),("providerName",runtime["provider"]["name"].clone()),("providerModelName",runtime["model"]["name"].clone()),("appliedReasoningEffort",first["appliedReasoningEffort"].clone()),("reasoningAdjusted",first["adjusted"].clone())] {result[key]=value;}
            if let Some(reasoning)=&turn.requested_reasoning {result["reasoningEffort"]=reasoning.clone();}else if let Value::Object(fields)=&mut result {fields.shift_remove("reasoningEffort");}
            Ok(result)
        })
    }
    async fn run(
        self: &Arc<Self>,
        turn: Arc<PreparedTurn>,
        hooks: Hooks,
        started: oneshot::Sender<Result<(), Arc<anyhow::Error>>>,
    ) -> Result<()> {
        let mut started = Some(started);
        let state = Arc::new(Mutex::new(TurnState::default()));
        let _heartbeat = self.heartbeat(turn.clone());
        let result = self
            .run_routes(turn.clone(), &hooks, state.clone(), &mut started)
            .await;
        if let Err(error) = result {
            let error = Arc::new(error);
            if let Some(started) = started.take() {
                let _ = started.send(Err(error.clone()));
            }
            self.settle_failure(turn.clone(), &hooks, state, &error)
                .await?;
        }
        if let Some(started) = started {
            let _ = started.send(Err(Arc::new(anyhow::anyhow!(
                "Scheduled Task bootstrap ended before worker dispatch."
            ))));
        }
        Ok(())
    }
    async fn run_routes(
        self: &Arc<Self>,
        turn: Arc<PreparedTurn>,
        hooks: &Hooks,
        state: Arc<Mutex<TurnState>>,
        started: &mut Option<oneshot::Sender<Result<(), Arc<anyhow::Error>>>>,
    ) -> Result<()> {
        for (index, pair) in turn.route_pairs.iter().enumerate() {
            let runtime = Arc::new(Mutex::new(pair["root"]["runtime"].clone()));
            let sink = EventSink::new(
                self.dependencies.events.clone(),
                turn.clone(),
                runtime,
                index,
                state.clone(),
            );
            let began = (self.dependencies.events.clock)();
            self.prepare_attempt(&sink, index, began).await?;
            let result = self.dispatch(&sink, index, began, hooks, started).await;
            match result {
                Ok(()) => return Ok(()),
                Err(error) => {
                    if let Some(receipt) = &turn.native_receipt
                        && Commands::new(self.dependencies.events.database.clone())
                            .has_deferred_logical_gui(
                                &turn.owner,
                                &events::text(&turn.execution["workerId"])?,
                                &events::text(&receipt["operationId"])?,
                                &events::text(&receipt["operationGeneration"])?,
                            )
                            .await?
                    {
                        self.dependencies
                            .bootstrap
                            .finish(&turn, "idle", false)
                            .await?;
                        self.dependencies.events.live.publish_summary(
                            &turn.owner,
                            &turn.execution["chatId"],
                            &turn.execution["projectId"],
                        );
                        return Ok(());
                    }
                    if !self.fail_attempt(&sink, index, began, &error).await? {
                        return Err(error);
                    }
                }
            }
        }
        Ok(())
    }
    pub async fn drained(&self) {
        self.operations.drained().await;
        self.dependencies.bootstrap.drained().await;
        self.dependencies.titles.drained().await;
    }
    pub(super) fn log(&self, level: &'static str, message: &'static str, context: Value) {
        (self.dependencies.logger)(LogCall::event(level, message, context));
    }
}
