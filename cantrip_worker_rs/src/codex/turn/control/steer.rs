//! Steering submits one input to the exact live turn. For a managed turn,
//! Core owns the queue claim and records a separate control receipt.
use super::{Active, Failure, Phase, RPC_TIMEOUT, Scope, Selection, Turns};
use crate::{
    attachments::content::ServiceKeys,
    codex::turn::{STEER, id, protected::user_prompt_text, queued},
    metadata::{Guard, Signal},
    native_items::{array, concat},
};
use anyhow::{Context, Result, anyhow, bail, ensure};
use cantrip_history::{canonical::open_message, content::Encryption};
use cantrip_wire::{Value, value::json};

const METHOD: &str = "turn/steer";

impl Turns {
    pub(crate) async fn steer(&self, command: &Value, signal: Signal) -> Result<Value> {
        let key = self.key(command)?;
        let active = self
            .active
            .lock()
            .unwrap()
            .active
            .get(&key)
            .cloned()
            .context("The Codex thread does not have an active turn.")?;
        let direct = command["type"] == STEER;
        ensure!(
            active.task_input.is_none() && active.task.get().is_none(),
            "Private Task turns cannot accept queued steering."
        );
        let active_binding = active.control.get().zip(active.root.as_ref());
        let selected = if let Some((binding, root)) = active_binding {
            let matches = if direct {
                (command["threadId"].is_null()
                    || command["threadId"] == binding.session["threadId"])
                    && command["model"]["routeId"] == binding.session["modelRouteId"]
                    && command["provider"]["accountId"] == binding.session["providerAccountId"]
                    && (command["nativeActivationGeneration"].is_null()
                        || command["nativeActivationGeneration"] == root.activation)
            } else {
                binding.matches(command) && command["nativeActivationGeneration"] == root.activation
            };
            ensure!(
                matches,
                "The steer does not identify the current managed turn."
            );
            // Console and autonomous owners can be marked for cleanup while
            // the native turn is still running. Use the live phase and receipt.
            Guard::request(Some(signal.clone()))
                .run(active.select_control(binding, false))
                .await?
                .context("The Codex thread no longer has an active turn.")?
        } else {
            ensure!(
                direct
                    && command["nativeActivationGeneration"].is_null()
                    && command["queueClaim"].is_null(),
                "The steer does not identify a connected managed turn."
            );
            legacy_turn(&active, &command["threadId"])?
        };
        let scope = Scope::new(self.encryption.clone())?;
        ensure!(
            scope.owner == key.0 && scope.server == key.1,
            "The worker binding changed before Chat steering."
        );
        let control = if direct { command } else { &command["control"] };
        let prompt = &control["protectedPrompt"];
        let text = if prompt.is_null() {
            id(&control["prompt"], "steering prompt")?
        } else {
            ensure!(
                prompt["classification"]["role"] == "user"
                    && prompt["classification"]["mode"] == "default",
                "The steer must carry an ordinary protected user prompt."
            );
            let ids = array(&prompt["classification"]["attachmentIds"])?;
            let entries = array(&control["attachments"])?;
            ensure!(
                ids.len() == entries.len()
                    && ids.iter().all(|id| entries
                        .iter()
                        .filter(|entry| entry["id"] == *id)
                        .count()
                        == 1),
                "The steer attachments do not match the protected prompt."
            );
            let grant = scope.material(prompt["protectedContent"]["keyRevision"].as_u64())?;
            let opened = open_message(&grant.key, &json!(grant.owner_id), prompt)
                .map_err(|_| anyhow!("Unable to authenticate the protected steer prompt."))?;
            user_prompt_text(&opened)?
        };
        let mut input = active_binding.map_or_else(
            || command.clone(),
            |(binding, _)| binding.input_target.clone(),
        );
        input["chatId"] = json!(key.2);
        input["attachments"] = control["attachments"].clone();
        let retained = if command["protectedNativeInput"].is_null() {
            None
        } else {
            ensure!(
                command["queueClaim"].is_object()
                    && command["operationId"].is_string()
                    && command["queuedPromptId"].is_string(),
                "The protected steer input requires its exact queue claim."
            );
            input["protectedNativeInput"] = command["protectedNativeInput"].clone();
            input["queuedPromptId"] = command["queuedPromptId"].clone();
            input["protectedPrompt"] = prompt.clone();
            queued::open(&input, &text, &scope)?
        };
        let items = queued::inputs(
            &input,
            &text,
            retained,
            &selected.runtime,
            queued::InputSource {
                store: &self.attachments,
                keys: &ServiceKeys(self.encryption.clone()),
                scope: &scope,
                guest: input["osExecution"]
                    .is_object()
                    .then_some(self.guest_files.as_ref()),
                signal: &signal,
            },
        )
        .await?;
        signal.check()?;
        let mut params =
            json!({"threadId":selected.thread,"expectedTurnId":selected.turn,"input":items});
        if let Some(client) = command["nativeClientUserMessageId"].as_js_string() {
            params["clientUserMessageId"] = json!(client);
        } else if direct && let Some(message) = prompt["id"].as_js_string() {
            params["clientUserMessageId"] = json!(concat(&["cantrip:".into(), message.clone()]));
        }

        let receipt = if let Some((binding, root)) = active_binding {
            let mut session = binding.session.clone();
            session["connectionId"] =
                json!(format!("gui-control:{}", selected.runtime.generation()));
            let mut admission = command.clone();
            admission["permissionProfileId"] = binding.permission.clone();
            let (receipt, _, _) = self
                .receipts
                .admit_command(
                    scope,
                    session,
                    METHOD,
                    &params,
                    &admission,
                    root.activation.clone(),
                )
                .await?;
            if let Err(error) = receipt.dispatch().await {
                receipt
                    .rejected(&json!({"code":-32000,"message":"Native dispatch did not complete."}))
                    .await?;
                return Err(error);
            }
            Some(receipt)
        } else {
            None
        };
        let start = (|| {
            ensure!(
                self.key(command)? == key,
                "The worker binding changed during Chat steering."
            );
            signal.check()?;
            let phase = active.phase.lock().unwrap();
            ensure!(
                selected.current(&phase),
                "The native turn ended before steering was forwarded."
            );
            Ok(selected
                .runtime
                .request(METHOD.into(), Some(params), Some(RPC_TIMEOUT), None))
        })();
        let request = match start {
            Ok(request) => request,
            Err(error) => {
                if let Some(receipt) = &receipt {
                    receipt
                        .rejected(&json!({"code":-32000,"message":"The steer was not forwarded."}))
                        .await?;
                }
                return Err(error);
            }
        };
        match request.await {
            Ok(Some(reply)) if reply["turnId"].as_js_string() == Some(&selected.turn) => {
                if let Some(receipt) = &receipt {
                    receipt.applied(&json!({"result":reply}), None).await?;
                }
                Ok(json!({"steered":true,"turnId":selected.turn}))
            }
            result => {
                if let Some(receipt) = &receipt {
                    if let Some(native) = result
                        .as_ref()
                        .err()
                        .and_then(|error| error.downcast_ref::<Failure>())
                        .and_then(|failure| failure.native_error.as_ref())
                    {
                        receipt.rejected(native).await?;
                    } else {
                        receipt.uncertain().await?;
                    }
                }
                bail!("Codex could not confirm steering for the selected turn.");
            }
        }
    }
}

fn legacy_turn(active: &Active, requested: &Value) -> Result<Selection> {
    let phase = active.phase.lock().unwrap();
    if let Phase::Running {
        runtime,
        thread,
        turn,
    } = &*phase
        && runtime.is_live()
        && (requested.is_null() || requested.as_js_string() == Some(thread))
    {
        return Ok(Selection {
            runtime: runtime.clone(),
            thread: thread.clone(),
            turn: turn.clone(),
            thread_version: runtime.thread_version(thread),
        });
    }
    bail!("The Codex thread does not have an active turn.");
}
