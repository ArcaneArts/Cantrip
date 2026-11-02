use super::*;
use crate::{
    chats::{
        Repository, RuntimeUpdate, live_mutations::RouteSelection, message_queries::MessageKind,
        runtime_quota, runtime_telemetry::RuntimeTelemetry,
    },
    workers::command_bus::RequestTimeout,
};
use std::{sync::OnceLock, time::Duration};
pub(super) struct Heartbeat(Option<oneshot::Sender<()>>);
impl Drop for Heartbeat {
    fn drop(&mut self) {
        self.0.take();
    }
}
impl Runtime {
    pub(super) fn heartbeat(self: &Arc<Self>, turn: Arc<PreparedTurn>) -> Heartbeat {
        let Some(lease) = turn
            .options
            .get("taskDispatchLease")
            .filter(|v| truthy(Some(v)))
            .cloned()
        else {
            return Heartbeat(None);
        };
        let (stop, mut stopped) = oneshot::channel();
        let runtime = self.clone();
        self.operations.spawn(async move {
            let interval=Duration::from_millis((crate::task_dispatch::LEASE_MS/3) as u64);
            let mut timer=tokio::time::interval_at(tokio::time::Instant::now()+interval,interval);
            loop {
                tokio::select! {biased; _=&mut stopped=>break,_=timer.tick()=>{}}
                let (runtime,turn,lease)=(runtime.clone(),turn.clone(),lease.clone());
                let operations=runtime.operations.clone();
                operations.spawn(async move {
                    if let Err(error)=crate::task_dispatch::Repository::new(runtime.dependencies.events.database.clone()).heartbeat(&lease,&json!(())).await && !error.is::<crate::task_dispatch::Conflict>() {
                        runtime.log("warn","Could not renew the Task dispatch lease",json!({"chatId":turn.execution["chatId"],"err":logging::error_details(&error)}));
                    }
                    Ok(())
                });
            }
            Ok(())
        });
        Heartbeat(Some(stop))
    }
    pub(super) async fn update_runtime(
        &self,
        turn: &PreparedTurn,
        runtime: &Value,
        thread: &Value,
        status: &str,
    ) -> Result<()> {
        let e = &turn.execution;
        Repository::new(self.dependencies.events.database.clone())
            .update_runtime(RuntimeUpdate {
                chat: events::text(&e["chatId"])?,
                worker: events::text(&e["workerId"])?,
                worktree: e["worktreeId"].as_str().map(str::to_owned),
                scratch_root: e["scratchRootId"].as_str().map(str::to_owned),
                thread: thread.as_str().map(str::to_owned),
                route: events::text(&runtime["routeId"])?,
                status: status.into(),
                provider_account: runtime["provider"]
                    .get("accountId")
                    .map(|v| v.as_str().map(str::to_owned)),
            })
            .await
    }
    fn quota_execution(
        &self,
        sink: &EventSink,
        turn: Option<String>,
    ) -> Result<runtime_quota::Execution> {
        Ok(runtime_quota::Execution {
            owner: sink.turn.owner.clone(),
            worker: events::text(&sink.turn.execution["workerId"])?,
            chat: Some(events::text(&sink.turn.execution["chatId"])?),
            attempt: events::text(&sink.attempt_id)?,
            turn,
        })
    }
    pub(super) fn quota_completed(&self, sink: &EventSink, turn: &Value) -> Result<()> {
        self.dependencies.events.quota.schedule_completed(
            sink.runtime.clone(),
            self.quota_execution(sink, turn.as_str().map(str::to_owned))?,
        );
        Ok(())
    }
    pub(super) async fn prepare_attempt(
        self: &Arc<Self>,
        sink: &Arc<EventSink>,
        index: usize,
        began: i64,
    ) -> Result<()> {
        let turn = &sink.turn;
        let runtime = sink.runtime.lock().unwrap().clone();
        if index > 0 {
            let kind = if turn.encrypted_chat.is_some() {
                MessageKind::Encrypted
            } else if turn.encrypted_task.is_some() {
                MessageKind::Task
            } else {
                MessageKind::Plain
            };
            let pair = &turn.route_pairs[index]["root"];
            self.dependencies.events.live.set_route(&turn.owner,&events::text(&turn.user_message["id"])?,RouteSelection {model:&events::text(&turn.model_id)?,runtime:&runtime,reasoning:Some(&json!({"appliedReasoningEffort":pair["appliedReasoningEffort"],"reasoningAdjusted":pair["adjusted"]})),kind,routing:None}).await?;
        }
        let thread = if RuntimeTelemetry::can_resume(&turn.execution, &runtime) {
            turn.execution["threadId"].clone()
        } else {
            Value::Null
        };
        let (this, turn_start, runtime_start, thread_start) =
            (self.clone(), turn.clone(), runtime.clone(), thread.clone());
        sink.turn
            .observer
            .run("persist-chat-runtime", async move {
                this.update_runtime(&turn_start, &runtime_start, &thread_start, "starting")
                    .await
            })
            .await?;
        let switch = index > 0
            && sink.turn.route_pairs[index - 1]["root"]["runtime"]["provider"].get("accountId")
                != runtime["provider"].get("accountId");
        self.dependencies.events.quota.capture(
            sink.runtime.clone(),
            self.quota_execution(sink, None)?,
            if switch {
                "account-switch"
            } else {
                "turn-starting"
            },
        );
        if !truthy(sink.turn.options.get("taskDispatchLease")) {
            self.record_started(sink, index, began).await;
        }
        Ok(())
    }
    fn analytics(
        &self,
        sink: &EventSink,
        index: usize,
        status: &str,
        began: i64,
        at: Option<i64>,
    ) -> Value {
        let turn = &sink.turn;
        let mut a = json!({"workerId":turn.execution["workerId"],"executionAttemptId":sink.attempt_id,"attemptKind":"chat-turn","attemptStatus":status,"codexVersion":turn.attributed_worker.as_ref().map(|v|v["codexVersion"].clone()).unwrap_or(Value::Null),"routeAttemptIndex":index,"retryFailoverCount":index,"startedAt":crate::wire::date_iso_milliseconds(began).expect("Attempt clock"),"immediateCorrectiveFollowup":turn.immediate_corrective_followup,"userRetryRegeneration":truthy(turn.options.get("retryMessageId"))});
        if let Some(at) = at {
            let iso = json!(crate::wire::date_iso_milliseconds(at).expect("Attempt clock"));
            a["completedAt"] = iso.clone();
            a["finalizedAt"] = iso;
            a["durationMs"] = json!(at - began);
        }
        a
    }
    pub(super) async fn record_started(&self, sink: &EventSink, index: usize, began: i64) {
        let runtime = sink.runtime.lock().unwrap().clone();
        let a = self.analytics(sink, index, "running", began, None);
        self.dependencies
            .events
            .telemetry
            .record_usage(
                &sink.turn.owner,
                &sink.source,
                &sink.turn.execution,
                &runtime,
                None,
                &a,
            )
            .await;
        let state = sink.state.lock().await;
        self.dependencies
            .events
            .telemetry
            .record_behavior(
                &sink.turn.owner,
                &sink.source,
                &sink.turn.execution,
                &runtime,
                &state.tracker,
                &a,
            )
            .await;
    }
    pub(super) async fn dispatch(
        self: &Arc<Self>,
        sink: &Arc<EventSink>,
        index: usize,
        began: i64,
        hooks: &Hooks,
        started: &mut Option<oneshot::Sender<Result<(), Arc<anyhow::Error>>>>,
    ) -> Result<()> {
        let turn = &sink.turn;
        let e = &turn.execution;
        if let Some(lease) = turn
            .options
            .get("taskDispatchLease")
            .filter(|v| truthy(Some(v)))
        {
            self.log("info","Scheduled Task turn bootstrap is ready for worker dispatch",json!({"event":"task.turn-bootstrap-ready","subsystem":"task-scheduler","operation":"bootstrap-turn","status":"ready","chatId":e["chatId"],"cycleId":lease["cycleId"],"operationId":lease["operationId"],"clientMessageId":turn.user_message["id"],"executionLaneId":e["executionLaneId"],"serverVersion":crate::settings::quota::server_version(),"workerId":e["workerId"]}));
        }
        let runtime = sink.runtime.lock().unwrap().clone();
        self.log("debug","Agent turn route dispatched",json!({"event":"chat.turn.route-dispatched","subsystem":"chat-execution","operation":"turn","status":"dispatching","chatId":e["chatId"],"projectId":e["projectId"],"workerId":e["workerId"],"requestId":turn.user_message["id"],"runId":e["executionLaneId"],"attempt":index+1,"counts":json!({"candidateRoutes":turn.route_pairs.len()}),"providerId":runtime["provider"]["id"],"providerAccountId":runtime["provider"]["accountId"],"routeId":runtime["routeId"]}));
        let command = sink.command(&self.dependencies.server_id).await?;
        let (commands, worker, sink_events) = (
            self.dependencies.events.commands.clone(),
            events::text(&e["workerId"])?,
            sink.clone(),
        );
        let receive = self.operations.spawn(async move {
            Ok(commands
                .request_with_timeout(
                    &worker,
                    command,
                    RequestTimeout::Disabled,
                    Some(Arc::new(move |event| {
                        let sink = sink_events.clone();
                        async move { sink.on_event(&event).await.map_err(event_error) }.boxed()
                    })),
                )
                .await?)
        });
        if let Some(started) = started.take() {
            let _ = started.send(Ok(()));
        }
        if let Some(lease) = turn
            .options
            .get("taskDispatchLease")
            .filter(|v| truthy(Some(v)))
        {
            self.log("info","Scheduled Task turn dispatched to the worker",json!({"event":"task.worker-turn.dispatched","subsystem":"task-scheduler","operation":"dispatch-worker-turn","status":"dispatched","chatId":e["chatId"],"cycleId":lease["cycleId"],"operationId":lease["operationId"],"clientMessageId":turn.user_message["id"],"executionLaneId":e["executionLaneId"],"serverVersion":crate::settings::quota::server_version(),"workerId":e["workerId"]}));
            let (this, sink) = (self.clone(), sink.clone());
            let operation = async move {
                this.record_started(&sink, index, began).await;
                Ok(())
            };
            let recorded =
                if let Some(timeout) = turn.options["preflightWorkerCommandTimeoutMs"].as_f64() {
                    self.operations
                        .with_timeout("begin-turn", timeout, operation)
                        .await
                } else {
                    operation.await
                };
            if let Err(error) = recorded {
                self.log("warn","Could not record scheduled Task turn-start telemetry",json!({"event":"task.turn-start-telemetry.failed","subsystem":"task-scheduler","operation":"record-turn-start","status":"degraded","chatId":e["chatId"],"cycleId":lease["cycleId"],"operationId":lease["operationId"],"clientMessageId":turn.user_message["id"],"executionLaneId":e["executionLaneId"],"serverVersion":crate::settings::quota::server_version(),"workerId":e["workerId"],"err":logging::error_details(&error)}));
            }
        }
        let raw = receive
            .await
            .context("The owned worker turn stopped unexpectedly.")??;
        self.dependencies.continuation.cancel_outcome_recovery(turn);
        let result = crate::settings::parse_response("agentTurnResultSchema", raw.as_ref())?;
        self.complete(sink, index, began, hooks, result).await
    }
    pub(super) async fn fail_attempt(
        &self,
        sink: &EventSink,
        index: usize,
        began: i64,
        error: &anyhow::Error,
    ) -> Result<bool> {
        let turn = &sink.turn;
        let runtime = sink.runtime.lock().unwrap().clone();
        let mut state = sink.state.lock().await;
        let failed = (self.dependencies.events.clock)();
        let text = message(error).lossy().to_ascii_lowercase();
        let interrupted = worker_interrupted(turn, error);
        let status = if interrupted || text.contains("interrupt") {
            "interrupted"
        } else if text.contains("cancel") {
            "cancelled"
        } else {
            "failed"
        };
        let automatic = !(runtime["provider"]["kind"] == "chatgpt"
            && crate::chats::eligibility::use_chatgpt_credits(&runtime["provider"]["credits"]));
        let native_accepted = if !interrupted && automatic {
            if let Some(receipt) = &turn.native_receipt {
                Commands::new(self.dependencies.events.database.clone())
                    .get(
                        &turn.owner,
                        &events::text(&turn.execution["workerId"])?,
                        &events::text(&receipt["operationId"])?,
                        &events::text(&receipt["operationGeneration"])?,
                    )
                    .await?["status"]
                    == "accepted"
            } else {
                true
            }
        } else {
            false
        };
        let overloaded = state
            .terminal_reason
            .as_ref()
            .is_some_and(|v| v == "serverOverloaded");
        static RETRY: OnceLock<regress::Regex> = OnceLock::new();
        // The Source expression has no `u` flag: its dot consumes one UTF-16
        // code unit, so a surrogate pair cannot be the single rate.?limit gap.
        let retry_error=RETRY.get_or_init(||regress::Regex::with_flags(r"(quota|usage limit|rate.?limit|\b429\b|unauthori[sz]ed|\b401\b|forbidden|\b403\b|authentication|credentials|model.+(?:not found|unavailable|at capacity)|\b404\b|timed? out|timeout|ECONN|connection|network|socket|\b5\d\d\b|service unavailable|overloaded)","i").unwrap()).find_from_ucs2(message(error).units(),0).next().is_some();
        let retry = !interrupted
            && automatic
            && native_accepted
            && (overloaded || (!state.activity && retry_error))
            && index + 1 < turn.route_pairs.len();
        let mut a = self.analytics(sink, index, status, began, Some(failed));
        a["turnId"] = state.behavior_turn.clone();
        a["retryFailoverCount"] = json!(index + usize::from(retry));
        a["userInterrupted"] = json!(matches!(status, "interrupted" | "cancelled"));
        let mut usage_attribution = a.clone();
        if let Value::Object(fields) = &mut usage_attribution {
            fields.shift_remove("startedAt");
        }
        self.dependencies
            .events
            .telemetry
            .record_usage(
                &turn.owner,
                &sink.source,
                &turn.execution,
                &runtime,
                None,
                &usage_attribution,
            )
            .await;
        self.dependencies
            .events
            .telemetry
            .record_behavior(
                &turn.owner,
                &sink.source,
                &turn.execution,
                &runtime,
                &state.tracker,
                &a,
            )
            .await;
        if !state.quota_followups_scheduled {
            self.quota_completed(sink, &Value::Null)?;
            state.quota_followups_scheduled = true;
        }
        if retry {
            self.dependencies.continuation.cancel_outcome_recovery(turn);
            self.dependencies.routing.set_cooldown(
                &runtime,
                Some((self.dependencies.events.clock)() as f64 + 60_000.0),
            );
            self.log("warn",if overloaded {"Provider route remained at capacity; trying the next route"}else{"Provider route failed before activity; trying the next route"},json!({"event":"chat.turn.route-failed-over","subsystem":"chat-execution","operation":"turn","status":"retrying","reasonCode":if overloaded {"model-capacity"}else{"route-failed-before-activity"},"chatId":turn.execution["chatId"],"err":if turn.encrypted_task.is_some(){json!({"name":"Error","message":"Encrypted Task route failed."})}else{logging::error_details(error)},"providerId":runtime["provider"]["id"],"providerAccountId":runtime["provider"]["accountId"],"routeId":runtime["routeId"],"projectId":turn.execution["projectId"],"workerId":turn.execution["workerId"],"requestId":turn.user_message["id"],"runId":turn.execution["executionLaneId"],"durationMs":failed-began,"attempt":index+1}));
        }
        Ok(retry)
    }
    pub(super) fn completed_analytics(
        &self,
        sink: &EventSink,
        index: usize,
        began: i64,
        at: i64,
    ) -> Value {
        self.analytics(sink, index, "completed", began, Some(at))
    }
}
