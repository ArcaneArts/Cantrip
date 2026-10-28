//! Legacy OAuth capture remains opaque. Candidate failures produce counters,
//! never worker payloads, diagnostic strings or secret-bearing log records.
use super::{accounts::CredentialConflict, parse_response, repository::SettingsRepository};
use crate::{wire::Value as WireValue, workers::command_bus::LimitedCommandBus};
use anyhow::{Context, Result};
use futures::{FutureExt, future::BoxFuture};
use serde::Serialize;
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::sync::Notify;

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationSummary {
    pub already_captured: u64,
    pub captured: u64,
    pub checked: u64,
    pub conflicts: u64,
    pub failed: u64,
    pub malformed: u64,
    pub missing: u64,
    pub purged: u64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountCaptureSummary {
    #[serde(flatten)]
    pub migration: MigrationSummary,
    pub worker_logout_required: bool,
}
pub struct MigrationCoordinator {
    repository: SettingsRepository,
    commands: Arc<LimitedCommandBus>,
    purge_enabled: HashSet<String>,
    active: AtomicUsize,
    drained: Notify,
}
struct Task(Arc<MigrationCoordinator>);
impl Drop for Task {
    fn drop(&mut self) {
        if self.0.active.fetch_sub(1, Ordering::AcqRel) == 1 {
            self.0.drained.notify_waiters();
        }
    }
}
fn text<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value[key]
        .as_str()
        .context("stored credential migration text")
}
fn revision(value: &Value) -> Result<f64> {
    value["revision"]
        .as_f64()
        .context("stored credential migration revision")
}
impl MigrationCoordinator {
    pub fn new(repository: SettingsRepository, commands: Arc<LimitedCommandBus>) -> Arc<Self> {
        Self::with_purge_kinds(repository, commands, HashSet::new())
    }
    pub fn with_purge_kinds(
        repository: SettingsRepository,
        commands: Arc<LimitedCommandBus>,
        purge_enabled: HashSet<String>,
    ) -> Arc<Self> {
        Arc::new(Self {
            repository,
            commands,
            purge_enabled,
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
        let service = Arc::clone(self);
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
                .context("Provider credential migration task failed.")?
        }
        .boxed()
    }
    pub fn migrate_worker(
        self: &Arc<Self>,
        owner: &str,
        worker: &str,
    ) -> BoxFuture<'static, Result<MigrationSummary>> {
        let (owner, worker) = (owner.to_owned(), worker.to_owned());
        self.launch(move |service| async move { service.run_worker(&owner, &worker).await })
    }
    pub fn capture_account(
        self: &Arc<Self>,
        owner: &str,
        worker: &str,
        provider: &str,
        account: &str,
    ) -> BoxFuture<'static, Result<AccountCaptureSummary>> {
        let (owner, worker, provider, account) = (
            owner.to_owned(),
            worker.to_owned(),
            provider.to_owned(),
            account.to_owned(),
        );
        self.launch(move |service| async move {
            service
                .run_account(&owner, &worker, &provider, &account)
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
    async fn run_worker(&self, owner: &str, worker: &str) -> Result<MigrationSummary> {
        let mut summary = MigrationSummary::default();
        let candidates = self
            .repository
            .list_provider_credential_migrations(owner)
            .await?;
        for candidate in candidates {
            summary.checked += 1;
            if self
                .migrate_candidate(owner, worker, &candidate, &mut summary)
                .await
                .is_err()
            {
                summary.failed += 1;
            }
        }
        Ok(summary)
    }
    async fn run_account(
        &self,
        owner: &str,
        worker: &str,
        provider: &str,
        account: &str,
    ) -> Result<AccountCaptureSummary> {
        let mut summary = MigrationSummary::default();
        let Some(candidate) = self
            .repository
            .get_provider_credential_migration(owner, provider, account)
            .await?
        else {
            summary.failed = 1;
            return Ok(AccountCaptureSummary {
                migration: summary,
                worker_logout_required: false,
            });
        };
        summary.checked = 1;
        let worker_logout_required = match self
            .migrate_candidate(owner, worker, &candidate, &mut summary)
            .await
        {
            Ok(portable) => portable == Some(false),
            Err(_) => {
                summary.failed = 1;
                false
            }
        };
        Ok(AccountCaptureSummary {
            migration: summary,
            worker_logout_required,
        })
    }
    async fn migrate_candidate(
        &self,
        owner: &str,
        worker: &str,
        candidate: &Value,
        summary: &mut MigrationSummary,
    ) -> Result<Option<bool>> {
        let provider = text(candidate, "providerId")?;
        let account = text(candidate, "accountId")?;
        let captured=self.commands.request(worker,WireValue::from_serialize(&json!({"type":"provider.auth.legacy.capture","providerId":provider,"providerKind":candidate["providerKind"],"providerAccountId":account,"credentialHomeKey":candidate["credentialHomeKey"]})),Some(Duration::from_secs(15)),None).await?;
        let captured = parse_response(
            "providerLegacyCredentialCaptureResultSchema",
            captured.as_ref(),
        )?;
        if captured["status"] == "missing" {
            summary.missing += 1;
            return Ok(None);
        }
        if captured["status"] == "malformed" {
            summary.malformed += 1;
            return Ok(None);
        }
        let subject = &captured["credential"]["subjectBlindIndex"];
        let stored = if candidate["state"] == "signed-in" {
            let stored = self
                .repository
                .get_provider_account_credential(owner, provider, account)
                .await?
                .context("Provider account migration target vanished.")?;
            if WireValue::from_serialize(&stored["credential"]["subjectBlindIndex"]) != *subject {
                self.mark_conflict(owner, candidate, revision(&stored)?)
                    .await?;
                summary.conflicts += 1;
                return Ok(None);
            }
            anyhow::ensure!(
                stored["state"] == "signed-in",
                "Provider account migration state changed."
            );
            summary.already_captured += 1;
            stored
        } else {
            let metadata: Value = serde_json::from_str(&captured["metadata"].stringify())?;
            let stored = match self
                .repository
                .store_provider_account_credential(
                    owner,
                    provider,
                    account,
                    &captured["credential"],
                    &metadata,
                    Some(revision(candidate)?),
                )
                .await
            {
                Ok(stored) => stored.context("Provider account migration target vanished.")?,
                Err(error) if error.is::<CredentialConflict>() => {
                    let stored = self
                        .repository
                        .get_provider_account_credential(owner, provider, account)
                        .await?
                        .context("Provider account migration target vanished.")?;
                    if WireValue::from_serialize(&stored["credential"]["subjectBlindIndex"])
                        != *subject
                    {
                        self.mark_conflict(owner, candidate, revision(&stored)?)
                            .await?;
                        summary.conflicts += 1;
                        return Ok(None);
                    }
                    anyhow::ensure!(
                        stored["state"] == "signed-in",
                        "Provider account migration state changed."
                    );
                    stored
                }
                Err(error) => return Err(error),
            };
            summary.captured += 1;
            stored
        };
        let portable = captured["portableAuth"]
            .as_bool()
            .expect("validated portable auth flag");
        if !portable
            || !self
                .purge_enabled
                .contains(text(candidate, "providerKind")?)
        {
            return Ok(Some(portable));
        }
        let purge=self.commands.request(worker,WireValue::from_serialize(&json!({"type":"provider.auth.legacy.purge","providerId":provider,"providerKind":candidate["providerKind"],"providerAccountId":account,"credentialHomeKey":candidate["credentialHomeKey"],"expectedSubjectBlindIndex":subject,"serverCredentialRevision":stored["revision"]})),Some(Duration::from_secs(15)),None).await?;
        let purge = parse_response("providerLegacyCredentialPurgeResultSchema", purge.as_ref())?;
        anyhow::ensure!(
            purge["subjectBlindIndex"] == *subject
                && purge["serverCredentialRevision"]
                    == WireValue::from_serialize(&stored["revision"]),
            "Worker returned an invalid credential purge acknowledgement."
        );
        if purge["purged"] == true {
            summary.purged += 1;
        }
        Ok(Some(portable))
    }
    async fn mark_conflict(
        &self,
        owner: &str,
        candidate: &Value,
        current_revision: f64,
    ) -> Result<()> {
        let provider = text(candidate, "providerId")?;
        let account = text(candidate, "accountId")?;
        if self
            .repository
            .update_provider_credential_state(
                owner,
                provider,
                account,
                current_revision,
                "conflict",
            )
            .await?
        {
            return Ok(());
        }
        let latest = self
            .repository
            .get_provider_account_credential(owner, provider, account)
            .await?
            .context("Provider account migration target vanished.")?;
        if latest["state"] == "conflict" {
            return Ok(());
        }
        anyhow::ensure!(
            self.repository
                .update_provider_credential_state(
                    owner,
                    provider,
                    account,
                    revision(&latest)?,
                    "conflict"
                )
                .await?,
            "Provider account migration state changed."
        );
        Ok(())
    }
}
