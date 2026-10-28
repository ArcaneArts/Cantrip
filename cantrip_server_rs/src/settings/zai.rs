//! Built-in provider discovery, including hydration of existing installations.
use super::{catalog::CatalogUpdate, normalize_responses_base_url, repository::SettingsRepository};
use crate::{
    auth::now,
    wire::{JsString, Value as WireValue},
};
use anyhow::{Context, Result};
use serde_json::{Value, json};
use std::{collections::HashSet, sync::OnceLock};

pub fn catalog_data() -> &'static Value {
    static DATA: OnceLock<Value> = OnceLock::new();
    DATA.get_or_init(|| {
        serde_json::from_str(include_str!("../../contracts/zai-catalog.json"))
            .expect("embedded Z.ai catalog")
    })
}
pub fn is_coding_plan_provider(provider: &Value) -> bool {
    if provider["kind"] != "openai-compatible" {
        return false;
    }
    let Some(base) = provider["baseUrl"].as_str() else {
        return false;
    };
    normalize_responses_base_url(base)
        .ok()
        .and_then(|base| url::Url::parse(&base).ok())
        .is_some_and(|url| {
            url.scheme() == "https"
                && url.host_str() == Some("api.z.ai")
                && url.path().trim_end_matches('/') == "/api/v1"
        })
}
impl SettingsRepository {
    pub async fn reconcile_zai_owner_providers(&self, owner: &str) -> Result<Vec<String>> {
        let data = catalog_data();
        let models = data["models"].as_array().expect("built-in catalog models");
        let scope = data["scope"].as_str().expect("built-in catalog scope");
        let etag = format!("built-in-v{}", data["version"]);
        let providers = self
            .list_provider_catalog_targets(owner)
            .await?
            .into_iter()
            .filter(is_coding_plan_provider)
            .map(|provider| {
                provider["id"]
                    .as_str()
                    .context("stored provider ID")
                    .map(str::to_owned)
            })
            .collect::<Result<Vec<_>>>()?;
        for provider in &providers {
            let existing = self
                .get_provider_model_catalog(owner, provider, false)
                .await?;
            let current = existing.as_ref().is_some_and(|existing| {
                existing["syncStates"].as_array().is_some_and(|states| {
                    states.iter().any(|state| {
                        state["scopeKey"] == scope
                            && state["status"] == "current"
                            && state["etag"] == etag
                    })
                }) && models.iter().all(|model| {
                    existing["models"].as_array().is_some_and(|stored| {
                        stored
                            .iter()
                            .any(|stored| stored["nativeModelId"] == model["nativeModelId"])
                    })
                })
            });
            if !current {
                self.get_zai_provider_catalog(owner, provider).await?;
            }
        }
        Ok(providers)
    }
    pub async fn get_zai_provider_catalog(
        &self,
        owner: &str,
        provider: &str,
    ) -> Result<Option<Value>> {
        let Some(runtime) = self.get_provider_catalog_runtime(owner, provider).await? else {
            return Ok(None);
        };
        anyhow::ensure!(
            is_coding_plan_provider(&runtime),
            "Provider is not a Z.ai Coding Plan provider."
        );
        let data = catalog_data();
        let models = data["models"].as_array().expect("built-in catalog models");
        let scope = data["scope"].as_str().expect("built-in catalog scope");
        let available: HashSet<JsString> = models
            .iter()
            .map(|model| {
                model["nativeModelId"]
                    .as_str()
                    .expect("built-in model ID")
                    .into()
            })
            .collect();
        // These are separate commits in the source service. A reconcile failure
        // must retain its refreshing state for the next real retry.
        self.set_provider_catalog_sync_state(provider, &json!({"scopeKey":scope,"status":"refreshing","errorCode":null,"refreshStartedAt":now()})).await?;
        self.reconcile_provider_model_catalog(
            owner,
            provider,
            CatalogUpdate {
                models: models.iter().map(WireValue::from_serialize).collect(),
                availability_scope: scope.into(),
                available: available.clone(),
                auto_create: true,
                auto_create_native_ids: Some(available),
                worker_id: None,
                account_id: None,
                default_native_id: Some("glm-5.3".into()),
            },
        )
        .await?;
        self.set_provider_catalog_sync_state(provider, &json!({"scopeKey":scope,"status":"current","errorCode":null,"etag":format!("built-in-v{}",data["version"]),"lastSuccessAt":now()})).await?;
        self.get_provider_model_catalog(owner, provider, false)
            .await
    }
}
