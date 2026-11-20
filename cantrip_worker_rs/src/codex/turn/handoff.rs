//! Core reserves and commits a provider transfer. The worker moves the native
//! history and keeps staged runtimes private until it observes the commit.
mod journal;
mod task;
pub(crate) use task::TASK_SOURCE;
pub(super) mod withdrawal;

use super::{
    Turns, id,
    receipt::{MetadataHttpError, Unacknowledged},
};
use crate::{
    chat_content::Scope,
    codex::{
        managed::{Runtime, Worker},
        observation::{home, provider},
        preparation::{
            Intent,
            command::{COMMAND as ENSURE, HandoffStage, Prepared},
            native::LoadedThread,
        },
    },
    http::checked,
    metadata::{Abort, Guard, Signal},
};
use anyhow::{Context, Result, anyhow, bail, ensure};
use cantrip_crypto::content::protect_native_settings_snapshot;
use cantrip_history::{content::Encryption, files::queue};
use cantrip_wire::{JsString, Value, payload_digest, value::json};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::time::Instant;

pub(crate) const COMMAND: &str = "chat.runtime.handoff";
const ENDPOINT: &str = "/api/internal/native-runtime-handoffs";

#[derive(Clone)]
pub(super) struct Coordinator {
    data: PathBuf,
    worker: JsString,
    active: Arc<Mutex<HashMap<PathBuf, (Value, Abort)>>>,
    retained: Arc<Mutex<HashMap<PathBuf, Retained>>>,
}

#[derive(Clone, Default)]
struct Retained {
    source: Option<Arc<Prepared>>,
    destination: Option<Arc<Prepared>>,
    task_withdrawal: Option<task::WithdrawalAttempt>,
}

impl Coordinator {
    pub fn new(data: PathBuf, worker: JsString) -> Self {
        Self {
            data,
            worker,
            active: Arc::default(),
            retained: Arc::default(),
        }
    }
}

struct Transfer {
    turns: Turns,
    worker: Worker,
    identity: Scope,
    scope: Value,
    request: Value,
    signal: Signal,
    local_key: PathBuf,
}

impl Turns {
    pub(crate) async fn runtime_handoff(
        &self,
        command: &Value,
        signal: Signal,
        worker: Worker,
    ) -> Result<Value> {
        let identity = Scope::new(self.encryption.clone())?;
        let scope = json!({
            "serverId":identity.server,"ownerId":identity.owner,"workerId":self.handoffs.worker,
        });
        let request = checked(
            "nativeRuntimeHandoffWorkerRequestSchema",
            &json!({
                "action":"read","workerId":self.handoffs.worker,"chatId":command["chatId"],
                "operationId":command["operationId"],
            }),
        )?;
        let key = self
            .handoffs
            .data
            .join("managed-runtime-handoffs")
            .join(payload_digest(&json!([
                scope["serverId"].clone(),
                scope["ownerId"].clone(),
                scope["workerId"].clone(),
                request["chatId"].clone(),
            ])));
        let mut transfer = Transfer {
            local_key: key
                .join(journal::operation_id(&request["operationId"]).context("Handoff operation")?),
            turns: self.clone(),
            worker,
            identity,
            scope,
            request,
            signal,
        };
        if command["intent"] == "cancel" {
            let state = transfer.action("read", json!({})).await?;
            ensure!(
                state["cancelRequested"] == true || state["phase"] == "cancelled",
                "Core has not reserved handoff cancellation."
            );
            if let Some((operation, active)) = self.handoffs.active.lock().unwrap().get(&key)
                && *operation == transfer.request["operationId"]
            {
                active.abort(anyhow!("Handoff cancellation requested."));
            }
        }
        queue(&key)
            .run_async(async move {
                let (abort, signal) = Abort::new();
                transfer.signal = Signal::any(vec![transfer.signal, signal]);
                let active = transfer.turns.handoffs.active.clone();
                active.lock().unwrap().insert(
                    key.clone(),
                    (transfer.request["operationId"].clone(), abort),
                );
                let result = transfer.run().await;
                active.lock().unwrap().remove(&key);
                result
            })
            .await
    }
}

