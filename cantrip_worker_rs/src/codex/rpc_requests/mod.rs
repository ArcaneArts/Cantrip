//! Observation deadlines do not settle accepted native execution.
mod responses;
#[cfg(test)]
mod tests;
use super::provider_errors::Policy;
use crate::logging::Logs;
use anyhow::Result;
use cantrip_history::projection::Work;
use cantrip_wire::{JsString, Value, coercion, value::json};
use indexmap::IndexMap;
use responses::log;
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::{sync::oneshot, task::AbortHandle, time::Instant};

#[derive(Clone, Debug)]
pub struct Failure {
    pub kind: &'static str,
    pub message: JsString,
    pub native_error: Option<Value>,
    pub request_method: Option<JsString>,
}
impl Failure {
    pub fn observation(message: impl Into<JsString>) -> Self {
        Self {
            kind: "observation",
            message: message.into(),
            native_error: None,
            request_method: None,
        }
    }
    pub fn send(message: impl Into<JsString>) -> Self {
        Self {
            kind: "error",
            ..Self::observation(message)
        }
    }
}
impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message.lossy())
    }
}
impl std::error::Error for Failure {}
pub trait Settlement: Send + Sync {
    fn replied(&self) -> Result<()>;
    fn not_sent(&self) -> Result<()>;
}
pub type SendFrame = Arc<dyn Fn(Value) -> Result<()> + Send + Sync>;
pub type Record = Arc<dyn Fn(Value, Option<JsString>) + Send + Sync>;
pub struct Ports {
    pub send: SendFrame,
    pub record: Record,
    pub policy: Policy,
    pub runtime_id: Option<String>,
    pub logs: Option<Arc<Logs>>,
}
pub type Response = Option<Value>;
struct Pending {
    method: JsString,
    send: oneshot::Sender<std::result::Result<Response, Failure>>,
    timer: Option<AbortHandle>,
    started: Instant,
}
#[derive(Default)]
struct State {
    pending: IndexMap<u64, Pending>,
    private: HashMap<u64, &'static str>,
    settlements: HashMap<u64, Arc<dyn Settlement>>,
}
impl Drop for State {
    fn drop(&mut self) {
        for pending in self.pending.values() {
            if let Some(timer) = &pending.timer {
                timer.abort();
            }
        }
    }
}
struct Inner {
    state: Mutex<State>,
    next: AtomicU64,
    ports: Ports,
}
#[derive(Clone)]
pub struct Requests(Arc<Inner>);
fn numeric_id(value: &Value) -> Option<u64> {
    let n = coercion::number(Some(value)).ok()?;
    (n.is_finite() && n.fract() == 0. && n >= 1. && n <= u64::MAX as f64).then_some(n as u64)
}
impl Requests {
    pub fn new(ports: Ports) -> Self {
        Self(Arc::new(Inner {
            state: Mutex::new(State::default()),
            next: AtomicU64::new(1),
            ports,
        }))
    }
    pub fn pending_count(&self) -> usize {
        self.0.state.lock().unwrap().pending.len()
    }
    pub fn request(
        &self,
        method: JsString,
        params: Option<Value>,
        timeout: Option<Duration>,
        settlement: Option<Arc<dyn Settlement>>,
    ) -> Work<Response> {
        let id = self.0.next.fetch_add(1, Ordering::Relaxed);
        let (send, receive) = oneshot::channel();
        let started = Instant::now();
        let weak = Arc::downgrade(&self.0);
        let mut state = self.0.state.lock().unwrap();
        let timer = timeout.map(|duration| {
            tokio::spawn(async move {
                tokio::time::sleep(duration.max(Duration::from_millis(1))).await;
                if let Some(owner) = weak.upgrade() {
                    let pending = owner.state.lock().unwrap().pending.shift_remove(&id);
                    if let Some(pending) = pending {
                        log(&owner.ports, &pending, "timed-out", None);
                        let message = super::provider_errors::surround(
                            "Codex request ",
                            &pending.method,
                            " timed out.",
                        );
                        let _ = pending.send.send(Err(Failure::observation(message)));
                    }
                }
            })
            .abort_handle()
        });
        match method.as_str() {
            Some("cantrip/inference") => {
                state.private.insert(id, "privateInference");
            }
            Some(super::rpc_protocol::RESOURCE_RESOLVE) => {
                state.private.insert(id, "privateNativeResources");
            }
            Some(super::customizations::oauth::LOGIN) => {
                state.private.insert(id, "privateMcpOauth");
            }
            Some(
                super::customizations::external::DETECT | super::customizations::external::IMPORT,
            ) => {
                state.private.insert(id, "privateExternalConfig");
            }
            _ => {}
        }
        if let Some(settlement) = &settlement {
            state.settlements.insert(id, settlement.clone());
        }
        state.pending.insert(
            id,
            Pending {
                method: method.clone(),
                send,
                timer,
                started,
            },
        );
        drop(state);
        let mut frame = json!({"id":id,"method":method});
        if let Some(params) = params {
            frame["params"] = params;
        }
        if let Err(error) = (self.0.ports.send)(frame) {
            let pending = {
                let mut state = self.0.state.lock().unwrap();
                state.private.remove(&id);
                state.settlements.remove(&id);
                state.pending.shift_remove(&id)
            };
            if let Some(settlement) = settlement {
                let _ = settlement.not_sent();
            }
            if let Some(pending) = pending {
                if let Some(timer) = pending.timer {
                    timer.abort();
                }
                let _ = pending
                    .send
                    .send(Err(Failure::send(crate::error::message(&error))));
            }
        }
        cantrip_transport::lifecycle::owned(async move {
            receive
                .await
                .unwrap_or_else(|_| Err(Failure::observation("Codex app-server client closed.")))
                .map_err(Into::into)
        })
    }
    pub fn reject_all(&self, message: JsString) {
        let pending = {
            let mut state = self.0.state.lock().unwrap();
            state.private.clear();
            state.settlements.clear();
            std::mem::take(&mut state.pending)
        };
        for (_, pending) in pending {
            if let Some(timer) = pending.timer {
                timer.abort();
            }
            let _ = pending
                .send
                .send(Err(Failure::observation(message.clone())));
        }
    }
    pub fn diagnostic_payload(&self, message: &Value) -> Value {
        if message["method"] == super::customizations::oauth::COMPLETED {
            return json!({"method":message["method"],"params":json!({
                "success":message["params"]["success"]
            })});
        }
        if super::customizations::external::notification_phase(&message["method"]).is_some() {
            return json!({"method":message["method"]});
        }
        if !coercion::truthy(message.get("method"))
            && message.get("id").is_some()
            && let Some(kind) = numeric_id(&message["id"])
                .and_then(|id| self.0.state.lock().unwrap().private.remove(&id))
        {
            let mut status = json!({"id":message["id"],"status":if coercion::truthy(message.get("error")){"failed"}else{"completed"}});
            status[kind] = json!(true);
            status
        } else {
            message.clone()
        }
    }
    pub fn remember_secret(&self, secret: JsString) {
        self.0.ports.policy.remember_secret(secret);
    }

    pub fn record(&self, diagnostic: Value, warning: Option<JsString>) {
        (self.0.ports.record)(
            self.0.ports.policy.diagnostic(&diagnostic),
            warning.map(|v| {
                self.0
                    .ports
                    .policy
                    .redact(&Value::String(v))
                    .as_js_string()
                    .unwrap()
                    .clone()
            }),
        );
    }
}
fn diagnostic(kind: &str, payload: Value) -> Value {
    json!({"at":chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis,true),"direction":"from-runtime","kind":kind,"method":Value::Null,"payload":payload})
}
