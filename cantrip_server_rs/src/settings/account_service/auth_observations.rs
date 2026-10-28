//! Provider sign-in observations are ephemeral, owner-scoped worker events.
//! Keep the original observation alive across awaits: removal from the map
//! does not cancel an already admitted notification in the reference server.
use super::{AccountService, AuthObservation, AuthState, auth_flow::same_identifier};
use crate::{
    settings::catalog_runtime::CatalogRequest, wire::Value, workers::repository::WorkerRepository,
};
use anyhow::{Context, Result};
use futures::{FutureExt, future::BoxFuture};
use serde_json::json;
use std::{
    collections::HashSet,
    sync::{Arc, Mutex},
};

fn date(value: &Value) -> f64 {
    value
        .as_js_string()
        .and_then(crate::wire::date_milliseconds)
        .map_or(f64::NAN, |v| v as f64)
}

impl AccountService {
    pub(super) fn sync_observation_subscriptions(self: &Arc<Self>) {
        let state = self.auth_state.lock().unwrap();
        let workers: HashSet<String> = state
            .observations
            .values()
            .filter_map(|active| active.lock().unwrap().worker.as_str().map(str::to_owned))
            .collect();
        let mut subscriptions = self.observation_subscriptions.lock().unwrap();
        subscriptions.retain(|worker, _| workers.contains(worker));
        for worker in workers {
            subscriptions.entry(worker.clone()).or_insert_with(|| {
                let weak = Arc::downgrade(self);
                let observed_worker = worker.clone();
                self.bridge.subscribe_owned_notifications(
                    &worker,
                    Arc::new(move |owner, notification| {
                        if notification["type"].as_str() != Some("provider.auth.status.observed") {
                            return async { Ok(()) }.boxed();
                        }
                        let Some(service) = weak.upgrade() else {
                            return async { Ok(()) }.boxed();
                        };
                        // The owner comes from the authenticated, generation-checked peer.
                        // Retain the observation before the first database await.
                        service.auth_observed(owner, observed_worker.clone(), notification)
                    }),
                )
            });
        }
    }

