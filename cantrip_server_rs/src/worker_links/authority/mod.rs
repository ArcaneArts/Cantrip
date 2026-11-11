//! WorkerLinkService authority election, operation RPC and distributed revocation.
//! The existing local coordinator owns capability/peer state and worker commands.
mod api;
mod operations;
mod parse;
pub(crate) use parse::relay_scope as parse_relay_revocation;
#[cfg(test)]
mod tests;
use super::{Coordinator, Error, ResourceScope, Result, RevocationScope, checked, unavailable};
use crate::{
    coordination::RelayCoordinator,
    wire::{self, JsString, Value, value::json},
};
use futures::{FutureExt, future::BoxFuture};
use indexmap::{IndexMap, IndexSet};
use std::{
    collections::HashSet,
    future::Future,
    sync::{
        Arc, Mutex, Weak,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::{
    sync::{Notify, oneshot},
    task::AbortHandle,
};
use uuid::Uuid;

type Outcome = Result<Option<Value>>;
pub type RelayRevokeListener = Arc<dyn Fn(Value) -> anyhow::Result<()> + Send + Sync>;
struct Pending {
    send: oneshot::Sender<Outcome>,
    timer: AbortHandle,
}
#[derive(Default)]
struct State {
    closed: bool,
    sessions: IndexSet<String>,
    pending: IndexMap<String, Pending>,
    listeners: IndexMap<Uuid, RelayRevokeListener>,
}
pub struct Authority {
    pub local: Arc<Coordinator>,
    coordination: Option<Arc<dyn RelayCoordinator>>,
    state: Mutex<State>,
    subscription: Mutex<Option<u64>>,
    active: AtomicUsize,
    drained: Notify,
}
struct Active(Arc<Authority>);
impl Drop for Active {
    fn drop(&mut self) {
        if self.0.active.fetch_sub(1, Ordering::AcqRel) == 1 {
            self.0.drained.notify_waiters();
        }
    }
}
pub struct RelayRevokeSubscription {
    authority: Weak<Authority>,
    id: Uuid,
}
impl Drop for RelayRevokeSubscription {
    fn drop(&mut self) {
        if let Some(authority) = self.authority.upgrade() {
            authority
                .state
                .lock()
                .unwrap()
                .listeners
                .shift_remove(&self.id);
        }
    }
}
fn now() -> f64 {
    chrono::Utc::now().timestamp_millis() as f64
}
fn bounded(value: &JsString) -> JsString {
    JsString::new(value.units().iter().take(500).copied().collect())
}
fn error_message(error: &Error) -> JsString {
    match error {
        Error::Unavailable(message) => message.clone(),
        Error::Failure(error) => error.to_string().into(),
    }
}
fn claim(instance: &str, session: &Value) -> Value {
    let expires = session["lease"]["expiresAt"]
        .as_js_string()
        .and_then(wire::date_milliseconds)
        .map_or(f64::NAN, |v| v as f64);
    json!({"authorityInstanceId":instance,"expiresAt":expires,"session":session})
}
impl Authority {
    pub fn new(
        local: Arc<Coordinator>,
        coordination: Option<Arc<dyn RelayCoordinator>>,
    ) -> Arc<Self> {
        let service = Arc::new(Self {
            local,
            coordination,
            state: Mutex::default(),
            subscription: Mutex::new(None),
            active: AtomicUsize::new(0),
            drained: Notify::new(),
        });
        if let Some(coordinator) = &service.coordination {
            let weak = Arc::downgrade(&service);
            let token = coordinator.subscribe(Arc::new(move |message| {
                let weak = weak.clone();
                Box::pin(async move {
                    if let Some(service) = weak.upgrade() {
                        service.receive(message).await.map_err(anyhow::Error::new)?;
                    }
                    Ok(())
                })
            }));
            *service.subscription.lock().unwrap() = Some(token);
        }
        service
    }
    fn assert_open(&self) -> Result<()> {
        if self.state.lock().unwrap().closed {
            Err(unavailable("WorkerLink service is closed."))
        } else {
            Ok(())
        }
    }
    fn own<T: Send + 'static>(
        self: &Arc<Self>,
        operation: impl Future<Output = Result<T>> + Send + 'static,
    ) -> BoxFuture<'static, Result<T>> {
        self.active.fetch_add(1, Ordering::AcqRel);
        let active = Active(self.clone());
        let (send, receive) = oneshot::channel();
        let mut running = Box::pin(async move {
            let _active = active;
            let _ = send.send(operation.await);
        });
        if running.as_mut().now_or_never().is_none() {
            tokio::spawn(running);
        }
        Box::pin(async move {
            receive
                .await
                .unwrap_or_else(|_| Err(unavailable("WorkerLink service closed.")))
        })
    }
    pub fn stats(&self) -> Value {
        self.local.stats()
    }
    pub fn subscribe_relay_revocations(
        self: &Arc<Self>,
        listener: RelayRevokeListener,
    ) -> RelayRevokeSubscription {
        let mut state = self.state.lock().unwrap();
        let id = state
            .listeners
            .iter()
            .find(|(_, callback)| Arc::ptr_eq(callback, &listener))
            .map(|(id, _)| *id)
            .unwrap_or_else(Uuid::new_v4);
        state.listeners.insert(id, listener);
        RelayRevokeSubscription {
            authority: Arc::downgrade(self),
            id,
        }
    }
    fn notify_relay(&self, scope: Value) -> Result<()> {
        let mut visited = HashSet::new();
        loop {
            let next = self
                .state
                .lock()
                .unwrap()
                .listeners
                .iter()
                .find(|(id, _)| !visited.contains(*id))
                .map(|(id, listener)| (*id, listener.clone()));
            let Some((id, listener)) = next else {
                return Ok(());
            };
            visited.insert(id);
            listener(scope.clone()).map_err(Error::from)?;
        }
    }
    async fn revoke_relay(&self, scope: Value) -> Result<()> {
        self.notify_relay(scope.clone())?;
        if let Some(coordinator) = &self.coordination {
            coordinator
                .publish(
                    json!({"kind":"worker-link-relay-revoke","scope":scope}),
                    None,
                )
                .await?;
        }
        Ok(())
    }
    pub async fn close(&self) -> Result<()> {
        let (pending, sessions) = {
            let mut state = self.state.lock().unwrap();
            if state.closed {
                return Ok(());
            }
            state.closed = true;
            state.listeners.clear();
            (
                std::mem::take(&mut state.pending),
                std::mem::take(&mut state.sessions),
            )
        };
        if let (Some(coordinator), Some(token)) =
            (&self.coordination, self.subscription.lock().unwrap().take())
        {
            coordinator.unsubscribe(token);
        }
        for (_, pending) in pending {
            pending.timer.abort();
            let _ = pending
                .send
                .send(Err(unavailable("WorkerLink service closed.")));
        }
        self.local.close().await;
        if let Some(coordinator) = &self.coordination {
            let releases = sessions.into_iter().map(|session| {
                let coordinator = coordinator.clone();
                // Promises already started by Promise.all continue even if
                // another release fails. An owned task retains that lifetime.
                let mut release = Box::pin(async move {
                    coordinator
                        .release_worker_link_session(
                            &session.into(),
                            &coordinator.instance_id().into(),
                        )
                        .await
                        .map_err(Error::from)
                });
                let (send, receive) = oneshot::channel();
                if let Some(value) = release.as_mut().now_or_never() {
                    let _ = send.send(value);
                } else {
                    tokio::spawn(async move {
                        let _ = send.send(release.await);
                    });
                }
                async move {
                    receive
                        .await
                        .map_err(|_| unavailable("WorkerLink service closed."))??;
                    Ok::<_, Error>(())
                }
            });
            futures::future::try_join_all(releases).await?;
        }
        Ok(())
    }
    pub async fn drained(&self) {
        loop {
            let notified = self.drained.notified();
            if self.active.load(Ordering::Acquire) == 0 {
                break;
            }
            notified.await;
        }
        self.local.drained().await;
    }
}
impl Drop for Authority {
    fn drop(&mut self) {
        if let (Some(coordinator), Some(token)) = (
            &self.coordination,
            self.subscription.get_mut().unwrap().take(),
        ) {
            coordinator.unsubscribe(token);
        }
    }
}
