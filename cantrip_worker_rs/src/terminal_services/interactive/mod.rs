mod process;
mod replay;

use super::{Configuration, Manager as Services, private_state};
use crate::{
    connection::Outbound,
    encryption::Service,
    filesystem::Scope,
    logging::Logs,
    protected_content::{SurfaceStreamReplayGuard, open_surface_content, protect_surface_content},
    routing::Registry,
};
use anyhow::{Context, Result, anyhow, bail};
use cantrip_crypto::checked;
use cantrip_wire::{JsString, Value, value::json};
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
    owner: JsString,
    server: JsString,
    terminal: JsString,
}

struct Attachment {
    complete: oneshot::Sender<Result<Value>>,
    outbound: Arc<Outbound>,
    request_id: JsString,
    epoch: u64,
    binding: Value,
    encryption: Arc<Service>,
    owner: JsString,
    discard: bool,
    sequence: u64,
}

fn detached() -> Value {
    json!({"status":"detached"})
}

impl Attachment {
    fn emit(&self, event: Value) -> Result<()> {
        let (owner, server) = self.encryption.bound_identity()?;
        anyhow::ensure!(
            owner == self.owner && server == self.binding["serverId"],
            "Terminal owner changed."
        );
        anyhow::ensure!(
            self.outbound.terminal_event(
                self.epoch,
                json!({"kind":"event","requestId":self.request_id,"event":event}),
            )?,
            "Terminal output attachment closed."
        );
        Ok(())
    }

    fn output(&mut self, data: &JsString) -> Result<()> {
        if self.discard {
            return Ok(());
        }
        let mut offset = 0;
        loop {
            let units = data.units();
            let mut end = (offset + 32 * 1024).min(units.len());
            if end < units.len()
                && (0xd800..=0xdbff).contains(&units[end - 1])
                && (0xdc00..=0xdfff).contains(&units[end])
            {
                end -= 1;
            }
            self.binding["sequence"] = json!(self.sequence);
            let protected = protect_surface_content(
                &self.encryption,
                &self.binding,
                &json!({"type":"terminal.output","data":JsString::new(units[offset..end].to_vec())}),
                "terminalOutputContentSchema",
            )?;
            self.emit(json!({
                "type":"terminal.output","operationId":self.binding["operationId"],
                "sequence":self.sequence,"protectedData":protected,
            }))?;
            self.sequence += 1;
            offset = end;
            if offset == units.len() {
                return Ok(());
            }
        }
    }
}

struct State {
    replay: replay::Replay,
    views: HashMap<JsString, Attachment>,
    exited: Option<Value>,
}

impl State {
    fn write(&mut self, text: &str) {
        if text.is_empty() {
            return;
        }
        self.replay.write(text);
        let text = JsString::from(text);
        for (_, view) in self.views.extract_if(|_, view| view.output(&text).is_err()) {
            let _ = view
                .complete
                .send(Err(anyhow!("Terminal output attachment closed.")));
        }
    }

    fn finish(&mut self, result: Value) {
        for (_, view) in self.views.drain() {
            let _ = view.complete.send(Ok(result.clone()));
        }
        self.exited = Some(result);
    }
}

struct Entry {
    cwd: PathBuf,
    stop: watch::Sender<bool>,
    done: watch::Receiver<bool>,
    writer: mpsc::Sender<Vec<u8>>,
    resize: mpsc::Sender<process::Resize>,
    state: Arc<Mutex<State>>,
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
}

pub(crate) struct Ports<'a> {
    pub encryption: &'a Arc<Service>,
    pub routes: &'a Registry,
    pub scope: &'a Scope,
    pub outbound: &'a Arc<Outbound>,
    pub request_id: &'a Value,
    pub socket_epoch: u64,
}

