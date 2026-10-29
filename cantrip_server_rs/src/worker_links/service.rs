//! Local WorkerLink service composition. Shared-server authority and forwarding
//! belong at this boundary; the local coordinator never delegates to JavaScript.
use super::{Coordinator, Options, ResourceScope, RevocationScope, relay::Relay};
use crate::{
    config::ServerConfig, usage::service::UsageService, wire::Value,
    workers::service::WorkerService,
};
use std::sync::Arc;

pub struct Service {
    pub local: Arc<Coordinator>,
    pub relay: Arc<Relay>,
}
impl Service {
    pub async fn revoke_attachment(
        &self,
        owner: &str,
        kind: &str,
        resource: &str,
        attachment: &str,
    ) -> usize {
        self.local
            .revoke_scope(
                RevocationScope::Resource(Box::new(ResourceScope {
                    owner: Value::String(owner.into()),
                    kind: Value::String(kind.into()),
                    resource: Value::String(resource.into()),
                    attachment: Some(Value::String(attachment.into())),
                })),
                "resource-stopped",
            )
            .await
    }
    pub async fn revoke_resource(
        &self,
        owner: &str,
        kind: &str,
        resource: &str,
        reason: &str,
    ) -> usize {
        self.local
            .revoke_scope(
                RevocationScope::Resource(Box::new(ResourceScope {
                    owner: Value::String(owner.into()),
                    kind: Value::String(kind.into()),
                    resource: Value::String(resource.into()),
                    attachment: None,
                })),
                reason,
            )
            .await
    }
    pub async fn open_peer(&self, session: &str, input: &Value) -> super::Result<Value> {
        let peer = self
            .local
            .open_peer(
                session,
                input["route"].clone(),
                input["routeGeneration"].clone(),
            )
            .await?;
        Ok(
            crate::wire::value::json!({"peerSession": peer, "configuration": self.local.peer_configuration()?}),
        )
    }
    pub fn new(
        server_id: String,
        config: &ServerConfig,
        workers: &Arc<WorkerService>,
        usage: &Arc<UsageService>,
    ) -> Arc<Self> {
        let mut options = Options::new(server_id, workers.control_generation.clone());
        options.peer_configuration = Some(Value::from_serialize(&config.worker_link_peer));
        let local = Coordinator::native(workers.commands.clone(), workers.bridge.clone(), options);
        let surface_quotas = workers.relay_quotas.clone();
        let bandwidth_quotas = workers.relay_quotas.clone();
        let usage = Arc::downgrade(usage);
        let relay = Relay::new(
            workers.bridge.clone(),
            super::relay::Options {
                lane_limits: Value::from_serialize(&config.worker_link_peer.lane_limits),
                acquire_remote_surface: Some(Arc::new(move |owner, worker| {
                    Ok(Box::new(surface_quotas.acquire_surface(
                        owner.as_str().expect("WorkerLink owner identity"),
                        worker.as_str().expect("WorkerLink worker identity"),
                    )?))
                })),
                consume_relay: Some(Arc::new(move |owner, worker, bytes| {
                    bandwidth_quotas.consume_relay_at(
                        owner.as_str().expect("WorkerLink owner identity"),
                        worker.as_str().expect("WorkerLink worker identity"),
                        bytes as u64,
                        chrono::Utc::now().timestamp_millis(),
                    )
                })),
                record: Some(Arc::new(move |owner, channel, ingress, bytes| {
                    if let Some(usage) = usage.upgrade() {
                        usage.record(
                            owner.as_str().expect("WorkerLink owner identity"),
                            channel,
                            ingress,
                            bytes,
                            1,
                            true,
                        );
                    }
                })),
                ..Default::default()
            },
        );
        Arc::new(Self { local, relay })
    }
    pub async fn replace_route(&self, session: &str, route: Value) -> super::Result<Value> {
        let result = self.local.replace_route(session, route).await?;
        self.relay
            .revoke_session(session, "WorkerLink session ended");
        Ok(result)
    }
    pub async fn revoke_session(&self, session: &str, reason: &str) -> bool {
        let revoked = self.local.revoke_session(session, reason).await;
        if revoked {
            self.relay
                .revoke_session(session, "WorkerLink session ended");
        }
        revoked
    }
    pub async fn revoke_account(&self, account: &str) -> usize {
        let account = Value::String(account.into());
        let count = self
            .local
            .revoke_scope(
                RevocationScope::AccountSession(account.clone()),
                "account-session-ended",
            )
            .await;
        self.relay.revoke_account(&account);
        count
    }
    pub async fn revoke_owner(&self, owner: &str) -> usize {
        let owner = Value::String(owner.into());
        let count = self
            .local
            .revoke_scope(
                RevocationScope::Owner(owner.clone()),
                "account-session-ended",
            )
            .await;
        self.relay.revoke_owner(&owner);
        count
    }
    pub async fn close(&self) {
        self.local.stop();
        self.relay.close();
        self.local.close().await;
    }
}
