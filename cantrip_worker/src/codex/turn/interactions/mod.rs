//! Native interactions belong to one live physical turn and its Core command.
pub(in crate::codex) mod protocol;

use super::{Emit, Key, Phase, Runtime, Turns, id, receipt::Receipt, task_route::Attempt};
use crate::{
    chat_content::Scope,
    encryption::Service,
    http::checked,
    metadata::{Abort, Guard, Signal},
    native_items::concat,
};
use anyhow::{Context, Result, anyhow, bail, ensure};
use cantrip_crypto::content::{Communication, decrypt_communication, encrypt_communication};
use cantrip_history::content::Encryption;
use cantrip_wire::{JsString, Value, value::json};
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, OnceLock},
    time::Duration,
};
use tokio::{
    sync::{mpsc, oneshot},
    time::Instant,
};

pub(crate) fn handles(command: &Value) -> bool {
    matches!(
        command["type"].as_str(),
        Some(
            "agent.interaction.respond"
                | "agent.interaction.respond.protected"
                | "agent.interaction.cancel"
        )
    )
}

pub(super) struct Handle(mpsc::Sender<Command>);
pub(super) type Commands = mpsc::Receiver<Command>;

pub(super) struct Command {
    key: JsString,
    action: Action,
    complete: oneshot::Sender<Result<Value>>,
}

enum Action {
    Reply {
        response: Value,
        protected: bool,
    },
    Terminal {
        session: Value,
        frame: Value,
        open: Signal,
    },
    Cancel(JsString),
}

impl Handle {
    pub(super) fn channel() -> (Self, Commands) {
        let (send, receive) = mpsc::channel(16);
        (Self(send), receive)
    }

    async fn execute(&self, key: JsString, action: Action) -> Result<Value> {
        let (complete, result) = oneshot::channel();
        self.0
            .send(Command {
                key,
                action,
                complete,
            })
            .await
            .map_err(|_| anyhow!("The agent interaction is no longer pending."))?;
        result
            .await
            .context("The native interaction owner ended before settlement.")?
    }
}

impl Turns {
    pub(crate) async fn interaction(&self, command: &Value) -> Result<Value> {
        let control = &command["control"];
        let native = command["type"] == super::CONTROL;
        let source = if native { control } else { command };
        let cancel = command["type"] == "agent.interaction.cancel";
        let key = self.key(command)?;
        let active = self.active.lock().unwrap().active.get(&key).cloned();
        let Some(active) = active else {
            if cancel {
                return Ok(json!({"accepted":true}));
            }
            bail!("The agent interaction is no longer pending.");
        };
        let binding = active.control.get();
        if native {
            let root = active
                .root
                .as_ref()
                .context("The native turn has no active receipt.")?;
            ensure!(
                command["nativeActivationGeneration"] == root.activation
                    && binding.is_some_and(|binding| binding.matches(command)),
                "The reply does not match the active native turn."
            );
        } else {
            let phase = active.phase.lock().unwrap();
            let thread = binding
                .map(|binding| &binding.session["threadId"])
                .and_then(Value::as_js_string)
                .or_else(|| match &*phase {
                    Phase::Running { thread, .. } => Some(thread),
                    _ => None,
                });
            ensure!(
                command["threadId"].is_null() || command["threadId"].as_js_string() == thread,
                "The reply belongs to a different native thread."
            );
        }
        let handle = match binding
            .and_then(|binding| binding.interactions.get())
            .or_else(|| active.task_input.as_ref()?.interactions.get())
        {
            Some(handle) => handle,
            None if cancel => return Ok(json!({"accepted":true})),
            None => bail!("The agent interaction is no longer pending."),
        };
        let request = id(&source["requestKey"], "agent interaction request")?;
        let action = if cancel {
            Action::Cancel(id(&command["reason"], "interaction cancellation reason")?)
        } else {
            let protected = if native {
                source.get("protectedResponse").is_some()
            } else {
                command["type"] == "agent.interaction.respond.protected"
            };
            let response = if native && protected {
                &source["protectedResponse"]
            } else {
                &source["response"]
            };
            Action::Reply {
                response: response.clone(),
                protected,
            }
        };
        handle.execute(request, action).await
    }

