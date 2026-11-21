//! Resume an existing managed Goal through its native producer. The recovery
//! reply observes a queued admission and does not own a physical turn.
mod claim;
pub(crate) use claim::COMMAND as CLAIM_COMMAND;

use super::{Key, RPC_TIMEOUT, Runtime, Scope, Turns, id};
use crate::{
    codex::{
        managed::Worker,
        preparation::{
            Intent,
            command::{Prepared, native_session},
            native::LoadedThread,
        },
        rpc_requests::Failure,
    },
    http::checked,
    metadata::{Guard, Signal},
};
use anyhow::{Context, Result, bail, ensure};
use cantrip_history::content::Encryption;
use cantrip_wire::{JsString, Value, payload_digest, value::json};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, Weak},
    time::Duration,
};
use tokio::sync::watch;

pub(crate) const COMMAND: &str = "chat.goal.recover";

#[derive(Clone, Default)]
pub(super) struct Observations(Arc<Mutex<HashMap<String, Weak<Observation>>>>);
pub(super) struct Observation(watch::Sender<Option<Value>>);

impl Observations {
    pub(super) fn observe(
        &self,
        key: &Key,
        recovery: &Value,
        runtime_generation: &str,
    ) -> Arc<Observation> {
        self.subscribe(
            key,
            runtime_generation,
            json!([
                json!(COMMAND),
                recovery["source"].clone(),
                order_epoch(recovery),
            ]),
        )
    }

    pub(super) fn observe_claim(
        &self,
        key: &Key,
        thread: &JsString,
        claim: &Value,
        runtime_generation: &str,
    ) -> Arc<Observation> {
        self.subscribe(
            key,
            runtime_generation,
            json!([
                json!(CLAIM_COMMAND),
                json!(thread),
                claim["claimId"].clone(),
                claim["operationId"].clone(),
                claim["operationGeneration"].clone(),
                claim["goalEpoch"].clone(),
            ]),
        )
    }

    fn subscribe(&self, key: &Key, runtime_generation: &str, source: Value) -> Arc<Observation> {
        let key = payload_digest(&json!([
            json!(key.0),
            json!(key.1),
            json!(key.2),
            json!(runtime_generation),
            source,
        ]));
        let mut observations = self.0.lock().unwrap();
        observations.retain(|_, observation| observation.strong_count() != 0);
        let entry = observations.entry(key).or_default();
        entry.upgrade().unwrap_or_else(|| {
            let observation = Arc::new(Observation(watch::channel(None).0));
            *entry = Arc::downgrade(&observation);
            observation
        })
    }
}

impl Observation {
    pub(super) fn queued(&self, admission: Value) {
        self.0.send_replace(Some(admission));
    }

    fn observed(&self) -> Option<Value> {
        self.0.borrow().clone()
    }

    async fn admission(&self) -> Result<Value> {
        let mut receiver = self.0.subscribe();
        let observed = receiver.wait_for(Option::is_some).await?;
        Ok(observed.clone().unwrap())
    }
}

pub(super) fn order_epoch(recovery: &Value) -> Value {
    recovery.get("orderEpoch").cloned().unwrap_or(json!(0))
}

struct Target {
    runtime: Runtime,
    thread: LoadedThread,
    session: Value,
}

impl Target {
    fn from_prepared(command: &Value, prepared: Prepared) -> Self {
        let session = native_session(command, &prepared.runtime, prepared.thread.id());
        Self {
            runtime: prepared.runtime,
            thread: prepared.thread,
            session,
        }
    }

    async fn wake(&self, guard: &Guard) -> Result<()> {
        let runner = self
            .runtime
            .inference_router()
            .goal_runner(self.thread.id())
            .context("The recovered Goal has no current native producer.")?;
        let result = native(
            &self.runtime,
            "thread/managedExecution/wake",
            json!({"threadId":self.thread.id(),"runnerGeneration":runner}),
            guard,
        )
        .await?;
        ensure!(
            result["scheduled"].is_boolean(),
            "Codex did not acknowledge the Goal recovery wake."
        );
        Ok(())
    }

