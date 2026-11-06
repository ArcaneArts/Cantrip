//! Explicit recovery holds automation until authoritative native acknowledgement.
use super::*;
struct Observed {
    context: Value,
    state: Value,
}
fn completed(state: &Value) -> bool {
    matches!(
        state["phase"].as_str(),
        Some("running" | "stopped" | "completed" | "failed" | "idle")
    )
}
fn response(observed: &Observed) -> Value {
    json!({"paused":observed.context["automationPaused"],"active":observed.state["active"],"nativeSuspension":super::super::native_suspensions::stored_summary(&observed.state)})
}
impl Service {
    async fn suspension_state(&self, owner: &str, chat: &str) -> Result<Observed> {
        let context = self.chats.execution_context(owner, chat).await?;
        let state = self.chats.native_suspension(owner, chat).await?;
        match (context, state) {
            (Some(context), Some(state)) => Ok(Observed { context, state }),
            _ => Err(failure(404, "The suspended chat is no longer available.")),
        }
    }
    async fn finish_resume(
        &self,
        owner: &str,
        context: &Value,
        control_id: &Value,
        observed: Observed,
        resume_automation: bool,
    ) -> Result<Value> {
        self.publish(owner, context);
        if resume_automation
            && observed.state["controlId"] == *control_id
            && observed.state["phase"] == "running"
            && !truthy(observed.context.get("automationPaused"))
            && self
                .goals
                .resume(owner, &text(&context["chatId"])?, false, false)
                .await
                .is_err()
        {
            (self.logger)(LogCall::event(
                "warn",
                "The turn resumed but queued automation remains pending",
                json!({"event":"chat.suspension.automation-wake-failed","chatId":context["chatId"]}),
            ));
        }
        Ok(response(&observed))
    }
    pub(super) async fn durable_resume(
        &self,
        owner: &str,
        context: &Value,
        control: &Value,
        resume_automation: bool,
    ) -> Result<Value> {
        let chat = text(&context["chatId"])?;
        let worker = text(&context["workerId"])?;
        let requested = match self.native.request_suspension_resume(owner, &chat).await {
            Ok(state) => state,
            Err(error) => {
                let current = self.suspension_state(owner, &chat).await?;
                if completed(&current.state) || current.state["action"] == "stop" {
                    return Ok(response(&current));
                }
                return Err(error);
            }
        };
        if truthy(control.get("activationGeneration")) {
            // A surviving owner is the fast path. Its requested flag is not ACK.
            let _ = async {
                let reply = self
                    .commands
                    .request_with_timeout(
                        &worker,
                        command(context, control, true, false),
                        RequestTimeout::Disabled,
                        None,
                    )
                    .await?;
                crate::settings::parse_response("chatPauseRuntimeStateSchema", reply.as_ref())
            }
            .await;
        }
        let mut observed = self.suspension_state(owner, &chat).await?;
        let mut known_failure = None;
        let mut source_failure = None;
        if observed.state["controlId"] == requested["controlId"]
            && observed.state["phase"] == "resuming"
            && observed.state["actorControlId"] != observed.state["controlId"]
        {
            let attempt: Result<()> = async {
                let Some(launch) = self.goals.suspended_launch(owner, context).await? else {
                    known_failure = Some((409, "runtime-unavailable", "The saved provider route is unavailable. This chat remains paused."));
                    return Err(failure(409, "The saved provider route is unavailable. This chat remains paused."));
                };
                if launch["session"].is_null() || !truthy(launch.get("threadId")) || requested["checkpoint"].is_null() {
                    known_failure = Some((409, "authority-changed", "The saved turn no longer matches its managed chat attachment."));
                    return Err(failure(409, "The saved turn no longer matches its managed chat attachment."));
                }
                let mut packet = json!({"type":"chat.suspension.resume","chatId":context["chatId"],"threadId":launch["threadId"],"controlId":requested["controlId"],"checkpoint":requested["checkpoint"],"nativeActivationGeneration":control["activationGeneration"],"nativeRuntimeGeneration":control["runtimeGeneration"],"session":launch["session"],"cwd":context["cwd"],"executionProfile":if context["contextKind"]=="standalone"{"standalone-chat"}else{"ide"}});
                packet["session"]["heldSuspension"] = requested["checkpoint"].clone();
                for field in ["model","provider","permissionProfileId","planMode","subagentDefaults","mcpServers"] { packet[field] = launch[field].clone(); }
                let reply = self.commands.request_with_timeout(&worker, packet, RequestTimeout::Disabled, None).await?;
                crate::settings::parse_response("chatPauseRuntimeStateSchema", reply.as_ref())?;
                Ok(())
            }.await;
            if let Err(error) = attempt
                && known_failure.is_none()
            {
                if let Some(crate::workers::command_bus::CommandFailure::Bridge(error)) =
                    error.downcast_ref::<crate::workers::command_bus::CommandFailure>()
                    && let Some(code) = error.code.as_ref()
                    && crate::settings::parse_response(
                        "nativeSuspensionErrorSchema",
                        Some(&json!({"code":code,"protectedDetails":Value::Null})),
                    )
                    .is_ok()
                {
                    source_failure = Some(code.clone());
                }
                // Worker transport errors can include native paths; keep them out
                // of public durable metadata. Native checkpoint/source stays held.
                known_failure = Some((
                    502,
                    "restore-failed",
                    "The worker could not resume this saved turn. Its checkpoint has been retained.",
                ));
            }
            observed = self.suspension_state(owner, &chat).await?;
        }
        if observed.state["controlId"] != requested["controlId"] || completed(&observed.state) {
            return self
                .finish_resume(
                    owner,
                    context,
                    &requested["controlId"],
                    observed,
                    resume_automation,
                )
                .await;
        }
        if observed.state["phase"] == "resuming" {
            let code = if !self.commands.is_connected(&worker) {
                "worker-offline"
            } else {
                source_failure
                    .as_deref()
                    .unwrap_or_else(|| known_failure.map_or("restore-failed", |f| f.1))
            };
            let _ = self
                .native
                .fail_suspension_resume(
                    owner,
                    &chat,
                    &observed.state,
                    &json!({"code":code,"protectedDetails":Value::Null}),
                )
                .await;
            observed = self.suspension_state(owner, &chat).await?;
        }
        self.publish(owner, context);
        if observed.state["controlId"] != requested["controlId"] || completed(&observed.state) {
            return self
                .finish_resume(
                    owner,
                    context,
                    &requested["controlId"],
                    observed,
                    resume_automation,
                )
                .await;
        }
        (self.logger)(LogCall::event(
            "warn",
            "The suspended native turn remains held",
            json!({"event":"chat.suspension.resume-failed","chatId":context["chatId"],"controlId":requested["controlId"],"errorCode":observed.state["error"]["code"]}),
        ));
        let (status, _, message) = known_failure.unwrap_or((
            502,
            "restore-failed",
            "The worker could not resume this saved turn. Its checkpoint has been retained.",
        ));
        Err(failure(status, message))
    }
}
