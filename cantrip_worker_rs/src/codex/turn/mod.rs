//! Server-owned host turns. The command channel supplies the execution lane;
//! the native runtime supplies the turn identity and terminal settlement.
mod output;
mod params;
mod protected;
mod receipt;

use super::{
    admission::Acquire,
    managed::Runtime,
    preparation::{Intent, command::Ensurer},
    rpc_requests::Failure,
};
use crate::{
    chat_content::Scope,
    config::Config,
    encryption::Service,
    history::live::observation::{Observer, Runtime as _},
    http::checked,
    inference::admission::Source,
    metadata::{Abort, Signal},
};
use anyhow::{Context, Result, anyhow, bail};
use cantrip_wire::{JsString, Value, payload_digest, value::json};
use std::{
    collections::{HashMap, HashSet},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::sync::{mpsc, watch};

pub(crate) const RUN: &str = "chat.turn";
pub(crate) const INTERRUPT: &str = "chat.interrupt";
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
}

struct Active {
    root: Option<receipt::Root>,
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
                    Err(_) if matches!(*self.phase.lock().unwrap(), Phase::Finished) => Ok(false),
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
    ) -> Result<Self> {
        Ok(Self {
            preparation,
            encryption,
            active: Arc::default(),
            receipts: receipt::Client::new(configuration, generation)?,
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
                        command["nativeActivationGeneration"].as_js_string()
                            == Some(&root.activation)
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

    pub(crate) async fn run(&self, incoming: &Value, emit: Emit) -> Result<Value> {
        self.run_owned(incoming, emit)
            .await
            .map_err(|error| protected::redact(incoming, error))
    }

    async fn run_owned(&self, incoming: &Value, emit: Emit) -> Result<Value> {
        params::validate(incoming)?;
        let key = self.key(incoming)?;
        let root = receipt::Root::read(incoming)?;
        let (abort, signal) = Abort::new();
        let active = Arc::new(Active {
            logical_finished: AtomicBool::new(root.is_none()),
            root: root.clone(),
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
        } else {
            (id(&command["prompt"], "native turn prompt")?, None)
        };
        let emit = protection
            .as_ref()
            .map_or(emit.clone(), |protection| protection.attach(emit));
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
        let operation = root
            .as_ref()
            .map_or_else(|| operation.into(), |root| root.generation.clone());
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
        if let Some(root) = &root {
            request.recovery_key = Some(json!(crate::native_items::concat(&[
                "chat:".into(),
                key.2.clone(),
                ":message:".into(),
                id(&command["clientMessageId"], "chat message identity")?,
            ])));
            recovery["commandId"] = json!(root.operation);
            recovery["commandGeneration"] = json!(root.generation);
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
            let params = params::native_input(
                &command,
                &prompt,
                runtime,
                thread,
                self.preparation.supports_permission_profiles(),
            )
            .await?;
            prepared.thread.assert_current(runtime)?;
            let (observed, mut events) = mpsc::unbounded_channel();
            let subscription = runtime.history().observe(
                thread.clone(),
                Observer {
                    capture: Arc::new(move |frame| {
                        if output::observes(&frame["method"]) {
                            let _ = observed.send(frame);
                        }
                        Ok(None)
                    }),
                    on_error: Arc::new(|_, _| Ok(())),
                },
            )?;
            let transport = subscription.signal();
            let result = async {
                execution.bind_thread(thread.clone())?;
                execution.seal_input_dispatch().await?;
                let _mcp = self
                    .preparation
                    .activate(&prepared, &command["executionLaneId"])?;
                active.dispatch(&signal, thread.clone())?;
                if let Some(receipt) = &receipt {
                    receipt.dispatch().await?;
                    signal.check()?;
                    prepared.thread.assert_current(runtime)?;
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
                                .result(&json!({"error": failure.native_error}), None)
                                .await?;
                        }
                        return Err(error);
                    }
                    Err(error) => Err(error),
                    Ok(None) => Err(anyhow!("Codex did not confirm the native turn identity.")),
                };
                let (turn, reply) = match turn {
                    Ok(turn) => turn,
                    Err(error) => {
                        // A lost acknowledgement must not make the lane reusable.
                        // This worker owns this native thread. Wait for its order-
                        // preserving observation stream or confirmed process exit.
                        match output::started(&mut events, &transport).await {
                            Ok(turn) => (turn, None),
                            Err(_) => {
                                runtime.retired().await?;
                                return Err(error);
                            }
                        }
                    }
                };
                let bound = execution.bind_turn(turn.clone());
                active.set(Phase::Running {
                    runtime: runtime.clone(),
                    thread: thread.clone(),
                    turn: turn.clone(),
                });
                let applied = async {
                    if let (Some(receipt), Some(reply)) = (&receipt, &reply) {
                        receipt.result(reply, Some(&turn)).await?;
                    }
                    Ok::<_, anyhow::Error>(())
                };
                let (result, applied) = tokio::join!(
                    output::collect(&mut events, &transport, thread, &turn, &emit),
                    applied,
                );
                if transport.check().is_err() {
                    runtime.retired().await?;
                }
                execution.settled().await?;
                bound?;
                let settled = result?;
                if let Some(receipt) = &receipt {
                    receipt.terminal(&turn, settled.status).await?;
                }
                applied?;
                settled.result
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
            match protection {
                Some(protection) => protection.result(value),
                None => Ok(value),
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
