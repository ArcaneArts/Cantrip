//! Host Run lifecycle. Core owns admission and durable identity. Each worker
//! generation owns its setup and PTY handles, and returns only protected output.
mod layers;
mod output;
mod process;
mod providers;
mod shell;

use crate::{
    connection::Outbound,
    encryption::Service,
    filesystem::{Scope, paths},
    git::worktrees,
    logging::Logs,
    protected_content::protect_endpoint_content,
    routing::Registry,
    run_definitions::repository::Repository,
};
use anyhow::{Context, Result, anyhow, bail, ensure};
use cantrip_crypto::checked;
use cantrip_wire::{JsString, Value, value::json};
use indexmap::IndexMap;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::{
    sync::{Mutex as Queue, watch},
    task::JoinHandle,
};

pub(crate) type Environment = HashMap<String, String>;
pub(crate) use providers::{capabilities, detect, inspect_devices, validation};
const PREFIX: &str = "project.run-configuration-runtime.";
const RETAINED: usize = 256;

pub(crate) struct Manager {
    entries: Mutex<IndexMap<JsString, Arc<Slot>>>,
    worker: JsString,
    environment: Arc<Environment>,
    encryption: Arc<Service>,
    outbound: Arc<Outbound>,
    worktrees: Arc<worktrees::Manager>,
    routing: Arc<Registry>,
    logs: Arc<Logs>,
}

struct Slot {
    shared: Arc<Mutex<Session>>,
    queue: Queue<Option<Job>>,
}

struct Job {
    stop: watch::Sender<bool>,
    force: Arc<AtomicBool>,
    task: JoinHandle<Option<process::Exit>>,
}

pub(super) struct Control {
    stop: watch::Receiver<bool>,
    force: Arc<AtomicBool>,
}

pub(super) struct LaunchJob {
    command: Value,
    control: Control,
    session: Arc<Mutex<Session>>,
}

struct Session {
    identity: Value,
    authority: Option<(JsString, Value)>,
    placement: Value,
    observation: Value,
    output: output::Output,
    target: Option<PathBuf>,
    source: Option<PathBuf>,
    grace: Duration,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Phase {
    Starting,
    Running,
    Restarting,
    Stopping,
    Idle,
    Exited,
    Failed,
    Lost,
}

impl Phase {
    fn name(self) -> &'static str {
        match self {
            Self::Starting => "starting",
            Self::Running => "running",
            Self::Restarting => "restarting",
            Self::Stopping => "stopping",
            Self::Idle => "idle",
            Self::Exited => "exited",
            Self::Failed => "failed",
            Self::Lost => "lost",
        }
    }

    fn active(self) -> bool {
        matches!(
            self,
            Self::Starting | Self::Running | Self::Restarting | Self::Stopping
        )
    }
}

struct Failure {
    phase: &'static str,
    code: String,
    message: String,
    retryable: bool,
}

impl Failure {
    fn new(phase: &'static str, code: &str, message: impl Into<String>, retryable: bool) -> Self {
        Self {
            phase,
            code: code.to_owned(),
            message: message.into(),
            retryable,
        }
    }

    fn observation(&self) -> Value {
        let message = self
            .message
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        let message = if message.is_empty() {
            "The Run could not start."
        } else {
            &message
        };
        json!({"phase":self.phase,"code":self.code,"message":JsString::new(message.encode_utf16().take(1000).collect()),"retryable":self.retryable})
    }
}

impl Manager {
    pub(crate) fn new(
        worker: JsString,
        environment: Arc<Environment>,
        encryption: Arc<Service>,
        outbound: Arc<Outbound>,
        worktrees: Arc<worktrees::Manager>,
        routing: Arc<Registry>,
        logs: Arc<Logs>,
    ) -> Self {
        Self {
            entries: Default::default(),
            worker,
            environment,
            encryption,
            outbound,
            worktrees,
            routing,
            logs,
        }
    }

    pub(crate) fn supports(kind: &str) -> bool {
        matches!(
            kind.strip_prefix(PREFIX),
            Some("start" | "restart" | "stop" | "status" | "output" | "reconcile")
        )
    }

