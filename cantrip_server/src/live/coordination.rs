//! App Live fanout uses the same envelopes and hub entry points as Node.
use super::{ExternalPublisher, Hub};
use crate::{coordination::RelayCoordinator, wire::value::json};
use std::sync::Arc;

pub(super) fn publisher(coordinator: Arc<dyn RelayCoordinator>) -> ExternalPublisher {
    Arc::new(move |publication| {
        let coordinator = coordinator.clone();
        Box::pin(async move {
            coordinator
                .publish(
                    json!({"kind":"live-publication","publication":publication}),
                    None,
                )
                .await
        })
    })
}

pub(super) struct Subscription {
    coordinator: Arc<dyn RelayCoordinator>,
    token: u64,
}
impl Subscription {
    pub fn new(coordinator: Arc<dyn RelayCoordinator>, hub: &Arc<Hub>) -> Self {
        let weak = Arc::downgrade(hub);
        let token = coordinator.subscribe(Arc::new(move |message| {
            let weak = weak.clone();
            Box::pin(async move {
                if message["kind"] == "live-publication"
                    && let Some(hub) = weak.upgrade()
                {
                    hub.receive_external(&message["publication"]);
                }
                Ok(())
            })
        }));
        Self { coordinator, token }
    }
}
impl Drop for Subscription {
    fn drop(&mut self) {
        self.coordinator.unsubscribe(self.token);
    }
}