    pub(super) async fn console_interaction(
        &self,
        session: Value,
        frame: Value,
        open: Signal,
    ) -> Result<Value> {
        open.check()?;
        let key = self.key(&session)?;
        let active = self
            .active
            .lock()
            .unwrap()
            .active
            .get(&key)
            .cloned()
            .context("The native interaction is no longer pending.")?;
        let handle = active
            .control
            .get()
            .and_then(|binding| binding.interactions.get())
            .context("The native interaction is no longer pending.")?;
        let request = concat(&[
            format!(
                "codex:{}:",
                id(&session["runtimeGeneration"], "native runtime generation")?.lossy()
            )
            .into(),
            protocol::native_id(&frame["id"]),
        ]);
        handle
            .execute(
                request,
                Action::Terminal {
                    session,
                    frame,
                    open,
                },
            )
            .await
    }
}

struct Pending {
    id: Value,
    method: Value,
    request: Value,
    question: Option<Value>,
    expires: Instant,
    retry: Option<Instant>,
    published: bool,
}

impl Pending {
    fn descriptor(&self) -> Value {
        json!({"nativeRequestId":protocol::native_id(&self.id),"requestMethod":self.method,"turnId":self.request["turnId"]})
    }
    fn kind(&self) -> &str {
        self.request["payload"]["kind"].as_str().unwrap()
    }

    fn publish_terminal(&self, emit: &Emit, event: Value) -> Result<()> {
        let plan = if self.question.is_some() {
            emit(
                json!({"type":"agent.plan.question-resolved","questionId":self.request["requestKey"]}),
            )
        } else {
            Ok(())
        };
        let interaction = emit(event);
        plan.and(interaction)
    }
}

#[derive(Clone, Copy)]
pub(super) enum Authority<'a> {
    Receipt(&'a Receipt<'a>),
    Task(&'a Key, &'a Attempt),
}

pub(super) struct Turn<'a> {
    pub(super) runtime: &'a Runtime,
    pub(super) authority: Authority<'a>,
    pub(super) thread: &'a JsString,
    pub(super) turn: &'a JsString,
    pub(super) thread_version: u64,
    pub(super) encryption: &'a Arc<Service>,
    pub(super) emit: &'a Emit,
    pub(super) protected: bool,
}

struct Owner<'a> {
    turn: Turn<'a>,
    stop: Signal,
    pending: HashMap<JsString, Pending>,
    resolved: HashSet<JsString>,
}

impl Turn<'_> {
    pub(super) async fn observe<T>(
        self,
        handle: &OnceLock<Handle>,
        events: &mut mpsc::Receiver<Value>,
        collecting: impl Future<Output = Result<T>>,
    ) -> Result<T> {
        let (send, commands) = Handle::channel();
        handle
            .set(send)
            .map_err(|_| anyhow!("The native interaction owner already exists."))?;
        let (stop, stopping) = Abort::new();
        let mut owner = Owner {
            turn: self,
            stop: stopping,
            pending: HashMap::new(),
            resolved: HashSet::new(),
        };
        let interactions = owner.run(events, commands);
        tokio::pin!(interactions);
        tokio::select! {
            result = collecting => {
                stop.abort(anyhow!("The native turn ended."));
                interactions.await?;
                result
            }
            failure = &mut interactions => {
                failure?;
                bail!("The native interaction owner ended before the turn ended.")
            }
        }
    }

    fn component(&self, revision: Option<u64>) -> Result<crate::encryption::BoundComponentKey> {
        let grant = self
            .encryption
            .bound_component("interaction-content", revision)?;
        let (owner, server) = self.identity()?;
        ensure!(
            grant.owner_id == owner && grant.server_id.as_js_string() == Some(&server),
            "The interaction encryption binding changed."
        );
        Ok(grant)
    }

    fn publish_request(&self, request: &Value) -> Result<()> {
        let event = if self.protected {
            let grant = self.component(None)?;
            let classification = json!({"kind":request["payload"]["kind"]});
            let protected = encrypt_communication(
                Communication::InteractionRequest,
                &grant.component.key,
                &json!({"ownerId":grant.owner_id,"requestKey":request["requestKey"],"keyRevision":grant.component.key_revision}),
                &json!({"version":1,"classification":classification,"payload":request["payload"]}),
            )?;
            let mut opaque = request.clone();
            if let Value::Object(fields) = &mut opaque {
                fields.shift_remove("payload");
            }
            opaque["classification"] = classification;
            opaque["protectedPayload"] = protected;
            json!({"type":"agent.interaction.requested.protected","request":opaque})
        } else {
            json!({"type":"agent.interaction.requested","request":request})
        };
        (self.emit)(checked("workerEventSchema", &event)?)
    }

    fn open_reply(&self, request: &JsString, response: &Value, protected: bool) -> Result<Value> {
        ensure!(
            !self.protected || protected,
            "The native interaction requires a protected response."
        );
        if !protected {
            return Ok(response.clone());
        }
        let grant = self.component(Some(
            response["protectedResponse"]["keyRevision"]
                .as_u64()
                .context("Missing interaction key revision.")?,
        ))?;
        let opened = decrypt_communication(
            Communication::InteractionResponse,
            &grant.component.key,
            &json!({"ownerId":grant.owner_id,"requestKey":request,"keyRevision":grant.component.key_revision}),
            &response["protectedResponse"],
            Some(&response["classification"]),
        )?;
        Ok(opened["response"].clone())
    }

    fn identity(&self) -> Result<(JsString, JsString)> {
        match self.authority {
            Authority::Receipt(receipt) => receipt.scope().identity(),
            Authority::Task((owner, server, _), attempt) => {
                ensure!(
                    !attempt.revoked(),
                    "The Task input is no longer authorized."
                );
                let (current_owner, current_server) = self.encryption.bound_identity()?;
                ensure!(
                    &current_owner == owner && current_server.as_js_string() == Some(server),
                    "The interaction no longer belongs to the current worker identity."
                );
                Ok((owner.clone(), server.clone()))
            }
        }
    }

    fn current(&self) -> Result<()> {
        self.identity()?;
        ensure!(
            self.runtime.is_live()
                && self.runtime.thread_version(self.thread) == self.thread_version,
            "The native interaction belongs to a replaced thread or runtime."
        );
        Ok(())
    }
}

