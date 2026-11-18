//! Server-owned host turns. The command channel supplies the execution lane;
//! the native runtime supplies the turn identity and terminal settlement.
mod output;
mod params;
mod protected;

use super::{
    admission::Acquire,
    managed::Runtime,
    preparation::{Intent, command::Ensurer},
    rpc_requests::Failure,
};
use crate::{
    encryption::Service,
    history::live::observation::{Observer, Runtime as _},
    http::checked,
    inference::admission::Source,
    metadata::{Abort, Signal},
};
use anyhow::{Context, Result, anyhow, bail};
use cantrip_wire::{JsString, Value, payload_digest, value::json};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::{mpsc, watch};

pub(crate) const RUN: &str = "chat.turn";
pub(crate) const INTERRUPT: &str = "chat.interrupt";
const RPC_TIMEOUT: Duration = Duration::from_secs(120);

type Key = (JsString, JsString, JsString);
type Sessions = Arc<Mutex<HashMap<Key, Arc<Active>>>>;
pub(crate) type Emit = Arc<dyn Fn(Value) -> Result<()> + Send + Sync>;

#[derive(Clone)]
pub(crate) struct Turns {
    preparation: Ensurer,
    encryption: Arc<Service>,
    active: Sessions,
}

struct Active {
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
        if entries
            .get(&self.key)
            .is_some_and(|entry| Arc::ptr_eq(entry, &self.active))
        {
            entries.remove(&self.key);
        }
        self.active.set(Phase::Finished);
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
    pub(crate) fn new(preparation: Ensurer, encryption: Arc<Service>) -> Self {
        Self {
            preparation,
            encryption,
            active: Arc::default(),
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

    pub(crate) async fn interrupt(&self, command: &Value) -> Result<Value> {
        if ["task", "taskStop", "nativeActivationGeneration"]
            .iter()
            .any(|field| command.get(field).is_some_and(|value| !value.is_null()))
        {
            bail!("This native interrupt requires a host turn owned by the command channel.");
        }
        let active = self
            .active
            .lock()
            .unwrap()
            .get(&self.key(command)?)
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

    pub(crate) async fn run(&self, incoming: &Value, emit: Emit) -> Result<Value> {
        self.run_owned(incoming, emit)
            .await
            .map_err(|error| protected::redact(incoming, error))
    }

    async fn run_owned(&self, incoming: &Value, emit: Emit) -> Result<Value> {
        params::validate(incoming)?;
        let key = self.key(incoming)?;
        let (abort, signal) = Abort::new();
        let active = Arc::new(Active {
            preparation: abort,
            phase: Mutex::new(Phase::Preparing(
                incoming["threadId"].as_js_string().cloned(),
            )),
            changed: watch::channel(0).0,
        });
        {
            let mut entries = self.active.lock().unwrap();
            if entries.contains_key(&key) {
                bail!("This chat already has an active native turn.");
            }
            entries.insert(key.clone(), active.clone());
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

        let operation = payload_digest(&json!([
            json!(key.0),
            json!(key.1),
            json!(key.2),
            command["executionLaneId"].clone(),
            command["clientMessageId"].clone(),
        ]));
        let source = Source::claimed(operation.into(), Some(signal.clone()));
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
        request.recovery =
            Some(json!({"messageId": command["clientMessageId"], "threadId": thread}));
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
                if let Err(error) = execution.dispatched() {
                    execution.rejected()?;
                    return Err(error);
                }
                let reply = runtime
                    .request("turn/start".into(), Some(params), Some(RPC_TIMEOUT), None)
                    .await;
                let turn = match reply {
                    Ok(Some(reply)) => id(&reply["turn"]["id"], "native turn identity"),
                    Err(error)
                        if error
                            .downcast_ref::<Failure>()
                            .is_some_and(|failure| failure.native_error.is_some()) =>
                    {
                        execution.rejected()?;
                        execution.settled().await?;
                        return Err(error);
                    }
                    Err(error) => Err(error),
                    Ok(None) => Err(anyhow!("Codex did not confirm the native turn identity.")),
                };
                let turn = match turn {
                    Ok(turn) => turn,
                    Err(error) => {
                        // A lost acknowledgement must not make the lane reusable.
                        // This worker owns this native thread. Wait for its order-
                        // preserving observation stream or confirmed process exit.
                        match output::started(&mut events, &transport).await {
                            Ok(turn) => turn,
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
                let result = output::collect(&mut events, &transport, thread, &turn, &emit).await;
                if transport.check().is_err() {
                    runtime.retired().await?;
                }
                execution.settled().await?;
                bound?;
                result
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
