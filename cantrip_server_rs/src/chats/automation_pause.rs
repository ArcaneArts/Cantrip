//! Durable pause/resume and worker acknowledgements shared by Chat and Tasks.
//! Native controls persist authorized intent at dispatch; late acknowledgements
//! must observe that intent instead of writing an older request a second time.
mod durable_resume;
mod durable_stop;
use super::{
    Repository, goals, live_mutations::Service as Live, managed_console,
    turn_runtime::stages::Operations,
};
use crate::{
    database::Database,
    native_commands::{self, queued_prompt::PromptRepository},
    operations::logging::{LogCall, Logger},
    wire::{JsString, Value, coercion::truthy, value::json},
    workers::command_bus::{LimitedCommandBus, RequestTimeout},
};
use anyhow::{Context, Result};
use futures::future::BoxFuture;
use std::sync::Arc;
#[path = "automation_pause_task.rs"]
mod task;
#[derive(Debug)]
pub struct PauseError {
    pub status_code: u16,
    pub message: JsString,
}
impl std::fmt::Display for PauseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message.lossy())
    }
}
impl std::error::Error for PauseError {}
fn failure(status_code: u16, message: impl Into<JsString>) -> anyhow::Error {
    PauseError {
        status_code,
        message: message.into(),
    }
    .into()
}
fn wrapped(status: u16, prefix: &str, error: &anyhow::Error) -> anyhow::Error {
    let mut units = prefix.encode_utf16().collect::<Vec<_>>();
    units.extend_from_slice(crate::settings::operation_error_message(error).units());
    failure(status, JsString::new(units))
}
pub struct Service {
    chats: Repository,
    native: native_commands::Repository,
    prompts: PromptRepository,
    handoffs: crate::native_handoffs::Repository,
    commands: Arc<LimitedCommandBus>,
    goals: Arc<goals::Service>,
    live: Arc<Live>,
    logger: Logger,
    operations: Arc<Operations>,
    stop_controls: std::sync::Mutex<
        std::collections::HashMap<(String, String), std::sync::Weak<tokio::sync::Mutex<()>>>,
    >,
}
fn text(value: &Value) -> Result<String> {
    Ok(value
        .as_js_string()
        .context("Pause identity")?
        .lossy()
        .into_owned())
}
fn command(context: &Value, control: &Value, native: bool, paused: bool) -> Value {
    if native && truthy(control.get("activationGeneration")) {
        let mut result = json!({"type":"chat.native-control","chatId":context["chatId"],"threadId":context["threadId"],"nativeActivationGeneration":control["activationGeneration"],"modelRouteId":context["modelRouteId"],"providerAccountId":context["providerAccountId"],"control":json!({"kind":"pause","paused":paused})});
        if let Some(generation) = control.get("runtimeGeneration") {
            result["nativeRuntimeGeneration"] = generation.clone();
        }
        result
    } else {
        json!({"type":"chat.pause.set","chatId":context["chatId"],"paused":paused})
    }
}
impl Service {
    pub fn new(
        database: Arc<Database>,
        commands: Arc<LimitedCommandBus>,
        goals: Arc<goals::Service>,
        live: Arc<Live>,
        logger: Logger,
    ) -> Arc<Self> {
        Arc::new(Self {
            chats: Repository::new(database.clone()),
            native: native_commands::Repository::new(database.clone()),
            handoffs: crate::native_handoffs::Repository::new(database.clone()),
            prompts: PromptRepository::new(database),
            commands,
            goals,
            live,
            logger,
            operations: Arc::default(),
            stop_controls: Default::default(),
        })
    }
    pub fn set(
        self: &Arc<Self>,
        owner: &str,
        chat: &str,
        paused: bool,
        resume_automation: bool,
    ) -> BoxFuture<'static, Result<Value>> {
        let (this, owner, chat) = (self.clone(), owner.to_owned(), chat.to_owned());
        self.operations
            .run(async move { this.set_one(&owner, &chat, paused, resume_automation).await })
    }
    pub async fn drained(&self) {
        self.operations.drained().await;
    }
    fn publish(&self, owner: &str, context: &Value) {
        self.live
            .publish_summary(owner, &context["chatId"], &context["projectId"]);
    }
    async fn set_one(
        &self,
        owner: &str,
        chat: &str,
        paused: bool,
        resume_automation: bool,
    ) -> Result<Value> {
        crate::native_handoffs::service::settle_task_control(
            &self.handoffs,
            &self.commands,
            owner,
            chat,
        )
        .await
        .map_err(|cause| {
            wrapped(
                409,
                "Could not settle the provider transfer before changing pause state: ",
                &cause,
            )
        })?;
        let control = self.native.control_context(owner, chat).await?;
        let context = &control["context"];
        if !truthy(Some(context)) {
            return Err(failure(404, "Chat source not found."));
        }
        let worker = text(&context["workerId"])?;
        let chat = text(&context["chatId"])?;
        if !paused
            && !self.commands.is_connected(&worker)
            && (truthy(context.get("threadId"))
                || !self.prompts.list_visible(owner, &chat).await?.is_empty())
        {
            return Err(failure(
                503,
                "The project worker is offline. This chat remains paused so its next action is not lost.",
            ));
        }
        if context["experience"] == "task" {
            return self
                .set_task_pause(owner, &chat, paused, resume_automation)
                .await;
        }
        let native = managed_console::turn_session_context(context).is_some();
        let suspension = if native {
            self.chats.native_suspension(owner, &chat).await?
        } else {
            None
        };
        if paused && let Some(state) = suspension.as_ref().filter(|s| s["phase"] == "paused") {
            return Ok(
                json!({"paused":true,"active":state["active"],"nativeSuspension":super::native_suspensions::stored_summary(state)}),
            );
        }
        let suspension_resume = native
            && !paused
            && suspension.as_ref().is_some_and(|s| {
                !s["checkpoint"].is_null() || super::native_suspensions::is_live_resume(s)
            });
        if suspension_resume {
            return self
                .durable_resume(owner, context, &control, resume_automation)
                .await;
        }
        let resume_before_worker = !paused && native && !suspension_resume;
        let resumed = if resume_before_worker {
            self.chats
                .set_automation_paused(owner, &chat, false)
                .await?
        } else {
            None
        };
        if resume_before_worker && resumed.is_none() {
            return Err(failure(404, "Chat source not found."));
        }
        if native && !paused && !suspension_resume {
            self.native.resume_autonomy(owner, &chat).await?;
        }
        let connected = self.commands.is_connected(&worker);
        let mut active = Value::Null;
        if connected {
            let acknowledged: Result<Value> = async {
                let response = self
                    .commands
                    .request_with_timeout(
                        &worker,
                        command(context, &control, native, paused),
                        RequestTimeout::Disabled,
                        None,
                    )
                    .await?;
                let receipt = crate::settings::parse_response(
                    "chatPauseRuntimeStateSchema",
                    response.as_ref(),
                )?;
                anyhow::ensure!(
                    native || receipt["paused"] == paused,
                    "The worker did not acknowledge the requested pause state."
                );
                Ok(receipt["active"].clone())
            }
            .await;
            match acknowledged {
                Ok(value) => active = value,
                Err(error) => {
                    if resume_before_worker {
                        self.chats.set_automation_paused(owner, &chat, true).await?;
                        self.publish(owner, context);
                    }
                    return Err(wrapped(
                        502,
                        if paused {
                            "The worker could not pause this chat at a safe boundary: "
                        } else {
                            "The worker could not resume this chat: "
                        },
                        &error,
                    ));
                }
            }
        }
        let native_owns_pause = native && truthy(control.get("activationGeneration")) && connected;
        let updated = if native_owns_pause {
            self.chats.execution_context(owner, &chat).await?
        } else {
            match resumed {
                Some(value) => Some(value),
                None => {
                    self.chats
                        .set_automation_paused(owner, &chat, paused)
                        .await?
                }
            }
        };
        let Some(updated) = updated else {
            if connected {
                let _ = self
                    .commands
                    .request_with_timeout(
                        &worker,
                        command(context, &control, native, !paused),
                        RequestTimeout::Disabled,
                        None,
                    )
                    .await;
            }
            return Err(failure(404, "Chat source not found."));
        };
        self.publish(owner, context);
        if resume_automation
            && !paused
            && !truthy(updated.get("automationPaused"))
            && let Err(error) = self.goals.resume(owner, &chat, false, false).await
        {
            self.chats.set_automation_paused(owner, &chat, true).await?;
            self.publish(owner, context);
            if self.commands.is_connected(&worker) {
                let _ = self
                    .commands
                    .request_with_timeout(
                        &worker,
                        command(context, &control, native, true),
                        RequestTimeout::Default,
                        None,
                    )
                    .await;
            }
            return Err(wrapped(
                409,
                "This chat remains paused because its next action could not start: ",
                &error,
            ));
        }
        let paused = truthy(updated.get("automationPaused"));
        (self.logger)(LogCall::event(
            "info",
            if paused {
                "Chat automation paused"
            } else {
                "Chat automation resumed"
            },
            json!({"event":if paused{"chat.automation.paused"}else{"chat.automation.resumed"},"subsystem":"chat-execution","operation":if paused{"pause"}else{"resume"},"status":if paused{"paused"}else{"active"},"chatId":context["chatId"],"projectId":context["projectId"],"workerId":context["workerId"]}),
        ));
        Ok(json!({"paused":updated["automationPaused"],"active":active}))
    }
}
