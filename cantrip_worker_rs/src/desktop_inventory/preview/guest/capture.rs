//! A remote desktop viewer shares the guest carrier while owning its capture bindings.
use super::{Group, Guests};
use crate::{
    connection::Outbound,
    desktop_inventory::{
        DEADLINE,
        capture::{Capture, Captures, Operation, Operations, Release, Scope},
    },
    encryption::Service,
    metadata::Signal,
};
use anyhow::{Context, Result};
use cantrip_wire::Value;
use std::sync::Arc;
use tokio::{sync::oneshot, time::timeout};
use uuid::Uuid;

pub(in crate::desktop_inventory::preview) struct CaptureConnection {
    pub(in crate::desktop_inventory::preview) scope: Scope,
    pub(in crate::desktop_inventory::preview) generation: String,
    pub(in crate::desktop_inventory::preview) encryption: Arc<Service>,
    pub(in crate::desktop_inventory::preview) outgoing: Arc<Outbound>,
    pub(in crate::desktop_inventory::preview) stop: Signal,
}

impl Guests {
    pub(in crate::desktop_inventory::preview) async fn capture(
        &self,
        connection: CaptureConnection,
        execution: &Value,
        target: Value,
    ) -> Result<Capture> {
        let (client, operations) = Captures::channel();
        let (ready, result) = oneshot::channel();
        let scope = connection.scope.clone();
        {
            let mut registry = self.registry.lock().unwrap();
            let group = registry.group(&scope.server, execution)?;
            while registry.jobs.try_join_next().is_some() {}
            registry.jobs.spawn(async move {
                group
                    .capture_connection(connection, operations, ready)
                    .await;
            });
        }
        result.await.context("Linux desktop capture stopped.")??;
        client.open(scope, target).await
    }
}

enum Work {
    Capture(Operation),
    Release(Release),
}

impl Group {
    async fn capture_connection(
        &self,
        connection: CaptureConnection,
        mut operations: Operations,
        ready: oneshot::Sender<Result<()>>,
    ) {
        let owner = Uuid::new_v4();
        let CaptureConnection {
            scope,
            generation,
            encryption,
            outgoing,
            stop,
        } = connection;
        let mut epoch = outgoing.stream_epoch();
        let connected = async {
            let mut state = self.state.lock().await;
            scope.authorize(&encryption, &outgoing)?;
            let context = self.open_context(&stop, Some(&generation)).await?;
            scope.authorize(&encryption, &outgoing)?;
            self.install_context(&mut state, context, &stop).await?;
            state.owners.insert(owner);
            Ok(())
        }
        .await;
        if connected.is_err() {
            let _ = ready.send(connected);
            return;
        }
        if ready.send(Ok(())).is_ok() {
            loop {
                let work = tokio::select! {
                    biased;
                    _ = stop.cancelled() => break,
                    _ = epoch.wait_for(|current| *current != scope.epoch) => break,
                    Some(release) = operations.releases.recv() => Work::Release(release),
                    request = operations.requests.recv() => match request {
                        Some(request) => Work::Capture(request),
                        None => break,
                    },
                };
                let mut state = self.state.lock().await;
                let Some(carrier) = state.carrier.as_mut() else {
                    break;
                };
                // A preview can adopt a new desktop after the old one retires.
                // An already admitted viewer remains pinned to its original generation.
                if carrier.context["desktop_generation"] != generation {
                    break;
                }
                let usable = match work {
                    Work::Capture(request) => request
                        .execute(&mut carrier.helper, None, &encryption, &outgoing)
                        .await
                        .is_ok(),
                    Work::Release(release) => timeout(DEADLINE, release.close(&mut carrier.helper))
                        .await
                        .is_ok(),
                };
                if !usable || carrier.helper.is_none() {
                    if let Some(carrier) = state.carrier.take() {
                        carrier.close(&self.transport).await;
                    }
                    break;
                }
            }
        }
        let mut state = self.state.lock().await;
        state.owners.remove(&owner);
        if state.owners.is_empty()
            && let Some(carrier) = state.carrier.take()
        {
            carrier.close(&self.transport).await;
        }
    }
}
