//! Provider-account target selection and legacy sign-out preparation. Request
//! ownership is captured before launching work and never inferred from an ID.
use super::{credential_migrations::MigrationCoordinator, repository::SettingsRepository};
use crate::{
    wire::{self, ValidationError, Value},
    workers::{command_bus::LimitedCommandBus, repository::WorkerRepository},
};
use anyhow::{Context, Result};
use futures::{FutureExt, future::BoxFuture};
use indexmap::IndexSet;
use serde_json::{Value as Json, json};
use std::{
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::sync::Notify;

pub const REAUTH_REQUIRED_MESSAGE: &str =
    "ChatGPT authentication expired. Sign in again to reconnect this provider account.";
#[derive(Debug)]
pub struct ReconnectRequired;
impl std::fmt::Display for ReconnectRequired {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("The original worker must reconnect before this provider account can be signed out globally.")
    }
}
impl std::error::Error for ReconnectRequired {}

/// The source builds this global view from stored account state, including
/// signed-out quota metadata; a worker-local auth result is not authoritative.
pub fn account_auth_status(kind: &str, account: &Value) -> Result<Value, ValidationError> {
    let authenticated = account["credentialState"] == "signed-in";
    let mut status = Value::object([
        ("authenticated", Value::Bool(authenticated)),
        (
            "authMode",
            if authenticated {
                Value::String(kind.into())
            } else {
                Value::Null
            },
        ),
        ("email", Value::Null),
        ("loginPending", Value::Bool(false)),
    ]);
    if let Some(plan) = account.get("planType") {
        status["planType"] = plan.clone();
    }
    let error = match account["credentialState"].as_str() {
        Some("migration-needed") => {
            Some("The original worker must reconnect to migrate this provider account.")
        }
        Some("reauth-required") => Some("This provider account requires sign-in."),
        Some("conflict") => Some("This provider account has a credential identity conflict."),
        Some("signed-out" | "signed-in") => None,
        _ => {
            // An unrecognized state leaves loginError undefined in the source;
            // the actual response schema supplies its default.
            status["weeklyUsage"] = weekly_usage(account)?;
            return wire::parse("codexAuthStatusSchema", Some(&status));
        }
    };
    status["loginError"] = error.map_or(Value::Null, |error| Value::String(error.into()));
    status["weeklyUsage"] = weekly_usage(account)?;
    wire::parse("codexAuthStatusSchema", Some(&status))
}
fn weekly_usage(account: &Value) -> Result<Value, ValidationError> {
    if account.get("weeklyUsageUsedPercent") == Some(&Value::Null) {
        return Ok(Value::Null);
    }
    let mut weekly = Value::object([("resetsAt", Value::Null)]);
    if let Some(used) = account.get("weeklyUsageUsedPercent") {
        weekly["usedPercent"] = used.clone();
    }
    if wire::coercion::truthy(account.get("weeklyUsageResetsAt")) {
        let text = wire::coercion::string(&account["weeklyUsageResetsAt"])
            .map_err(|_| ValidationError::Operation)?;
        let seconds =
            wire::date_milliseconds(&text).map_or(f64::NAN, |ms| (ms as f64 / 1000.0).floor());
        weekly["resetsAt"] = Value::Number(seconds);
    }
    Ok(weekly)
}

