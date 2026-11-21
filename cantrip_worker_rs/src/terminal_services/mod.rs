//! Host PTY service supervision and shared terminal presentation.
pub(crate) mod interactive;
pub(crate) mod output;
mod presentation;
mod private_state;
mod replay;
mod service;
use crate::{encryption::Service, filesystem::Scope, logging::Logs, routing::Registry};
use anyhow::{Context, Result, anyhow, bail};
use cantrip_wire::{JsString, Value, value::json};
use codex_utils_pty::{ProcessHandle, TerminalSize};
use indexmap::IndexMap;
use presentation::Display;
pub(crate) use private_state::open_host as host_private_state;
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    sync::{mpsc, oneshot, watch},
    task::JoinSet,
};

type Authority = (JsString, JsString);

fn authority(encryption: &Service) -> Result<Authority> {
    let (owner, server) = encryption.bound_identity()?;
    Ok((
        owner,
        server
            .as_js_string()
            .context("Terminal server identity")?
            .clone(),
    ))
}

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

#[derive(Clone, Copy, Default)]
struct ProcessExit {
    code: i32,
    signal: Option<i32>,
}

impl ProcessExit {
    fn observed(process: &ProcessHandle, code: Option<i32>) -> Option<Self> {
        #[cfg(unix)]
        {
            use std::os::unix::process::ExitStatusExt;
            if let Some(signal) = process
                .native_exit_status()
                .and_then(|status| status.signal())
            {
                // The terminal wire reports a signal separately from its exit code.
                return Some(Self {
                    code: 0,
                    signal: Some(signal),
                });
            }
        }
        code.or_else(|| process.exit_code())
            .map(|code| Self { code, signal: None })
    }

    fn result(self) -> Value {
        json!({"status":"exited","exitCode":self.code,"signal":self.signal})
    }
}

struct State {
    display: Arc<Mutex<Display>>,
    size: TerminalSize,
    io: Option<ServiceIo>,
    generation: u64,
    restarts: u64,
    phase: &'static str,
    exit: Option<ProcessExit>,
}

struct ServiceIo {
    writer: mpsc::Sender<Vec<u8>>,
    resize: mpsc::Sender<Resize>,
}

struct Resize {
    size: TerminalSize,
    complete: oneshot::Sender<Result<()>>,
}
impl Resize {
    fn request(
        sender: &mpsc::Sender<Self>,
        size: TerminalSize,
    ) -> Result<oneshot::Receiver<Result<()>>> {
        let (complete, done) = oneshot::channel();
        sender
            .try_send(Self { size, complete })
            .map_err(|_| anyhow!("Terminal resize could not be queued."))?;
        Ok(done)
    }
}

impl Default for State {
    fn default() -> Self {
        let size = TerminalSize::default();
        Self {
            display: Arc::new(Mutex::new(Display::new(size, 0))),
            size,
            io: None,
            generation: 0,
            restarts: 0,
            phase: "starting",
            exit: None,
        }
    }
}

impl State {
    fn append(&mut self, text: &str) {
        self.display.lock().unwrap().write(text);
    }
    fn reset(&mut self) {
        self.generation += 1;
        self.display
            .lock()
            .unwrap()
            .reset(self.size, self.generation);
        self.exit = None;
    }
    fn value(&self) -> Value {
        let display = self.display.lock().unwrap();
        let (buffer, truncated) = display.replay.raw();
        json!({"buffer":buffer,"truncated":truncated,"outputBoundary":display.replay.output_boundary(),"processGeneration":self.generation,"restartCount":self.restarts,"phase":self.phase,"exitCode":self.exit.map(|exit| exit.code)})
    }
    fn resize(&mut self, size: TerminalSize) {
        self.size = size;
        self.display.lock().unwrap().replay.resize(size);
    }
    fn request_resize(
        &mut self,
        size: TerminalSize,
    ) -> Result<Option<oneshot::Receiver<Result<()>>>> {
        if let Some(io) = &self.io {
            Ok(Some(Resize::request(&io.resize, size)?))
        } else {
            self.resize(size);
            Ok(None)
        }
    }
    fn write_input(&self, data: Vec<u8>) -> Result<()> {
        self.io
            .as_ref()
            .context("Terminal service is not running.")?
            .writer
            .try_send(data)
            .map_err(|_| anyhow!("Terminal input could not be written."))
    }
    fn finish(&mut self, exit: Option<ProcessExit>) {
        self.phase = "exited";
        self.exit = exit.or(self.exit);
        self.io = None;
        self.display
            .lock()
            .unwrap()
            .finish(self.exit.unwrap_or_default().result());
    }
}
struct Entry {
    control: watch::Sender<Desired>,
    state: Arc<Mutex<State>>,
}

