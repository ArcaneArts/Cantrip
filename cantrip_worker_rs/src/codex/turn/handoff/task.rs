//! Capture the current keeper-owned Task Goal source for Core's handoff.
use crate::{
    codex::turn::{
        Turns,
        goal_recovery::{native, read_native_goal},
        id,
    },
    http::checked,
    metadata::{Guard, Signal},
};
use anyhow::{Result, ensure};
use cantrip_history::content::Encryption;
use cantrip_wire::{Value, value::json};
use std::{sync::Arc, time::Duration};

pub(crate) const TASK_SOURCE: &str = "task.goal.source";

impl Turns {
    pub(crate) async fn capture_task_goal(&self, command: &Value, signal: Signal) -> Result<Value> {
        let scope = checked("nativeSettingsReadScopeSchema", &command["scope"])?;
        let cycle = id(&command["cycleId"], "Task Goal cycle")?;
        let chat = id(&scope["chatId"], "Task Goal chat")?;
        let input = command
            .get("input")
            .map(|value| checked("taskInferenceInputReceiptSchema", value))
            .transpose()?;
        ensure!(
            scope["contextKind"] == "project"
                && input.as_ref().is_none_or(|input| {
                    input["kind"] == "goal"
                        && ["chatId", "workerId", "modelRouteId", "providerAccountId"]
                            .iter()
                            .all(|field| input[*field] == scope[*field])
                        && input["worktreeId"] == scope["placementId"]
                        && input["dispatch"]["cycleId"] == command["cycleId"]
                }),
            "The Task Goal input does not match its current root."
        );
        let (thread, root, settings) = self
            .preparation
            .task_goal_source(&scope, &command["cycleId"])?;
        let guard = Guard::metadata_timeout(Some(signal.clone()), None, Duration::from_secs(10));
        let runtime = settings.runtime()?;
        let adapter = runtime.admission();
        let capture = || async {
            let (record, queue_revision) = if let Some(input) = &input {
                let value = guard
                    .run(adapter.capture_task_goal_input_source(input.clone()))
                    .await?;
                (value["record"].clone(), value["queueRevision"].clone())
            } else {
                let record = guard
                    .run(adapter.capture_task_goal_source(
                        chat.clone(),
                        thread.id().clone(),
                        cycle.clone(),
                    ))
                    .await?;
                (record, Value::Null)
            };
            ensure!(
                record["identity"]["runtimeGeneration"].as_js_string()
                    == Some(adapter.generation())
                    && record["identity"]["recovery"]["threadId"].as_js_string()
                        == Some(thread.id())
                    && record["workerGeneration"] == self.receipts.worker_generation(),
                "The keeper captured another Task Goal producer."
            );
            Ok::<_, anyhow::Error>((record, queue_revision))
        };

        let (first, _) = capture().await?;
        let snapshot = guard.run(settings.read(signal)).await?;
        let (goal, goal_epoch, native_epoch) = read_native_goal(&runtime, &thread, &guard).await?;
        ensure!(
            goal["status"] == "active"
                && !goal_epoch.is_null()
                && snapshot["context"]["runtimeGeneration"] == runtime.generation()
                && snapshot["context"]["settingsVersion"]["epoch"] == native_epoch,
            "The native Task Goal changed during source capture."
        );
        if input.is_none() {
            let recovery = &first["identity"]["recovery"];
            let cycle = &recovery["taskGoalCycle"];
            ensure!(
                cycle["goalEpoch"] == goal_epoch
                    && cycle["runnerGeneration"].as_js_string() == Some(&root.runner),
                "The captured cycle belongs to another Task Goal producer."
            );
            let claim = native(
                &runtime,
                "thread/managedExecution/inferenceClaim",
                json!({
                    "threadId":thread.id(),"turnId":recovery["turnId"],"scopeId":cycle["scopeId"],
                    "runnerGeneration":root.runner,"attemptId":cycle["gateAttemptId"],
                }),
                &guard,
            )
            .await?;
            ensure!(
                claim["claimed"] == true
                    && claim["inferenceOnly"] == true
                    && claim["goalEpoch"] == goal_epoch,
                "Codex no longer owns the captured Task Goal cycle."
            );
        }
        let (record, queue_revision) = capture().await?;
        let (_, _, current) = self
            .preparation
            .task_goal_source(&scope, &command["cycleId"])?;
        ensure!(
            record["key"] == first["key"] && Arc::ptr_eq(&current, &settings),
            "The Task Goal source changed during its native ownership read."
        );
        settings.assert_current()?;
        let mut result = json!({"record":record,"snapshot":snapshot});
        if let Some(input) = input {
            let order_epoch = root.latch.order_epoch(&root.binding, &command["cycleId"]);
            result["taskGoalInput"] = json!({
                "goalEpoch":goal_epoch,"runnerGeneration":root.runner,
                "orderEpoch":order_epoch.max(input["queueOrderEpoch"].as_u64().unwrap_or(0)),
                "sourceQueueRevision":queue_revision,
            });
        }
        checked("taskGoalHandoffCaptureSchema", &result)
    }
}

