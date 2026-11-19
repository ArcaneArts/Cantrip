//! Install and supervise the signed managed web runtimes.
mod archive;
mod launch;
mod searxng;
mod source;
mod storage;

use crate::{http::checked, logging::Logs, platform};
use anyhow::{Context, Result, anyhow, ensure};
use cantrip_config::Environment;
use cantrip_wire::{Value, parse_json_text, value::json};
pub(crate) use searxng::Search;
use source::Source;
use std::{
    net::SocketAddrV4,
    path::Path,
    sync::{Arc, Mutex},
    time::Duration,
};
use storage::{Entry, Pointer, Storage};
use tokio::sync::{Mutex as AsyncMutex, RwLock, watch};

const REFRESH: Duration = Duration::from_secs(6 * 60 * 60);

#[derive(Clone, Copy, Eq, PartialEq)]
enum Component {
    Chromium,
    Searxng,
}

impl Component {
    fn key(self) -> &'static str {
        match self {
            Self::Chromium => "playwright",
            Self::Searxng => "searxng",
        }
    }
}

pub(crate) struct Runtimes {
    pub(crate) browser: Arc<Manager>,
    pub(crate) search: Arc<Search>,
}

impl Runtimes {
    pub(crate) fn configure(
        data: &Path,
        environment: &Environment,
        logs: Arc<Logs>,
    ) -> Result<Self> {
        let manifest = environment
            .get("CANTRIP_MANAGED_RUNTIME_MANIFEST_URL")
            .map(|value| value.trim())
            .filter(|value| !value.is_empty())
            .unwrap_or(source::MANIFEST);
        Ok(Self {
            browser: Arc::new(Manager::new(
                data,
                Source::configured(manifest.into())?,
                Component::Chromium,
            )),
            search: Arc::new(Search::new(
                Manager::new(
                    data,
                    Source::configured(manifest.into())?,
                    Component::Searxng,
                ),
                Some(logs),
            )?),
        })
    }

    pub(crate) fn capabilities(&self) -> Value {
        json!({"schemaVersion":1,"search":self.search.snapshot(),"browser":self.browser.snapshot(),"staticReading":true})
    }

    pub(crate) fn stop(&self) {
        self.browser.stop();
        self.search.stop();
    }

    pub(crate) async fn run(&self, logs: &Logs) -> Result<()> {
        tokio::join!(self.browser.run(logs), self.search.run(logs)).1
    }

    pub(crate) async fn action(&self, command: &Value, logs: &Logs) -> Result<Value> {
        match command["component"].as_str() {
            Some("playwright") => self.browser.action(command, logs).await,
            Some("searxng") => self.search.action(command, logs).await,
            _ => anyhow::bail!("Unknown managed web runtime."),
        }
    }
}

pub(crate) struct Manager {
    component: Component,
    storage: Storage,
    source: Source,
    operation: AsyncMutex<()>,
    active_version: RwLock<()>,
    status: Mutex<Value>,
    stop: watch::Sender<bool>,
}

struct Failure {
    category: &'static str,
    message: &'static str,
    retryable: bool,
    cause: anyhow::Error,
}

type InstallResult<T> = std::result::Result<T, Failure>;

impl Manager {
    fn new(data: &Path, source: Source, component: Component) -> Self {
        let supported = matches!(platform::platform(), "darwin" | "linux" | "win32")
            && matches!(platform::architecture(), "arm64" | "x64");
        Self {
            component,
            storage: Storage::new(data, component.key()),
            source,
            operation: AsyncMutex::new(()),
            active_version: RwLock::new(()),
            status: Mutex::new(status(component.key(), supported)),
            stop: watch::channel(false).0,
        }
    }

    pub(crate) fn stopped(&self) -> watch::Receiver<bool> {
        self.stop.subscribe()
    }