impl Shells {
    pub(crate) fn supports(command: &str) -> bool {
        matches!(
            command,
            "terminal.open"
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
    ) -> Self {
        Self {
            inner: Default::default(),
            environment,
            logs,
            services,
            replay,
            transition: Default::default(),
            generation,
        }
    }

    fn key(command: &Value, encryption: &Service) -> Result<Key> {
        let (owner, server) = encryption.bound_identity()?;
        if command
            .get("serverId")
            .is_some_and(|declared| declared != &server)
        {
            bail!("Terminal belongs to another server.");
        }
        Ok(Key {
            owner,
            server: server
                .as_js_string()
                .context("Terminal server identity")?
                .clone(),
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
            Some("terminal.open") => self
                .open(command, key, &ports)
                .await
                .map_err(|_| anyhow!("The terminal could not be opened.")),
            Some("terminal.detach") => {
                self.detach(&key, command["attachmentId"].as_js_string().unwrap())
                    .await;
                Ok(detached())
            }
            Some("terminal.input") => self.input(command, &key, ports.encryption).await,
            Some("terminal.snapshot") => self.snapshot(command, &key, ports.encryption).await,
            Some("terminal.resize") => {
                let resize = {
                    let inner = self.inner.lock().await;
                    inner.entries.get(&key).map(|entry| entry.resize.clone())
                }
                .ok_or_else(|| not_running(&key))?;
                let (complete, done) = oneshot::channel();
                resize
                    .send(process::Resize {
                        size: size(command),
                        complete,
                    })
                    .await
                    .map_err(|_| not_running(&key))?;
                done.await.map_err(|_| not_running(&key))??;
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
                self.services.disable(&key.terminal).await;
                Ok(json!({"accepted":true}))
            }
            _ => bail!("Unsupported host terminal operation."),
        }
    }

    async fn open(&self, command: &Value, key: Key, ports: &Ports<'_>) -> Result<Value> {
        if command["launch"]["type"] != "shell" {
            bail!("The terminal requires a different runtime.");
        }
        let command = ports.routes.resolve(command).await?;
        let configuration = private_state::open_host(&command, ports.encryption)?;
        let view_id = command["attachmentId"].as_js_string().unwrap();
        let mut connection = ports.outbound.stream_epoch();
        if *connection.borrow_and_update() != ports.socket_epoch {
            return Ok(detached());
        }
        let (complete, done) = oneshot::channel();
        let mut view = Attachment {
            complete,
            outbound: ports.outbound.clone(),
            request_id: ports
                .request_id
                .as_js_string()
                .context("Terminal request identity")?
                .clone(),
            epoch: ports.socket_epoch,
            binding: binding(&command, "output"),
            encryption: ports.encryption.clone(),
            owner: key.owner.clone(),
            discard: command["outputMode"] == "discard",
            sequence: 0,
        };
        {
            let _transition = self.transition().await;
            if self.services.enabled(&key.terminal).await {
                bail!("The terminal requires a different runtime.");
            }
            let mut inner = self.inner.lock().await;
            ports.scope.check()?;
            while let Some(result) = inner.jobs.try_join_next() {
                result?;
            }
            if inner
                .entries
                .get(&key)
                .is_some_and(|entry| entry.state.lock().unwrap().exited.is_some())
            {
                inner.entries.remove(&key);
            }
            if !inner.entries.contains_key(&key) {
                let exited = {
                    let key = key.clone();
                    let generation = self.generation.clone();
                    let encryption = ports.encryption.clone();
                    let outbound = ports.outbound.clone();
                    move |code| {
                        if encryption.bound_identity().is_ok_and(|(owner, server)| {
                            owner == key.owner && server.as_js_string() == Some(&key.server)
                        }) {
                            let _ =
                                outbound.notification(json!({"type":"terminal.runtime.observed",
                                    "workerProcessGeneration":generation,"terminalId":key.terminal,
                                    "status":"exited","exitCode":code,"signal":Value::Null,
                                }));
                        }
                    }
                };
                let (entry, actor) = process::spawn(
                    configuration.cwd.clone(),
                    key.terminal.clone(),
                    size(&command),
                    self.environment.clone(),
                    self.logs.clone(),
                    exited,
                )
                .await?;
                inner.jobs.spawn(actor);
                inner.entries.insert(key.clone(), entry);
            }
            let entry = &inner.entries[&key];
            anyhow::ensure!(
                entry.cwd == configuration.cwd && !*entry.stop.borrow(),
                "Terminal belongs to another source folder or is stopping.",
            );
            let mut state = entry.state.lock().unwrap();
            if let Some(exited) = &state.exited {
                return Ok(exited.clone());
            }
            anyhow::ensure!(
                !state.views.contains_key(view_id),
                "Terminal attachment already exists."
            );
            if !view.discard {
                view.output(&state.replay.attachment())?;
            }
            view.emit(json!({"type":"terminal.ready"}))?;
            state.views.insert(view_id.clone(), view);
        }
        let result = tokio::select! {
            result = done => result.unwrap_or_else(|_| Ok(detached())),
            _ = connection.changed() => Ok(detached()),
            _ = ports.scope.stopped() => Ok(detached()),
        };
        self.detach(&key, view_id).await;
        self.replay
            .lock()
            .unwrap()
            .release(&binding(&command, "input"));
        checked("terminalOpenResultSchema", &result?)
    }

    async fn detach(&self, key: &Key, view: &JsString) {
        if let Some(entry) = self.inner.lock().await.entries.get(key)
            && let Some(view) = entry.state.lock().unwrap().views.remove(view)
        {
            let mut binding = view.binding;
            binding["direction"] = json!("input");
            self.replay.lock().unwrap().release(&binding);
            let _ = view.complete.send(Ok(detached()));
        }
    }

    async fn input(&self, command: &Value, key: &Key, encryption: &Service) -> Result<Value> {
        let inner = self.inner.lock().await;
        let context = binding(command, "input");
        let mut replay = self.replay.lock().unwrap();
        replay.reserve(&context)?;
        let input = open_surface_content(
            encryption,
            &context,
            &command["protectedData"],
            "terminalInputContentSchema",
        )?;
        let entry = inner
            .entries
            .get(key)
            .filter(|entry| !*entry.stop.borrow())
            .ok_or_else(|| not_running(key))?;
        let data = input["data"]
            .as_js_string()
            .unwrap()
            .lossy()
            .as_bytes()
            .to_vec();
        entry
            .writer
            .try_send(data)
            .map_err(|_| anyhow!("Terminal input could not be written."))?;
        let response = seal(
            encryption,
            context,
            &json!({"ok":true,"result":json!({"type":"terminal.input.accepted"})}),
        )?;
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
        let value = {
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
                Some(json!({"type":"terminal.snapshot","terminalId":key.terminal,
                    "status":if state.exited.is_some() {"exited"} else {"running"},
                    "data":data,"truncated":truncated,"exitCode":exit_code,
                }))
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
        encryption: &Service,
        configurations: &[Configuration],
    ) -> Result<()> {
        let (owner, server) = encryption.bound_identity()?;
        let server = server.as_js_string().context("Terminal server identity")?;
        let mut retiring = Vec::new();
        {
            let inner = self.inner.lock().await;
            for configuration in configurations {
                let key = Key {
                    owner: owner.clone(),
                    server: server.clone(),
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