use super::{Transfer, journal, withdrawal::SourceUnavailable};
use crate::{
    codex::{
        managed::Runtime,
        preparation::native::LoadedThread,
        private_inference::{Pending, Phase as GatePhase},
        task_pause::Root,
        turn::Phase,
    },
    inference::{
        admission::{AdmissionError, Promise},
        withdrawal::Withdrawal,
    },
};
use anyhow::Context;
use cantrip_wire::JsString;

#[derive(Clone)]
pub(super) struct WithdrawalAttempt {
    source_key: Value,
    withdrawal: Withdrawal,
    proof: Promise<Value>,
    pending: Option<Pending>,
}

fn cycle_id(queued: &Value) -> &Value {
    let recovery = &queued["taskGoal"]["identity"]["recovery"];
    if queued["taskGoalInput"].is_object() {
        &recovery["taskInput"]["dispatch"]["cycleId"]
    } else {
        &recovery["taskGoalCycle"]["cycleId"]
    }
}

pub(super) fn prepare_configuration(state: &Value, configuration: &mut Value) -> Result<()> {
    let task = configuration["task"].clone();
    let queued = &state["queuedSource"];
    ensure!(
        queued["taskGoal"].is_object()
            && task["projectId"] == state["source"]["projectId"]
            && task["worktreeId"] == state["source"]["placementId"]
            && task["cycleId"] == *cycle_id(queued),
        "The Task handoff configuration belongs to another Task."
    );
    let mut session = json!({
        "contextKind":"project","chatId":task["chatId"],"projectId":task["projectId"],
        "worktreeId":task["worktreeId"],"rootKind":task["rootKind"],"scratchRootId":Value::Null,
        "computerUseEnabled":task["computerUseEnabled"],
    });
    if let Some(os) = task.get("osExecution") {
        session["osExecution"] = os.clone();
    }
    configuration["session"] = session;
    configuration["taskOwned"] = json!(true);
    configuration["taskCycleId"] = task["cycleId"].clone();
    configuration["taskGoalPermissions"] = json!(true);
    if queued["taskGoalInput"].is_object() {
        configuration["taskGoalFirstInput"] =
            queued["taskGoal"]["identity"]["recovery"]["taskInput"]["clientMessageId"].clone();
    }
    Ok(())
}

impl Transfer {
    pub(super) async fn publish_task_goal(
        &self,
        state: &Value,
        config: &Value,
        prepared: &super::Prepared,
    ) -> Result<()> {
        if !config["task"].is_object() {
            return Ok(());
        }
        self.check()?;
        let chat = id(&state["chatId"], "transferred Task Goal chat")?;
        let manager = self
            .worker
            .inference_manager(&self.identity.owner, &self.identity.server)?;
        manager.wake_recovery(Some(chat.clone()));
        if state["queuedSource"]["taskGoalInput"].is_object() {
            return Ok(());
        }
        let guard = Guard::request(Some(self.signal.clone()));
        let (goal, epoch, _) =
            read_native_goal(&prepared.runtime, &prepared.thread, &guard).await?;
        if epoch != config["task"]["goalEpoch"] || goal["status"] != "active" {
            return Ok(());
        }
        let config = self.turns.preparation.resolve_routing(config).await?;
        self.turns.install_task_cycle(
            prepared,
            &config,
            (self.identity.owner.clone(), self.identity.server.clone(), chat),
            json!({
                "cycleId":config["task"]["cycleId"],"modelRouteId":config["model"]["routeId"],
                "providerAccountId":config["provider"]["accountId"],"orderEpoch":config["task"]["orderEpoch"],
            }),
        )?;
        crate::codex::turn::task::recovery::wake(
            &prepared.runtime,
            prepared.thread.id(),
            &prepared.runner_generation,
            &guard,
        )
        .await?;
        self.check()
    }

