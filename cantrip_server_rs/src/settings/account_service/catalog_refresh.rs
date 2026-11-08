//! Connection and periodic refreshes settle catalogs before independent quota reads.
use super::AccountService;
use crate::{
    settings::{catalog_runtime::CatalogRequest, endpoint_providers, quota::QuotaContext},
    wire::Value,
    workers::repository::WorkerRepository,
};
use anyhow::Result;
use futures::{future::BoxFuture, future::join_all};
use std::sync::Arc;

impl AccountService {
    pub fn refresh_worker_catalogs(
        self: &Arc<Self>,
        owner: String,
        worker: String,
        trigger: &'static str,
    ) -> BoxFuture<'static, Result<()>> {
        self.launch(move |service| async move {
            let workers = WorkerRepository::new(service.repository.database.clone());
            let (providers, record) = tokio::try_join!(
                service.repository.list_provider_refresh_targets(&owner),
                workers.get_worker(&owner, &worker)
            )?;
            let has_credentials = record.as_ref().is_some_and(|record| {
                record["encryption"]["grants"]
                    .as_array()
                    .is_some_and(|grants| {
                        grants
                            .iter()
                            .any(|grant| grant["component"] == "provider-credential")
                    })
            });
            let providers: Vec<_> = providers
                .into_iter()
                .filter(|provider| {
                    endpoint_providers::worker_endpoint_kind(
                        provider["kind"].as_str().unwrap_or_default(),
                    ) || (has_credentials
                        && matches!(provider["kind"].as_str(), Some("chatgpt" | "grok")))
                })
                .collect();
            // Like Promise.allSettled, one catalog failure does not prevent the
            // other catalogs or the subsequent per-account quota pass.
            join_all(providers.iter().map(|provider| {
                service.catalogs.load(CatalogRequest {
                    owner: owner.clone(),
                    provider: provider["id"].as_str().unwrap_or_default().into(),
                    worker: Some(Value::String(worker.clone().into())),
                    force: false,
                    account: None,
                    quota_trigger: None,
                })
            }))
            .await;
            let mut quotas = Vec::new();
            for provider in &providers {
                if !matches!(provider["kind"].as_str(), Some("chatgpt" | "grok")) {
                    continue;
                }
                for account in provider["accounts"].as_array().into_iter().flatten() {
                    if account["enabled"] != true {
                        continue;
                    }
                    let (service, owner, worker) = (service.clone(), &owner, &worker);
                    quotas.push(async move {
                        let provider_id = provider["id"].as_str().unwrap_or_default();
                        let account_id = account["id"].as_str().unwrap_or_default();
                        let Some(runtime) = service
                            .repository
                            .get_provider_account_runtime(owner, provider_id, Some(account_id))
                            .await?
                        else {
                            return Ok::<_, anyhow::Error>(());
                        };
                        let mut request = Value::from_serialize(provider);
                        request["credentialHomeKey"] =
                            Value::from_serialize(&runtime["credentialHomeKey"]);
                        service
                            .repository
                            .read_and_persist_quota_snapshot(
                                &QuotaContext {
                                    owner,
                                    provider: provider_id,
                                    account: account_id,
                                    worker,
                                    account_plan_type: account["planType"].as_str(),
                                    trigger,
                                    chat: None,
                                    turn: None,
                                    execution_attempt: None,
                                },
                                &service.commands,
                                &request,
                            )
                            .await?;
                        Ok(())
                    });
                }
            }
            join_all(quotas).await;
            Ok(())
        })
    }
}
