//! Reopen the retained Task Goal and observe a real private inference enqueue.
use super::{
    super::{Emit, Key, Scope, Turns, goal_recovery::read_native_goal, id},
    cycle::{Checkpoints, GoalCycle},
};
use crate::{
    codex::{
        managed::Worker,
        preparation::{Intent, command::Prepared},
        rpc_requests::Failure,
    },
    http::checked,
    inference::admission::Promise,
    metadata::{Guard, Signal},
};
use anyhow::{Result, bail, ensure};
use cantrip_history::content::Encryption;
use cantrip_wire::{JsString, Value, value::json};
use std::{sync::Arc, time::Duration};
use tokio::sync::{Mutex, watch};

pub(crate) const COMMAND: &str = "task.goal.recover";

impl Turns {
    pub(crate) async fn recover_task_goal(
        &self,
        command: &Value,
        worker: &Worker,
        signal: Signal,
    ) -> Result<Value> {
        let recovery = checked("taskGoalCycleRecoverySchema", &command["recovery"])?;
        let binding = recovery.get("binding").unwrap_or(&recovery["cycle"]);
        ensure!(
            recovery["settled"].is_null()
                && recovery["suspension"].is_null()
                && recovery["workerId"].as_js_string() == Some(self.encryption.worker_id())
                && recovery["threadId"] == command["threadId"]
                && recovery["providerId"] == command["provider"]["id"]
                && binding["modelRouteId"] == command["model"]["routeId"]
                && binding["providerAccountId"] == command["provider"]["accountId"],
            "The Task Goal recovery belongs to another native source."
        );
        let scope = Scope::new(self.encryption.clone())?;
        let chat = id(&command["chatId"], "Task Goal recovery chat")?;
        let manager = worker.inference_manager(&scope.owner, &scope.server)?;
        let hold = manager.begin_goal_recovery_preparation(
            chat.clone(),
            id(&command["provider"]["id"], "Task Goal recovery provider")?,
            recovery.clone(),
        );
        let result = async {
            let guard = Guard::metadata_timeout(Some(signal), None, Duration::from_secs(8));
            guard.run(manager.confirm_native_ownership()).await?;
            let key = (scope.owner.clone(), scope.server.clone(), chat);
            let mut command = command.clone();
            command["taskOwned"] = json!(true);
            command["taskGoalPermissions"] = json!(true);
            command["taskCycleId"] = recovery["cycle"]["cycleId"].clone();
            command["session"] = json!({
                "chatId":command["chatId"], "contextKind":"project",
                "projectId":command["projectId"],"worktreeId":command["worktreeId"],
                "rootKind":command["rootKind"],"scratchRootId":Value::Null,
                "computerUseEnabled":command["computerUseEnabled"],
            });
            if let Some(os) = command.get("osExecution").cloned() {
                command["session"]["osExecution"] = os;
            }
            let resolved = self.preparation.resolve_routing(&command).await?;
            let route = json!({
                "cycleId":recovery["cycle"]["cycleId"],"modelRouteId":binding["modelRouteId"],
                "providerAccountId":binding["providerAccountId"],"orderEpoch":binding["orderEpoch"],
            });

            let chat = &key.2;
            let (thread, runner, runtime, observer) = if let Some(live) = self.live_task_goal(&resolved, &route)? {
                live
            } else {
                let prepared = guard.run(self.preparation.prepare(&resolved, Intent::Configure)).await?;
                let observer = self.install_task_cycle(&prepared, &resolved, key.clone(), route.clone(), None)?;
                (prepared.thread, prepared.runner_generation, prepared.runtime, observer)
            };
            let epoch = &recovery["cycle"]["goalEpoch"];
            let goal_epoch = id(epoch, "retained Task Goal epoch")?;
            let cycle = id(&route["cycleId"], "retained Task cycle")?;
            let scheduled = |admission: Value| {
                scope.identity()?;
                thread.assert_current(&runtime)?;
                checked("taskGoalCycleRecoveryReceiptSchema", &json!({
                    "status":"scheduled","admission":admission,
                    "sourceKey":recovery["sourceKey"],"workerGeneration":self.receipts.worker_generation(),
                }))
            };
            let queued = || runtime.admission().queued_task_goal_cycle(thread.id(), &cycle, &goal_epoch);
            if let Some(admission) = queued() {
                return scheduled(admission);
            }
            let (goal, observed, native_epoch) = read_native_goal(&runtime, &thread, &guard).await?;
            if &observed != epoch || goal["status"] != "active" {
                scope.identity()?;
                return checked("taskGoalCycleRecoveryReceiptSchema", &json!({
                    "status":"ineligible","threadId":thread.id(),"modelRouteId":route["modelRouteId"],
                    "providerAccountId":route["providerAccountId"],"nativeEpoch":native_epoch,
                    "observedGoalEpoch":observed,"observedGoalStatus":goal["status"],
                    "sourceKey":recovery["sourceKey"],"workerGeneration":self.receipts.worker_generation(),
                }));
            }
            manager.wake_recovery(Some(chat.clone()));
            if let Some(admission) = queued() {
                return scheduled(admission);
            }
            wake(&runtime, thread.id(), &runner, &guard).await?;
            let admission = guard.run(observer.wait_for_enqueue(epoch)).await.map_err(|error| {
                Failure::observation(format!("Task Goal queue was not acknowledged: {error}"))
            })?;
            scheduled(admission)
        }.await;
        match &result {
            Ok(_) => hold.succeeded(),
            Err(error)
                if error
                    .downcast_ref::<Failure>()
                    .is_some_and(|error| error.kind == "observation") =>
            {
                hold.unconfirmed()
            }
            Err(_) => hold.failed(),
        }
        result
    }

