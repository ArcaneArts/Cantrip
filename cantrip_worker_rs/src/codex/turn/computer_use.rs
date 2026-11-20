//! Computer-use MCP authority belongs to a turn observed on this app-server.
mod model;

use super::{Emit, Signal, protected::Protected};
use crate::{
    codex::managed::{Runtime, WeakRuntime},
    computer_use::{DesktopTurn, HostActivity, HostError, Javascript, NativeError},
    desktop_inventory::preview::{ObservedTurn, Previews},
    history::lineage,
    mcp::bindings::{Activation, ComputerUseAuthority, ComputerUseExecutor},
    metadata::Abort,
};
use anyhow::{Context, Result, ensure};
use cantrip_wire::{JsString, Value, value::json};
use futures::future::BoxFuture;
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex, OnceLock},
};
use tokio::sync::{Mutex as AsyncMutex, Notify};

#[derive(Clone)]
pub(super) struct Desktop {
    pub(crate) previews: Previews,
    pub(crate) binary: PathBuf,
}

enum Phase {
    Preparing,
    Dispatched,
    Running(JsString),
    Retired,
}

pub(super) struct Turn {
    desktop: Desktop,
    epoch: u64,
    emit: Emit,
    protection: Option<Arc<Protected>>,
    publication_failed: Mutex<bool>,
    runtime: WeakRuntime,
    thread: JsString,
    phase: Mutex<Phase>,
    authority: OnceLock<ComputerUseAuthority>,
    cancel: Abort,
    signal: Signal,
    actors: Mutex<HashMap<(JsString, JsString), Arc<Actor>>>,
    calls: Mutex<usize>,
    drained: Notify,
}

struct Actor {
    signal: Signal,
    scope: Value,
    session: AsyncMutex<Option<Session>>,
    observations: ObservedTurn,
    pending: Mutex<Option<Pending>>,
}

struct Pending {
    id: uuid::Uuid,
    reset: bool,
    cancel: Abort,
}

struct Call<'a> {
    turn: &'a Turn,
    actor: &'a Actor,
    id: uuid::Uuid,
    signal: Signal,
}

impl Drop for Call<'_> {
    fn drop(&mut self) {
        let mut calls = self.turn.calls.lock().unwrap();
        let mut pending = self.actor.pending.lock().unwrap();
        if pending.as_ref().is_some_and(|call| call.id == self.id) {
            pending.take();
        }
        *calls -= 1;
        if *calls == 0 {
            self.turn.drained.notify_one();
        }
    }
}

struct Session {
    desktop: DesktopTurn,
    javascript: Javascript,
}

pub(super) struct Lifetime(pub(super) Arc<Turn>);

impl Drop for Lifetime {
    fn drop(&mut self) {
        self.0.retire();
    }
}

impl Turn {
    pub(super) fn new(
        desktop: Desktop,
        epoch: u64,
        runtime: &Runtime,
        thread: JsString,
        emit: Emit,
        protection: Option<Arc<Protected>>,
        parent: Signal,
    ) -> Lifetime {
        let (cancel, signal) = Abort::new();
        Lifetime(Arc::new(Self {
            desktop,
            epoch,
            thread,
            emit,
            protection,
            publication_failed: Mutex::default(),
            runtime: runtime.downgrade(),
            phase: Mutex::new(Phase::Preparing),
            authority: OnceLock::new(),
            cancel,
            signal: Signal::any(vec![parent, signal]),
            actors: Mutex::default(),
            calls: Mutex::default(),
            drained: Notify::new(),
        }))
    }

    pub(super) fn register(self: &Arc<Self>, activation: &Activation, raw: &Value) -> Result<()> {
        let authority = activation.computer_use_authority(raw)?;
        self.authority
            .set(authority)
            .map_err(|_| anyhow::anyhow!("The turn already owns computer use."))?;
        activation.register_computer_use(raw, self.clone())
    }

    pub(super) fn dispatched(&self) {
        let mut phase = self.phase.lock().unwrap();
        if matches!(*phase, Phase::Preparing) {
            *phase = Phase::Dispatched;
        }
    }

    pub(super) fn observe(&self, frame: &Value) {
        let params = &frame["params"];
        if params["threadId"].as_js_string() != Some(&self.thread) {
            return;
        }
        let Some(turn) = params["turn"]["id"].as_js_string() else {
            return;
        };
        match frame["method"].as_str() {
            Some("turn/started") => self.started(turn),
            Some("turn/completed") if self.owns_turn(&self.thread, turn) => self.retire(),
            _ => {}
        }
    }

