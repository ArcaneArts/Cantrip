mod guest;
mod process;
mod stream;

pub(crate) use stream::{LinkTarget, LinkedTerminal};

use super::{
    Authority, Configuration, Manager as Services, Resize, authority,
    presentation::{Attachment, Display, Transport, detached},
    private_state,
};
use crate::{
    cantrip_os::terminal,
    codex::turn::Turns,
    connection::Outbound,
    encryption::Service,
    filesystem::Scope,
    logging::Logs,
    protected_content::{SurfaceStreamReplayGuard, open_surface_content, protect_surface_content},
    routing::Registry,
};
use anyhow::{Context, Result, anyhow, bail};
use cantrip_crypto::checked;
use cantrip_wire::{JsString, Value, payload_digest, value::json};
use codex_utils_pty::TerminalSize;
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tokio::{
    sync::{mpsc, oneshot, watch},
    task::JoinSet,
};

#[derive(Clone, PartialEq, Eq, Hash)]
struct Key {
    authority: Authority,
    terminal: JsString,
}

struct Entry {
    location: Location,
    stop: watch::Sender<bool>,
    done: watch::Receiver<bool>,
    writer: mpsc::Sender<Vec<u8>>,
    resize: mpsc::Sender<Resize>,
    state: Arc<Mutex<Display>>,
    managed_generation: Arc<Mutex<Value>>,
}

#[derive(Clone, PartialEq, Eq)]
enum Location {
    Host(PathBuf),
    Guest(String),
    Console(String),
}

enum Launch {
    Host(Configuration),
    Guest(terminal::Target),
    Console { command: Value, cwd: JsString },
}

#[derive(Default)]
struct Inner {
    entries: HashMap<Key, Entry>,
    jobs: JoinSet<()>,
}

pub(crate) struct Shells {
    inner: tokio::sync::Mutex<Inner>,
    environment: HashMap<String, String>,
    logs: Arc<Logs>,
    services: Arc<Services>,
    replay: Arc<Mutex<SurfaceStreamReplayGuard>>,
    transition: tokio::sync::Mutex<()>,
    generation: String,
    guests: terminal::Store,
}

pub(crate) struct Ports<'a> {
    pub encryption: &'a Arc<Service>,
    pub routes: &'a Registry,
    pub scope: &'a Scope,
    pub codex_binary: &'a std::path::Path,
    pub turns: &'a Turns,
    pub outbound: &'a Arc<Outbound>,
    pub request_id: &'a Value,
    pub socket_epoch: u64,
}

impl Shells {
    pub(crate) fn supports(command: &str) -> bool {
        matches!(
            command,
            "terminal.prepare-state"
                | "terminal.open"
                | "terminal.detach"
                | "terminal.input"
                | "terminal.resize"
                | "terminal.close"
                | "terminal.snapshot"
        )
    }

    pub(crate) fn new(
        environment: HashMap<String, String>,
        logs: Arc<Logs>,
        services: Arc<Services>,
        replay: Arc<Mutex<SurfaceStreamReplayGuard>>,
        generation: String,
        data: &std::path::Path,
    ) -> Self {
        Self {
            inner: Default::default(),
            environment,
            logs,
            services,
            replay,
            transition: Default::default(),
            generation,
            guests: terminal::Store::new(data),
        }
    }

    fn key(command: &Value, encryption: &Service) -> Result<Key> {
        let authority = authority(encryption)?;
        if command
            .get("serverId")
            .is_some_and(|declared| declared.as_js_string() != Some(&authority.1))
        {
            bail!("Terminal belongs to another server.");
        }
        Ok(Key {
            authority,
            terminal: command["terminalId"]
                .as_js_string()
                .context("Terminal identity")?
                .clone(),
        })
    }

