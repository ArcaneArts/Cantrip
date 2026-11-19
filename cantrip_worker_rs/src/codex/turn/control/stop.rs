//! A Stop is committed against the named native turn's terminal history.
use super::{Action, Selection, restore};
use crate::codex::turn::*;
use cantrip_history::content::Encryption;

struct Reservation {
    sessions: Sessions,
    key: Key,
}
impl Drop for Reservation {
    fn drop(&mut self) {
        self.sessions.lock().unwrap().stopping.remove(&self.key);
    }
}

pub(super) struct Terminal {
    status: &'static str,
    turn: Value,
}

impl Turns {
    pub(crate) async fn stop_suspension(&self, command: &Value) -> Result<Value> {
        let command = self.preparation.resolve_routing(command).await?;
        let key = self.key(&command)?;
        let signature = payload_digest(&command);
        let (owner, pending) = {
            let mut state = self.active.lock().unwrap();
            if let Some(pending) = state.stopping.get(&key) {
                if pending.signature != signature {
                    bail!("Another Stop already owns this saved turn.");
                }
                (None, pending.response.clone())
            } else {
                let (complete, response) = Promise::pair();
                state.stopping.insert(
                    key.clone(),
                    PendingSuspension {
                        signature,
                        response: response.clone(),
                    },
                );
                (Some(complete), response)
            }
        };
        let Some(complete) = owner else {
            return pending.work().await;
        };
        let _reservation = Reservation {
            sessions: self.active.clone(),
            key: key.clone(),
        };
        let result = self.stop_owned(&command, &key).await;
        complete.finish(restore::shared(&result));
        result
    }

    async fn stop_owned(&self, command: &Value, key: &Key) -> Result<Value> {
        let active = self.active.lock().unwrap().active.get(key).cloned();
        let activation = active
            .as_ref()
            .and_then(|active| match &*active.phase.lock().unwrap() {
                Phase::Running { runtime, .. } if runtime.is_live() => {
                    active.root.as_ref().map(|root| root.activation.clone())
                }
                _ => None,
            });
        if let Some(activation) = activation {
            let binding = json!({
                "chatId":command["chatId"],"threadId":command["threadId"],
                "nativeActivationGeneration":activation, "nativeRuntimeGeneration":Value::Null,
                "modelRouteId":command["model"]["routeId"],"providerAccountId":command["provider"]["accountId"],
            });
            return self
                .control_active(&binding, Action::DurableStop(Some(command)))
                .await;
        }

        let (prepared, selected, scope) = self.attach_saved_turn(command, key).await?;
        let (receipt, grant) = self.admit_saved_turn(command, &selected, scope).await?;
        receipt.dispatch().await?;
        let checkpoint = &command["checkpoint"]["suspension"];
        let runtime = &prepared.runtime;
        prepared.thread.assert_current(runtime)?;
        receipt
            .applied(&json!({"restored":checkpoint}), Some(&selected.turn))
            .await?;
        if receipt.session()["contextKind"] == "project" {
            self.history.bind(sources::Input {
                chat_id: key.2.clone(),
                thread_id: selected.thread.clone(),
                runtime: runtime.history(),
                provenance: Some(json!({
                    "kind":"command","operationId":grant["source"]["operationId"],
                    "operationGeneration":grant["source"]["operationGeneration"],
                })),
            })?;
        }

        // The restored observer admits cancellation only. No provider
        // capacity, MCP execution activation, prompt or Resume is needed.
        let scope = Scope::new(self.encryption.clone())?;
        if scope.owner != key.0 || scope.server != key.1 {
            bail!("The worker binding changed before native Stop.");
        }
        let params = json!({"threadId":selected.thread,"turnId":selected.turn});
        let stop = self
            .receipts
            .admit_control(
                receipt.operation(),
                scope,
                receipt.session().clone(),
                &params,
                &command["permissionProfileId"],
                Action::DurableStop(Some(command)),
            )
            .await?;
        let terminal = self
            .durable_stop(&selected, &stop, None)
            .await?
            .context("The saved turn lost its native owner before Stop.")?;
        let result = match terminal.status {
            "interrupted" => json!({"interrupted":true}),
            "failed" => json!({"failed":true}),
            _ => completion(&selected, &terminal.turn)?,
        };
        receipt
            .finish_native(&selected.turn, terminal.status, &result)
            .await?;
        interrupt_result(true)
    }

