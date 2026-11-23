//! Preview grants authorize a later retry under the same live lease.
use super::{Lease, native::reject};
use crate::{connection::Outbound, encryption::Service, http::checked};
use anyhow::{Context, Result, ensure};
use cantrip_crypto::content::{Communication, decrypt_communication, encrypt_communication};
use cantrip_wire::{JsString, Value, value::json};
use chrono::{SecondsFormat, Utc};
use indexmap::IndexMap;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    sync::oneshot,
    time::{Instant, sleep_until},
};

pub(super) const LIFETIME: Duration = Duration::from_secs(300);
pub(super) const MAX_PENDING: usize = 32;
pub(super) const MAX_GRANTS: usize = 64;
pub(super) const MAX_COMPLETED: usize = 128;
pub(super) const NO_LONGER_ACTIVE: &str = "This computer-use approval is no longer active.";
pub(super) const INVALID_RESPONSE: &str =
    "The response does not match the requested computer-use permissions.";
pub(super) const CAPACITY: &str = "Computer-use approval capacity was reached.";

pub(super) struct Approvals {
    state: Arc<Mutex<State>>,
    outgoing: Arc<Outbound>,
}

#[derive(Default)]
struct State {
    pending: HashMap<JsString, Pending>,
    grants: Vec<Grant>,
    completed: IndexMap<JsString, Completed>,
}

struct Pending {
    lease_id: JsString,
    chat_id: Value,
    permissions: Value,
    deadline: Instant,
    request: Value,
    _timer: oneshot::Sender<()>,
}

struct Grant {
    lease_id: JsString,
    permissions: Value,
    once: bool,
}

struct Completed {
    lease_id: JsString,
    response_digest: [u8; 32],
}

impl Approvals {
    pub(super) fn new(outgoing: Arc<Outbound>) -> Self {
        Self {
            state: Arc::default(),
            outgoing,
        }
    }

    pub(super) fn authorize(
        &self,
        encryption: &Service,
        lease: &Lease,
        action: &Value,
        operation_id: &Value,
        emit: impl Fn(Value) -> Result<()>,
    ) -> Result<()> {
        let Some(class) = permission_class(action["operation"].as_str())? else {
            return Ok(());
        };
        if lease.authority["profile"]["selectedId"] == ":yolo" {
            return Ok(());
        }
        let target = action.get("targetId").map_or(
            Value::Null,
            |id| json!({"targetId":id,"targetGeneration":action["targetGeneration"]}),
        );
        let permissions =
            json!({"computerUse":json!({"version":1,"classes":[class],"target":target})});
        let mut state = self.state.lock().unwrap();
        self.current(lease)?;
        if let Some(index) = state
            .grants
            .iter()
            .position(|grant| grant.lease_id == lease.id && grant.permissions == permissions)
        {
            if state.grants[index].once {
                state.grants.swap_remove(index);
            }
            return Ok(());
        }
        let now = Instant::now();
        state.expire(now, &self.outgoing);
        let request = match state
            .pending
            .values()
            .find(|item| item.lease_id == lease.id && item.permissions == permissions)
        {
            Some(existing) => existing.request.clone(),
            None => {
                if state.pending.len() >= MAX_PENDING {
                    return Err(reject("capacity", CAPACITY));
                }
                let key: JsString = uuid::Uuid::new_v4().to_string().into();
                let request = protect(encryption, &lease.authority, None, &key, &permissions)
                    .map_err(|_| {
                        reject(
                            "encryption-unavailable",
                            "Computer-use approval encryption is unavailable.",
                        )
                    })?;
                let deadline = now + LIFETIME;
                let (cancel, cancelled) = oneshot::channel();
                state.pending.insert(
                    key.clone(),
                    Pending {
                        lease_id: lease.id.clone(),
                        chat_id: lease.authority["chatId"].clone(),
                        permissions,
                        deadline,
                        request: request.clone(),
                        _timer: cancel,
                    },
                );
                let retained = Arc::downgrade(&self.state);
                let outgoing = self.outgoing.clone();
                tokio::spawn(async move {
                    tokio::select! {
                        _ = cancelled => {},
                        _ = sleep_until(deadline) => {
                            if let Some(state) = retained.upgrade() {
                                state.lock().unwrap().expire(Instant::now(), &outgoing);
                            }
                        }
                    }
                });
                request
            }
        };
        // Publication and terminal notifications enter the command socket in
        // order. Core fences the terminal write on any in-flight insert.
        self.current(lease)?;
        emit(checked(
            "cuaApprovalRequestEventSchema",
            &json!({"type":"computer-use.approval.request","operationId":operation_id,"request":request}),
        )?)?;
        Err(reject(
            "approval-required",
            "Computer use requires approval through the active permission profile.",
        ))
    }

