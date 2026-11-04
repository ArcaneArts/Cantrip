//! Global provider mutations retain the complete admitted operation, including
//! account cleanup and catalog work, when the HTTP caller disconnects.
use super::{AccountService, LifecycleLog, sign_out_input};
use crate::{settings::catalog_runtime::CatalogRequest, wire::Value};
use anyhow::{Context, Result};
use futures::future::BoxFuture;
use serde_json::Value as Json;
use std::sync::Arc;

const MODELS_FIRST: &str = "Delete the provider's models before deleting the provider.";

fn catalog(owner: &str, provider: &str, force: bool) -> CatalogRequest {
    CatalogRequest {
        owner: owner.into(),
        provider: provider.into(),
        worker: None,
        force,
        account: None,
        quota_trigger: None,
    }
}

impl AccountService {
    pub fn settings_bundle(self: &Arc<Self>, owner: &str) -> BoxFuture<'static, Result<Json>> {
        let owner = owner.to_owned();
        self.launch(move |service| async move {
            service
                .repository
                .reconcile_zai_owner_providers(&owner)
                .await?;
            let settings = service.repository.get_settings(&owner).await?;
            for provider in settings["providers"]
                .as_array()
                .context("stored providers")?
            {
                if matches!(
                    provider["kind"].as_str(),
                    Some("ollama" | "chatgpt" | "grok")
                ) {
                    // load admits its owned task synchronously. Dropping the
                    // receiver neither delays this response nor cancels work.
                    drop(service.catalogs.load(catalog(
                        &owner,
                        provider["id"].as_str().context("stored provider ID")?,
                        false,
                    )));
                }
            }
            Ok(settings)
        })
    }

    pub fn create_provider(
        self: &Arc<Self>,
        owner: &str,
        input: Value,
    ) -> BoxFuture<'static, Result<Json>> {
        let owner = owner.to_owned();
        self.launch(move |service| async move {
            let provider = service
                .repository
                .create_model_provider(&owner, &input)
                .await?;
            let request = catalog(
                &owner,
                provider["id"].as_str().context("provider ID")?,
                false,
            );
            if crate::settings::zai::is_coding_plan_provider(&provider) {
                service.catalogs.load(request).await?;
            } else if provider["kind"] == "ollama" {
                drop(service.catalogs.load(request));
            }
            Ok(provider)
        })
    }

    pub fn update_provider(
        self: &Arc<Self>,
        owner: &str,
        provider: &str,
        input: Value,
    ) -> BoxFuture<'static, Result<Option<Json>>> {
        let (owner, provider) = (owner.to_owned(), provider.to_owned());
        self.launch(move |service| async move {
            let current = service
                .repository
                .get_model_provider(&owner, &provider)
                .await?;
            let base = super::super::providers::normalize_responses_base_url(
                input["baseUrl"].as_str().context("provider base URL")?,
            )?;
            let native_configuration_changed = current
                .as_ref()
                .is_none_or(|current| current["baseUrl"] != base)
                || input.get("protectedApiKey").is_some();
            if native_configuration_changed {
                service
                    .catalogs
                    .hydrator
                    .invalidate(&provider.clone().into());
            }

            let updated = service
                .repository
                .update_model_provider(&owner, &provider, &input)
                .await?;
            if updated.is_some() && input.get("maxConcurrentInference").is_some() {
                let workers = crate::workers::repository::WorkerRepository {
                    database: service.repository.database.clone(),
                }
                .list_workers(&owner)
                .await?;
                let deliveries = workers
                    .iter()
                    .filter_map(|worker| worker["id"].as_str())
                    .map(|worker| service.synchronize_inference(&owner, worker));
                // Delivery failures remain visible and owned by their sync jobs.
                let _ = futures::future::join_all(deliveries).await;
            }
            if let Some(updated) = &updated
                && native_configuration_changed
            {
                let request = catalog(&owner, &provider, true);
                if crate::settings::zai::is_coding_plan_provider(updated) {
                    service.catalogs.load(request).await?;
                } else if updated["kind"] == "ollama" {
                    drop(service.catalogs.load(request));
                }
            }
            Ok(updated)
        })
    }

    pub fn synchronize_inference(
        self: &Arc<Self>,
        owner: &str,
        worker: &str,
    ) -> BoxFuture<'static, Result<()>> {
        let (owner, worker) = (owner.to_owned(), worker.to_owned());
        self.launch(move |service| async move {
            let result = async {
                let configurations = service.repository.provider_inference_configurations(&owner).await?;
                let command = Value::from_serialize(&serde_json::json!({
                    "type": "inference.configure", "configurations": configurations,
                }));
                let reply = service.commands.request(
                    &worker, command, Some(std::time::Duration::from_secs(30)), None,
                ).await?;
                let status = crate::settings::parse_response("workerInferenceStatusSchema", reply.as_ref())?;
                anyhow::ensure!(
                    status["workerId"] == worker && status["ownerId"] == owner,
                    "Inference configuration acknowledgement belongs to another worker scope."
                );
                Ok(())
            }.await;
            if result.is_err() {
                LifecycleLog::emit("warn", crate::wire::value::json!({"event":"inference.configuration.delivery-pending", "workerId":worker}), "Provider inference configuration delivery remains pending");
            }
            result
        })
    }

    pub fn delete_provider(
        self: &Arc<Self>,
        owner: &str,
        provider: &str,
    ) -> BoxFuture<'static, Result<bool>> {
        let (owner, provider) = (owner.to_owned(), provider.to_owned());
        self.launch(move |service| async move {
            let Some(current) = service
                .repository
                .get_model_provider(&owner, &provider)
                .await?
            else {
                return Ok(false);
            };
            if matches!(current["kind"].as_str(), Some("chatgpt" | "grok")) {
                anyhow::ensure!(
                    !service
                        .repository
                        .has_model_routes_for_provider(&owner, &provider)
                        .await?,
                    MODELS_FIRST
                );
                let accounts = service
                    .repository
                    .list_provider_accounts(&owner, &provider)
                    .await?
                    .unwrap_or_default();
                for account in accounts {
                    let target = service
                        .authentication
                        .resolve_target(
                            &owner,
                            &provider,
                            Some(account["id"].as_str().context("account ID")?),
                        )
                        .await?;
                    service
                        .authentication
                        .prepare_sign_out(&owner, &provider, target.clone(), None)
                        .await?;
                    service
                        .lifecycle
                        .sign_out(sign_out_input(&owner, &provider, &target)?)
                        .await?;
                }
            }
            service
                .catalogs
                .hydrator
                .invalidate(&provider.clone().into());
            service
                .repository
                .delete_model_provider(&owner, &provider)
                .await
        })
    }
}
