//! Server-authoritative sign-out. The committed credential clear precedes all
//! remote cleanup; admitted work survives a disconnected caller.
use super::repository::SettingsRepository;
use crate::{
    wire::Value,
    workers::{command_bus::LimitedCommandBus, repository::WorkerRepository},
};
use anyhow::{Context, Result};
use futures::{
    FutureExt,
    future::{BoxFuture, join_all},
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::sync::Notify;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignOutInput {
    pub account_id: String,
    pub credential_home_key: String,
    pub kind: String,
    pub owner_id: String,
    pub provider_id: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignOutSummary {
    pub catalog_invalidated: bool,
    pub credential_cleared: bool,
    pub revocation: &'static str,
    pub workers_closed: usize,
    pub workers_failed: usize,
}
pub trait LifecycleDiagnostics: Send + Sync {
    /// The source logger's info callback is optional.
    fn info(&self, _context: Value, _message: &'static str) -> Result<()> {
        Ok(())
    }
    fn warn(&self, context: Value, message: &'static str) -> Result<()>;
}
pub type CatalogInvalidator =
    Arc<dyn Fn(SignOutInput) -> BoxFuture<'static, Result<()>> + Send + Sync>;
pub type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;
pub struct LifecycleService {
    repository: SettingsRepository,
    commands: Arc<LimitedCommandBus>,
    invalidate: CatalogInvalidator,
    diagnostics: Arc<dyn LifecycleDiagnostics>,
    clock: Clock,
    active: AtomicUsize,
    drained: Notify,
}
struct Task(Arc<LifecycleService>);
impl Drop for Task {
    fn drop(&mut self) {
        if self.0.active.fetch_sub(1, Ordering::AcqRel) == 1 {
            self.0.drained.notify_waiters();
        }
    }
}
impl LifecycleService {
    pub fn new(
        repository: SettingsRepository,
        commands: Arc<LimitedCommandBus>,
        invalidate: CatalogInvalidator,
        diagnostics: Arc<dyn LifecycleDiagnostics>,
    ) -> Arc<Self> {
        Self::with_clock(
            repository,
            commands,
            invalidate,
            diagnostics,
            Arc::new(|| crate::auth::now().timestamp_millis()),
        )
    }
    pub fn with_clock(
        repository: SettingsRepository,
        commands: Arc<LimitedCommandBus>,
        invalidate: CatalogInvalidator,
        diagnostics: Arc<dyn LifecycleDiagnostics>,
        clock: Clock,
    ) -> Arc<Self> {
        Arc::new(Self {
            repository,
            commands,
            invalidate,
            diagnostics,
            clock,
            active: AtomicUsize::new(0),
            drained: Notify::new(),
        })
    }
    pub fn sign_out(
        self: &Arc<Self>,
        input: SignOutInput,
    ) -> BoxFuture<'static, Result<Option<SignOutSummary>>> {
        self.active.fetch_add(1, Ordering::AcqRel);
        let service = Arc::clone(self);
        let (send, receive) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            let task = Task(service);
            let result = task.0.run(input).await;
            let _ = send.send(result);
        });
        async move {
            receive
                .await
                .context("Provider account sign-out task failed.")?
        }
        .boxed()
    }
    async fn run(&self, input: SignOutInput) -> Result<Option<SignOutSummary>> {
        let started = (self.clock)();
        self.diagnostics.info(Value::from_serialize(&json!({"event":"provider.account.sign_out_started","subsystem":"provider-auth","operation":"sign-out","status":"started","accountId":input.account_id,"providerId":input.provider_id})),"Provider account sign-out started")?;
        if self
            .repository
            .take_provider_credential_for_sign_out(
                &input.owner_id,
                &input.provider_id,
                &input.account_id,
                None,
            )
            .await?
            .is_none()
        {
            return Ok(None);
        }
        let workers = WorkerRepository::new(self.repository.database.clone())
            .list_workers(&input.owner_id)
            .await?;
        let connected = workers
            .iter()
            .map(|worker| {
                worker["workerId"]
                    .as_str()
                    .context("stored lifecycle worker ID")
            })
            .collect::<Result<Vec<_>>>()?
            .into_iter()
            .filter(|worker| self.commands.is_connected(worker))
            .collect::<Vec<_>>();
        let catalog = (self.invalidate)(input.clone());
        let requests=connected.into_iter().map(|worker|self.commands.request(worker,Value::from_serialize(&json!({"type":"provider.auth.account.clear","providerId":input.provider_id,"providerKind":input.kind,"providerAccountId":input.account_id,"credentialHomeKey":input.credential_home_key})),Some(Duration::from_secs(15)),None));
        let (catalog, workers) = tokio::join!(catalog, join_all(requests));
        let workers_failed = workers.iter().filter(|worker| worker.is_err()).count();
        let summary = SignOutSummary {
            catalog_invalidated: catalog.is_ok(),
            credential_cleared: true,
            revocation: "not-applicable",
            workers_closed: workers.len() - workers_failed,
            workers_failed,
        };
        if !summary.catalog_invalidated || summary.workers_failed > 0 {
            self.diagnostics.warn(Value::from_serialize(&json!({"accountId":input.account_id,"catalogInvalidated":summary.catalog_invalidated,"providerId":input.provider_id,"revocation":summary.revocation,"workersFailed":summary.workers_failed})),"Provider account sign-out completed with cleanup warnings")?;
        }
        self.diagnostics.info(Value::from_serialize(&json!({"event":"provider.account.sign_out_completed","subsystem":"provider-auth","operation":"sign-out","status":if !summary.catalog_invalidated || workers_failed>0{"degraded"}else{"completed"},"accountId":input.account_id,"providerId":input.provider_id,"durationMs":(self.clock)()-started,"counts":{"workersClosed":summary.workers_closed,"workersFailed":summary.workers_failed},"catalogInvalidated":summary.catalog_invalidated,"credentialRevocation":summary.revocation})),"Provider account sign-out completed")?;
        Ok(Some(summary))
    }
    pub async fn drain(&self) {
        loop {
            let notified = self.drained.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.active.load(Ordering::Acquire) == 0 {
                return;
            }
            notified.await;
        }
    }
}
