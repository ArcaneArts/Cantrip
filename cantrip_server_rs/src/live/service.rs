//! Application-live ownership, post-commit publication and session lifetime.
use super::{
    ConnectionContext, Hub, Options, SessionRegistry, Transports, repository::LiveRepository,
};
use crate::{auth::service::Revocation, config::ServerConfig, database::Database, wire::Value};
use anyhow::Result;
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::task::AbortHandle;

pub struct LiveService {
    pub hub: Arc<Hub>,
    pub sessions: Arc<SessionRegistry>,
    pub transports: Arc<Transports>,
    repository: Arc<LiveRepository>,
    publishing: Arc<AtomicBool>,
    validation: AbortHandle,
}
fn invalidation(
    hub: &Hub,
    enabled: &AtomicBool,
    owner: &str,
    resource: &str,
    entity: Option<&str>,
) {
    if !enabled.load(Ordering::Acquire) {
        return;
    }
    if hub
        .publish(Value::from_serialize(&serde_json::json!({
            "ownerId":owner,"scope":{"kind":"current-user"},"resource":resource,
            "action":"invalidated","entityId":entity,"revision":null,"payload":null,
        })))
        .is_err()
    {
        // No payload, credentials, or owner-scoped data in operational logs.
        eprintln!(
            "{}",
            serde_json::json!({"event":"live.publication-failed","resource":resource})
        );
    }
}
impl LiveService {
    pub fn new(database: Arc<Database>, config: &ServerConfig) -> Result<Arc<Self>> {
        Self::with_usage(database, config, None)
    }
    pub fn with_usage(
        database: Arc<Database>,
        config: &ServerConfig,
        usage: Option<super::UsageRecorder>,
    ) -> Result<Arc<Self>> {
        let repository = Arc::new(LiveRepository::new(database)?);
        let hub = Hub::new(Options {
            record_usage: usage,
            ..Options::default()
        })?;
        let publishing = Arc::new(AtomicBool::new(true));
        let weak = Arc::downgrade(&hub);
        let enabled = publishing.clone();
        let sessions = SessionRegistry::new(
            config.account_websocket_limit as usize,
            Arc::new(move |owner, session| {
                if let Some(hub) = weak.upgrade() {
                    invalidation(&hub, &enabled, owner, "account-session", Some(session));
                }
            }),
        );
        let registry = Arc::downgrade(&sessions);
        let repository_for_validation = repository.clone();
        let validation = tokio::spawn(async move {
            let interval = Duration::from_secs(30);
            let mut timer =
                tokio::time::interval_at(tokio::time::Instant::now() + interval, interval);
            timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                timer.tick().await;
                let Some(registry) = registry.upgrade() else {
                    break;
                };
                for (session, owner) in registry.active_sessions() {
                    let registry = Arc::downgrade(&registry);
                    let repository = repository_for_validation.clone();
                    tokio::spawn(async move {
                        if let Ok(false) = repository.session_active(&session, &owner).await
                            && let Some(registry) = registry.upgrade()
                        {
                            registry.close_session(&session, "Session is no longer active");
                        }
                    });
                }
            }
        })
        .abort_handle();
        Ok(Arc::new(Self {
            hub,
            sessions,
            transports: Arc::new(Transports::default()),
            repository,
            publishing,
            validation,
        }))
    }
    pub fn context(&self, owner: String, session: Option<String>) -> ConnectionContext {
        let repository = self.repository.clone();
        let principal = owner.clone();
        let authorize = Arc::new(move |scope| {
            let repository = repository.clone();
            let owner = principal.clone();
            Box::pin(async move { repository.authorize(&owner, &scope).await })
                as futures::future::BoxFuture<'static, Result<bool>>
        });
        let repository = self.repository.clone();
        let principal = owner.clone();
        let session_id = session.clone();
        ConnectionContext {
            owner,
            session,
            authorize,
            active: Some(Arc::new(move || {
                let repository = repository.clone();
                let owner = principal.clone();
                let session = session_id.clone();
                Box::pin(async move {
                    match session {
                        Some(session) if !session.is_empty() => {
                            repository.session_active(&session, &owner).await
                        }
                        _ => Ok(true),
                    }
                })
            })),
        }
    }
    pub fn invalidate(&self, owner: &str, resource: &str, entity: &str) {
        invalidation(&self.hub, &self.publishing, owner, resource, Some(entity));
    }
    pub fn invalidate_resource(&self, owner: &str, resource: &str) {
        invalidation(&self.hub, &self.publishing, owner, resource, None);
    }
    pub fn publish_event(&self, event: Value) -> Result<()> {
        if self.publishing.load(Ordering::Acquire) {
            self.hub.publish(event)?;
        }
        Ok(())
    }
    pub fn publishing_enabled(&self) -> bool {
        self.publishing.load(Ordering::Acquire)
    }
    pub fn revoke(&self, revocation: &Revocation) {
        self.revoke_live(revocation);
        self.close_revoked_sockets(revocation);
    }
    pub fn revoke_live(&self, revocation: &Revocation) {
        match revocation {
            Revocation::Owner(owner) => self.hub.revoke_owner(owner),
            Revocation::Session(session) => self.hub.revoke_optional_session(session.as_deref()),
        };
    }
    pub fn close_revoked_sockets(&self, revocation: &Revocation) {
        match revocation {
            Revocation::Owner(owner) => {
                self.sessions
                    .close_owner(owner, "Account sessions were revoked");
            }
            Revocation::Session(session) => {
                if let Some(session) = session {
                    self.sessions.close_session(session, "Session was revoked");
                }
            }
        }
    }
    pub fn close(&self) {
        self.publishing.store(false, Ordering::Release);
        self.validation.abort();
        self.sessions.close_all("Server is shutting down");
        self.hub.close();
    }
}
impl Drop for LiveService {
    fn drop(&mut self) {
        self.close();
    }
}
