//! ChatGPT device sign-in over an owned, account-local Codex stdio service.
use super::{
    catalog::account_home,
    managed::{Host, Worker},
    rpc_client::Client,
};
use crate::{http::checked, provider_auth_observer::Observer};
use anyhow::{Result, anyhow, bail};
use cantrip_history::projection::Work;
use cantrip_transport::lifecycle::owned;
use cantrip_wire::{JsString, Value, value::json};
use indexmap::IndexMap;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::{Mutex as AsyncMutex, Notify};

const STATUS: &str = "codex.auth.status";
const LOGIN: &str = "codex.auth.login.start";
const LOGOUT: &str = "codex.auth.logout";

pub fn supports(command: &Value) -> bool {
    command["providerKind"] == "chatgpt"
        && matches!(command["type"].as_str(), Some(STATUS | LOGIN | LOGOUT))
}

struct Inner {
    host: Host,
    data: PathBuf,
    codex: Worker,
    observations: Observer,
    state: Mutex<Registry>,
}

#[derive(Default)]
struct Registry {
    closed: bool,
    homes: HashMap<PathBuf, Arc<HomeAuth>>,
}

#[derive(Clone)]
pub struct Commands(Arc<Inner>);

impl Commands {
    pub fn new(host: Host, data: PathBuf, codex: Worker, observations: Observer) -> Self {
        Self(Arc::new(Inner {
            host,
            data,
            codex,
            observations,
            state: Mutex::default(),
        }))
    }

    pub fn execute(&self, command: Value) -> Work<Value> {
        let this = self.clone();
        owned(async move {
            let provider = command["providerId"]
                .as_js_string()
                .ok_or_else(|| anyhow!("Missing provider identity."))?;
            let key = command["credentialHomeKey"]
                .as_js_string()
                .unwrap_or(provider);
            let home = account_home(&this.0.data, key);
            if command["type"] == LOGOUT {
                let account = command["providerAccountId"]
                    .as_js_string()
                    .ok_or_else(|| anyhow!("Missing provider account identity."))?;
                return this
                    .0
                    .codex
                    .with_retired_account(home.clone(), (provider.clone(), account.clone()), {
                        let this = this.clone();
                        move |retired| {
                            Box::pin(async move {
                                this.0.observations.cancel(&home);
                                retired.await?;
                                this.entry(&home)?.logout(&this.0.host, &home).await?;
                                Ok(json!({"accepted":true}))
                            })
                        }
                    })
                    .await;
            }
            let _guard = this.0.codex.lock_account_home(&home).await;
            let entry = this.entry(&home)?;
            if command["type"] == STATUS {
                return entry.status(&this.0.host, &home).await;
            }
            let login = entry.start(&this.0.host, &home).await?;
            let auth = Arc::downgrade(&this.0);
            let target = home.clone();
            this.0.observations.start(
                home,
                command,
                entry.changed.clone(),
                Arc::new(move |stopped| {
                    let auth = auth.clone();
                    let target = target.clone();
                    Box::pin(async move {
                        let auth = Commands(
                            auth.upgrade()
                                .ok_or_else(|| anyhow!("Provider authentication is stopped."))?,
                        );
                        let _guard = auth.0.codex.lock_account_home(&target).await;
                        if *stopped.borrow() {
                            bail!("Provider authentication observation ended.");
                        }
                        auth.entry(&target)?.status(&auth.0.host, &target).await
                    })
                }),
            );
            Ok(login)
        })
    }

    fn entry(&self, home: &Path) -> Result<Arc<HomeAuth>> {
        let mut state = self.0.state.lock().unwrap();
        if state.closed {
            bail!("Provider authentication is stopped.");
        }
        Ok(state.homes.entry(home.to_path_buf()).or_default().clone())
    }

    /// The caller owns the account home guard until its mutation is settled.
    pub(crate) async fn retire(&self, home: &Path, clear: bool) -> Result<()> {
        if clear {
            self.0.observations.cancel(home);
        }
        let entry = self.0.state.lock().unwrap().homes.get(home).cloned();
        if let Some(entry) = entry {
            entry.close().await?;
            self.0.state.lock().unwrap().homes.remove(home);
        }
        Ok(())
    }

    pub fn close(&self) -> Work<()> {
        let homes = {
            let mut state = self.0.state.lock().unwrap();
            state.closed = true;
            std::mem::take(&mut state.homes)
        };
        owned(async move {
            futures::future::join_all(
                homes
                    .into_values()
                    .map(|entry| async move { entry.close().await }),
            )
            .await
            .into_iter()
            .collect::<Result<()>>()
        })
    }
}

#[derive(Default)]
struct Login {
    pending: Option<JsString>,
    rejected: Option<&'static str>,
    completions: IndexMap<JsString, Completion>,
    quota: Option<(Instant, Value)>,
}

#[derive(Clone, Copy)]
struct Completion {
    succeeded: bool,
    failure: &'static str,
}

impl Login {
    fn complete(&mut self, completion: Completion) {
        self.pending = None;
        self.rejected = (!completion.succeeded).then_some(completion.failure);
        self.quota = None;
    }

    fn observe(&mut self, event: &Value) -> bool {
        if event["method"] == "account/updated" {
            return true;
        }
        let params = &event["params"];
        if event["method"] == "account/login/completed"
            && let (Some(id), Some(succeeded)) = (
                params["loginId"].as_js_string(),
                params["success"].as_bool(),
            )
        {
            let failure = params["error"]
                .as_js_string()
                .map(JsString::lossy)
                .unwrap_or_default()
                .to_lowercase();
            let failure = if failure.contains("expired") {
                "The ChatGPT sign-in code expired."
            } else if failure.contains("cancel") {
                "ChatGPT sign-in was cancelled."
            } else if failure.contains("denied") {
                "ChatGPT sign-in was denied."
            } else {
                "ChatGPT sign-in failed."
            };
            let completion = Completion { succeeded, failure };
            if self.pending.as_ref() == Some(id) {
                self.complete(completion);
                return true;
            }
            self.completions.insert(id.clone(), completion);
            if self.completions.len() > 8 {
                self.completions.shift_remove_index(0);
            }
        }
        false
    }
}

