use super::{Repository, surface_material_changed};
use crate::{
    database::Database,
    live::LiveService,
    wire::Value,
    workers::{bridge::WorkerBridge, command_bus::LimitedCommandBus},
};
use anyhow::{Context, Result};
use std::{
    future::Future,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::{Notify, oneshot};

#[derive(Default)]
struct State {
    stopping: bool,
    active: usize,
}
pub struct Service {
    pub repository: Repository,
    bridge: Arc<WorkerBridge>,
    commands: Arc<LimitedCommandBus>,
    live: Arc<LiveService>,
    server_id: String,
    state: Mutex<State>,
    changed: Notify,
}
struct Admission(Arc<Service>);
impl Drop for Admission {
    fn drop(&mut self) {
        self.0.state.lock().unwrap().active -= 1;
        self.0.changed.notify_waiters();
    }
}
impl Service {
    pub fn new(
        database: Arc<Database>,
        bridge: Arc<WorkerBridge>,
        commands: Arc<LimitedCommandBus>,
        live: Arc<LiveService>,
        server_id: String,
    ) -> Arc<Self> {
        Arc::new(Self {
            repository: Repository::new(database),
            bridge,
            commands,
            live,
            server_id,
            state: Mutex::new(State::default()),
            changed: Notify::new(),
        })
    }
    fn admission(self: &Arc<Self>, child: bool) -> Result<Admission> {
        let mut state = self.state.lock().unwrap();
        anyhow::ensure!(child || !state.stopping, "Worker maintenance is closing");
        state.active += 1;
        Ok(Admission(self.clone()))
    }
    pub async fn owned<T: Send + 'static>(
        self: &Arc<Self>,
        operation: impl Future<Output = Result<T>> + Send + 'static,
    ) -> Result<T> {
        let admission = self.admission(false)?;
        let (send, receive) = oneshot::channel();
        tokio::spawn(async move {
            let _admission = admission;
            let _ = send.send(operation.await);
        });
        receive.await.context("Worker maintenance task ended")?
    }
    pub fn worker_connected(self: &Arc<Self>, owner: Option<String>, worker: String) {
        let Ok(admission) = self.admission(false) else {
            return;
        };
        let service = self.clone();
        tokio::spawn(async move {
            let _admission = admission;
            if service.reconcile(owner.as_deref(), &worker).await.is_err() {
                eprintln!(
                    "{}",
                    Value::object([
                        (
                            "event",
                            Value::String("terminal.services.reconcile-failed".into())
                        ),
                        ("subsystem", Value::String("terminal".into()))
                    ])
                    .stringify()
                );
            }
        });
    }
    pub async fn refresh(
        self: &Arc<Self>,
        owner: &str,
        worker: &str,
        before: &Value,
        input: &Value,
    ) -> Result<Value> {
        let mut command = input.clone();
        command["type"] = Value::String("worker.encryption.refresh".into());
        let result = self
            .commands
            .request(worker, command, Some(Duration::from_secs(20)), None)
            .await?;
        let result = crate::settings::parse_response(
            "workerEncryptionRefreshResultSchema",
            result.as_ref(),
        )?;
        if surface_material_changed(&input["component"], before, &result["status"]) {
            self.reconcile(Some(owner), worker).await?;
        }
        Ok(result)
    }
    async fn reconcile(self: &Arc<Self>, owner: Option<&str>, worker: &str) -> Result<()> {
        if !self.bridge.is_connected(worker) {
            return Ok(());
        }
        let services = self.repository.list(worker, &self.server_id).await?;
        self.commands
            .request(
                worker,
                Value::object([
                    ("type", Value::String("terminal.services.reconcile".into())),
                    ("services", Value::Array(services.clone())),
                ]),
                Some(Duration::from_secs(30)),
                None,
            )
            .await?;
        let mut updates = Vec::new();
        for service in services {
            // Each sibling owns its write even if Promise.all's first rejection
            // has already completed the route or its HTTP receiver disappeared.
            let admission = self.admission(true)?;
            let service_owner = self.clone();
            let owner = owner.map(str::to_owned);
            let terminal = service["terminalId"]
                .as_str()
                .context("Terminal service id")?
                .to_owned();
            updates.push(tokio::spawn(async move {
                let _admission = admission;
                service_owner
                    .repository
                    .set_status(&terminal, "running")
                    .await?;
                // The reference background callback inherits its HTTP owner
                // context. Credential-only account sockets have none: their
                // status writes commit, while the best-effort publication fails.
                if let Some(owner) = owner {
                    service_owner.live.invalidate(&owner, "terminal", &terminal);
                } else {
                    eprintln!(
                        "{}",
                        Value::object([
                            (
                                "event",
                                Value::String("terminal.services.invalidation-unavailable".into())
                            ),
                            ("subsystem", Value::String("terminal".into()))
                        ])
                        .stringify()
                    );
                }
                Ok::<_, anyhow::Error>(())
            }));
        }
        futures::future::try_join_all(
            updates
                .into_iter()
                .map(|update| async move { update.await.context("Terminal status task ended")? }),
        )
        .await?;
        Ok(())
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
}
