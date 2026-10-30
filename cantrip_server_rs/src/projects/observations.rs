//! Debounced worker observation configuration and fenced path reconciliation.
use super::{coordinator::Coordinator, targets::TargetRepository};
use crate::{
    database::Database,
    operations::logging::{self, LogCall},
    wire::{Value, value::json},
    workers::{
        bridge::WorkerBridge,
        command_bus::{CommandFailure, LimitedCommandBus},
    },
};
use anyhow::{Context, Result};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::oneshot;
mod codegraph;
mod notifications;

struct Timer {
    id: uuid::Uuid,
    cancel: oneshot::Sender<()>,
}
#[derive(Default)]
struct State {
    codegraph: codegraph::Registry,
    stopped: bool,
    timers: HashMap<(String, String), Timer>,
    subscriptions: HashMap<String, crate::workers::bridge::NotificationSubscription>,
}
pub struct Service {
    live: std::sync::Weak<crate::live::LiveService>,
    repository: TargetRepository,
    bridge: Arc<WorkerBridge>,
    commands: Arc<LimitedCommandBus>,
    tasks: Arc<Coordinator>,
    state: Mutex<State>,
}
impl Service {
    pub fn new(
        database: Arc<Database>,
        bridge: Arc<WorkerBridge>,
        commands: Arc<LimitedCommandBus>,
        live: &Arc<crate::live::LiveService>,
    ) -> Arc<Self> {
        Arc::new(Self {
            live: Arc::downgrade(live),
            repository: TargetRepository::new(database),
            bridge,
            commands,
            tasks: Coordinator::new(Arc::new(|_, _| {})),
            state: Mutex::new(State::default()),
        })
    }
    pub fn schedule_project(self: &Arc<Self>, owner: String, project: String) {
        let state = self.state.lock().unwrap();
        if state.stopped {
            return;
        }
        let service = self.clone();
        drop(self.tasks.own(async move {
            let connected = |worker: &str| service.bridge.is_connected(worker);
            match service
                .repository
                .observation_source(&owner, &project, &connected)
                .await
            {
                Ok(Some(source)) => service.schedule_worker(
                    owner,
                    source["workerId"]
                        .as_str()
                        .context("Observation source worker")?
                        .to_owned(),
                ),
                Ok(None) => {}
                Err(error) => service.warn(&error, None),
            }
            Ok(())
        }));
    }
    pub fn schedule_worker(self: &Arc<Self>, owner: String, worker: String) {
        let mut state = self.state.lock().unwrap();
        if state.stopped {
            return;
        }
        let key = (owner.clone(), worker.clone());
        let id = uuid::Uuid::new_v4();
        let (cancel, cancelled) = oneshot::channel();
        if let Some(previous) = state.timers.insert(key.clone(), Timer { id, cancel }) {
            let _ = previous.cancel.send(());
        }
        let service = self.clone();
        drop(self.tasks.own(async move {
            tokio::select! { _=cancelled=>return Ok(()), _=tokio::time::sleep(Duration::from_millis(100))=>{} }
            {
                let mut state=service.state.lock().unwrap();
                if state.stopped || state.timers.get(&key).is_none_or(|timer|timer.id!=id) {return Ok(());}
                state.timers.remove(&key);
            }
            if let Err(error)=service.configure(&owner,&worker).await { service.warn(&error,Some(&worker)); }
            Ok(())
        }));
    }
    fn warn(&self, error: &anyhow::Error, worker: Option<&str>) {
        if error
            .downcast_ref::<CommandFailure>()
            .is_some_and(|failure| failure.status(502) == 503)
        {
            return;
        }
        (logging::server_logger())(LogCall::event(
            "warn",
            "Could not configure worker worktree observation",
            json!({"err":json!({"message":error.to_string()}),"workerId":worker}),
        ));
    }
    async fn configure(self: &Arc<Self>, owner: &str, worker: &str) -> Result<()> {
        if !self.bridge.is_connected(worker) {
            return Ok(());
        }
        let (targets, roots) = tokio::try_join!(
            self.repository
                .observation_targets(owner, worker, true, 128),
            self.repository
                .observation_targets(owner, worker, false, 128)
        )?;
        let mut configured = Vec::new();
        for target in targets {
            let active = self
                .repository
                .active_observation_operation(
                    owner,
                    target["projectId"]
                        .as_str()
                        .context("Observation project")?,
                    target["worktreeId"]
                        .as_str()
                        .context("Observation worktree")?,
                )
                .await?;
            let operation = active.filter(|active| active["workerId"] == worker).map_or(
                Value::Null,
                |active| json!({"id":active["id"],"context":active["context"]}),
            );
            configured.push(json!({"projectId":target["projectId"],"worktreeId":target["worktreeId"],"sourcePath":target["sourcePath"],"worktreePath":target["worktreePath"],"operation":operation}));
        }
        let codegraph=roots.into_iter().map(|target|json!({"projectId":target["projectId"],"worktreeId":target["worktreeId"],"rootKind":target["rootKind"],"sourcePath":target["sourcePath"],"worktreePath":target["worktreePath"]})).collect::<Vec<_>>();
        let result=self.commands.request(worker,json!({"type":"worktree.observation.configure","targets":configured,"codegraphTargets":codegraph}),None,None).await?;
        let result = crate::settings::parse_response(
            "worktreeObservationConfigurationResultSchema",
            result.as_ref(),
        )?;
        let mut requested = HashMap::new();
        for target in configured.iter().chain(&codegraph) {
            requested.insert(
                (
                    target["projectId"].clone().stringify(),
                    target["worktreeId"].clone().stringify(),
                ),
                target,
            );
        }
        let mut paths = Vec::new();
        for resolved in result["paths"]
            .as_array()
            .context("Observation result paths")?
        {
            if let Some(expected) = requested.get(&(
                resolved["projectId"].stringify(),
                resolved["worktreeId"].stringify(),
            )) {
                paths.push(json!({"projectId":resolved["projectId"],"worktreeId":resolved["worktreeId"],"sourcePath":resolved["sourcePath"],"worktreePath":resolved["worktreePath"],"expectedSourcePath":expected["sourcePath"],"expectedWorktreePath":expected["worktreePath"]}));
            }
        }
        if self
            .repository
            .reconcile_observation_paths(owner, worker, &paths)
            .await?
            > 0
        {
            self.schedule_worker(owner.to_owned(), worker.to_owned());
        }
        Ok(())
    }
    pub fn stop(&self) {
        let mut state = self.state.lock().unwrap();
        state.stopped = true;
        state.subscriptions.clear();
        state.codegraph.clear();
        for (_, timer) in state.timers.drain() {
            let _ = timer.cancel.send(());
        }
    }
    pub async fn drained(&self) {
        self.tasks.drain().await;
    }
}