    pub(super) fn lease_for(&self, key: &JsString) -> Result<JsString> {
        let state = self.state.lock().unwrap();
        state
            .pending
            .get(key)
            .map(|entry| &entry.lease_id)
            .or_else(|| state.completed.get(key).map(|entry| &entry.lease_id))
            .cloned()
            .context(NO_LONGER_ACTIVE)
    }

    pub(super) fn answer(
        &self,
        encryption: &Service,
        lease: &Lease,
        key: &JsString,
        response: &Value,
    ) -> Result<Value> {
        let mut state = self.state.lock().unwrap();
        self.current(lease)?;
        let digest = Sha256::digest(response.stringify().as_bytes()).into();
        if let Some(prior) = state.completed.get(key) {
            ensure!(prior.lease_id == lease.id, NO_LONGER_ACTIVE);
            ensure!(prior.response_digest == digest, INVALID_RESPONSE);
            return Ok(json!({"accepted":true}));
        }
        state.expire(Instant::now(), &self.outgoing);
        let request = state.pending.get(key).context(NO_LONGER_ACTIVE)?;
        ensure!(request.lease_id == lease.id, NO_LONGER_ACTIVE);
        let answer = open(encryption, &lease.authority, key, response)
            .map_err(|_| anyhow::anyhow!(INVALID_RESPONSE))?;
        ensure!(
            answer["kind"] == "permissions"
                && answer["strictAutoReview"] == false
                && matches!(answer["scope"].as_str(), Some("turn" | "session")),
            INVALID_RESPONSE
        );
        let permissions = &answer["permissions"];
        let denied = matches!(permissions, Value::Object(fields) if fields.is_empty());
        ensure!(
            denied || *permissions == request.permissions,
            INVALID_RESPONSE
        );
        ensure!(denied || state.grants.len() < MAX_GRANTS, CAPACITY);
        self.current(lease)?;
        if request.deadline <= Instant::now() {
            state.expire(Instant::now(), &self.outgoing);
            anyhow::bail!("This computer-use approval expired.");
        }
        let request = state.pending.remove(key).unwrap();
        if !denied {
            state.grants.push(Grant {
                lease_id: lease.id.clone(),
                permissions: request.permissions,
                // A preview has no turn of its own. A turn answer permits one retry.
                once: answer["scope"] == "turn",
            });
        }
        state.completed.insert(
            key.clone(),
            Completed {
                lease_id: lease.id.clone(),
                response_digest: digest,
            },
        );
        if state.completed.len() > MAX_COMPLETED {
            state.completed.shift_remove_index(0);
        }
        Ok(json!({"accepted":true}))
    }

    pub(super) fn revoke(&self, lease_id: &JsString) {
        let mut state = self.state.lock().unwrap();
        state.pending.retain(|key, request| {
            if &request.lease_id != lease_id {
                return true;
            }
            request.terminal(key, "interrupted", &self.outgoing);
            false
        });
        state.grants.retain(|grant| &grant.lease_id != lease_id);
        state
            .completed
            .retain(|_, prior| &prior.lease_id != lease_id);
    }

    fn current(&self, lease: &Lease) -> Result<()> {
        lease.signal.check()?;
        ensure!(self.outgoing.stream_current(lease.epoch), NO_LONGER_ACTIVE);
        Ok(())
    }
}

impl State {
    fn expire(&mut self, now: Instant, outgoing: &Outbound) {
        self.pending.retain(|key, request| {
            if now < request.deadline {
                return true;
            }
            request.terminal(key, "expired", outgoing);
            false
        });
    }
}

