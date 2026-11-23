use super::{Coordinator, Scope, lifecycle::Background};
use crate::{coordination::RelayCoordinator, worker_links::authority::parse_relay_revocation};
use std::sync::Arc;

pub(super) struct Subscription {
    coordination: Arc<dyn RelayCoordinator>,
    token: u64,
}

impl Coordinator {
    pub(crate) fn subscribe_peer_revocations(
        self: &Arc<Self>,
        coordination: Arc<dyn RelayCoordinator>,
    ) {
        let attachments = Arc::downgrade(self);
        let token = coordination.subscribe(Arc::new(move |message| {
            let attachments = attachments.clone();
            Box::pin(async move {
                // The coordination transport excludes this instance's own messages.
                // Its HTTP sign-out already revokes the local direct capabilities.
                if message["kind"] != "worker-link-relay-revoke" {
                    return Ok(());
                }
                let Some(scope) = parse_relay_revocation(&message["scope"]) else {
                    return Ok(());
                };
                let scope = match scope["kind"].as_str() {
                    Some("account-session") => Scope::Session(scope["accountSessionId"].clone()),
                    Some("owner") => Scope::Owner(scope["ownerId"].clone()),
                    _ => return Ok(()),
                };
                let Some(attachments) = attachments.upgrade() else {
                    return Ok(());
                };
                let _background = {
                    let mut state = attachments.state.lock().unwrap();
                    if state.closed {
                        return Ok(());
                    }
                    state.background += 1;
                    Background(attachments.clone())
                };
                attachments.revoke_scope(scope).await;
                Ok(())
            })
        }));
        *self.peer_revocations.lock().unwrap() = Some(Subscription {
            coordination,
            token,
        });
    }
}

impl Drop for Subscription {
    fn drop(&mut self) {
        self.coordination.unsubscribe(self.token);
    }
}
