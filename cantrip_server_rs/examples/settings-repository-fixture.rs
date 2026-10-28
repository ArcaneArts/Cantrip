//! Disposable IPC adapter of native settings persistence, never a production route.
use anyhow::{Context, Result};
use cantrip_server::{
    auth::repository::AuthRepository, database::Database, managed_postgres::ManagedPostgres,
    migrations::migrate, settings::repository::SettingsRepository,
};
use cantrip_server::{
    relay::RelayQuotas,
    wire::Value as WireValue,
    workers::{
        bridge::{BridgeStats, CommandError, EventHandler},
        command_bus::{
            CommandDelegate, CommandFailure, CommandLimits, CommandOutcome, LimitedCommandBus,
        },
    },
};
use clap::Parser;
use futures::{FutureExt, future::BoxFuture};
use serde_json::{Value, json};
use std::{
    io::{self, BufRead, Write},
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};
#[path = "support/provider_services.rs"]
mod provider_services;

struct PublicCatalogControl {
    input: Mutex<WireValue>,
    calls: Mutex<Vec<WireValue>>,
    now: std::sync::atomic::AtomicU64,
    release: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
}
struct PublicCatalogFetcher(Arc<PublicCatalogControl>);
impl cantrip_server::settings::openrouter::CatalogFetcher for PublicCatalogFetcher {
    fn fetch(
        &self,
        url: url::Url,
        etag: Option<cantrip_server::wire::JsString>,
    ) -> BoxFuture<
        'static,
        Result<
            cantrip_server::settings::openrouter::FetchResponse,
            cantrip_server::settings::openrouter::CatalogFailure,
        >,
    > {
        use cantrip_server::settings::openrouter::{CatalogFailure, FetchResponse};
        let input = self.0.input.lock().unwrap().clone();
        self.0.calls.lock().unwrap().push(WireValue::object([
            ("url", WireValue::String(url.to_string().into())),
            (
                "etag",
                etag.map(WireValue::String).unwrap_or(WireValue::Null),
            ),
            ("accept", WireValue::String("application/json".into())),
            ("authorization", WireValue::Null),
        ]));
        let blocked = if input["block"] == true {
            let (send, receive) = tokio::sync::oneshot::channel();
            *self.0.release.lock().unwrap() = Some(send);
            Some(receive)
        } else {
            None
        };
        async move {
            if let Some(blocked) = blocked {
                let _ = blocked.await;
            }
            if let Some(error) = input["error"]
                .as_js_string()
                .filter(|error| !error.is_empty())
            {
                return Err(CatalogFailure(error.clone()));
            }
            Ok(FetchResponse {
                status: input["status"].as_u64().unwrap_or(200) as u16,
                status_text: input["statusText"]
                    .as_js_string()
                    .cloned()
                    .unwrap_or_else(|| "OK".into()),
                etag: input["etag"].as_js_string().cloned(),
                body: async move {
                    Ok(input
                        .get("payload")
                        .filter(|value| !value.is_null())
                        .cloned()
                        .unwrap_or_else(|| WireValue::object([] as [(&str, WireValue); 0])))
                }
                .boxed(),
            })
        }
        .boxed()
    }
}
struct FixtureCatalog {
    control: Arc<PublicCatalogControl>,
    service: Arc<cantrip_server::settings::openrouter::CatalogService>,
    grok_cache: Arc<cantrip_server::settings::openrouter::CatalogCache>,
    diagnostics: Arc<CatalogDiagnostics>,
}
#[derive(Default)]
struct CatalogDiagnostics(Mutex<Vec<WireValue>>);
impl cantrip_server::settings::grok::CatalogDiagnostics for CatalogDiagnostics {
    fn rate_limited(&self, warning: cantrip_server::settings::grok::CatalogWarning) -> Result<()> {
        self.0.lock().unwrap().push(WireValue::object([
            ("key", WireValue::String(warning.key.into())),
            ("level", WireValue::String(warning.level.into())),
            ("message", WireValue::String(warning.message.into())),
            ("context", warning.context),
            (
                "options",
                WireValue::from_serialize(
                    &json!({"summaryEvery":warning.summary_every,"windowMs":warning.window_ms}),
                ),
            ),
        ]));
        Ok(())
    }
}
impl FixtureCatalog {
    fn new(repo: SettingsRepository) -> Self {
        let control = Arc::new(PublicCatalogControl {
            input: Mutex::new(WireValue::Null),
            calls: Mutex::new(vec![]),
            now: std::sync::atomic::AtomicU64::new(1000_f64.to_bits()),
            release: Mutex::new(None),
        });
        let clock = Arc::clone(&control);
        let cache = cantrip_server::settings::openrouter::CatalogCache::with_options(
            Arc::new(PublicCatalogFetcher(Arc::clone(&control))),
            Arc::new(move || f64::from_bits(clock.now.load(std::sync::atomic::Ordering::SeqCst))),
            100.0,
        );
        let clock = Arc::clone(&control);
        let grok_cache = cantrip_server::settings::openrouter::CatalogCache::with_options(
            Arc::new(PublicCatalogFetcher(Arc::clone(&control))),
            Arc::new(move || f64::from_bits(clock.now.load(std::sync::atomic::Ordering::SeqCst))),
            100.0,
        );
        Self {
            control,
            service: cantrip_server::settings::openrouter::CatalogService::with_cache(repo, cache),
            grok_cache,
            diagnostics: Arc::new(CatalogDiagnostics::default()),
        }
    }
}

