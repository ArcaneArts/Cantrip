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
pub struct FolderService {
    pub repository: FolderRepository,
    commands: Arc<LimitedCommandBus>,
    bridge: Arc<WorkerBridge>,
    live: Arc<LiveService>,
    state: Mutex<State>,
    changed: Notify,
    stop: watch::Sender<bool>,
}
struct JobTask(Arc<FolderService>);
impl Drop for JobTask {
    fn drop(&mut self) {
        let mut state = self.0.state.lock().unwrap();
        state.active -= 1;
        state.rerun = true;
        drop(state);
        self.0.changed.notify_waiters();
    }
}
struct Callback(Arc<FolderService>);
impl Drop for Callback {
    fn drop(&mut self) {
        self.0.state.lock().unwrap().callbacks -= 1;
        self.0.changed.notify_waiters();
    }
}
impl FolderService {
    pub async fn owned<T: Send + 'static>(
        self: &Arc<Self>,
        future: impl std::future::Future<Output = Result<T>> + Send + 'static,
    ) -> Result<T> {
        // Use the existing HTTP admission lifetime, retaining this sequence even
        // if its receiver disconnects while a database operation is pending.
        let ticket = self.callback().context("Folder service is closing")?;
        let (send, receive) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            let _ticket = ticket;
            let _ = send.send(future.await);
        });
        receive.await.context("Folder operation task ended")?
    }
    pub fn new(
        database: Arc<Database>,
        commands: Arc<LimitedCommandBus>,
        bridge: Arc<WorkerBridge>,
        live: Arc<LiveService>,
    ) -> Arc<Self> {
        Arc::new(Self {
            repository: FolderRepository::new(database),
            commands,
            bridge,
            live,
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
                    Err(_) => Self::diagnostic("project-folder.setup.recovery-failed"),
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
                Err(_) => Self::diagnostic("project-folder.setup.worker-resume-failed"),
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
                Self::diagnostic("project-folder.setup.dispatch-failed");
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
            if active >= 4 {
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
                    Self::diagnostic("project-folder.setup.transition-failed");
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
        let attempt = job["attempt"].as_f64().context("Folder attempt")?;
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
                    Ok(false) => Self::diagnostic("project-folder.setup.lease-lost"),
                    Err(_) => Self::diagnostic("project-folder.setup.lease-renewal-failed"),
                }
            }
        });
        let result = self.perform(claimed).await;
        if let Err(error) = &result {
            if error
                .downcast_ref::<FolderError>()
                .is_some_and(|e| matches!(e, FolderError::Stale(_)))
            {
                Self::diagnostic("project-folder.setup.stale-completion");
            } else {
                let bridge = error.downcast_ref::<CommandFailure>().and_then(|e| {
                    if let CommandFailure::Bridge(e) = e {
                        Some(e)
                    } else {
                        None
                    }
                });
                let offline = bridge.is_some_and(|e| e.unavailable);
                let code = if offline {
                    "worker-offline"
                } else if !crate::wire::coercion::truthy(claimed.get("existingPath")) {
                    "materialization-failed"
                } else {
                    bridge
                        .and_then(|e| e.code.as_ref())
                        .map(|s| s.as_str())
                        .filter(|s| {
                            matches!(
                                *s,
                                "existing-path-missing"
                                    | "existing-path-not-directory"
                                    | "existing-path-permission-denied"
                            )
                        })
                        .unwrap_or("attachment-failed")
                };
                let settled = self
                    .repository
                    .settle(
                        &id,
                        &command,
                        if offline { "blocked" } else { "failed" },
                        &Value::object([
                            ("code", Value::String(code.into())),
                            ("retryable", Value::Bool(offline)),
                        ]),
                    )
                    .await;
                match settled {
                    Ok(job) => self.publish(&text(&claimed["ownerId"])?, &job),
                    Err(e)
                        if e.downcast_ref::<FolderError>()
                            .is_some_and(|e| matches!(e, FolderError::Stale(_))) => {}
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
    async fn perform(&self, claimed: &Value) -> Result<()> {
        let job = &claimed["job"];
        let owner = text(&claimed["ownerId"])?;
        let worker_id = text(&job["workerId"])?;
        let project = text(&job["projectId"])?;
        let id = text(&job["id"])?;
        let command = text(&claimed["commandId"])?;
        let worker =
            crate::projects::targets::TargetRepository::new(self.repository.database.clone())
                .worker(&owner, &job["workerId"])
                .await?;
        let Some(worker) = worker.filter(|_| self.bridge.is_connected(&worker_id)) else {
            let settled = self
                .repository
                .settle(
                    &id,
                    &command,
                    "blocked",
                    &Value::object([
                        ("code", Value::String("worker-offline".into())),
                        ("retryable", Value::Bool(true)),
                    ]),
                )
                .await?;
            self.publish(&owner, &settled);
            return Ok(());
        };
        let storage = self
            .repository
            .workspace_storage(&owner, &project)
            .await?
            .context("Project workspace storage is unavailable.")?;
        anyhow::ensure!(
            !worker["managedFolders"].is_null(),
            "Cannot read managed folder capabilities from null"
        );
        if !crate::wire::coercion::truthy(worker["managedFolders"].get("create"))
            || storage["kind"] == "managed"
                && !crate::wire::coercion::truthy(
                    worker["managedFolders"].get("workspaceScopedRoots"),
                )
        {
            let failed = self
                .repository
                .settle(
                    &id,
                    &command,
                    "failed",
                    &Value::object([
                        ("code", Value::String("capability-missing".into())),
                        ("retryable", Value::Bool(false)),
                    ]),
                )
                .await?;
            self.publish(&owner, &failed);
            return Ok(());
        }
        let mut request = Value::object([
            ("type", Value::String("project.folder.materialize".into())),
            ("jobId", job["id"].clone()),
            ("attempt", job["attempt"].clone()),
            ("projectId", job["projectId"].clone()),
            ("workspaceStorage", storage),
        ]);
        if crate::wire::coercion::truthy(claimed.get("existingPath")) {
            request["existingPath"] = claimed["existingPath"].clone();
        }
        let response = self
            .commands
            .request(&worker_id, request, Some(Duration::from_secs(60)), None)
            .await?
            .unwrap_or(Value::Null);
        let response =
            crate::wire::parse("managedFolderMaterializeReadySchema", Some(&response))
                .map_err(|_| anyhow::anyhow!("Invalid worker folder materialization result"))?;
        let completed = self.repository.complete(&id, &command, &response).await?;
        self.publish(&owner, &completed);
        Ok(())
    }
    pub fn publish(&self, owner: &str, job: &Value) {
        let state = job["state"].as_str().unwrap_or("");
        let level = match state {
            "failed" => "error",
            "blocked" => "warn",
            "succeeded" => "info",
            _ => "debug",
        };
        eprintln!(
            "{}",
            Value::object([
                (
                    "event",
                    Value::String("project-folder.setup.transitioned".into())
                ),
                ("subsystem", Value::String("project-folder".into())),
                ("operation", Value::String("materialize".into())),
                ("level", Value::String(level.into())),
                ("status", job["state"].clone()),
                ("runId", job["id"].clone()),
                ("projectId", job["projectId"].clone()),
                ("workerId", job["workerId"].clone()),
                ("attempt", job["attempt"].clone())
            ])
            .stringify()
        );
        for (resource, entity, revision) in [
            (
                "project-folder-setup-job",
                job["id"].clone(),
                job["stateRevision"].clone(),
            ),
            ("project", job["projectId"].clone(), Value::Null),
        ]
        .into_iter()
        .chain((state == "succeeded").then(|| ("worktree", job["projectId"].clone(), Value::Null)))
        {
            let event = Value::object([
                ("ownerId", Value::String(owner.into())),
                (
                    "scope",
                    Value::object([
                        ("kind", Value::String("project".into())),
                        ("projectId", job["projectId"].clone()),
                    ]),
                ),
                ("resource", Value::String(resource.into())),
                ("action", Value::String("invalidated".into())),
                ("entityId", entity),
                ("revision", revision),
                ("payload", Value::Null),
            ]);
            if self.live.publish_event(event).is_err() {
                Self::diagnostic("project-folder.setup.publication-failed");
                break;
            }
        }
    }
    fn diagnostic(event: &str) {
        eprintln!(
            "{}",
            serde_json::json!({"level":"warn","event":event,"subsystem":"project-folder"})
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
