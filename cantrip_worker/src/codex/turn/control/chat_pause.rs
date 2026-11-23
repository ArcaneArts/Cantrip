//! Core uses the chat-level pause command before it has an active turn
//! selector. Resolve the current worker owner before forwarding a control.
use super::{Action, Active, Phase, Selection, Turns, pause};
use anyhow::{Context, Result, bail, ensure};
use cantrip_wire::{Value, value::json};

impl Turns {
    pub(crate) async fn set_pause(&self, command: &Value) -> Result<Value> {
        if !command["task"].is_null() {
            return self.task_pause(command).await;
        }
        let key = self.key(command)?;
        let bound = (key.0.clone(), json!(key.1));
        let chat = &key.2;
        let paused = command["paused"] == true;
        let latch = self.preparation.chat_pause_latch(&bound, chat)?;
        let _control = latch.control.lock().await;
        let previously_paused = latch.paused();
        let active = self.active.lock().unwrap().active.get(&key).cloned();
        let running = if let Some(active) = &active {
            ensure!(
                active.task_input.is_none() && active.task.get().is_none(),
                "The private Task pause requires its canonical scope."
            );
            if !command["nativeActivationGeneration"].is_null() {
                ensure!(
                    active.root.as_ref().is_some_and(|root| {
                        command["nativeActivationGeneration"] == root.activation
                    }),
                    "The Chat pause belongs to a replaced activation."
                );
            }
            running(active, paused).await?
        } else {
            ensure!(
                command["nativeActivationGeneration"].is_null(),
                "The Chat pause has no current activation."
            );
            None
        };
        // A turn can be acknowledged while Core is sending the chat-level
        // control. Use its existing durable receipt path once the owner is known.
        if let (Some(active), Some(selected)) = (&active, &running)
            && let (Some(root), Some(binding)) = (&active.root, active.control.get())
        {
            let target = json!({
                "chatId":chat,"threadId":selected.thread,"nativeActivationGeneration":root.activation,
                "nativeRuntimeGeneration":binding.session["runtimeGeneration"],
                "modelRouteId":binding.session["modelRouteId"],"providerAccountId":binding.session["providerAccountId"],
            });
            return self.control_active(&target, Action::Pause(paused)).await;
        }

        let attempt = async {
            let runtime = self.preparation.apply_chat_pause(&bound, chat, &latch, paused)?;
            if let (Some(active), Some(selected)) = (&active, &running) {
                ensure!(active.root.is_none(), "The native Chat has no control receipt.");
                let (thread, owner) = self.preparation.selected_live_owner(chat, &bound)
                    .context("The Chat pause has no current native thread.")?;
                ensure!(
                    thread.id() == &selected.thread && thread.version() == selected.thread_version
                        && owner.runtime.generation() == selected.runtime.generation(),
                    "The Chat pause belongs to a replaced native thread."
                );
                return legacy_pause(active, selected, paused).await;
            }
            if paused && let Some(runtime) = runtime {
                let adapter = runtime.admission();
                ensure!(
                    adapter.can_hold_unstarted_chat(chat, false),
                    "Native input dispatch or provider preparation is in progress. Retry Pause after preparation finishes, or Stop the operation."
                );
                adapter.confirm_chat_hold(chat).await?;
            }
            Ok(None)
        }.await;
        let controlled = match attempt {
            Ok(controlled) => controlled,
            Err(error) => {
                let _ = self
                    .preparation
                    .apply_chat_pause(&bound, chat, &latch, previously_paused);
                return Err(error);
            }
        };
        ensure!(
            self.preparation.identity()? == bound,
            "The worker binding changed during Chat pause."
        );
        pause::result(paused, controlled)
    }
}

async fn running(active: &Active, paused: bool) -> Result<Option<Selection>> {
    let mut changes = active.changed.subscribe();
    loop {
        {
            let phase = active.phase.lock().unwrap();
            match &*phase {
                Phase::Running {
                    runtime,
                    thread,
                    turn,
                } => {
                    return Ok(Some(Selection {
                        runtime: runtime.clone(),
                        thread: thread.clone(),
                        turn: turn.clone(),
                        thread_version: active.control.get().map_or_else(
                            || runtime.thread_version(thread),
                            |binding| binding.thread_version,
                        ),
                    }));
                }
                // Resume can release a held begin before Codex has assigned
                // its turn ID. Pause waits for the exact in-flight turn.
                Phase::Sending(_) if paused => {}
                _ => return Ok(None),
            }
        }
        changes.changed().await?;
    }
}

async fn legacy_pause<'a>(
    active: &Active,
    selected: &'a Selection,
    paused: bool,
) -> Result<Option<&'a Selection>> {
    let request = {
        let phase = active.phase.lock().unwrap();
        if !selected.current(&phase) {
            return Ok(None);
        }
        selected.runtime.request(
            "turn/pause".into(),
            Some(json!({"threadId":selected.thread,"turnId":selected.turn,"paused":paused})),
            Some(pause::BOUNDARY_TIMEOUT),
            None,
        )
    };
    let response = request.await;
    if !selected.current(&active.phase.lock().unwrap()) {
        return Ok(None);
    }
    let response = response?.context("Codex did not acknowledge the Chat pause.")?;
    if response["paused"] != paused {
        bail!("Codex acknowledged a different Pause control.");
    }
    Ok(Some(selected))
}