    pub(in crate::codex::turn) fn install_task_cycle(
        &self,
        prepared: &Prepared,
        command: &Value,
        key: Key,
        placement: Value,
        handoff_completed: Option<watch::Receiver<bool>>,
    ) -> Result<Arc<GoalCycle>> {
        prepared.thread.assert_current(&prepared.runtime)?;
        let emit: Emit = Arc::new(|_| Ok(()));
        let mut seed = command.clone();
        seed["chatId"] = json!(key.2);
        let checkpoints = Checkpoints::new(&seed);
        prepared
            .runtime
            .inference_router()
            .attach_task_goal_recovery(
                prepared.thread.id(),
                &prepared.runner_generation,
                Arc::new(GoalCycle {
                    key,
                    parent: None,
                    placement,
                    project: command["session"]["projectId"].clone(),
                    worktree: command["session"]["worktreeId"].clone(),
                    enqueued: watch::channel(None).0,
                    handoff_completed,
                    encryption: self.encryption.clone(),
                    client: self.task_inputs.clone(),
                    outcomes: self.task_outcomes.clone(),
                    observation: prepared.runtime.history(),
                    activate: self.preparation.cycle_activation(prepared),
                    emit,
                    reuse_published_response: false,
                    previous: Mutex::new(Promise::ready(Ok(()))),
                    checkpoints,
                }),
            )
    }

    fn live_task_goal(
        &self,
        command: &Value,
        placement: &Value,
    ) -> Result<
        Option<(
            crate::codex::preparation::native::LoadedThread,
            JsString,
            crate::codex::managed::Runtime,
            Arc<GoalCycle>,
        )>,
    > {
        let scope = json!({
            "chatId":command["chatId"],"workerId":self.encryption.worker_id(),
            "threadId":command["threadId"],"contextKind":"project",
            "projectId":command["projectId"],"placementId":command["worktreeId"],
            "modelRouteId":placement["modelRouteId"],"providerAccountId":placement["providerAccountId"],
        });
        let Ok((thread, root, settings)) = self
            .preparation
            .task_goal_source(&scope, &placement["cycleId"])
        else {
            return Ok(None);
        };
        let runtime = settings.runtime()?;
        let Some(observer) = runtime
            .inference_router()
            .active_task_goal_cycle(thread.id(), &root.runner)
            .filter(|owner| owner.placement() == *placement)
        else {
            return Ok(None);
        };
        Ok(Some((thread, root.runner, runtime, observer)))
    }
}

pub(in crate::codex::turn) async fn wake(
    runtime: &crate::codex::managed::Runtime,
    thread: &JsString,
    runner: &JsString,
    guard: &Guard,
) -> Result<()> {
    let reply = super::super::goal_recovery::native(
        runtime,
        "thread/managedExecution/wake",
        json!({"threadId":thread,"runnerGeneration":runner}),
        guard,
    )
    .await?;
    if !reply["scheduled"].is_boolean() {
        bail!("Codex did not acknowledge the Task Goal wake.");
    }
    Ok(())
}