    pub(crate) async fn execute(self: &Arc<Self>, command: &Value, scope: &Scope) -> Result<Value> {
        scope.check()?;
        let action = command["type"]
            .as_str()
            .and_then(|kind| kind.strip_prefix(PREFIX))
            .context("Run action")?;
        if action == "reconcile" {
            return self
                .reconcile(command["identities"].as_array().unwrap())
                .await;
        }
        let identity = &command["identity"];
        ensure!(
            identity["workerId"].as_js_string() == Some(&self.worker),
            "The Run configuration belongs to another worker."
        );
        let id = identity["runtimeId"].as_js_string().unwrap();
        match action {
            "status" => checked(
                "runConfigurationRuntimeWorkerLookupSchema",
                &self.lookup(identity),
            ),
            "output" => self.output(command),
            "start" | "restart" => self.admit(id, command, action == "restart", scope).await,
            "stop" => self.stop(id, identity).await,
            _ => bail!("Unknown Run configuration runtime action."),
        }
    }

    fn slot(&self, id: &JsString) -> Option<Arc<Slot>> {
        self.entries.lock().unwrap().get(id).cloned()
    }

    fn get_or_create(
        &self,
        id: &JsString,
        command: &Value,
        restart: bool,
    ) -> Result<Option<Arc<Slot>>> {
        let mut entries = self.entries.lock().unwrap();
        if let Some(slot) = entries.get(id) {
            return Ok(Some(slot.clone()));
        }
        if restart {
            return Ok(None);
        }
        if entries.len() == RETAINED {
            let oldest = entries
                .iter()
                .filter_map(|(id, slot)| {
                    let state = slot.shared.lock().unwrap();
                    (!state.phase().active() && Arc::strong_count(slot) == 1).then(|| {
                        (
                            id.clone(),
                            state.observation["endedAt"]
                                .as_str()
                                .unwrap_or("")
                                .to_owned(),
                        )
                    })
                })
                .min_by(|(_, left), (_, right)| left.cmp(right));
            if let Some((id, _)) = oldest {
                entries.shift_remove(&id);
            }
        }
        ensure!(
            entries.len() < RETAINED,
            "This worker is retaining the maximum number of Run configuration runtimes."
        );
        let slot = Arc::new(Slot {
            shared: Arc::new(Mutex::new(Session::new(
                command,
                self.encryption.bound_identity().ok(),
            ))),
            queue: Queue::default(),
        });
        entries.insert(id.clone(), slot.clone());
        Ok(Some(slot))
    }

