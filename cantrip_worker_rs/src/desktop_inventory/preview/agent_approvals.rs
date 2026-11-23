//! Resume the suspended host action after its protected Core approval.
#[cfg(all(test, unix))]
mod tests;

use super::{HostAction, approvals};
use crate::{
    computer_use::HostError,
    connection::Outbound,
    encryption::Service,
    http::checked,
    metadata::{Abort, Signal},
};
use anyhow::{Context, Result, ensure};
use cantrip_wire::{JsString, Value, value::json};
use indexmap::IndexMap;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, Weak},
};
use tokio::{
    sync::oneshot,
    time::{Instant, sleep_until},
};

pub(super) struct Approvals {
    encryption: Arc<Service>,
    outgoing: Arc<Outbound>,
    state: Mutex<State>,
}

pub(super) struct Turn {
    pub(super) authority: Value,
    pub(super) binding: Value,
    pub(super) epoch: u64,
    pub(super) signal: Signal,
    pub(super) abort: Arc<Abort>,
}

#[derive(Default)]
struct State {
    turns: Vec<Weak<Turn>>,
    pending: HashMap<JsString, Pending>,
    grants: Vec<Permission>,
    completed: IndexMap<JsString, Completed>,
}

struct Permission {
    turn: Arc<Turn>,
    value: Value,
}

impl Permission {
    fn matches(&self, turn: &Arc<Turn>, value: &Value) -> bool {
        Arc::ptr_eq(&self.turn, turn) && self.value == *value
    }
}

struct Pending {
    permissions: Permission,
    call: Signal,
    deadline: Instant,
    decision: Option<oneshot::Sender<bool>>,
}

struct Completed {
    turn: Arc<Turn>,
    response_digest: [u8; 32],
}

struct Publication<'a, P: Fn(Value) -> Result<()>> {
    approvals: &'a Approvals,
    key: JsString,
    publish: P,
    published: bool,
    terminal: &'static str,
}

impl<P: Fn(Value) -> Result<()>> Drop for Publication<'_, P> {
    fn drop(&mut self) {
        let request = self
            .approvals
            .state
            .lock()
            .unwrap()
            .pending
            .remove(&self.key);
        if let Some(request) = request.filter(|_| self.published) {
            let event = json!({
                "type":"computer-use.approval.terminal","requestKey":self.key,
                "chatId":request.permissions.turn.authority["chatId"],"status":self.terminal,
            });
            if let Ok(event) = checked("cuaApprovalTerminalSchema", &event) {
                let _ = (self.publish)(event);
            }
        }
    }
}

impl Approvals {
    pub(super) fn new(encryption: Arc<Service>, outgoing: Arc<Outbound>) -> Self {
        Self {
            encryption,
            outgoing,
            state: Mutex::default(),
        }
    }

    pub(super) fn bind(&self, turn: Turn) -> Arc<Turn> {
        let turn = Arc::new(turn);
        let mut state = self.state.lock().unwrap();
        state.prune();
        state.turns.push(Arc::downgrade(&turn));
        turn
    }

    fn current(&self, turn: &Turn) -> Result<()> {
        turn.signal.check()?;
        ensure!(
            self.outgoing.stream_current(turn.epoch)
                && self
                    .encryption
                    .bound_identity()
                    .is_ok_and(|(owner, server)| {
                        turn.authority["ownerId"].as_js_string() == Some(&owner)
                            && turn.authority["serverId"] == server
                            && turn.authority["workerId"].as_js_string()
                                == Some(self.encryption.worker_id())
                    }),
            approvals::NO_LONGER_ACTIVE
        );
        Ok(())
    }

    pub(super) fn revoke(&self, matches: impl Fn(&Value) -> bool) {
        let mut state = self.state.lock().unwrap();
        let turns = state.turns.iter().filter_map(Weak::upgrade);
        for turn in turns.filter(|turn| matches(&turn.authority)) {
            turn.abort
                .abort(anyhow::anyhow!("The computer-use approval was revoked."));
        }
        state.prune();
    }