    pub(crate) async fn execute(&self, command: &Value, ports: Ports<'_>) -> Result<Value> {
        ports.scope.check()?;
        anyhow::ensure!(
            *ports.outbound.stream_epoch().borrow() == ports.socket_epoch,
            "Terminal command belongs to a disconnected socket.",
        );
        let key = Self::key(command, ports.encryption)?;
        match command["type"].as_str() {
            Some("terminal.prepare-state") => {
                private_state::prepare_console(command, ports.encryption)
            }
            Some("terminal.open") => self
                .open(command, key, &ports)
                .await
                .map_err(|_| anyhow!("The terminal could not be opened.")),
            Some("terminal.detach") => {
                self.detach(&key, command["attachmentId"].as_js_string().unwrap())
                    .await;
                Ok(detached())
            }
            Some("terminal.input") => self.input(command, &key, ports.encryption, true).await,
            Some("terminal.snapshot") => self.snapshot(command, &key, ports.encryption).await,
            Some("terminal.resize") => {
                self.resize(&key, size(command)).await?;
                Ok(json!({"accepted":true}))
            }
            Some("terminal.close") => {
                let _transition = self.transition().await;
                let pending = {
                    let inner = self.inner.lock().await;
                    inner.entries.get(&key).map(|entry| {
                        entry.stop.send_replace(true);
                        entry.done.clone()
                    })
                };
                if let Some(mut done) = pending {
                    done.wait_for(|finished| *finished)
                        .await
                        .context("Terminal retirement was not confirmed")?;
                    self.inner.lock().await.entries.remove(&key);
                }
                self.guests
                    .close(&key.terminal, &key.authority, ports.encryption.worker_id())
                    .await?;
                self.services.disable(&key.terminal, &key.authority).await;
                Ok(json!({"accepted":true}))
            }
            _ => bail!("Unsupported host terminal operation."),
        }
    }

    async fn open(&self, command: &Value, key: Key, ports: &Ports<'_>) -> Result<Value> {
        let command = ports.routes.resolve(command).await?;
        let guest = command["worktreePath"].is_object();
        let launch = match (command["launch"]["type"].as_str(), guest) {
            (Some("shell"), false) => {
                Launch::Host(private_state::open_host(&command, ports.encryption)?)
            }
            (Some("shell" | "codex"), true) => {
                let state = private_state::open_state(&command, ports.encryption)?;
                let target = terminal::Target::new(
                    &command,
                    &state["directory"],
                    &key.authority.0,
                    ports.encryption.worker_id(),
                )?;
                if command["launch"]["type"] == "shell" {
                    Launch::Guest(target)
                } else {
                    let mut launch = command["launch"].clone();
                    anyhow::ensure!(
                        launch["session"].is_object(),
                        "The managed console requires a Chat session."
                    );
                    if let Some(declared) = launch["session"].get("osExecution") {
                        anyhow::ensure!(
                            *declared == command["worktreePath"],
                            "The console's Linux placement changed."
                        );
                    }
                    launch["session"]["osExecution"] = command["worktreePath"].clone();
                    Launch::Console {
                        command: launch,
                        cwd: target.cwd().into(),
                    }
                }
            }
            (Some("codex"), false) => {
                let configuration = private_state::open_host(&command, ports.encryption)?;
                let launch = command["launch"].clone();
                anyhow::ensure!(
                    launch["session"].is_object() && launch["session"]["osExecution"].is_null(),
                    "The console requires a managed Host Chat session."
                );
                Launch::Console {
                    command: launch,
                    cwd: crate::filesystem::paths::text(&configuration.cwd),
                }
            }
            _ => bail!("The terminal requires a different runtime."),
        };
        let view_id = command["attachmentId"].as_js_string().unwrap();
        let mut connection = ports.outbound.stream_epoch();
        if *connection.borrow_and_update() != ports.socket_epoch {
            return Ok(detached());
        }
        let (complete, done) = oneshot::channel();
        let view = Attachment {
            complete,
            transport: Transport::Command {
                outbound: ports.outbound.clone(),
                request_id: ports
                    .request_id
                    .as_js_string()
                    .context("Terminal request identity")?
                    .clone(),
                epoch: ports.socket_epoch,
            },
            binding: binding(&command, "output"),
            encryption: ports.encryption.clone(),
            owner: key.authority.0.clone(),
            discard: command["outputMode"] == "discard",
            sequence: 0,
        };
        let display = {
            let _transition = self.transition().await;
            ports.scope.check()?;
            anyhow::ensure!(
                authority(ports.encryption)? == key.authority,
                "Terminal owner changed."
            );
            if !matches!(launch, Launch::Guest(_)) {
                self.guests.assert_host(&key.terminal, &key.authority)?;
            }
            let display = if let Some(view) =
                self.services.view(&key.terminal, &key.authority).await?
            {
                anyhow::ensure!(
                    matches!(&launch, Launch::Host(configuration) if view.cwd.as_ref() == Some(&configuration.cwd)),
                    "Terminal service belongs to a different source folder or is stopping."
                );
                view.state.lock().unwrap().display.clone()
            } else {
                self.shell(
                    &key,
                    launch,
                    size(&command),
                    &command["managedPreparationGeneration"],
                    ports,
                )
                .await?
            };
            let finished = display.lock().unwrap().attach(view_id, view)?;
            if let Some(result) = finished {
                return Ok(result);
            }
            display
        };
        let result = tokio::select! {
            result = done => result.unwrap_or_else(|_| Ok(detached())),
            _ = connection.changed() => Ok(detached()),
            _ = ports.scope.stopped() => Ok(detached()),
        };
        self.detach_view(&display, view_id);
        self.replay
            .lock()
            .unwrap()
            .release(&binding(&command, "input"));
        checked("terminalOpenResultSchema", &result?)
    }

