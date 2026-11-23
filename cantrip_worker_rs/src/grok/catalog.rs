use super::{
    Commands,
    http::{Http, weekly_usage},
    models::inventory,
};
use crate::{
    codex::catalog::account_home,
    encryption::Service,
    http::checked,
    logging::Logs,
    protected_secrets::open_runtime_provider,
    provider_access::{Access, Account, Lease, RequestError, json_body},
};
use anyhow::{Result, anyhow, bail};
use cantrip_history::projection::Work;
use cantrip_transport::lifecycle::owned;
use cantrip_wire::{JsString, Value, value::json};
use reqwest::{Response, StatusCode};
use std::{sync::Arc, time::Duration};
use tokio::time::Instant;

const MODELS: &str = "model.grok.catalog";
const QUOTA: &str = "provider.quota.read";
const FRESH: Duration = Duration::from_secs(30);

pub fn supports(command: &Value) -> bool {
    command["provider"]["kind"] == "grok"
        && matches!(command["type"].as_str(), Some(MODELS | QUOTA))
}

#[derive(Clone)]
pub struct Catalog {
    auth: Commands,
    access: Access,
    encryption: Arc<Service>,
    logs: Arc<Logs>,
}

impl Catalog {
    pub fn new(auth: Commands, access: Access, encryption: Arc<Service>, logs: Arc<Logs>) -> Self {
        Self {
            auth,
            access,
            encryption,
            logs,
        }
    }

    pub fn execute(&self, command: Value) -> Work<Value> {
        let this = self.clone();
        owned(async move {
            let provider = open_runtime_provider(&this.encryption, &command["provider"])?;
            let field = |name: &str| {
                provider[name]
                    .as_js_string()
                    .cloned()
                    .ok_or_else(|| anyhow!("Worker command does not contain a Grok {name}."))
            };
            let account = Account {
                provider: field("id")?,
                id: field("accountId")?,
            };
            let home = account_home(&this.auth.0.data, &field("credentialHomeKey")?);
            let _home = this.auth.0.codex.lock_account_home(&home).await;
            let entry = this.auth.entry(&home)?;
            let mut state = entry.state.lock().await;
            if state.closed {
                bail!("Grok authentication is stopped.");
            }
            let binding = this.encryption.bound_identity()?;
            let http = &this.auth.0.http;
            let portable = Portable {
                http,
                access: &this.access,
                account: &account,
                logs: &this.logs,
            };
            if state.portable_quota.as_ref().is_some_and(|quota| {
                quota.owner != binding.0 || quota.server != binding.1 || quota.account != account
            }) {
                state.portable_quota = None;
            }

            let result = if command["type"] == QUOTA {
                let observed = portable
                    .quota(&mut state.portable_quota, &binding, true)
                    .await;
                with_worker_version(if observed.is_null() {
                    quota_document(None)
                } else {
                    observed
                })?
            } else {
                let start = Instant::now();
                let (models, quota) = tokio::join!(
                    portable.models(),
                    portable.quota(&mut state.portable_quota, &binding, false),
                );
                let (mut result, snapshot) = match models {
                    Ok(models) => (models, quota),
                    Err(error)
                        if error
                            .chain()
                            .filter_map(|cause| cause.downcast_ref::<RequestError>())
                            .any(RequestError::legacy_fallback) =>
                    {
                        this.logs.event("warn", "Grok account operation using local fallback", json!({
                            "event":"provider.fallback","subsystem":"provider","operation":"refresh-model-catalog",
                            "status":"recovering","reasonCode":"server-managed-credential-unavailable",
                            "providerKind":"grok","providerId":account.provider,"accountId":account.id
                        }));
                        let response = state.credential.request(http, &home, "models").await?;
                        let models = models_response(response).await?;
                        let weekly = state.credential.quota(http, &home).await;
                        let quota = if weekly.is_null() {
                            Value::Null
                        } else {
                            quota_document(Some((&weekly, true)))
                        };
                        (models, quota)
                    }
                    Err(error) => return Err(error),
                };
                let quota = if snapshot.is_null() {
                    snapshot
                } else {
                    with_worker_version(snapshot)?
                };
                let weekly = quota["windows"]
                    .as_array()
                    .and_then(|windows| {
                        windows
                            .iter()
                            .find(|window| window["isWeeklyProjection"] == true)
                    })
                    .map_or(Value::Null, |window| {
                        json!({
                            "usedPercent":window["usedPercent"],"resetsAt":window["resetsAt"]
                        })
                    });
                result["weeklyUsage"] = weekly;
                result["quotaSnapshot"] = quota;
                let result = checked("grokModelInventorySchema", &result)?;
                this.logs.event("info", "Grok model catalog refreshed", json!({
                    "event":"provider.catalog.refresh","subsystem":"provider",
                    "operation":"grok-catalog","status":"completed","providerId":account.provider,
                    "providerKind":"grok","accountId":account.id,"durationMs":start.elapsed().as_millis() as u64,
                    "counts":json!({
                        "models":result["models"].as_array().map_or(0, |rows| rows.len()),
                        "quotaWindows":result["quotaSnapshot"]["windows"].as_array().map_or(0, |rows| rows.len())
                    })
                }));
                result
            };
            if this.encryption.bound_identity()? != binding {
                bail!("The Grok account binding changed during discovery.");
            }
            Ok(result)
        })
    }
}

