//! Managed controls acquire a separate Core receipt for the exact active turn.
mod pause;
mod restore;
use super::{Active, Phase, RPC_TIMEOUT, Runtime, Turns, output};
use crate::{chat_content::Scope, codex::rpc_requests::Failure, http::checked};
use anyhow::{Context, Result, bail};
use cantrip_wire::{JsString, Value, payload_digest, value::json};
use std::sync::{OnceLock, atomic::Ordering};
use tokio::sync::{Mutex, watch};

#[derive(Clone, Copy)]
pub(super) enum Action<'a> {
    Stop,
    Pause(bool),
    Resume(&'a Value),
}

impl Action<'_> {
    pub(super) fn paused(self) -> Option<bool> {
        match self {
            Self::Stop => None,
            Self::Pause(paused) => Some(paused),
            Self::Resume(_) => Some(false),
        }
    }

    pub(super) fn control_id(self) -> Option<Value> {
        match self {
            Self::Resume(command) => Some(command["controlId"].clone()),
            _ => None,
        }
    }
}

pub(super) struct Binding {
    session: Value,
    permission: Value,
    published: watch::Sender<Option<bool>>,
    checkpoint: OnceLock<Capture>,
    pause_control: Mutex<()>,
    thread_version: u64,
}

struct Capture {
    events: output::Capture,
    seed: Value,
}

impl Binding {
    pub(super) fn new(session: Value, permission: Value, thread_version: u64) -> Self {
        Self {
            session,
            permission,
            published: watch::channel(None).0,
            checkpoint: OnceLock::new(),
            pause_control: Mutex::default(),
            thread_version,
        }
    }

    pub(super) fn published(&self, ok: bool) {
        self.published.send_replace(Some(ok));
    }

    fn matches(&self, command: &Value) -> bool {
        (command["threadId"].is_null() || command["threadId"] == self.session["threadId"])
            && (command["nativeRuntimeGeneration"].is_null()
                || command["nativeRuntimeGeneration"] == self.session["runtimeGeneration"])
            && command["modelRouteId"] == self.session["modelRouteId"]
            && command["providerAccountId"] == self.session["providerAccountId"]
    }
}

struct Selection {
    runtime: Runtime,
    thread: JsString,
    turn: JsString,
    thread_version: u64,
}

impl Selection {
    fn current(&self, phase: &Phase) -> bool {
        matches!(phase, Phase::Running { runtime, thread, turn }
            if runtime.generation() == self.runtime.generation()
                && thread == &self.thread && turn == &self.turn && self.transport_current()
        )
    }

    fn transport_current(&self) -> bool {
        self.runtime.is_live() && self.runtime.thread_version(&self.thread) == self.thread_version
    }
}

impl Active {
    async fn select_control(&self, binding: &Binding) -> Result<Option<Selection>> {
        let mut phase_updates = self.changed.subscribe();
        let mut receipt_updates = binding.published.subscribe();
        loop {
            if self.logical_finished.load(Ordering::Relaxed) {
                return Ok(None);
            }
            {
                let phase = self.phase.lock().unwrap();
                match &*phase {
                    Phase::Sending(_) => {}
                    Phase::Running {
                        runtime,
                        thread,
                        turn,
                    } if runtime.is_live() => match *receipt_updates.borrow_and_update() {
                        Some(true) => {
                            return Ok(Some(Selection {
                                runtime: runtime.clone(),
                                thread: thread.clone(),
                                turn: turn.clone(),
                                thread_version: binding.thread_version,
                            }));
                        }
                        Some(false) => {
                            bail!("Core did not bind the current native turn for control.")
                        }
                        None => {}
                    },
                    Phase::Terminal | Phase::Finished => return Ok(None),
                    _ => {
                        bail!("The native control does not identify one connected managed session.")
                    }
                }
            }
            tokio::select! {
                changed = phase_updates.changed() => changed?,
                changed = receipt_updates.changed() => changed?,
            }
        }
    }
}

impl Turns {
    pub(crate) async fn control(&self, command: &Value) -> Result<Value> {
        let action = match command["control"]["kind"].as_str() {
            Some("interrupt") => Action::Stop,
            Some("pause") => Action::Pause(command["control"]["paused"] == true),
            _ => bail!("This native control requires a different managed execution path."),
        };
        self.control_active(command, action).await
    }