    pub(super) async fn durable_stop(
        &self,
        selected: &Selection,
        receipt: &receipt::Receipt<'_>,
        live: Option<&Active>,
    ) -> Result<Option<Terminal>> {
        receipt.dispatch_durable().await?;
        receipt.scope().identity()?;
        let interrupt = || {
            selected.runtime.request(
                "turn/interrupt".into(),
                Some(json!({"threadId":selected.thread,"turnId":selected.turn})),
                Some(RPC_TIMEOUT),
                None,
            )
        };
        let request = if let Some(active) = live {
            // Sending under the phase lock prevents a replacement turn from
            // being selected after the native identity check.
            let phase = active.phase.lock().unwrap();
            selected.current(&phase).then(interrupt)
        } else {
            selected.transport_current().then(interrupt)
        };
        let reply = match request {
            Some(request) => Some(request.await),
            None => None,
        };
        // A named cold Stop may terminate from the rollout even if the native
        // checkpoint cannot decode. A repeated Stop may only see its terminal
        // history. Neither an RPC error nor an ACK is terminal proof.
        let proof = match reply {
            Some(Ok(_)) => selected.await_terminal().await,
            Some(Err(error)) => match selected.terminal().await {
                Ok(Some(terminal)) => Ok(terminal),
                _ => Err(error),
            },
            None => match selected.terminal().await {
                Ok(Some(terminal)) => Ok(terminal),
                _ => {
                    receipt.settle_durable("uncertain", None, None).await?;
                    return Ok(None);
                }
            },
        };
        match proof {
            Ok(terminal) => {
                receipt
                    .settle_durable("applied", Some(&json!({"result":json!({})})), None)
                    .await?;
                Ok(Some(terminal))
            }
            Err(error) => {
                receipt.settle_durable("uncertain", None, None).await?;
                Err(error.context("Codex did not confirm terminal history for the saved turn."))
            }
        }
    }
}

impl Selection {
    async fn terminal(&self) -> Result<Option<Terminal>> {
        let snapshot = self.runtime.read_history(&self.thread).await?;
        if !self.transport_current() {
            bail!("The native transport changed during Stop.");
        }
        let turn = snapshot["thread"]["turns"]
            .as_array()
            .and_then(|turns| {
                turns
                    .iter()
                    .find(|entry| entry["id"].as_js_string() == Some(&self.turn))
            })
            .context("The named turn is missing from native history.")?;
        let status = match turn["status"].as_str() {
            Some("completed") => "completed",
            Some("interrupted") => "interrupted",
            Some("failed") => "failed",
            _ => return Ok(None),
        };
        Ok(Some(Terminal {
            status,
            turn: turn.clone(),
        }))
    }

    async fn await_terminal(&self) -> Result<Terminal> {
        tokio::time::timeout(RPC_TIMEOUT, async {
            loop {
                if let Some(terminal) = self.terminal().await? {
                    return Ok(terminal);
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        })
        .await
        .context("Codex did not commit terminal history before the Stop deadline.")?
    }
}

fn completion(selected: &Selection, turn: &Value) -> Result<Value> {
    let text = turn["items"]
        .as_array()
        .and_then(|items| {
            items
                .iter()
                .rev()
                .filter(|item| {
                    matches!(item["type"].as_str(), Some("agentMessage" | "plan"))
                        && item["phase"] != "commentary"
                })
                .find_map(|item| item["text"].as_js_string())
        })
        .cloned()
        .unwrap_or_else(|| "".into());
    checked(
        "agentTurnResultSchema",
        &json!({
            "threadId":selected.thread,"turnId":selected.turn,"status":"completed","text":text,
        }),
    )
}

fn interrupt_result(interrupted: bool) -> Result<Value> {
    checked(
        "chatInterruptAcceptedSchema",
        &json!({"interrupted":interrupted}),
    )
}