impl Transfer {
    fn data(&self) -> &std::path::Path {
        &self.turns.handoffs.data
    }

    fn check(&self) -> Result<()> {
        self.signal.check()?;
        self.identity.identity()?;
        Ok(())
    }

    fn validate_state(&self, state: &Value) -> Result<()> {
        ensure!(
            ["chatId", "workerId", "operationId"]
                .iter()
                .all(|field| state[*field] == self.request[*field])
                && state["source"]["chatId"] == state["chatId"]
                && state["source"]["workerId"] == state["workerId"],
            "Core returned another native handoff operation."
        );
        self.check()
    }

    async fn action(&self, action: &str, mut fields: Value) -> Result<Value> {
        for key in ["workerId", "chatId", "operationId"] {
            fields[key] = self.request[key].clone();
        }
        fields["action"] = json!(action);
        let fields = checked("nativeRuntimeHandoffWorkerRequestSchema", &fields)?;
        let retry = action == "commit" || (action == "finish" && fields["outcome"] == "completed");
        let guard = Guard::request(Some(self.signal.clone()));
        let deadline = Instant::now() + Duration::from_secs(60);
        let mut delay = 500;
        loop {
            self.check()?;
            let result = self
                .turns
                .receipts
                .exchange(action, ENDPOINT, &fields, &guard)
                .await;
            match result {
                Err(error) if retry && Instant::now() < deadline && retryable(&error) => {
                    guard
                        .delay(
                            delay.min(
                                deadline
                                    .saturating_duration_since(Instant::now())
                                    .as_millis() as u64,
                            ),
                        )
                        .await?;
                    delay = (delay * 2).min(5_000);
                }
                result => {
                    let state = checked("nativeRuntimeHandoffStateSchema", &result?)?;
                    self.validate_state(&state)?;
                    return Ok(state);
                }
            }
        }
    }

    async fn configuration(&self, state: &Value, side: &str) -> Result<Value> {
        self.check()?;
        let request = json!({
            "workerId":state["workerId"],"chatId":state["chatId"],
            "operationId":state["operationId"],"side":side,
        });
        let result = checked(
            "nativeRuntimeHandoffConfigurationSchema",
            &self
                .turns
                .receipts
                .exchange(
                    "runtime handoff configuration",
                    "/api/internal/native-runtime-handoffs/configuration",
                    &request,
                    &Guard::request(Some(self.signal.clone())),
                )
                .await?,
        )?;
        self.validate_state(&result["state"])?;
        let mut configuration = result["configuration"].clone();
        ensure!(
            result["side"] == side
                && result["state"] == *state
                && configuration
                    .get("session")
                    .or_else(|| configuration.get("task"))
                    .is_some_and(|context| context["chatId"] == state["chatId"])
                && configuration["threadId"] == state["source"]["threadId"],
            "Core returned a different native handoff configuration."
        );
        if configuration["task"].is_object() {
            task::prepare_configuration(state, &mut configuration)?;
        }
        configuration["type"] = json!(ENSURE);
        Ok(configuration)
    }

    async fn run(&self) -> Result<Value> {
        let state = self.action("read", json!({})).await?;
        let result = if matches!(state["phase"].as_str(), Some("completed" | "cancelled")) {
            self.settle_local(&state, state["phase"] == "cancelled")
                .await?;
            Ok(state)
        } else {
            self.execute(state).await
        };
        if result.is_err() && self.check().is_ok() {
            let _ = self
                .action(
                    "failure",
                    json!({"errorCode":"handoff-worker-operation-failed"}),
                )
                .await;
        }
        if let Ok(state) = &result
            && state["queuedSource"]["withdrawn"] == true
        {
            if withdrawal::has_managed_reservation(state) {
                self.retire_managed_withdrawal(state).await?;
            } else if state["queuedSource"]["taskGoal"].is_object() {
                journal::Journal::new(self.data(), self.scope.clone(), state.clone())?
                    .retire_withdrawal()
                    .await?;
            } else if state["queuedSource"]["goalRecovery"].is_object() {
                journal::Journal::new(self.data(), self.scope.clone(), state.clone())?
                    .retire_goal_withdrawal()
                    .await?;
            }
        }
        result
    }

