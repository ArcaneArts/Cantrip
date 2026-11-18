//! Server-owned host turns. The command channel supplies the execution lane;
//! the native runtime supplies the turn identity and terminal settlement.
pub(crate) mod autonomous;
mod control;
mod output;
mod params;
mod protected;
pub(super) use protected::runtime_text;
mod receipt;
pub(in crate::codex) mod task;

use super::{
    admission::Acquire,
    managed::Runtime,
    preparation::{Intent, command::Ensurer},
    rpc_requests::Failure,
    task_inputs,
};
use crate::{
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
pub(crate) const COMPLETE: &str = "chat.native-logical.complete";
pub(crate) const CANCEL: &str = "chat.native-logical.cancel";
const RPC_TIMEOUT: Duration = Duration::from_secs(120);

type Key = (JsString, JsString, JsString);
type Sessions = Arc<Mutex<SessionsState>>;

#[derive(Default)]
struct SessionsState {
    active: HashMap<Key, Arc<Active>>,
    cancelled: HashSet<(Key, JsString, JsString)>,
}
pub(crate) type Emit = Arc<dyn Fn(Value) -> Result<()> + Send + Sync>;

#[derive(Clone)]
pub(crate) struct Turns {
    preparation: Ensurer,
    encryption: Arc<Service>,
    active: Sessions,
    receipts: receipt::Client,
    history: History,
    task_inputs: task_inputs::Client,
    task_outcomes: Arc<TaskDelivery>,
}

struct TaskTurn {
    turn: task::Turn,
    key: Key,
    claimed: bool,
    goal_commit: Option<(Complete<()>, Promise<()>)>,
}

struct Active {
    root: Option<receipt::Operation>,
    control: OnceLock<control::Binding>,
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
        if self.active.logical_finished.load(Ordering::Relaxed) {
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

    async fn interrupt(&self, selected: Option<&JsString>) -> Result<bool> {
        let mut changes = self.changed.subscribe();
        loop {
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
    ) -> Result<Self> {
        Ok(Self {
            preparation,
            encryption,
            active: Arc::default(),
            receipts: receipt::Client::new(configuration, generation)?,
            history,
            task_inputs,
            task_outcomes,
        })
    }

    fn key(&self, command: &Value) -> Result<Key> {
        let (owner, server) = self.preparation.identity()?;
        Ok((
            owner,
            id(&server, "logical server identity")?,
            id(&command["chatId"], "chat identity")?,
        ))
    }

    pub(in crate::codex) async fn goal_mutation(
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
            bail!("The worker binding changed before the Goal mutation.");
        }
        let gate = session["threadId"]
            .as_js_string()
            .and_then(|thread| runtime.inference_router().goal_mutations(thread));
        let _mutation = match gate {
            Some(gate) => Some(gate.lock_owned().await),
            None => None,
        };
        let activation = self
            .active
            .lock()
            .unwrap()
            .active
            .get(&key)
            .and_then(|active| active.root.as_ref())
            .map(|root| root.activation.clone())
            .unwrap_or(Value::Null);
        let (receipt, awaiting_goal) = self
            .receipts
            .admit_goal(scope, session, method, &params, command, activation)
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
        let reply = runtime
            .request(method.into(), Some(params), Some(RPC_TIMEOUT), None)
            .await;
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
                bail!("Codex did not return a Goal mutation result.");
            }
        }
    }

    pub(crate) async fn interrupt(&self, command: &Value) -> Result<Value> {
        if ["task", "taskStop"]
            .iter()
            .any(|field| command.get(field).is_some_and(|value| !value.is_null()))
        {
            bail!("This native interrupt requires a host turn owned by the command channel.");
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
            Some(active) => active.interrupt(command["threadId"].as_js_string()).await?,
            None => false,
        };
        checked(
            "chatInterruptAcceptedSchema",
            &json!({"interrupted": interrupted}),
        )
    }

    pub(crate) fn logical(&self, command: &Value) -> Result<Value> {
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
        }
        Ok(json!({}))
    }

    pub(crate) async fn run(&self, incoming: &Value, emit: Emit) -> (Result<Value>, Option<Value>) {
        let goal = task::is_goal(incoming);
        if !task::is_round(incoming) && !goal {
            let result = self
                .run_owned(incoming, emit, None)
                .await
                .map_err(|error| protected::redact(incoming, error));
            return (result, None);
        }
        let encrypted_error = || {
            anyhow!(if goal {
                "Encrypted Task turn failed."
            } else {
                "Encrypted Task operation failed."
            })
        };
        let task = (|| {
            params::validate(incoming)?;
            let key = self.key(incoming)?;
            let turn = task::Turn::open(self.encryption.clone(), incoming, &key)?;
            Ok::<_, anyhow::Error>(TaskTurn {
                turn,
                key,
                claimed: false,
                goal_commit: goal.then(Promise::pair),
            })
        })();
        let mut task = match task {
            Ok(task) => task,
            Err(_) => return (Err(encrypted_error()), None),
        };
        let result = self
            .run_owned(incoming, emit, Some(&mut task))
            .await
            .map_err(|_| encrypted_error());
        let note = if task.claimed {
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
    ) -> Result<Value> {
        params::validate(incoming)?;
        let key = self.key(incoming)?;
        if task.as_ref().is_some_and(|task| key != task.key) {
            bail!("The worker binding changed before Task admission.");
        }
        let root = receipt::Operation::read(incoming)?;
        let (abort, signal) = Abort::new();
        let active = Arc::new(Active {
            logical_finished: AtomicBool::new(root.is_none()),
            root: root.clone(),
            control: OnceLock::new(),
            preparation: abort,
            phase: Mutex::new(Phase::Preparing(
                incoming["threadId"].as_js_string().cloned(),
            )),
            changed: watch::channel(0).0,
        });
        {
            let mut entries = self.active.lock().unwrap();
            if entries.active.contains_key(&key) {
                bail!("This chat already has an active native turn.");
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
        let _owner = Owner {
            sessions: self.active.clone(),
            key: key.clone(),
            active: active.clone(),
        };
        let command = self.preparation.resolve_routing(incoming).await?;
        let (prompt, protection) = if protected_mode(&command) {
            let (prompt, protection) =
                protected::Protected::open(self.encryption.clone(), &command, &key.0, &key.1)?;
            (prompt, Some(Arc::new(protection)))
        } else if let Some(task) = &task {
            (task.turn.prompt(), None)
        } else {
            (id(&command["prompt"], "native turn prompt")?, None)
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
        let acquired = admission.acquire(request).await;
        let execution = match acquired {
            Ok(execution) => execution,
            Err(error) => {
                source.close();
                return Err(error);
            }
        };
        let result = async {
            let mut params = params::native_input(
                &command,
                &prompt,
                runtime,
                thread,
                self.preparation.supports_permission_profiles(),
            )
            .await?;
            if let Some(schema) = task.as_ref().and_then(|task| task.turn.output_schema()) {
                params["outputSchema"] = schema.clone();
            }
            prepared.thread.assert_current(runtime)?;
            let (subscription, mut events) = output::subscribe(&runtime.history(), thread)?;
            let transport = subscription.signal();
            let result = async {
                execution.bind_thread(thread.clone())?;
                execution.seal_input_dispatch().await?;
                let _mcp = self
                    .preparation
                    .activate(&prepared, &command["executionLaneId"])?;
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
                let send = || async {
                    if goal {
                        active.dispatch(&signal, thread.clone())?;
                    }
                    if let Err(error) = execution.dispatched() {
                        execution.rejected()?;
                        return Err(error);
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
                                receipt
                                    .rejected(failure.native_error.as_ref().unwrap())
                                    .await?;
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
                    let cycle = Arc::new(task::cycle::GoalCycle {
                        parent: command["taskInferenceInput"].clone(),
                        project: command["policyProjectId"].clone(),
                        encryption: self.encryption.clone(),
                        key: key.clone(),
                        client: self.task_inputs.clone(),
                        outcomes: self.task_outcomes.clone(),
                        observation: runtime.history(),
                        activate: self
                            .preparation
                            .cycle_activation(&prepared, &command["executionLaneId"]),
                        emit: emit.clone(),
                        reuse_published_response: command["resultMode"]["reusePublishedResponse"]
                            == true,
                        previous: AsyncMutex::new(commit.clone()),
                    });
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
                let bound = execution.bind_turn(turn.clone());
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
                let observe = async {
                    let result =
                        output::collect(&mut events, &transport, thread, &turn, &emit).await;
                    active.set(Phase::Terminal);
                    result
                };
                let (result, applied) = tokio::join!(observe, applied);
                drop(emit);
                let settled = async {
                    if transport.check().is_err() {
                        runtime.retired().await?;
                    }
                    execution.settled().await?;
                    bound?;
                    let settled = result?;
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
            subscription.close();
            result
        }
        .await;
        let cleanup = execution.not_dispatched();
        source.close();
        result.and_then(|value| {
            cleanup?;
            match (protection, task) {
                (Some(protection), _) => protection.result(value),
                (_, Some(task)) => task.turn.finish(value),
                _ => Ok(value),
            }
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