    pub(crate) async fn resume_suspension(
        &self,
        command: &Value,
        acknowledge: impl FnOnce(Result<Value>) + Send,
    ) -> Result<Value> {
        let command = self.preparation.resolve_routing(command).await?;
        let key = self.key(&command)?;
        let signature = payload_digest(&command);
        let (active, pending) = {
            let sessions = self.active.lock().unwrap();
            let pending = sessions
                .restoring
                .get(&key)
                .filter(|attempt| attempt.signature == signature)
                .map(|attempt| attempt.response.clone());
            (sessions.active.get(&key).cloned(), pending)
        };
        if let Some(pending) = pending {
            return pending.work().await;
        }
        if active.is_none_or(|active| matches!(*active.phase.lock().unwrap(), Phase::Finished)) {
            return self
                .restore_suspension(&command, key, signature, acknowledge)
                .await;
        }
        let binding = json!({
            "chatId":command["chatId"],"threadId":command["threadId"],
            "nativeActivationGeneration":command["nativeActivationGeneration"],
            "nativeRuntimeGeneration":command["nativeRuntimeGeneration"],
            "modelRouteId":command["model"]["routeId"],
            "providerAccountId":command["provider"]["accountId"],
        });
        self.control_active(&binding, Action::Resume(&command))
            .await
    }

    async fn control_active(&self, command: &Value, action: Action<'_>) -> Result<Value> {
        let mismatch = "The native control does not identify one connected managed session.";
        let key = self.key(command)?;
        let active = self
            .active
            .lock()
            .unwrap()
            .active
            .get(&key)
            .cloned()
            .context(mismatch)?;
        let root = active
            .root
            .as_ref()
            .filter(|root| command["nativeActivationGeneration"] == root.activation)
            .context(mismatch)?;
        let binding = active
            .control
            .get()
            .filter(|binding| binding.matches(command))
            .context(mismatch)?;
        if action.paused() == Some(true) && binding.checkpoint.get().is_none() {
            bail!("The native turn observer was not attached for durable Pause.");
        }
        let _pause = if action.paused().is_some() {
            Some(binding.pause_control.lock().await)
        } else {
            None
        };
        let result = |interrupted| {
            checked(
                "chatInterruptAcceptedSchema",
                &json!({"interrupted": interrupted}),
            )
        };
        let Some(selected) = active.select_control(binding).await? else {
            return match action {
                Action::Pause(paused) => pause::result(paused, None),
                Action::Resume(_) => Err(anyhow::anyhow!(
                    "The suspended native turn is no longer attached."
                )),
                Action::Stop => result(false),
            };
        };
        let scope = Scope::new(self.encryption.clone())?;
        if scope.owner != key.0 || scope.server != key.1 {
            bail!("The worker binding changed before native control.");
        }
        let mut session = binding.session.clone();
        session["connectionId"] = json!(format!("gui-control:{}", selected.runtime.generation()));
        let checkpoint = if let Action::Resume(command) = action {
            Some(binding.resume_checkpoint(command, &selected)?)
        } else {
            None
        };
        let mut params = json!({"threadId": selected.thread, "turnId": selected.turn});
        if let Some(paused) = action.paused() {
            params["paused"] = json!(paused);
        }
        let receipt = self
            .receipts
            .admit_control(root, scope, session, &params, &binding.permission, action)
            .await?;
        if let Some(paused) = action.paused() {
            return self
                .pause(&active, binding, selected, &receipt, paused, checkpoint)
                .await;
        }
        if let Err(error) = receipt.dispatch().await {
            receipt
                .rejected(&json!({"code": -32000, "message": "Native dispatch did not complete."}))
                .await?;
            return Err(error);
        }
        // Snapshot and enqueue while holding the exact phase, so an ended turn
        // can never be replaced between the identity check and the RPC send.
        let request = {
            let phase = active.phase.lock().unwrap();
            (selected.current(&phase) && !active.logical_finished.load(Ordering::Relaxed)).then(
                || {
                    selected.runtime.request(
                        "turn/interrupt".into(),
                        Some(params),
                        Some(RPC_TIMEOUT),
                        None,
                    )
                },
            )
        };
        let Some(request) = request else {
            receipt.rejected(&json!({"code": -32000, "message": "The native turn ended before Stop was forwarded."})).await?;
            return result(false);
        };
        match request.await {
            Ok(reply) => receipt.applied(&json!({"result": reply}), None).await?,
            Err(error) => {
                if let Some(native) = error
                    .downcast_ref::<Failure>()
                    .and_then(|failure| failure.native_error.as_ref())
                {
                    receipt.rejected(native).await?;
                } else {
                    receipt.uncertain().await?;
                }
                bail!("Codex could not confirm Stop for the managed turn.");
            }
        }
        result(true)
    }
}
