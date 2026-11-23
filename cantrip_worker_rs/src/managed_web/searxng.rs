//! Own the portable SearXNG child and its loopback JSON service.
use super::{
    Manager, REFRESH,
    launch::regular_below,
    now,
    source::{cancelled, hex},
    storage::{self, Entry, Pointer},
};
use crate::{http::checked, logging::Logs};
use anyhow::{Context, Result, anyhow, bail, ensure};
use cantrip_wire::{Value, parse_json_text, value::json};
use reqwest::{Client, redirect::Policy};
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::{
    process::Command,
    sync::{Mutex as AsyncMutex, Notify, RwLock, oneshot, watch},
    task::JoinHandle,
    time::{Instant, timeout},
};
use url::Url;

const MAX_RESPONSE: usize = 8_000_000;
const STARTUP: Duration = Duration::from_secs(30);
const REQUEST: Duration = Duration::from_secs(15);
const STOP: Duration = Duration::from_secs(3);
const STABLE: Duration = Duration::from_secs(300);
const MAX_FAILURES: u32 = 5;

pub(crate) struct Search {
    installer: Manager,
    client: Client,
    update: AsyncMutex<()>,
    runtime: RwLock<Runtime>,
    failure: Mutex<Option<Value>>,
    changed: Arc<Notify>,
    logs: Option<Arc<Logs>>,
    initialized: watch::Sender<bool>,
}

#[derive(Default)]
struct Runtime {
    process: Option<Process>,
    failures: u32,
    retry: Option<Instant>,
    rolled_back: bool,
}

struct Process {
    entry: Entry,
    origin: Url,
    started: Instant,
    done: watch::Receiver<bool>,
    stop: oneshot::Sender<()>,
    task: JoinHandle<Result<()>>,
    expired_request: AtomicBool,
}

impl Search {
    pub(super) fn new(installer: Manager, logs: Option<Arc<Logs>>) -> Result<Self> {
        Ok(Self {
            installer,
            client: loopback_client()?,
            update: AsyncMutex::new(()),
            runtime: RwLock::default(),
            failure: Mutex::new(None),
            changed: Arc::new(Notify::new()),
            logs,
            initialized: watch::channel(false).0,
        })
    }

    pub(crate) fn snapshot(&self) -> Value {
        let mut status = self.installer.snapshot();
        if let Some(failure) = self.failure.lock().unwrap().clone() {
            status["state"] = json!(if status["installedVersion"].is_null() {
                "failed"
            } else {
                "degraded"
            });
            status["progress"] = Value::Null;
            status["failure"] = failure;
        }
        status
    }

    pub(super) fn stop(&self) {
        self.installer.stop();
    }

    pub(super) async fn run(&self, logs: &Logs) -> Result<()> {
        if self.installer.snapshot()["supported"] != true {
            self.initialized.send_replace(true);
            return Ok(());
        }
        let mut stop = self.installer.stopped();
        let mut refresh = tokio::time::interval(REFRESH);
        refresh.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let mut retry = None;
        loop {
            let refresh_due = tokio::select! {
                biased;
                _ = cancelled(&mut stop) => break,
                _ = refresh.tick() => true,
                _ = self.changed.notified() => false,
                _ = retry_due(retry) => false,
            };
            let _update = self.update.lock().await;
            if *stop.borrow() {
                break;
            }
            if refresh_due {
                if let Ok(mut runtime) = self.runtime.try_write() {
                    self.refresh(&mut runtime, "check-update", logs).await;
                    self.initialized.send_replace(true);
                }
            } else {
                let mut runtime = self.runtime.write().await;
                self.recover(&mut runtime, logs).await;
            }
            retry = self.runtime.read().await.retry;
        }
        close(&mut self.runtime.write().await.process).await
    }

