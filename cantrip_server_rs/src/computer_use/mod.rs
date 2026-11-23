//! Computer-use publication ordering and owner-scoped opaque activity writes.
mod activity;
pub mod publications;
use crate::{
    agent_interactions,
    chats::live_mutations,
    database::{Database, Executor},
    wire::{self, Value},
    workers::{bridge::NotificationSubscription, maintenance, transport::WorkerTransport},
};
pub use activity::Activity;
use anyhow::{Result, bail};
use futures::{FutureExt, future::BoxFuture};
use publications::{Publications, Scope};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

pub struct Service {
    pub publications: Arc<Publications>,
    pub mutations: Arc<live_mutations::Service>,
    database: Arc<Database>,
    tasks: Arc<maintenance::Service>,
    bridge: Arc<dyn WorkerTransport>,
    subscriptions: Mutex<HashMap<String, NotificationSubscription>>,
}
impl Service {
    pub fn new(
        database: Arc<Database>,
        mutations: Arc<live_mutations::Service>,
        tasks: Arc<maintenance::Service>,
        bridge: Arc<dyn WorkerTransport>,
    ) -> Arc<Self> {
        Arc::new(Self {
            publications: Default::default(),
            mutations,
            database,
            tasks,
            bridge,
            subscriptions: Default::default(),
        })
    }
    pub fn publish_approval(
        &self,
        scope: Scope,
        request: Value,
    ) -> Result<BoxFuture<'static, Result<Value>>> {
        let guard = self
            .publications
            .insert(scope.clone(), text(&request["requestKey"])?.into())?;
        let mutations = self.mutations.clone();
        // Both the insert and its fence survive a command timeout or dropped waiter.
        Ok(self.tasks.admit_owned(async move {
            let _guard = guard;
            mutations.record_interaction(&scope.0, &request, true).await
        }))
    }
    pub fn subscribe(self: &Arc<Self>, worker: &str) {
        let mut subscriptions = self.subscriptions.lock().unwrap();
        if subscriptions.contains_key(worker) {
            return;
        }
        let (weak, id) = (Arc::downgrade(self), worker.to_owned());
        let subscription = self.bridge.subscribe_owned_notifications(
            worker,
            Arc::new(move |owner, event| {
                let (weak, id) = (weak.clone(), id.clone());
                async move {
                    let Some(service) = weak.upgrade() else {
                        return Ok(());
                    };
                    if event["type"] != "computer-use.approval.terminal" {
                        return Ok(());
                    }
                    let Ok(terminal) = wire::parse("cuaApprovalTerminalSchema", Some(&event))
                    else {
                        return Ok(());
                    };
                    let scope = (
                        owner.clone(),
                        id.clone(),
                        text(&terminal["chatId"])?.to_owned(),
                    );
                    let commands = service.publications.wait_commands(&scope);
                    let retained = service.clone();
                    service
                        .tasks
                        .owned(
                            async move { retained.terminal(&owner, &id, &event, commands).await },
                        )
                        .await
                }
                .boxed()
            }),
        );
        subscriptions.insert(worker.into(), subscription);
    }
    async fn terminal(
        &self,
        owner: &str,
        worker: &str,
        event: &Value,
        commands: BoxFuture<'static, ()>,
    ) -> Result<()> {
        let Ok(terminal) = wire::parse("cuaApprovalTerminalSchema", Some(event)) else {
            return Ok(());
        };
        let result: Result<()> = async {
            let chat = text(&terminal["chatId"])?;
            let key = text(&terminal["requestKey"])?;
            let scope = (owner.into(), worker.into(), chat.into());
            commands.await;
            self.publications.wait_insert(scope, key.into()).await;
            let repository =
                agent_interactions::Repository::new(Executor::Database(&self.database));
            let existing = repository.get_by_key(owner, key).await?;
            let Some(existing) = existing.filter(|row| {
                row["provenance"]["owner"] == "computer-use"
                    && row["requestKey"] == key
                    && row["provenance"]["chatId"] == chat
                    && row["provenance"]["workerId"] == worker
            }) else {
                return Ok(());
            };
            self.mutations
                .terminalize_interaction(
                    owner,
                    text(&existing["requestKey"])?,
                    chat,
                    worker,
                    text(&terminal["status"])?,
                    None,
                )
                .await?;
            Ok(())
        }
        .await;
        if result.is_err() {
            bail!("Computer-use approval terminal state could not be applied.");
        }
        Ok(())
    }
}
pub(crate) fn text(value: &Value) -> Result<&str> {
    value
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("Computer-use identity"))
}
