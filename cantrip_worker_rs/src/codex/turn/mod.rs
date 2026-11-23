//! Server-owned Chat turns. The command channel supplies the execution lane;
//! the native runtime supplies the turn identity and terminal settlement.
mod acknowledged;
pub(crate) mod autonomous;
mod compact;
mod computer_use;
pub(crate) mod console;
pub(crate) mod context;
mod control;
mod deferred;
pub(crate) mod goal_recovery;
pub(crate) mod handoff;
pub(crate) mod interactions;
pub(crate) mod label;
mod output;
mod params;
mod policy;
mod protected;
pub(crate) mod provider_test;
pub(crate) mod queue_wake;
mod queued;
pub(super) use crate::chat_content::runtime_text;
mod receipt;
mod repository_draft;
pub(crate) use compact::COMMAND as COMPACT;
mod rollback;
pub(crate) use rollback::COMMAND as ROLLBACK;
pub(in crate::codex) mod settings;
pub(crate) use settings::{
    ACCOUNT_DEFAULTS, COMMAND as SETTINGS_UPDATE, PERMISSION_UPDATE,
    snapshot::READ as SETTINGS_READ,
};
pub(in crate::codex) mod shell;
pub(in crate::codex) mod task;
pub(crate) use task::recovery::COMMAND as TASK_GOAL_RECOVERY;
pub(crate) mod task_route;
pub(in crate::codex) mod thread_changes;