    pub(super) async fn resume_cancelled_task_root(
        &self,
        state: &Value,
        prepared: &super::Prepared,
    ) -> Result<()> {
        let queued = &state["queuedSource"];
        if !queued["taskGoal"].is_object() {
            return Ok(());
        }
        if queued["taskGoalInput"].is_null() {
            let expected =
                &queued["taskGoal"]["identity"]["recovery"]["taskGoalCycle"]["goalEpoch"];
            let guard = Guard::request(Some(self.signal.clone()));
            let (goal, epoch, _) =
                read_native_goal(&prepared.runtime, &prepared.thread, &guard).await?;
            if &epoch == expected && goal["status"] == "active" {
                let reply = self.native(prepared, "thread/managedExecution/wake", json!({
                    "threadId":prepared.thread.id(),"runnerGeneration":prepared.runner_generation,
                })).await?;
                ensure!(
                    reply["scheduled"].is_boolean(),
                    "Codex did not acknowledge the restored Task Goal wake."
                );
            }
        }
        let chat = id(&state["chatId"], "Task handoff chat")?;
        self.worker
            .inference_manager(&self.identity.owner, &self.identity.server)?
            .wake_recovery(Some(chat));
        Ok(())
    }

    pub(super) async fn withdraw_task(&self, state: Value) -> Result<Value> {
        if state["queuedSource"]["withdrawn"] == true {
            self.acknowledge_task_withdrawal(&state).await?;
            return Ok(state);
        }
        let journal = journal::Journal::new(self.data(), self.scope.clone(), state.clone())?;
        let record = match journal.saved_withdrawal().await? {
            Some(record) => record,
            None => {
                let proof = match self.capture_task_withdrawal(&state).await {
                    Ok(proof) => proof,
                    Err(refusal) if refusal.is::<SourceUnavailable>() => {
                        return self.action("decline-queued-source", json!({})).await;
                    }
                    Err(error) => return Err(error),
                };
                journal.save_withdrawal(&proof).await?;
                proof
            }
        };
        assert_proof(&state["queuedSource"]["taskGoal"], &record)?;
        let state = self.action("withdrawn", json!({"record":record})).await?;
        ensure!(
            state["queuedSource"]["withdrawn"] == true,
            "Core did not acknowledge the Task Goal withdrawal."
        );
        self.acknowledge_task_withdrawal(&state).await?;
        Ok(state)
    }

    fn live_task_source(&self, state: &Value) -> Result<Option<(LoadedThread, Runtime, Root)>> {
        let binding = state
            .get("binding")
            .filter(|value| !value.is_null())
            .unwrap_or(&state["source"]);
        let chat = id(&state["chatId"], "Task handoff chat")?;
        let bound = (self.identity.owner.clone(), json!(self.identity.server));
        let Some((_, owner)) = self
            .turns
            .preparation
            .selected_live_owner(&chat, &bound)
            .filter(|(_, owner)| binding["runtimeGeneration"] == owner.runtime.generation())
        else {
            return Ok(None);
        };
        let mut scope = binding.clone();
        if let Value::Object(fields) = &mut scope {
            for field in ["bindingId", "runtimeGeneration", "nativeEpoch"] {
                fields.shift_remove(field);
            }
        }
        let (thread, root, source) = self
            .turns
            .preparation
            .task_goal_source(&scope, cycle_id(&state["queuedSource"]))?;
        let runtime = source.runtime()?;
        ensure!(
            runtime.generation() == owner.runtime.generation(),
            "The Task source changed during withdrawal."
        );
        Ok(Some((thread, runtime, root)))
    }

