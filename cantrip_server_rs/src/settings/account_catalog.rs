//! Shared account catalog transactions and worker discovery.
use super::{
    catalog::CatalogUpdate, parse_response, quota::QuotaContext, repository::SettingsRepository,
};
use crate::{
    auth::now,
    wire::{self, Value},
    workers::{command_bus::LimitedCommandBus, repository::WorkerRepository},
};
use anyhow::{Context, Result};
use futures::FutureExt;
use serde_json::{Value as Json, json};
use std::{sync::Arc, time::Duration};

pub struct AccountCatalogRequest<'a> {
    pub owner: &'a str,
    pub provider: &'a str,
    pub worker: &'a str,
    pub worker_key_is_string: bool,
    pub force: bool,
    pub requested_account: Option<&'a str>,
    pub quota_trigger: Option<&'a str>,
}
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Family {
    ChatGpt,
    Grok,
}
impl Family {
    fn kind(self) -> &'static str {
        match self {
            Self::ChatGpt => "chatgpt",
            Self::Grok => "grok",
        }
    }
    fn label(self) -> &'static str {
        match self {
            Self::ChatGpt => "ChatGPT",
            Self::Grok => "Grok",
        }
    }
    fn schema(self) -> &'static str {
        match self {
            Self::ChatGpt => "chatGptModelInventorySchema",
            Self::Grok => "grokModelInventorySchema",
        }
    }
    fn id_key(self) -> &'static str {
        match self {
            Self::ChatGpt => "model",
            Self::Grok => "id",
        }
    }
    fn normalize(self, model: &Value) -> Value {
        match self {
            Self::ChatGpt => super::chatgpt::normalize_model(model),
            Self::Grok => super::grok::normalize_model(model),
        }
    }
}
impl SettingsRepository {
    pub(super) async fn mark_account_catalog_unavailable(
        &self,
        family: Family,
        owner: &str,
        provider: &str,
        account: &str,
    ) -> Result<()> {
        let scope = format!("{}-account:{account}", family.kind());
        self.reconcile_provider_model_catalog(
            owner,
            provider,
            CatalogUpdate {
                models: vec![],
                availability_scope: scope.clone(),
                available: Default::default(),
                auto_create: false,
                auto_create_native_ids: None,
                worker_id: None,
                account_id: Some(account.into()),
                default_native_id: None,
            },
        )
        .boxed()
        .await?;
        self.set_provider_catalog_sync_state(provider,&json!({"scopeKey":scope,"workerId":null,"providerAccountId":account,"status":"current","errorCode":null,"lastSuccessAt":now()})).await
    }
    pub(super) async fn get_account_provider_catalog(
        &self,
        request: &AccountCatalogRequest<'_>,
        commands: &Arc<LimitedCommandBus>,
        family: Family,
        public: Option<(
            &Arc<super::openrouter::CatalogCache>,
            &dyn super::grok::CatalogDiagnostics,
        )>,
    ) -> Result<Option<Json>> {
        let AccountCatalogRequest {
            owner,
            provider,
            worker,
            worker_key_is_string,
            force,
            requested_account,
            quota_trigger,
        } = *request;
        let workers = WorkerRepository::new(self.database.clone());
        let (runtime, owned_worker, accounts) = tokio::try_join!(
            self.get_provider_catalog_runtime(owner, provider),
            workers.get_worker(owner, worker),
            self.list_provider_accounts(owner, provider)
        )?;
        let Some(runtime) = runtime else {
            return Ok(None);
        };
        anyhow::ensure!(owned_worker.is_some(), "Worker not found.");
        anyhow::ensure!(
            runtime["kind"] == family.kind() && accounts.is_some(),
            "Provider is not a {} provider.",
            family.label()
        );
        // Unlike Ollama, account catalog reads require a connected worker even
        // when an account's cached metadata is still current.
        anyhow::ensure!(
            worker_key_is_string && commands.is_connected(worker),
            "Worker is offline."
        );
        let requested_account = requested_account.filter(|account| !account.is_empty());
        let accounts: Vec<_> = accounts
            .expect("provider accounts checked")
            .into_iter()
            .filter(|account| {
                account["enabled"] == true && requested_account.is_none_or(|id| account["id"] == id)
            })
            .collect();
        anyhow::ensure!(
            requested_account.is_none() || !accounts.is_empty(),
            "{} account not found.",
            family.label()
        );
        let existing = self
            .get_provider_model_catalog(owner, provider, false)
            .await?;
        let has_models = existing.as_ref().is_some_and(|value| {
            value["models"]
                .as_array()
                .is_some_and(|models| !models.is_empty())
        });
        let mut public_metadata = None;
        let mut succeeded = 0;
        let mut last_error = None;
        for account in accounts {
            let id = account["id"]
                .as_str()
                .context("stored provider account ID")?;
            let scope = format!("{}-account:{id}", family.kind());
            let sync = existing
                .as_ref()
                .and_then(|catalog| catalog["syncStates"].as_array())
                .and_then(|states| states.iter().find(|state| state["scopeKey"] == scope));
            if !force
                && sync.is_some_and(|state| {
                    state["status"] == "current"
                        && state["lastSuccessAt"]
                            .as_str()
                            .and_then(|stamp| wire::date_milliseconds(&stamp.into()))
                            .is_some_and(|stamp| now().timestamp_millis() - stamp < 900_000)
                })
            {
                succeeded += 1;
                continue;
            }
            // Runtime lookup failures escape before the account refresh catch.
            let Some(account_runtime) = self
                .get_provider_account_runtime(owner, provider, Some(id))
                .await?
            else {
                continue;
            };
            let refresh: Result<()> = async {
                let legacy_available=account["credentialState"]=="migration-needed" && account["workerBindings"].as_array().is_some_and(|bindings|bindings.iter().find(|binding|binding["workerId"]==worker).is_some_and(|binding|binding["authState"]=="signed-in"));
                if account["credentialState"]!="signed-in" && !legacy_available {
                    self.mark_account_catalog_unavailable(family,owner,provider,id).await?;
                    return Ok(());
                }
                self.set_provider_catalog_sync_state(provider,&json!({"scopeKey":scope,"workerId":null,"providerAccountId":id,"status":"refreshing","errorCode":null,"refreshStartedAt":now()})).await?;
                let result=commands.request(worker,Value::from_serialize(&json!({"type":format!("model.{}.catalog",family.kind()),"provider":{"id":provider,"name":family.label(),"kind":family.kind(),"baseUrl":runtime["baseUrl"],"protectedApiKey":null,"accountId":id,"credentialHomeKey":account_runtime["credentialHomeKey"]}})),Some(Duration::from_secs(120)),None).await?;
                let inventory=parse_response(family.schema(),result.as_ref())?;
                if !inventory["quotaSnapshot"].is_null() {
                    self.persist_quota_snapshot(&QuotaContext {
                        owner,provider,account:id,worker,account_plan_type:account["planType"].as_str(),
                        trigger:quota_trigger.unwrap_or(if force {"manual-refresh"} else {"catalog-refresh"}),chat:None,turn:None,execution_attempt:None,
                    },&inventory["quotaSnapshot"]).await?;
                } else if !inventory["weeklyUsage"].is_null() {
                    self.record_provider_account_usage(owner,provider,id,account["planType"].as_str(),inventory["weeklyUsage"]["resetsAt"].as_f64(),inventory["weeklyUsage"]["usedPercent"].as_f64().expect("validated weekly usage")).await?;
                }
                let inventory_models=inventory["models"].as_array().expect("validated ChatGPT inventory");
                let mut models:Vec<_>=inventory_models.iter().map(|model|family.normalize(model)).collect();
                if family == Family::Grok && models.iter().any(|model|model["supportsVision"].is_null()) {
                    let (cache,diagnostics)=public.expect("Grok catalog metadata dependencies");
                    if public_metadata.is_none() {public_metadata=Some(super::grok::public_models(cache,diagnostics,force).await?);}
                    models=super::grok::enrich_vision(&models,public_metadata.as_ref().expect("loaded public metadata"));
                }
                let visible:Vec<_>=inventory_models.iter().filter(|model|model["hidden"]!=true).collect();
                self.reconcile_provider_model_catalog(owner,provider,CatalogUpdate {
                    available:models.iter().map(|model|model["nativeModelId"].as_js_string().expect("validated model ID").clone()).collect(),
                    auto_create_native_ids:Some(visible.iter().map(|model|model[family.id_key()].as_js_string().expect("validated model ID").clone()).collect()),
                    default_native_id:visible.iter().find(|model|model["isDefault"]==true).and_then(|model|model[family.id_key()].as_js_string()).map(|value|value.lossy().into_owned()),
                    models,availability_scope:scope.clone(),auto_create:true,worker_id:None,account_id:Some(id.into()),
                }).await?;
                self.set_provider_catalog_sync_state(provider,&json!({"scopeKey":scope,"workerId":null,"providerAccountId":id,"status":"current","errorCode":null,"lastSuccessAt":now()})).await?;
                succeeded+=1;
                Ok(())
            }.boxed().await;
            if let Err(error) = refresh {
                last_error = Some(error);
                self.set_provider_catalog_sync_state(provider,&json!({"scopeKey":scope,"workerId":null,"providerAccountId":id,"status":if has_models {"stale"} else {"failed"},"errorCode":format!("{}-catalog-refresh-failed",family.kind())})).await?;
            }
        }
        if succeeded > 0 || has_models {
            return self
                .get_provider_model_catalog(owner, provider, succeeded == 0)
                .await;
        }
        if let Some(error) = last_error {
            return Err(error);
        }
        anyhow::bail!("No signed-in {} account is available.", family.label())
    }
}
