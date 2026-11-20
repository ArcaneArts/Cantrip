//! Recover a physical Task turn under a fresh canonical input receipt.
use crate::codex::{
    preparation::command::Prepared,
    suspension_store::Opened,
    turn::{
        control::{Selection, pause::BOUNDARY_TIMEOUT},
        *,
    },
};

#[derive(Debug)]
pub(in crate::codex::turn) struct Failure {
    stage: &'static str,
    code: Option<i64>,
}

impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Task restoration failed at {}", self.stage)?;
        if let Some(code) = self.code {
            write!(f, " (native RPC code {code})")?;
        }
        write!(f, ".")
    }
}
impl std::error::Error for Failure {}

pub(in crate::codex::turn) fn failed(stage: &'static str, cause: anyhow::Error) -> anyhow::Error {
    let code = cause
        .downcast_ref::<super::super::Failure>()
        .and_then(|error| error.native_error.as_ref())
        .and_then(|error| error["code"].as_i64());
    Failure { stage, code }.into()
}

struct HeldTask {
    prepared: Prepared,
    selected: Selection,
    epoch: Option<u64>,
}

impl Turns {
    pub(in crate::codex::turn) async fn restore_task(
        &self,
        command: &Value,
        task: &mut TaskTurn,
        active: &Arc<Active>,
        signal: &Signal,
        emit: Emit,
        epoch: Option<u64>,
    ) -> Result<Value> {
        let opened = self
            .open_task_checkpoint(command, task)
            .await
            .map_err(|error| failed("attach", error))?;
        let mut target = params::preparation(command);
        target["model"] = opened.continuation["model"].clone();
        let checkpoint = &opened.evidence["suspension"];
        let turn = id(&checkpoint["turnId"], "saved Task turn")?;
        let thread = id(&checkpoint["threadId"], "saved Task thread")?;
        let checkpoint = checkpoint.clone();
        let input = &command["taskInferenceInput"];
        let (owner, server, chat) = &task.key;
        let chat = chat.clone();
        self.task_inputs
            .authorize(owner, server, input, "claim", None, signal.clone())
            .await
            .map_err(|error| failed("admit", error))?;
        task.claimed = true;
        let prepared = self
            .preparation
            .prepare_restored_task(&target, opened)
            .await
            .map_err(|error| failed("attach", error))?;
        let selected = Selection {
            runtime: prepared.runtime.clone(),
            thread,
            turn,
            thread_version: prepared.thread.version(),
        };
        active.set(Phase::Preparing(Some(selected.thread.clone())));
        let held = HeldTask {
            prepared,
            selected,
            epoch,
        };
        let result = self
            .run_held_task(command, task, active, signal, emit, &held)
            .await;
        if result.is_err()
            && !task.restored_finished
            && held.selected.confirm_held(&checkpoint).await.is_ok()
        {
            self.preparation
                .detach_restored_task(&held.prepared, &chat)
                .await;
        }
        result
    }

