//! Steering submits one input to the exact live turn. For a managed turn,
//! Core owns the queue claim and records a separate control receipt.
use super::{Active, Failure, Phase, RPC_TIMEOUT, Scope, Selection, Turns};
use crate::{
    attachments::content::ServiceKeys,
    codex::turn::{STEER, id, protected::user_prompt_text, queued, receipt::Receipt},
    metadata::{Guard, Signal},
    native_items::{array, concat},
};
use anyhow::{Context, Result, anyhow, bail, ensure};
use cantrip_history::{canonical::open_message, content::Encryption};
use cantrip_wire::{JsString, Value, value::json};
use std::time::Duration;

pub(in crate::codex::turn) const METHOD: &str = "turn/steer";

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
            Some(receipt)
        } else {
            None
        };
        let council_queue = command["queueClaim"].is_object()
            && active_binding.is_some_and(|(binding, _)| binding.council);
        let result = dispatch(
            &active,
            &selected,
            params,
            receipt.as_ref(),
            council_queue,
            || {
                ensure!(
                    self.key(command)? == key,
                    "The worker binding changed during Chat steering."
                );
                signal.check()
            },
        )
        .await;
        match result {
            Ok(_) => Ok(json!({"steered":true,"turnId":selected.turn})),
            Err(error) if error.is::<Failure>() => {
                bail!("Codex could not confirm steering for the selected turn.")
            }
            Err(error) => Err(error),
        }
    }

    pub(in crate::codex::turn) async fn steer_console(
        &self,
        session: Value,
        permission: &Value,
        frame: &Value,
        signal: Signal,
        assert_view: impl Fn() -> Result<()>,
    ) -> Result<Value> {
        assert_view()?;
        signal.check()?;
        let key = self.key(&session)?;
        let active = self
            .active
            .lock()
            .unwrap()
            .active
            .get(&key)
            .cloned()
            .context("The Codex thread does not have an active turn.")?;
        let (binding, root) = active
            .control
            .get()
            .zip(active.root.as_ref())
            .context("The console steer has no current managed turn.")?;
        ensure!(
            active.task_input.is_none()
                && active.task.get().is_none()
                && [
                    "chatId",
                    "threadId",
                    "runtimeGeneration",
                    "contextKind",
                    "projectId",
                    "placementId",
                    "modelRouteId",
                    "providerAccountId",
                ]
                .iter()
                .all(|field| session[*field] == binding.session[*field]),
            "The console steer does not identify the current managed turn."
        );
        let params = &frame["params"];
        ensure!(
            params
                .as_object()
                .is_some_and(|fields| fields.keys().all(|key| matches!(
                    key.as_str(),
                    Some("threadId" | "expectedTurnId" | "input" | "clientUserMessageId")
                )))
                && params["threadId"] == session["threadId"]
                && params["input"].is_array(),
            "The console steer requires native input for its bound thread."
        );
        let selected = Guard::request(Some(signal.clone()))
            .run(active.select_control(binding, false))
            .await?
            .context("The Codex thread no longer has an active turn.")?;
        ensure!(
            params["expectedTurnId"].as_js_string() == Some(&selected.turn),
            "The console steer targets a different native turn."
        );
        assert_view()?;
        signal.check()?;
        let scope = Scope::new(self.encryption.clone())?;
        ensure!(
            scope.owner == key.0 && scope.server == key.1,
            "The worker binding changed before console steering."
        );
        let receipt = self
            .receipts
            .admit_console(
                scope,
                session,
                METHOD,
                frame,
                permission,
                root.activation.clone(),
            )
            .await?;
        dispatch(
            &active,
            &selected,
            params.clone(),
            Some(&receipt),
            false,
            || {
                assert_view()?;
                signal.check()
            },
        )
        .await
    }
}