#[derive(Default)]
struct HomeAuth {
    client: AsyncMutex<Option<Client>>,
    login: Arc<Mutex<Login>>,
    changed: Arc<Notify>,
}

impl HomeAuth {
    async fn client(&self, host: &Host, home: &Path) -> Result<Client> {
        let mut current = self.client.lock().await;
        if let Some(client) = &*current {
            if !client.is_closed() {
                return Ok(client.clone());
            }
            client.close().await?;
            *current = None;
        }
        cantrip_host::files::private_directory(home)?;
        let login = self.login.clone();
        let changed = self.changed.clone();
        let client = Client::spawn_auth(
            &host.binary,
            home,
            &host.cwd,
            &host.environment,
            Arc::new(move |event| {
                if login.lock().unwrap().observe(event) {
                    changed.notify_one();
                }
            }),
        )
        .await?;
        *current = Some(client.clone());
        let initialized = async {
            rpc(
                &client,
                "initialize",
                Some(json!({
                    "clientInfo":json!({"name":"cantrip","title":"Cantrip","version":"0.0.0"})
                })),
            )
            .await?;
            client.notify("initialized".into(), Some(json!({})))
        }
        .await;
        if let Err(error) = initialized {
            client.close().await?;
            *current = None;
            return Err(error);
        }
        Ok(client)
    }

    async fn status(&self, host: &Host, home: &Path) -> Result<Value> {
        let client = self.client(host, home).await?;
        let result = rpc(&client, "account/read", Some(json!({"refreshToken":false}))).await?;
        let account = &result["account"];
        let chatgpt = account["type"] == "chatgpt";
        let weekly = if chatgpt {
            self.weekly_usage(&client).await
        } else {
            Value::Null
        };
        let login = self.login.lock().unwrap();
        let auth_mode = match account["type"].as_str() {
            Some("chatgpt") => Some("chatgpt"),
            Some("apiKey") => Some("apiKey"),
            _ if account.is_null() => None,
            _ => Some("other"),
        };
        checked(
            "codexAuthStatusSchema",
            &json!({
                "authenticated":!account.is_null(),"authMode":auth_mode,
                "email":if chatgpt { account["email"].clone() } else { Value::Null },
                "planType":if chatgpt { account["planType"].clone() } else { Value::Null },
                "weeklyUsage":weekly,"loginPending":login.pending.is_some(),"loginError":login.rejected
            }),
        )
    }

    async fn weekly_usage(&self, client: &Client) -> Value {
        if let Some((at, value)) = &self.login.lock().unwrap().quota
            && at.elapsed() < Duration::from_secs(30)
        {
            return value.clone();
        }
        let Ok(result) = rpc(client, "account/rateLimits/read", None).await else {
            return Value::Null;
        };
        let weekly = weekly_projection(&result);
        self.login.lock().unwrap().quota = Some((Instant::now(), weekly.clone()));
        weekly
    }

    async fn start(&self, host: &Host, home: &Path) -> Result<Value> {
        let client = self.client(host, home).await?;
        let result = rpc(
            &client,
            "account/login/start",
            Some(json!({"type":"chatgptDeviceCode"})),
        )
        .await?;
        if result["type"] != "chatgptDeviceCode" {
            bail!("Codex did not start a ChatGPT device-code login.");
        }
        let device = checked("codexDeviceLoginSchema", &result)?;
        let id = device["loginId"].as_js_string().unwrap();
        let mut login = self.login.lock().unwrap();
        login.pending = Some(id.clone());
        login.rejected = None;
        if let Some(completed) = login.completions.shift_remove(id) {
            login.complete(completed);
        }
        self.changed.notify_one();
        Ok(device)
    }

    async fn logout(&self, host: &Host, home: &Path) -> Result<()> {
        let client = self.client(host, home).await?;
        let pending = self.login.lock().unwrap().pending.clone();
        if let Some(id) = pending {
            let _ = rpc(&client, "account/login/cancel", Some(json!({"loginId":id}))).await;
        }
        rpc(&client, "account/logout", None).await?;
        *self.login.lock().unwrap() = Login::default();
        self.changed.notify_one();
        Ok(())
    }

    async fn close(&self) -> Result<()> {
        let mut current = self.client.lock().await;
        if let Some(client) = &*current {
            client.close().await?;
            *current = None;
        }
        Ok(())
    }
}

async fn rpc(client: &Client, method: &str, params: Option<Value>) -> Result<Value> {
    let response = client.request(method.into(), params).await?;
    if response.get("error").is_some() {
        // Authentication responses can contain device-flow or credential material.
        bail!("Codex authentication request {method} failed.");
    }
    Ok(response["result"].clone())
}

fn weekly_projection(result: &Value) -> Value {
    let canonical = result
        .get("rateLimits")
        .filter(|v| !v.is_null())
        .unwrap_or(&result["rateLimitsByLimitId"]["codex"]);
    ["primary", "secondary"]
        .into_iter()
        .map(|slot| &canonical[slot])
        .find(|window| window["windowDurationMins"].as_u64() == Some(10_080))
        .filter(|window| {
            window["usedPercent"]
                .as_f64()
                .is_some_and(|value| (0.0..=100.0).contains(&value))
        })
        .map_or(
            Value::Null,
            |window| json!({"usedPercent":window["usedPercent"],"resetsAt":window["resetsAt"]}),
        )
}
