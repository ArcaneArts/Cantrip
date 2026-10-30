//! Controlled worker replies and real database races around production services.
use anyhow::{Context, Result};
use cantrip_server::{
    relay::RelayQuotas,
    settings::{
        authentication::{AccountAuthentication, ReconnectRequired},
        catalog_runtime::{CatalogBackend, CatalogRequest, CatalogRuntime, Family},
        credential_migrations::MigrationCoordinator,
        lifecycle::{LifecycleDiagnostics, LifecycleService, SignOutInput},
        repository::SettingsRepository,
    },
    wire::Value as Wire,
    workers::{
        bridge::{BridgeStats, CommandError, EventHandler},
        command_bus::{CommandDelegate, CommandLimits, CommandOutcome, LimitedCommandBus},
    },
};
use futures::{FutureExt, future::BoxFuture};
use serde_json::{Value, json};
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicI64, Ordering},
    },
    time::Duration,
};
struct Control {
    repository: SettingsRepository,
    input: Wire,
    calls: Mutex<Vec<Wire>>,
    logs: Mutex<Vec<Wire>>,
    invalidations: Mutex<Vec<Wire>>,
    clock: AtomicI64,
    disconnected: Mutex<Vec<String>>,
}
fn text<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value[key].as_str().context("provider fixture text")
}
impl Control {
    async fn sql(&self, statements: &Wire) -> Result<()> {
        for statement in statements.as_array().into_iter().flatten() {
            self.repository
                .database
                .execute(statement.as_str().context("fixture SQL")?)
                .await?;
        }
        Ok(())
    }
    fn connected(&self, worker: &str) -> bool {
        if self
            .disconnected
            .lock()
            .unwrap()
            .iter()
            .any(|id| id == worker)
        {
            return false;
        }
        let configured = &self.input["connected"];
        configured
            .as_bool()
            .unwrap_or_else(|| configured[worker] == true)
    }
    fn log(&self, level: &'static str, context: Wire, message: &'static str) -> Result<()> {
        if level == "info" && self.input["noInfo"] == true {
            return Ok(());
        }
        self.logs.lock().unwrap().push(Wire::object([
            ("level", Wire::String(level.into())),
            ("context", context),
            ("message", Wire::String(message.into())),
        ]));
        if self.input["logError"] == level {
            anyhow::bail!("controlled diagnostic failure")
        }
        Ok(())
    }
}
impl LifecycleDiagnostics for Control {
    fn info(&self, context: Wire, message: &'static str) -> Result<()> {
        self.log("info", context, message)
    }
    fn warn(&self, context: Wire, message: &'static str) -> Result<()> {
        self.log("warn", context, message)
    }
}
struct Delegate(Arc<Control>);
impl cantrip_server::settings::grok::CatalogDiagnostics for Control {
    fn event(&self, level: &'static str, context: Wire, message: &'static str) -> Result<()> {
        self.log(level, context, message)
    }
    fn rate_limited(&self, warning: cantrip_server::settings::grok::CatalogWarning) -> Result<()> {
        self.logs.lock().unwrap().push(Wire::from_serialize(&json!({"key":warning.key,"level":warning.level,"message":warning.message,"context":warning.context,"options":{"summaryEvery":warning.summary_every,"windowMs":warning.window_ms}})));
        if self.input["logError"] == warning.level {
            anyhow::bail!("controlled diagnostic failure")
        }
        Ok(())
    }
}
impl CatalogBackend for Delegate {
    fn load(
        &self,
        family: Family,
        request: CatalogRequest,
    ) -> BoxFuture<'static, Result<Option<Value>>> {
        let control = self.0.clone();
        async move {
            let kind = match family {
                Family::Zai => "zai",
                Family::Public => "public",
                Family::ChatGpt => "chatgpt",
                Family::Grok => "grok",
                Family::Ollama => "ollama",
            };
            let mut call = Wire::from_serialize(
                &json!({"kind":kind,"owner":request.owner,"provider":request.provider}),
            );
            if matches!(family, Family::Public) {
                call["force"] = Wire::Bool(request.force)
            } else if !matches!(family, Family::Zai) {
                call["worker"] = Wire::from_serialize(&request.worker);
                call["force"] = Wire::Bool(request.force);
                if matches!(family, Family::ChatGpt | Family::Grok) {
                    if let Some(account) = request.account {
                        call["account"] = Wire::String(account.into())
                    }
                    if let Some(trigger) = request.quota_trigger {
                        call["trigger"] = Wire::String(trigger.into())
                    }
                }
            }
            control.calls.lock().unwrap().push(call);
            control.sql(&control.input["beforeCatalogSQL"]).await?;
            control.clock.fetch_add(
                control.input["elapsedMs"].as_i64().unwrap_or(0),
                Ordering::SeqCst,
            );
            if let Some(error) = control.input["catalogError"]
                .as_str()
                .filter(|error| !error.is_empty())
            {
                anyhow::bail!("{error}")
            }
            let value = control
                .input
                .get("catalog")
                .cloned()
                .unwrap_or_else(|| Wire::from_serialize(&json!({"fixture":"catalog"})));
            Ok(if value.is_null() {
                None
            } else {
                Some(serde_json::from_str(&value.stringify())?)
            })
        }
        .boxed()
    }
}
impl CommandDelegate for Delegate {
    fn is_connected(&self, worker: &str) -> bool {
        self.0.connected(worker)
    }
    fn stats(&self) -> BridgeStats {
        BridgeStats {
            active_requests: 0,
            connected_workers: 0,
            failed_requests: 0,
            routed_requests: 0,
            succeeded_requests: 0,
        }
    }
    fn request(
        self: Arc<Self>,
        owner: String,
        worker: String,
        command: Wire,
        timeout: Option<Duration>,
        _: Option<EventHandler>,
    ) -> BoxFuture<'static, CommandOutcome> {
        async move {
            let control=&self.0;
            let kind=command["type"].as_str().expect("command type");
            let account=command["providerAccountId"].as_str().unwrap_or("");
            let response=control.input["accounts"][account].get(kind)
                .or_else(||control.input["workers"].get(worker.as_str()))
                .or_else(||control.input["byType"].get(kind)).unwrap_or(&control.input).clone();
            let index={let mut calls=control.calls.lock().unwrap();let index=calls.len();calls.push(Wire::object([
                ("worker",Wire::String(worker.clone().into())),("command",command.clone()),("options",Wire::from_serialize(&json!({"ownerId":owner,"timeoutMs":timeout.map(|value|value.as_millis() as u64)}))),
            ]));index};
            let execute:Result<Option<Wire>>=async {
                if control.input["observeClear"]==true{
                    let cleared=control.repository.get_provider_account_credential(&owner,command["providerId"].as_str().context("provider ID")?,account).await?.is_none();
                    control.calls.lock().unwrap()[index]["credentialCleared"]=Wire::Bool(cleared);
                }
                control.sql(&response["beforeSQL"]).await?;
                control.clock.fetch_add(response["elapsedMs"].as_i64().unwrap_or(0),Ordering::SeqCst);
                if control.input["rejectDisconnected"]==true && !control.connected(&worker){anyhow::bail!("controlled disconnected worker")}
                if let Some(error)=response["error"].as_js_string().filter(|error|!error.is_empty()){anyhow::bail!("{}",error.lossy())}
                Ok(response.get("reply").cloned())
            }.await;
            execute.map_err(|error|CommandError{message:error.to_string().into(),code:None,unavailable:false,encoding_error:None,request_id:None})
        }.boxed()
    }
}
pub async fn run(repository: &SettingsRepository, r: &Value, input: &Wire) -> Result<Value> {
    let control = Arc::new(Control {
        repository: repository.clone(),
        input: input.clone(),
        calls: Mutex::new(vec![]),
        logs: Mutex::new(vec![]),
        invalidations: Mutex::new(vec![]),
        clock: AtomicI64::new(input["now"].as_i64().unwrap_or(1000)),
        disconnected: Mutex::new(vec![]),
    });
    let owner = text(r, "owner")?.to_owned();
    let principal = owner.clone();
    let commands = LimitedCommandBus::with_parts(
        Arc::new(Delegate(control.clone())),
        RelayQuotas::with_limits(64 << 20, 64 << 20, 64 << 20, 64 << 20, 10, 10),
        CommandLimits {
            account_concurrency: 100,
            account_rate_per_minute: 1000,
            worker_concurrency: 100,
            worker_rate_per_minute: 1000,
        },
        Arc::new(move |_| {
            let principal = principal.clone();
            async move { Ok(Some(principal)) }.boxed()
        }),
        Arc::new(|| 0),
    );
    let result: Value = match text(r, "op")? {
        "runtime-catalog" => {
            let clock = control.clone();
            let runtime = CatalogRuntime::with_backend(
                repository.clone(),
                commands.clone(),
                Arc::new(Delegate(control.clone())),
                control.clone(),
                Arc::new(move || clock.clock.load(Ordering::SeqCst)),
            );
            let pending = runtime.load(CatalogRequest {
                owner: owner.clone(),
                provider: text(r, "provider")?.into(),
                worker: r.get("worker").map(Wire::from_serialize),
                force: r["force"] == true,
                account: r["account"].as_str().map(str::to_owned),
                quota_trigger: r["trigger"].as_str().map(str::to_owned),
            });
            let result = if input["discard"] == true {
                drop(pending);
                Value::Null
            } else {
                match pending.await {
                    Ok(catalog) => {
                        if input["hydrateAfterLoad"] == true {
                            let provider = text(r, "provider")?;
                            let hydrated=runtime.hydrate(&owner,&[Wire::from_serialize(&json!({"provider":{"id":provider,"kind":"openai-compatible","baseUrl":"https://openrouter.ai/api/v1"}}))]).await.map_err(|error|anyhow::anyhow!("{error}"))?;
                            json!({"catalog":catalog,"hydrated":hydrated})
                        } else {
                            json!(catalog)
                        }
                    }
                    Err(error) => json!({"error":error.to_string()}),
                }
            };
            anyhow::ensure!(
                runtime.drain().await.is_empty(),
                "controlled catalog background failures"
            );
            result
        }
        "auth-resolve" | "auth-prepare" | "auth-reauth" => {
            let purge = input["purgeKinds"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|kind| kind.as_str().context("purge kind").map(str::to_owned))
                .collect::<Result<_>>()?;
            let migrations =
                MigrationCoordinator::with_purge_kinds(repository.clone(), commands.clone(), purge);
            let auth = AccountAuthentication::new(
                repository.clone(),
                commands.clone(),
                migrations.clone(),
            );
            let outcome: Result<Value> = async {
                if r["op"] == "auth-reauth" {
                    return Ok(json!(
                        auth.mark_reauthentication_required(
                            &owner,
                            text(r, "provider")?,
                            text(r, "account")?
                        )
                        .await?
                    ));
                }
                let target = auth
                    .resolve_target(&owner, text(r, "provider")?, r["account"].as_str())
                    .await?;
                if r["op"] == "auth-resolve" {
                    return Ok(target);
                }
                let pending = auth.prepare_sign_out(
                    &owner,
                    text(r, "provider")?,
                    target,
                    r["worker"].as_str(),
                );
                if input["discard"] == true {
                    drop(pending);
                    auth.drain().await;
                } else {
                    pending.await?;
                }
                Ok(Value::Null)
            }
            .await;
            auth.drain().await;
            migrations.drain().await;
            outcome.unwrap_or_else(|error|json!({"error":error.to_string(),"reconnectRequired":error.is::<ReconnectRequired>()}))
        }
        "migration-worker" | "migration-account" => {
            let purge = input["purgeKinds"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|kind| kind.as_str().context("purge kind").map(str::to_owned))
                .collect::<Result<_>>()?;
            let coordinator =
                MigrationCoordinator::with_purge_kinds(repository.clone(), commands.clone(), purge);
            if r["op"] == "migration-worker" {
                json!(
                    coordinator
                        .migrate_worker(&owner, text(r, "worker")?)
                        .await?
                )
            } else {
                let pending = coordinator.capture_account(
                    &owner,
                    text(r, "worker")?,
                    text(r, "provider")?,
                    text(r, "account")?,
                );
                if input["discard"] == true {
                    drop(pending);
                    coordinator.drain().await;
                    Value::Null
                } else {
                    json!(pending.await?)
                }
            }
        }
        "lifecycle-signout" => {
            let invalidator = control.clone();
            let clock = control.clone();
            let service = LifecycleService::with_clock(
                repository.clone(),
                commands.clone(),
                Arc::new(move |context| {
                    let invalidator = invalidator.clone();
                    if let Some(worker) = invalidator.input["disconnectOnInvalidate"].as_str() {
                        invalidator.disconnected.lock().unwrap().push(worker.into());
                    }
                    async move {
                        let cleared = invalidator
                            .repository
                            .get_provider_account_credential(
                                &context.owner_id,
                                &context.provider_id,
                                &context.account_id,
                            )
                            .await?
                            .is_none();
                        invalidator
                            .invalidations
                            .lock()
                            .unwrap()
                            .push(Wire::object([
                                ("input", Wire::from_serialize(&context)),
                                ("credentialCleared", Wire::Bool(cleared)),
                            ]));
                        invalidator.sql(&invalidator.input["invalidateSQL"]).await?;
                        if invalidator.input["invalidateError"] == true {
                            anyhow::bail!("controlled invalidation failure")
                        }
                        if context.kind == "grok" {
                            invalidator
                                .repository
                                .mark_grok_account_unavailable(
                                    &context.owner_id,
                                    &context.provider_id,
                                    &context.account_id,
                                )
                                .await?;
                        } else {
                            invalidator
                                .repository
                                .mark_chatgpt_account_unavailable(
                                    &context.owner_id,
                                    &context.provider_id,
                                    &context.account_id,
                                )
                                .await?;
                        }
                        Ok(())
                    }
                    .boxed()
                }),
                control.clone(),
                Arc::new(move || clock.clock.load(Ordering::SeqCst)),
            );
            let pending = service.sign_out(SignOutInput {
                owner_id: owner,
                provider_id: text(r, "provider")?.into(),
                account_id: text(r, "account")?.into(),
                credential_home_key: text(r, "home")?.into(),
                kind: text(r, "kind")?.into(),
            });
            if input["discard"] == true {
                drop(pending);
                service.drain().await;
                Value::Null
            } else {
                let result = pending.await;
                service.drain().await;
                json!(result?)
            }
        }
        _ => anyhow::bail!("unknown provider service fixture"),
    };
    commands.drained().await;
    Ok(
        json!({"result":result,"calls":Wire::Array(control.calls.lock().unwrap().clone()),"logs":Wire::Array(control.logs.lock().unwrap().clone()),"invalidations":Wire::Array(control.invalidations.lock().unwrap().clone())}),
    )
}