    async fn capture_task_withdrawal(&self, state: &Value) -> Result<Value> {
        self.check()?;
        let queued = &state["queuedSource"];
        let source = &queued["taskGoal"];
        let manager = self
            .worker
            .inference_manager(&self.identity.owner, &self.identity.server)?;
        let guard = Guard::request(Some(self.signal.clone()));
        let live = self.live_task_source(state)?;
        let existing = self.task_withdrawal();
        let attempt = if let Some(existing) = existing {
            ensure!(
                existing.source_key == source["key"],
                "The Task transfer changed its reservation."
            );
            Some(existing)
        } else if let Some((thread, runtime, root)) = &live
            && state["cancelRequested"] != true
        {
            match self.begin_task_withdrawal(queued, thread, runtime, &root.runner) {
                Ok(attempt) => Some(attempt),
                Err(error) if error.is::<SourceUnavailable>() => None,
                Err(error) => return Err(error),
            }
        } else {
            None
        };
        let record = if let Some(attempt) = &attempt {
            guard.run(attempt.proof.work()).await?
        } else {
            let record = guard
                .run(manager.task_goal_withdrawal_record(source.clone()))
                .await?;
            match record {
                Some(record) => record,
                None if live.is_some() || state["cancelRequested"] == true => {
                    return Err(SourceUnavailable.into());
                }
                None => anyhow::bail!("The retired Task source has no keeper withdrawal receipt."),
            }
        };
        assert_proof(source, &record)?;
        if let Some((thread, runtime, root)) = live {
            let operation =
                journal::operation_id(&state["operationId"]).context("Task handoff operation")?;
            self.control_producer(&runtime, &thread, &root.runner, "hold", operation)
                .await?;
            if queued["taskGoalInput"].is_object() {
                self.deny_parked_task_cycles(
                    &runtime,
                    &thread,
                    &root,
                    &queued["taskGoalInput"]["goalEpoch"],
                )
                .await?;
            }
        }
        Ok(record)
    }

    fn begin_task_withdrawal(
        &self,
        queued: &Value,
        thread: &LoadedThread,
        runtime: &Runtime,
        runner: &JsString,
    ) -> Result<WithdrawalAttempt> {
        let source = &queued["taskGoal"];
        let recovery = &source["identity"]["recovery"];
        let adapter = runtime.admission();
        ensure!(
            recovery["threadId"].as_js_string() == Some(thread.id())
                && source["identity"]["runtimeGeneration"].as_js_string()
                    == Some(adapter.generation()),
            "The Task reservation no longer matches the captured runtime."
        );
        let withdrawal = Withdrawal::new();
        let (proof, pending) = if queued["taskGoalInput"].is_object() {
            let revision = queued["taskGoalInput"]["sourceQueueRevision"]
                .as_u64()
                .context("Task input queue revision")?;
            (
                adapter.withdraw_task_goal_input_source(source, withdrawal.clone(), revision),
                None,
            )
        } else {
            let cycle = &recovery["taskGoalCycle"];
            let pending = runtime
                .inference_router()
                .pending()
                .into_iter()
                .find(|pending| {
                    let gate = pending.gate();
                    gate.phase == GatePhase::Begin
                        && gate.root_thread() == thread.id()
                        && gate.key.thread_id == *thread.id()
                        && gate.key.runner_generation == *runner
                        && cycle["runnerGeneration"].as_js_string() == Some(runner)
                        && cycle["scopeId"].as_js_string() == Some(&gate.scope_id)
                        && cycle["gateAttemptId"].as_js_string() == Some(&gate.key.attempt_id)
                        && recovery["turnId"].as_js_string() == Some(&gate.key.turn_id)
                        && cycle["goalEpoch"].as_js_string() == gate.goal_epoch.as_ref()
                })
                .ok_or(SourceUnavailable)?;
            (
                adapter.withdraw_task_goal_source(source, withdrawal.clone()),
                Some(pending),
            )
        };
        let proof = proof.map_err(|error| {
            if error.chain().any(|cause| {
                cause
                    .downcast_ref::<AdmissionError>()
                    .is_some_and(|error| error.unstarted_unavailable)
            }) {
                SourceUnavailable.into()
            } else {
                error
            }
        })?;
        let attempt = WithdrawalAttempt {
            source_key: source["key"].clone(),
            withdrawal,
            proof: Promise::spawn(proof),
            pending,
        };
        self.turns
            .handoffs
            .retained
            .lock()
            .unwrap()
            .entry(self.local_key.clone())
            .or_default()
            .task_withdrawal = Some(attempt.clone());
        Ok(attempt)
    }