    async fn shell(
        &self,
        key: &Key,
        launch: Launch,
        size: TerminalSize,
        managed_generation: &Value,
        ports: &Ports<'_>,
    ) -> Result<Arc<Mutex<Display>>> {
        let mut inner = self.inner.lock().await;
        ports.scope.check()?;
        while let Some(result) = inner.jobs.try_join_next() {
            result?;
        }
        let location = match &launch {
            Launch::Host(configuration) => Location::Host(configuration.cwd.clone()),
            Launch::Guest(target) => Location::Guest(target.identity.clone()),
            Launch::Console { command, cwd } => Location::Console(payload_digest(&json!({
                "session":command["session"], "threadId":command["threadId"],
                "modelRouteId":command["model"]["routeId"], "providerId":command["provider"]["id"],
                "providerAccountId":command["provider"]["accountId"], "cwd":cwd,
            }))),
        };
        if inner
            .entries
            .get(key)
            .is_some_and(|entry| entry.state.lock().unwrap().exited.is_some())
        {
            inner.entries.remove(key);
        }
        if !inner.entries.contains_key(key) {
            let preparation = Arc::new(Mutex::new(managed_generation.clone()));
            let exited = {
                let key = key.clone();
                let generation = self.generation.clone();
                let encryption = ports.encryption.clone();
                let outbound = ports.outbound.clone();
                let preparation = preparation.clone();
                move |result: &Value| {
                    if encryption.bound_identity().is_ok_and(|(owner, server)| {
                        owner == key.authority.0 && server.as_js_string() == Some(&key.authority.1)
                    }) {
                        let mut notification = json!({"type":"terminal.runtime.observed",
                            "workerProcessGeneration":generation,"terminalId":key.terminal,
                            "status":"exited","exitCode":result["exitCode"],"signal":result["signal"],
                        });
                        if let Some(preparation) = preparation.lock().unwrap().as_js_string() {
                            notification["managedPreparationGeneration"] = json!(preparation);
                        }
                        let _ = outbound.notification(notification);
                    }
                }
            };
            match launch {
                Launch::Host(configuration) => {
                    let (mut entry, actor) = process::spawn(
                        process::Local::Shell(configuration.cwd, self.environment.clone()),
                        location.clone(),
                        key.terminal.clone(),
                        size,
                        self.logs.clone(),
                        exited,
                    )
                    .await?;
                    entry.managed_generation = preparation;
                    inner.jobs.spawn(actor);
                    inner.entries.insert(key.clone(), entry);
                }
                Launch::Console { command, cwd } => {
                    let launch = ports
                        .turns
                        .launch_console(
                            ports.codex_binary.to_path_buf(),
                            command,
                            cwd,
                            self.environment.clone(),
                        )
                        .await?;
                    ports.scope.check()?;
                    anyhow::ensure!(
                        authority(ports.encryption)? == key.authority,
                        "Terminal owner changed."
                    );
                    let (mut entry, actor) = process::spawn(
                        process::Local::Console(Box::new(launch)),
                        location.clone(),
                        key.terminal.clone(),
                        size,
                        self.logs.clone(),
                        exited,
                    )
                    .await?;
                    entry.managed_generation = preparation;
                    inner.jobs.spawn(actor);
                    inner.entries.insert(key.clone(), entry);
                }
                Launch::Guest(target) => {
                    match self
                        .guests
                        .open(&key.terminal, &key.authority, target, size, ports.scope)
                        .await?
                    {
                        terminal::Opened::Live(pty) => {
                            let (entry, actor) = guest::spawn(pty, location, size, exited);
                            let display = entry.state.clone();
                            inner.jobs.spawn(actor);
                            inner.entries.insert(key.clone(), entry);
                            return Ok(display);
                        }
                        terminal::Opened::Exited(result) => {
                            let mut state = Display::new(size);
                            state.finish(result);
                            return Ok(Arc::new(Mutex::new(state)));
                        }
                    }
                }
            }
        }
        let entry = &inner.entries[key];
        anyhow::ensure!(
            entry.location == location && !*entry.stop.borrow(),
            "Terminal belongs to another source folder or is stopping.",
        );
        if !managed_generation.is_null() {
            *entry.managed_generation.lock().unwrap() = managed_generation.clone();
        }
        Ok(entry.state.clone())
    }

