//! Only an explicit user Resume may acquire fresh authority for a saved Task.
use super::*;
use crate::{
    chats::{automation_pause::ResumeTaskSuspension, live_mutations::Service as Live},
    native_commands,
    workers::command_bus::{LimitedCommandBus, RequestTimeout},
};
use futures::FutureExt;
use std::sync::{Mutex, Weak};
use tokio::sync::oneshot;

pub struct Dependencies {
    pub database: Arc<Database>,
    pub routing: Arc<crate::chats::routing::ModelRouting>,
    pub claimed: Weak<super::claimed_execution::Service>,
    pub eligibility: Arc<super::eligibility::Service>,
    pub commands: Arc<LimitedCommandBus>,
    pub live: Arc<Live>,
    pub lease_owner: String,
}
type ControlLocks = HashMap<(String, String), Weak<tokio::sync::Mutex<()>>>;
pub struct Service {
    dependencies: Dependencies,
    controls: Mutex<ControlLocks>,
}
impl Service {
    pub fn handlers(dependencies: Dependencies) -> (ResumeTaskSuspension, ResumeTaskSuspension) {
        let service = Arc::new(Self {
            dependencies,
            controls: Mutex::default(),
        });
        let resumed = service.clone();
        (
            Arc::new(move |owner, chat, state, intent| {
                let service = resumed.clone();
                async move { service.resume(&owner, &chat, &state, &intent).await }.boxed()
            }),
            Arc::new(move |owner, chat, state, intent| {
                let service = service.clone();
                async move { service.stop(&owner, &chat, &state, &intent).await }.boxed()
            }),
        )
    }
    async fn stop(
        &self,
        owner: &str,
        chat: &str,
        expected: &Value,
        intent: &Value,
    ) -> Result<Value> {
        let native = native_commands::Repository::new(self.dependencies.database.clone());
        let prepared = native
            .prepare_task_stop(owner, chat)
            .await?
            .context("Task Stop source unavailable")?;
        if prepared["stop"].is_null() {
            return Ok(json!({"interrupted":true}));
        }
        anyhow::ensure!(
            prepared["state"]["controlId"] == expected["controlId"],
            "The Task Stop was superseded."
        );
        let context = &prepared["context"];
        let mut stop = prepared["stop"].clone();
        stop["scope"] = intent["scope"].clone();
        stop["cwd"] = context["cwd"].clone();
        stop["permissionProfileId"] =
            crate::chats::managed_console::permission_profile(context)["effectiveId"].clone();
        // A surviving native owner can cancel with its retained configuration.
        // A missing current route must not prevent that actual cancellation.
        if let Ok(runtime) = self
            .dependencies
            .routing
            .bound_managed_runtime(owner, context)
            .await
        {
            stop["model"] = runtime["model"].clone();
            stop["provider"] = runtime["provider"].clone();
        }
        let result = self.dependencies.commands.request_with_timeout(&text(&intent["scope"]["workerId"])?,
            json!({"type":"chat.interrupt","executionProfile":"ide","chatId":chat,"threadId":stop["active"]["threadId"],"taskStop":stop}),
            RequestTimeout::Disabled, None).await?.context("Task Stop acknowledgement missing")?;
        let saved = native
            .acknowledge_task_stop(owner, chat, &prepared["stop"], &intent["scope"], &result)
            .await?;
        self.dependencies
            .live
            .publish_summary(owner, &json!(chat), &saved["target"]["projectId"]);
        Ok(json!({"interrupted":true}))
    }
    async fn resume(
        &self,
        owner: &str,
        chat: &str,
        expected: &Value,
        _intent: &Value,
    ) -> Result<Value> {
        let lock = {
            let mut controls = self.controls.lock().unwrap();
            controls.retain(|_, lock| lock.strong_count() > 0);
            let entry = controls
                .entry((owner.to_owned(), chat.to_owned()))
                .or_default();
            if let Some(lock) = entry.upgrade() {
                lock
            } else {
                let lock = Arc::new(tokio::sync::Mutex::new(()));
                *entry = Arc::downgrade(&lock);
                lock
            }
        };
        let _guard = lock.lock().await;
        let chats = crate::chats::Repository::new(self.dependencies.database.clone());
        let native = native_commands::Repository::new(self.dependencies.database.clone());
        let expected_now = chats
            .native_suspension(owner, chat)
            .await?
            .context("Task suspension missing")?;
        anyhow::ensure!(
            expected_now["controlId"] == expected["controlId"],
            "The Task Resume was superseded."
        );
        let intent = chats
            .task_pause_intent(owner, chat)
            .await?
            .context("Task source missing")?;
        anyhow::ensure!(
            intent["paused"] == false,
            "A newer Task pause superseded Resume."
        );
        let receipt = self.dependencies.commands.request_with_timeout(&text(&intent["scope"]["workerId"])?,
            json!({"type":"chat.pause.set","chatId":chat,"paused":false,"task":intent["scope"]}),
            RequestTimeout::Disabled, None).await?;
        let receipt = parse(
            "taskPauseRuntimeStateSchema",
            receipt.as_ref().unwrap_or(&Value::Null),
        )?;
        anyhow::ensure!(
            receipt["paused"] == false,
            "A newer Task pause superseded Resume."
        );
        if !receipt["active"].is_null() {
            let state = native
                .acknowledge_task_suspension(owner, chat, &intent, &expected_now, &receipt)
                .await?;
            self.dependencies.live.publish_summary(
                owner,
                &json!(chat),
                &state["target"]["projectId"],
            );
            return Ok(
                json!({"paused":false,"active":state["active"],"nativeSuspension":crate::chats::native_suspensions::stored_summary(&state)}),
            );
        }
        let restore = native
            .task_resumption(owner, chat, &text(&expected["controlId"])?)
            .await?;
        let dispatch = crate::task_dispatch::Repository::new(self.dependencies.database.clone());
        let resolve = self
            .dependencies
            .eligibility
            .prepare_resume(owner.to_owned())
            .await?;
        let claim = dispatch.resume_next_paused(owner, &self.dependencies.lease_owner, resolve,
            &json!({"nativeSuspension":json!({"chatId":chat,"controlId":expected["controlId"]})})).await?
            .context("The paused Task could not acquire its current dispatch lease.")?;
        let (send, ready) = oneshot::channel();
        let send = Arc::new(Mutex::new(Some(send)));
        let signal: crate::chats::turn_runtime::engine::TaskRestored = Arc::new(move |result| {
            if let Some(send) = send.lock().unwrap().take() {
                let _ = send.send(result);
            }
        });
        let result: Result<Value> = async {
            self.dependencies.claimed.upgrade().context("Task launcher unavailable")?
                .restore(owner, &claim, &restore, signal).await?;
            ready.await.context("Task restoration ended before its native acknowledgement.")?
                .map_err(|error| anyhow::anyhow!(error.to_string()))?;
            let state = chats.native_suspension(owner, chat).await?.context("Task Resume acknowledgement missing")?;
            let intent = chats.task_pause_intent(owner, chat).await?;
            self.dependencies.live.publish_summary(owner, &json!(chat), &state["target"]["projectId"]);
            Ok(json!({"paused":intent.as_ref().map(|v|v["paused"].clone()).unwrap_or(json!(true)),
                "active":state["active"],"nativeSuspension":crate::chats::native_suspensions::stored_summary(&state)}))
        }.await;
        if result.is_err() {
            if let Err(error) = dispatch
                .pause(
                    &claim["lease"],
                    &json!({"threadId":restore["checkpoint"]["suspension"]["threadId"],
                "turnId":restore["checkpoint"]["suspension"]["turnId"]}),
                    &Value::Null,
                    false,
                )
                .await
            {
                if error
                    .downcast_ref::<crate::task_dispatch::Conflict>()
                    .is_none()
                {
                    return Err(error);
                }
            }
        }
        result
    }
}
