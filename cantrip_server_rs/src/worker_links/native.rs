//! Bind authority to the production Rust command bus and its actual worker
//! lifecycle. Admitted callbacks survive an HTTP/socket caller going away.
use super::*;
use crate::workers::{
    bridge::{NotificationSubscription, OfflineSubscription, WorkerBridge},
    command_bus::LimitedCommandBus,
};
use anyhow::Context;
use std::{future::Future, time::Duration};

pub(super) struct Subscriptions {
    _offline: OfflineSubscription,
    _notifications: NotificationSubscription,
}
struct Admission(Arc<Coordinator>);
impl Drop for Admission {
    fn drop(&mut self) {
        self.0.state.lock().unwrap().active -= 1;
        self.0.changed.notify_waiters();
    }
}
impl Coordinator {
    pub fn native(
        commands: Arc<LimitedCommandBus>,
        bridge: Arc<WorkerBridge>,
        options: Options,
    ) -> Arc<Self> {
        let requests: WorkerRequest = Arc::new(move |worker, command, _owner| {
            let commands = commands.clone();
            async move {
                // The reference LimitedWorkerCommandBus also resolves ownership
                // itself rather than accepting a caller's owner override.
                Ok(commands
                    .request(
                        worker.as_str().context("Enrolled WorkerLink worker")?,
                        command,
                        Some(Duration::from_secs(5)),
                        None,
                    )
                    .await?
                    .unwrap_or(Value::Null))
            }
            .boxed()
        });
        let service = Self::construct(requests, options, Some(bridge));
        let weak = Arc::downgrade(&service);
        let task = tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(5)).await;
                let Some(service) = weak.upgrade() else { break };
                let Ok(admission) = service.admission(false) else {
                    break;
                };
                tokio::spawn(async move {
                    let _admission = admission;
                    service.sweep_expired().await;
                });
            }
        });
        service.state.lock().unwrap().sweeper = Some(task.abort_handle());
        service
    }
    fn admission(self: &Arc<Self>, child: bool) -> anyhow::Result<Admission> {
        let mut state = self.state.lock().unwrap();
        if !child && state.stopping {
            return Err(unavailable("The WorkerLink coordinator is shutting down.").into());
        }
        state.active += 1;
        Ok(Admission(self.clone()))
    }
    pub async fn owned<T: Send + 'static>(
        self: &Arc<Self>,
        operation: impl Future<Output = anyhow::Result<T>> + Send + 'static,
    ) -> anyhow::Result<T> {
        let admission = self.admission(false)?;
        let (send, receive) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            let _admission = admission;
            let _ = send.send(operation.await);
        });
        receive.await.context("WorkerLink operation ended")?
    }
    pub fn stop(&self) {
        self.state.lock().unwrap().stopping = true;
    }
    pub async fn drained(&self) {
        loop {
            let changed = self.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            if self.state.lock().unwrap().active == 0 {
                return;
            }
            changed.await;
        }
    }
    pub(super) fn register_worker(self: &Arc<Self>, state: &mut State, worker: &Value) {
        let Some(bridge) = &self.bridge else { return };
        let worker = worker
            .as_str()
            .expect("Enrolled worker identity")
            .to_owned();
        if state.native_workers.contains_key(&worker) {
            return;
        }
        let (weak, id) = (Arc::downgrade(self), worker.clone());
        let offline = bridge.subscribe_worker_offline(
            &worker,
            Arc::new(move || {
                let Some(service) = weak.upgrade() else {
                    return;
                };
                let Ok(admission) = service.admission(true) else {
                    return;
                };
                let worker = Value::String(id.clone().into());
                let mut future = Box::pin(async move {
                    let _admission = admission;
                    service
                        .revoke_worker(&worker, None, "worker-disconnected")
                        .await;
                });
                // Match a JS async listener's synchronous prefix before publishing
                // a replacement worker. The command bus owns any pending request.
                if future.as_mut().now_or_never().is_none() {
                    tokio::spawn(future);
                }
            }),
        );
        let (weak, id) = (Arc::downgrade(self), worker.clone());
        let notifications = bridge.subscribe_notifications(
            &worker,
            Arc::new(move |notification| {
                let (weak, id) = (weak.clone(), id.clone());
                async move {
                    let Some(service) = weak.upgrade() else {
                        return Ok(());
                    };
                    let _admission = service.admission(true)?;
                    service
                        .receive_notification(Value::String(id.into()), (*notification).clone())
                        .await;
                    Ok(())
                }
                .boxed()
            }),
        );
        state.native_workers.insert(
            worker,
            Subscriptions {
                _offline: offline,
                _notifications: notifications,
            },
        );
    }
}