    pub(super) async fn action(&self, command: &Value, logs: &Logs) -> Result<Value> {
        let action = command["action"]
            .as_str()
            .context("Missing managed search action.")?;
        ensure!(
            action != "clear-profiles",
            "The search runtime has no persistent browser profiles."
        );
        let _update = self.update.lock().await;
        ensure!(
            !*self.installer.stop.borrow(),
            "Managed search is shutting down."
        );
        let mut runtime = self.runtime.try_write().map_err(|_| {
            anyhow!("The search runtime is busy; retry after active searches finish.")
        })?;
        if matches!(action, "retry" | "reinstall" | "clear-cache") {
            close(&mut runtime.process).await?;
            runtime.failures = 0;
            runtime.retry = None;
            runtime.rolled_back = false;
            *self.failure.lock().unwrap() = None;
        }
        self.refresh(&mut runtime, action, logs).await;
        self.initialized.send_replace(true);
        self.changed.notify_one();
        checked(
            "managedWebRuntimeActionResultSchema",
            &json!({
                "accepted":true,"component":"searxng","action":action,"status":self.snapshot(),
            }),
        )
    }

    pub(crate) async fn request(&self, parameters: &[(&str, String)]) -> Result<Value> {
        let mut stop = self.installer.stopped();
        let mut initialized = self.initialized.subscribe();
        tokio::select! {
            _ = cancelled(&mut stop) => bail!("Managed search is shutting down."),
            _ = initialized.wait_for(|initialized| *initialized) => {}
        }
        let state = self.runtime.read().await;
        ensure!(
            !*self.installer.stop.borrow(),
            "Managed search is shutting down."
        );
        let Some(process) = state.process.as_ref().filter(|process| {
            !*process.done.borrow() && !process.expired_request.load(Ordering::Acquire)
        }) else {
            let status = self.snapshot();
            let state = status["state"].as_str().unwrap_or("unavailable");
            if let Some(failure) = status["failure"]["message"].as_str() {
                bail!("Search runtime is {state}: {failure}");
            }
            bail!("Search runtime is {state}.");
        };
        let mut url = process.origin.join("/search")?;
        url.query_pairs_mut()
            .extend_pairs(parameters.iter().map(|(key, value)| (*key, value.as_str())));
        let began = Instant::now();
        let result = tokio::select! {
            _ = cancelled(&mut stop) => bail!("Managed search is shutting down."),
            result = timeout(REQUEST, request_json(&self.client, url)) => result,
        };
        if result.is_err() {
            process.expired_request.store(true, Ordering::Release);
            self.changed.notify_one();
            if let Some(logs) = &self.logs {
                logs.event("warn", "Managed search request timed out", json!({
                    "event":"worker.search-runtime.request-timed-out","subsystem":"managed-web-runtime",
                    "operation":"search","status":"retrying","component":"searxng","reasonCode":"request-timeout",
                    "version":process.entry.version,"durationMs":began.elapsed().as_millis() as u64,
                }));
            }
            bail!(
                "Managed web search timed out after {} ms; the search runtime is restarting.",
                REQUEST.as_millis()
            );
        }
        let response = result?;
        if let Some(logs) = &self.logs {
            let (level, message, event, status) = if response.is_ok() {
                (
                    "debug",
                    "Managed search request completed",
                    "worker.search-runtime.request-completed",
                    "completed",
                )
            } else {
                (
                    "warn",
                    "Managed search request failed",
                    "worker.search-runtime.request-failed",
                    "failed",
                )
            };
            logs.event(level, message, json!({
                "event":event,"subsystem":"managed-web-runtime","operation":"search","status":status,
                "component":"searxng","version":process.entry.version,"durationMs":began.elapsed().as_millis() as u64,
            }));
        }
        response
    }

    async fn refresh(&self, runtime: &mut Runtime, action: &str, logs: &Logs) {
        self.installer.perform(action, logs).await;
        if !*self.installer.stop.borrow() {
            self.start_current(runtime, logs).await;
        }
    }