    pub(crate) async fn with_browser<T>(
        &self,
        deny_proxy: SocketAddrV4,
        read: impl AsyncFnOnce(&cantrip_browser::Browser) -> Result<T>,
    ) -> Result<T> {
        let _version = self.active_version.read().await;
        ensure!(!*self.stop.borrow(), "Managed Chromium is shutting down.");
        let pointer = self.storage.current()?.with_context(|| {
            format!(
                "Browser runtime is {}.",
                self.snapshot()["state"].as_str().unwrap_or("missing")
            )
        })?;
        let runtime = self.storage.version(&pointer.current);
        let binary = launch::inventory(&runtime, &pointer.current.version, None)?;
        let staging = self.storage.root.join("staging");
        storage::private(&staging)?;
        let scratch = tempfile::Builder::new()
            .prefix("render-")
            .tempdir_in(staging)?;
        let environment = launch::environment(&runtime, scratch.path())?;
        let profile = scratch.path().join("profile");
        let browser = cantrip_browser::Browser::launch_intercepted(
            cantrip_browser::Launch {
                executable: &binary,
                profile: &profile,
                viewport: (1280, 720),
                environment: Some(&environment),
            },
            deny_proxy,
        )
        .await?;
        let result = read(&browser).await;
        let exit = browser.close().await;
        let value = result?;
        exit?;
        Ok(value)
    }

    pub(crate) fn stop(&self) {
        self.stop.send_replace(true);
    }