pub struct AccountAuthentication {
    repository: SettingsRepository,
    workers: WorkerRepository,
    commands: Arc<LimitedCommandBus>,
    migrations: Arc<MigrationCoordinator>,
    active: AtomicUsize,
    drained: Notify,
}
struct Task(Arc<AccountAuthentication>);
impl Drop for Task {
    fn drop(&mut self) {
        if self.0.active.fetch_sub(1, Ordering::AcqRel) == 1 {
            self.0.drained.notify_waiters();
        }
    }
}
fn text<'a>(value: &'a Json, key: &str) -> Result<&'a str> {
    value[key]
        .as_str()
        .context("stored provider authentication text")
}
impl AccountAuthentication {
    pub fn new(
        repository: SettingsRepository,
        commands: Arc<LimitedCommandBus>,
        migrations: Arc<MigrationCoordinator>,
    ) -> Arc<Self> {
        Arc::new(Self {
            workers: WorkerRepository::new(repository.database.clone()),
            repository,
            commands,
            migrations,
            active: AtomicUsize::new(0),
            drained: Notify::new(),
        })
    }
    pub async fn resolve_target(
        &self,
        owner: &str,
        provider: &str,
        account: Option<&str>,
    ) -> Result<Json> {
        let (provider, runtime, accounts) = tokio::try_join!(
            self.repository.get_model_provider(owner, provider),
            self.repository
                .get_provider_account_runtime(owner, provider, account),
            self.repository.list_provider_accounts(owner, provider)
        )?;
        Self::target(provider, runtime, accounts)
    }
    pub async fn resolve_request_target(
        &self,
        owner: &str,
        provider: &Value,
        account: Option<&Value>,
    ) -> Result<(String, Json)> {
        let provider_text = super::raw_identifiers::text(provider)?;
        let (provider, runtime, accounts) = tokio::try_join!(
            self.repository.provider_input(owner, provider),
            self.repository
                .account_runtime_input(owner, provider, account),
            self.repository
                .list_provider_accounts(owner, &provider_text),
        )?;
        Ok((provider_text, Self::target(provider, runtime, accounts)?))
    }
    fn target(
        provider: Option<Json>,
        runtime: Option<Json>,
        accounts: Option<Vec<Json>>,
    ) -> Result<Json> {
        let summary = runtime.as_ref().and_then(|runtime| {
            accounts
                .as_ref()?
                .iter()
                .find(|account| account["id"] == runtime["accountId"])
        });
        let Some((provider, mut runtime, summary)) = provider
            .zip(runtime.clone())
            .zip(summary)
            .map(|((provider, runtime), summary)| (provider, runtime, summary))
            .filter(|(provider, _, _)| {
                matches!(provider["kind"].as_str(), Some("chatgpt" | "grok"))
            })
        else {
            anyhow::bail!("Provider account not found.")
        };
        runtime["credentialState"] = summary["credentialState"].clone();
        runtime["planType"] = summary["planType"].clone();
        runtime["providerKind"] = provider["kind"].clone();
        runtime["workerBindings"] = summary["workerBindings"].clone();
        Ok(runtime)
    }
    pub async fn runner_available(&self, owner: &str, worker: Option<&str>) -> Result<bool> {
        let Some(worker) = worker.filter(|worker| !worker.is_empty()) else {
            return Ok(false);
        };
        Ok(self.commands.is_connected(worker)
            && self.workers.get_worker(owner, worker).await?.is_some())
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
                .context("Provider authentication task failed.")?
        }
        .boxed()
    }
    pub fn prepare_sign_out(
        self: &Arc<Self>,
        owner: &str,
        provider: &str,
        account: Json,
        requested_worker: Option<&str>,
    ) -> BoxFuture<'static, Result<()>> {
        let (owner, provider, requested) = (
            owner.to_owned(),
            provider.to_owned(),
            requested_worker.map(str::to_owned),
        );
        self.launch(move |service| async move {
            service
                .prepare(&owner, &provider, &account, requested.as_deref())
                .await
        })
    }
    async fn logout_worker(&self, worker: &str, provider: &str, account: &Json) -> Result<()> {
        self.commands
            .request(
                worker,
                Value::from_serialize(&json!({
                    "type":"codex.auth.logout","providerId":provider,
                    "providerAccountId":account["accountId"],"providerKind":account["providerKind"],
                    "credentialHomeKey":account["credentialHomeKey"],
                })),
                Some(Duration::from_secs(15)),
                None,
            )
            .await?;
        Ok(())
    }
    async fn prepare(
        &self,
        owner: &str,
        provider: &str,
        account: &Json,
        requested: Option<&str>,
    ) -> Result<()> {
        let id = text(account, "accountId")?;
        let bindings = account["workerBindings"]
            .as_array()
            .context("stored account worker bindings")?;
        let legacy = bindings
            .iter()
            .filter(|binding| binding["authState"] == "signed-in")
            .map(|binding| text(binding, "workerId"))
            .collect::<Result<Vec<_>>>()?;
        if self
            .repository
            .get_provider_account_credential(owner, provider, id)
            .await?
            .is_some()
        {
            let mut connected = Vec::new();
            for worker in legacy {
                if self.runner_available(owner, Some(worker)).await? {
                    connected.push(worker)
                }
            }
            // A legacy cleanup failure cannot undo an existing portable record.
            futures::future::join_all(
                connected
                    .into_iter()
                    .map(|worker| self.logout_worker(worker, provider, account)),
            )
            .await;
            return Ok(());
        }
        let migration_needed = account["credentialState"] == "migration-needed";
        let candidates: IndexSet<_> = if migration_needed {
            legacy.into_iter().collect()
        } else {
            requested
                .into_iter()
                .chain(legacy)
                .chain(bindings.iter().map(|binding| {
                    binding["workerId"]
                        .as_str()
                        .expect("stored binding worker ID")
                }))
                .filter(|worker| !worker.is_empty())
                .collect()
        };
        let mut runner = None;
        for candidate in candidates {
            if self.runner_available(owner, Some(candidate)).await? {
                runner = Some(candidate);
                break;
            }
        }
        let Some(runner) = runner else {
            if migration_needed {
                return Err(ReconnectRequired.into());
            }
            return Ok(());
        };
        let capture = self
            .migrations
            .capture_account(owner, runner, provider, id)
            .await?;
        if self
            .repository
            .get_provider_account_credential(owner, provider, id)
            .await?
            .is_some()
        {
            if capture.worker_logout_required {
                let _ = self.logout_worker(runner, provider, account).await;
            }
            return Ok(());
        }
        self.logout_worker(runner, provider, account).await
    }
    pub fn mark_reauthentication_required(
        self: &Arc<Self>,
        owner: &str,
        provider: &str,
        account: &str,
    ) -> BoxFuture<'static, Result<bool>> {
        let (owner, provider, account) =
            (owner.to_owned(), provider.to_owned(), account.to_owned());
        self.launch(move |service| async move {
            let Some(credential) = service
                .repository
                .get_provider_account_credential(&owner, &provider, &account)
                .await?
            else {
                return Ok(false);
            };
            if credential["state"] == "reauth-required" {
                return Ok(true);
            }
            if credential["state"] != "signed-in" {
                return Ok(false);
            }
            service
                .repository
                .update_provider_credential_state(
                    &owner,
                    &provider,
                    &account,
                    credential["revision"]
                        .as_f64()
                        .context("stored credential revision")?,
                    "reauth-required",
                )
                .await
        })
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