    async fn admit(
        self: &Arc<Self>,
        id: &JsString,
        command: &Value,
        restart: bool,
        scope: &Scope,
    ) -> Result<Value> {
        let Some(slot) = self.get_or_create(id, command, restart)? else {
            return result("not-found", None);
        };
        let mut running = slot.queue.lock().await;
        scope.check()?;
        let identity = &command["identity"];
        let placement = Session::requested(command);
        let (replaying_restart, initial) = {
            let mut state = slot.shared.lock().unwrap();
            state.assert_identity(identity)?;
            ensure!(
                self.current_authority(&state),
                "The Run configuration belongs to another server authorization."
            );
            let phase = state.phase();
            let same = state.identity == *identity && state.placement == placement;
            // A newly allocated slot has no published observation or job yet.
            let initial = state.observation["state"].is_null();
            if !initial {
                if same && !(restart && phase == Phase::Restarting) {
                    return result("replayed", Some(&state.observation));
                }
                let previous = state.generation();
                let next = identity["generation"].as_u64().unwrap();
                if !same && next <= previous {
                    return result("stale", Some(&state.observation));
                }
                if restart {
                    ensure!(
                        same || (phase.active() && next == previous + 1),
                        "A restart must advance one active Run configuration generation."
                    );
                } else {
                    ensure!(
                        !phase.active(),
                        "A start cannot replace an active Run configuration generation."
                    );
                }
            }
            let replaying = restart && same && !initial;
            if !replaying {
                let next = if restart {
                    Phase::Restarting
                } else {
                    Phase::Starting
                };
                state.begin(identity, placement, next);
                self.emit(&state);
            }
            (replaying, initial)
        };
        if let Some(job) = running.as_mut() {
            // Restart retires the actual previous process before a replacement
            // may start. A naturally ended generation joins here as well.
            job.retire(true, Duration::ZERO).await?;
            running.take();
        }
        let accepted = {
            let mut state = slot.shared.lock().unwrap();
            if !initial {
                let label = if restart {
                    "Restarting"
                } else {
                    "Starting next generation"
                };
                let generation = state.generation();
                state.output.append(&format!(
                    "\r\n\x1b[90m[{label} · generation {generation}]\x1b[0m\r\n"
                ));
            }
            if restart {
                state.set_phase(Phase::Starting);
                self.emit(&state);
            }
            result(
                if replaying_restart {
                    "replayed"
                } else {
                    "accepted"
                },
                Some(&state.observation),
            )?
        };
        let manager = self.clone();
        let (stop, stopped) = watch::channel(false);
        let force = Arc::new(AtomicBool::new(false));
        let job = LaunchJob {
            command: command.clone(),
            session: slot.shared.clone(),
            control: Control {
                stop: stopped,
                force: force.clone(),
            },
        };
        let task = tokio::spawn(async move { manager.run(job).await });
        *running = Some(Job { stop, force, task });
        Ok(accepted)
    }

    async fn stop(&self, id: &JsString, identity: &Value) -> Result<Value> {
        let Some(slot) = self.slot(id) else {
            return result("not-found", None);
        };
        let mut running = slot.queue.lock().await;
        let (replaying_stop, grace) = {
            let mut state = slot.shared.lock().unwrap();
            state.assert_identity(identity)?;
            ensure!(
                self.current_authority(&state),
                "The Run configuration belongs to another server authorization."
            );
            let same = state.identity == *identity;
            let phase = state.phase();
            let replaying = same && phase == Phase::Stopping;
            if same && !replaying {
                return result("replayed", Some(&state.observation));
            }
            let generation = identity["generation"].as_u64().unwrap();
            if generation < state.generation() {
                return result("stale", Some(&state.observation));
            }
            ensure!(
                generation == state.generation()
                    && identity["definitionRevision"] == state.identity["definitionRevision"]
                    && identity["codexEnvironmentRevision"]
                        == state.identity["codexEnvironmentRevision"],
                "The stop target does not match the active generation."
            );
            if !phase.active() {
                return result("replayed", Some(&state.observation));
            }
            if !replaying {
                state.identity["operationId"] = identity["operationId"].clone();
                state.observation["operationId"] = identity["operationId"].clone();
                state.set_phase(Phase::Stopping);
                self.emit(&state);
            }
            (replaying, state.grace)
        };
        let exit = if let Some(job) = running.as_mut() {
            job.retire(false, grace).await?
        } else {
            None
        };
        running.take();
        let mut state = slot.shared.lock().unwrap();
        state.end(Phase::Idle, exit, None);
        self.emit(&state);
        result(
            if replaying_stop {
                "replayed"
            } else {
                "accepted"
            },
            Some(&state.observation),
        )
    }

    fn lookup(&self, identity: &Value) -> Value {
        if let Some(slot) = self.slot(identity["runtimeId"].as_js_string().unwrap()) {
            let state = slot.shared.lock().unwrap();
            if state.identity == *identity
                && !state.observation.is_null()
                && self.current_authority(&state)
            {
                return json!({"found":true,"observation":state.observation});
            }
        }
        json!({"found":false,"identity":identity})
    }

