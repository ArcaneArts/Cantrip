//! A remote desktop viewer shares the guest carrier while owning its capture bindings.
use super::{Group, Guests, State};
use crate::{
    connection::Outbound,
    desktop_inventory::{
        DEADLINE,
        capture::{Capture, Captures, Operation, Operations, Release, Scope, TakeControl},
    },
    encryption::Service,
    metadata::{Abort, Signal},
};
use anyhow::{Context, Result, anyhow, ensure};
use cantrip_wire::Value;
use std::sync::Arc;
use tokio::{
    sync::{mpsc, oneshot},
    time::timeout,
};
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
        let (take, take_requests) = mpsc::channel(1);
        let (ready, result) = oneshot::channel();
        let scope = connection.scope.clone();
        let control = {
            let mut registry = self.registry.lock().unwrap();
            let group = registry.group(&scope.server, execution)?;
            let control = group.control.watch();
            while registry.jobs.try_join_next().is_some() {}
            registry.jobs.spawn(async move {
                group
                    .capture_connection(connection, operations, take_requests, ready)
                    .await;
            });
            control
        };
        result.await.context("Linux desktop capture stopped.")??;
        client.with_control(control, take).open(scope, target).await
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
        mut take_requests: mpsc::Receiver<TakeControl>,
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
        let mut binding = None;
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
            let (exited, done) = Abort::new();
            let capture = async {
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
                    let work = match work {
                        Work::Release(Release::Control(lease)) => {
                            let mut state = self.state.lock().await;
                            self.return_control(&mut state, owner, lease, &mut binding)
                                .await;
                            continue;
                        }
                        work => work,
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
                    if let Work::Capture(Operation::Interaction {
                        key,
                        request,
                        control,
                        ..
                    }) = &work
                    {
                        if !control.is_some_and(|lease| self.control.owns(owner, lease)) {
                            if let Work::Capture(Operation::Interaction { reply, .. }) = work {
                                let _ = reply
                                    .send(Err(anyhow!("The desktop control authority expired.")));
                            }
                            continue;
                        }
                        if request["type"] == "open" {
                            binding = Some(Release::Binding {
                                generation: key.generation,
                                binding: request["binding"].clone(),
                                operation: "interaction.request",
                                reply: None,
                            });
                        }
                    }
                    let usable = match work {
                        Work::Capture(request) => request
                            .execute(&mut carrier.helper, None, &encryption, &outgoing)
                            .await
                            .is_ok(),
                        Work::Release(release) => {
                            timeout(DEADLINE, release.close(&mut carrier.helper))
                                .await
                                .is_ok()
                        }
                    };
                    if !usable || carrier.helper.is_none() {
                        if let Some(carrier) = state.carrier.take() {
                            carrier.close(&self.transport).await;
                        }
                        break;
                    }
                }
                exited.abort(anyhow!("Linux desktop capture stopped."));
            };
            // Takeover must be able to cancel an agent gesture even while a
            // queued video frame is waiting for the same native pipe.
            let control = async {
                loop {
                    let TakeControl {
                        generation,
                        lease,
                        allowed,
                        reply,
                    } = tokio::select! {
                        biased;
                        _ = done.cancelled() => break,
                        _ = stop.cancelled() => break,
                        request = take_requests.recv() => match request {
                            Some(request) => request,
                            None => break,
                        },
                    };
                    let result = async {
                        scope.authorize(&encryption, &outgoing)?;
                        ensure!(
                            !reply.is_closed() && allowed(),
                            "The desktop control authority expired."
                        );
                        self.take_control(owner, lease, generation).await
                    }
                    .await;
                    let _ = reply.send(result);
                }
            };
            tokio::join!(capture, control);
        }
        let mut state = self.state.lock().await;
        if let Some(lease) = self.control.lease(owner) {
            self.return_control(&mut state, owner, lease, &mut binding)
                .await;
        }
        state.owners.remove(&owner);
        if state.owners.is_empty()
            && let Some(carrier) = state.carrier.take()
        {
            carrier.close(&self.transport).await;
        }
    }

    async fn return_control(
        &self,
        state: &mut State,
        owner: Uuid,
        lease: Uuid,
        binding: &mut Option<Release>,
    ) {
        if !self.control.owns(owner, lease) {
            return;
        }
        if let Some(binding) = binding.take()
            && let Some(carrier) = state.carrier.as_mut()
            && (timeout(DEADLINE, binding.close(&mut carrier.helper))
                .await
                .is_err()
                || carrier.helper.is_none())
            && let Some(carrier) = state.carrier.take()
        {
            carrier.close(&self.transport).await;
        }
        self.control.end(owner, lease);
    }
}