    async fn start_current(&self, runtime: &mut Runtime, logs: &Logs) {
        let Some(pointer) = (match self.installer.storage.current() {
            Ok(pointer) => pointer,
            Err(_) => return,
        }) else {
            return;
        };
        if runtime.process.as_ref().is_some_and(|process| {
            process.entry == pointer.current
                && !*process.done.borrow()
                && !process.expired_request.load(Ordering::Acquire)
        }) {
            return;
        }
        runtime.retry = None;
        if let Err(error) = self.activate(runtime, pointer.current).await {
            self.failed(runtime, "SearXNG failed to start.", &error, logs);
        }
    }

    async fn activate(&self, runtime: &mut Runtime, entry: Entry) -> Result<()> {
        close(&mut runtime.process).await?;
        let version = self.installer.storage.version(&entry);
        let executable = inventory(&version, &entry.version, None)?;
        let state = &self.installer.storage.root;
        let process = spawn(
            &executable,
            &version,
            state,
            entry,
            false,
            self.changed.clone(),
        )?;
        let result = ready(&self.client, &process, self.installer.stopped()).await;
        if result.is_err() {
            process.close().await?;
            return result;
        }
        runtime.process = Some(process);
        *self.failure.lock().unwrap() = None;
        Ok(())
    }

    async fn recover(&self, runtime: &mut Runtime, logs: &Logs) {
        if let Some(process) = runtime.process.as_ref() {
            let exited = *process.done.borrow();
            let timed_out = process.expired_request.load(Ordering::Acquire);
            if exited || timed_out {
                if process.started.elapsed() >= STABLE {
                    runtime.failures = 0;
                    runtime.rolled_back = false;
                }
                let result = close(&mut runtime.process).await;
                if !exited && timed_out && result.is_ok() {
                    self.start_current(runtime, logs).await;
                    return;
                }
                self.failed(
                    runtime,
                    "SearXNG stopped unexpectedly.",
                    &result.err().unwrap_or_else(|| anyhow!("Process exited.")),
                    logs,
                );
                return;
            }
        }
        if runtime.retry.is_none_or(|retry| retry > Instant::now()) {
            return;
        }
        runtime.retry = None;
        if runtime.failures >= 3 && !runtime.rolled_back {
            runtime.rolled_back = true;
            if let Err(error) = self.rollback().await {
                self.failed(runtime, "SearXNG rollback failed.", &error, logs);
                return;
            }
        }
        self.start_current(runtime, logs).await;
    }

    async fn rollback(&self) -> Result<()> {
        let storage = &self.installer.storage;
        let _lock = storage.lock(self.installer.stopped()).await?;
        let Some(pointer) = storage.current()? else {
            return Ok(());
        };
        let Some(previous) = pointer.previous else {
            return Ok(());
        };
        inventory(&storage.version(&previous), &previous.version, None)?;
        let pointer = Pointer {
            current: previous,
            previous: Some(pointer.current),
            verified_at: now(),
        };
        storage.write(&pointer)?;
        self.installer.apply_pointer(&pointer, "ready");
        Ok(())
    }

    fn failed(
        &self,
        runtime: &mut Runtime,
        message: &'static str,
        cause: &anyhow::Error,
        logs: &Logs,
    ) {
        if *self.installer.stop.borrow() {
            return;
        }
        runtime.failures = runtime.failures.saturating_add(1);
        let retryable = runtime.failures < MAX_FAILURES;
        runtime.retry =
            retryable.then(|| Instant::now() + Duration::from_secs(1 << (runtime.failures - 1)));
        *self.failure.lock().unwrap() = Some(
            json!({"category":"process","message":message,"retryable":retryable,"failedAt":now()}),
        );
        logs.event("warn", message, json!({
            "event":"worker.search-runtime.process-failed","subsystem":"managed-web-runtime","component":"searxng",
            "operation":"search-process","status":if retryable {"retrying"} else {"failed"},
            "ioErrorKind":cause.downcast_ref::<std::io::Error>().map(|error| format!("{:?}",error.kind())),
        }));
    }
}

