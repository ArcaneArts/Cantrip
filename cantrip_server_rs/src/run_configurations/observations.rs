//! Owned worker observations and reconnect reconciliation for durable runtimes.
use super::{Repository, text};
use crate::{
    database::Database,
    live::LiveService,
    projects::coordinator::Coordinator,
    wire::{Value, value::json},
    workers::{
        bridge::{NotificationSubscription, WorkerBridge},
        command_bus::LimitedCommandBus,
        maintenance,
    },
};
use anyhow::Result;
use futures::{FutureExt, future::BoxFuture};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, Weak},
};

pub struct Service {
    repository: Repository,
    bridge: Arc<WorkerBridge>,
    commands: Arc<LimitedCommandBus>,
    live: Weak<LiveService>,
    maintenance: Arc<maintenance::Service>,
    subscriptions: Mutex<Option<HashMap<String, NotificationSubscription>>>,
    tasks: Arc<Coordinator>,
}
fn logged(worker: &str, message: &'static str, result: Result<()>) {
    if let Err(error) = result {
        use crate::operations::logging::{self, LogCall};
        (logging::server_logger())(LogCall::event(
            "warn",
            message,
            json!({"workerId":worker,"err":json!({"message":error.to_string()})}),
        ));
    }
}
impl Service {
    pub fn new(
        database: Arc<Database>,
        bridge: Arc<WorkerBridge>,
        commands: Arc<LimitedCommandBus>,
        live: &Arc<LiveService>,
        maintenance: Arc<maintenance::Service>,
    ) -> Arc<Self> {
        Arc::new(Self {
            repository: Repository::new(database),
            bridge,
            commands,
            live: Arc::downgrade(live),
            maintenance,
            subscriptions: Mutex::new(Some(HashMap::new())),
            tasks: Coordinator::new(Arc::new(|_, _| {})),
        })
    }
    pub fn subscribe(self: &Arc<Self>, worker: &str) {
        let mut state = self.subscriptions.lock().unwrap();
        let Some(subscriptions) = state.as_mut() else {
            return;
        };
        subscriptions.entry(worker.to_owned()).or_insert_with(|| {
            let weak = Arc::downgrade(self);
            let worker = worker.to_owned();
            self.bridge.subscribe_owned_notifications(
                &worker.clone(),
                Arc::new(move |owner, notification| {
                    if notification["type"] != "project.run-configuration-runtime.observed" {
                        return async { Ok(()) }.boxed();
                    }
                    let Some(service) = weak.upgrade() else {
                        return async { Ok(()) }.boxed();
                    };
                    let state = service.subscriptions.lock().unwrap();
                    if state.is_none() {
                        return async { Ok(()) }.boxed();
                    }
                    let retained = service.clone();
                    let worker = worker.clone();
                    service.tasks.own(async move {
                        let result = retained
                            .apply(&owner, &worker, &notification["observation"])
                            .await;
                        logged(&worker, "Could not apply worker notification", result);
                        Ok(())
                    })
                }),
            )
        });
    }
    pub fn worker_connected(self: &Arc<Self>, owner: String, worker: String) {
        let state = self.subscriptions.lock().unwrap();
        if state.is_none() {
            return;
        }
        let retained = self.clone();
        let task = self.tasks.own(async move {
            let result = retained.reconcile(&owner, &worker).await;
            logged(
                &worker,
                "Could not reconcile worker Run configuration runtimes",
                result,
            );
            Ok(())
        });
        tokio::spawn(task);
    }
    async fn apply(&self, owner: &str, worker: &str, observation: &Value) -> Result<()> {
        let Some(applied) = self.repository.observe(owner, worker, observation).await? else {
            return Ok(());
        };
        if applied["applied"] != true {
            return Ok(());
        }
        let runtime = &applied["runtime"];
        if let Some(live) = self.live.upgrade() {
            live.publish_event(json!({"ownerId":owner,"scope":json!({"kind":"project","projectId":runtime["projectId"]}),"resource":"run","action":"invalidated","entityId":runtime["id"],"revision":Value::Null,"payload":Value::Null}))?;
        }
        if let Some(terminal) = runtime["terminalId"].as_str().filter(|id| !id.is_empty()) {
            let status = match text(runtime, "state")? {
                "starting" | "running" | "restarting" | "stopping" => "running",
                "failed" => "failed",
                _ => "exited",
            };
            self.maintenance
                .record_status(owner, terminal, status)
                .await?;
        }
        Ok(())
    }
    async fn reconcile(self: &Arc<Self>, owner: &str, worker: &str) -> Result<()> {
        if !self.bridge.is_connected(worker) {
            return Ok(());
        }
        let identities = self.repository.active_identities(owner, worker).await?;
        let reply=self.commands.request(worker,json!({"type":"project.run-configuration-runtime.reconcile","identities":identities}),None,None).await?;
        let reply = crate::settings::parse_response(
            "runConfigurationRuntimeWorkerReconciliationSchema",
            reply.as_ref(),
        )?;
        let lookups = reply["runtimes"]
            .as_array()
            .expect("validated runtime reconciliation");
        let mut pending: Vec<BoxFuture<'static, Result<()>>> = Vec::new();
        for identity in identities {
            let found = lookups.iter().find(|lookup| {
                let field = if lookup["found"] == true {
                    "observation"
                } else {
                    "identity"
                };
                lookup[field]["runtimeId"] == identity["runtimeId"]
            });
            let matches = found.is_some_and(|lookup| {
                lookup["found"] == true
                    && [
                        "projectId",
                        "configurationId",
                        "worktreeId",
                        "workerId",
                        "definitionRevision",
                        "codexEnvironmentRevision",
                        "generation",
                        "operationId",
                        "terminalId",
                    ]
                    .iter()
                    .all(|key| lookup["observation"][*key] == identity[*key])
            });
            let observation = if matches {
                found.unwrap()["observation"].clone()
            } else {
                let mut observation = identity;
                for (key,value) in json!({"state":"lost","startedAt":Value::Null,"endedAt":crate::auth::iso(crate::auth::now()),"exitCode":Value::Null,"signal":Value::Null,"failure":json!({"phase":"reconcile","code":"process-missing","message":"The Run configuration process was not present after worker reconnect.","retryable":true})}).as_object().unwrap() {
                    observation[key.as_str().expect("literal observation key")]=value.clone();
                }
                crate::settings::parse_response(
                    "runConfigurationRuntimeWorkerObservationSchema",
                    Some(&observation),
                )?
            };
            let retained = self.clone();
            let owner = owner.to_owned();
            let worker = worker.to_owned();
            pending.push(
                self.tasks
                    .own(async move { retained.apply(&owner, &worker, &observation).await }),
            );
        }
        futures::future::try_join_all(pending).await?;
        Ok(())
    }
    pub fn stop(&self) {
        self.subscriptions.lock().unwrap().take();
    }
    pub async fn drained(&self) {
        self.tasks.drain().await;
    }
}
