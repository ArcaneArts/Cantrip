//! WorkerLink authority and relay composition. The local coordinator owns worker
//! capabilities; the authority routes operations and distributed revocation.
use super::{
    Coordinator, Options,
    authority::{Authority, RelayRevokeSubscription},
    relay::Relay,
};
use crate::{
    config::ServerConfig, coordination::RelayCoordinator, usage::service::UsageService,
    wire::Value, workers::service::WorkerService,
};
use futures::future::BoxFuture;
use std::sync::{Arc, Mutex};
fn text(value: &str) -> Value {
    Value::String(value.into())
}

pub struct Service {
    pub local: Arc<Coordinator>,
    pub authority: Arc<Authority>,
    pub relay: Arc<Relay>,
    relay_revocations: Mutex<Option<RelayRevokeSubscription>>,
}
impl Service {
    pub fn revoke_attachment(
        &self,
        owner: &str,
        kind: &str,
        resource: &str,
        attachment: &str,
    ) -> BoxFuture<'static, super::Result<usize>> {
        self.authority.revoke_attachment(
            text(owner),
            text(kind),
            text(resource),
            text(attachment),
            text("resource-stopped"),
        )
    }
    pub fn revoke_resource(
        &self,
        owner: &str,
        kind: &str,
        resource: &str,
        reason: &str,
    ) -> BoxFuture<'static, super::Result<usize>> {
        self.authority
            .revoke_resource(text(owner), text(kind), text(resource), text(reason))
    }
    pub fn open_peer(
        &self,
        session: &str,
        input: &Value,
    ) -> BoxFuture<'static, super::Result<Value>> {
        self.authority.open_peer(session, input.clone())
    }
    pub fn new(
        server_id: String,
        config: &ServerConfig,
        workers: &Arc<WorkerService>,
        usage: &Arc<UsageService>,
    ) -> Arc<Self> {
        Self::with_coordination(server_id, config, workers, usage, None)
    }
    pub fn with_coordination(
        server_id: String,
        config: &ServerConfig,
        workers: &Arc<WorkerService>,
        usage: &Arc<UsageService>,
        coordination: Option<Arc<dyn RelayCoordinator>>,
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
        Self::compose(local, relay, coordination)
    }
    pub fn compose(
        local: Arc<Coordinator>,
        relay: Arc<Relay>,
        coordination: Option<Arc<dyn RelayCoordinator>>,
    ) -> Arc<Self> {
        let authority = Authority::new(local.clone(), coordination);
        let weak = Arc::downgrade(&relay);
        let subscription = authority.subscribe_relay_revocations(Arc::new(move |scope| {
            if let Some(relay) = weak.upgrade() {
                match scope["kind"].as_str() {
                    Some("session") => {
                        if let Some(session) = scope["sessionId"].as_str() {
                            relay.revoke_session(session, "WorkerLink session ended");
                        }
                    }
                    Some("account-session") => relay.revoke_account(&scope["accountSessionId"]),
                    Some("owner") => relay.revoke_owner(&scope["ownerId"]),
                    _ => {}
                }
            }
            Ok(())
        }));
        Arc::new(Self {
            local,
            authority,
            relay,
            relay_revocations: Mutex::new(Some(subscription)),
        })
    }
    pub fn replace_route(
        &self,
        session: &str,
        route: Value,
    ) -> BoxFuture<'static, super::Result<Value>> {
        self.authority.replace_route(session, route)
    }
    pub fn revoke_session(
        &self,
        session: &str,
        reason: &str,
    ) -> BoxFuture<'static, super::Result<bool>> {
        self.authority.revoke_session(session, reason)
    }
    pub fn revoke_account(&self, account: &str) -> BoxFuture<'static, super::Result<usize>> {
        self.authority.revoke_account(text(account))
    }
    pub fn revoke_owner(&self, owner: &str) -> BoxFuture<'static, super::Result<usize>> {
        self.authority.revoke_owner(text(owner))
    }
    pub async fn close(&self) -> super::Result<()> {
        self.local.stop();
        self.relay_revocations.lock().unwrap().take();
        self.relay.close();
        self.authority.close().await
    }
    pub async fn drained(&self) {
        self.authority.drained().await;
    }
}
