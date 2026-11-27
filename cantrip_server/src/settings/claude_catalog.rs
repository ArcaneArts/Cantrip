use super::{
    catalog::CatalogUpdate, catalog_runtime::CatalogRequest, parse_response,
    repository::SettingsRepository,
};
use crate::{
    auth::now,
    wire::{self, Value, value::json},
    workers::command_bus::LimitedCommandBus,
};
use anyhow::{Context, Result, ensure};
use serde_json::{Value as Json, json as serialize};
use std::{collections::HashSet, sync::Arc, time::Duration};

impl SettingsRepository {
    pub(super) async fn get_claude_code_catalog(
        &self,
        request: &CatalogRequest,
        commands: &Arc<LimitedCommandBus>,
        server: &str,
    ) -> Result<Option<Json>> {
        let owner = &request.owner;
        let provider = &request.provider;
        let worker_filter = request.worker.as_ref().filter(|worker| !worker.is_null());
        ensure!(
            worker_filter.is_none_or(Value::is_string),
            "Worker not found."
        );
        let Some(runtime) = self.get_provider_catalog_runtime(owner, provider).await? else {
            return Ok(None);
        };
        let Some(accounts) = self.list_provider_accounts(owner, provider).await? else {
            return Ok(None);
        };
        let existing = self
            .get_provider_model_catalog(owner, provider, false)
            .await?;
        let states = existing
            .as_ref()
            .and_then(|catalog| catalog["syncStates"].as_array());
        let mut refreshed = false;
        let mut failed = None;
        let mut scopes = HashSet::new();
        for account in accounts {
            if account["enabled"] != true {
                continue;
            }
            let id = account["id"].as_str().context("Claude Code account ID")?;
            let Some(worker) = self
                .claude_account_worker(owner, provider, id, true)
                .await?
            else {
                continue;
            };
            if worker_filter.is_some_and(|filter| filter.as_str() != Some(&worker)) {
                continue;
            }
            let scope = format!("claude-code-account:{id}");
            scopes.insert(scope.clone());
            let prior =
                states.and_then(|states| states.iter().find(|state| state["scopeKey"] == scope));
            if !commands.is_connected(&worker) {
                failed = Some(anyhow::anyhow!(
                    "The Claude Code account's worker is offline."
                ));
                continue;
            }
            if !request.force && prior.is_some_and(is_current) {
                continue;
            }
            let result = async {
                let response = commands.request(
                    &worker,
                    json!({"type":"claude-code.account.inspect","serverId":server,"accountId":id,"section":"models"}),
                    Some(Duration::from_secs(30)),
                    None,
                ).await?;
                let inventory = parse_response("claudeCodeModelListSchema", response.as_ref())?;
                let models: Vec<_> = inventory["models"].as_array().context("Claude Code model list")?
                    .iter().map(catalog_model).collect();
                if self.claude_account_worker(owner, provider, id, true).await?.as_deref() != Some(&worker) {
                    return Ok(());
                }
                let accepted = self.reconcile_provider_model_catalog(owner, provider, CatalogUpdate {
                    available: models.iter().filter_map(|model| model["nativeModelId"].as_js_string().cloned()).collect(),
                    models,
                    availability_scope: scope.clone(),
                    worker_id: Some(worker.clone()),
                    account_id: Some(id.into()),
                    auto_create: true,
                    auto_create_native_ids: None,
                    default_native_id: None,
                    connection_revision: runtime["connectionRevision"].as_i64(),
                    preserve_missing_models: false,
                }).await?;
                if accepted {
                    self.set_provider_catalog_sync_state(provider, &serialize!({
                        "scopeKey":scope,"workerId":worker,"providerAccountId":id,
                        "status":"current","errorCode":null,"lastSuccessAt":now()
                    })).await?;
                }
                Ok::<_, anyhow::Error>(())
            }.await;
            match result {
                Ok(()) => refreshed = true,
                Err(error) => failed = Some(error),
            }
        }
        let stale = failed.is_some();
        if let Some(error) = failed {
            let has_cache = states.is_some_and(|states| {
                states.iter().any(|state| {
                    state["scopeKey"]
                        .as_str()
                        .is_some_and(|scope| scopes.contains(scope))
                })
            });
            if !refreshed && !has_cache {
                return Err(error);
            }
        }
        let mut result = if refreshed || stale {
            self.get_provider_model_catalog(owner, provider, stale)
                .await?
        } else {
            existing
        };
        if let Some(catalog) = &mut result {
            for field in ["availability", "syncStates"] {
                if let Some(observations) = catalog[field].as_array_mut() {
                    observations.retain(|entry| {
                        entry["scopeKey"]
                            .as_str()
                            .is_some_and(|scope| scopes.contains(scope))
                    });
                }
            }
        }
        Ok(result)
    }
}

fn is_current(state: &Json) -> bool {
    state["status"] == "current"
        && state["lastSuccessAt"]
            .as_str()
            .and_then(|stamp| wire::date_milliseconds(&stamp.into()))
            .is_some_and(|stamp| now().timestamp_millis() - stamp < 900_000)
}

fn catalog_model(model: &Value) -> Value {
    let efforts: Vec<_> = model["efforts"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|effort| json!({"effort":effort,"description":Value::Null}))
        .collect();
    json!({
        "nativeModelId":model["id"],
        "displayName":model["name"],
        "description":model["description"],
        "metadataSource":"claude-code",
        "supportsReasoning":(!efforts.is_empty()).then_some(true),
        "supportedReasoningEfforts":efforts,
    })
}