    async fn execute(&self, mut state: Value) -> Result<Value> {
        let operation = journal::operation_id(&state["operationId"])
            .context("Invalid native handoff operation")?
            .to_owned();
        let thread = id(&state["source"]["threadId"], "handoff thread")?;
        let recovering_goal = state["queuedSource"]["goalRecovery"].is_object();
        if withdrawal::has_managed_reservation(&state) {
            state = self.withdraw_managed(state).await?;
            if state["phase"] == "cancelled" {
                return Ok(state);
            }
        } else if state["queuedSource"]["taskGoal"].is_object() {
            state = self.withdraw_task(state).await?;
            if state["phase"] == "cancelled" {
                return Ok(state);
            }
        } else if !recovering_goal
            && !state["queuedSource"].is_null()
            && state["queuedSource"]["withdrawn"] != true
        {
            bail!("The queued native handoff source still requires a confirmed withdrawal.");
        }
        let journal = journal::Journal::new(self.data(), self.scope.clone(), state.clone())?;
        let mut source = None;
        if state["phase"] != "committed" {
            let config = self.configuration(&state, "source").await?;
            let prepared = self
                .turns
                .preparation
                .prepare_handoff(&config, HandoffStage::Source)
                .await?;
            let prepared = Arc::new(prepared);
            self.turns
                .handoffs
                .retained
                .lock()
                .unwrap()
                .entry(self.local_key.clone())
                .or_default()
                .source = Some(prepared.clone());
            let snapshot = self.snapshot(&state, &config, &prepared, false).await?;
            state = self.recover(state, "source", snapshot).await?;
            let needs_goal_withdrawal =
                recovering_goal && state["queuedSource"]["withdrawn"] != true;
            if needs_goal_withdrawal || state["cancelRequested"] != true {
                self.control(&prepared, "hold", &operation).await?;
            }
            if needs_goal_withdrawal {
                state = self.withdraw_recovered_goal(state, &prepared).await?;
            }
            if state["cancelRequested"] == true {
                let restored = self
                    .turns
                    .preparation
                    .prepare(&config, Intent::Preserve)
                    .await?;
                ensure!(
                    restored.runtime.generation() == prepared.runtime.generation()
                        && restored.thread.id() == prepared.thread.id(),
                    "Cancellation restored a different handoff source."
                );
                self.turns
                    .handoffs
                    .retained
                    .lock()
                    .unwrap()
                    .entry(self.local_key.clone())
                    .or_default()
                    .source = Some(Arc::new(restored));
                let state = self
                    .action("finish", json!({"outcome":"cancelled"}))
                    .await?;
                self.settle_local(&state, true).await?;
                return Ok(state);
            }
            source = Some(prepared);
        }
        let capture = source
            .as_ref()
            .map(|source| (source.runtime.clone(), source.codex_home.clone()));
        let scope = self.scope.clone();
        let data = self.data().to_owned();
        let capture_thread = thread.clone();
        let plan = journal
            .prepare(move || async move {
                let (runtime, home) =
                    capture.context("Missing source runtime before native export")?;
                let snapshot = runtime.read_history(&capture_thread).await?;
                let last_turn = snapshot["thread"]["turns"]
                    .as_array()
                    .and_then(|turns| turns.last())
                    .and_then(|turn| turn["id"].as_js_string())
                    .cloned();
                let previous = home::current_operation(&data, &scope, &capture_thread).await?;
                Ok((home, last_turn, previous))
            })
            .await?;
        self.check()?;
        let transfer = if state["prepared"].is_null() {
            let source = source.as_ref().context("Missing prepared native source")?;
            ensure!(
                source.codex_home == plan.source_home,
                "The prepared native source home changed."
            );
            let runtime = source.runtime.clone();
            let signal = self.signal.clone();
            Some(
                plan.export(move |input| async move {
                    Guard::request(Some(signal))
                        .run(async move {
                            runtime
                                .request(
                                    "thread/managedHistory/export".into(),
                                    Some(input),
                                    None,
                                    None,
                                )
                                .await?
                                .context("Missing native history export response")
                        })
                        .await
                })
                .await?,
            )
        } else {
            None
        };
        let config = self.configuration(&state, "destination").await?;
        let staged = self
            .turns
            .preparation
            .prepare_handoff(
                &config,
                HandoffStage::Destination {
                    operation: operation.clone(),
                    transfer,
                },
            )
            .await?;
        let staged = Arc::new(staged);
        self.turns
            .handoffs
            .retained
            .lock()
            .unwrap()
            .entry(self.local_key.clone())
            .or_default()
            .destination = Some(staged.clone());
        if state["phase"] == "committed" {
            let snapshot = self.snapshot(&state, &config, &staged, true).await?;
            state = self.recover(state, "destination", snapshot).await?;
        } else {
            self.native(
                &staged,
                "thread/managedContext/reset",
                json!({
                    "threadId":thread,"expectedLastTurnId":plan.last_turn(),
                }),
            )
            .await?;
            let snapshot = self.snapshot(&state, &config, &staged, true).await?;
            self.action("prepared", json!({
                "expectedPreparedRuntimeGeneration":state["prepared"]["runtimeGeneration"],
                "expectedPreparedNativeEpoch":state["prepared"]["snapshot"]["context"]["settingsVersion"]["epoch"],
                "prepared":snapshot,
            })).await?;
            state = self.action("commit", json!({})).await?;
        }
        self.check()?;
        home::select_committed(
            self.data(),
            &self.scope,
            &state,
            &config["provider"],
            plan.previous_operation(),
        )
        .await?;
        self.check()?;
        let selected = self
            .turns
            .preparation
            .prepare(&config, Intent::Preserve)
            .await?;
        ensure!(
            selected.runtime.generation() == staged.runtime.generation(),
            "The published handoff did not adopt the staged runtime."
        );
        self.settle_local(&state, false).await?;
        let state = self
            .action("finish", json!({"outcome":"completed"}))
            .await?;
        self.publish_task_goal(&state, &config, &selected).await?;
        if let Some(queue) = selected.queue {
            queue.reconcile_on_prepare();
        }
        Ok(state)
    }