    fn task_withdrawal(&self) -> Option<WithdrawalAttempt> {
        self.turns
            .handoffs
            .retained
            .lock()
            .unwrap()
            .get(&self.local_key)?
            .task_withdrawal
            .clone()
    }

    async fn deny_parked_task_cycles(
        &self,
        runtime: &Runtime,
        thread: &LoadedThread,
        root: &Root,
        epoch: &Value,
    ) -> Result<()> {
        let router = runtime.inference_router();
        for pending in router.pending() {
            let gate = pending.gate();
            if gate.root_thread() == thread.id()
                && gate.key.thread_id == *thread.id()
                && gate.key.runner_generation == root.runner
                && epoch.as_js_string() == gate.goal_epoch.as_ref()
            {
                let runtime = runtime.clone();
                let thread = thread.clone();
                let scope = crate::chat_content::Scope::new(self.turns.encryption.clone())?;
                ensure!(
                    scope.owner == self.identity.owner && scope.server == self.identity.server,
                    "The Task handoff worker binding changed before native denial."
                );
                let signal = self.signal.clone();
                router
                    .deny_for_first_input(&pending, move || {
                        signal.check()?;
                        scope.identity()?;
                        thread.assert_current(&runtime)
                    })
                    .await?;
            }
        }
        Ok(())
    }

    async fn acknowledge_task_withdrawal(&self, state: &Value) -> Result<()> {
        let Some(attempt) = self.task_withdrawal() else {
            return Ok(());
        };
        let source = &state["queuedSource"]["taskGoal"];
        ensure!(
            attempt.source_key == source["key"],
            "The Task withdrawal acknowledges another source."
        );
        let manager = self
            .worker
            .inference_manager(&self.identity.owner, &self.identity.server)?;
        let guard = Guard::request(Some(self.signal.clone()));
        let proof = guard
            .run(manager.task_goal_withdrawal_record(source.clone()))
            .await?
            .context("The Task withdrawal lost its keeper settlement")?;
        assert_proof(source, &proof)?;
        attempt.withdrawal.acknowledge();
        if let Some(pending) = attempt.pending {
            guard.run(pending.denied()).await?;
        } else {
            let chat = id(&state["chatId"], "Task handoff chat")?;
            let key = (
                self.identity.owner.clone(),
                self.identity.server.clone(),
                chat,
            );
            let active = self
                .turns
                .active
                .lock()
                .unwrap()
                .active
                .get(&key)
                .filter(|active| {
                    active.task_input.as_ref().is_some_and(|input| {
                        input.operation() == &source["identity"]["operationId"]
                    })
                })
                .cloned();
            if let Some(active) = active {
                let mut changed = active.changed.subscribe();
                guard
                    .run(async {
                        while !matches!(*active.phase.lock().unwrap(), Phase::Finished) {
                            changed.changed().await?;
                        }
                        Ok(())
                    })
                    .await?;
            }
        }
        self.check()
    }
}

fn assert_proof(source: &Value, record: &Value) -> Result<()> {
    ensure!(
        ["key", "workerGeneration", "identity", "order"]
            .iter()
            .all(|field| record[*field] == source[*field])
            && record["state"] == "released"
            && record["outcome"] == "never-started",
        "The Task withdrawal has no exact durable no-start proof."
    );
    Ok(())
}