async fn retry_due(retry: Option<Instant>) {
    if let Some(retry) = retry {
        tokio::time::sleep_until(retry).await;
    } else {
        std::future::pending::<()>().await;
    }
}

fn loopback_client() -> Result<Client> {
    Ok(Client::builder()
        .no_proxy()
        .redirect(Policy::none())
        .connect_timeout(Duration::from_secs(2))
        .build()?)
}

async fn request_json(client: &Client, url: Url) -> Result<Value> {
    let mut response = client
        .get(url)
        .header("accept", "application/json")
        .send()
        .await
        .map_err(reqwest::Error::without_url)?;
    ensure!(
        response.status().is_success(),
        "Search runtime returned HTTP {}.",
        response.status().as_u16()
    );
    ensure!(
        response
            .content_length()
            .is_none_or(|size| size <= MAX_RESPONSE as u64),
        "Search runtime response is too large."
    );
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(reqwest::Error::without_url)?
    {
        ensure!(
            chunk.len() <= MAX_RESPONSE - bytes.len(),
            "Search runtime response is too large."
        );
        bytes.extend_from_slice(&chunk);
    }
    parse_json_text(std::str::from_utf8(&bytes)?)
        .map_err(|_| anyhow!("Search runtime returned invalid JSON."))
}

pub(super) fn inventory(
    runtime: &Path,
    version: &str,
    artifact: Option<&Value>,
) -> Result<PathBuf> {
    storage::require_directory(runtime)?;
    let python = if cfg!(windows) {
        "python/python.exe"
    } else {
        "python/bin/python3.13"
    };
    for file in [
        python,
        "app/searxng/searx/webapp.py",
        "app/searxng/searx/version_frozen.py",
        "config-template/settings.yml",
        "config-template/smoke-settings.yml",
        "launcher/serve.py",
        "licenses/manifest.json",
        "source/manifest.json",
        "sbom.cdx.json",
        "build-info.json",
    ] {
        regular_below(runtime, file)?;
    }
    if let Some(artifact) = artifact {
        for key in ["licenseManifest", "sourceManifest"] {
            regular_below(
                runtime,
                artifact[key]
                    .as_str()
                    .context("Missing signed runtime inventory path.")?,
            )?;
        }
    }
    let build = parse_json_text(&storage::read_small(&runtime.join("build-info.json"))?)
        .map_err(|_| anyhow!("Managed search build inventory is invalid."))?;
    ensure!(
        build["schemaVersion"] == 1
            && build["component"] == "searxng"
            && build["version"] == version,
        "Managed search build inventory does not match the release."
    );
    Ok(runtime.join(python))
}

pub(super) async fn probe(
    executable: &Path,
    runtime: &Path,
    base: &Path,
    mut stop: watch::Receiver<bool>,
) -> Result<()> {
    let state = tempfile::Builder::new().prefix("probe-").tempdir_in(base)?;
    let client = loopback_client()?;
    let entry = Entry {
        version: "probe".to_owned(),
        archive: String::new(),
    };
    let process = spawn(
        executable,
        runtime,
        state.path(),
        entry,
        true,
        Arc::new(Notify::new()),
    )?;
    let result = async {
        ready(&client, &process, stop.clone()).await?;
        let mut url = process.origin.join("/search")?;
        url.query_pairs_mut().extend_pairs([
            ("engines", "cantrip offline"),
            ("format", "json"),
            ("q", "managed runtime probe"),
        ]);
        let response = tokio::select! {
            _ = cancelled(&mut stop) => bail!("Managed search probe stopped."),
            result = timeout(Duration::from_secs(5), request_json(&client, url)) => result??,
        };
        ensure!(
            response["results"]
                .as_array()
                .is_some_and(|results| !results.is_empty()),
            "SearXNG probe search returned no fixture results."
        );
        Ok(())
    }
    .await;
    let stopped = process.close().await;
    result.and(stopped)
}