    pub(super) fn started(&self, turn: &JsString) {
        let mut phase = self.phase.lock().unwrap();
        match &*phase {
            Phase::Dispatched => *phase = Phase::Running(turn.clone()),
            Phase::Running(prior) if prior != turn => {
                drop(phase);
                self.retire();
            }
            _ => {}
        }
    }

    pub(super) fn retire(&self) {
        *self.phase.lock().unwrap() = Phase::Retired;
        self.cancel
            .abort(anyhow::anyhow!("The native computer-use turn ended."));
        for (_, actor) in self.actors.lock().unwrap().drain() {
            actor.observations.clear();
        }
    }

    pub(super) async fn finish(&self) -> Result<()> {
        self.retire();
        while *self.calls.lock().unwrap() != 0 {
            self.drained.notified().await;
        }
        ensure!(
            !*self.publication_failed.lock().unwrap(),
            "The worker could not publish protected computer-use activity."
        );
        Ok(())
    }

    fn scope(&self, thread: &JsString, turn: &JsString) -> Option<(Value, Signal)> {
        self.signal.check().ok()?;
        let Phase::Running(root_turn) = &*self.phase.lock().unwrap() else {
            return None;
        };
        if thread == &self.thread {
            return (root_turn == turn)
                .then(|| (lineage::root_scope(thread, turn), self.signal.clone()));
        }
        let (scope, child) =
            self.runtime
                .upgrade()?
                .child_turn(&self.thread, root_turn, thread, turn)?;
        Some((scope, Signal::any(vec![self.signal.clone(), child])))
    }

    fn invoke<'a>(&'a self, actor: &'a Actor, id: uuid::Uuid, reset: bool) -> Result<Call<'a>> {
        let mut calls = self.calls.lock().unwrap();
        actor.signal.check()?;
        let mut pending = actor.pending.lock().unwrap();
        if let Some(current) = pending.as_ref() {
            ensure!(
                reset && !current.reset,
                "The native turn already has a computer-use call in progress."
            );
            current.cancel.abort(anyhow::anyhow!(
                "The native computer-use session was reset."
            ));
        }
        let (cancel, signal) = Abort::new();
        *pending = Some(Pending { id, reset, cancel });
        *calls += 1;
        Ok(Call {
            turn: self,
            actor,
            id,
            signal,
        })
    }

    fn activity(&self, activity: Value) {
        if let Some(protection) = &self.protection
            && protection
                .computer_use_activity(&activity)
                .and_then(|event| (self.emit)(event))
                .is_err()
        {
            *self.publication_failed.lock().unwrap() = true;
        }
    }

    async fn refresh(
        &self,
        authority: &ComputerUseAuthority,
        signal: &Signal,
    ) -> Result<(), HostError> {
        tokio::select! {
            biased;
            _ = signal.cancelled() => Err(HostError::new("cancelled")),
            live = authority.current() => match live {
                Ok(true) => Ok(()),
                Ok(false) => {
                    self.retire();
                    Err(HostError::new("ownership-mismatch"))
                }
                Err(_) => Err(HostError::new("permission-denied")),
            },
        }
    }

    fn session(
        &self,
        authority: &ComputerUseAuthority,
        actor: &Actor,
        turn: &JsString,
    ) -> Result<Session> {
        let javascript = Javascript::new(
            self.desktop.binary.clone(),
            Vec::new(),
            json!({
                "sessionId":uuid::Uuid::new_v4().to_string(),"workerId":authority.captured["workerId"],
                "chatId":authority.captured["chatId"],"taskId":Value::Null,"threadId":actor.scope["agentThreadId"],"turnId":turn,
            }),
            actor.signal.clone(),
        )?;
        let desktop =
            self.desktop
                .previews
                .bind_turn(&authority.captured, &javascript, self.epoch)?;
        Ok(Session {
            desktop,
            javascript,
        })
    }
}

impl ComputerUseExecutor for Turn {
    fn owns_turn(&self, thread: &JsString, turn: &JsString) -> bool {
        self.scope(thread, turn)
            .is_some_and(|(_, signal)| signal.check().is_ok())
    }