use super::{
    admission::Acquire,
    managed::Runtime,
    preparation::{Intent, command::Ensurer},
    revocation::{REMOVED, Target},
    rpc_requests::Failure,
    skills, task_inputs,
};
use crate::{
    attachments::{Store, content::ServiceKeys},
    cantrip_os::product_files::ProductFiles,
    chat_content::Scope,
    config::Config,
    encryption::Service,
    history::managed::{coordinator::History, sources},
    http::checked,
    inference::admission::{Complete, Promise, Source},
    metadata::{Abort, Signal},
    outcomes::TaskDelivery,
};
use anyhow::{Context, Result, anyhow, bail};
use cantrip_wire::{JsString, Value, payload_digest, value::json};
use std::{
    collections::{HashMap, HashSet},
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::sync::{Mutex as AsyncMutex, watch};

pub(crate) const RUN: &str = "chat.turn";
pub(crate) const INTERRUPT: &str = "chat.interrupt";
pub(crate) const CONTROL: &str = "chat.native-control";
pub(crate) const STEER: &str = "chat.steer";
pub(crate) use control::PAUSE_SET;
pub(crate) const RESUME: &str = "chat.suspension.resume";
pub(crate) const STOP_SUSPENSION: &str = "chat.suspension.stop";
pub(crate) const COMPLETE: &str = "chat.native-logical.complete";
pub(crate) const CANCEL: &str = "chat.native-logical.cancel";
const RPC_TIMEOUT: Duration = Duration::from_secs(120);

type Key = (JsString, JsString, JsString);
type Sessions = Arc<Mutex<SessionsState>>;

#[derive(Default)]
struct SessionsState {
    active: HashMap<Key, Arc<Active>>,
    cancelled: HashSet<(Key, JsString, JsString)>,
    restoring: HashMap<Key, PendingSuspension>,
    stopping: HashMap<Key, PendingSuspension>,
}
struct PendingSuspension {
    signature: String,
    response: Promise<Value>,
}

pub(crate) type Emit = Arc<dyn Fn(Value) -> Result<()> + Send + Sync>;

#[derive(Clone)]
pub(crate) struct Turns {
    preparation: Ensurer,
    encryption: Arc<Service>,
    active: Sessions,
    receipts: receipt::Client,
    settings: Arc<settings::Delivery>,
    history: History,
    attachments: Store,
    console_queues: console::QueueViews,
    guest_files: Arc<ProductFiles>,
    task_inputs: task_inputs::Client,
    task_outcomes: Arc<TaskDelivery>,
    suspensions: super::suspension_store::Store,
    handoffs: handoff::Coordinator,
    goal_recoveries: goal_recovery::Observations,
    computer_use: computer_use::Desktop,
    thread_changes: Arc<thread_changes::Publisher>,
}

struct TaskTurn {
    turn: task::Turn,
    input: Arc<task_route::Attempt>,
    key: Key,
    claimed: bool,
    restored_finished: bool,
    retained_checkpoint: bool,
    goal_commit: Option<(Complete<()>, Promise<()>)>,
}

struct Active {
    context: OnceLock<Arc<context::ContextTurn>>,
    root: Option<receipt::Operation>,
    project: Option<JsString>,
    control: OnceLock<control::Binding>,
    queued_inference: OnceLock<handoff::withdrawal::QueuedInference>,
    task: OnceLock<task::checkpoint::Checkpoint>,
    task_input: Option<Arc<task_route::Attempt>>,
    logical_finished: AtomicBool,
    preparation: Abort,
    phase: Mutex<Phase>,
    changed: watch::Sender<u64>,
}

enum Phase {
    Preparing(Option<JsString>),
    Sending(JsString),
    Running {
        runtime: Runtime,
        thread: JsString,
        turn: JsString,
    },
    Terminal,
    Finished,
}

struct Owner {
    sessions: Sessions,
    key: Key,
    active: Arc<Active>,
}
impl Drop for Owner {
    fn drop(&mut self) {
        let mut entries = self.sessions.lock().unwrap();
        self.active.set(Phase::Finished);
        if self.active.logical_finished.load(Ordering::Relaxed)
            && entries
                .active
                .get(&self.key)
                .is_some_and(|active| Arc::ptr_eq(active, &self.active))
        {
            entries.active.remove(&self.key);
        }
    }
}

impl Active {
    fn set(&self, next: Phase) {
        *self.phase.lock().unwrap() = next;
        self.changed.send_modify(|version| *version += 1);
    }

    fn dispatch(&self, signal: &Signal, thread: JsString) -> Result<()> {
        let mut phase = self.phase.lock().unwrap();
        signal.check()?;
        *phase = Phase::Sending(thread);
        self.changed.send_modify(|version| *version += 1);
        Ok(())
    }

    async fn interrupt(
        &self,
        selected: Option<&JsString>,
        assert_current: impl Fn() -> Result<()>,
    ) -> Result<bool> {
        let mut changes = self.changed.subscribe();
        loop {
            assert_current()?;
            let request = {
                let phase = self.phase.lock().unwrap();
                let matches = |thread: Option<&JsString>| selected.is_none() || selected == thread;
                match &*phase {
                    Phase::Preparing(thread) if matches(thread.as_ref()) => {
                        self.preparation.abort(anyhow!(
                            "The turn was interrupted before response admission."
                        ));
                        return Ok(true);
                    }
                    Phase::Sending(thread) if matches(Some(thread)) => None,
                    Phase::Running {
                        runtime,
                        thread,
                        turn,
                    } if matches(Some(thread)) => {
                        Some((runtime.clone(), thread.clone(), turn.clone()))
                    }
                    _ => return Ok(false),
                }
            };
            if let Some((runtime, thread, turn)) = request {
                assert_current()?;
                let result = runtime
                    .request(
                        "turn/interrupt".into(),
                        Some(json!({"threadId": thread, "turnId": turn})),
                        Some(RPC_TIMEOUT),
                        None,
                    )
                    .await;
                return match result {
                    Ok(_) => Ok(true),
                    Err(_)
                        if matches!(
                            *self.phase.lock().unwrap(),
                            Phase::Terminal | Phase::Finished
                        ) =>
                    {
                        Ok(false)
                    }
                    Err(error) => Err(error),
                };
            }
            changes.changed().await?;
        }
    }
}

impl Turns {
    pub(crate) fn new(
        preparation: Ensurer,
        encryption: Arc<Service>,
        configuration: Arc<Mutex<Config>>,
        generation: String,
        history: History,
        task_inputs: task_inputs::Client,
        task_outcomes: Arc<TaskDelivery>,
        guest_files: Arc<ProductFiles>,
        desktop: &crate::desktop_inventory::DesktopInventory,
        outgoing: Arc<crate::connection::Outbound>,
    ) -> Result<Self> {
        let (data, worker) = {
            let config = configuration.lock().unwrap();
            (config.data_directory.clone(), config.worker_id.clone())
        };
        let attachments = Store::new(&data, None)?;
        let receipts = receipt::Client::new(configuration, generation)?;
        let settings = Arc::new(settings::Delivery::new(
            receipts.clone(),
            encryption.clone(),
            worker.clone(),
            &data,
        ));
        Ok(Self {
            computer_use: computer_use::Desktop {
                previews: desktop.previews(),
                binary: desktop.helper_binary(),
            },
            handoffs: handoff::Coordinator::new(data.clone(), worker),
            goal_recoveries: goal_recovery::Observations::default(),
            suspensions: super::suspension_store::Store::new(&data, encryption.clone()),
            preparation,
            encryption,
            active: Arc::default(),
            receipts,
            settings,
            history,
            attachments,
            console_queues: console::QueueViews::default(),
            guest_files,
            task_inputs,
            task_outcomes,
            thread_changes: Arc::new(thread_changes::Publisher::new(outgoing)),
        })
    }

    pub(crate) fn settings_delivery(&self) -> Arc<settings::Delivery> {
        self.settings.clone()
    }

    pub(crate) fn wake_deferred_settlements(&self) {
        self.receipts.deferred.wake();
    }

    pub(crate) fn deferred_settlement_pump(
        &self,
        stop: watch::Receiver<bool>,
        logs: Arc<crate::logging::Logs>,
    ) -> impl Future<Output = ()> + use<> {
        let receipts = self.receipts.clone();
        let encryption = self.encryption.clone();
        async move {
            receipts
                .deferred
                .run(&receipts, encryption, stop, logs)
                .await
        }
    }

    fn key(&self, command: &Value) -> Result<Key> {
        let (owner, server) = self.preparation.identity()?;
        Ok((
            owner,
            id(&server, "logical server identity")?,
            id(&command["chatId"], "chat identity")?,
        ))
    }

    pub(in crate::codex) async fn native_mutation(
        &self,
        runtime: &Runtime,
        binding: &(JsString, Value),
        command: &Value,
        session: Value,
        method: &'static str,
        params: Value,
    ) -> Result<Value> {
        let key = self.key(command)?;
        let scope = Scope::new(self.encryption.clone())?;
        if scope.owner != key.0
            || scope.server != key.1
            || key.0 != binding.0
            || binding.1.as_js_string() != Some(&key.1)
        {
            bail!("The worker binding changed before the native mutation.");
        }
        let gate = session["threadId"]
            .as_js_string()
            .and_then(|thread| runtime.inference_router().goal_mutations(thread));
        let _mutation = match gate {
            Some(gate) => Some(gate.lock_owned().await),
            None => None,
        };
        let activation = if method == rollback::METHOD
            && command["session"].is_object()
            && command["nativeCommandReceipt"].is_object()
        {
            command["nativeCommandReceipt"]["activationGeneration"].clone()
        } else {
            self.active
                .lock()
                .unwrap()
                .active
                .get(&key)
                .and_then(|active| active.root.as_ref())
                .map(|root| root.activation.clone())
                .unwrap_or(Value::Null)
        };
        let (receipt, awaiting_goal, _) = self
            .receipts
            .admit_command(scope, session, method, &params, command, activation)
            .await?;
        if let Err(error) = receipt.dispatch().await {
            receipt
                .rejected(&json!({"code":-32000,"message":"Native dispatch did not complete."}))
                .await?;
            return Err(error);
        }
        if method == "thread/goal/clear" || params["status"] == "paused" {
            let active = self.active.lock().unwrap().active.get(&key).cloned();
            if let Some(active) = active
                && matches!(*active.phase.lock().unwrap(), Phase::Preparing(_))
            {
                active
                    .preparation
                    .abort(anyhow!("The Goal was stopped before native dispatch."));
            }
        }
        let settings = if method == settings::UPDATE {
            let observation = (|| {
                let scope = Scope::new(self.encryption.clone())?;
                if scope.owner != key.0 || scope.server != key.1 {
                    bail!("The worker binding changed before the native settings mutation.");
                }
                self.settings.observe(
                    runtime,
                    &receipt,
                    scope,
                    params["operationId"]
                        .as_js_string()
                        .context("Missing native settings operation ID.")?,
                    None,
                )
            })();
            match observation {
                Ok(observation) => Some(observation),
                Err(error) => {
                    receipt.rejected(&json!({"code":-32000,"message":"Native settings observation did not start."})).await?;
                    return Err(error);
                }
            }
        } else {
            None
        };
        let reply = runtime
            .request(method.into(), Some(params), Some(RPC_TIMEOUT), None)
            .await;
        if let Some(settings) = settings {
            return settings.settle(&receipt, reply).await;
        }
        match reply {
            Ok(Some(result)) => {
                if awaiting_goal {
                    receipt.applied_queued_goal(&result).await?;
                } else {
                    receipt.applied(&result, None).await?;
                }
                Ok(result)
            }
            Err(error) => {
                if let Some(native) = error
                    .downcast_ref::<Failure>()
                    .and_then(|error| error.native_error.as_ref())
                {
                    receipt.rejected(native).await?;
                } else {
                    receipt.uncertain().await?;
                }
                Err(error)
            }
            Ok(None) => {
                receipt.uncertain().await?;
                bail!("Codex did not return a native mutation result.");
            }
        }
    }

    pub(crate) fn revoke_resource(&self, command: &Value) -> Result<Value> {
        let bound = self.preparation.identity()?;
        let server = bound
            .1
            .as_js_string()
            .context("Missing inference resource server.")?;
        if command["ownerId"].as_js_string() != Some(&bound.0) {
            bail!("The resource revocation belongs to another worker owner.");
        }
        let mut target = Target::read(&command["target"])?;
        {
            let mut sessions = self.active.lock().unwrap();
            sessions
                .active
                .retain(|(owner, logical_server, chat), active| {
                    if owner != &bound.0
                        || logical_server != server
                        || !target.matches(Some(chat), active.project.as_ref())
                    {
                        return true;
                    }
                    target.chats.insert(chat.clone());
                    // Core deleted the logical owner. An accepted native turn
                    // retains its physical slot until its execution is settled.
                    active.logical_finished.store(true, Ordering::Relaxed);
                    let phase = active.phase.lock().unwrap();
                    active.preparation.abort(anyhow!(REMOVED));
                    !matches!(*phase, Phase::Finished)
                });
            sessions
                .cancelled
                .retain(|((owner, logical_server, chat), _, _)| {
                    owner != &bound.0 || logical_server != server || !target.chats.contains(chat)
                });
        }
        self.preparation.revoke_resources(&bound, &mut target)?;
        if self.preparation.identity()? != bound {
            bail!("The worker binding changed during inference resource revocation.");
        }
        Ok(json!({"revoked":true,"ownerId":bound.0,"workerId":self.encryption.worker_id()}))
    }

    pub(crate) async fn interrupt(&self, command: &Value) -> Result<Value> {
        if !command["taskStop"].is_null() || !command["task"].is_null() {
            return self.stop_task(command).await;
        }
        let active = self
            .active
            .lock()
            .unwrap()
            .active
            .get(&self.key(command)?)
            .filter(|active| {
                command["nativeActivationGeneration"].is_null()
                    || active.root.as_ref().is_some_and(|root| {
                        command["nativeActivationGeneration"] == root.activation
                    })
            })
            .cloned();
        let interrupted = match active {
            Some(active) => {
                active
                    .interrupt(command["threadId"].as_js_string(), || Ok(()))
                    .await?
            }
            None => false,
        };
        checked(
            "chatInterruptAcceptedSchema",
            &json!({"interrupted": interrupted}),
        )
    }

    pub(crate) fn logical(&self, command: &Value) -> Result<Option<context::Completion>> {
        let key = self.key(command)?;
        let selector = (
            key.clone(),
            id(&command["rootOperationId"], "logical operation")?,
            id(
                &command["rootOperationGeneration"],
                "logical operation generation",
            )?,
        );
        let mut sessions = self.active.lock().unwrap();
        let active = sessions
            .active
            .get(&key)
            .filter(|active| {
                active
                    .root
                    .as_ref()
                    .is_some_and(|root| root.matches(command))
            })
            .cloned();
        if command["type"] == CANCEL {
            if let Some(active) = &active {
                if let Some(context) = active.context.get() {
                    context.cancel();
                }
                active.preparation.abort(anyhow!(
                    "The GUI request was stopped before native dispatch."
                ));
            } else {
                sessions.cancelled.insert(selector);
            }
        } else {
            sessions.cancelled.remove(&selector);
        }
        if let Some(active) = active {
            // Core has already committed logical closure for either command.
            active.logical_finished.store(true, Ordering::Relaxed);
            if matches!(*active.phase.lock().unwrap(), Phase::Finished) {
                sessions.active.remove(&key);
            }
            if command["type"] == COMPLETE {
                return Ok(context::Completion::pending(active));
            }
        }
        Ok(None)
    }

    pub(crate) async fn run(
        &self,
        incoming: &Value,
        emit: Emit,
        epoch: Option<u64>,
    ) -> (Result<Value>, Option<Value>) {
        let goal = task::is_goal(incoming);
        if !task::is_round(incoming) && !goal {
            let result = self
                .run_owned(incoming, emit, None, epoch)
                .await
                .map_err(|error| protected::redact(incoming, error));
            return (result, None);
        }
        let failure_context = if goal {
            "Encrypted Task turn failed"
        } else {
            "Encrypted Task operation failed"
        };
        let task = (|| {
            params::validate(incoming)?;
            let key = self.key(incoming)?;
            let turn = task::Turn::open(self.encryption.clone(), incoming, &key)?;
            let input = task_route::Attempt::new(incoming, self.encryption.worker_id())?;
            Ok::<_, anyhow::Error>(TaskTurn {
                turn,
                input: Arc::new(input),
                key,
                claimed: false,
                restored_finished: false,
                retained_checkpoint: false,
                goal_commit: goal.then(Promise::pair),
            })
        })();
        let mut task = match task {
            Ok(task) => task,
            Err(_) => return (Err(anyhow!("{failure_context}.")), None),
        };
        let restoring = !incoming["taskResumption"].is_null();
        let result = self.run_owned(incoming, emit, Some(&mut task), epoch).await;
        if result.as_ref().err().is_some_and(|error| {
            crate::inference::withdrawal::Withdrawal::in_error(error).is_some()
        }) {
            let note = task
                .input
                .revoked()
                .then(|| self.task_route_notification(&task))
                .flatten();
            return (
                Err(crate::encryption::ServiceError::new(
                    "worker-inference-deferred",
                    "The unused Task input was deferred for a runtime handoff.",
                )
                .into()),
                note,
            );
        }
        let result = result.map_err(|error| {
            if !restoring {
                anyhow!(task::failure_message(failure_context, Some(&error)))
            } else if error.is::<task::restore::Failure>() {
                error
            } else {
                task::restore::failed(
                    if task.restored_finished {
                        "complete"
                    } else {
                        "attach"
                    },
                    error,
                )
            }
        });
        if task.input.revoked() {
            return (result, self.task_route_notification(&task));
        }
        let note = if task.claimed
            && !task.retained_checkpoint
            && (!restoring || task.restored_finished)
        {
            self.task_outcomes
                .task(&task.key.0, &task.key.1, incoming, &result)
                .await
        } else {
            None
        };
        if let Some((commit, _)) = task.goal_commit {
            commit.finish(if note.is_some() {
                Ok(())
            } else {
                Err(anyhow!("The first Task Goal outcome was not acknowledged."))
            });
        }
        (result, note)
    }

    async fn run_owned(
        &self,
        incoming: &Value,
        emit: Emit,
        mut task: Option<&mut TaskTurn>,
        epoch: Option<u64>,
    ) -> Result<Value> {
        params::validate(incoming)?;
        let key = self.key(incoming)?;
        if task.as_ref().is_some_and(|task| key != task.key) {
            bail!("The worker binding changed before Task admission.");
        }
        let title = label::Title::read(incoming, (key.0.clone(), json!(key.1)))?;
        let root = receipt::Operation::read(incoming)?;
        let (abort, signal) = Abort::new();
        let active = Arc::new(Active {
            context: OnceLock::new(),
            logical_finished: AtomicBool::new(root.is_none()),
            root: root.clone(),
            project: incoming["policyProjectId"].as_js_string().cloned(),
            control: OnceLock::new(),
            queued_inference: OnceLock::new(),
            task: OnceLock::new(),
            task_input: task.as_ref().map(|task| task.input.clone()),
            preparation: abort,
            phase: Mutex::new(Phase::Preparing(
                incoming["threadId"].as_js_string().cloned(),
            )),
            changed: watch::channel(0).0,
        });
        {
            let mut entries = self.active.lock().unwrap();
            if entries.active.contains_key(&key)
                || entries.restoring.contains_key(&key)
                || entries.stopping.contains_key(&key)
            {
                bail!("This chat already has an active native turn.");
            }
            if let Some(input) = &active.task_input
                && entries.active.values().any(|owned| {
                    owned.task_input.as_ref().is_some_and(|other| {
                        other.operation() == input.operation()
                            && !matches!(*owned.phase.lock().unwrap(), Phase::Finished)
                    })
                })
            {
                bail!("The Task input already has a live physical command owner.");
            }
            if root.as_ref().is_some_and(|root| {
                entries.cancelled.contains(&(
                    key.clone(),
                    root.operation.clone(),
                    root.generation.clone(),
                ))
            }) {
                bail!("The GUI request was stopped before native dispatch.");
            }
            entries.active.insert(key.clone(), active.clone());
        }
        let mut owner = Some(Owner {
            sessions: self.active.clone(),
            key: key.clone(),
            active: active.clone(),
        });
        let command = self.preparation.resolve_routing(incoming).await?;
        if !command["taskResumption"].is_null() {
            let task = task.context("The restored Task has no canonical owner.")?;
            return self
                .restore_task(&command, task, &active, &signal, emit, epoch)
                .await;
        }
        let policy_context = policy::context(&self.encryption, &command)?;
        let (prompt, protection) = if protected_mode(&command) {
            let (prompt, protection) =
                protected::Protected::open(self.encryption.clone(), &command, &key.0, &key.1)?;
            (prompt, Some(Arc::new(protection)))
        } else if let Some(task) = &task {
            (task.turn.prompt(), None)
        } else {
            (id(&command["prompt"], "native turn prompt")?, None)
        };
        let is_queued = queued::is_queued(&command);
        let retained = if is_queued {
            let scope = protection
                .as_ref()
                .context("Missing protected queue scope.")?
                .scope();
            queued::open(&command, &prompt, scope)?
        } else {
            None
        };
        if let Some(task) = &mut task {
            self.task_inputs
                .authorize(
                    &key.0,
                    &key.1,
                    &command["taskInferenceInput"],
                    "claim",
                    None,
                    signal.clone(),
                )
                .await?;
            task.claimed = true;
        }
        let prepared = self
            .preparation
            .prepare(&params::preparation(&command), Intent::Configure)
            .await?;
        let runtime = &prepared.runtime;
        let thread = prepared.thread.id();
        let context = (root.is_some() && task.is_none() && command["contextKind"] == "project")
            .then(|| {
                active
                    .context
                    .get_or_init(|| Arc::new(context::ContextTurn::new(thread.clone())))
                    .clone()
            });
        active.set(Phase::Preparing(Some(thread.clone())));
        signal.check()?;
        if self.key(&command)? != key {
            bail!("The worker binding changed before turn admission.");
        }
        prepared.thread.assert_current(runtime)?;

        let receipt = root
            .as_ref()
            .map(|root| {
                receipt::Receipt::new(
                    &self.receipts,
                    root,
                    &command,
                    runtime,
                    thread,
                    Scope::new(self.encryption.clone())?,
                    &key,
                )
            })
            .transpose()?;
        if let Some(receipt) = &receipt {
            receipt.prepare().await?;
            let _ = active.control.set(control::Binding::new(
                receipt.session().clone(),
                command["permissionProfileId"].clone(),
                prepared.thread.version(),
                &command,
            ));
        }
        signal.check()?;
        prepared.thread.assert_current(runtime)?;
        let operation = payload_digest(&json!([
            json!(key.0),
            json!(key.1),
            json!(key.2),
            command["executionLaneId"].clone(),
            command["clientMessageId"].clone(),
        ]));
        let operation = if task.is_some() {
            id(
                &command["taskInferenceInput"]["operationId"],
                "Task input operation",
            )?
        } else {
            root.as_ref()
                .map_or_else(|| operation.into(), |root| root.generation.clone())
        };
        let source = Source::claimed(operation, Some(signal.clone()));
        let admission = runtime.admission();
        let mut request = Acquire::new(
            admission.lifetime_for_source(&source)?,
            command["provider"].clone(),
        );
        request.purpose = Some("turn".into());
        request.chat_id = Some(command["chatId"].clone());
        request.project_id = command
            .get("policyProjectId")
            .filter(|value| !value.is_null())
            .cloned();
        request.thread_id = Some(thread.clone());
        request.signal = Some(source.signal());
        let mut recovery = json!({"messageId": command["clientMessageId"], "threadId": thread});
        if root.is_some() || task.is_some() {
            request.recovery_key = Some(json!(crate::native_items::concat(&[
                "chat:".into(),
                key.2.clone(),
                ":message:".into(),
                id(&command["clientMessageId"], "chat message identity")?,
            ])));
        }
        if let Some(root) = &root {
            recovery["commandId"] = json!(root.operation);
            recovery["commandGeneration"] = json!(root.generation);
        }
        if task.is_some() {
            recovery["taskInput"] = command["taskInferenceInput"].clone();
        }
        request.recovery = Some(recovery);
        if is_queued && root.is_some() && task.is_none() {
            active.queued_inference.get_or_init(|| {
                handoff::withdrawal::QueuedInference::new(admission.clone(), source.clone())
            });
        }
        let acquired = async {
            let shared_title = if let Some(title) = title {
                if title.shares_provider(&command["provider"]) {
                    Some(title)
                } else {
                    let job = title.clone();
                    let preparation = self.preparation.clone();
                    let encryption = self.encryption.clone();
                    let result = admission
                        .prepare_before_acquire(request.clone(), move |signal| {
                            Box::pin(job.separate(preparation, encryption, signal))
                        })
                        .await;
                    if result.as_ref().err().is_some_and(|error| {
                        crate::inference::withdrawal::Withdrawal::in_error(error).is_some()
                    }) {
                        result?;
                    } else {
                        title.report(&emit, result)?;
                    }
                    None
                }
            } else {
                None
            };
            let execution = admission.acquire(request).await?;
            Ok::<_, anyhow::Error>((execution, shared_title))
        }
        .await;
        let (execution, shared_title) = match acquired {
            Ok(acquired) => acquired,
            Err(error) => {
                source.close();
                if task.is_some()
                    && let Some(withdrawal) =
                        crate::inference::withdrawal::Withdrawal::in_error(&error)
                {
                    tokio::select! {
                        _ = withdrawal.wait(Some(signal.clone())) => {},
                        _ = runtime.retired() => {},
                    }
                    return Err(error);
                }
                return Err(active
                    .finish_withdrawal(runtime, &signal)
                    .await
                    .unwrap_or(error));
            }
        };
        let result = async {
            if let Some(input) = &active.task_input {
                input.bind(&execution)?;
            }
            if let Some(title) = shared_title {
                let result = title
                    .shared(runtime, &execution, self.encryption.clone())
                    .await;
                title.report(&emit, result)?;
            }
            signal.check()?;
            let _standalone_skills = if command["contextKind"] == "standalone" {
                let sources = self.preparation.standalone_skill_sources(&command).await?;
                let cwd = id(&command["cwd"], "native workspace path")?;
                Some(
                    runtime
                        .standalone_skills()
                        .prepare(runtime, sources, &cwd, &signal)
                        .await?,
                )
            } else {
                None
            };
            let guest = prepared.environment.is_some();
            let skill_inputs = if retained.is_none() && command["contextKind"] == "project" {
                let names = if protection.is_some()
                    || command["resultMode"]["operation"]["classification"]["kind"] == "direct"
                {
                    skills::mentions(&prompt)
                } else {
                    command["skillNames"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(Value::as_js_string)
                        .cloned()
                        .collect()
                };
                let cwd = id(&command["cwd"], "native workspace path")?;
                skills::turn_inputs(runtime, &cwd, &names, RPC_TIMEOUT).await?
            } else {
                Vec::new()
            };
            let mut input = if is_queued
                || (guest
                    && command["attachments"]
                        .as_array()
                        .is_some_and(|items| !items.is_empty()))
            {
                let scope = Scope::new(self.encryption.clone())?;
                if scope.owner != key.0 || scope.server != key.1 {
                    bail!("The worker binding changed before opening turn attachments.");
                }
                queued::inputs(
                    &command,
                    &prompt,
                    retained,
                    runtime,
                    queued::InputSource {
                        store: &self.attachments,
                        keys: &ServiceKeys(self.encryption.clone()),
                        scope: &scope,
                        guest: guest.then_some(self.guest_files.as_ref()),
                        signal: &signal,
                    },
                )
                .await?
            } else {
                vec![json!({"type":"text","text":prompt})]
            };
            input.extend(skill_inputs);
            let mut params = params::native_input(
                &command,
                input,
                runtime,
                thread,
                self.preparation.supports_permission_profiles(),
                prepared.environment.as_deref(),
                policy_context,
            )
            .await?;
            if let Some(schema) = task.as_ref().and_then(|task| task.turn.output_schema()) {
                params["outputSchema"] = schema.clone();
            }
            prepared.thread.assert_current(runtime)?;
            let cua = if params::computer_use_enabled(&command) {
                let publication = if let Some(task) = &task {
                    computer_use::Publication::Task(task.turn.messages())
                } else {
                    computer_use::Publication::Chat(protection.clone().context("Missing protected Chat context.")?)
                };
                Some(computer_use::Turn::new(self.computer_use.clone(), epoch.context("Computer use requires an active worker socket.")?,
                    runtime, thread.clone(), emit.clone(), publication, signal.clone()))
            } else {
                None
            };
            let (subscription, mut events, capture) =
                output::subscribe_with_context(&runtime.history(), thread, context.clone(),
                    cua.as_ref().map(|lifetime| Arc::new(OnceLock::from(Arc::downgrade(&lifetime.0)))))?;
            let transport = subscription.signal();
            let result = async {
                execution.bind_thread(thread.clone())?;
                execution.seal_input_dispatch().await?;
                let mut mcp = Some(
                    self.preparation
                        .activate(&prepared, &command["executionLaneId"])?
                );
                if let Some(context) = &context
                    && let Some(activation) = mcp.as_ref().and_then(Option::as_ref)
                {
                    activation.track_context(context.clone());
                }
                if let Some(cua) = &cua {
                    let activation = mcp.as_ref().and_then(Option::as_ref).context("The computer-use MCP attachment is unavailable.")?;
                    cua.0.register(activation, &command["computerUseAuthority"])?;
                }
                if task.is_some() {
                    self.task_inputs
                        .authorize(
                            &key.0,
                            &key.1,
                            &command["taskInferenceInput"],
                            "dispatch",
                            None,
                            signal.clone(),
                        )
                        .await?;
                    prepared.thread.assert_current(runtime)?;
                }
                let goal = task::is_goal(&command);
                if !goal {
                    active.dispatch(&signal, thread.clone())?;
                }
                if let Some(receipt) = &receipt {
                    receipt.dispatch().await?;
                    signal.check()?;
                    prepared.thread.assert_current(runtime)?;
                }
                let canonical = root
                    .as_ref()
                    .filter(|_| command["contextKind"] == "project")
                    .map(|root| {
                        self.history.capture_outputs(
                            sources::Input {
                                chat_id: key.2.clone(),
                                thread_id: thread.clone(),
                                runtime: runtime.history(),
                                provenance: Some(json!({
                                    "kind": "command", "operationId": root.operation,
                                    "operationGeneration": root.generation,
                                })),
                            },
                            transport.clone(),
                        )
                    });
                let task_interactions = active.task_input.as_deref().filter(|_| !task::is_structured(&command));
                let interactions = if let Some(attempt) = task_interactions {
                    Some((&attempt.interactions, interactions::Authority::Task(&key, attempt)))
                } else if task.is_none() {
                    receipt.as_ref().zip(active.control.get()).map(|(receipt, binding)| {
                        (&binding.interactions, interactions::Authority::Receipt(receipt))
                    })
                } else {
                    None
                };
                let mut native_interactions = if interactions.is_some() {
                    Some(runtime.interaction_requests(thread,
                        command["contextKind"] == "project" && prepared.environment.is_none())?)
                } else { None };
                let send = || async {
                    if goal {
                        active.dispatch(&signal, thread.clone())?;
                    }
                    if let Err(error) = execution.dispatched() {
                        execution.rejected()?;
                        return Err(error);
                    }
                    if let Some(binding) = active.control.get() {
                        binding.capture(&command, capture.clone());
                    }
                    if let Some(task) = &task {
                        let checkpoint = task.turn.checkpoint(&command, capture);
                        let _ = active.task.set(checkpoint);
                    }
                    let pending_input = (!is_queued && receipt.is_some() && protection.is_some())
                        .then(|| params["input"].clone());
                    if let Some(cua) = &cua {
                        cua.0.dispatched();
                    }
                    let reply = runtime
                        .request("turn/start".into(), Some(params), Some(RPC_TIMEOUT), None)
                        .await;
                    let turn = match reply {
                        Ok(Some(reply)) => id(&reply["turn"]["id"], "native turn identity")
                            .map(|turn| (turn, Some(reply))),
                        Err(error)
                            if error
                                .downcast_ref::<Failure>()
                                .is_some_and(|failure| failure.native_error.is_some()) =>
                        {
                            execution.rejected()?;
                            execution.settled().await?;
                            if let Some(receipt) = &receipt {
                                let failure = error.downcast_ref::<Failure>().unwrap();
                                let native = failure.native_error.as_ref().unwrap();
                                if queued::deferred(native)
                                    && (is_queued || pending_input.is_some())
                                {
                                    let retained = if let Some(input) = &pending_input {
                                        Some(
                                            crate::chat_content::queue::retain_gui(
                                                receipt.scope(),
                                                &command,
                                                input,
                                            )
                                            .await?,
                                        )
                                    } else {
                                        None
                                    };
                                    // Core may assign a new physical attempt as soon as
                                    // the deferred receipt releases the canonical lane.
                                    drop(native_interactions.take());
                                    drop(mcp.take());
                                    active.logical_finished.store(true, Ordering::Relaxed);
                                    drop(owner.take());
                                    receipt.defer_queue_input(native, retained).await?;
                                    return Err(crate::encryption::ServiceError::new(
                                        "native-settings-pending",
                                        "The native input was deferred while its permission settings settle.",
                                    ).into());
                                } else {
                                    receipt.rejected(native).await?;
                                }
                            }
                            return Err(error);
                        }
                        Err(error) => Err(error),
                        Ok(None) => Err(anyhow!("Codex did not confirm the native turn identity.")),
                    };
                    match turn {
                        Ok(turn) => Ok(turn),
                        Err(error) => {
                            // A lost acknowledgement must not make the lane reusable.
                            match output::started(&mut events, &transport).await {
                                Ok(turn) => Ok((turn, None)),
                                Err(_) => {
                                    runtime.retired().await?;
                                    Err(error)
                                }
                            }
                        }
                    }
                };
                let (turn, reply) = if let Some((_, commit)) =
                    task.as_ref().and_then(|task| task.goal_commit.as_ref())
                {
                    let cycle = self.task_goal_cycle(
                        &command,
                        &key,
                        &prepared,
                        emit.clone(),
                        commit,
                        &command["taskInferenceInput"],
                    );
                    task::first_input::start(
                        &prepared,
                        &command["taskInferenceInput"],
                        &signal,
                        cycle,
                        send,
                    )
                    .await?
                } else {
                    send().await?
                };
                if let Some(cua) = &cua {
                    cua.0.started(&turn);
                }
                if let Some(interactions) = &native_interactions {
                    interactions.bind_turn(&turn)?;
                }
                let bound = execution.bind_turn(turn.clone());
                if let Some(context) = &context {
                    context.bind(&turn);
                }
                active.set(Phase::Running {
                    runtime: runtime.clone(),
                    thread: thread.clone(),
                    turn: turn.clone(),
                });
                let applied = async {
                    let Some(receipt) = &receipt else {
                        return Ok(());
                    };
                    let result = match &reply {
                        Some(reply) => receipt.applied(reply, Some(&turn)).await,
                        None => receipt.observed(&turn, None).await,
                    };
                    active.control.get().unwrap().published(result.is_ok());
                    result
                };
                let interaction_events = emit.clone();
                let emit = match &task {
                    Some(task) => task.turn.events(emit),
                    None => emit,
                };
                let (emit, publish) = match (protection.as_ref(), canonical) {
                    (Some(protection), Some(identity)) => {
                        let (emit, publish) = protection.publish_canonical(emit, identity);
                        (emit, Some(publish))
                    }
                    (Some(protection), None) => (protection.attach(emit), None),
                    (None, _) => (emit, None),
                };
                let task_summary = task.is_some();
                let observe = async {
                    let saved = Value::Null;
                    let collecting = output::collect_restored(&mut events, &transport, thread, &turn, &emit, &saved, task_summary);
                    let result = if let (Some((handle, authority)), Some(subscribed)) = (interactions, native_interactions.as_mut()) {
                        interactions::Turn {
                            runtime, authority, thread, turn: &turn,
                            thread_version: prepared.thread.version(),
                            encryption: &self.encryption,
                            emit: if task_interactions.is_some() { &interaction_events } else { &emit },
                            protected: task_interactions.is_some() || protection.is_some(),
                        }.observe(handle, &mut subscribed.events, collecting).await
                    } else { collecting.await };
                    drop(native_interactions.take());
                    if let Some(cua) = &cua {
                        cua.0.retire();
                    }
                    active.set(Phase::Terminal);
                    result
                };
                let (result, applied) = tokio::join!(observe, applied);
                if result.is_err()
                    && transport.check().is_err()
                    && let Some(task) = &mut task
                    && let Some(capture) = active.task.get()
                {
                    // A disconnected observer cannot settle a saved Task.
                    // Core still owns its suspended input and its next action.
                    task.retained_checkpoint = capture.evidence.lock().await.is_some();
                }
                drop(emit);
                let settled = async {
                    if transport.check().is_err() {
                        runtime.retired().await?;
                    }
                    execution.settled().await?;
                    bound?;
                    let settled = result?;
                    if let Some(cua) = &cua {
                        cua.0.finish().await?;
                    }
                    if settled.status == "interrupted" {
                        self.preparation.renew_runner_on_next_prepare(&key.2, &prepared.bound, runtime, thread);
                    }
                    if let Some(receipt) = &receipt {
                        receipt.observed(&turn, Some(settled.status)).await?;
                    }
                    applied?;
                    settled.result
                }
                .await;
                let published = match publish {
                    Some(publish) => publish.await,
                    None => Ok(()),
                };
                settled.and_then(|value| {
                    published?;
                    Ok(value)
                })
            }
            .await;
            if result.is_err() && let Some(cua) = &cua {
                let _ = cua.0.finish().await;
            }
            subscription.close();
            result
        }
        .await;
        let cleanup = execution.not_dispatched();
        source.close();
        if result.is_err()
            && let Some(deferral) = active.finish_withdrawal(runtime, &signal).await
        {
            return Err(deferral);
        }
        if task.is_some() {
            execution.settled().await?;
        }
        let outcome = result.and_then(|value| {
            cleanup?;
            match (protection, task) {
                (Some(protection), _) => protection.result(value),
                (_, Some(task)) => task.turn.finish(value),
                _ => Ok(value),
            }
        });
        if let Some(context) = context {
            if outcome.is_ok() {
                context.finish(|| {
                    let mut next = params::preparation(&command);
                    next["type"] = json!(COMPACT);
                    next["chatId"] = command["chatId"].clone();
                    next["threadId"] = json!(thread);
                    context::Followup {
                        key: key.clone(),
                        runtime_generation: runtime.generation().to_owned(),
                        thread_version: prepared.thread.version(),
                        signal: signal.clone(),
                        command: next,
                    }
                });
            } else {
                context.cancel();
            }
        }
        outcome
    }

    fn task_goal_cycle(
        &self,
        command: &Value,
        key: &Key,
        prepared: &crate::codex::preparation::command::Prepared,
        emit: Emit,
        commit: &Promise<()>,
        parent: &Value,
    ) -> Arc<task::cycle::GoalCycle> {
        Arc::new(task::cycle::GoalCycle {
            parent: Some(parent.clone()),
            placement: json!({
                "cycleId":parent["dispatch"]["cycleId"], "modelRouteId":parent["modelRouteId"],
                "providerAccountId":parent["providerAccountId"], "orderEpoch":parent["queueOrderEpoch"].as_u64().unwrap_or(0),
            }),
            project: command["policyProjectId"].clone(),
            worktree: parent["worktreeId"].clone(),
            enqueued: watch::channel(None).0,
            handoff_completed: None,
            encryption: self.encryption.clone(),
            key: key.clone(),
            client: self.task_inputs.clone(),
            outcomes: self.task_outcomes.clone(),
            observation: prepared.runtime.history(),
            activate: self.preparation.cycle_activation(prepared),
            emit,
            reuse_published_response: command["resultMode"]["reusePublishedResponse"] == true,
            previous: AsyncMutex::new(commit.clone()),
            checkpoints: task::cycle::Checkpoints::new(command),
        })
    }
}

fn id(value: &Value, name: &str) -> Result<JsString> {
    value
        .as_js_string()
        .filter(|text| !text.is_empty())
        .cloned()
        .with_context(|| format!("Invalid {name}."))
}

fn protected_mode(command: &Value) -> bool {
    command["resultMode"]["kind"] == "chat-message-encrypted"
}