struct ServiceView {
    state: Arc<Mutex<State>>,
    cwd: Option<PathBuf>,
}
#[derive(Default)]
struct Inner {
    closing: bool,
    entries: IndexMap<JsString, Entry>,
    jobs: JoinSet<()>,
    fingerprint: String,
    authority: Option<Authority>,
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
                    let binding = authority(encryption)?;
                    let configurations = command["services"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|value| Configuration::open_host(value, encryption))
                        .collect::<Result<Vec<_>>>()?;
                    scope.check()?;
                    let _transition = shells.transition().await;
                    anyhow::ensure!(
                        authority(encryption)? == binding,
                        "Terminal service owner changed."
                    );
                    shells
                        .retire_for_services(&binding, &configurations)
                        .await?;
                    anyhow::ensure!(
                        authority(encryption)? == binding,
                        "Terminal service owner changed."
                    );
                    self.reconcile_scoped(configurations, Some(binding)).await
                }
                .await;
                result.map_err(|_| anyhow!("Terminal services could not be reconciled."))?;
            }
            Some("terminal.service.restart") => {
                self.restart_scoped(
                    command["terminalId"].as_js_string().unwrap(),
                    Some(&authority(encryption)?),
                )
                .await?
            }
            _ => bail!("Unsupported terminal service operation."),
        }
        Ok(json!({"accepted":true}))
    }
    pub async fn reconcile(&self, configurations: Vec<Configuration>) -> Result<()> {
        self.reconcile_scoped(configurations, None).await
    }
    async fn reconcile_scoped(
        &self,
        configurations: Vec<Configuration>,
        authority: Option<Authority>,
    ) -> Result<()> {
        let mut desired = IndexMap::new();
        for configuration in configurations.iter().cloned() {
            desired.insert(configuration.terminal_id.clone(), configuration);
        }
        let mut inner = self.inner.lock().await;
        if inner.closing {
            bail!("Terminal manager is stopping.");
        }
        if inner.authority != authority {
            Self::retire(&mut inner).await?;
            inner.authority = authority;
            inner.fingerprint.clear();
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
        self.restart_scoped(id, None).await
    }
    async fn restart_scoped(&self, id: &JsString, authority: Option<&Authority>) -> Result<()> {
        let inner = self.inner.lock().await;
        let entry = inner
            .entries
            .get(id)
            .filter(|e| e.control.borrow().configuration.is_some());
        let Some(entry) = entry else {
            bail!("Terminal service {} is disabled.", id.lossy());
        };
        anyhow::ensure!(
            inner.authority.as_ref() == authority,
            "Terminal service owner changed."
        );
        self.logs.event("info","Terminal service restart requested",json!({"event":"terminal.service.restart-requested","subsystem":"terminal","operation":"restart-service","status":"started","terminalId":id}));
        entry
            .state
            .lock()
            .unwrap()
            .append("\r\n\x1b[90m[Restarting service]\x1b[0m\r\n");
        entry.control.send_modify(|control| control.restart += 1);
        Ok(())
    }
    async fn view(&self, id: &JsString, authority: &Authority) -> Result<Option<ServiceView>> {
        let inner = self.inner.lock().await;
        let Some(entry) = inner.entries.get(id) else {
            return Ok(None);
        };
        let cwd = entry
            .control
            .borrow()
            .configuration
            .as_ref()
            .map(|config| config.cwd.clone());
        if cwd.is_none() && !matches!(entry.state.lock().unwrap().phase, "starting" | "running") {
            return Ok(None);
        }
        anyhow::ensure!(
            inner.authority.as_ref() == Some(authority),
            "Terminal service owner changed."
        );
        Ok(Some(ServiceView {
            state: entry.state.clone(),
            cwd,
        }))
    }
    async fn disable(&self, id: &JsString, authority: &Authority) {
        let inner = self.inner.lock().await;
        if inner.authority.as_ref() == Some(authority)
            && let Some(entry) = inner.entries.get(id)
        {
            entry.control.send_modify(|control| {
                control.configuration = None;
                control.restart += 1;
            });
        }
    }
    /// Inspect local service state in the native lifecycle fixtures.
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
        Self::retire(&mut inner).await
    }

    async fn retire(inner: &mut Inner) -> Result<()> {
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