    async fn detach(&self, key: &Key, view: &JsString) {
        let shell = self
            .inner
            .lock()
            .await
            .entries
            .get(key)
            .map(|entry| entry.state.clone());
        if let Some(shell) = shell {
            self.detach_view(&shell, view);
        }
        if let Ok(Some(service)) = self.services.view(&key.terminal, &key.authority).await {
            let display = service.state.lock().unwrap().display.clone();
            self.detach_view(&display, view);
        }
    }

    fn detach_view(&self, display: &Mutex<Display>, view: &JsString) {
        let binding = display.lock().unwrap().detach(view);
        if let Some(binding) = binding {
            self.replay.lock().unwrap().release(&binding);
        }
    }

    async fn resize(&self, key: &Key, size: TerminalSize) -> Result<()> {
        let completion = {
            let _transition = self.transition().await;
            if let Some(service) = self.services.view(&key.terminal, &key.authority).await? {
                anyhow::ensure!(service.cwd.is_some(), "Terminal service is stopping.");
                service.state.lock().unwrap().request_resize(size)?
            } else {
                let inner = self.inner.lock().await;
                let entry = inner
                    .entries
                    .get(key)
                    .filter(|entry| !*entry.stop.borrow())
                    .ok_or_else(|| not_running(key))?;
                Some(Resize::request(&entry.resize, size)?)
            }
        };
        if let Some(done) = completion {
            done.await.map_err(|_| not_running(key))??;
        }
        Ok(())
    }

    async fn input(
        &self,
        command: &Value,
        key: &Key,
        encryption: &Service,
        reply: bool,
    ) -> Result<Value> {
        let _transition = self.transition().await;
        let service = self.services.view(&key.terminal, &key.authority).await?;
        let inner = self.inner.lock().await;
        anyhow::ensure!(
            authority(encryption)? == key.authority,
            "Terminal owner changed."
        );
        let context = binding(command, "input");
        let mut replay = self.replay.lock().unwrap();
        replay.reserve(&context)?;
        let input = open_surface_content(
            encryption,
            &context,
            &command["protectedData"],
            "terminalInputContentSchema",
        )?;
        let data = input["data"]
            .as_js_string()
            .unwrap()
            .lossy()
            .as_bytes()
            .to_vec();
        if let Some(service) = service {
            anyhow::ensure!(service.cwd.is_some(), "Terminal service is stopping.");
            service.state.lock().unwrap().write_input(data)?;
        } else {
            let entry = inner
                .entries
                .get(key)
                .filter(|entry| !*entry.stop.borrow())
                .ok_or_else(|| not_running(key))?;
            entry
                .writer
                .try_send(data)
                .map_err(|_| anyhow!("Terminal input could not be written."))?;
        }
        let response = if reply {
            seal(
                encryption,
                context,
                &json!({"ok":true,"result":json!({"type":"terminal.input.accepted"})}),
            )?
        } else {
            Value::Null
        };
        replay.accept(&binding(command, "input"), command["complete"] == true)?;
        Ok(response)
    }