async fn ready(client: &Client, process: &Process, mut stop: watch::Receiver<bool>) -> Result<()> {
    let url = process.origin.join("/healthz")?;
    let mut done = process.done.clone();
    let mut polling = tokio::time::interval(Duration::from_millis(200));
    polling.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    tokio::select! {
        _ = cancelled(&mut stop) => bail!("Managed search is shutting down."),
        _ = done.wait_for(|done| *done) => bail!("SearXNG exited before reaching readiness."),
        result = timeout(STARTUP, async {
            loop {
                polling.tick().await;
                if client.get(url.clone()).timeout(Duration::from_secs(1)).send().await
                    .is_ok_and(|response| response.status().is_success()) {
                    return;
                }
            }
        }) => result.context("SearXNG readiness timed out."),
    }
}

fn spawn(
    executable: &Path,
    runtime: &Path,
    home: &Path,
    entry: Entry,
    smoke: bool,
    changed: Arc<Notify>,
) -> Result<Process> {
    let config = home.join("config");
    let isolated_home = home.join("state/home");
    let temp = home.join("state/tmp");
    let cache = home.join("cache");
    for directory in [&config, &home.join("state"), &isolated_home, &temp, &cache] {
        storage::private(directory)?;
    }
    let template = runtime.join(if smoke {
        "config-template/smoke-settings.yml"
    } else {
        "config-template/settings.yml"
    });
    let template = storage::read_small(&template)?;
    let listener = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))?;
    let port = listener.local_addr()?.port();
    let mut secret = [0; 32];
    getrandom::fill(&mut secret)
        .map_err(|_| anyhow!("Could not generate an isolated search secret."))?;
    ensure!(
        template.matches("__CANTRIP_PORT__").count() == 1
            && template.matches("__CANTRIP_SECRET__").count() == 1,
        "SearXNG settings template placeholders are invalid."
    );
    let settings = template
        .replace("__CANTRIP_PORT__", &port.to_string())
        .replace("__CANTRIP_SECRET__", &hex(&secret));
    let config_path = config.join("settings.yml");
    let mut file = tempfile::NamedTempFile::new_in(&config)?;
    std::io::Write::write_all(&mut file, settings.as_bytes())?;
    file.persist(&config_path)?;
    let mut command = Command::new(executable);
    command
        .current_dir(runtime)
        .arg("-I")
        .arg("-B")
        .arg(runtime.join("launcher/serve.py"))
        .arg("--port")
        .arg(port.to_string())
        .arg("--settings")
        .arg(config_path)
        .env_clear()
        .env("PATH", "")
        .env("HOME", &isolated_home)
        .env("TMPDIR", &temp)
        .env("TMP", &temp)
        .env("TEMP", &temp)
        .env("XDG_CACHE_HOME", &cache)
        .env("PYTHONDONTWRITEBYTECODE", "1")
        .env("PYTHONNOUSERSITE", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    if let Some(root) = std::env::var_os("SystemRoot") {
        command.env("SystemRoot", root);
    }
    drop(listener);
    #[cfg(unix)]
    let mut child = command.process_group(0).spawn()?;
    #[cfg(windows)]
    let (mut child, job) = codex_utils_pty::JobObject::spawn_background(&mut command)?;
    let (stop, stopped) = oneshot::channel();
    let (exited, done) = watch::channel(false);
    let task = tokio::spawn(async move {
        let result = tokio::select! {
            _ = stopped => {
                #[cfg(unix)]
                { stop_unix(&mut child).await }
                #[cfg(windows)]
                {
                    match job {
                        Some(job) => job.terminate()?,
                        None => child.start_kill()?,
                    }
                    timeout(STOP, child.wait()).await??;
                    Ok(())
                }
            }
            result = child.wait() => result.map(|_| ()).map_err(anyhow::Error::from),
        };
        exited.send_replace(true);
        changed.notify_one();
        result
    });
    Ok(Process {
        entry,
        origin: Url::parse(&format!("http://127.0.0.1:{port}"))?,
        started: Instant::now(),
        done,
        task,
        stop,
        expired_request: AtomicBool::new(false),
    })
}

