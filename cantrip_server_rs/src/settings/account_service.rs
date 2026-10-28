//! Server-owned account operations. A browser disconnect cannot interrupt the
//! admitted sequence between legacy preparation, durable clear and cleanup.
use super::{
    authentication::AccountAuthentication,
    credential_migrations::MigrationCoordinator,
    lifecycle::{LifecycleDiagnostics, LifecycleService, SignOutInput},
    parse_response,
    repository::SettingsRepository,
};
use crate::{live::LiveService, wire::Value, workers::command_bus::LimitedCommandBus};
use anyhow::{Context, Result};
use futures::{FutureExt, future::BoxFuture};
use indexmap::IndexMap;
use serde_json::{Value as Json, json};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicUsize, Ordering},
};
use tokio::sync::Notify;
mod auth_flow;
mod auth_observations;
use auth_flow::AuthObservation;

// Lifecycle only supplies fixed operational fields here. Shared native log
// formatting, rate limiting, buffering and archival remain a separate pending
// integration, as recorded in the server coverage ledger.
struct LifecycleLog;
impl LifecycleLog {
    fn emit(level: &str, context: Value, message: &'static str) {
        eprintln!(
            "{}",
            Value::object([
                ("level", Value::String(level.into())),
                ("message", Value::String(message.into())),
                ("context", context),
            ])
            .stringify()
        );
    }
}
impl LifecycleDiagnostics for LifecycleLog {
    fn info(&self, context: Value, message: &'static str) -> Result<()> {
        Self::emit("info", context, message);
        Ok(())
    }
    fn warn(&self, context: Value, message: &'static str) -> Result<()> {
        Self::emit("warn", context, message);
        Ok(())
    }
}
pub struct AccountService {
    pub authentication: Arc<AccountAuthentication>,
    pub migrations: Arc<MigrationCoordinator>,
    pub lifecycle: Arc<LifecycleService>,
    repository: SettingsRepository,
    live: Arc<LiveService>,
    catalogs: Arc<super::catalog_runtime::CatalogRuntime>,
    commands: Arc<LimitedCommandBus>,
    bridge: Arc<crate::workers::bridge::WorkerBridge>,
    auth_state: Mutex<AuthState>,
    observation_subscriptions:
        Mutex<std::collections::HashMap<String, crate::workers::bridge::NotificationSubscription>>,
    active: AtomicUsize,
    drained: Notify,
}
struct AuthState {
    observations: IndexMap<String, Arc<Mutex<AuthObservation>>>,
    revision: f64,
}
struct Task(Arc<AccountService>);
impl Drop for Task {
    fn drop(&mut self) {
        if self.0.active.fetch_sub(1, Ordering::AcqRel) == 1 {
            self.0.drained.notify_waiters();
        }
    }
}
fn sign_out_input(owner: &str, provider: &str, target: &Json) -> Result<SignOutInput> {
    Ok(SignOutInput {
        owner_id: owner.into(),
        provider_id: provider.into(),
        account_id: target["accountId"].as_str().context("account ID")?.into(),
        credential_home_key: target["credentialHomeKey"]
            .as_str()
            .context("credential home")?
            .into(),
        kind: target["providerKind"]
            .as_str()
            .context("account provider kind")?
            .into(),
    })
}
impl AccountService {
    pub fn new(
        repository: SettingsRepository,
        commands: Arc<LimitedCommandBus>,
        live: Arc<LiveService>,
        catalogs: Arc<super::catalog_runtime::CatalogRuntime>,
        bridge: Arc<crate::workers::bridge::WorkerBridge>,
    ) -> Arc<Self> {
        let migrations = MigrationCoordinator::with_purge_kinds(
            repository.clone(),
            commands.clone(),
            ["chatgpt".to_owned(), "grok".to_owned()].into(),
        );
        let authentication =
            AccountAuthentication::new(repository.clone(), commands.clone(), migrations.clone());
        let invalidator = repository.clone();
        let lifecycle = LifecycleService::new(
            repository.clone(),
            commands.clone(),
            Arc::new(move |input| {
                let repository = invalidator.clone();
                async move {
                    if input.kind == "grok" {
                        repository
                            .mark_grok_account_unavailable(
                                &input.owner_id,
                                &input.provider_id,
                                &input.account_id,
                            )
                            .await
                    } else {
                        repository
                            .mark_chatgpt_account_unavailable(
                                &input.owner_id,
                                &input.provider_id,
                                &input.account_id,
                            )
                            .await
                    }
                }
                .boxed()
            }),
            Arc::new(LifecycleLog),
        );
        Arc::new(Self {
            authentication,
            migrations,
            lifecycle,
            repository,
            live,
            catalogs,
            commands,
            bridge,
            auth_state: Mutex::new(AuthState {
                observations: IndexMap::new(),
                revision: crate::auth::now().timestamp_millis() as f64 * 1000.0,
            }),
            observation_subscriptions: Mutex::new(std::collections::HashMap::new()),
            active: AtomicUsize::new(0),
            drained: Notify::new(),
        })
    }
    fn launch<T, F, Make>(self: &Arc<Self>, make: Make) -> BoxFuture<'static, Result<T>>
    where
        T: Send + 'static,
        F: std::future::Future<Output = Result<T>> + Send + 'static,
        Make: FnOnce(Arc<Self>) -> F + Send + 'static,
    {
        self.active.fetch_add(1, Ordering::AcqRel);
        let service = self.clone();
        let (send, receive) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            let task = Task(service.clone());
            let result = make(service).await;
            let _ = send.send(result);
            drop(task);
        });
        async move {
            receive
                .await
                .context("Provider account operation failed.")?
        }
        .boxed()
    }
    pub fn delete_account(
        self: &Arc<Self>,
        owner: &str,
        provider: &str,
        account: &str,
    ) -> BoxFuture<'static, Result<bool>> {
        let (owner, provider, account) =
            (owner.to_owned(), provider.to_owned(), account.to_owned());
        self.launch(move |service| async move {
            let target = service
                .authentication
                .resolve_target(&owner, &provider, Some(&account))
                .await?;
            service
                .authentication
                .prepare_sign_out(&owner, &provider, target.clone(), None)
                .await?;
            service
                .lifecycle
                .sign_out(sign_out_input(&owner, &provider, &target)?)
                .await?;
            service
                .repository
                .delete_provider_account(&owner, &provider, &account)
                .await
        })
    }
    pub fn create_account(
        self: &Arc<Self>,
        owner: &str,
        provider: &str,
        input: Value,
    ) -> BoxFuture<'static, Result<Option<Json>>> {
        let (owner, provider) = (owner.to_owned(), provider.to_owned());
        self.launch(move |service| async move {
            service
                .repository
                .create_provider_account(&owner, &provider, &input)
                .await
        })
    }
    pub fn update_account(
        self: &Arc<Self>,
        owner: &str,
        provider: &str,
        account: &str,
        input: Value,
    ) -> BoxFuture<'static, Result<Option<Json>>> {
        let (owner, provider, account) =
            (owner.to_owned(), provider.to_owned(), account.to_owned());
        self.launch(move |service| async move {
            service
                .repository
                .update_provider_account(&owner, &provider, &account, &input)
                .await
        })
    }
    pub fn reorder_accounts(
        self: &Arc<Self>,
        owner: &str,
        provider: &str,
        ids: Vec<crate::wire::JsString>,
    ) -> BoxFuture<'static, Result<bool>> {
        let (owner, provider) = (owner.to_owned(), provider.to_owned());
        self.launch(move |service| async move {
            service
                .repository
                .reorder_provider_accounts(&owner, &provider, &ids)
                .await
        })
    }
    pub fn sign_out(
        self: &Arc<Self>,
        owner: &str,
        provider: Value,
        account: Option<Value>,
        worker: Option<Value>,
    ) -> BoxFuture<'static, Result<()>> {
        let owner = owner.to_owned();
        self.launch(move |service| async move {
            let (provider_id, target) = service.authentication.resolve_request_target(&owner, &provider, account.as_ref()).await?;
            service.authentication.prepare_sign_out(&owner, &provider_id, target.clone(), worker.as_ref().and_then(Value::as_str)).await?;
            let input = sign_out_input(&owner, &provider_id, &target)?;
            anyhow::ensure!(service.lifecycle.sign_out(input.clone()).await?.is_some(), "Provider account not found.");
            let published = {
            let mut state = service.auth_state.lock().unwrap();
            Self::remove_observations(&mut state, &owner, &provider, &input.account_id);
            service.publish_status(&owner, Value::object([
                ("providerId", provider),
                ("providerAccountId", Value::String(input.account_id.into())),
                ("providerKind", Value::String(input.kind.into())),
                ("workerId", worker.filter(|value| !value.is_null()).unwrap_or_else(|| Value::String("server".into()))),
                ("observedAt", Value::String(crate::auth::iso(crate::auth::now()).into())),
                ("expiresAt", Value::Null),
                ("status", Value::from_serialize(&json!({"state":"signed-out","authMode":null,"email":null,"planType":null,"weeklyUsage":null,"failureCode":null}))),
            ]), true, &mut state)
            };
            service.sync_observation_subscriptions();
            published?;
            Ok(())
        })
    }
    fn publish_status(
        &self,
        owner: &str,
        mut status: Value,
        invalidate: bool,
        state: &mut AuthState,
    ) -> Result<Value> {
        // The source invalidation/revision/parse/publication sequence is
        // synchronous. The caller retains auth_state through enqueueing, so a later
        // revision cannot reach Live before an earlier one on another thread.
        if invalidate {
            self.live.invalidate_resource(owner, "settings");
        }
        state.revision =
            (state.revision + 1.0).max(crate::auth::now().timestamp_millis() as f64 * 1000.0);
        let revision = state.revision;
        status["revision"] = Value::Number(revision);
        let payload = parse_response("providerAuthLiveStatusSchema", Some(&status))?;
        let live_payload = parse_response("appLiveEventPayloadSchema", Some(&payload))?;
        self.live.publish_event(Value::object([
            ("ownerId", Value::String(owner.into())),
            (
                "scope",
                Value::from_serialize(&json!({"kind":"current-user"})),
            ),
            ("resource", Value::String("provider-auth".into())),
            ("action", Value::String("status".into())),
            ("entityId", payload["providerAccountId"].clone()),
            ("revision", Value::Number(revision)),
            ("payload", live_payload),
        ]))?;
        Ok(payload)
    }
    pub async fn drained(&self) {
        loop {
            let notified = self.drained.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.active.load(Ordering::Acquire) == 0 {
                break;
            }
            notified.await;
        }
        self.authentication.drain().await;
        self.lifecycle.drain().await;
        self.migrations.drain().await;
    }
}