    async fn snapshot(&self, command: &Value, key: &Key, encryption: &Service) -> Result<Value> {
        let context = binding(command, "request");
        self.replay.lock().unwrap().reserve(&context)?;
        let input = open_surface_content(
            encryption,
            &context,
            &command["protectedRequest"],
            "terminalSnapshotRequestContentSchema",
        )?;
        let max = input["maxChars"].as_u64().unwrap() as usize;
        let value = if let Some(service) = self.services.view(&key.terminal, &key.authority).await?
        {
            let state = service.state.lock().unwrap();
            let (data, truncated) = state.display.lock().unwrap().replay.tail(max);
            let status = if state.phase == "starting" {
                "restarting"
            } else {
                state.phase
            };
            Some(
                json!({"type":"terminal.snapshot","terminalId":key.terminal,"status":status,
                    "data":data,"truncated":truncated,"exitCode":state.exit.map(|exit| exit.code),
                }),
            )
        } else {
            let inner = self.inner.lock().await;
            inner.entries.get(key).and_then(|entry| {
                let state = entry.state.lock().unwrap();
                if *entry.stop.borrow() && state.exited.is_some() {
                    return None;
                }
                let (data, truncated) = state.replay.tail(max);
                let exit_code = state
                    .exited
                    .as_ref()
                    .and_then(|result| result.get("exitCode"));
                let mut result = json!({"type":"terminal.snapshot","terminalId":key.terminal,
                    "status":if state.exited.is_some() {"exited"} else {"running"},
                    "data":data,"truncated":truncated,"exitCode":exit_code,
                });
                if let Some(outcome) = state
                    .exited
                    .as_ref()
                    .and_then(|result| result.get("executionOutcome"))
                {
                    result["executionOutcome"] = outcome.clone();
                }
                Some(result)
            })
        }
        .unwrap_or_else(|| {
            json!({"type":"terminal.snapshot","terminalId":key.terminal,
                "status":"not-running","data":"","truncated":false,"exitCode":Value::Null,
            })
        });
        let response = seal(
            encryption,
            context.clone(),
            &json!({"ok":true,"result":value}),
        )?;
        self.replay.lock().unwrap().accept(&context, true)?;
        Ok(response)
    }

    pub(super) async fn transition(&self) -> tokio::sync::MutexGuard<'_, ()> {
        self.transition.lock().await
    }

    pub(super) async fn retire_for_services(
        &self,
        authority: &Authority,
        configurations: &[Configuration],
    ) -> Result<()> {
        let mut retiring = Vec::new();
        {
            let inner = self.inner.lock().await;
            for configuration in configurations {
                let key = Key {
                    authority: authority.clone(),
                    terminal: configuration.terminal_id.clone(),
                };
                if let Some(entry) = inner.entries.get(&key) {
                    entry.stop.send_replace(true);
                    retiring.push((key, entry.done.clone()));
                }
            }
        }
        for (key, mut done) in retiring {
            done.wait_for(|value| *value)
                .await
                .context("Terminal retirement was not confirmed")?;
            self.inner.lock().await.entries.remove(&key);
        }
        Ok(())
    }

    pub(crate) async fn shutdown(&self) -> Result<()> {
        let mut inner = self.inner.lock().await;
        for entry in inner.entries.values() {
            entry.stop.send_replace(true);
        }
        while let Some(result) = inner.jobs.join_next().await {
            result?;
        }
        inner.entries.clear();
        Ok(())
    }
}

fn not_running(key: &Key) -> anyhow::Error {
    anyhow!("Terminal {} is not running.", key.terminal)
}

fn size(command: &Value) -> TerminalSize {
    TerminalSize {
        cols: command["cols"].as_u64().unwrap() as u16,
        rows: command["rows"].as_u64().unwrap() as u16,
    }
}

fn binding(command: &Value, direction: &str) -> Value {
    json!({"serverId":command["serverId"],"surfaceKind":"terminal","surfaceId":command["terminalId"],
        "operationId":command["operationId"],"direction":direction,"sequence":command["sequence"]})
}

fn seal(encryption: &Service, mut context: Value, outcome: &Value) -> Result<Value> {
    context["direction"] = json!("response");
    let protected = protect_surface_content(
        encryption,
        &context,
        outcome,
        "surfaceOperationOutcomeContentSchema",
    )?;
    checked(
        "surfaceStreamWireResponseSchema",
        &json!({
            "operationId":context["operationId"],"sequence":context["sequence"],"protectedResponse":protected,
        }),
    )
}