    pub(super) async fn authorize<P: Fn(Value) -> Result<()>>(
        &self,
        turn: &Arc<Turn>,
        action: HostAction,
        request_id: uuid::Uuid,
        call: Signal,
        publish: P,
    ) -> Result<(), HostError> {
        self.current(turn)
            .map_err(|_| HostError::new("ownership-mismatch"))?;
        call.check().map_err(|_| HostError::new("cancelled"))?;
        let Some(class) = approvals::permission_class(action.operation)
            .map_err(|_| HostError::new("unsupported"))?
        else {
            return Ok(());
        };
        if turn.authority["profile"]["selectedId"] == ":yolo" {
            return Ok(());
        }
        let permissions =
            json!({"computerUse":json!({"version":1,"classes":[class],"target":action.target})});
        let deadline = Instant::now() + approvals::LIFETIME;
        let key: JsString = uuid::Uuid::new_v4().to_string().into();
        let (event, response) = {
            let mut state = self.state.lock().unwrap();
            state.prune();
            if state
                .grants
                .iter()
                .any(|grant| grant.matches(turn, &permissions))
            {
                return Ok(());
            }
            if state.pending.len() >= approvals::MAX_PENDING
                || state
                    .pending
                    .values()
                    .any(|pending| pending.permissions.matches(turn, &permissions))
            {
                return Err(HostError::new("capacity"));
            }
            let request = approvals::protect(
                &self.encryption,
                &turn.authority,
                Some(&turn.binding),
                &key,
                &permissions,
            )
            .map_err(|_| HostError::new("permission-denied"))?;
            let event = checked("cuaApprovalRequestEventSchema", &json!({
                "type":"computer-use.approval.request","operationId":request_id.to_string(),"request":request,
            })).map_err(|_| HostError::new("permission-denied"))?;
            let (decision, response) = oneshot::channel();
            state.pending.insert(
                key.clone(),
                Pending {
                    permissions: Permission {
                        turn: turn.clone(),
                        value: permissions.clone(),
                    },
                    call: call.clone(),
                    deadline,
                    decision: Some(decision),
                },
            );
            (event, response)
        };
        let mut publication = Publication {
            approvals: self,
            key,
            publish,
            published: false,
            terminal: "interrupted",
        };
        call.check().map_err(|_| HostError::new("cancelled"))?;
        self.current(turn)
            .map_err(|_| HostError::new("ownership-mismatch"))?;
        // The publisher enqueues on the owning command stream synchronously.
        // A cancellation event follows this enqueue, including on caller drop.
        (publication.publish)(event).map_err(|_| HostError::new("publication-failed"))?;
        publication.published = true;
        let allowed = tokio::select! {
            biased;
            _ = turn.signal.cancelled() => return Err(HostError::new("cancelled")),
            _ = call.cancelled() => return Err(HostError::new("cancelled")),
            _ = sleep_until(deadline) => {
                publication.terminal = "expired";
                return Err(HostError::new("expired"));
            },
            answer = response => answer.map_err(|_| HostError::new("cancelled"))?,
        };
        if !allowed {
            return Err(HostError::new("denied"));
        }
        self.current(turn)
            .map_err(|_| HostError::new("ownership-mismatch"))?;
        call.check().map_err(|_| HostError::new("cancelled"))?;
        let mut state = self.state.lock().unwrap();
        state.prune();
        if !state
            .grants
            .iter()
            .any(|grant| grant.matches(turn, &permissions))
        {
            if state.grants.len() >= approvals::MAX_GRANTS {
                return Err(HostError::new("capacity"));
            }
            // A native turn consumes the suspended action and can reuse only
            // this exact class and target until that turn retires.
            state.grants.push(Permission {
                turn: turn.clone(),
                value: permissions,
            });
        }
        Ok(())
    }

    pub(super) fn answer(&self, command: &Value, epoch: u64) -> Result<Value> {
        let authority = checked("cuaAgentAuthoritySchema", &command["agentAuthority"])?;
        ensure!(
            command["previewAuthority"].is_null()
                && command["ownerId"] == authority["ownerId"]
                && command["chatId"] == authority["chatId"]
                && command["executionLaneId"] == authority["executionLaneId"],
            approvals::NO_LONGER_ACTIVE
        );
        let key = command["requestKey"]
            .as_js_string()
            .context(approvals::NO_LONGER_ACTIVE)?;
        let response = &command["response"];
        let response_digest = Sha256::digest(response.stringify().as_bytes()).into();
        let mut state = self.state.lock().unwrap();
        state.prune();
        let matches = |turn: &Turn| turn.epoch == epoch && turn.authority == authority;
        if let Some(prior) = state.completed.get(key) {
            ensure!(matches(&prior.turn), approvals::NO_LONGER_ACTIVE);
            self.current(&prior.turn)?;
            ensure!(
                prior.response_digest == response_digest,
                approvals::INVALID_RESPONSE
            );
            return Ok(json!({"accepted":true}));
        }
        let request = state
            .pending
            .get(key)
            .context(approvals::NO_LONGER_ACTIVE)?;
        let turn = request.permissions.turn.clone();
        ensure!(
            matches(&turn) && Instant::now() < request.deadline,
            approvals::NO_LONGER_ACTIVE
        );
        self.current(&turn)?;
        request.call.check()?;
        let opened = approvals::open(&self.encryption, &turn.authority, key, response)
            .map_err(|_| anyhow::anyhow!(approvals::INVALID_RESPONSE))?;
        ensure!(
            opened["kind"] == "permissions"
                && opened["strictAutoReview"] == false
                && matches!(opened["scope"].as_str(), Some("turn" | "session")),
            approvals::INVALID_RESPONSE
        );
        let permissions = &opened["permissions"];
        let denied = permissions
            .as_object()
            .is_some_and(|permissions| permissions.is_empty());
        ensure!(
            denied || *permissions == request.permissions.value,
            approvals::INVALID_RESPONSE
        );
        ensure!(
            denied || state.grants.len() < approvals::MAX_GRANTS,
            approvals::CAPACITY
        );
        self.current(&turn)?;
        request.call.check()?;
        ensure!(
            Instant::now() < request.deadline,
            approvals::NO_LONGER_ACTIVE
        );
        let decision = state
            .pending
            .get_mut(key)
            .unwrap()
            .decision
            .take()
            .context(approvals::NO_LONGER_ACTIVE)?;
        decision
            .send(!denied)
            .map_err(|_| anyhow::anyhow!(approvals::NO_LONGER_ACTIVE))?;
        state.pending.remove(key);
        state.completed.insert(
            key.clone(),
            Completed {
                turn,
                response_digest,
            },
        );
        if state.completed.len() > approvals::MAX_COMPLETED {
            state.completed.shift_remove_index(0);
        }
        Ok(json!({"accepted":true}))
    }
}

impl State {
    fn prune(&mut self) {
        self.turns.retain(|turn| {
            turn.upgrade()
                .is_some_and(|turn| turn.signal.check().is_ok())
        });
        self.grants
            .retain(|grant| grant.turn.signal.check().is_ok());
        self.completed
            .retain(|_, completed| completed.turn.signal.check().is_ok());
    }
}
