//! Real host PTY service supervision. Terminal attachment/canonical rendering
//! are separate consumers of these process/output lifetimes and remain pending.
pub(crate) mod interactive;
mod output;
mod private_state;
mod service;
use crate::{encryption::Service, filesystem::Scope, logging::Logs, routing::Registry};
use anyhow::{Result, anyhow, bail};
use cantrip_wire::{JsString, Value, value::json};
use indexmap::IndexMap;
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{sync::watch, task::JoinSet};

#[derive(Clone, PartialEq, Eq)]
pub struct Configuration {
    pub terminal_id: JsString,
    pub cwd: PathBuf,
    pub command: JsString,
}
impl Configuration {
    pub fn open_host(input: &Value, encryption: &Service) -> Result<Self> {
        private_state::open(input, encryption)
    }
}
#[derive(Clone)]
struct Desired {
    configuration: Option<Configuration>,
    restart: u64,
    closing: bool,
}
#[derive(Default)]
struct State {
    buffer: Vec<u16>,
    truncated: bool,
    boundary: u64,
    generation: u64,
    restarts: u64,
    phase: &'static str,
    exit: Option<i32>,
}
impl State {
    fn append(&mut self, text: &str) {
        self.boundary += 1;
        self.buffer.extend(text.encode_utf16());
        if self.buffer.len() > 2_000_000 {
            self.truncated = true;
            self.buffer.drain(..self.buffer.len() - 2_000_000);
        }
    }
    fn reset(&mut self) {
        self.buffer.clear();
        self.truncated = false;
        self.boundary = 0;
        self.exit = None;
    }
    fn value(&self) -> Value {
        json!({"buffer":JsString::new(self.buffer.clone()),"truncated":self.truncated,"outputBoundary":self.boundary,"processGeneration":self.generation,"restartCount":self.restarts,"phase":self.phase,"exitCode":self.exit})
    }
}
struct Entry {
    control: watch::Sender<Desired>,
    state: Arc<Mutex<State>>,
}
#[derive(Default)]
struct Inner {
    closing: bool,
    entries: IndexMap<JsString, Entry>,
    jobs: JoinSet<()>,
    fingerprint: String,
}
pub struct Manager {
    inner: tokio::sync::Mutex<Inner>,
    environment: HashMap<String, String>,
    logs: Arc<Logs>,
    delay: Duration,
}
impl Manager {
    pub fn new(environment: HashMap<String, String>, logs: Arc<Logs>) -> Self {
        Self::with_restart_delay(environment, logs, Duration::from_secs(5))
    }
    /// The delay is explicit for owned local lifecycle fixtures. Production
    /// always uses the source's five-second retry policy through `new`.
    pub fn with_restart_delay(
        environment: HashMap<String, String>,
        logs: Arc<Logs>,
        delay: Duration,
    ) -> Self {
        Self {
            inner: tokio::sync::Mutex::new(Inner::default()),
            environment,
            logs,
            delay,
        }
    }
    pub(crate) async fn execute(
        &self,
        command: &Value,
        encryption: &Service,
        registry: &Registry,
        scope: &Scope,
        shells: &interactive::Shells,
    ) -> Result<Value> {
        scope.check()?;
        let command = registry.resolve(command).await?;
        match command["type"].as_str() {
            Some("terminal.services.reconcile") => {
                let result = async {
                    let configurations = command["services"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|value| Configuration::open_host(value, encryption))
                        .collect::<Result<Vec<_>>>()?;
                    scope.check()?;
                    let _transition = shells.transition().await;
                    shells
                        .retire_for_services(encryption, &configurations)
                        .await?;
                    self.reconcile(configurations).await
                }
                .await;
                result.map_err(|_| anyhow!("Terminal services could not be reconciled."))?;
            }
            Some("terminal.service.restart") => {
                self.restart(command["terminalId"].as_js_string().unwrap())
                    .await?
            }
            _ => bail!("Unsupported terminal service operation."),
        }
        Ok(json!({"accepted":true}))
    }
    pub async fn reconcile(&self, configurations: Vec<Configuration>) -> Result<()> {
        let mut desired = IndexMap::new();
        for configuration in configurations.iter().cloned() {
            desired.insert(configuration.terminal_id.clone(), configuration);
        }
        let mut inner = self.inner.lock().await;
        if inner.closing {
            bail!("Terminal manager is stopping.");
        }
        while let Some(result) = inner.jobs.try_join_next() {
            result?;
        }
        for (id, entry) in &inner.entries {
            if !desired.contains_key(id) && entry.control.borrow().configuration.is_some() {
                entry.control.send_modify(|control| {
                    control.configuration = None;
                    control.restart += 1;
                });
            }
        }
        for (id, configuration) in &desired {
            if let Some(entry) = inner.entries.get(id) {
                if entry.control.borrow().configuration.as_ref() != Some(configuration) {
                    entry.control.send_modify(|control| {
                        control.configuration = Some(configuration.clone());
                        control.restart += 1;
                    });
                }
            } else {
                let state = Arc::new(Mutex::new(State::default()));
                let (control, receive) = watch::channel(Desired {
                    configuration: Some(configuration.clone()),
                    restart: 0,
                    closing: false,
                });
                inner.entries.insert(
                    id.clone(),
                    Entry {
                        control,
                        state: state.clone(),
                    },
                );
                let (started, ready) = tokio::sync::oneshot::channel();
                inner.jobs.spawn(service::run(
                    id.clone(),
                    receive,
                    state,
                    self.environment.clone(),
                    self.logs.clone(),
                    self.delay,
                    started,
                ));
                ready
                    .await
                    .map_err(|_| anyhow!("Terminal service startup task stopped."))?;
            }
        }
        use sha2::{Digest, Sha256};
        let mut hashes: Vec<String> = desired
            .values()
            .map(|c| {
                let value = format!(
                    "{}\0{}\0{}",
                    c.terminal_id.lossy(),
                    crate::filesystem::paths::text(&c.cwd).lossy(),
                    c.command.lossy()
                );
                Sha256::digest(value.as_bytes())
                    .iter()
                    .map(|b| format!("{b:02x}"))
                    .collect()
            })
            .collect();
        hashes.sort();
        let fingerprint = hashes.join("|");
        if fingerprint != inner.fingerprint {
            inner.fingerprint = fingerprint;
            self.logs.event("info","Terminal services reconciled",json!({"event":"terminal.service.reconciled","subsystem":"terminal","operation":"reconcile-services","status":"completed","counts":json!({"configured":configurations.len()})}));
        }
        Ok(())
    }
    pub async fn restart(&self, id: &JsString) -> Result<()> {
        let inner = self.inner.lock().await;
        let entry = inner
            .entries
            .get(id)
            .filter(|e| e.control.borrow().configuration.is_some());
        let Some(entry) = entry else {
            bail!("Terminal service {} is disabled.", id.lossy());
        };
        self.logs.event("info","Terminal service restart requested",json!({"event":"terminal.service.restart-requested","subsystem":"terminal","operation":"restart-service","status":"started","terminalId":id}));
        entry
            .state
            .lock()
            .unwrap()
            .append("\r\n\x1b[90m[Restarting service]\x1b[0m\r\n");
        entry.control.send_modify(|control| control.restart += 1);
        Ok(())
    }
    pub(crate) async fn enabled(&self, id: &JsString) -> bool {
        self.inner
            .lock()
            .await
            .entries
            .get(id)
            .is_some_and(|entry| {
                entry.control.borrow().configuration.is_some()
                    || matches!(entry.state.lock().unwrap().phase, "starting" | "running")
            })
    }
    pub(super) async fn disable(&self, id: &JsString) {
        if let Some(entry) = self.inner.lock().await.entries.get(id) {
            entry.control.send_modify(|control| {
                control.configuration = None;
                control.restart += 1;
            });
        }
    }
    /// Internal output retained for the future terminal attachment adapter; it
    /// is not a plaintext transport endpoint or a canonical terminal snapshot.
    pub async fn output(&self, id: &JsString) -> Option<Value> {
        self.inner
            .lock()
            .await
            .entries
            .get(id)
            .map(|entry| entry.state.lock().unwrap().value())
    }
    pub async fn close(&self) -> Result<()> {
        let mut inner = self.inner.lock().await;
        inner.closing = true;
        for entry in inner.entries.values() {
            entry.control.send_modify(|control| {
                control.configuration = None;
                control.closing = true;
            });
        }
        let mut failure = None;
        while let Some(result) = inner.jobs.join_next().await {
            if let Err(error) = result {
                failure.get_or_insert(error);
            }
        }
        inner.entries.clear();
        if let Some(error) = failure {
            return Err(error.into());
        }
        Ok(())
    }
}