#[cfg(unix)]
async fn stop_unix(child: &mut tokio::process::Child) -> Result<()> {
    const IDENTITY: &str = "SearXNG no longer has an owned child process.";
    cantrip_host::process::signal_owned(child, libc::SIGTERM, true, IDENTITY)?;
    if let Ok(status) = timeout(STOP, child.wait()).await {
        status?;
        return Ok(());
    }
    cantrip_host::process::signal_owned(child, libc::SIGKILL, true, IDENTITY)?;
    timeout(STOP, child.wait()).await??;
    Ok(())
}

impl Process {
    async fn close(self) -> Result<()> {
        let _ = self.stop.send(());
        self.task.await?
    }
}

async fn close(process: &mut Option<Process>) -> Result<()> {
    if let Some(process) = process.take() {
        process.close().await?;
    }
    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::managed_web::{Component, source::Source};
    use cantrip_config::Environment;
    use std::{fs, os::unix::fs::PermissionsExt};

    #[tokio::test]
    #[ignore = "set CANTRIP_TEST_SEARCH_PYTHON to a local Python 3 executable"]
    async fn owned_search_process_queries_reads_and_recovers() -> Result<()> {
        let python = PathBuf::from(
            std::env::var_os("CANTRIP_TEST_SEARCH_PYTHON").context("Missing test interpreter.")?,
        )
        .canonicalize()?;
        let directory = tempfile::tempdir()?;
        let data = directory.path();
        let logs = Arc::new(Logs::initialize(data, &Environment::default(), data).await);
        let mut source = Source::configured("https://127.0.0.1:1/unavailable".into())?;
        source.client = super::loopback_client()?;
        let installer = Manager::new(data, source, Component::Searxng);
        install_fixture(&installer.storage, &python)?;
        let search = Arc::new(Search::new(installer, Some(logs.clone()))?);
        let runner = tokio::spawn({
            let search = search.clone();
            let logs = logs.clone();
            async move { search.run(&logs).await }
        });
        let result = async {
            let address = endpoint_after(&search, None).await?;
            let web = crate::web::Service::with_fixture(None, Some(search.clone()), address);
            let binding = json!({"ownerId":"owner","chatId":"chat"});
            let selected = web
                .search(
                    &binding,
                    Some(&json!({
                        "query":"fixture query","includeDomains":vec!["DOCS.example"],
                        "excludeDomains":vec!["blocked.docs.example"],"safeSearch":"strict",
                        "page":2,"language":"en-US","category":"science","freshness":"month",
                    })),
                )
                .await?;
            assert_eq!(
                selected["summary"],
                "Search returned 1 result with 1 partial engine failure."
            );
            assert_eq!(
                selected["data"]["diagnostics"].as_array().unwrap()[0]["category"],
                "timeout"
            );
            assert_eq!(selected["data"]["truncated"], true);
            let item = &selected["data"]["results"].as_array().unwrap()[0];
            assert_eq!(item["publishedAt"], "2026-08-20T10:00:00.000Z");
            assert_eq!(item["title"], "Fixture title");
            assert_eq!(item["url"], "http://docs.example/article");
            let read = json!({"searchResultId":item["id"],"render":"never"});
            let denied = web
                .read(
                    &json!({"ownerId":"owner","chatId":"different"}),
                    Some(&read),
                )
                .await
                .unwrap_err();
            assert!(denied.to_string().contains("another task"));
            let document = web.read(&binding, Some(&read)).await?;
            assert_eq!(
                document["data"]["content"],
                "The document selected by the search result."
            );
            assert!(search.request(&[("q", "crash".into())]).await.is_err());
            let replacement = endpoint_after(&search, Some(address)).await?;
            assert_ne!(address, replacement);
            assert!(search.request(&[("q", "recovered".into())]).await.is_ok());
            Ok(())
        }
        .await;
        search.stop();
        runner.await??;
        logs.close().await;
        result
    }

    async fn endpoint_after(
        search: &Search,
        prior: Option<std::net::SocketAddr>,
    ) -> Result<std::net::SocketAddr> {
        timeout(Duration::from_secs(10), async {
            loop {
                if let Some(process) = search.runtime.read().await.process.as_ref()
                    && !*process.done.borrow()
                {
                    let address = (
                        std::net::Ipv4Addr::LOCALHOST,
                        process.origin.port().unwrap(),
                    )
                        .into();
                    if Some(address) != prior {
                        return address;
                    }
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        })
        .await
        .context("SearXNG fixture did not publish a live endpoint.")
    }

    fn install_fixture(storage: &storage::Storage, python: &Path) -> Result<()> {
        storage.ensure()?;
        let entry = Entry {
            version: "fixture".into(),
            archive: "a".repeat(64),
        };
        let version = storage.version(&entry);
        let executable = version.join("python/bin/python3.13");
        let interpreter = python
            .to_str()
            .context("Test interpreter path is not Unicode.")?
            .replace('\'', "'\\''");
        let launcher = format!("#!/bin/sh\nexec '{interpreter}' \"$@\"\n");
        for (name, content) in [
            ("python/bin/python3.13", launcher.as_str()),
            ("app/searxng/searx/webapp.py", ""),
            ("app/searxng/searx/version_frozen.py", ""),
            (
                "config-template/settings.yml",
                "port: __CANTRIP_PORT__\nsecret: __CANTRIP_SECRET__\n",
            ),
            (
                "config-template/smoke-settings.yml",
                "port: __CANTRIP_PORT__\nsecret: __CANTRIP_SECRET__\n",
            ),
            ("licenses/manifest.json", "{}"),
            ("source/manifest.json", "{}"),
            ("sbom.cdx.json", "{}"),
            (
                "build-info.json",
                r#"{"schemaVersion":1,"component":"searxng","version":"fixture"}"#,
            ),
            ("launcher/serve.py", FIXTURE),
        ] {
            let file = version.join(name);
            fs::create_dir_all(file.parent().unwrap())?;
            fs::write(file, content)?;
        }
        fs::set_permissions(executable, fs::Permissions::from_mode(0o700))?;
        storage.write(&Pointer {
            current: entry,
            previous: None,
            verified_at: now(),
        })
    }

    const FIXTURE: &str = r#"
import argparse
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        address = urlsplit(self.path)
        args = parse_qs(address.query)
        self.send_reply(address.path, args)

    def send_reply(self, path, args):
        content_type = "text/plain"
        if path == "/search":
            content_type = "application/json"
            query, = args["q"]
            if query == "crash":
                os._exit(7)
            if query.startswith("fixture query"):
                assert query == "fixture query (site:docs.example) -site:blocked.docs.example"
                assert args == {
                    "q": [query], "categories": ["science"], "format": ["json"], "language": ["en-US"],
                    "pageno": ["2"], "safesearch": ["2"], "timeout_limit": ["8"], "time_range": ["month"],
                }
            body = json.dumps({
                "query": query,
                "results": [
                    {"url":"http://docs.example/article#part", "title":" Fixture  title ",
                     "content":" relevant text ", "engines":["fixture"], "publishedDate":"2026-08-20T10:00:00Z"},
                    {"url":"http://docs.example/article"},
                    {"url":"http://blocked.docs.example/article"},
                    {"url":"http://127.0.0.1/private"},
                ],
                "unresponsive_engines":[["fixture","timeout: local diagnostic"]],
            }).encode()
        elif path == "/robots.txt":
            body = b"User-agent: *\n"
        elif path == "/article":
            body = b"The document selected by the search result."
        else:
            assert path == "/healthz"
            body = b"OK"
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", len(body))
        self.end_headers()
        self.wfile.write(body)

parser = argparse.ArgumentParser()
parser.add_argument("--port", type=int)
parser.add_argument("--settings")
args = parser.parse_args()
assert os.environ["PATH"] == ""
ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()
"#;
}