    async fn withdraw_managed(&self, state: Value) -> Result<Value> {
        if state["queuedSource"]["withdrawn"] == true {
            self.acknowledge_withdrawal(&state).await?;
            return Ok(state);
        }
        let journal = journal::Journal::new(self.data(), self.scope.clone(), state.clone())?;
        let record = match journal.saved_withdrawal().await? {
            Some(record) => Some(record),
            None => match self.capture_withdrawal(&state).await {
                Ok(record) => {
                    if let Some(record) = &record {
                        self.hold_queued_goal(&state).await?;
                        journal.save_withdrawal(record).await?;
                    }
                    record
                }
                Err(error) if error.is::<withdrawal::SourceUnavailable>() => {
                    return self.action("decline-queued-source", json!({})).await;
                }
                Err(error) => return Err(error),
            },
        };
        let state = self.action("withdrawn", json!({"record":record})).await?;
        ensure!(
            state["queuedSource"]["withdrawn"] == true,
            "Core did not acknowledge the unused inference reservation."
        );
        self.acknowledge_withdrawal(&state).await?;
        Ok(state)
    }

    async fn withdraw_recovered_goal(&self, state: Value, prepared: &Prepared) -> Result<Value> {
        let binding = state
            .get("binding")
            .filter(|binding| !binding.is_null())
            .unwrap_or(&state["source"]);
        let goal = &state["queuedSource"]["goalRecovery"];
        ensure!(
            goal["threadId"].as_js_string() == Some(prepared.thread.id())
                && binding["runtimeGeneration"] == prepared.runtime.generation(),
            "The recovered Goal lost its prepared native producer."
        );
        let journal = journal::Journal::new(self.data(), self.scope.clone(), state.clone())?;
        let receipt = journal
            .save_goal_withdrawal(&json!({
                "operationId":state["operationId"],"source":goal,
                "bindingId":binding["bindingId"],"runtimeGeneration":prepared.runtime.generation(),
                "runnerGeneration":prepared.runner_generation,
                "workerGeneration":self.turns.receipts.worker_generation(),
            }))
            .await?;
        let state = self
            .action("goal-recovery-withdrawn", json!({"receipt":receipt}))
            .await?;
        ensure!(
            state["queuedSource"]["withdrawn"] == true
                && state["queuedSource"]["goalWithdrawal"] == receipt,
            "Core did not acknowledge the native Goal producer hold."
        );
        Ok(state)
    }