    async fn run_held_task(
        &self,
        command: &Value,
        task: &mut TaskTurn,
        active: &Arc<Active>,
        signal: &Signal,
        emit: Emit,
        held: &HeldTask,
    ) -> Result<Value> {
        let HeldTask {
            prepared,
            selected,
            epoch,
        } = held;
        let opened = prepared
            .saved
            .as_ref()
            .context("The Task checkpoint attachment was lost.")?;
        let saved = &opened.continuation;
        let checkpoint = &opened.evidence["suspension"];
        let runtime = &selected.runtime;
        let (owner, server, chat) = &task.key;
        let input = &command["taskInferenceInput"];
        let restoration = &command["taskResumption"];
        let (thread, turn) = (&selected.thread, &selected.turn);
        selected
            .confirm_held(checkpoint)
            .await
            .map_err(|error| failed("attach", error))?;
        let bound = (owner.clone(), json!(server));
        let current = || {
            signal.check()?;
            self.preparation.task_restore_allowed(&bound, chat)?;
            prepared.thread.assert_current(runtime)
        };
        current().map_err(|error| failed("admit", error))?;
        let source = Source::claimed(
            id(&input["operationId"], "restored Task input")?,
            Some(signal.clone()),
        );
        let admission = runtime.admission();
        let mut request = Acquire::new(
            admission.lifetime_for_source(&source)?,
            command["provider"].clone(),
        );
        request.purpose = Some("turn".into());
        request.chat_id = Some(json!(chat));
        request.project_id = Some(command["policyProjectId"].clone());
        request.thread_id = Some(thread.clone());
        request.expected_turn_id = Some(turn.clone());
        request.signal = Some(source.signal());
        request.recovery_key = Some(json!(format!(
            "chat:{chat}:message:{}",
            id(&input["clientMessageId"], "restored Task message")?
        )));
        request.recovery = Some(json!({
            "messageId":input["clientMessageId"], "threadId":thread, "turnId":turn, "taskInput":input,
        }));
        let ack = json!({"type":"agent.task-resumed","controlId":restoration["controlId"],
            "inputOperationId":input["operationId"],"threadId":thread,"turnId":turn});
        request.on_native_bound = Some(Arc::new({
            let emit = emit.clone();
            let runtime = runtime.downgrade();
            let loaded = prepared.thread.clone();
            move || {
                loaded.assert_current(
                    &runtime
                        .upgrade()
                        .context("The Task runtime closed during native binding.")?,
                )?;
                // The persisted binding already belongs to this execution. A
                // disconnected requester cannot revoke the admitted turn.
                let _ = emit(ack.clone());
                Ok(())
            }
        }));
        let execution = match admission.acquire(request).await {
            Ok(execution) => execution,
            Err(error) => {
                source.close();
                return Err(failed("admit", error));
            }
        };
        let observe_cua: Option<output::ComputerUseObserver> =
            params::computer_use_enabled(command).then(Arc::default);
        let (subscription, mut events, capture) = match output::subscribe_with_context(
            &runtime.history(),
            thread,
            None,
            observe_cua.clone(),
        ) {
            Ok(observer) => observer,
            Err(error) => {
                let cleanup = execution.not_dispatched();
                source.close();
                cleanup?;
                execution.settled().await?;
                return Err(failed("admit", error));
            }
        };
        let transport = subscription.signal();
        let mut observer = task.turn.checkpoint(command, capture);
        observer.restore_observer(saved);
        let _ = active.task.set(observer);
        let result = async {
            task.input.bind(&execution)?;
            let dispatch = async {
                execution.bind_thread(thread.clone())?;
                execution.bind_turn(turn.clone())?;
                execution.seal_input_dispatch().await?;
                let activation = self.preparation.activate(prepared, &command["executionLaneId"])?;
                self.task_inputs.authorize(owner, server, input, "dispatch", None, signal.clone()).await?;
                current()?;
                selected.confirm_held(checkpoint).await?;
                current()?;
                if let Some((_, commit)) = &task.goal_commit {
                    let cycle = self.task_goal_cycle(command, &task.key, prepared, emit.clone(), commit, &restoration["source"]);
                    runtime.inference_router().restore_task_goal(thread, &prepared.runner_generation,
                        &id(&restoration["source"]["clientMessageId"], "restored Goal parent")?, cycle)?;
                }
                let cua = if let Some(observer) = &observe_cua {
                    let epoch = epoch.context("Computer use requires the Task command socket.")?;
                    let lifetime = computer_use::Turn::new(
                        self.computer_use.clone(), epoch, runtime, thread.clone(), emit.clone(),
                        computer_use::Publication::Task(task.turn.messages()),
                        Signal::any(vec![signal.clone(), transport.clone()]),
                    );
                    let binding = activation.as_ref().context("The restored Task's computer-use MCP attachment is unavailable.")?;
                    lifetime.0.register(binding, &command["computerUseAuthority"])?;
                    let _ = observer.set(Arc::downgrade(&lifetime.0));
                    Some(lifetime)
                } else { None };
                let native_interactions = if !super::is_structured(command) {
                    let interactions = runtime.interaction_requests(thread, prepared.environment.is_none())?;
                    interactions.bind_turn(turn)?;
                    Some(interactions)
                } else { None };
                active.dispatch(signal, thread.clone())?;
                execution.dispatched()?;
                active.set(Phase::Running {runtime:runtime.clone(),thread:thread.clone(),turn:turn.clone()});
                if let Some(cua) = &cua {
                    cua.0.dispatched();
                    cua.0.started(turn);
                }
                Ok::<_, anyhow::Error>((activation, cua, native_interactions))
            };
            let (_mcp, cua, mut native_interactions) =
                dispatch.await.map_err(|error| failed("dispatch", error))?;
            let response = runtime.request(
                "turn/suspension".into(),
                Some(json!({"threadId":thread,"operation":json!({"type":"resume","suspension":checkpoint})})),
                Some(BOUNDARY_TIMEOUT), None,
            ).await;
            match response {
                Ok(Some(reply)) if reply["paused"] == false && &reply["suspension"] == checkpoint => {}
                Err(error) if error.downcast_ref::<super::super::Failure>().is_some_and(|native| native.native_error.is_some()) => {
                    execution.rejected()?;
                    return Err(failed("resume", error));
                }
                // Disconnect or an unexpected acknowledgement does not establish
                // terminal state. Continue collecting from the exact native owner.
                _ => {}
            }
            let messages = task.turn.events(emit.clone());
            let collecting = output::collect_restored(&mut events, &transport, thread, turn, &messages, saved, true);
            let terminal = if let Some(interactions) = &mut native_interactions {
                interactions::Turn {
                    runtime,
                    authority: interactions::Authority::Task(&task.key, &task.input),
                    thread, turn, thread_version: selected.thread_version,
                    encryption: &self.encryption, emit: &emit, protected: true,
                }.observe(&task.input.interactions, &mut interactions.events, collecting).await
            } else { collecting.await };
            drop(native_interactions);
            active.set(Phase::Terminal);
            let cua_finished = if let Some(cua) = &cua {
                cua.0.finish().await
            } else { Ok(()) };
            if transport.check().is_err() { runtime.retired().await?; }
            execution.settled().await?;
            let terminal = terminal.map_err(|error| failed("complete", error))?;
            cua_finished.map_err(|error| failed("complete", error))?;
            task.restored_finished = true;
            task.turn.finish(terminal.result?).map_err(|error| failed("complete", error))
        }.await;
        subscription.close();
        let cleanup = execution.not_dispatched();
        source.close();
        cleanup?;
        execution.settled().await?;
        result
    }

