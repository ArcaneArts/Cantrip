use super::runtime::*;
use crate::{
    chats::{Repository as Chats, routing::ModelSelectionRequired},
    database::Executor,
    operations::logging::LogCall,
    wire::{Value, coercion::truthy, value::json},
};
use anyhow::{Context, Result, bail};
use futures::FutureExt;
use std::sync::{Arc, Mutex};
use tokio::sync::oneshot;

struct Attempt {
    state: Option<Value>,
    phase: &'static str,
    ready: Option<oneshot::Sender<Result<(), Arc<anyhow::Error>>>>,
}
impl Service {
    async fn bound_runtime(&self, owner: &str, context: &Value) -> Result<Value> {
        self.routing.bound_managed_runtime(owner, context).await
    }
    pub(super) async fn run(
        &self,
        owner: &str,
        chat: &str,
        job: &Job,
        recovery: Option<Recovery>,
        ready_send: oneshot::Sender<Result<(), Arc<anyhow::Error>>>,
    ) -> Result<()> {
        let mut attempt = Attempt {
            state: None,
            phase: "thread",
            ready: Some(ready_send),
        };
        let result = self.prepare(owner, chat, job, recovery, &mut attempt).await;
        let Attempt {
            state,
            phase,
            mut ready,
        } = attempt;
        if let Err(error) = result {
            let needs_model = phase == "thread" && error.is::<ModelSelectionRequired>();
            let diagnostic = crate::operations::logging::error_details(&error);
            if let Some(send) = ready.take() {
                let _ = send.send(Err(Arc::new(error)));
            }
            if needs_model {
                if let Some(state) = &state {
                    self.repository
                        .update(owner, state, "needs-model", None, None)
                        .await?;
                }
                return Ok(());
            }
            (self.logger)(LogCall::event(
                "warn",
                "Managed chat preparation failed",
                json!({"event":"chat.preparation.failed","subsystem":"chat-preparation","operation":phase,"status":"failed","chatId":chat,"error":diagnostic}),
            ));
            if let Some(state) = &state {
                self.repository
                    .update(owner, state, "failed", Some(phase), None)
                    .await?;
            }
        }
        if let Some(send) = ready.take() {
            let _ = send.send(Ok(()));
        }
        Ok(())
    }
    async fn prepare(
        &self,
        owner: &str,
        chat: &str,
        job: &Job,
        recovery: Option<Recovery>,
        attempt: &mut Attempt,
    ) -> Result<()> {
        let Attempt {
            state,
            phase,
            ready,
        } = attempt;
        if let Some(recovery) = recovery {
            recovery.await.map_err(copy_error)?;
        }
        if self
            .state
            .lock()
            .unwrap()
            .active
            .get(&key(owner, chat))
            .is_none_or(|current| current.id != job.id)
        {
            bail!("The preparation was replaced.");
        }
        let chats = Chats::new(self.repository.database.clone());
        let Some(context) = chats.execution_context(owner, chat).await?.filter(eligible) else {
            return Ok(());
        };
        *state = self
            .repository
            .claim(owner, chat, text(&context, "workerId")?)
            .await?;
        let Some(claimed) = state.clone() else {
            return Ok(());
        };
        self.publish_preparation(owner, chat);
        let runtime = if truthy(context.get("threadId")) && truthy(context.get("modelRouteId")) {
            self.bound_runtime(owner, &context).await?
        } else {
            self.routing
                .runtime_for_context(owner, &context)
                .await?
                .context("No configured provider route is available.")?
        };
        let launch = self
            .console
            .prepare_launch(owner, &context, &runtime)
            .await?;
        if truthy(context.get("threadId"))
            && (launch["model"]["routeId"] != context["modelRouteId"]
                || launch["provider"]
                    .get("accountId")
                    .filter(|v| !v.is_null())
                    .unwrap_or(&Value::Null)
                    != &context["providerAccountId"])
        {
            bail!("The bound provider identity changed.");
        }
        let worker = text(&context, "workerId")?;
        if truthy(context.get("threadId")) {
            let commands =
                crate::native_commands::Repository::new(self.repository.database.clone());
            let recovery = commands.recovery_context(owner, chat).await?;
            let mut configuration = launch.clone();
            if let Value::Object(fields) = &mut configuration {
                fields.shift_remove("type");
            }
            let mut command = json!({"type":"chat.thread.ensure","cwd":context["cwd"]});
            for (key, value) in configuration.as_object().context("Console configuration")? {
                command[key.as_str().context("Configuration field")?] = value.clone();
            }
            for (field, fallback) in [
                ("planMode", context["planMode"].clone()),
                ("permissionProfileId", json!(":workspace")),
                ("mcpServers", Value::Array(vec![])),
            ] {
                if command.get(field).is_none_or(Value::is_null) {
                    command[field] = fallback;
                }
            }
            if let Some(recovery) = &recovery {
                command["recoveryTurnId"] = recovery["turnId"].clone();
            }
            let result = self
                .command(owner.to_owned(), worker.to_owned(), command, None)
                .await?;
            if crate::chats::context::property(result.as_ref(), "threadId")?
                != Some(&launch["threadId"])
            {
                bail!("The prepared native thread changed.");
            }
            if let (Some(recovery), Some(observed)) = (
                recovery.as_ref(),
                result
                    .as_ref()
                    .and_then(|v| v.get("recovery"))
                    .filter(|v| truthy(Some(v))),
            ) {
                let observed = crate::settings::parse_response(
                    "nativeTurnRecoveryObservationSchema",
                    Some(observed),
                )?;
                if commands
                    .recover_execution(owner, worker, recovery, &observed)
                    .await?
                    && truthy(recovery["receipt"].get("executionLaneId"))
                {
                    crate::agent_interactions::Repository::new(Executor::Database(
                        &self.repository.database,
                    ))
                    .interrupt(chat, recovery["receipt"]["executionLaneId"].as_str())
                    .await?;
                    self.publish_preparation(owner, chat);
                }
            }
        }
        let current = chats.execution_context(owner, chat).await?;
        let Some(current) = current.filter(eligible).filter(|c| {
            c["workerId"] == context["workerId"]
                && c["worktreeId"] == context["worktreeId"]
                && c["threadId"] == launch["threadId"]
        }) else {
            bail!("The prepared chat placement changed.");
        };
        *phase = "console";
        *state = Some(
            self.repository
                .update(owner, &claimed, "console", None, None)
                .await?
                .context("The preparation was replaced.")?,
        );
        if let Some(send) = ready.take() {
            let _ = send.send(Ok(()));
        }
        self.publish_preparation(owner, chat);
        let state_before_console = state.as_ref().unwrap();
        let protected=self.command(owner.to_owned(),worker.to_owned(),json!({"type":"terminal.prepare-state","terminalId":state_before_console["terminalId"],"serverId":self.server_id}),None).await?;
        let protected = crate::settings::parse_response(
            "encryptedLinkedConsoleCreateSchema",
            protected.as_ref(),
        )?;
        if protected["id"] != state_before_console["terminalId"] {
            bail!("Console identity changed.");
        }
        let terminal = crate::terminals::Repository::new(self.repository.database.clone())
            .get_or_create_chat_console(owner, chat, &protected)
            .await?
            .filter(|v| truthy(v.get("stateProtection")))
            .context("The chat console is unavailable.")?;
        *state = Some(
            self.repository
                .update(
                    owner,
                    state_before_console,
                    "console",
                    None,
                    terminal["id"].as_str(),
                )
                .await?
                .context("The preparation was replaced.")?,
        );
        let state = state.as_ref().unwrap();
        let attachment = format!("managed-preparation:{}", text(state, "generation")?);
        let (send, receive) = oneshot::channel::<Result<(), Arc<anyhow::Error>>>();
        let spawned = Arc::new(Mutex::new(Some(send)));
        let event: crate::workers::bridge::EventHandler = {
            let spawned = spawned.clone();
            Arc::new(move |event| {
                let spawned = spawned.clone();
                async move {
                    if event["type"] == "terminal.ready"
                        && let Some(send) = spawned.lock().unwrap().take()
                    {
                        let _ = send.send(Ok(()));
                    }
                    Ok(())
                }
                .boxed()
            })
        };
        let command = json!({"type":"terminal.open","terminalId":terminal["id"],"attachmentId":attachment,"operationId":uuid::Uuid::new_v4().to_string(),"serverId":self.server_id,"worktreePath":current["cwd"],"stateProtection":terminal["stateProtection"],"cols":100,"rows":30,"outputMode":"discard","managedPreparationGeneration":state["generation"],"launch":launch});
        let opened = (self.request_worker)(
            owner.to_owned(),
            worker.to_owned(),
            command,
            crate::workers::command_bus::RequestTimeout::Disabled,
            Some(event),
        );
        // The open request continues while detach acknowledges the ready event.
        let opened = tokio::spawn(async move {
            let result = opened.await;
            if let Some(send) = spawned.lock().unwrap().take() {
                let error = result
                    .as_ref()
                    .err()
                    .map(|e| anyhow::anyhow!(e.to_string()))
                    .unwrap_or_else(|| {
                        anyhow::anyhow!("The CLI exited before preparation completed.")
                    });
                let _ = send.send(Err(Arc::new(error)));
            }
            result
        });
        let ready_result = receive
            .await
            .context("Console readiness ended")?
            .map_err(copy_error);
        self.command(
            owner.to_owned(),
            worker.to_owned(),
            json!({"type":"terminal.detach","terminalId":terminal["id"],"attachmentId":attachment}),
            None,
        )
        .await?;
        ready_result?;
        let opened = opened.await.context("Console open task ended")??;
        let result = crate::settings::parse_response("terminalOpenResultSchema", opened.as_ref())?;
        if result["status"] == "exited" {
            bail!("The CLI exited during preparation.");
        }
        self.repository
            .update(owner, state, "ready", None, terminal["id"].as_str())
            .await?;
        Ok(())
    }
}
