use super::*;
use crate::{
    live::LiveService,
    workers::{
        bridge::WorkerBridge,
        command_bus::{CommandFailure, LimitedCommandBus},
    },
};
use std::{sync::Mutex, time::Duration};
use tokio::sync::{Notify, watch};

#[derive(Default)]
struct State {
    dispatching: bool,
    rerun: bool,
    stopping: bool,
    active: usize,
    callbacks: usize,
}
pub struct ConversionService {
    pub repository: ConversionRepository,
    pub(super) commands: Arc<LimitedCommandBus>,
    pub(super) bridge: Arc<WorkerBridge>,
    live: Arc<LiveService>,
    observations: Arc<crate::projects::observations::Service>,
    state: Mutex<State>,
    changed: Notify,
    stop: watch::Sender<bool>,
}
struct JobTask(Arc<ConversionService>);
impl Drop for JobTask {
    fn drop(&mut self) {
        let mut state = self.0.state.lock().unwrap();
        state.active -= 1;
        state.rerun = true;
        drop(state);
        self.0.changed.notify_waiters();
    }
}
struct Callback(Arc<ConversionService>);
impl Drop for Callback {
    fn drop(&mut self) {
        self.0.state.lock().unwrap().callbacks -= 1;
        self.0.changed.notify_waiters();
    }
}
impl ConversionService {
    pub async fn owned<T: Send + 'static>(
        self: &Arc<Self>,
        future: impl std::future::Future<Output = Result<T>> + Send + 'static,
    ) -> Result<T> {
        // Use the existing HTTP admission lifetime, retaining this sequence even
        // if its receiver disconnects while a database operation is pending.
        let ticket = self.callback().context("Conversion service is closing")?;
        let (send, receive) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            let _ticket = ticket;
            let _ = send.send(future.await);
        });
        receive.await.context("Conversion operation task ended")?
    }
    pub fn new(
        database: Arc<Database>,
        commands: Arc<LimitedCommandBus>,
        bridge: Arc<WorkerBridge>,
        live: Arc<LiveService>,
        observations: Arc<crate::projects::observations::Service>,
    ) -> Arc<Self> {
        Arc::new(Self {
            repository: ConversionRepository::new(database),
            commands,
            bridge,
            live,
            observations,
            state: Mutex::new(State::default()),
            changed: Notify::new(),
            stop: watch::channel(false).0,
        })
    }
    pub async fn start(self: &Arc<Self>) -> Result<()> {
        self.repository.recover(true, crate::auth::now()).await?;
        self.queue();
        let service = Arc::downgrade(self);
        let mut stop = self.stop.subscribe();
        tokio::spawn(async move {
            let mut timer = tokio::time::interval_at(
                tokio::time::Instant::now() + Duration::from_secs(30),
                Duration::from_secs(30),
            );
            timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                tokio::select! {biased;_=stop.changed()=>break,_=timer.tick()=>{}}
                let Some(service) = service.upgrade() else {
                    break;
                };
                let Some(_ticket) = service.callback() else {
                    break;
                };
                match service.repository.recover(false, crate::auth::now()).await {
                    Ok(recovered) if recovered > 0 => service.queue(),
                    Ok(_) => {}
                    Err(_) => Self::diagnostic("project.github-conversion.recovery-failed"),
                }
            }
        });
        Ok(())
    }
    fn callback(self: &Arc<Self>) -> Option<Callback> {
        let mut state = self.state.lock().unwrap();
        if state.stopping {
            return None;
        }
        state.callbacks += 1;
        Some(Callback(self.clone()))
    }
    pub fn worker_connected(self: &Arc<Self>, worker: String) {
        let Some(ticket) = self.callback() else {
            return;
        };
        let service = self.clone();
        tokio::spawn(async move {
            let _ticket = ticket;
            match service.repository.requeue_worker(&worker).await {
                Ok(_) => service.queue(),
                Err(_) => Self::diagnostic("project.github-conversion.worker-resume-failed"),
            }
        });
    }
    pub fn queue(self: &Arc<Self>) {
        let mut state = self.state.lock().unwrap();
        if state.stopping {
            return;
        }
        if state.dispatching {
            state.rerun = true;
            return;
        }
        state.dispatching = true;
        drop(state);
        let service = self.clone();
        tokio::spawn(async move {
            if service.dispatch().await.is_err() {
                Self::diagnostic("project.github-conversion.dispatch-failed");
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
        loop {
            let changed = self.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            let (stopping, active) = {
                let state = self.state.lock().unwrap();
                (state.stopping, state.active)
            };
            if stopping {
                break;
            }
            if active >= 2 {
                changed.await;
                continue;
            }
            let Some(claimed) = self.repository.claim_next().await? else {
                break;
            };
            self.state.lock().unwrap().active += 1;
            let service = self.clone();
            tokio::spawn(async move {
                let _ticket = JobTask(service.clone());
                if service.execute(&claimed).await.is_err() {
                    Self::diagnostic("project.github-conversion.transition-failed");
                }
            });
        }
        Ok(())
    }
    async fn execute(self: &Arc<Self>, claimed: &Value) -> Result<()> {
        let job = &claimed["job"];
        let id = text(&job["id"])?;
        let command = text(&claimed["commandId"])?;
        let (stop, mut ending) = watch::channel(false);
        let repository = self.repository.clone();
        let renew_id = id.clone();
        let renew_command = command.clone();
        let attempt = job["attempt"].as_f64().context("Conversion attempt")?;
        let renewal = tokio::spawn(async move {
            let mut timer = tokio::time::interval_at(
                tokio::time::Instant::now() + Duration::from_secs(30),
                Duration::from_secs(30),
            );
            timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                tokio::select! {biased;_=ending.changed()=>break,_=timer.tick()=>{}}
                match repository.renew(&renew_id, &renew_command, attempt).await {
                    Ok(true) => {}
                    Ok(false) => Self::diagnostic("project.github-conversion.lease-lost"),
                    Err(_) => Self::diagnostic("project.github-conversion.lease-renewal-failed"),
                }
            }
        });
        let result = self.perform(claimed).await;
        if let Err(error) = &result {
            if error
                .downcast_ref::<ConversionError>()
                .is_some_and(|e| matches!(e, ConversionError::Stale(_)))
            {
                Self::diagnostic("project.github-conversion.stale-completion");
            } else {
                let bridge = error.downcast_ref::<CommandFailure>().and_then(|e| {
                    if let CommandFailure::Bridge(e) = e {
                        Some(e)
                    } else {
                        None
                    }
                });
                let offline = bridge.is_some_and(|e| e.unavailable);
                let error = json!({"code":if offline {"worker-offline"}else{"reconciliation-failed"},"retryable":offline});
                let settled = if offline {
                    self.repository.block(&id, &command, &error).await
                } else {
                    self.repository.fail(&id, &command, &error).await
                };
                match settled {
                    Ok(job) => self.publish(&text(&claimed["ownerId"])?, &job),
                    Err(e)
                        if e.downcast_ref::<ConversionError>()
                            .is_some_and(|e| matches!(e, ConversionError::Stale(_))) => {}
                    Err(e) => {
                        stop.send_replace(true);
                        let _ = renewal.await;
                        return Err(e);
                    }
                }
            }
        }
        stop.send_replace(true);
        let _ = renewal.await;
        // Expected command errors are durably settled; only failures outside
        // that transition reach the dispatcher's fixed operational diagnostic.
        Ok(())
    }
    pub fn publish(&self, owner: &str, job: &Value) {
        let state = job["state"].as_str().unwrap_or_default();
        let level = match state {
            "failed" => "error",
            "blocked" => "warn",
            "succeeded" => "info",
            _ => "debug",
        };
        eprintln!("{}",json!({"event":"project.github-conversion.transitioned","subsystem":"project-github-conversion","operation":"convert","status":job["state"],"runId":job["id"],"projectId":job["projectId"],"workerId":job["workerId"],"attempt":job["attempt"],"level":level}).stringify());
        let scope = json!({"kind":"project","projectId":job["projectId"]});
        let mut events = vec![
            (
                "project-github-conversion-job",
                job["id"].clone(),
                job["stateRevision"].clone(),
            ),
            ("project", job["projectId"].clone(), Value::Null),
        ];
        if state == "succeeded" {
            for resource in ["worktree", "worktree-status", "git-operation", "settings"] {
                events.push((resource, job["projectId"].clone(), Value::Null));
            }
        }
        for (resource, entity, revision) in events {
            if self.live.publish_event(json!({"ownerId":owner,"scope":scope,"resource":resource,"action":"invalidated","entityId":entity,"revision":revision,"payload":Value::Null})).is_err(){Self::diagnostic("project.github-conversion.publication-failed");return;}
        }
        if state == "succeeded" {
            self.observations.schedule_worker(
                owner.to_owned(),
                job["workerId"].as_str().unwrap_or_default().to_owned(),
            );
        }
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
            serde_json::json!({"level":level,"event":event,"subsystem":"project-github-conversion"})
        );
    }
    pub fn stop(&self) {
        let mut state = self.state.lock().unwrap();
        state.stopping = true;
        drop(state);
        self.stop.send_replace(true);
        self.changed.notify_waiters();
    }
    pub async fn drained(&self) {
        loop {
            let changed = self.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            let done = {
                let state = self.state.lock().unwrap();
                !state.dispatching && state.active == 0 && state.callbacks == 0
            };
            if done {
                return;
            }
            changed.await;
        }
    }
}