    async fn wait(&self, observation: &Observation, guard: &Guard) -> Result<Value> {
        tokio::select! {
            result = guard.run(observation.admission()) => result,
            _ = self.runtime.retired() => bail!("The recovered Goal runtime retired before admission."),
        }
    }
}

impl Turns {
    fn live_goal_target(&self, command: &Value, scope: &Scope, chat: &JsString) -> Option<Target> {
        let bound = (scope.owner.clone(), json!(scope.server));
        let (thread, owner) = self.preparation.selected_live_owner(chat, &bound)?;
        let session = native_session(command, &owner.runtime, thread.id());
        (command["threadId"].as_js_string() == Some(thread.id())
            && owner.session.as_ref() == Some(&session))
        .then_some(Target {
            runtime: owner.runtime,
            thread,
            session,
        })
    }

    pub(crate) async fn recover_goal(
        &self,
        command: &Value,
        worker: &Worker,
        signal: Signal,
    ) -> Result<Value> {
        let scope = Scope::new(self.encryption.clone())?;
        let chat = id(&command["chatId"], "Goal recovery chat")?;
        let source = &command["source"];
        let target = &command["recovery"];
        ensure!(
            source["threadId"] == command["threadId"]
                && command["session"]["chatId"] == command["chatId"]
                && (target.is_null() || target["source"] == *source),
            "Goal recovery belongs to another managed session."
        );
        let key = (scope.owner.clone(), scope.server.clone(), chat.clone());
        let manager = worker.inference_manager(&scope.owner, &scope.server)?;
        let prepared = if let Some(live) = self.live_goal_target(command, &scope, &chat) {
            live
        } else {
            let preparation = if target.is_null() {
                None
            } else {
                Some(manager.begin_goal_recovery_preparation(
                    chat.clone(),
                    id(&command["provider"]["id"], "Goal recovery provider")?,
                    target.clone(),
                ))
            };
            let observed = self.preparation.prepare(command, Intent::Preserve).await;
            if let Some(preparation) = preparation {
                match &observed {
                    Ok(_) => preparation.succeeded(),
                    Err(error)
                        if error
                            .downcast_ref::<Failure>()
                            .is_some_and(|failure| failure.kind == "observation") =>
                    {
                        preparation.unconfirmed()
                    }
                    Err(_) => preparation.failed(),
                }
            }
            Target::from_prepared(command, observed?)
        };
        let session = &prepared.session;
        let guard = Guard::metadata_timeout(Some(signal), None, Duration::from_secs(10));
        let ineligible = |reason: &str, observed_epoch: Option<&Value>, recovery: &Value| {
            let mut result = json!({
                "source":source,"status":"ineligible","workerGeneration":self.receipts.worker_generation(),
                "reason":reason,
            });
            if let Some(epoch) = observed_epoch {
                let mut observation = session.clone();
                let Value::Object(fields) = &mut observation else {
                    unreachable!()
                };
                fields.shift_remove("connectionId");
                observation["workerId"] = json!(self.encryption.worker_id());
                observation["nativeEpoch"] = epoch.clone();
                observation["orderEpoch"] = order_epoch(recovery);
                result["observation"] = observation;
            }
            checked("nativeGoalRecoveryReceiptSchema", &result)
        };
        let mut queue = guard
            .run(self.receipts.queue_snapshot(&scope, session))
            .await?;
        if queue["goalRecovery"]["source"] != *source {
            return ineligible("source-changed", None, &queue["goalRecovery"]);
        }
        if queue["paused"] == true {
            return ineligible("paused", None, &queue["goalRecovery"]);
        }
        let previous = &queue["goalRecovery"]["admission"];
        if previous.is_object() && previous["workerGeneration"] != self.receipts.worker_generation()
        {
            guard.run(manager.confirm_native_ownership()).await?;
            scope.identity()?;
            let result = self.receipts.exchange(
                "goal-recovery-fence",
                "/api/internal/native-commands/goal-recovery-fence",
                &checked("nativeGoalRecoveryFenceSchema", &json!({
                    "serverId":scope.server,"workerId":self.encryption.worker_id(),
                    "workerGeneration":self.receipts.worker_generation(),"source":source,"admission":previous,
                }))?,
                &guard,
            ).await?;
            checked("nativeGoalRecoveryFenceResultSchema", &result)?;
            manager.wake_recovery(Some(chat));
            queue = guard
                .run(self.receipts.queue_snapshot(&scope, session))
                .await?;
            if queue["goalRecovery"]["source"] != *source {
                return ineligible("source-changed", None, &queue["goalRecovery"]);
            }
            if queue["paused"] == true {
                return ineligible("paused", None, &queue["goalRecovery"]);
            }
        }
        let recovery = &queue["goalRecovery"];
        let observation =
            self.goal_recoveries
                .observe(&key, recovery, prepared.runtime.generation());
        let admitted = observation.observed();
        if let Some(admission) = admitted
            .as_ref()
            .filter(|admission| *admission == &recovery["admission"])
        {
            prepared.thread.assert_current(&prepared.runtime)?;
            scope.identity()?;
            return recovery_reply(source, admission);
        }
        let (goal, goal_epoch, epoch) =
            read_native_goal(&prepared.runtime, &prepared.thread, &guard).await?;
        if goal_epoch != source["goalEpoch"] {
            return ineligible("epoch-changed", Some(&epoch), recovery);
        }
        if goal["status"] != "active" {
            return ineligible("not-active", Some(&epoch), recovery);
        }
        let admitted = observation.observed();
        let admission = if let Some(admission) = admitted {
            admission
        } else {
            prepared.wake(&guard).await?;
            prepared.wait(&observation, &guard).await?
        };
        prepared.thread.assert_current(&prepared.runtime)?;
        scope.identity()?;
        recovery_reply(source, &admission)
    }
}