    fn auth_observed(
        self: &Arc<Self>,
        owner: String,
        worker: String,
        notification: Arc<Value>,
    ) -> BoxFuture<'static, Result<()>> {
        let Some(id) = notification["observationId"].as_str().map(str::to_owned) else {
            return async { Ok(()) }.boxed();
        };
        let state = self.auth_state.lock().unwrap();
        let active = state.observations.get(&id).cloned();
        let Some(active) = active else {
            return async { Ok(()) }.boxed();
        };
        let observed_at = date(&notification["observedAt"]);
        let Some(sequence) = notification["sequence"].as_f64() else {
            return async { Ok(()) }.boxed();
        };
        {
            let current = active.lock().unwrap();
            if current.owner != owner
                || !same_identifier(&current.worker, &Value::String(worker.clone().into()))
                || !same_identifier(&current.provider, &notification["providerId"])
                || current.account != notification["providerAccountId"].as_str().unwrap_or("")
                || current.kind != notification["providerKind"].as_str().unwrap_or("")
                || (notification["status"]["state"].as_str() == Some("authenticated")
                    && notification["status"]["authMode"] != notification["providerKind"])
                || observed_at < (current.started_at - 5 * 60_000) as f64
                || observed_at > (crate::auth::now().timestamp_millis() + 5 * 60_000) as f64
                || sequence <= current.last_sequence
            {
                return async { Ok(()) }.boxed();
            }
        }
        drop(state);
        self.launch(move |service| async move {
            service
                .apply_auth_observation(owner, worker, notification, active, sequence)
                .await
        })
    }

    async fn apply_auth_observation(
        self: Arc<Self>,
        owner: String,
        worker: String,
        notification: Arc<Value>,
        active: Arc<Mutex<AuthObservation>>,
        sequence: f64,
    ) -> Result<()> {
        let workers = WorkerRepository::new(self.repository.database.clone());
        let provider = notification["providerId"]
            .as_str()
            .context("auth provider ID")?;
        let account = notification["providerAccountId"]
            .as_str()
            .context("auth account ID")?;
        let (worker_record, target) = tokio::try_join!(
            workers.get_worker(&owner, &worker),
            self.authentication
                .resolve_target(&owner, provider, Some(account)),
        )?;
        if worker_record.is_none()
            || Value::from_serialize(&target["providerKind"]) != notification["providerKind"]
        {
            return Ok(());
        }
        let mut status = notification["status"].clone();
        if status["state"].as_str() != Some("authenticated") {
            let terminal = {
                let mut state = self.auth_state.lock().unwrap();
                advance_observation(&active, &notification, sequence);
                self.publish_observation(&mut state, &owner, &worker, &notification, status)?
            };
            if terminal {
                self.sync_observation_subscriptions();
            }
            return Ok(());
        }
        {
            // Authentication has a real capture await after advancement. Keep
            // the original active reference even if its map entry was removed.
            let _state = self.auth_state.lock().unwrap();
            advance_observation(&active, &notification, sequence);
        }
        let capture = self
            .migrations
            .capture_account(&owner, &worker, provider, account)
            .await?;
        if capture.migration.captured + capture.migration.already_captured == 0 {
            status = Value::from_serialize(
                &json!({"state":"failed","authMode":null,"email":null,"planType":null,"weeklyUsage":null,"failureCode":"credential-capture-failed"}),
            );
        } else {
            let weekly = status.get("weeklyUsage").filter(|v| !v.is_null()).map(|v| {
                (
                    v["usedPercent"].as_f64().unwrap_or(0.0),
                    v["resetsAt"].as_f64(),
                )
            });
            self.repository
                .record_provider_account_status(
                    account,
                    &worker,
                    true,
                    status["planType"].as_str(),
                    weekly,
                )
                .await?;
            drop(self.catalogs.load(CatalogRequest {
                owner: owner.clone(),
                provider: provider.into(),
                worker: Some(Value::String(worker.clone().into())),
                force: true,
                account: Some(account.into()),
                quota_trigger: Some("account-auth-live".into()),
            }));
        }
        let terminal = {
            let mut state = self.auth_state.lock().unwrap();
            self.publish_observation(&mut state, &owner, &worker, &notification, status)?
        };
        if terminal {
            self.sync_observation_subscriptions();
        }
        Ok(())
    }

    fn publish_observation(
        &self,
        state: &mut AuthState,
        owner: &str,
        worker: &str,
        notification: &Value,
        status: Value,
    ) -> Result<bool> {
        let id = notification["observationId"]
            .as_str()
            .context("auth observation ID")?;
        let terminal = status["state"].as_str() != Some("pending");
        self.publish_status(
            owner,
            Value::object([
                ("providerId", notification["providerId"].clone()),
                (
                    "providerAccountId",
                    notification["providerAccountId"].clone(),
                ),
                ("providerKind", notification["providerKind"].clone()),
                ("workerId", Value::String(worker.into())),
                ("observedAt", notification["observedAt"].clone()),
                ("expiresAt", notification["expiresAt"].clone()),
                ("status", status),
            ]),
            terminal,
            state,
        )?;
        if terminal {
            state.observations.shift_remove(id);
        }
        Ok(terminal)
    }
}

// Called while auth_state is held. Source intentionally does not re-check map
// presence or sequence after its database validation await.
fn advance_observation(active: &Mutex<AuthObservation>, notification: &Value, sequence: f64) {
    let mut current = active.lock().unwrap();
    current.last_sequence = sequence;
    let expiry = date(&notification["expiresAt"]);
    current.expires_at = if expiry.is_nan() {
        f64::NAN
    } else {
        expiry.min((crate::auth::now().timestamp_millis() + 16 * 60_000) as f64)
    };
}
