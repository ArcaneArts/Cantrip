//! Computer-use MCP authority belongs to a turn observed on this app-server.
mod model;

use super::{Emit, Signal, protected::Protected};
use crate::{
    computer_use::{DesktopTurn, HostActivity, HostError, Javascript, NativeError},
    desktop_inventory::preview::{ObservedTurn, Previews},
    mcp::bindings::{Activation, ComputerUseAuthority, ComputerUseExecutor},
    metadata::Abort,
};
use anyhow::{Context, Result, ensure};
use cantrip_wire::{JsString, Value, value::json};
use futures::future::BoxFuture;
use std::{
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
    thread: JsString,
    phase: Mutex<Phase>,
    authority: OnceLock<ComputerUseAuthority>,
    cancel: Abort,
    signal: Signal,
    session: AsyncMutex<Option<Session>>,
    observations: ObservedTurn,
    calls: Mutex<Calls>,
    drained: Notify,
}

#[derive(Default)]
struct Calls {
    pending: Option<Pending>,
    active: usize,
}

struct Pending {
    id: uuid::Uuid,
    reset: bool,
    cancel: Abort,
}

struct Call<'a> {
    turn: &'a Turn,
    id: uuid::Uuid,
    signal: Signal,
}

impl Drop for Call<'_> {
    fn drop(&mut self) {
        let mut calls = self.turn.calls.lock().unwrap();
        if calls
            .pending
            .as_ref()
            .is_some_and(|call| call.id == self.id)
        {
            calls.pending.take();
        }
        calls.active -= 1;
        if calls.active == 0 {
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
        thread: JsString,
        emit: Emit,
        protection: Option<Arc<Protected>>,
        parent: Signal,
    ) -> Lifetime {
        let (cancel, signal) = Abort::new();
        let observations = desktop.previews.observe_turn();
        Lifetime(Arc::new(Self {
            desktop,
            epoch,
            thread,
            emit,
            protection,
            publication_failed: Mutex::default(),
            phase: Mutex::new(Phase::Preparing),
            authority: OnceLock::new(),
            cancel,
            signal: Signal::any(vec![parent, signal]),
            session: AsyncMutex::default(),
            observations,
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
        self.observations.clear();
    }

    pub(super) async fn finish(&self) -> Result<()> {
        self.retire();
        while self.calls.lock().unwrap().active != 0 {
            self.drained.notified().await;
        }
        ensure!(
            !*self.publication_failed.lock().unwrap(),
            "The worker could not publish protected computer-use activity."
        );
        Ok(())
    }

    fn invoke(&self, id: uuid::Uuid, reset: bool) -> Result<Call<'_>> {
        let mut calls = self.calls.lock().unwrap();
        self.signal.check()?;
        if let Some(current) = calls.pending.as_ref() {
            ensure!(
                reset && !current.reset,
                "The native turn already has a computer-use call in progress."
            );
            current.cancel.abort(anyhow::anyhow!(
                "The native computer-use session was reset."
            ));
        }
        let (cancel, signal) = Abort::new();
        calls.pending = Some(Pending { id, reset, cancel });
        calls.active += 1;
        Ok(Call {
            turn: self,
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

    fn session(&self, authority: &ComputerUseAuthority, turn: &JsString) -> Result<Session> {
        let javascript = Javascript::new(
            self.desktop.binary.clone(),
            Vec::new(),
            json!({
                "sessionId":uuid::Uuid::new_v4().to_string(),"workerId":authority.captured["workerId"],
                "chatId":authority.captured["chatId"],"taskId":Value::Null,"threadId":self.thread,"turnId":turn,
            }),
            self.signal.clone(),
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
        *thread == self.thread
            && self.signal.check().is_ok()
            && matches!(&*self.phase.lock().unwrap(), Phase::Running(current) if current == turn)
    }

    fn begin_call(&self, request_id: uuid::Uuid) {
        self.observations.begin(request_id);
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
            let reset = request["operation"] == "js_reset";
            let call = self.invoke(request_id, reset)?;
            let active = Signal::any(vec![self.signal.clone(), signal, call.signal.clone()]);
            let publish = |activity| self.activity(activity);
            let activity = HostActivity {
                chat: &authority.captured["chatId"],
                worker: &authority.captured["workerId"],
                thread,
                turn,
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
                session = self.session.lock() => session,
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
                    *session = Some(self.session(authority, turn)?);
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
                        &self.observations,
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
