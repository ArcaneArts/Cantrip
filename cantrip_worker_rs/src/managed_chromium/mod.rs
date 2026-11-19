//! Install the existing managed Chromium release and launch its native binary.
mod archive;
mod launch;
mod source;
mod storage;

use crate::{http::checked, logging::Logs, platform};
use anyhow::{Context, Result, anyhow, ensure};
use cantrip_config::Environment;
use cantrip_wire::{Value, parse_json_text, value::json};
use source::Source;
use std::{path::Path, sync::Mutex, time::Duration};
use storage::{Entry, Pointer, Storage};
use tokio::sync::{Mutex as AsyncMutex, watch};

const REFRESH: Duration = Duration::from_secs(6 * 60 * 60);

pub(crate) struct Manager {
    storage: Storage,
    source: Source,
    operation: AsyncMutex<()>,
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
    pub(crate) fn configure(data: &Path, environment: &Environment) -> Result<Self> {
        let manifest = environment
            .get("CANTRIP_MANAGED_RUNTIME_MANIFEST_URL")
            .map(|value| value.trim())
            .filter(|value| !value.is_empty())
            .unwrap_or(source::MANIFEST);
        Ok(Self::new(data, Source::configured(manifest.into())?))
    }

    fn new(data: &Path, source: Source) -> Self {
        let supported = matches!(platform::platform(), "darwin" | "linux" | "win32")
            && matches!(platform::architecture(), "arm64" | "x64");
        Self {
            storage: Storage::new(data),
            source,
            operation: AsyncMutex::new(()),
            status: Mutex::new(status("playwright", supported)),
            stop: watch::channel(false).0,
        }
    }

    pub(crate) fn capabilities(&self) -> Value {
        json!({"schemaVersion":1,"search":status("searxng", false),"browser":self.snapshot(),"staticReading":false})
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
    }

    pub(crate) async fn action(&self, command: &Value, logs: &Logs) -> Result<Value> {
        ensure!(
            command["component"] == "playwright",
            "Native managed search runtime is unavailable."
        );
        ensure!(!*self.stop.borrow(), "Managed Chromium is shutting down.");
        let action = command["action"]
            .as_str()
            .context("Missing managed Chromium action.")?;
        self.perform(action, logs).await;
        checked(
            "managedWebRuntimeActionResultSchema",
            &json!({
                "accepted":true,"component":"playwright","action":action,"status":self.snapshot(),
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
                logs.event("warn", "Managed Chromium operation failed", json!({
                    "event":"managed-chromium.operation-failed","subsystem":"managed-web-runtime",
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
            "Managed Chromium storage could not be updated.",
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
            "clear-cache" => self
                .storage
                .purge(&[
                    "downloads",
                    "staging",
                    "state/cache",
                    "state/downloads",
                    "state/traces",
                ])
                .map_err(storage_error)?,
            _ => {}
        }
        let current = self.storage.current().map_err(Failure::new(
            "integrity",
            "Managed Chromium current installation pointer is invalid.",
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
                "Managed Chromium release manifest could not be downloaded.",
                true,
            ))?;
        let manifest = parse_manifest(&raw).map_err(Failure::new(
            "integrity",
            "Managed Chromium release manifest is invalid.",
            false,
        ))?;
        let artifact = manifest["artifacts"]
            .as_array()
            .unwrap()
            .iter()
            .find(|artifact| {
                artifact["component"] == "playwright"
                    && artifact["platform"] == platform::platform()
                    && artifact["architecture"] == platform::architecture()
            });
        let Some(artifact) = artifact else {
            let mut status = self.status.lock().unwrap();
            status["supported"] = json!(false);
            status["state"] = json!("unsupported");
            status["lastCheckedAt"] = json!(now());
            status["progress"] = Value::Null;
            status["failure"] = json!({"category":"compatibility","message":"Managed Chromium is unavailable for this platform and architecture.","retryable":false,"failedAt":now()});
            return Ok(());
        };
        self.source.verify(artifact).map_err(Failure::new(
            "signature",
            "Managed Chromium release signature could not be verified.",
            false,
        ))?;
        let selected = Entry {
            version: artifact["version"]
                .as_str()
                .ok_or_else(|| {
                    Failure::new(
                        "integrity",
                        "Managed Chromium release version is invalid.",
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
                "The installed Managed Chromium version is no longer available in the signed release channel.",
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
                    "Managed Chromium staging could not be created.",
                    true,
                )(error.into())
            })?;
        let archive = scratch.path().join("artifact");
        let unpacked = scratch.path().join("runtime");
        storage::private(&unpacked).map_err(Failure::new(
            "disk",
            "Managed Chromium staging could not be created.",
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
                "The managed Chromium archive could not be downloaded at its signed size.",
                true,
            ))?;
        self.progress("verify", compressed, compressed);
        if source::hex(&digest) != entry.archive {
            return Err(Failure::new(
                "integrity",
                "Managed Chromium archive digest does not match the signed release.",
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
                "Managed Chromium archive extraction did not finish.",
                true,
            )(error.into())
        })?
        .map_err(Failure::new(
            "archive",
            "Managed Chromium archive contents are invalid.",
            false,
        ))?;
        self.check_installation(&unpacked, artifact, &entry).await?;
        if *self.stop.borrow() {
            return Err(Failure::new(
                "unknown",
                "Managed Chromium installation stopped.",
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
        self.storage
            .promote(&unpacked, &pointer)
            .map_err(Failure::new(
                "disk",
                "Managed Chromium installation could not be activated.",
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
        let executable =
            launch::inventory(root, &selected.version, Some(artifact)).map_err(Failure::new(
                "inventory",
                "Managed Chromium runtime inventory does not match the release.",
                false,
            ))?;
        self.progress("probe", expanded, expanded);
        launch::probe(&executable, root, &self.storage.root, self.stop.subscribe())
            .await
            .map_err(Failure::new(
                "health-check",
                "Managed Chromium failed to launch or return an accessibility snapshot.",
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
