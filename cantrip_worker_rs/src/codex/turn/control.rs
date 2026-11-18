//! Managed desktop Stop must acquire a separate Core control receipt before
//! forwarding the mutation to the exact active native turn.
use super::{Active, Phase, RPC_TIMEOUT, Runtime, Turns};
use crate::{chat_content::Scope, codex::rpc_requests::Failure, http::checked};
use anyhow::{Context, Result, bail};
use cantrip_wire::{JsString, Value, value::json};
use std::sync::atomic::Ordering;
use tokio::sync::watch;

pub(super) struct Binding {
    session: Value,
    permission: Value,
    published: watch::Sender<Option<bool>>,
}

impl Binding {
    pub(super) fn new(session: Value, permission: Value) -> Self {
        Self {
            session,
            permission,
            published: watch::channel(None).0,
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
}

impl Selection {
    fn current(&self, phase: &Phase) -> bool {
        matches!(phase, Phase::Running { runtime, thread, turn }
            if runtime.generation() == self.runtime.generation()
                && thread == &self.thread && turn == &self.turn && runtime.is_live()
        )
    }
}

impl Active {
    async fn select_stop(&self, binding: &Binding) -> Result<Option<Selection>> {
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
                            }));
                        }
                        Some(false) => bail!("Core did not bind the current native turn for Stop."),
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
        if command["control"]["kind"] != "interrupt" {
            bail!("This native control requires a different managed execution path.");
        }
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
        let result = |interrupted| {
            checked(
                "chatInterruptAcceptedSchema",
                &json!({"interrupted": interrupted}),
            )
        };
        let Some(selected) = active.select_stop(binding).await? else {
            return result(false);
        };
        let scope = Scope::new(self.encryption.clone())?;
        if scope.owner != key.0 || scope.server != key.1 {
            bail!("The worker binding changed before native Stop.");
        }
        let mut session = binding.session.clone();
        session["connectionId"] = json!(format!("gui-control:{}", selected.runtime.generation()));
        let params = json!({"threadId": selected.thread, "turnId": selected.turn});
        let receipt = self
            .receipts
            .admit_interrupt(root, scope, session, &params, &binding.permission)
            .await?;
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
