use super::{AccountService, AuthState};
use crate::{
    settings::{
        authentication::account_auth_status, catalog_runtime::CatalogRequest, parse_response,
        raw_identifiers,
    },
    wire::{Value, coercion},
};
use anyhow::{Context, Result};
use futures::future::BoxFuture;
use serde_json::json;
use std::sync::Arc;

pub(super) struct AuthObservation {
    pub owner: String,
    pub provider: Value,
    pub account: String,
    pub expires_at: f64,
    pub worker: Value,
    pub kind: String,
    pub started_at: i64,
    pub last_sequence: f64,
}
// Separate JSON requests cannot share an array/object reference. The source's
// identifier comparisons use === even where database binding coerces to text.
pub(super) fn same_identifier(a: &Value, b: &Value) -> bool {
    matches!(
        a,
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_)
    ) && a == b
}
impl AccountService {
    pub fn device_login(
        self: &Arc<Self>,
        owner: &str,
        provider: Value,
        account: Option<Value>,
        worker: Value,
    ) -> BoxFuture<'static, Result<Value>> {
        let owner = owner.to_owned();
        self.launch(move |service| async move {
            let workers = crate::workers::repository::WorkerRepository::new(service.repository.database.clone());
            let ((_, target), worker_record) = tokio::try_join!(
                service.authentication.resolve_request_target(&owner, &provider, account.as_ref()),
                workers.get_worker_input(&owner, &worker),
            )?;
            anyhow::ensure!(worker_record.is_some(), "Worker not found.");
            let account = target["accountId"].as_str().context("account ID")?.to_owned();
            let kind = target["providerKind"].as_str().context("account provider kind")?.to_owned();
            let (id, started, expires) = {
                // Source removal, creation and insertion have no await between
                // them. Keep that operation indivisible across Tokio threads.
                let mut state = service.auth_state.lock().unwrap();
                let observations = &mut state.observations;
                observations.retain(|_, observation| {
                    let observation = observation.lock().unwrap();
                    !(observation.owner == owner && same_identifier(&observation.provider, &provider) && observation.account == account)
                });
                let id = uuid::Uuid::new_v4().to_string();
                let started = crate::auth::now().timestamp_millis();
                let expires = started + 15 * 60_000;
                observations.insert(id.clone(), Arc::new(std::sync::Mutex::new(AuthObservation {
                    owner: owner.clone(), provider: provider.clone(), account: account.clone(),
                    worker: worker.clone(), kind: kind.clone(), started_at: started,
                    last_sequence: 0.0, expires_at: expires as f64,
                })));
                while observations.len() > 4096 { observations.shift_remove_index(0); }
                (id, started, expires)
            };
            service.sync_observation_subscriptions();
            let login = async {
                let reply = service.commands.request_key(worker.clone(), Value::object([
                    ("type", Value::String("codex.auth.login.start".into())),
                    ("providerId", provider.clone()),
                    ("providerAccountId", Value::String(account.clone().into())),
                    ("providerKind", Value::String(kind.clone().into())),
                    ("credentialHomeKey", Value::from_serialize(&target["credentialHomeKey"])),
                    ("observationId", Value::String(id.clone().into())),
                ])).await?;
                parse_response("codexDeviceLoginSchema", reply.as_ref())
            }.await;
            let login = match login {
                Ok(login) => login,
                Err(error) => {
                    service.auth_state.lock().unwrap().observations.shift_remove(&id);
                    service.sync_observation_subscriptions();
                    return Err(error);
                }
            };
            let still_active = service.auth_state.lock().unwrap().observations.contains_key(&id);
            if still_active {
                service.repository.record_provider_account_status(&account, &raw_identifiers::text(&worker)?, false, None, None).await?;
                let mut state = service.auth_state.lock().unwrap();
                service.publish_status(&owner, Value::object([
                    ("providerId", provider),
                    ("providerAccountId", Value::String(account.into())),
                    ("providerKind", Value::String(kind.into())),
                    ("workerId", worker),
                    ("observedAt", Value::String(crate::wire::date_iso_milliseconds(started).context("login start time")?.into())),
                    ("expiresAt", Value::String(crate::wire::date_iso_milliseconds(expires).context("login expiry time")?.into())),
                    ("status", Value::from_serialize(&json!({"state":"pending","authMode":null,"email":null,"planType":null,"weeklyUsage":null,"failureCode":null}))),
                ]), true, &mut state)?;            }
            Ok(login)
        })
    }
    pub(super) fn remove_observations(
        state: &mut AuthState,
        owner: &str,
        provider: &Value,
        account: &str,
    ) {
        state.observations.retain(|_, observation| {
            let observation = observation.lock().unwrap();
            !(observation.owner == owner
                && same_identifier(&observation.provider, provider)
                && observation.account == account)
        });
    }
    pub fn auth_status(
        self: &Arc<Self>,
        owner: &str,
        query: Value,
    ) -> BoxFuture<'static, Result<Value>> {
        let owner = owner.to_owned();
        self.launch(move|service|async move{
            let provider=query.get("providerId").context("providerId is required")?;
            let provider_id=raw_identifiers::text(provider)?;
            let (provider_record,accounts)=tokio::try_join!(
                service.repository.provider_input(&owner,provider),
                service.repository.list_provider_accounts(&owner,&provider_id),
            )?;
            let Some((provider_record,accounts))=provider_record.zip(accounts).filter(|(provider,_)|matches!(provider["kind"].as_str(),Some("chatgpt"|"grok"))) else {anyhow::bail!("Provider account not found.")};
            let account_key=query.get("accountId").filter(|value|coercion::truthy(Some(value)));
            let mut account=accounts.into_iter().find(|account| {
                account_key.map_or_else(||account["enabled"]==true,|key|same_identifier(&Value::from_serialize(&account["id"]),key))
            }).context("Provider account not found.")?;
            let account_id=account["id"].as_str().context("stored auth account ID")?.to_owned();
            let pending={
                let mut state=service.auth_state.lock().unwrap();
                let observations=&mut state.observations;
                let active=observations.iter().find_map(|(id,observation)| {
                    let observation=observation.lock().unwrap();
                    (observation.owner==owner&&same_identifier(&observation.provider,provider)&&observation.account==account_id).then(||(id.clone(),observation.expires_at))
                });
                active.map(|(id,expires)| {
                    let pending=expires>crate::auth::now().timestamp_millis() as f64;
                    if !pending {observations.shift_remove(&id);}
                    pending
                })
            };
            if let Some(pending)=pending {
                if !pending {service.sync_observation_subscriptions();}
                return parse_response("codexAuthStatusSchema",Some(&Value::from_serialize(&json!({"authenticated":false,"authMode":null,"email":null,"planType":null,"weeklyUsage":null,"loginPending":pending,"loginError":if pending{None}else{Some("The provider sign-in code expired.")}}))))
            }
            let worker=query.get("workerId");
            let mut capture_error=None;
            if account["credentialState"]!="signed-in" && coercion::truthy(worker) && service.authentication.runner_available(&owner,worker.and_then(Value::as_str)).await? {
                let capture=service.migrations.capture_account(&owner,worker.and_then(Value::as_str).context("available auth worker")?,&provider_id,&account_id).await?;
                if capture.migration.malformed>0 {capture_error=Some("The worker's provider credential is invalid. Sign in again to replace it.")}
                else if capture.migration.failed>0 {capture_error=Some("The worker could not protect and save provider authentication. Reconnect or update the worker, then try again.")}
                if let Some(refreshed)=service.repository.list_provider_accounts(&owner,&provider_id).await?.and_then(|accounts|accounts.into_iter().find(|account|account["id"]==account_id)) {account=refreshed;}
                service.live.invalidate_resource(&owner,"settings");
            }
            let mut status=account_auth_status(provider_record["kind"].as_str().context("stored account kind")?,&Value::from_serialize(&account)).map_err(crate::settings::response_error)?;
            if status["authenticated"]==false && let Some(error)=capture_error {
                status["loginError"]=Value::String(error.into());
                status=parse_response("codexAuthStatusSchema",Some(&status))?;
            }
            if status["authenticated"]==true && coercion::truthy(worker) {
                drop(service.catalogs.load(CatalogRequest{owner,provider:provider_id,worker:worker.cloned(),force:true,account:Some(account_id),quota_trigger:Some("account-status-refresh".into())}));
            }
            Ok(status)
        })
    }
}