async fn dispatch(
    active: &Active,
    selected: &Selection,
    params: Value,
    receipt: Option<&Receipt<'_>>,
    council_queue: bool,
    assert_current: impl FnOnce() -> Result<()>,
) -> Result<Value> {
    let client = params["clientUserMessageId"]
        .as_js_string()
        .filter(|client| council_queue && !client.is_empty())
        .cloned();
    if let Some(receipt) = receipt
        && let Err(error) = receipt.dispatch().await
    {
        receipt
            .rejected(&json!({"code":-32000,"message":"Native dispatch did not complete."}))
            .await?;
        return Err(error);
    }
    let start = (|| {
        assert_current()?;
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
            if let Some(receipt) = receipt {
                let proof = json!({"code":-32000,"message":"The steer was not forwarded."});
                if council_queue {
                    receipt.rejected_steer_target_ended(&proof).await?;
                } else {
                    receipt.rejected(&proof).await?;
                }
            }
            return Err(error);
        }
    };
    match request.await {
        Ok(Some(reply)) if reply["turnId"].as_js_string() == Some(&selected.turn) => {
            if let Some(receipt) = receipt {
                receipt.applied(&json!({"result":reply}), None).await?;
            }
            Ok(reply)
        }
        result => {
            if let Err(error) = result
                && let Some(native) = native_error(&error)
            {
                if let Some(receipt) = receipt {
                    if council_queue && native_target_ended(native, &selected.turn) {
                        receipt.rejected_steer_target_ended(native).await?;
                    } else {
                        receipt.rejected(native).await?;
                    }
                }
                return Err(error);
            }
            if let Some(receipt) = receipt {
                if let Some(client) = client.as_ref()
                    && let Some(item) = observed_input(selected, client).await
                {
                    let reply = json!({"turnId":selected.turn});
                    receipt
                        .applied(
                            &json!({"result":reply,"observedInput":json!({"itemId":item,"clientUserMessageId":client})}),
                            None,
                        )
                        .await?;
                    return Ok(reply);
                }
                receipt.uncertain().await?;
            }
            bail!("Codex could not confirm steering for the selected turn.");
        }
    }
}

async fn observed_input(selected: &Selection, client: &JsString) -> Option<JsString> {
    // An exact native item is positive evidence. Missing pages, an unavailable
    // runtime, or an absent item cannot authorize another submission.
    let mut cursor = Value::Null;
    for _ in 0..4 {
        let page = selected
            .runtime
            .request(
                "thread/items/list".into(),
                Some(json!({"threadId":selected.thread,"turnId":selected.turn,
                    "cursor":cursor,"limit":128,"sortDirection":"desc"})),
                Some(Duration::from_secs(3)),
                None,
            )
            .await
            .ok()??;
        if let Some(item) = page["data"]
            .as_array()?
            .iter()
            .find(|entry| {
                let item = &entry["item"];
                entry["turnId"].as_js_string() == Some(&selected.turn)
                    && item["type"] == "userMessage"
                    && item["clientId"].as_js_string() == Some(client)
            })
            .and_then(|entry| entry["item"]["id"].as_js_string())
            .filter(|id| !id.is_empty())
        {
            return Some(item.clone());
        }
        let next = page["nextCursor"].as_js_string()?;
        if cursor.as_js_string() == Some(next) {
            return None;
        }
        cursor = json!(next);
    }
    None
}

fn native_target_ended(error: &Value, expected: &cantrip_wire::JsString) -> bool {
    // The bundled App Server rejects these requests before accepting input.
    // Other RPC errors and missing replies cannot prove the steer was unused.
    error["code"] == json!(-32600)
        && error["message"].as_str().is_some_and(|message| {
            message == "no active turn to steer"
                || message.starts_with(&format!(
                    "expected active turn id `{}` but found `",
                    expected.lossy()
                ))
        })
}

pub(in crate::codex::turn) fn native_error(error: &anyhow::Error) -> Option<&Value> {
    error.downcast_ref::<Failure>()?.native_error.as_ref()
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
