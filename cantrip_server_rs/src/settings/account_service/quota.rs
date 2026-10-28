//! Authenticated quota requests retain the source's independently committed
//! credits/readings and best-effort reset persistence boundaries.
use super::{AccountService, LifecycleLog};
use crate::{
    settings::{operation_error_message, parse_response, quota::QuotaContext},
    wire::Value,
    workers::repository::WorkerRepository,
};
use anyhow::{Context, Result};
use futures::future::BoxFuture;
use std::{sync::Arc, time::Duration};

pub(crate) const REAUTH_MESSAGE: &str =
    "ChatGPT authentication expired. Sign in again to reconnect this provider account.";

#[derive(Debug)]
pub(crate) struct QuotaAuthenticationUpdateError(pub anyhow::Error);
impl std::fmt::Display for QuotaAuthenticationUpdateError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(formatter)
    }
}
impl std::error::Error for QuotaAuthenticationUpdateError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(self.0.as_ref())
    }
}
impl AccountService {
    pub fn quota_request(
        self: &Arc<Self>,
        owner: &str,
        provider: &str,
        account: &str,
        worker: Value,
        consume: Option<Value>,
    ) -> BoxFuture<'static, Result<Value>> {
        let (owner, provider, account) =
            (owner.to_owned(), provider.to_owned(), account.to_owned());
        self.launch(move |service| async move {
            let result = service
                .run_quota_request(&owner, &provider, &account, worker, consume)
                .await;
            if let Err(error) = &result
                && operation_error_message(error) == REAUTH_MESSAGE.into()
            {
                service
                    .authentication
                    .mark_reauthentication_required(&owner, &provider, &account)
                    .await
                    .map_err(QuotaAuthenticationUpdateError)?;
                service.live.invalidate_resource(&owner, "settings");
            }
            result
        })
    }
    async fn run_quota_request(
        &self,
        owner: &str,
        provider_id: &str,
        account_id: &str,
        worker: Value,
        consume: Option<Value>,
    ) -> Result<Value> {
        let workers = WorkerRepository::new(self.repository.database.clone());
        let (account, provider, stored_worker) = tokio::try_join!(
            self.authentication
                .resolve_target(owner, provider_id, Some(account_id)),
            self.repository.get_model_provider(owner, provider_id),
            workers.get_worker_input(owner, &worker),
        )?;
        let provider = provider
            .filter(|provider| provider["kind"] == "chatgpt")
            .context("Rate-limit reset credits are only available for ChatGPT accounts.")?;
        anyhow::ensure!(stored_worker.is_some(), "Worker not found.");
        // Query arrays and unpaired UTF16 strings cannot alias a bridge Map key,
        // even when the database converted their values to an existing worker ID.
        let worker_id = worker
            .as_str()
            .filter(|id| self.commands.is_connected(id))
            .context("Worker is offline.")?;
        let legacy = account["credentialState"] == "migration-needed"
            && account["workerBindings"]
                .as_array()
                .is_some_and(|bindings| {
                    bindings.iter().any(|binding| {
                        binding["workerId"].as_str() == Some(worker_id)
                            && binding["authState"] == "signed-in"
                    })
                });
        anyhow::ensure!(
            account["credentialState"] == "signed-in" || legacy,
            "ChatGPT account is not signed in."
        );
        let context = QuotaContext {
            owner,
            provider: provider_id,
            account: account["accountId"].as_str().context("account ID")?,
            worker: worker_id,
            account_plan_type: account["planType"].as_str(),
            trigger: if consume.is_some() {
                "reset-credit-consumed"
            } else {
                "reset-credit-status"
            },
            chat: None,
            turn: None,
            execution_attempt: None,
        };
        let mut runtime = Value::from_serialize(&provider);
        runtime["credentialHomeKey"] = Value::from_serialize(&account["credentialHomeKey"]);
        let result = if let Some(consume) = consume {
            let mut command_provider = Value::object([
                ("id", Value::String(provider_id.into())),
                ("protectedApiKey", Value::Null),
                ("accountId", Value::String(context.account.into())),
            ]);
            for key in ["name", "kind", "baseUrl", "credentialHomeKey"] {
                command_provider[key] = runtime[key].clone();
            }
            let mut command = Value::object([
                (
                    "type",
                    Value::String("provider.rate-limit-reset.consume".into()),
                ),
                ("provider", command_provider),
                ("idempotencyKey", consume["idempotencyKey"].clone()),
            ]);
            if let Some(credit) = consume.get("creditId") {
                command["creditId"] = credit.clone();
            }
            let response = self
                .commands
                .request(worker_id, command, Some(Duration::from_secs(120)), None)
                .await?;
            let result = parse_response(
                "providerRateLimitResetConsumeResultSchema",
                response.as_ref(),
            )?;
            if let Some(snapshot) = result
                .get("quotaSnapshot")
                .filter(|snapshot| !snapshot.is_null())
                && self
                    .repository
                    .persist_quota_snapshot(&context, snapshot)
                    .await
                    .is_err()
            {
                LifecycleLog::emit(
                    "warn",
                    Value::object([
                        (
                            "event",
                            Value::String("provider.quota.reset-persist-failed".into()),
                        ),
                        ("providerId", Value::String(provider_id.into())),
                        ("accountId", Value::String(context.account.into())),
                        ("workerId", worker),
                    ]),
                    "ChatGPT usage reset succeeded but its quota snapshot could not be persisted",
                );
            }
            result
        } else {
            self.repository
                .read_and_persist_quota_snapshot(&context, &self.commands, &runtime)
                .await?
                .1
        };
        self.live.invalidate_resource(owner, "settings");
        Ok(result)
    }
}