    fn output(&self, command: &Value) -> Result<Value> {
        let identity = &command["identity"];
        let unavailable =
            || anyhow!("The Run configuration output is not available on this worker.");
        let slot = self
            .slot(identity["runtimeId"].as_js_string().unwrap())
            .ok_or_else(unavailable)?;
        let authority = self.encryption.bound_identity()?;
        let content = {
            let state = slot.shared.lock().unwrap();
            if state.identity != *identity || state.authority.as_ref() != Some(&authority) {
                return Err(unavailable());
            }
            state
                .output
                .tail(command["tail"].as_u64().unwrap() as usize)
        };
        let (_, server) = authority;
        ensure!(
            server == command["serverId"],
            "The Run output belongs to another server."
        );
        let scope = json!([&identity["projectId"], &identity["worktreeId"]]).stringify();
        let protected = protect_endpoint_content(
            &self.encryption,
            &json!({
                "domain":"run-content","workerId":Value::Null,"serverId":server,"scopeId":scope,
                "operationId":command["requestOperationId"],"operation":"run.configuration.output","direction":"response","sequence":0,
            }),
            &content,
            "runConfigurationRuntimeOutputContentSchema",
        )?;
        checked(
            "protectedRunConfigurationRuntimeWorkerOutputSchema",
            &json!({
                "requestOperationId":command["requestOperationId"],"identity":identity,"protectedOutput":protected
            }),
        )
    }

    async fn reconcile(&self, identities: &[Value]) -> Result<Value> {
        let found = identities
            .iter()
            .map(|identity| self.lookup(identity))
            .collect::<Vec<_>>();
        let expected: HashMap<_, _> = identities
            .iter()
            .map(|identity| (identity["runtimeId"].as_js_string().unwrap(), identity))
            .collect();
        let entries = self.snapshot();
        let retired = futures::future::join_all(entries.into_iter().map(|(id, slot)| {
            let expected = expected.get(&id).copied();
            async move {
                self.retire_slot(&slot, |state| expected != Some(&state.identity))
                    .await
                    .map(|retired| retired.then_some(id))
            }
        }))
        .await
        .into_iter()
        .collect::<Result<Vec<_>>>()?;
        let orphaned: Vec<_> = retired.into_iter().flatten().collect();
        checked(
            "runConfigurationRuntimeWorkerReconciliationSchema",
            &json!({"runtimes":found,"orphanedRuntimeIds":orphaned}),
        )
    }

    fn snapshot(&self) -> Vec<(JsString, Arc<Slot>)> {
        self.entries
            .lock()
            .unwrap()
            .iter()
            .map(|(id, slot)| (id.clone(), slot.clone()))
            .collect()
    }

    async fn retire_slot(
        &self,
        slot: &Slot,
        matches: impl FnOnce(&Session) -> bool,
    ) -> Result<bool> {
        let mut running = slot.queue.lock().await;
        {
            let mut state = slot.shared.lock().unwrap();
            if state.observation.is_null() || !state.phase().active() || !matches(&state) {
                return Ok(false);
            }
            // Fence completion callbacks before awaiting teardown. Core can
            // retry retirement if the actual owned exit remains unconfirmed.
            state.set_phase(Phase::Stopping);
        }
        if let Some(job) = running.as_mut() {
            job.retire(true, Duration::ZERO).await?;
        }
        running.take();
        let mut state = slot.shared.lock().unwrap();
        state.end(
            Phase::Lost,
            None,
            Some(Failure::new(
                "reconcile",
                "runtime-unclaimed",
                "The worker stopped an unclaimed Run configuration process.",
                true,
            )),
        );
        self.emit(&state);
        Ok(true)
    }

    pub(crate) async fn stop_project(&self, project: &Value) -> Result<()> {
        for (_, slot) in self.snapshot() {
            self.retire_slot(&slot, |state| state.identity["projectId"] == *project)
                .await?;
        }
        Ok(())
    }

