//! Native interaction ownership follows one live physical turn and its Core receipt.
pub(in crate::codex) mod protocol;

use super::{Emit, Runtime, Turns, id, receipt::Receipt};
use crate::{
    chat_content::Scope,
    encryption::Service,
    http::checked,
    metadata::{Guard, Signal},
    native_items::concat,
};
use anyhow::{Context, Result, anyhow, bail, ensure};
use cantrip_crypto::content::{Communication, decrypt_communication, encrypt_communication};
use cantrip_history::content::Encryption;
use cantrip_wire::{JsString, Value, value::json};
use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
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
    Reply { response: Value, protected: bool },
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
        let binding = active
            .control
            .get()
            .context("The agent interaction has no active binding.")?;
        if native {
            let root = active
                .root
                .as_ref()
                .context("The native turn has no active receipt.")?;
            ensure!(
                command["nativeActivationGeneration"] == root.activation
                    && binding.matches(command),
                "The reply does not match the active native turn."
            );
        } else {
            ensure!(
                command["threadId"].is_null() || command["threadId"] == binding.session["threadId"],
                "The reply belongs to a different native thread."
            );
        }
        let handle = match binding.interactions.get() {
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
}

struct Pending {
    id: Value,
    method: Value,
    request: Value,
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
}

pub(super) struct Turn<'a> {
    pub(super) runtime: &'a Runtime,
    pub(super) receipt: &'a Receipt<'a>,
    pub(super) thread: &'a JsString,
    pub(super) turn: &'a JsString,
    pub(super) thread_version: u64,
    pub(super) encryption: &'a Arc<Service>,
    pub(super) emit: &'a Emit,
    pub(super) protected: bool,
    pub(super) stop: Signal,
}

struct Owner<'a> {
    turn: Turn<'a>,
    pending: HashMap<JsString, Pending>,
    resolved: HashSet<JsString>,
}

impl Turn<'_> {
    pub(super) async fn run(
        self,
        events: &mut mpsc::Receiver<Value>,
        commands: Commands,
    ) -> Result<()> {
        let mut owner = Owner {
            turn: self,
            pending: HashMap::new(),
            resolved: HashSet::new(),
        };
        owner.run(events, commands).await
    }

    fn component(&self, revision: Option<u64>) -> Result<crate::encryption::BoundComponentKey> {
        let grant = self
            .encryption
            .bound_component("interaction-content", revision)?;
        let (owner, server) = self.receipt.scope().identity()?;
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

    fn current(&self) -> Result<()> {
        self.stop.check()?;
        self.receipt.scope().identity()?;
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
                _ = self.turn.stop.cancelled() => return Ok(()),
                frame = events.recv() => self.frame(frame.context("The native interaction channel closed.")?)?,
                command = commands.recv() => {
                    let Command { key, action, complete } = command.context("The interaction command owner closed.")?;
                    let result = match action {
                        Action::Reply { response, protected } => self.reply(&key, &response, protected).await,
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
        if frame["params"]["threadId"].as_js_string() != Some(self.turn.thread)
            || !(native_id.is_string() || native_id.is_number())
        {
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
            && (request["turnId"].is_null()
                || request["turnId"].as_js_string() == Some(self.turn.turn))
            && self.pending.len() < 32
        {
            let now = Instant::now();
            self.pending.insert(
                key,
                Pending {
                    id: native_id.clone(),
                    method: frame["method"].clone(),
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
        let guard = Guard::metadata_timeout(None, None, Duration::from_secs(2));
        if self
            .turn
            .receipt
            .register_interaction(&pending.descriptor(), &guard)
            .await
            .is_err()
        {
            pending.retry = Some(Instant::now() + Duration::from_millis(350));
            return Ok(());
        }
        if self.turn.stop.check().is_err() {
            return Ok(());
        }
        if self.turn.publish_request(&pending.request).is_err() {
            return self
                .cancel(
                    &key,
                    &"Cantrip could not publish the interaction safely.".into(),
                    false,
                )
                .map(|_| ());
        }
        pending.published = true;
        pending.retry = None;
        Ok(())
    }

    async fn reply(&mut self, key: &JsString, response: &Value, protected: bool) -> Result<Value> {
        self.turn.current()?;
        let pending = self
            .pending
            .get(key)
            .filter(|pending| pending.published && pending.expires > Instant::now())
            .context("The agent interaction is no longer pending.")?;
        let plain = self
            .turn
            .open_reply(key, response, protected)
            .map_err(|_| anyhow!("The agent interaction response could not be authenticated."))?;
        ensure!(
            plain["kind"] == pending.kind(),
            "The response kind does not match the native request."
        );
        let result = protocol::result(&plain)?;
        let scope = Scope::new(self.turn.encryption.clone())?;
        let receipt = self
            .turn
            .receipt
            .admit_interaction_reply(scope, &pending.descriptor(), &result)
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
        if let Err(error) = self.turn.current().and_then(|()| {
            ensure!(
                pending.expires > Instant::now(),
                "The native interaction expired before dispatch."
            );
            Ok(())
        }) {
            let _ = receipt.rejected(&json!({"code":-32000,"message":"The native reply no longer belongs to an active request."})).await;
            return Err(error);
        }
        // Claim before sending, even if the native transport subsequently fails.
        let pending = self
            .remove(key)
            .context("The native request was replaced.")?;
        match self
            .turn
            .runtime
            .reply_to_interaction(self.turn.thread, json!({"id":pending.id,"result":result}))
        {
            Ok(true) => {}
            Ok(false) => {
                receipt
                    .rejected(&json!({"code":-32000,"message":"The native request already ended."}))
                    .await?;
                self.clear(&pending, false)?;
                bail!("The native request already ended.");
            }
            Err(error) => {
                receipt.uncertain().await?;
                return Err(error);
            }
        }
        let mut resolution = if protected {
            response.clone()
        } else {
            json!({"response":plain})
        };
        resolution["idempotencyKey"] = json!(concat(&["native-response:".into(), key.clone()]));
        let _ = (self.turn.emit)(
            json!({"type":"agent.interaction.cleared","requestKey":key,"resolution":resolution}),
        );
        receipt.applied(&json!({"accepted":true}), None).await?;
        Ok(json!({"accepted":true}))
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
            (self.turn.emit)(
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