impl Pending {
    fn terminal(&self, key: &JsString, status: &str, outgoing: &Outbound) {
        let _ = outgoing.notification(json!({
            "type":"computer-use.approval.terminal","chatId":self.chat_id,"requestKey":key,"status":status,
        }));
    }
}

pub(super) fn permission_class(operation: Option<&str>) -> Result<Option<&'static str>> {
    Ok(Some(match operation {
        None
        | Some(
            "capabilities.get" | "session.close" | "agent.sources.list" | "agent.observation.get",
        ) => return Ok(None),
        Some("targets.list" | "session.open" | "session.state" | "target.attach") => "inventory",
        Some("observation.snapshot") => "capture",
        Some("target.detach" | "cursor.configure" | "cursor.move") => "cursor",
        Some("controls.inspect") => "controls",
        Some(
            "input.press" | "input.click" | "input.perform" | "clipboard.read" | "clipboard.write"
            | "desktop.resize",
        ) => "native-input",
        _ => {
            return Err(reject(
                "unavailable",
                "This computer-use operation is unavailable.",
            ));
        }
    }))
}

pub(super) fn protect(
    encryption: &Service,
    authority: &Value,
    binding: Option<&Value>,
    key: &JsString,
    permissions: &Value,
) -> Result<Value> {
    let now = Utc::now();
    let grant = component(encryption, authority, None)?;
    let no_binding = Value::Null;
    let binding = binding.unwrap_or(&no_binding);
    let classification = json!({"kind":"permissions"});
    let reason = if permissions["computerUse"]["classes"]
        .as_array()
        .is_some_and(|classes| classes.iter().any(|class| class == "native-input"))
    {
        "Allow real computer input on the selected target on this agent's worker? An approved action can change application state, focus and the system pointer."
    } else {
        "Allow the requested computer-use observation or logical cursor operations on this agent's worker? Native input requires separate approval."
    };
    let protected = encrypt_communication(
        Communication::InteractionRequest,
        &grant.component.key,
        &json!({"ownerId":grant.owner_id,"requestKey":key,"keyRevision":grant.component.key_revision}),
        &json!({
            "version":1,"classification":classification,"payload":json!({
                "kind":"permissions","source":"native-computer-use","startedAtMs":now.timestamp_millis(),
                "environmentId":Value::Null,"cwd":Value::Null,
                "reason":reason,
                "requestedPermissions":permissions,
            })
        }),
    )?;
    checked(
        "encryptedAgentInteractionRequestCreateSchema",
        &json!({
            "requestKey":key,"projectId":authority["projectId"],"provenance":json!({
                "owner":"computer-use","chatId":authority["chatId"],"workerId":authority["workerId"],
                "threadId":binding["threadId"],"turnId":binding["turnId"],"itemId":Value::Null,
                "executionLaneId":authority["executionLaneId"],
            }),
            "classification":classification,"protectedPayload":protected,
            "expiresAt":(now + chrono::TimeDelta::from_std(LIFETIME)?).to_rfc3339_opts(SecondsFormat::Millis, true),
        }),
    )
}

pub(super) fn open(
    encryption: &Service,
    authority: &Value,
    key: &JsString,
    response: &Value,
) -> Result<Value> {
    let revision = response["protectedResponse"]["keyRevision"]
        .as_u64()
        .context(INVALID_RESPONSE)?;
    let grant = component(encryption, authority, Some(revision))?;
    let opened = decrypt_communication(
        Communication::InteractionResponse,
        &grant.component.key,
        &json!({"ownerId":grant.owner_id,"requestKey":key,"keyRevision":grant.component.key_revision}),
        &response["protectedResponse"],
        Some(&response["classification"]),
    )?;
    Ok(opened["response"].clone())
}

fn component(
    encryption: &Service,
    authority: &Value,
    revision: Option<u64>,
) -> Result<crate::encryption::BoundComponentKey> {
    let grant = encryption.bound_component("interaction-content", revision)?;
    ensure!(
        authority["ownerId"].as_js_string() == Some(&grant.owner_id)
            && authority["serverId"] == grant.server_id,
        NO_LONGER_ACTIVE
    );
    Ok(grant)
}