impl Owner<'_> {
    async fn run(
        &mut self,
        events: &mut mpsc::Receiver<Value>,
        mut commands: Commands,
    ) -> Result<()> {
        loop {
            let next = self
                .pending
                .values()
                .map(|pending| {
                    pending
                        .retry
                        .map_or(pending.expires, |retry| retry.min(pending.expires))
                })
                .min();
            tokio::select! {
                biased;
                _ = self.stop.cancelled() => return Ok(()),
                frame = events.recv() => self.frame(frame.context("The native interaction channel closed.")?)?,
                command = commands.recv() => {
                    let Command { key, action, complete } = command.context("The interaction command owner closed.")?;
                    let result = match action {
                        Action::Reply { response, protected } => self.reply(&key, &response, protected).await,
                        Action::Terminal { session, frame, open } => self.terminal_reply(&key, &session, frame, &open).await,
                        Action::Cancel(reason) => self.cancel(&key, &reason, false),
                    };
                    let _ = complete.send(result);
                }
                _ = async { match next { Some(next) => tokio::time::sleep_until(next).await, None => std::future::pending().await } } => {
                    self.deliver().await?;
                }
            }
        }
    }

    fn frame(&mut self, frame: Value) -> Result<()> {
        let native_id = if frame["method"] == "serverRequest/resolved" {
            &frame["params"]["requestId"]
        } else {
            &frame["id"]
        };
        let Some(thread) = frame["params"]["threadId"].as_js_string() else {
            return Ok(());
        };
        if !(native_id.is_string() || native_id.is_number()) {
            return Ok(());
        }
        let key = concat(&[
            format!("codex:{}:", self.turn.runtime.generation()).into(),
            protocol::native_id(native_id),
        ]);
        if frame["method"] == "serverRequest/resolved" {
            if let Some(pending) = self.remove(&key) {
                self.clear(&pending, false)?;
            }
            return Ok(());
        }
        if self.resolved.contains(&key) || self.pending.contains_key(&key) {
            return Ok(());
        }
        let request = protocol::request(&frame, self.turn.runtime.generation());
        if let Ok((request, timeout)) = request
            && (thread != self.turn.thread
                || request["turnId"].is_null()
                || request["turnId"].as_js_string() == Some(self.turn.turn))
            && self.pending.len() < 32
        {
            let now = Instant::now();
            self.pending.insert(
                key,
                Pending {
                    id: native_id.clone(),
                    method: frame["method"].clone(),
                    question: match self.turn.authority {
                        Authority::Receipt(_) => protocol::plan_question(&request),
                        Authority::Task(..) => None,
                    },
                    request,
                    expires: now + timeout,
                    retry: Some(now),
                    published: false,
                },
            );
        } else if let Some(kind) = protocol::kind(&frame["method"]) {
            self.turn.runtime.reply_to_interaction(
                self.turn.thread,
                protocol::deny(
                    native_id,
                    kind,
                    &"The native request does not match the current turn.".into(),
                ),
            )?;
            self.resolved.insert(key);
        }
        Ok(())
    }

    async fn deliver(&mut self) -> Result<()> {
        let now = Instant::now();
        let due = self
            .pending
            .iter()
            .find(|(_, request)| {
                request.expires <= now || request.retry.is_some_and(|retry| retry <= now)
            })
            .map(|(key, _)| key.clone());
        let Some(key) = due else {
            return Ok(());
        };
        if self.pending[&key].expires <= now {
            return self
                .cancel(
                    &key,
                    &"The Cantrip interaction expired before it was answered.".into(),
                    true,
                )
                .map(|_| ());
        }
        self.turn.current()?;
        let pending = self.pending.get_mut(&key).unwrap();
        if let Authority::Receipt(receipt) = self.turn.authority {
            let guard = Guard::metadata_timeout(None, None, Duration::from_secs(2));
            if receipt
                .register_interaction(&pending.descriptor(), &guard)
                .await
                .is_err()
            {
                pending.retry = Some(Instant::now() + Duration::from_millis(350));
                return Ok(());
            }
        }
        if self.stop.check().is_err() {
            return Ok(());
        }
        let published = self.turn.publish_request(&pending.request).and_then(|()| {
            pending.published = true;
            if let Some(question) = &pending.question {
                (self.turn.emit)(json!({"type":"agent.plan.question","question":question}))?;
            }
            Ok(())
        });
        if published.is_err() {
            return self
                .cancel(
                    &key,
                    &"Cantrip could not publish the interaction safely.".into(),
                    false,
                )
                .map(|_| ());
        }
        pending.retry = None;
        if !self
            .turn
            .runtime
            .publish_interaction(self.turn.thread, &pending.id)
        {
            self.cancel(&key, &"The native request already ended.".into(), false)?;
        }
        Ok(())
    }

    fn pending(&self, key: &JsString) -> Result<&Pending> {
        self.stop.check()?;
        self.turn.current()?;
        self.pending
            .get(key)
            .filter(|pending| pending.published && pending.expires > Instant::now())
            .context("The agent interaction is no longer pending.")
    }

    async fn reply(&mut self, key: &JsString, response: &Value, protected: bool) -> Result<Value> {
        let pending = self.pending(key)?;
        let plain = self
            .turn
            .open_reply(key, response, protected)
            .map_err(|_| anyhow!("The agent interaction response could not be authenticated."))?;
        ensure!(
            plain["kind"] == pending.kind(),
            "The response kind does not match the native request."
        );
        let frame = json!({"id":pending.id,"result":protocol::result(&plain)?});
        let resolution = if protected {
            response.clone()
        } else {
            json!({"response":plain})
        };
        self.deliver_reply(key, frame, Some(resolution), None).await
    }

    async fn terminal_reply(
        &mut self,
        key: &JsString,
        session: &Value,
        frame: Value,
        open: &Signal,
    ) -> Result<Value> {
        open.check()?;
        let pending = self.pending(key)?;
        ensure!(
            frame["id"] == pending.id,
            "The console response belongs to a different request."
        );
        let resolution = if let Some(response) =
            protocol::response(pending.kind(), frame.get("result"))
        {
            if self.turn.protected {
                let grant = self.turn.component(None)?;
                let classification = json!({"kind":response["kind"]});
                let opaque = encrypt_communication(
                    Communication::InteractionResponse,
                    &grant.component.key,
                    &json!({"ownerId":grant.owner_id,"requestKey":key,"keyRevision":grant.component.key_revision}),
                    &json!({"version":1,"classification":classification,"response":response}),
                )?;
                Some(json!({"classification":classification,"protectedResponse":opaque}))
            } else {
                Some(json!({"response":response}))
            }
        } else {
            None
        };
        self.deliver_reply(key, frame, resolution, Some((session, open)))
            .await
    }

    async fn deliver_reply(
        &mut self,
        key: &JsString,
        frame: Value,
        resolution: Option<Value>,
        terminal: Option<(&Value, &Signal)>,
    ) -> Result<Value> {
        let receipt = if let Authority::Receipt(root) = self.turn.authority {
            let scope = Scope::new(self.turn.encryption.clone())?;
            let receipt = root
                .admit_interaction_reply(
                    scope,
                    self.turn.turn,
                    &self.pending(key)?.descriptor(),
                    &frame,
                    terminal.map(|(session, _)| session),
                )
                .await?;
            if let Err(error) = receipt.dispatch().await {
                let _ = receipt.uncertain().await;
                self.cancel(
                    key,
                    &"Core did not dispatch the native interaction reply.".into(),
                    false,
                )?;
                return Err(error);
            }
            if let Err(error) = self
                .pending(key)
                .and_then(|_| terminal.map_or(Ok(()), |(_, open)| open.check()))
            {
                let _ = receipt.rejected(&json!({"code":-32000,"message":"The native reply no longer belongs to an active request."})).await;
                // Core already claimed this request. Deny it so the turn cannot wait for an unusable reply.
                self.cancel(
                    key,
                    &"The authorized reply ended before delivery.".into(),
                    false,
                )?;
                return Err(error);
            }
            Some(receipt)
        } else {
            ensure!(
                terminal.is_none(),
                "A Task reply requires its owning command."
            );
            self.pending(key)?;
            None
        };
        // Claim before sending, even if the native transport subsequently fails.
        let pending = self
            .remove(key)
            .context("The native request was replaced.")?;
        match self
            .turn
            .runtime
            .reply_to_interaction(self.turn.thread, frame)
        {
            Ok(true) => {}
            Ok(false) => {
                if let Some(receipt) = receipt {
                    receipt
                        .rejected(
                            &json!({"code":-32000,"message":"The native request already ended."}),
                        )
                        .await?;
                }
                self.clear(&pending, false)?;
                bail!("The native request already ended.");
            }
            Err(error) => {
                let _ = self.clear(&pending, false);
                if let Some(receipt) = receipt {
                    receipt.uncertain().await?;
                }
                return Err(error);
            }
        }
        let mut event = json!({"type":"agent.interaction.cleared","requestKey":key});
        if let Some(mut resolution) = resolution {
            resolution["idempotencyKey"] = json!(concat(&["native-response:".into(), key.clone()]));
            event["resolution"] = resolution;
        }
        let _ = pending.publish_terminal(self.turn.emit, event);
        let acknowledged = if let (Some(receipt), Some(_)) = (&receipt, terminal) {
            json!({"delivered":true,"operationGeneration":receipt.operation().generation})
        } else {
            json!({"accepted":true})
        };
        if let Some(receipt) = receipt {
            receipt.applied(&acknowledged, None).await?;
        }
        Ok(acknowledged)
    }

    fn cancel(&mut self, key: &JsString, reason: &JsString, expired: bool) -> Result<Value> {
        if let Some(pending) = self.remove(key) {
            let _ = self.turn.runtime.reply_to_interaction(
                self.turn.thread,
                protocol::deny(&pending.id, pending.kind(), reason),
            );
            self.clear(&pending, expired)?;
        }
        Ok(json!({"accepted":true}))
    }

    fn remove(&mut self, key: &JsString) -> Option<Pending> {
        let pending = self.pending.remove(key)?;
        self.resolved.insert(key.clone());
        Some(pending)
    }

    fn clear(&self, pending: &Pending, expired: bool) -> Result<()> {
        if pending.published {
            pending.publish_terminal(
                self.turn.emit,
                json!({"type":if expired {"agent.interaction.expired"} else {"agent.interaction.cleared"}, "requestKey":pending.request["requestKey"]}),
            )?;
        }
        Ok(())
    }
}

impl Drop for Owner<'_> {
    fn drop(&mut self) {
        for pending in self.pending.values() {
            let _ = self.turn.runtime.reply_to_interaction(
                self.turn.thread,
                protocol::deny(
                    &pending.id,
                    pending.kind(),
                    &"The native turn ended.".into(),
                ),
            );
            let _ = self.clear(pending, false);
        }
    }
}