    fn begin_call(&self, request: &Value, request_id: uuid::Uuid) -> bool {
        let (Some(thread), Some(turn)) = (
            request["threadId"].as_js_string(),
            request["turnId"].as_js_string(),
        ) else {
            return false;
        };
        let Some((scope, signal)) = self.scope(thread, turn) else {
            return false;
        };
        let mut actors = self.actors.lock().unwrap();
        actors.retain(|_, actor| actor.signal.check().is_ok());
        if signal.check().is_err() {
            return false;
        }
        let key = (thread.clone(), turn.clone());
        if let Some(actor) = actors.get(&key) {
            actor.observations.begin(request_id);
            return true;
        }
        // Keep the same bound on simultaneous native agent lifetimes as the
        // Node worker. Expired children release their slot before the next call.
        if actors.len() >= 16 {
            return false;
        }
        let observations = self.desktop.previews.observe_turn();
        observations.begin(request_id);
        actors.insert(
            key,
            Arc::new(Actor {
                signal,
                scope,
                observations,
                session: AsyncMutex::default(),
                pending: Mutex::default(),
            }),
        );
        true
    }

    fn execute(
        &self,
        request: Value,
        request_id: uuid::Uuid,
        signal: Signal,
    ) -> BoxFuture<'_, Result<Value>> {
        Box::pin(async move {
            signal.check()?;
            let authority = self
                .authority
                .get()
                .context("The native turn has no computer-use authority.")?;
            let turn = request["turnId"]
                .as_js_string()
                .context("Missing native turn identity.")?;
            let thread = request["threadId"]
                .as_js_string()
                .context("Missing native thread identity.")?;
            ensure!(
                self.owns_turn(thread, turn),
                "The computer-use native turn is no longer active."
            );
            let actor = self
                .actors
                .lock()
                .unwrap()
                .get(&(thread.clone(), turn.clone()))
                .cloned()
                .context("The computer-use native turn ended before its call.")?;
            let reset = request["operation"] == "js_reset";
            let call = self.invoke(&actor, request_id, reset)?;
            let active = Signal::any(vec![actor.signal.clone(), signal, call.signal.clone()]);
            let publish = |activity| self.activity(activity);
            let activity = HostActivity {
                chat: &authority.captured["chatId"],
                worker: &authority.captured["workerId"],
                thread,
                turn,
                scope: &actor.scope,
                item: &request["itemId"],
                request: request_id,
                publish: &publish,
            };
            let activity = self.protection.as_ref().map(|_| &activity);
            // Publish the terminal record before releasing the session to a reset.
            let mut session;
            let mut terminal = activity.map(|a| a.terminal(reset, active.clone()));
            session = tokio::select! {
                biased;
                reason = active.cancelled() => return Err(reason.into()),
                session = actor.session.lock() => session,
            };
            if let (Some(record), Some(current)) = (&mut terminal, session.as_ref()) {
                record.session(current.desktop.activity_session());
            }
            let result = async {
                if reset {
                    if let Some(session) = session.as_mut() {
                        session.desktop.reset(&mut session.javascript).await?;
                    }
                    return Ok(model::reset());
                }
                let source = request["script"]
                    .as_js_string()
                    .context("Missing computer-use script.")?;
                if session.is_none() {
                    *session = Some(self.session(authority, &actor, turn)?);
                }
                let Session {
                    desktop,
                    javascript,
                } = session.as_mut().unwrap();
                let desktop: &DesktopTurn = desktop;
                let result = desktop
                    .evaluate(
                        javascript,
                        source,
                        active.clone(),
                        activity,
                        |action, call| async move {
                            self.refresh(authority, &call).await?;
                            desktop
                                .approve_action(
                                    action,
                                    request_id,
                                    call.clone(),
                                    self.emit.as_ref(),
                                )
                                .await?;
                            self.refresh(authority, &call).await
                        },
                    )
                    .await?;
                let (response, latest) = model::result(result, active.clone()).await?;
                if let Some(image) = latest {
                    desktop.retain_observation(
                        &actor.observations,
                        request_id,
                        &self.thread,
                        image,
                        active,
                    );
                }
                Ok(response)
            }
            .await;
            if let Some(record) = &mut terminal {
                if let Some(current) = session.as_ref() {
                    record.session(current.desktop.activity_session());
                }
                record.complete(result.as_ref().err().map(activity_error));
            }
            result
        })
    }
}

fn activity_error(error: &anyhow::Error) -> &str {
    if let Some(native) = error.downcast_ref::<NativeError>() {
        native.code()
    } else if error.is::<crate::metadata::Cancelled>() {
        "cancelled"
    } else {
        "operation-failed"
    }
}