fn recovery_reply(source: &Value, admission: &Value) -> Result<Value> {
    checked(
        "nativeGoalRecoveryReceiptSchema",
        &json!({
            "source":source,"status":"admitted","admission":admission,
        }),
    )
}

pub(super) async fn read_native_goal(
    runtime: &Runtime,
    thread: &LoadedThread,
    guard: &Guard,
) -> Result<(Value, Value, Value)> {
    let epoch = native_epoch(runtime, thread, guard).await?;
    let reply = native(
        runtime,
        "thread/goal/get",
        json!({"threadId":thread.id()}),
        guard,
    )
    .await?;
    let goal = checked("chatGoalResponseSchema", &reply)?["goal"].clone();
    let goal_epoch = reply
        .get("goalEpoch")
        .filter(|value| {
            value.is_null() || value.as_js_string().is_some_and(|epoch| !epoch.is_empty())
        })
        .context("Codex did not return a valid Goal epoch")?;
    ensure!(
        goal.is_null() || goal["threadId"].as_js_string() == Some(thread.id()),
        "Codex returned a Goal for another thread."
    );
    ensure!(
        native_epoch(runtime, thread, guard).await? == epoch,
        "The Goal's native settings were replaced."
    );
    Ok((goal, goal_epoch.clone(), epoch))
}

async fn native_epoch(runtime: &Runtime, thread: &LoadedThread, guard: &Guard) -> Result<Value> {
    let result = native(
        runtime,
        "thread/settings/read",
        json!({"threadId":thread.id()}),
        guard,
    )
    .await?;
    thread.assert_current(runtime)?;
    ensure!(
        result["threadId"].as_js_string() == Some(thread.id()),
        "Codex returned settings for a different Goal thread."
    );
    let version = checked(
        "nativeSettingsVersionSchema",
        &result["threadSettings"]["settingsVersion"],
    )?;
    Ok(version["epoch"].clone())
}

pub(super) async fn native(
    runtime: &Runtime,
    method: &str,
    params: Value,
    guard: &Guard,
) -> Result<Value> {
    guard
        .run(async {
            runtime
                .request(method.into(), Some(params), Some(RPC_TIMEOUT), None)
                .await?
                .with_context(|| format!("Codex did not return a {method} result."))
        })
        .await
}