    pub(crate) async fn run(&self, logs: &Logs) {
        if self.snapshot()["supported"] != true {
            return;
        }
        let mut stop = self.stop.subscribe();
        let mut next = tokio::time::interval(REFRESH);
        next.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tokio::select! {
                _ = source::cancelled(&mut stop) => break,
                _ = next.tick() => self.perform("check-update", logs).await,
            }
        }
        let _drained = self.active_version.write().await;
    }

    pub(crate) async fn action(&self, command: &Value, logs: &Logs) -> Result<Value> {
        ensure!(
            command["component"] == self.component.key(),
            "Managed web runtime command targets a different component."
        );
        ensure!(!*self.stop.borrow(), "Managed Chromium is shutting down.");
        let action = command["action"]
            .as_str()
            .context("Missing managed Chromium action.")?;
        self.perform(action, logs).await;
        checked(
            "managedWebRuntimeActionResultSchema",
            &json!({
                "accepted":true,"component":self.component.key(),"action":action,"status":self.snapshot(),
            }),
        )
    }

    async fn perform(&self, action: &str, logs: &Logs) {
        let mut stop = self.stop.subscribe();
        let _operation = tokio::select! {
            _ = source::cancelled(&mut stop) => return,
            guard = self.operation.lock() => guard,
        };
        if let Err(failure) = self.apply(action).await {
            if !*self.stop.borrow() {
                self.failure(action, &failure);
                let (event, message) = match self.component {
                    Component::Chromium => (
                        "managed-chromium.operation-failed",
                        "Managed Chromium operation failed",
                    ),
                    Component::Searxng => (
                        "worker.search-runtime.install-failed",
                        "Managed search runtime installation failed",
                    ),
                };
                logs.event("warn", message, json!({
                    "event":event,"subsystem":"managed-web-runtime","component":self.component.key(),
                    "operation":action,"reasonCode":failure.category,"error":failure.message,"status":"failed",
                    "httpStatus":failure.cause.downcast_ref::<reqwest::Error>().and_then(reqwest::Error::status).map(|status| status.as_u16()),
                    "ioErrorKind":failure.cause.downcast_ref::<std::io::Error>().map(|error| format!("{:?}", error.kind()))
                }));
            }
        }
    }

    async fn apply(&self, action: &str) -> InstallResult<()> {
        let storage_error = Failure::new(
            "disk",
            "Managed runtime storage could not be updated.",
            true,
        );
        self.storage.ensure().map_err(storage_error)?;
        let _lock = self
            .storage
            .lock(self.stop.subscribe())
            .await
            .map_err(storage_error)?;
        match action {
            "clear-profiles" => {
                return self
                    .storage
                    .purge(&["state/profiles"])
                    .map_err(storage_error);
            }
            "clear-cache" => {
                let _version = self.active_version.write().await;
                let paths = match self.component {
                    Component::Chromium => &[
                        "downloads",
                        "staging",
                        "state/cache",
                        "state/downloads",
                        "state/traces",
                    ][..],
                    Component::Searxng => &["downloads", "staging", "cache"][..],
                };
                self.storage.purge(paths).map_err(storage_error)?;
            }
            _ => {}
        }
        let current = self.storage.current().map_err(Failure::new(
            "integrity",
            "Managed runtime current installation pointer is invalid.",
            false,
        ))?;
        if let Some(pointer) = &current {
            self.apply_pointer(pointer, "checking");
        } else {
            self.status.lock().unwrap()["state"] = json!("checking");
        }
        self.progress("manifest", 0, 0);
        let raw = self
            .source
            .manifest(self.stop.subscribe())
            .await
            .map_err(Failure::new(
                "download",
                "Managed runtime release manifest could not be downloaded.",
                true,
            ))?;
        let manifest = parse_manifest(&raw).map_err(Failure::new(
            "integrity",
            "Managed runtime release manifest is invalid.",
            false,
        ))?;
        let artifact = manifest["artifacts"]
            .as_array()
            .unwrap()
            .iter()
            .find(|artifact| {
                artifact["component"] == self.component.key()
                    && artifact["platform"] == platform::platform()
                    && artifact["architecture"] == platform::architecture()
            });
        let Some(artifact) = artifact else {
            let mut status = self.status.lock().unwrap();
            status["supported"] = json!(false);
            status["state"] = json!("unsupported");
            status["lastCheckedAt"] = json!(now());
            status["progress"] = Value::Null;
            status["failure"] = json!({"category":"compatibility","message":"Managed runtime is unavailable for this platform and architecture.","retryable":false,"failedAt":now()});
            return Ok(());
        };
        self.source.verify(artifact).map_err(Failure::new(
            "signature",
            "Managed runtime release signature could not be verified.",
            false,
        ))?;
        let selected = Entry {
            version: artifact["version"]
                .as_str()
                .ok_or_else(|| {
                    Failure::new(
                        "integrity",
                        "Managed runtime release version is invalid.",
                        false,
                    )(anyhow!("Invalid version"))
                })?
                .into(),
            archive: artifact["sha256"].as_str().unwrap().into(),
        };
        {
            let mut status = self.status.lock().unwrap();
            status["supported"] = json!(true);
            status["latestVersion"] = json!(selected.version);
            status["lastCheckedAt"] = json!(now());
        }
        if action == "reinstall"
            && current
                .as_ref()
                .is_some_and(|pointer| pointer.current.version != selected.version)
        {
            return Err(Failure::new(
                "compatibility",
                "The installed Managed runtime version is no longer available in the signed release channel.",
                false,
            )(anyhow!("Installed release differs")));
        }
        if let Some(pointer) = &current
            && pointer.current == selected
            && action != "reinstall"
        {
            self.check_installation(&self.storage.version(&selected), artifact, &selected)
                .await?;
            self.apply_pointer(pointer, "ready");
            let _version = self.active_version.write().await;
            let _ = self.storage.cleanup(pointer);
            return Ok(());
        }
        self.install(artifact, selected, current).await
    }

    async fn install(
        &self,
        artifact: &Value,
        entry: Entry,
        current: Option<Pointer>,
    ) -> InstallResult<()> {
        self.status.lock().unwrap()["state"] = json!(if current.is_some() {
            "updating"
        } else {
            "installing"
        });
        let scratch = tempfile::Builder::new()
            .prefix("install-")
            .tempdir_in(self.storage.root.join("staging"))
            .map_err(|error| {
                Failure::new(
                    "disk",
                    "Managed runtime staging could not be created.",
                    true,
                )(error.into())
            })?;
        let archive = scratch.path().join("artifact");
        let unpacked = scratch.path().join("runtime");
        storage::private(&unpacked).map_err(Failure::new(
            "disk",
            "Managed runtime staging could not be created.",
            true,
        ))?;
        let compressed = artifact["compressedBytes"].as_u64().unwrap();
        self.progress("download", 0, compressed);
        let digest = self
            .source
            .download(
                artifact,
                &archive,
                |received, total| self.progress("download", received, total),
                self.stop.subscribe(),
            )
            .await
            .map_err(Failure::new(
                "download",
                "The managed runtime archive could not be downloaded at its signed size.",
                true,
            ))?;
        self.progress("verify", compressed, compressed);
        if source::hex(&digest) != entry.archive {
            return Err(Failure::new(
                "integrity",
                "Managed runtime archive digest does not match the signed release.",
                false,
            )(anyhow!("Archive digest mismatch")));
        }
        let expanded = artifact["extractedBytes"].as_u64().unwrap();
        let format = artifact["archiveFormat"].as_str().unwrap().to_owned();
        self.progress("extract", 0, expanded);
        let stop = self.stop.subscribe();
        tokio::task::spawn_blocking({
            let unpacked = unpacked.clone();
            move || archive::unpack(&archive, &format, &unpacked, expanded, stop)
        })
        .await
        .map_err(|error| {
            Failure::new(
                "archive",
                "Managed runtime archive extraction did not finish.",
                true,
            )(error.into())
        })?
        .map_err(Failure::new(
            "archive",
            "Managed runtime archive contents are invalid.",
            false,
        ))?;
        self.check_installation(&unpacked, artifact, &entry).await?;
        if *self.stop.borrow() {
            return Err(Failure::new(
                "unknown",
                "Managed runtime installation stopped.",
                true,
            )(anyhow!("Worker stopping")));
        }
        self.progress("promote", expanded, expanded);
        let previous = current.and_then(|pointer| {
            if pointer.current.archive == entry.archive {
                pointer.previous
            } else {
                Some(pointer.current)
            }
        });
        let pointer = Pointer {
            current: entry,
            previous,
            verified_at: now(),
        };
        let _version = self.active_version.write().await;
        self.storage
            .promote(&unpacked, &pointer)
            .map_err(Failure::new(
                "disk",
                "Managed runtime installation could not be activated.",
                true,
            ))?;
        self.apply_pointer(&pointer, "ready");
        let _ = self.storage.cleanup(&pointer);
        Ok(())
    }

    async fn check_installation(
        &self,
        root: &Path,
        artifact: &Value,
        selected: &Entry,
    ) -> InstallResult<()> {
        let expanded = artifact["extractedBytes"].as_u64().unwrap();
        self.progress("inventory", expanded, expanded);
        let executable = match self.component {
            Component::Chromium => launch::inventory(root, &selected.version, Some(artifact)),
            Component::Searxng => searxng::inventory(root, &selected.version, Some(artifact)),
        }
        .map_err(Failure::new(
            "inventory",
            "Managed runtime inventory does not match the release.",
            false,
        ))?;
        self.progress("probe", expanded, expanded);
        match self.component {
            Component::Chromium => {
                launch::probe(&executable, root, &self.storage.root, self.stopped()).await
            }
            Component::Searxng => {
                searxng::probe(
                    &executable,
                    root,
                    &self.storage.root.join("staging"),
                    self.stopped(),
                )
                .await
            }
        }
        .map_err(Failure::new(
            "health-check",
            "The managed runtime failed its local health check.",
            true,
        ))
    }

    fn snapshot(&self) -> Value {
        self.status.lock().unwrap().clone()
    }

    fn progress(&self, phase: &str, completed: u64, total: u64) {
        self.status.lock().unwrap()["progress"] =
            json!({"phase":phase,"completedBytes":completed,"totalBytes":total,"updatedAt":now()});
    }

    fn apply_pointer(&self, pointer: &Pointer, state: &str) {
        let mut status = self.status.lock().unwrap();
        status["supported"] = json!(true);
        status["state"] = json!(state);
        status["installedVersion"] = json!(pointer.current.version);
        status["previousVersion"] = json!(pointer.previous.as_ref().map(|entry| &entry.version));
        status["progress"] = Value::Null;
        status["failure"] = Value::Null;
    }

    fn failure(&self, action: &str, failure: &Failure) {
        let mut status = self.status.lock().unwrap();
        if action != "clear-profiles" {
            status["state"] = json!(if status["installedVersion"].is_null() {
                "failed"
            } else {
                "degraded"
            });
        }
        status["progress"] = Value::Null;
        status["failure"] = json!({"category":failure.category,"message":failure.message,
            "retryable":failure.retryable,"failedAt":now()});
    }
}

impl Failure {
    fn new(
        category: &'static str,
        message: &'static str,
        retryable: bool,
    ) -> impl FnOnce(anyhow::Error) -> Self + Copy {
        move |cause| Self {
            category,
            message,
            retryable,
            cause,
        }
    }
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn parse_manifest(raw: &[u8]) -> Result<Value> {
    let text = std::str::from_utf8(raw)?;
    let input = parse_json_text(text.strip_prefix('\u{feff}').unwrap_or(text))
        .map_err(|_| anyhow!("Release manifest JSON is invalid."))?;
    checked("managedWebRuntimeReleaseManifestSchema", &input)
}

fn status(component: &str, supported: bool) -> Value {
    json!({"component":component,"supported":supported,"state":if supported {"checking"} else {"unsupported"},
        "installedVersion":Value::Null,"previousVersion":Value::Null,"latestVersion":Value::Null,
        "lastCheckedAt":Value::Null,"progress":Value::Null,"failure":Value::Null})
}

#[cfg(test)]
mod tests;