    pub(crate) async fn stop_path(&self, path: &Path) -> Result<()> {
        let canonical = paths::canonical(path)
            .await
            .unwrap_or_else(|_| path.to_owned());
        for (_, slot) in self.snapshot() {
            let (placement, active) = {
                let state = slot.shared.lock().unwrap();
                (state.placement.clone(), state.phase().active())
            };
            if !active {
                continue;
            }
            let mut requested = Vec::new();
            for key in ["sourcePath", "targetPath"] {
                if let Ok(resolved) = self.routing.resolve(&placement[key]).await
                    && let Some(value) = resolved.as_js_string()
                {
                    let value = paths::native(value);
                    let path = paths::canonical(&value).await.unwrap_or(value);
                    requested.push(path);
                }
            }
            self.retire_slot(&slot, |state| {
                let requested_matches = state.placement == placement
                    && requested.iter().any(|path| paths::within(&canonical, path));
                let actual = [state.target.as_deref(), state.source.as_deref()];
                requested_matches
                    || actual
                        .into_iter()
                        .flatten()
                        .any(|candidate| paths::within(&canonical, candidate))
            })
            .await?;
        }
        Ok(())
    }

    pub(crate) async fn close(&self) -> Result<()> {
        let entries = self.snapshot();
        let results = futures::future::join_all(
            entries
                .into_iter()
                .map(|(_, slot)| async move { self.retire_slot(&slot, |_| true).await }),
        )
        .await;
        for result in results {
            result?;
        }
        Ok(())
    }

    fn current_authority(&self, state: &Session) -> bool {
        state.authority.as_ref().is_none_or(|authority| {
            self.encryption
                .bound_identity()
                .is_ok_and(|current| &current == authority)
        })
    }

    pub(crate) fn owns_terminal(&self, id: &Value) -> bool {
        self.entries.lock().unwrap().values().any(|slot| {
            let state = slot.shared.lock().unwrap();
            state.identity["terminalId"] == *id && self.current_authority(&state)
        })
    }

    fn emit(&self, state: &Session) {
        if !self.current_authority(state) {
            return;
        }
        let _ = self.outbound.notification(json!({
            "type":"project.run-configuration-runtime.observed","observation":state.observation,
        }));
    }

    async fn run(&self, job: LaunchJob) -> Option<process::Exit> {
        let completion = self.launch(&job).await;
        let mut state = job.session.lock().unwrap();
        if state.identity == job.command["identity"]
            && matches!(state.phase(), Phase::Starting | Phase::Running)
        {
            match completion {
                Ok(Some(exit)) => state.end(Phase::Exited, Some(exit), None),
                Err(failure) => {
                    let detail = json!({"event":"run-configuration.process.start-failed",
                        "subsystem":"run-configuration-runtime","operation":"start","status":"failed",
                        "reasonCode":failure.code,"runtimeId":state.identity["runtimeId"],
                        "projectId":state.identity["projectId"],"worktreeId":state.identity["worktreeId"],
                        "configurationId":state.identity["configurationId"],"generation":state.generation()});
                    self.logs
                        .event("warn", "Run configuration process failed to start", detail);
                    state.end(Phase::Failed, None, Some(failure));
                }
                Ok(None) => return None,
            }
            self.emit(&state);
            None
        } else {
            // The Stop/Restart command owns the transition and generation.
            completion.ok().flatten()
        }
    }

