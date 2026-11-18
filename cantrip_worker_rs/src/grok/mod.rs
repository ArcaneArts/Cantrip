//! Worker-owned Grok device authorization and account state.
pub(crate) mod catalog;
mod credential;
pub(crate) mod http;
mod models;
mod proxy;

use self::{
    credential::{Credential, FILE},
    http::Http,
};
use crate::{
    codex::{catalog::account_home, managed::Worker},
    http::checked,
    provider_auth_observer::Observer,
    provider_credentials::discard,
};
use anyhow::{Result, anyhow, bail};
use cantrip_history::projection::Work;
use cantrip_transport::lifecycle::owned;
use cantrip_wire::{Value, value::json};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use tokio::{
    sync::{Mutex as AsyncMutex, Notify, watch},
    task::JoinHandle,
};

#[cfg(test)]
mod tests;

const STATUS: &str = "codex.auth.status";
const LOGIN: &str = "codex.auth.login.start";
const LOGOUT: &str = "codex.auth.logout";

pub fn supports(command: &Value) -> bool {
    command["providerKind"] == "grok"
        && matches!(command["type"].as_str(), Some(STATUS | LOGIN | LOGOUT))
}

#[derive(Default)]
struct Registry {
    closed: bool,
    homes: HashMap<PathBuf, Arc<Entry>>,
}

struct Inner {
    http: Http,
    data: PathBuf,
    codex: Worker,
    observations: Observer,
    registry: Mutex<Registry>,
}

#[derive(Clone)]
pub struct Commands(Arc<Inner>);

impl Commands {
    pub fn new(
        data: PathBuf,
        codex: Worker,
        observations: Observer,
        environment: &cantrip_config::Environment,
    ) -> Result<Self> {
        let version = environment
            .iter()
            .find(|(key, _)| {
                if cfg!(windows) {
                    key.eq_ignore_ascii_case("CANTRIP_GROK_CLIENT_VERSION")
                } else {
                    key.as_str() == "CANTRIP_GROK_CLIENT_VERSION"
                }
            })
            .map(|(_, value)| cantrip_wire::text::trim(value))
            .filter(|version| !version.is_empty())
            .unwrap_or("1.0.3");
        Ok(Self::with_http(
            Http::new(version.into())?,
            data,
            codex,
            observations,
        ))
    }

    fn with_http(http: Http, data: PathBuf, codex: Worker, observations: Observer) -> Self {
        Self(Arc::new(Inner {
            http,
            data,
            codex,
            observations,
            registry: Mutex::default(),
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
                                this.retire(&home, false).await?;
                                discard(&home.join(FILE)).await?;
                                Ok(json!({"accepted":true}))
                            })
                        }
                    })
                    .await;
            }
            let _guard = this.0.codex.lock_account_home(&home).await;
            let entry = this.entry(&home)?;
            if command["type"] == STATUS {
                return entry.status(&this.0.http, &home).await;
            }
            let device = entry.start(this.0.http.clone(), home.clone()).await?;
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
                                .ok_or_else(|| anyhow!("Grok authentication is stopped."))?,
                        );
                        let _guard = auth.0.codex.lock_account_home(&target).await;
                        if *stopped.borrow() {
                            bail!("Grok authentication observation ended.");
                        }
                        auth.entry(&target)?.status(&auth.0.http, &target).await
                    })
                }),
            );
            Ok(device)
        })
    }

    fn entry(&self, home: &Path) -> Result<Arc<Entry>> {
        let mut registry = self.0.registry.lock().unwrap();
        if registry.closed {
            bail!("Grok authentication is stopped.");
        }
        Ok(registry
            .homes
            .entry(home.to_path_buf())
            .or_default()
            .clone())
    }

    /// Call with the shared account home lock held across retirement and file mutation.
    pub(crate) async fn retire(&self, home: &Path, clear: bool) -> Result<()> {
        if clear {
            self.0.observations.cancel(home);
        }
        let entry = self.0.registry.lock().unwrap().homes.get(home).cloned();
        if let Some(entry) = entry {
            entry.close().await?;
            self.0.registry.lock().unwrap().homes.remove(home);
        }
        Ok(())
    }

    pub fn close(&self) -> Work<()> {
        let homes = {
            let mut registry = self.0.registry.lock().unwrap();
            registry.closed = true;
            std::mem::take(&mut registry.homes)
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

struct Login {
    id: String,
    stop: watch::Sender<bool>,
    task: JoinHandle<()>,
}

#[derive(Default)]
struct State {
    closed: bool,
    credential: Credential,
    login: Option<Login>,
    login_error: Option<String>,
    portable_quota: Option<catalog::CachedQuota>,
}

#[derive(Default)]
struct Entry {
    state: AsyncMutex<State>,
    changed: Arc<Notify>,
    proxy: AsyncMutex<Option<proxy::account::AccountProxy>>,
}

impl Entry {
    async fn close(&self) -> Result<()> {
        let mut slot = self.proxy.lock().await;
        self.state.lock().await.closed = true;
        let proxy = slot.take();
        let (closed, stopped) = tokio::join!(
            async move {
                match proxy {
                    Some(proxy) => proxy.close().await,
                    None => Ok(()),
                }
            },
            self.stop(true)
        );
        closed?;
        stopped
    }

    async fn status(&self, http: &Http, home: &Path) -> Result<Value> {
        let mut state = self.state.lock().await;
        if state.closed {
            bail!("Grok authentication is stopped.");
        }
        let State {
            credential,
            login_error,
            login,
            ..
        } = &mut *state;
        let (credential, weekly) = credential.status(http, home, login_error).await;
        let credential = credential.as_ref();
        checked(
            "codexAuthStatusSchema",
            &json!({
                "authenticated":credential.is_some(),"authMode":credential.map(|_| "grok"),
                "email":credential.map(|value| &value["email"]),
                "planType":credential.map(|value| &value["planType"]),
                "weeklyUsage":weekly,"loginPending":login.is_some(),"loginError":login_error.as_deref(),
            }),
        )
    }

    async fn start(self: &Arc<Self>, http: Http, home: PathBuf) -> Result<Value> {
        self.stop(false).await?;
        let id = uuid::Uuid::new_v4().to_string();
        let device = http.start(&id).await?;
        let reply = device.reply.clone();
        let mut state = self.state.lock().await;
        if state.closed {
            bail!("Grok authentication is stopped.");
        }
        let this = self.clone();
        let (stop, mut stopped) = watch::channel(false);
        let login_id = id.clone();
        let task = tokio::spawn(async move {
            let result = tokio::select! {
                biased;
                _ = stopped.changed() => return,
                result = http.poll(device) => result,
            };
            let mut state = this.state.lock().await;
            if state.closed
                || state
                    .login
                    .as_ref()
                    .is_none_or(|login| login.id != login_id)
            {
                return;
            }
            let outcome = match result {
                Ok(payload) => state.credential.accept(&http, &home, &payload).await,
                Err(error) => Err(error),
            };
            state.login = None;
            state.login_error = outcome.err().map(|error| error.to_string());
            this.changed.notify_one();
        });
        state.login = Some(Login { id, stop, task });
        self.changed.notify_one();
        Ok(reply)
    }

    async fn stop(&self, close: bool) -> Result<()> {
        let pending = {
            let mut state = self.state.lock().await;
            state.closed |= close;
            state.login_error = None;
            state.login.take()
        };
        if let Some(pending) = pending {
            pending.stop.send_replace(true);
            pending.task.await?;
        }
        self.changed.notify_one();
        Ok(())
    }
}