    async fn hold_queued_goal(&self, state: &Value) -> Result<()> {
        let attempt = &state["queuedSource"]["autonomousAttempt"];
        if !attempt.is_object() {
            return Ok(());
        }
        let chat = id(&state["chatId"], "handoff chat")?;
        let bound = (self.identity.owner.clone(), json!(self.identity.server));
        let binding = state
            .get("binding")
            .filter(|binding| !binding.is_null())
            .unwrap_or(&state["source"]);
        // After restart the old producer is gone. Its no-start receipt is
        // still valid. A live producer must acknowledge the hold first.
        if let Some((thread, owner)) = self.turns.preparation.selected_live_owner(&chat, &bound)
            && binding["runtimeGeneration"] == owner.runtime.generation()
        {
            let runner = id(&attempt["runnerGeneration"], "queued Goal runner")?;
            ensure!(
                binding["threadId"].as_js_string() == Some(thread.id()),
                "The queued Goal belongs to another native thread."
            );
            let operation = journal::operation_id(&state["operationId"])
                .context("Invalid native handoff operation")?;
            self.control_producer(&owner.runtime, &thread, &runner, "hold", operation)
                .await?;
        }
        Ok(())
    }

    async fn retire_managed_withdrawal(&self, state: &Value) -> Result<()> {
        self.check()?;
        let journal = journal::Journal::new(self.data(), self.scope.clone(), state.clone())?;
        let manager = self
            .worker
            .inference_manager(&self.identity.owner, &self.identity.server)?;
        let mut expected = state["queuedSource"].clone();
        expected["chatId"] = state["chatId"].clone();
        if let Some(record) = manager.withdrawal_record(expected).await? {
            manager.retire_withdrawal(record).await?;
        }
        journal.retire_withdrawal().await
    }

    async fn settle_local(&self, state: &Value, cancelled: bool) -> Result<()> {
        let retained = self
            .turns
            .handoffs
            .retained
            .lock()
            .unwrap()
            .get(&self.local_key)
            .cloned();
        let Some(retained) = retained else {
            return Ok(());
        };
        if let Some(source) = retained.source
            && source.thread.assert_current(&source.runtime).is_ok()
        {
            if cancelled {
                let operation = journal::operation_id(&self.request["operationId"])
                    .context("Handoff operation")?;
                self.control(&source, "release", operation).await?;
                self.resume_cancelled_task_root(state, &source).await?;
            } else {
                self.native(
                    &source,
                    "thread/unsubscribe",
                    json!({"threadId":source.thread.id()}),
                )
                .await?;
            }
        }
        if cancelled && let Some(destination) = retained.destination {
            destination.runtime.close().await?;
        }
        self.turns
            .handoffs
            .retained
            .lock()
            .unwrap()
            .remove(&self.local_key);
        Ok(())
    }

    async fn control(&self, prepared: &Prepared, action: &str, operation: &str) -> Result<()> {
        self.control_producer(
            &prepared.runtime,
            &prepared.thread,
            &prepared.runner_generation,
            action,
            operation,
        )
        .await
    }

    async fn control_producer(
        &self,
        runtime: &Runtime,
        thread: &LoadedThread,
        runner: &JsString,
        action: &str,
        operation: &str,
    ) -> Result<()> {
        let mut input = json!({"threadId":thread.id(),"runnerGeneration":runner,"action":"read"});
        let observed = self
            .native_on(
                runtime,
                thread,
                "thread/managedExecution/handoff",
                input.clone(),
            )
            .await?;
        if observed["heldBy"] == operation && action == "hold" {
            return Ok(());
        }
        ensure!(
            observed["heldBy"].is_null() || observed["heldBy"] == operation,
            "Another operation owns the native producer hold."
        );
        let revision = observed["revision"]
            .as_str()
            .context("Missing native producer revision")?;
        ensure!(
            revision.parse::<u64>().is_ok(),
            "Invalid native producer revision."
        );
        input["action"] = json!(action);
        input["operationId"] = json!(operation);
        input["expectedRevision"] = observed["revision"].clone();
        let confirmed = self
            .native_on(runtime, thread, "thread/managedExecution/handoff", input)
            .await?;
        ensure!(
            if action == "hold" {
                confirmed["heldBy"] == operation
            } else {
                confirmed.get("heldBy") == Some(&Value::Null)
            },
            "Codex did not acknowledge the handoff producer hold change."
        );
        Ok(())
    }

