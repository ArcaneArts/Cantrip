//! Global provider mutations retain the complete admitted operation, including
//! account cleanup and catalog work, when the HTTP caller disconnects.
use super::{AccountService, sign_out_input};
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
            service
                .catalogs
                .hydrator
                .invalidate(&provider.clone().into());
            let updated = service
                .repository
                .update_model_provider(&owner, &provider, &input)
                .await?;
            if let Some(updated) = &updated {
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