    async fn launch(&self, job: &LaunchJob) -> Result<Option<process::Exit>, Failure> {
        let identity = &job.command["identity"];
        let roots = self.authorize(job).await.map_err(|_| {
            Failure::new(
                "target",
                "launch-target-unavailable",
                "The requested Run configuration worktree is unavailable.",
                true,
            )
        })?;
        {
            let mut state = job.session.lock().unwrap();
            if !job.current(&state) {
                return Ok(None);
            }
            if state.authority.is_none() {
                state.authority = self.encryption.bound_identity().ok();
            }
            if !self.current_authority(&state) {
                return Err(Failure::new(
                    "target",
                    "launch-target-unavailable",
                    "The Run configuration belongs to another server authorization.",
                    true,
                ));
            }
            state.source = Some(roots.source.clone());
            state.target = Some(roots.target.clone());
            state
                .output
                .replace_secrets(layers::protected(&self.environment));
        }
        let definition = {
            let source = roots.source.clone();
            let id = identity["configurationId"].as_str().unwrap().to_owned();
            tokio::task::spawn_blocking(move || Repository::new(source).read(&id))
                .await
                .ok()
                .and_then(Result::ok)
                .ok_or_else(|| {
                    Failure::new(
                        "definition",
                        "definition-invalid",
                        "The Run configuration is not valid.",
                        true,
                    )
                })?
                .ok_or_else(|| {
                    Failure::new(
                        "definition",
                        "definition-not-found",
                        "The Run configuration no longer exists in Primary.",
                        false,
                    )
                })?
        };
        if definition["status"] != "ready" {
            let diagnostics = definition["diagnostics"]
                .as_array()
                .and_then(|values| values.first());
            let message = diagnostics
                .and_then(|d| d["message"].as_str())
                .unwrap_or("The Run configuration is not valid.");
            return Err(Failure::new(
                "definition",
                "definition-invalid",
                message,
                true,
            ));
        }
        if definition["revision"] != identity["definitionRevision"] {
            return Err(Failure::new(
                "definition",
                "definition-revision-mismatch",
                "The Run configuration changed before this generation started.",
                true,
            ));
        }
        let document = &definition["document"];
        let launch = providers::materialize(document, &roots.target, &self.environment)?;
        let _scratch = launch.scratch;
        let grace = Duration::from_millis(document["stop"]["gracePeriodMs"].as_u64().unwrap());
        {
            let mut state = job.session.lock().unwrap();
            if !job.current(&state) {
                return Ok(None);
            }
            state.grace = grace;
        }
        let layers = layers::resolve(
            job,
            &roots,
            &launch.environment,
            launch.additions,
            &self.environment,
            &self.encryption,
        )
        .await?;
        {
            let mut state = job.session.lock().unwrap();
            if !job.current(&state) {
                return Ok(None);
            }
            state.output.replace_secrets(
                layers::protected(&self.environment)
                    .chain(layers.redactions.iter().map(|value| value.as_str())),
            );
        }
        for command in launch.before {
            let exit = process::run(
                &command,
                &layers.environment,
                &job.control,
                grace,
                None,
                |text| job.append(text),
                || {},
            )
            .await?;
            if *job.control.stop.borrow() {
                return Ok(exit);
            }
            if !exit
                .as_ref()
                .is_some_and(|exit| exit.code == Some(0) && exit.signal.is_none())
            {
                let code = exit
                    .and_then(|exit| exit.code)
                    .map_or_else(|| "null".to_owned(), |code| code.to_string());
                return Err(Failure::new(
                    "before-launch",
                    "before-launch-failed",
                    format!("A before-launch step exited with code {code}."),
                    true,
                ));
            }
        }
        process::run(
            &launch.main,
            &layers.environment,
            &job.control,
            grace,
            None,
            |text| job.append(text),
            || {
                let mut state = job.session.lock().unwrap();
                if job.current(&state) {
                    state.set_phase(Phase::Running);
                    state.observation["startedAt"] = json!(now());
                    self.emit(&state);
                    self.logs.event("info", "Run configuration process started",
                        json!({"event":"run-configuration.process.started","subsystem":"run-configuration-runtime",
                            "operation":"start","status":"running","runtimeId":state.identity["runtimeId"],
                            "projectId":state.identity["projectId"],"worktreeId":state.identity["worktreeId"],
                            "configurationId":state.identity["configurationId"],"generation":state.generation()}));

                }
            },
        )
        .await
    }

    async fn authorize(&self, job: &LaunchJob) -> Result<layers::Roots> {
        let scope = Scope::with_stop(job.control.stop.clone());
        scope.check()?;
        let source = self.routing.resolve(&job.command["sourcePath"]).await?;
        let target = self.routing.resolve(&job.command["targetPath"]).await?;
        let source = paths::native(source.as_js_string().unwrap());
        let target = paths::native(target.as_js_string().unwrap());
        if job.command["rootKind"] == "folder-root" {
            let source = paths::canonical(&source).await?;
            let target = paths::canonical(&target).await?;
            ensure!(
                paths::equal(&source, &target) && tokio::fs::metadata(&source).await?.is_dir(),
                "The requested folder Run root does not match its registered project source."
            );
            return Ok(layers::Roots { source, target });
        }
        let authorized = self
            .worktrees
            .authorize_targets(&source, &[target], &scope)
            .await?;
        let selected = authorized
            .first()
            .context("The requested Run configuration worktree is unavailable.")?;
        Ok(layers::Roots {
            source: paths::native(selected["inventory"]["sourcePath"].as_js_string().unwrap()),
            target: paths::native(selected["worktree"]["path"].as_js_string().unwrap()),
        })
    }
}