struct CatalogDelegate {
    input: WireValue,
    calls: Mutex<Vec<WireValue>>,
}
impl CommandDelegate for CatalogDelegate {
    fn is_connected(&self, _: &str) -> bool {
        self.input["connected"] == true
    }
    fn stats(&self) -> BridgeStats {
        BridgeStats {
            active_requests: 0,
            connected_workers: usize::from(self.is_connected("")),
            failed_requests: 0,
            routed_requests: 0,
            succeeded_requests: 0,
        }
    }
    fn request(
        self: Arc<Self>,
        owner: String,
        worker: String,
        command: WireValue,
        timeout: Option<Duration>,
        _: Option<EventHandler>,
    ) -> BoxFuture<'static, CommandOutcome> {
        Box::pin(async move {
            let account = command["provider"]["accountId"].as_str();
            let response = account
                .and_then(|account| self.input["responses"].get(account))
                .unwrap_or(&self.input)
                .clone();
            self.calls.lock().unwrap().push(WireValue::object([
                ("worker", WireValue::String(worker.into())),
                ("command", command),
                (
                    "options",
                    WireValue::object([
                        ("ownerId", WireValue::String(owner.into())),
                        (
                            "timeoutMs",
                            WireValue::from_serialize(&timeout.map(|time| time.as_millis() as u64)),
                        ),
                    ]),
                ),
            ]));
            if let Some(error) = response["error"]
                .as_js_string()
                .filter(|error| !error.is_empty())
            {
                return Err(CommandError {
                    message: error.clone(),
                    code: None,
                    unavailable: false,
                    encoding_error: None,
                });
            }
            Ok(response.get("inventory").cloned())
        })
    }
}
#[derive(Parser)]
struct Arguments {
    #[arg(long, default_value = "pglite")]
    database: String,
}
fn text<'a>(request: &'a Value, key: &str) -> Result<&'a str> {
    request[key].as_str().context("fixture string")
}
fn quota_context(r: &Value) -> Result<cantrip_server::settings::quota::QuotaContext<'_>> {
    let c = &r["context"];
    Ok(cantrip_server::settings::quota::QuotaContext {
        owner: text(r, "owner")?,
        provider: text(c, "providerId")?,
        account: text(c, "accountId")?,
        worker: text(c, "workerId")?,
        account_plan_type: c["accountPlanType"].as_str(),
        trigger: text(c, "trigger")?,
        chat: c["chatId"].as_str(),
        turn: c["turnId"].as_str(),
        execution_attempt: c["executionAttemptId"].as_str(),
    })
}
async fn operation(
    repo: &SettingsRepository,
    public: &FixtureCatalog,
    r: &Value,
    input: &cantrip_server::wire::Value,
) -> Result<Value> {
    let owner = || text(r, "owner");
    Ok(match text(r, "op")? {
        "migration-worker" | "migration-account" | "lifecycle-signout" | "auth-resolve"
        | "auth-prepare" | "auth-reauth" | "runtime-catalog" => {
            provider_services::run(repo, r, input).await?
        }
        "openrouter-get" => {
            *public.control.input.lock().unwrap() = input.clone();
            public.control.calls.lock().unwrap().clear();
            if let Some(now) = r["now"].as_f64() {
                public
                    .control
                    .now
                    .store(now.to_bits(), std::sync::atomic::Ordering::SeqCst);
            }
            let result = public
                .service
                .get_provider_catalog(owner()?, text(r, "provider")?, r["force"] == true)
                .await;
            let calls = WireValue::Array(public.control.calls.lock().unwrap().clone());
            match result {
                Ok(result) => json!({"result":result,"calls":calls}),
                Err(error) => json!({"error":error.to_string(),"calls":calls}),
            }
        }
        "openrouter-release" => {
            public
                .control
                .release
                .lock()
                .unwrap()
                .take()
                .context("No pending public catalog request.")?
                .send(())
                .ok()
                .context("Pending public catalog receiver closed.")?;
            let errors = public.service.drain().await;
            anyhow::ensure!(
                errors.is_empty(),
                "Public catalog persistence failed: {errors:?}"
            );
            repo.get_provider_model_catalog(owner()?, text(r, "provider")?, false)
                .await?
                .unwrap_or(Value::Null)
        }
        "sql" => {
            repo.database.execute(text(r, "sql")?).await?;
            Value::Null
        }
        "transaction" => {
            let statements = r["statements"]
                .as_array()
                .context("fixture statements")?
                .iter()
                .map(|v| Ok(v.as_str().context("fixture SQL")?.to_owned()))
                .collect::<Result<Vec<_>>>()?;
            repo.database
                .transaction(move |tx| {
                    Box::pin(async move {
                        for sql in statements {
                            tx.execute(&sql).await?;
                        }
                        Ok(())
                    })
                })
                .await?;
            Value::Null
        }
        "query-json" => repo
            .database
            .query(text(r, "sql")?, &[])
            .await?
            .first()
            .context("JSON query")?
            .get(0)?,
        "ensure-account" => {
            repo.ensure_account_configuration(owner()?).await?;
            Value::Null
        }
        "ensure-default" => {
            repo.ensure_default_model_configuration(
                owner()?,
                text(r, "model")?,
                text(r, "baseUrl")?,
            )
            .await?;
            Value::Null
        }
        "settings" => repo.get_settings(owner()?).await?,
        "preferences" => repo.get_user_settings(owner()?).await?,
        "update" => repo
            .update_settings(owner()?, &r["input"])
            .await?
            .unwrap_or(Value::Null),
        "destination" => repo
            .update_app_destination(owner()?, &r["input"])
            .await?
            .unwrap_or(Value::Null),
        "runtimes" => json!(
            repo.get_model_runtimes(
                owner()?,
                r["model"].as_str(),
                r["route"].as_str(),
                r["includeDisabled"].as_bool().unwrap_or(false),
                r["provider"].as_str()
            )
            .await?
        ),
        "catalog-hash" => json!(cantrip_server::settings::catalog::metadata_snapshot(input)?),
        "quota-observe" => json!(
            repo.record_provider_quota_observation(owner()?, input)
                .await?
        ),
        "quota-persist" => json!(
            repo.persist_quota_snapshot(&quota_context(r)?, input)
                .await?
        ),
        "quota-activity" => json!(
            repo.persist_rate_limit_activity_at(
                &quota_context(r)?,
                input,
                r["now"].as_i64().context("activity clock")?
            )
            .await?
        ),
        "chatgpt-unavailable" => {
            repo.mark_chatgpt_account_unavailable(
                owner()?,
                text(r, "provider")?,
                text(r, "account")?,
            )
            .await?;
            Value::Null
        }
        "ollama-get" | "chatgpt-get" | "grok-get" | "grok-unavailable" | "quota-read" => {
            let delegate = Arc::new(CatalogDelegate {
                input: input.clone(),
                calls: Mutex::new(Vec::new()),
            });
            let principal = owner()?.to_owned();
            let commands = LimitedCommandBus::with_parts(
                delegate.clone(),
                RelayQuotas::with_limits(
                    64 * 1024 * 1024,
                    64 * 1024 * 1024,
                    64 * 1024 * 1024,
                    64 * 1024 * 1024,
                    10,
                    10,
                ),
                CommandLimits {
                    account_concurrency: 100,
                    account_rate_per_minute: 1000,
                    worker_concurrency: 100,
                    worker_rate_per_minute: 1000,
                },
                Arc::new(move |_| {
                    let principal = principal.clone();
                    Box::pin(async move { Ok(Some(principal)) })
                }),
                Arc::new(|| 0),
            );
            let grok = if matches!(text(r, "op")?, "grok-get" | "grok-unavailable") {
                *public.control.input.lock().unwrap() =
                    input.get("public").cloned().unwrap_or(WireValue::Null);
                public.control.calls.lock().unwrap().clear();
                public.diagnostics.0.lock().unwrap().clear();
                if let Some(now) = r["now"].as_f64() {
                    public
                        .control
                        .now
                        .store(now.to_bits(), std::sync::atomic::Ordering::SeqCst);
                }
                Some(cantrip_server::settings::grok::CatalogService::with_cache(
                    repo.clone(),
                    commands.clone(),
                    public.grok_cache.clone(),
                    public.diagnostics.clone(),
                ))
            } else {
                None
            };
            let result: Result<Value> = match text(r,"op")? {
                "grok-get"=>grok.as_ref().unwrap().get_provider_catalog(&cantrip_server::settings::chatgpt::AccountCatalogRequest{
                    owner:owner()?,provider:text(r,"provider")?,worker:text(r,"worker")?,worker_key_is_string:true,force:r["force"]==true,requested_account:r["account"].as_str(),quota_trigger:r["trigger"].as_str(),
                }).await.map(|value|json!(value)),
                "grok-unavailable"=>grok.as_ref().unwrap().mark_account_unavailable(owner()?,text(r,"provider")?,text(r,"account")?).await.map(|()|Value::Null),
                "chatgpt-get" => repo.get_chatgpt_provider_catalog(&cantrip_server::settings::chatgpt::AccountCatalogRequest {
                    owner:owner()?,provider:text(r,"provider")?,worker:text(r,"worker")?,worker_key_is_string:true,force:r["force"].as_bool().unwrap_or(false),requested_account:r["account"].as_str(),quota_trigger:r["trigger"].as_str(),
                },&commands).await.map(|value|json!(value)),
                "quota-read" => async {
                    let (inserted,snapshot)=repo.read_and_persist_quota_snapshot(&quota_context(r)?,&commands,&WireValue::from_serialize(&r["context"]["provider"])).await?;
                    Ok(json!({"inserted":inserted,"snapshot":serde_json::from_str::<Value>(&snapshot.stringify())?}))
                }.await,
                _ => repo.get_ollama_provider_catalog(owner()?,text(r,"provider")?,text(r,"worker")?,r["force"].as_bool().unwrap_or(false),&commands).await.map(|value|json!(value)),
            };
            commands.drained().await;
            let calls: Value = serde_json::from_str(
                &WireValue::Array(delegate.calls.lock().unwrap().clone()).stringify(),
            )?;
            let mut response = match result {
                Ok(result) => json!({"result":result,"calls":calls}),
                Err(error) => {
                    let message = error
                        .downcast_ref::<CommandFailure>()
                        .map(|error| error.message().lossy().into_owned())
                        .unwrap_or_else(|| error.to_string());
                    json!({"error":message,"calls":calls})
                }
            };
            if grok.is_some() {
                response["publicCalls"] = serde_json::from_str(
                    &WireValue::Array(public.control.calls.lock().unwrap().clone()).stringify(),
                )?;
                response["diagnostics"] = serde_json::from_str(
                    &WireValue::Array(public.diagnostics.0.lock().unwrap().clone()).stringify(),
                )?;
            }
            response
        }
        "zai-get" => json!(
            repo.get_zai_provider_catalog(owner()?, text(r, "provider")?)
                .await?
        ),
        "zai-reconcile" => json!(repo.reconcile_zai_owner_providers(owner()?).await?),
        "zai-predicate" => json!(cantrip_server::settings::zai::is_coding_plan_provider(
            &r["input"]
        )),
        "zai-constants" => cantrip_server::settings::zai::catalog_data().clone(),
        "model-create" => repo
            .create_model_profile(owner()?, input)
            .await?
            .unwrap_or(Value::Null),
        "model-update" => repo
            .update_model_profile(owner()?, text(r, "model")?, input)
            .await?
            .unwrap_or(Value::Null),
        "model-delete" => json!(
            repo.delete_model_profile(owner()?, text(r, "model")?)
                .await?
        ),
        "provider-create" => repo.create_model_provider(owner()?, input).await?,
        "provider-get" => repo
            .get_model_provider(owner()?, text(r, "provider")?)
            .await?
            .unwrap_or(Value::Null),
        "provider-update" => repo
            .update_model_provider(owner()?, text(r, "provider")?, input)
            .await?
            .unwrap_or(Value::Null),
        "provider-delete" => json!(
            repo.delete_model_provider(owner()?, text(r, "provider")?)
                .await?
        ),
        "provider-runtime" => repo
            .get_provider_catalog_runtime(owner()?, text(r, "provider")?)
            .await?
            .unwrap_or(Value::Null),
        "provider-routes" => json!(
            repo.has_model_routes_for_provider(owner()?, text(r, "provider")?)
                .await?
        ),
        "account-runtimes" => json!(
            repo.list_provider_account_runtimes(
                owner()?,
                text(r, "provider")?,
                text(r, "worker")?,
                r["model"].as_str()
            )
            .await?
        ),
        "accounts-list" => json!(
            repo.list_provider_accounts(owner()?, text(r, "provider")?)
                .await?
        ),
        "account-create" => json!(
            repo.create_provider_account(owner()?, text(r, "provider")?, input)
                .await?
        ),
        "account-update" => json!(
            repo.update_provider_account(
                owner()?,
                text(r, "provider")?,
                text(r, "account")?,
                input
            )
            .await?
        ),
        "accounts-order" => json!(
            repo.reorder_provider_accounts(
                owner()?,
                text(r, "provider")?,
                &input["ids"]
                    .as_array()
                    .context("account IDs")?
                    .iter()
                    .map(|id| id.as_js_string().cloned().context("account ID"))
                    .collect::<Result<Vec<_>>>()?
            )
            .await?
        ),
        "account-delete" => json!(
            repo.delete_provider_account(owner()?, text(r, "provider")?, text(r, "account")?)
                .await?
        ),
        "account-runtime" => json!(
            repo.get_provider_account_runtime(
                owner()?,
                text(r, "provider")?,
                r["account"].as_str()
            )
            .await?
        ),
        "credential-get" => json!(
            repo.get_provider_account_credential(
                owner()?,
                text(r, "provider")?,
                text(r, "account")?
            )
            .await?
        ),
        "credential-migrations" => json!(repo.list_provider_credential_migrations(owner()?).await?),
        "credential-migration" => json!(
            repo.get_provider_credential_migration(
                owner()?,
                text(r, "provider")?,
                text(r, "account")?
            )
            .await?
        ),
        "credential-store" => json!(
            repo.store_provider_account_credential(
                owner()?,
                text(r, "provider")?,
                text(r, "account")?,
                input,
                &r["metadata"],
                r["expectedRevision"].as_f64()
            )
            .await?
        ),
        "credential-state" => json!(
            repo.update_provider_credential_state(
                owner()?,
                text(r, "provider")?,
                text(r, "account")?,
                r["expectedRevision"].as_f64().context("revision")?,
                text(r, "state")?
            )
            .await?
        ),
        "credential-clear" => json!(
            repo.clear_provider_account_credential(
                owner()?,
                text(r, "provider")?,
                text(r, "account")?,
                r["expectedRevision"].as_f64()
            )
            .await?
        ),
        "credential-signout" => json!(
            repo.take_provider_credential_for_sign_out(
                owner()?,
                text(r, "provider")?,
                text(r, "account")?,
                r["expectedRevision"].as_f64()
            )
            .await?
        ),
        "credential-parallel" => json!(
            futures::future::join_all((0..r["count"].as_u64().context("parallel count")?).map(
                |_| async {
                    match repo
                        .store_provider_account_credential(
                            owner()?,
                            text(r, "provider")?,
                            text(r, "account")?,
                            input,
                            &r["metadata"],
                            r["expectedRevision"].as_f64(),
                        )
                        .await
                    {
                        Ok(value) => Ok::<_, anyhow::Error>(json!({"value":value})),
                        Err(error) => Ok(json!({"error":error.to_string()})),
                    }
                }
            ))
            .await
            .into_iter()
            .collect::<Result<Vec<_>>>()?
        ),
        "account-status" => {
            let status = &r["status"];
            let weekly = if status["weeklyUsage"].is_null() {
                None
            } else {
                Some((
                    status["weeklyUsage"]["usedPercent"]
                        .as_f64()
                        .context("usage")?,
                    status["weeklyUsage"]["resetsAt"].as_f64(),
                ))
            };
            repo.record_provider_account_status(
                text(r, "account")?,
                text(r, "worker")?,
                status["authenticated"].as_bool().context("auth state")?,
                status["planType"].as_str(),
                weekly,
            )
            .await?;
            Value::Null
        }
        "account-credits" => json!(
            repo.record_provider_account_credits(
                owner()?,
                text(r, "provider")?,
                text(r, "account")?,
                &r["credits"],
                chrono::DateTime::parse_from_rfc3339(text(r, "observedAt")?)?
                    .with_timezone(&chrono::Utc)
            )
            .await?
        ),
        "account-usage" => {
            let used =
                r["usedPercent"]
                    .as_f64()
                    .unwrap_or_else(|| match r["usedPercent"].as_str() {
                        Some("NaN") => f64::NAN,
                        Some("Infinity") => f64::INFINITY,
                        Some("-Infinity") => f64::NEG_INFINITY,
                        _ => f64::NAN,
                    });
            json!(
                repo.record_provider_account_usage(
                    owner()?,
                    text(r, "provider")?,
                    text(r, "account")?,
                    r["planType"].as_str(),
                    r["resetsAt"].as_f64(),
                    used
                )
                .await?
            )
        }
        "catalog-targets" => json!(repo.list_provider_catalog_targets(owner()?).await?),
        "catalog-refresh-targets" => json!(repo.list_provider_refresh_targets(owner()?).await?),
        "catalog-sync" => {
            repo.set_provider_catalog_sync_state(text(r, "provider")?, &r["input"])
                .await?;
            Value::Null
        }
        "catalog-get" => json!(
            repo.get_provider_model_catalog(
                owner()?,
                text(r, "provider")?,
                r["servedStale"].as_bool().unwrap_or(false)
            )
            .await?
        ),
        "catalog-availability" => json!(
            repo.list_provider_model_availability(
                owner()?,
                text(r, "provider")?,
                text(r, "model")?
            )
            .await?
        ),
        "catalog-reconcile" => {
            let ids =
                |key: &str| -> Result<std::collections::HashSet<cantrip_server::wire::JsString>> {
                    input[key]
                        .as_array()
                        .context("catalog ID set")?
                        .iter()
                        .map(|id| id.as_js_string().cloned().context("catalog ID"))
                        .collect()
                };
            json!(
                repo.reconcile_provider_model_catalog(
                    owner()?,
                    text(r, "provider")?,
                    cantrip_server::settings::catalog::CatalogUpdate {
                        models: input["models"]
                            .as_array()
                            .context("catalog models")?
                            .clone(),
                        availability_scope: input["availabilityScope"]
                            .as_js_string()
                            .context("availability scope")?
                            .lossy()
                            .into_owned(),
                        available: ids("availableNativeModelIds")?,
                        auto_create: input["autoCreateLogicalModels"].as_bool().unwrap_or(false),
                        auto_create_native_ids: if input.get("autoCreateNativeModelIds").is_some() {
                            Some(ids("autoCreateNativeModelIds")?)
                        } else {
                            None
                        },
                        worker_id: input["availabilityWorkerId"]
                            .as_js_string()
                            .map(|id| id.lossy().into_owned()),
                        account_id: input["availabilityProviderAccountId"]
                            .as_js_string()
                            .map(|id| id.lossy().into_owned()),
                        default_native_id: input["defaultNativeModelId"]
                            .as_js_string()
                            .map(|id| id.lossy().into_owned()),
                    }
                )
                .await?
            )
        }
        "analytics" => {
            let a = repo
                .agent_time_analytics(
                    owner()?,
                    r["project"].as_str(),
                    chrono::DateTime::parse_from_rfc3339(text(r, "now")?)?
                        .with_timezone(&chrono::Utc),
                )
                .await?;
            json!({"total":a.total,"models":a.models,"providers":a.providers})
        }
        _ => anyhow::bail!("Unknown settings fixture operation"),
    })
}
#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<()> {
    if cantrip_server::managed_postgres::run_owner_if_requested().await? {
        return Ok(());
    }
    let args = Arguments::parse();
    let root = PathBuf::from(std::env::var("CANTRIP_DATA_DIR")?);
    let input = os_pipe::dup_stdin()?;
    let mut output = os_pipe::dup_stdout()?;
    let mut managed = None;
    let database = Arc::new(match args.database.as_str() {
        "pglite" => Database::pglite(&root.join("server-db")).await?,
        "postgres" => Database::postgres_url(&std::env::var("DATABASE_URL")?).await?,
        "bundled-postgres" => {
            let runtime = ManagedPostgres::start(
                &root.join("postgres"),
                &PathBuf::from(std::env::var("CANTRIP_POSTGRES_BIN_DIR")?),
            )
            .await?;
            let db = Database::postgres(runtime.configuration()).await?;
            managed = Some(runtime);
            db
        }
        _ => anyhow::bail!("Unknown fixture database"),
    });
    migrate(&database).await?;
    AuthRepository::new(database.clone()).local_user().await?;
    let repo = SettingsRepository::new(database.clone());
    let public = FixtureCatalog::new(repo.clone());
    writeln!(
        output,
        "\n{}",
        json!({"event":"server.listening","origin":"settings-repository-fixture"})
    )?;
    output.flush()?;
    for line in io::BufReader::new(input).lines() {
        let raw: cantrip_server::wire::Value = serde_json::from_str(&line?)?;
        let mut metadata = raw.clone();
        metadata["input"] = cantrip_server::wire::Value::Null;
        let mut request: Value = serde_json::from_str(&metadata.stringify())?;
        if !matches!(
            text(&request, "op")?,
            "model-create"
                | "model-update"
                | "provider-create"
                | "provider-update"
                | "account-create"
                | "account-update"
                | "accounts-order"
                | "credential-store"
                | "credential-parallel"
                | "catalog-reconcile"
                | "catalog-hash"
                | "ollama-get"
                | "chatgpt-get"
                | "grok-get"
                | "grok-unavailable"
                | "migration-worker"
                | "migration-account"
                | "lifecycle-signout"
                | "auth-resolve"
                | "auth-prepare"
                | "auth-reauth"
                | "runtime-catalog"
                | "openrouter-get"
                | "quota-read"
                | "quota-observe"
                | "quota-persist"
                | "quota-activity"
        ) {
            request["input"] = serde_json::from_str(&raw["input"].stringify())?;
        }
        let result = operation(&repo, &public, &request, &raw["input"]).await;
        let mut reply = json!({"id":request["id"],"rejected":result.is_err()});
        match result {
            Ok(value) => reply["value"] = value,
            Err(error) => {
                reply["diagnostic"] = json!(error.to_string());
                if let Some(kind) =
                    error.downcast_ref::<cantrip_server::settings::accounts::CredentialConflict>()
                {
                    reply["kind"] = json!(match kind {
                        cantrip_server::settings::accounts::CredentialConflict::Identity =>
                            "credential-identity",
                        cantrip_server::settings::accounts::CredentialConflict::Revision =>
                            "credential-revision",
                    });
                }
            }
        };
        writeln!(output, "\n{reply}")?;
        output.flush()?;
    }
    if let Some(release) = public.control.release.lock().unwrap().take() {
        let _ = release.send(());
    }
    let background_errors = public.service.drain().await;
    public.grok_cache.drain().await;
    anyhow::ensure!(
        background_errors.is_empty(),
        "Public catalog background cleanup: {background_errors:?}"
    );
    database.close().await?;
    if let Some(runtime) = managed {
        runtime.close().await?;
    }
    Ok(())
}
