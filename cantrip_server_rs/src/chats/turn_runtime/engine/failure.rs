use super::*;
use crate::chats::{live_mutations::MessageOptions, message_queries::MessageKind};
impl Runtime {
    pub(super) async fn retain_suspension(&self, turn: &PreparedTurn) -> Result<bool> {
        let commands = Commands::new(self.dependencies.events.database.clone());
        let task_input = turn.task_relay.is_some()
            || (turn.encrypted_task.is_some() && turn.user_message["mode"] == "goal");
        if task_input
            && truthy(turn.options.get("taskDispatchLease"))
            && commands
                .cancelled_task_execution(
                    &turn.owner,
                    &events::text(&turn.execution["workerId"])?,
                    &events::text(&turn.execution["chatId"])?,
                    &turn.options["taskDispatchLease"],
                    &turn.execution["executionLaneId"],
                    &turn.user_message["id"],
                )
                .await?
        {
            self.dependencies.events.live.publish_summary(
                &turn.owner,
                &turn.execution["chatId"],
                &turn.execution["projectId"],
            );
            return Ok(true);
        }
        let state = if let Some(receipt) = &turn.native_receipt {
            commands
                .suspended_execution(
                    &turn.owner,
                    &events::text(&turn.execution["workerId"])?,
                    &events::text(&receipt["operationId"])?,
                    &events::text(&receipt["operationGeneration"])?,
                )
                .await?
        } else if task_input && truthy(turn.options.get("taskDispatchLease")) {
            commands
                .retain_task_suspension(
                    &turn.owner,
                    &events::text(&turn.execution["workerId"])?,
                    &events::text(&turn.execution["chatId"])?,
                    &turn.options["taskDispatchLease"],
                    &turn.execution["executionLaneId"],
                    &turn.user_message["id"],
                )
                .await?
        } else {
            None
        };
        let Some(state) = state else {
            return Ok(false);
        };
        self.dependencies.events.live.publish_summary(
            &turn.owner,
            &turn.execution["chatId"],
            &state["target"]["projectId"],
        );
        self.log(
            "info",
            "Suspended native turn retained after its worker submission ended",
            json!({"event":"chat.turn.suspended","subsystem":"chat-execution",
                "operation":"retain-suspended-turn","status":state["phase"],
                "chatId":turn.execution["chatId"],"workerId":turn.execution["workerId"],
                "operationId":state["target"]["originalOperationId"],"turnId":state["active"]["turnId"]}),
        );
        Ok(true)
    }
    pub(super) async fn settle_failure(
        self: &Arc<Self>,
        turn: Arc<PreparedTurn>,
        hooks: &Hooks,
        state: Arc<Mutex<TurnState>>,
        error: &Arc<anyhow::Error>,
    ) -> Result<()> {
        if self.retain_suspension(&turn).await? {
            return Ok(());
        }
        let e = &turn.execution;
        let transport_ended = crate::workers::inference_failure::transport_ended(error);
        if (turn.task_relay.is_some()
            || (turn.encrypted_task.is_some() && turn.user_message["mode"] == "goal"))
            && truthy(turn.options.get("taskDispatchLease"))
        {
            if let Some(proof) = crate::workers::inference_failure::evidence(error) {
                crate::tasks::Repository::new(self.dependencies.events.database.clone())
                    .record_inference_failure(&turn.owner, &events::text(&e["workerId"])?, proof)
                    .await?;
            }
            match crate::tasks::Repository::new(self.dependencies.events.database.clone())
                .defer_inference_input(
                    &turn.owner,
                    &events::text(&e["chatId"])?,
                    &json!({"kind":"leased","lease":turn.options["taskDispatchLease"]}),
                )
                .await
            {
                Ok(true) => {
                    self.dependencies.events.live.publish_invalidation(
                        &turn.owner,
                        &events::text(&e["chatId"])?,
                        "task",
                        None,
                    );
                    if let Some(hook) = &hooks.structured {
                        (hook.failed)(Failure {
                            turn: turn.clone(),
                            error: error.clone(),
                        })
                        .await?;
                    }
                    return Ok(());
                }
                Ok(false) => {}
                Err(error) if error.is::<crate::task_dispatch::Conflict>() => return Ok(()),
                Err(error) => return Err(error),
            }
            if transport_ended {
                match crate::tasks::Repository::new(self.dependencies.events.database.clone())
                    .pending_input_after_transport_loss(
                        &turn.owner,
                        &events::text(&e["chatId"])?,
                        &turn.options["taskDispatchLease"],
                    )
                    .await
                {
                    Ok(true) => {
                        self.log("info", "Task input retained while awaiting its native outcome",
                            json!({"event":"task.input.transport-interrupted","chatId":e["chatId"],
                                "workerId":e["workerId"],"operationId":turn.options["taskDispatchLease"]["operationId"],"status":"retained"}));
                        return Ok(());
                    }
                    Ok(false) => {}
                    Err(error) if error.is::<crate::task_dispatch::Conflict>() => return Ok(()),
                    Err(error) => return Err(error),
                }
            }
        }
        let worker_interrupted = worker_interrupted(&turn, error);
        let failure = Failure {
            turn: turn.clone(),
            error: error.clone(),
        };
        if truthy(turn.options.get("structuredResult")) {
            let result = match &hooks.structured {
                Some(hook) => (hook.failed)(failure.clone()).await,
                None => Err(anyhow::anyhow!(
                    "options.structuredResult.onFailed is not a function"
                )),
            };
            if let Err(error) = result {
                self.log(
                    "error",
                    "Could not persist a failed Task planning operation",
                    json!({"chatId":e["chatId"],"err":logging::error_details(&error)}),
                );
            }
        }
        let active = state.lock().unwrap().any_activity;
        if !active && truthy(e.get("modelRouteId")) {
            self.update_runtime(&turn,&json!({"routeId":e["modelRouteId"],"provider":json!({"accountId":e["providerAccountId"]})}),&e["threadId"],"ready").await?;
        }
        let interrupted = worker_interrupted
            || message(error)
                .lossy()
                .to_ascii_lowercase()
                .contains("interrupted");
        self.log("error",if worker_interrupted{"Task Goal interrupted because its worker became unavailable"}else{"Agent turn failed"},json!({"event":if interrupted{"chat.turn.interrupted"}else{"chat.turn.failed"},"subsystem":"chat-execution","operation":"turn","status":if interrupted{"interrupted"}else{"failed"},"reasonCode":if worker_interrupted{"worker-unavailable"}else if interrupted{"interrupted"}else{"execution-failed"},"chatId":e["chatId"],"projectId":e["projectId"],"workerId":e["workerId"],"requestId":turn.user_message["id"],"runId":e["executionLaneId"],"durationMs":(self.dependencies.events.clock)()-turn.started_at,"err":if turn.encrypted_task.is_some(){json!({"name":"Error","message":if worker_interrupted{"Encrypted Task turn interrupted because its worker became unavailable. Resume the Task to continue."}else{"Encrypted Task turn failed."}})}else{logging::error_details(error)}}));
        if turn.encrypted_task.is_none() && turn.encrypted_chat.is_none() {
            let content = if interrupted {
                json!("Turn interrupted.")
            } else {
                identifier(&[&json!("Agent failed: "), &Value::String(message(error))])
            };
            self.dependencies.events.live.write_message(&turn.owner,&events::text(&e["chatId"])?,&json!({"role":"system","content":Value::Array(vec![json!({"type":"text","text":content})]),"idempotencyKey":identifier(&[&json!("error:"),&turn.user_message["id"]])}),MessageOptions{attribution:Some(&turn.attribution),kind:MessageKind::Plain,upsert:false,routing:None}).await?;
        }
        self.dependencies
            .events
            .live
            .interrupt_interactions(
                &turn.owner,
                &events::text(&e["chatId"])?,
                e["executionLaneId"].as_str(),
            )
            .await?;
        let finished = self
            .dependencies
            .bootstrap
            .finish_with_transport(
                &turn,
                if interrupted || e["contextKind"] == "standalone" {
                    "idle"
                } else {
                    "failed"
                },
                worker_interrupted,
                transport_ended,
            )
            .await?;
        self.dependencies
            .continuation
            .cancel_outcome_recovery(&turn);
        self.dependencies.events.live.publish_boundary(
            &turn.owner,
            &events::text(&e["chatId"])?,
            &e["projectId"],
            Some(e),
        );
        if let Some(callback) = &hooks.after_failed
            && (!worker_interrupted || finished)
            && let Err(error) = callback(failure).await
        {
            self.log(
                "error",
                "Task post-processing failed after its turn failed",
                json!({"chatId":e["chatId"],"err":logging::error_details(&error)}),
            );
        }
        if finished
            && !worker_interrupted
            && (e["contextKind"] == "standalone"
                || !self
                    .dependencies
                    .continuation
                    .continue_worktree(turn.clone())
                    .await?)
        {
            let continuation = self.dependencies.continuation.clone();
            self.operations
                .spawn(async move { continuation.dispatch_queue(turn).await });
        }
        Ok(())
    }
}