    async fn open_task_checkpoint(&self, command: &Value, task: &TaskTurn) -> Result<Opened> {
        let restore = checked("taskTurnResumptionSchema", &command["taskResumption"])?;
        let source = &restore["source"];
        let cycle = &restore["goalCycle"];
        let route = if cycle.is_null() {
            source
        } else {
            &cycle["cycle"]
        };
        let input = &command["taskInferenceInput"];
        let evidence = &restore["checkpoint"];
        let expected = &evidence["suspension"];
        if [
            "workerId",
            "executionLaneId",
            "worktreeId",
            "chatId",
            "clientMessageId",
            "executionLaneActivatedAt",
        ]
        .iter()
        .any(|key| input[*key] != source[*key])
            || input["modelRouteId"] != route["modelRouteId"]
            || input["providerAccountId"] != route["providerAccountId"]
            || input["providerId"] != command["provider"]["id"]
            || command["model"]["routeId"] != route["modelRouteId"]
            || command["provider"]["accountId"] != route["providerAccountId"]
            || command["threadId"] != expected["threadId"]
        {
            bail!("The restored Task changed its saved source or runtime.");
        }
        let mut binding = json!({
            "chatId":command["chatId"],"threadId":expected["threadId"],"contextKind":"project",
            "projectId":command["policyProjectId"],"placementId":source["worktreeId"],
            "modelRouteId":route["modelRouteId"],"providerAccountId":route["providerAccountId"],
        });
        if cycle.is_null() {
            binding["taskInput"] = source.clone();
        } else {
            binding["taskGoalCycle"] = cycle.clone();
        }
        let mut opened = self
            .suspensions
            .open(
                evidence["storageId"]
                    .as_str()
                    .context("Invalid saved Task storage ID")?,
                &binding,
            )
            .await?;
        let saved = &mut opened.continuation;
        if !cycle.is_null() && saved["cwd"] != command["cwd"] {
            saved["cwd"] = self
                .preparation
                .resolve_routing(&json!({"cwd":saved["cwd"]}))
                .await?["cwd"]
                .clone();
        }
        let protected = opened
            .task_continuation
            .as_ref()
            .context("Missing protected Task continuation")?;
        let mode = &command["resultMode"];
        let matches = if mode["kind"] == "task-encrypted" {
            protected["version"] == 1 && protected["request"] == mode["operation"]
        } else {
            protected["version"] == 2
                && protected["prompt"] == command["protectedTaskPrompt"]
                && protected["publication"]["id"] == mode["messageId"]
                && protected["publication"]["idempotencyKey"] == mode["idempotencyKey"]
        };
        if !matches
            || opened.evidence != *evidence
            || saved["threadId"] != expected["threadId"]
            || saved["turnId"] != expected["turnId"]
            || saved["chatId"] != command["chatId"]
            || saved["cwd"] != command["cwd"]
            || saved["providerId"] != command["provider"]["id"]
            || saved["providerKind"] != command["provider"]["kind"]
            || saved["executionKind"] != "chat"
        {
            bail!("The protected Task continuation does not match its original turn.");
        }
        task.turn.restore_output(&protected["events"])?;
        Ok(opened)
    }
}