impl Job {
    async fn retire(&mut self, force: bool, grace: Duration) -> Result<Option<process::Exit>> {
        if force {
            self.force.store(true, Ordering::Release);
        }
        if !self.task.is_finished() {
            self.stop.send_replace(true);
        }
        let result = tokio::time::timeout(grace + Duration::from_millis(1600), &mut self.task)
            .await
            .context("The Run process group did not confirm termination after force kill.")??;
        Ok(result)
    }
}

impl LaunchJob {
    fn append(&self, text: &str) {
        let mut state = self.session.lock().unwrap();
        // Lifecycle operations join this job before handing the terminal to a
        // replacement, so output from the retiring generation is still ordered.
        state.output.append(text);
    }

    fn current(&self, state: &Session) -> bool {
        !*self.control.stop.borrow()
            && state.identity == self.command["identity"]
            && state.phase() == Phase::Starting
    }
}

impl Session {
    fn new(command: &Value, authority: Option<(JsString, Value)>) -> Self {
        Self {
            identity: command["identity"].clone(),
            authority,
            placement: Self::requested(command),
            observation: Value::Null,
            output: Default::default(),
            target: None,
            source: None,
            grace: Duration::from_secs(3),
        }
    }

    fn requested(command: &Value) -> Value {
        json!({"rootKind":command["rootKind"],"sourcePath":command["sourcePath"],"targetPath":command["targetPath"]})
    }

    fn begin(&mut self, identity: &Value, placement: Value, phase: Phase) {
        self.identity = identity.clone();
        self.placement = placement;
        self.observation = identity.clone();
        for field in ["startedAt", "endedAt", "exitCode", "signal", "failure"] {
            self.observation[field] = Value::Null;
        }
        self.set_phase(phase);
        self.target = None;
        self.source = None;
    }

    fn assert_identity(&self, identity: &Value) -> Result<()> {
        for key in [
            "runtimeId",
            "projectId",
            "configurationId",
            "worktreeId",
            "workerId",
            "terminalId",
        ] {
            ensure!(
                self.identity[key] == identity[key],
                "The runtime ID is already bound to another Run configuration identity."
            );
        }
        Ok(())
    }

    fn phase(&self) -> Phase {
        match self.observation["state"].as_str() {
            Some("starting") | None => Phase::Starting,
            Some("running") => Phase::Running,
            Some("restarting") => Phase::Restarting,
            Some("stopping") => Phase::Stopping,
            Some("idle") => Phase::Idle,
            Some("exited") => Phase::Exited,
            Some("failed") => Phase::Failed,
            Some("lost") => Phase::Lost,
            _ => unreachable!("worker Run state"),
        }
    }

    fn generation(&self) -> u64 {
        self.identity["generation"].as_u64().unwrap()
    }

    fn set_phase(&mut self, phase: Phase) {
        self.observation["state"] = json!(phase.name());
    }

    fn end(&mut self, phase: Phase, exit: Option<process::Exit>, failure: Option<Failure>) {
        self.output.flush();
        self.set_phase(phase);
        self.observation["endedAt"] = json!(now());
        if let Some(exit) = exit {
            self.observation["exitCode"] = json!(exit.code);
            self.observation["signal"] = json!(exit.signal);
        }
        self.observation["failure"] = json!(failure.map(|failure| failure.observation()));
    }
}

fn result(outcome: &str, observation: Option<&Value>) -> Result<Value> {
    checked(
        "runConfigurationRuntimeWorkerOperationResultSchema",
        &json!({"outcome":outcome,"observation":observation}),
    )
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
