use super::*;
use std::{
    pin::Pin,
    task::{Context as TaskContext, Poll, Waker},
};
use tokio::sync::{Mutex as Gate, OwnedMutexGuard};

pub(super) type Ticket = Pin<Box<dyn Future<Output = Reservation> + Send>>;
pub(super) struct Reservation {
    lock: Option<OwnedMutexGuard<()>>,
    gate: Arc<Gate<()>>,
    runtime: Weak<Runtime>,
    id: String,
}
impl Drop for Reservation {
    fn drop(&mut self) {
        self.lock.take();
        if let Some(runtime) = self.runtime.upgrade() {
            let mut state = runtime.state.lock().unwrap();
            if Arc::strong_count(&self.gate) == 1
                && state
                    .gates
                    .get(&self.id)
                    .is_some_and(|gate| Weak::ptr_eq(gate, &Arc::downgrade(&self.gate)))
            {
                state.gates.remove(&self.id);
            }
        }
    }
}
fn timestamp(authorization: &Value, key: &str) -> Result<Time> {
    super::super::time(authorization, key)?.with_context(|| format!("Tunnel {key} timestamp"))
}
impl Runtime {
    pub(super) fn reserve(self: &Arc<Self>, id: &str) -> Ticket {
        let _serial = self.serial.lock();
        let gate = {
            let mut state = self.state.lock().unwrap();
            if let Some(gate) = state.gates.get(id).and_then(Weak::upgrade) {
                gate
            } else {
                let gate = Arc::new(Gate::new(()));
                state.gates.insert(id.into(), Arc::downgrade(&gate));
                gate
            }
        };
        // Enqueue before spawning: Tokio task scheduling must not reorder two
        // attaches or an expiry admitted while the first database write waits.
        let mut acquire = Box::pin(gate.clone().lock_owned());
        let ready = match acquire
            .as_mut()
            .poll(&mut TaskContext::from_waker(Waker::noop()))
        {
            Poll::Ready(guard) => Some(guard),
            Poll::Pending => None,
        };
        let (runtime, id) = (Arc::downgrade(self), id.to_owned());
        Box::pin(async move {
            let lock = if let Some(guard) = ready {
                guard
            } else {
                acquire.as_mut().await
            };
            drop(acquire);
            Reservation {
                lock: Some(lock),
                gate,
                runtime,
                id,
            }
        })
    }
    pub(super) async fn activate(
        self: &Arc<Self>,
        active: &Arc<Active>,
        ticket: Ticket,
    ) -> Result<Value> {
        let reservation = ticket.await;
        let result = self.activate_reserved(active).await;
        drop(reservation);
        result?;
        (self.changed)(change(active));
        self.log(
            Event::Activated((self.options.clock)().timestamp_millis() - active.started),
            &active.authorization,
            active.diagnostic.as_ref(),
        );
        let a = &active.authorization;
        let source = crate::wire::JsString::new(
            [
                "desktop:".encode_utf16().collect::<Vec<_>>(),
                a["clientId"]
                    .as_js_string()
                    .context("Tunnel client")?
                    .units()
                    .to_vec(),
                ":".encode_utf16().collect::<Vec<_>>(),
                a["attachmentId"]
                    .as_js_string()
                    .context("Tunnel attachment")?
                    .units()
                    .to_vec(),
            ]
            .concat(),
        );
        Ok(
            json!({"type":"ready","attachmentId":a["attachmentId"],"tunnelId":a["tunnelId"],"sourceEndpointId":source,"destinationEndpointId":format!("worker:{}",text(&a["destination"],"workerId")?),"expiresAt":a["expiresAt"]}),
        )
    }
    async fn activate_reserved(&self, active: &Arc<Active>) -> Result<()> {
        let a = &active.authorization;
        {
            let _serial = self.serial.lock();
            let current = self
                .state
                .lock()
                .unwrap()
                .active
                .get(a["attachmentId"].as_str().context("Tunnel attachment")?)
                .cloned();
            if !current.as_ref().is_some_and(|v| Arc::ptr_eq(v, active))
                || active.endpoint.socket.state() != 1
            {
                self.close_exact(active, "Attachment disconnected while activating", 1012);
                bail!(activation_error(current.as_ref(), active));
            }
        }
        let activated = self
            .repository
            .activate_attachment(
                &text(a, "attachmentId")?,
                &text(a, "clientId")?,
                timestamp(a, "secretExpiresAt")?,
            )
            .await;
        let activated = match activated {
            Ok(Some(at)) => at,
            Ok(None) => {
                self.close_exact(active, "Attachment is stale", 1008);
                bail!("Tunnel attachment is stale or expired.");
            }
            Err(error) => {
                self.close_exact(active, "Could not activate attachment", 1011);
                return Err(error);
            }
        };
        let outcome = {
            let _serial = self.serial.lock();
            active.state.lock().unwrap().activated_at = Some(activated);
            let current = self
                .state
                .lock()
                .unwrap()
                .active
                .get(a["attachmentId"].as_str().context("Tunnel attachment")?)
                .cloned();
            if !current.as_ref().is_some_and(|v| Arc::ptr_eq(v, active))
                || active.endpoint.socket.state() != 1
            {
                self.close_exact(active, "Attachment disconnected while activating", 1012);
                Some((
                    current.as_ref().is_none_or(|v| Arc::ptr_eq(v, active)),
                    activation_error(current.as_ref(), active),
                ))
            } else if !active.endpoint.activate() {
                self.close_exact(active, "Attachment disconnected while activating", 1012);
                Some((true, "Tunnel attachment disconnected while activating."))
            } else {
                active.state.lock().unwrap().activated = true;
                None
            }
        };
        if let Some((offline, error)) = outcome {
            if offline {
                self.offline(active).await?;
            }
            bail!(error);
        }
        Ok(())
    }
    pub(super) async fn offline(&self, active: &Active) -> Result<()> {
        let activated = active.state.lock().unwrap().activated_at;
        if let Some(activated) = activated {
            let a = &active.authorization;
            if self
                .repository
                .mark_offline(
                    &text(a, "attachmentId")?,
                    timestamp(a, "secretExpiresAt")?,
                    activated,
                )
                .await?
            {
                (self.changed)(change(active));
            }
        }
        Ok(())
    }
    pub(super) async fn expire(&self, active: &Active, ticket: Ticket) -> Result<()> {
        let _reservation = ticket.await;
        let a = &active.authorization;
        let fence = StopFence {
            activated: active.state.lock().unwrap().activated_at,
            expires: Some(timestamp(a, "expiresAt")?),
            secret_expires: Some(timestamp(a, "secretExpiresAt")?),
        };
        if self
            .repository
            .stop_attachment(
                &text(a, "ownerId")?,
                &text(a, "attachmentId")?,
                Some("attachment-expired"),
                false,
                Some(fence),
            )
            .await?
            .is_some()
        {
            (self.changed)(change(active));
        }
        Ok(())
    }
}
fn activation_error(current: Option<&Arc<Active>>, active: &Arc<Active>) -> &'static str {
    if current.is_some_and(|v| !Arc::ptr_eq(v, active)) {
        "Tunnel attachment was replaced while activating."
    } else {
        "Tunnel attachment disconnected while activating."
    }
}