    async fn native(&self, prepared: &Prepared, method: &str, params: Value) -> Result<Value> {
        self.native_on(&prepared.runtime, &prepared.thread, method, params)
            .await
    }

    async fn native_on(
        &self,
        runtime: &Runtime,
        thread: &LoadedThread,
        method: &str,
        params: Value,
    ) -> Result<Value> {
        self.check()?;
        thread.assert_current(runtime)?;
        let reply = Guard::request(Some(self.signal.clone()))
            .run(async {
                runtime
                    .request(method.into(), Some(params), Some(super::RPC_TIMEOUT), None)
                    .await?
                    .with_context(|| format!("Missing native handoff response to {method}."))
            })
            .await?;
        if method != "thread/unsubscribe" {
            thread.assert_current(runtime)?;
        }
        self.check()?;
        Ok(reply)
    }

    async fn snapshot(
        &self,
        state: &Value,
        config: &Value,
        prepared: &Prepared,
        destination: bool,
    ) -> Result<Value> {
        let thread = prepared.thread.id();
        let reply = self
            .native(prepared, "thread/settings/read", json!({"threadId":thread}))
            .await?;
        let settings = &reply["threadSettings"];
        let model = &config["model"];
        let provider = &config["provider"];
        ensure!(
            reply["threadId"].as_js_string() == Some(thread)
                && state["source"]["threadId"].as_js_string() == Some(thread)
                && settings["modelProvider"] == provider::model_provider(provider)
                && (!destination || settings["model"] == model["name"]),
            "Native handoff settings differ from the reserved provider or model."
        );
        let selection = if settings["model"] == model["name"] {
            json!({
                "status":"resolved","workerId":self.scope["workerId"],"providerId":provider["id"],
                "providerAccountId":provider["accountId"],"modelId":model["id"],"routeId":model["routeId"],
            })
        } else {
            json!({"status":"unavailable"})
        };
        let grant = self.identity.material(None)?;
        let snapshot = protect_native_settings_snapshot(
            &grant.key,
            &json!({"ownerId":grant.owner_id,"serverId":grant.server_id,"keyRevision":grant.key_revision}),
            &json!({
                "chatId":state["chatId"],"workerId":self.scope["workerId"],"threadId":thread,
                "runtimeGeneration":prepared.runtime.generation(),"settingsVersion":settings["settingsVersion"],
            }),
            settings,
            &selection,
        )?;
        self.check()?;
        checked(
            "nativeRuntimeHandoffPreparedSchema",
            &json!({
                "threadId":thread,"runtimeGeneration":prepared.runtime.generation(),
                "snapshot":snapshot,"reasoningEffort":settings["effort"],
            }),
        )
    }

    async fn recover(&self, state: Value, side: &str, snapshot: Value) -> Result<Value> {
        let binding = state
            .get("binding")
            .filter(|binding| !binding.is_null())
            .unwrap_or(&state["source"]);
        if snapshot["runtimeGeneration"] == binding["runtimeGeneration"]
            && snapshot["snapshot"]["context"]["settingsVersion"]["epoch"] == binding["nativeEpoch"]
        {
            return Ok(state);
        }
        self.action(
            "recover",
            json!({
                "side":side,"expectedBindingId":binding["bindingId"],"recovered":snapshot,
            }),
        )
        .await
    }
}

fn retryable(error: &anyhow::Error) -> bool {
    error.is::<Unacknowledged>()
        || error
            .downcast_ref::<MetadataHttpError>()
            .is_some_and(|response| matches!(response.status, 408 | 429))
}
