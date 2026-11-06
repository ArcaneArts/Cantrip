//! Development controls around actual authority callbacks, not mock Redis results.
use super::{Events, record, text};
use anyhow::{Context, Result};
use cantrip_server::{
    wire::Value,
    worker_links::{
        WorkerRequest,
        authority::{Authority, RelayRevokeListener, RelayRevokeSubscription},
    },
};
use futures::FutureExt;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, Weak},
};
use tokio::sync::oneshot;

#[derive(Default)]
pub struct Workers {
    pub commands: Vec<Value>,
    pub behavior: HashMap<String, Value>,
    pub held: HashMap<String, Vec<oneshot::Sender<Value>>>,
}
impl Workers {
    pub fn request(state: Arc<Mutex<Self>>, server: Value, generation: Value) -> WorkerRequest {
        Arc::new(move |worker, command, owner| {
            let (state, server, generation) = (state.clone(), server.clone(), generation.clone());
            async move {
                let (behavior, wait) = {
                    let mut state = state.lock().unwrap();
                    let kind = text(&command,"type");
                    let behavior = state.behavior.get(&kind).cloned().unwrap_or(Value::Null);
                    state.commands.push(j!({"worker":worker,"command":command,"owner":owner,"timeoutMs":5000}));
                    let wait = if behavior["hold"] == true {
                        let (send, receive) = oneshot::channel();
                        state.held.entry(kind).or_default().push(send);
                        Some(receive)
                    } else { None };
                    (behavior, wait)
                };
                let outcome = if let Some(wait) = wait { wait.await.context("Fixture worker ACK ended")? } else { behavior };
                if let Some(error) = outcome["error"].as_str() { anyhow::bail!("{error}"); }
                Ok(outcome.get("response").cloned().unwrap_or_else(|| {
                    if command["type"] == "worker-link.identity.resolve" {
                        j!({"serverId":server,"ownerId":owner,"workerId":worker,"workerProcessGeneration":generation})
                    } else { j!({"accepted":true}) }
                }))
            }.boxed()
        })
    }
}
pub struct Listeners {
    authority: Weak<Authority>,
    events: Events,
    callbacks: Mutex<HashMap<String, RelayRevokeListener>>,
    subscriptions: Mutex<HashMap<String, RelayRevokeSubscription>>,
}
impl Listeners {
    pub fn new(authority: &Arc<Authority>, events: Events) -> Arc<Self> {
        Arc::new(Self {
            authority: Arc::downgrade(authority),
            events,
            callbacks: Mutex::default(),
            subscriptions: Mutex::default(),
        })
    }
    pub fn remove(&self, token: &str) {
        self.subscriptions.lock().unwrap().remove(token);
    }
    pub fn add(self: &Arc<Self>, name: String, token: String, spec: Value) -> Result<()> {
        let existing = self.callbacks.lock().unwrap().get(&name).cloned();
        let callback = existing.unwrap_or_else(|| {
            let weak = Arc::downgrade(self);
            let callback_name = name.clone();
            Arc::new(move |scope| {
                let Some(listeners) = weak.upgrade() else {
                    return Ok(());
                };
                record(
                    &listeners.events,
                    j!({"kind":"relay-revoke","name":callback_name,"scope":scope}),
                );
                if let Some(tokens) = spec["remove"].as_array() {
                    for token in tokens {
                        listeners.remove(token.as_str().unwrap());
                    }
                }
                if let Some(entries) = spec["add"].as_array() {
                    for entry in entries {
                        listeners.add(
                            text(entry, "name"),
                            text(entry, "token"),
                            entry["spec"].clone(),
                        )?;
                    }
                }
                if spec["fail"] == true {
                    anyhow::bail!("Controlled relay revocation listener failed.");
                }
                Ok(())
            })
        });
        self.callbacks
            .lock()
            .unwrap()
            .insert(name, callback.clone());
        let authority = self.authority.upgrade().context("Fixture authority")?;
        let subscription = authority.subscribe_relay_revocations(callback);
        self.subscriptions
            .lock()
            .unwrap()
            .insert(token, subscription);
        Ok(())
    }
}
