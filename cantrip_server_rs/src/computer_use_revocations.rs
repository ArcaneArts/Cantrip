//! Best-effort preview interruption after the durable SQL authority fence.
//! Notifications can originate from either runtime on a shared database.
use crate::{
    database::Database,
    wire::{Value, value::json},
    workers::{command_bus::LimitedCommandBus, repository::WorkerRepository},
};
use anyhow::{Context, Result};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{sync::Notify, task::AbortHandle};

const CHANNEL: &str = "cantrip_computer_use_authority";
struct Pending {
    change: Value,
    dirty: bool,
}
struct State {
    enabled: bool,
    pending: HashMap<String, Pending>,
}
pub struct Service {
    workers: WorkerRepository,
    commands: Arc<LimitedCommandBus>,
    server: String,
    state: Mutex<State>,
    listener: Mutex<Option<AbortHandle>>,
    done: Notify,
}
fn diagnose(reason: &str) {
    crate::operations::logging::server_logger()(crate::operations::logging::LogCall::repeated(
        format!("computer-use-authority:{reason}").into(),
        "warn",
        "Computer-use authority notification could not be delivered",
        json!({"event":"computer-use.authority.notification-failed","subsystem":"computer-use","operation":"revoke-preview","status":"degraded","reasonCode":reason}),
        Some(json!({"summaryEvery":5,"windowMs":60_000})),
    ));
}
impl Service {
    pub async fn start(
        database: Arc<Database>,
        commands: Arc<LimitedCommandBus>,
        server: String,
    ) -> Result<Arc<Self>> {
        // Subscribe before serving requests. Database owns LISTEN reconnection;
        // PGlite emits only committed notifications from its single session.
        let mut notifications = database.listen(CHANNEL).await?;
        let service = Arc::new(Self {
            workers: WorkerRepository::new(database),
            commands,
            server,
            state: Mutex::new(State {
                enabled: true,
                pending: HashMap::new(),
            }),
            listener: Mutex::new(None),
            done: Notify::new(),
        });
        let weak = Arc::downgrade(&service);
        let handle = tokio::spawn(async move {
            loop {
                match notifications.recv().await {
                    Ok((channel, payload)) if channel == CHANNEL => {
                        let Some(service) = weak.upgrade() else { break };
                        service.receive(&payload);
                    }
                    Ok(_) | Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                    Err(_) => break,
                }
            }
        })
        .abort_handle();
        *service.listener.lock().unwrap() = Some(handle);
        Ok(service)
    }
    fn receive(self: &Arc<Self>, payload: &str) {
        let parsed = (|| -> Result<Value> {
            anyhow::ensure!(
                crate::text::length(payload) <= 4096,
                "oversized notification"
            );
            let change: Value = serde_json::from_str(payload)?;
            crate::settings::parse_response("computerUseAuthorityChangeSchema", Some(&change))
        })();
        let Ok(change) = parsed else {
            diagnose("invalid-notification");
            return;
        };
        let key = serde_json::to_string(&change).expect("validated notification");
        {
            let mut state = self.state.lock().unwrap();
            if !state.enabled {
                return;
            }
            if let Some(entry) = state.pending.get_mut(&key) {
                entry.dirty = true;
                return;
            }
            if state.pending.len() >= 256 {
                drop(state);
                diagnose("notification-capacity");
                return;
            }
            state.pending.insert(
                key.clone(),
                Pending {
                    change,
                    dirty: false,
                },
            );
        }
        let service = self.clone();
        tokio::spawn(async move { service.deliver(key).await });
    }
    async fn revoke(&self, change: &Value) -> Result<()> {
        let owner = change["ownerId"].as_str().context("Preview owner")?;
        let workers = self.workers.list_workers(owner).await?;
        let requests=workers.iter().map(|worker| async {
            let result=self.commands.request(worker["workerId"].as_str().context("Preview worker")?,json!({"type":"computer-use.preview.revoke","ownerId":change["ownerId"],"serverId":self.server,"scope":change["scope"]}),Some(Duration::from_secs(2)),None).await?;
            let result=result.context("Invalid computer-use close acknowledgment.")?;
            anyhow::ensure!(result.as_object().is_some_and(|v|v.len()==1)&&result["closed"]==true,"Invalid computer-use close acknowledgment.");
            Ok::<_,anyhow::Error>(())
        });
        let results = futures::future::join_all(requests).await;
        anyhow::ensure!(
            results.iter().all(Result::is_ok),
            "Computer-use revocation could not reach every worker."
        );
        Ok(())
    }
    async fn deliver(self: Arc<Self>, key: String) {
        loop {
            let change = {
                let mut state = self.state.lock().unwrap();
                let entry = state.pending.get_mut(&key).unwrap();
                entry.dirty = false;
                entry.change.clone()
            };
            if self.revoke(&change).await.is_err() {
                diagnose("observer-failed")
            }
            let mut state = self.state.lock().unwrap();
            if !state.enabled || !state.pending[&key].dirty {
                state.pending.remove(&key);
                self.done.notify_waiters();
                return;
            }
        }
    }
    pub fn stop(&self) {
        self.state.lock().unwrap().enabled = false;
        if let Some(listener) = self.listener.lock().unwrap().take() {
            listener.abort()
        }
    }
    pub async fn drained(&self) {
        loop {
            let notified = self.done.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.state.lock().unwrap().pending.is_empty() {
                return;
            }
            notified.await;
        }
    }
}
impl Drop for Service {
    fn drop(&mut self) {
        if let Some(listener) = self.listener.get_mut().unwrap().take() {
            listener.abort()
        }
    }
}
