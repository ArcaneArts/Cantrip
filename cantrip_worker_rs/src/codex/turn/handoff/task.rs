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