pub(super) struct CachedQuota {
    account: Account,
    owner: JsString,
    server: Value,
    read_at: Instant,
    snapshot: Value,
}

struct Portable<'a> {
    http: &'a Http,
    access: &'a Access,
    account: &'a Account,
    logs: &'a Logs,
}

impl Portable<'_> {
    async fn request(&self, path: &str) -> Result<Response> {
        let lease = self.access.get(self.account.clone()).await?;
        let credential = lease_credential(self.account, &lease)?;
        let response = self.http.subscription(path, &credential).await?;
        if response.status() == StatusCode::UNAUTHORIZED {
            let next = self
                .access
                .force(self.account.clone(), lease.revision())
                .await?;
            return self
                .http
                .subscription(path, &lease_credential(self.account, &next)?)
                .await;
        }
        Ok(response)
    }

    async fn models(&self) -> Result<Value> {
        models_response(self.request("models").await?).await
    }

    async fn quota(
        &self,
        cached: &mut Option<CachedQuota>,
        binding: &(JsString, Value),
        force: bool,
    ) -> Value {
        if !force
            && let Some(snapshot) = cached
                .as_ref()
                .filter(|quota| quota.read_at.elapsed() < FRESH)
        {
            return snapshot.snapshot.clone();
        }
        let result = async {
            let response = self.request("billing?format=credits").await?;
            if !response.status().is_success() {
                bail!(
                    "Grok usage discovery failed ({}).",
                    response.status().as_u16()
                );
            }
            let weekly = weekly_usage(&json_body(response).await?);
            if weekly.is_null() {
                return Ok(Value::Null);
            }
            checked(
                "providerQuotaSnapshotSchema",
                &quota_document(Some((&weekly, false))),
            )
        }
        .await;
        match result {
            Ok(snapshot) => {
                *cached = Some(CachedQuota {
                    account: self.account.clone(),
                    owner: binding.0.clone(),
                    server: binding.1.clone(),
                    read_at: Instant::now(),
                    snapshot: snapshot.clone(),
                });
                snapshot
            }
            Err(_) => {
                self.logs.repeated(
                    "grok-quota-refresh-failed".into(),
                    "warn",
                    "Grok quota refresh failed",
                    json!({
                        "event":"provider.quota.refresh","subsystem":"provider",
                        "operation":"grok-quota","reasonCode":"request-failed",
                        "status":"failed","providerKind":"grok"
                    }),
                );
                cached
                    .as_ref()
                    .map_or(Value::Null, |quota| quota.snapshot.clone())
            }
        }
    }
}

pub(super) fn lease_credential(account: &Account, lease: &Lease) -> Result<Value> {
    let value = lease.value();
    if value["providerKind"] != "grok"
        || value["providerIdentity"]["kind"] != "grok"
        || value["providerId"].as_js_string() != Some(&account.provider)
        || value["providerAccountId"].as_js_string() != Some(&account.id)
    {
        bail!("Server returned a mismatched Grok access lease.");
    }
    Ok(
        json!({"accessToken":value["accessToken"],"userId":value["providerIdentity"]["userId"],"email":value["email"]}),
    )
}

async fn models_response(response: Response) -> Result<Value> {
    if !response.status().is_success() {
        bail!(
            "Grok model discovery failed ({}).",
            response.status().as_u16()
        );
    }
    inventory(&json_body(response).await?, now())
}

fn quota_document(weekly: Option<(&Value, bool)>) -> Value {
    let windows = weekly.map(|(usage, legacy)| {
        let used = &usage["usedPercent"];
        let resets = &usage["resetsAt"];
        let raw = if legacy { json!({"source":"legacy-grok-usage"}) } else {
            json!({"source":"billing-credits","usedPercent":used,"resetsAt":resets})
        };
        json!({
            "limitId":"grok-subscription","limitName":"Grok subscription credits",
            "planType":Value::Null,"reachedType":used.as_f64().filter(|value| *value >= 100.0).map(|_| "exhausted"),
            "windowKind":"primary","usedPercent":used,"windowDurationMinutes":10080,
            "resetsAt":resets,"isWeeklyProjection":true,"rawPayload":raw
        })
    }).into_iter().collect::<Vec<_>>();
    json!({"snapshotId":uuid::Uuid::new_v4().to_string(),"observedAt":now(),"workerVersion":Value::Null,
        "codexVersion":Value::Null,"windows":windows})
}

fn with_worker_version(mut quota: Value) -> Result<Value> {
    quota["workerVersion"] = crate::version::value()["version"].clone();
    checked("providerQuotaSnapshotSchema", &quota)
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
