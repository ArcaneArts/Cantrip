use super::*;
use crate::{
    live::LiveService,
    workers::{bridge::WorkerBridge, command_bus::LimitedCommandBus},
};
use std::{sync::Mutex, time::Duration};
use tokio::sync::{Notify, watch};

#[derive(Default)]
struct State {
    dispatching: bool,
    rerun: bool,
    stopping: bool,
    callbacks: usize,
}
pub struct DiscoveryService {
    pub repository: DiscoveryRepository,
    pub(super) commands: Arc<LimitedCommandBus>,
    pub(super) bridge: Arc<WorkerBridge>,
    live: Arc<LiveService>,
    state: Mutex<State>,
    changed: Notify,
    stop: watch::Sender<bool>,
}
struct Callback(Arc<DiscoveryService>);
impl Drop for Callback {
    fn drop(&mut self) {
        self.0.state.lock().unwrap().callbacks -= 1;
        self.0.changed.notify_waiters();
    }
}
impl DiscoveryService {
    pub fn new(
        database: Arc<Database>,
        commands: Arc<LimitedCommandBus>,
        bridge: Arc<WorkerBridge>,
        live: Arc<LiveService>,
    ) -> Arc<Self> {
        Arc::new(Self {
            repository: DiscoveryRepository::new(database),
            commands,
            bridge,
            live,
            state: Mutex::new(State::default()),
            changed: Notify::new(),
            stop: watch::channel(false).0,
        })
    }
    fn callback(self: &Arc<Self>) -> Option<Callback> {
        let mut state = self.state.lock().unwrap();
        if state.stopping {
            return None;
        };
        state.callbacks += 1;
        Some(Callback(self.clone()))
    }
    pub async fn owned<T: Send + 'static>(
        self: &Arc<Self>,
        future: impl std::future::Future<Output = Result<T>> + Send + 'static,
    ) -> Result<T> {
        let ticket = self
            .callback()
            .context("Workspace discovery service is closing")?;
        let (send, receive) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            let _ticket = ticket;
            let _ = send.send(future.await);
        });
        receive
            .await
            .context("Workspace discovery operation task ended")?
    }
    async fn recover(&self, force: bool) -> Result<usize> {
        let at = crate::auth::now();
        let (scans, imports) = tokio::try_join!(
            self.repository.recover_scans(force, at),
            self.repository.recover_imports(force, at)
        )?;
        Ok(scans + imports)
    }
    pub async fn start(self: &Arc<Self>) -> Result<()> {
        self.recover(true).await?;
        self.queue();
        let weak = Arc::downgrade(self);
        let mut stop = self.stop.subscribe();
        tokio::spawn(async move {
            let mut timer = tokio::time::interval_at(
                tokio::time::Instant::now() + Duration::from_secs(30),
                Duration::from_secs(30),
            );
            timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                tokio::select! {biased;_=stop.changed()=>break,_=timer.tick()=>{}}
                let Some(service) = weak.upgrade() else { break };
                let Some(_ticket) = service.callback() else {
                    break;
                };
                match service.recover(false).await {
                    Ok(n) if n > 0 => service.queue(),
                    Ok(_) => {}
                    Err(_) => Self::diagnostic("workspace.repository-discovery.recovery-failed"),
                }
            }
        });
        Ok(())
    }
    pub fn worker_connected(self: &Arc<Self>, worker: String) {
        let Some(ticket) = self.callback() else {
            return;
        };
        let service = self.clone();
        tokio::spawn(async move {
            let _ticket = ticket;
            match tokio::try_join!(
                service.repository.requeue_worker_scans(&worker),
                service.repository.requeue_worker_imports(&worker)
            ) {
                Ok(_) => service.queue(),
                Err(_) => Self::diagnostic("workspace.repository-discovery.worker-resume-failed"),
            }
        });
    }
    pub fn queue(self: &Arc<Self>) {
        let mut state = self.state.lock().unwrap();
        if state.stopping {
            return;
        };
        if state.dispatching {
            state.rerun = true;
            return;
        };
        state.dispatching = true;
        drop(state);
        let service = self.clone();
        tokio::spawn(async move {
            if service.dispatch().await.is_err() {
                Self::diagnostic("workspace.repository-discovery.dispatch-failed");
            }
            let mut state = service.state.lock().unwrap();
            state.dispatching = false;
            let again = state.rerun;
            state.rerun = false;
            drop(state);
            service.changed.notify_waiters();
            if again {
                service.queue();
            }
        });
    }
    async fn dispatch(self: &Arc<Self>) -> Result<()> {
        // Scans and imports share the reference executor's single slot. A scan
        // always gets the next slot before a queued import.
        while !self.state.lock().unwrap().stopping {
            let scan = self.repository.claim_scan().await?;
            let (claimed, import) = if let Some(scan) = scan {
                (scan, false)
            } else if let Some(import) = self.repository.claim_import().await? {
                (import, true)
            } else {
                break;
            };
            if self.execute(&claimed, import).await.is_err() {
                Self::diagnostic("workspace.repository-discovery.transition-failed");
            }
        }
        Ok(())
    }
    pub fn publish(&self, owner: &str, job: &Value, progress: Option<&Value>) {
        if progress.is_none() {
            let level = match job["state"].as_str() {
                Some("failed") => "error",
                Some("blocked") => "warn",
                Some("succeeded") => "info",
                _ => "debug",
            };
            eprintln!("{}",json!({"event":"workspace.repository-discovery.transitioned","subsystem":"workspace-repository-discovery","operation":"discover","status":job["state"],"runId":job["id"],"workspaceId":job["workspaceId"],"workerId":job["workerId"],"attempt":job["attempt"],"level":level}).stringify());
        }
        if self.live.publish_event(json!({"ownerId":owner,"scope":json!({"kind":"current-user"}),"resource":"workspace-repository-discovery-job","action":if progress.is_some(){"status"}else{"invalidated"},"entityId":job["workspaceId"],"revision":job["stateRevision"],"payload":progress.map_or(Value::Null,|v|json!({"progress":v}))})).is_err(){Self::diagnostic("workspace.repository-discovery.publication-failed");}
    }
    pub(super) fn diagnostic(event: &str) {
        let level = if event.ends_with("lease-lost")
            || event.ends_with("lease-renewal-failed")
            || event.ends_with("stale-completion")
        {
            "warn"
        } else {
            "error"
        };
        eprintln!(
            "{}",
            serde_json::json!({"event":event,"subsystem":"workspace-repository-discovery","level":level})
        );
    }
    pub fn stop(&self) {
        self.state.lock().unwrap().stopping = true;
        self.stop.send_replace(true);
        self.changed.notify_waiters();
    }
    pub async fn drained(&self) {
        loop {
            let changed = self.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            {
                let state = self.state.lock().unwrap();
                if !state.dispatching && state.callbacks == 0 {
                    return;
                };
            }
            changed.await;
        }
    }
}
