//! One writer and one watcher for each authorized index.
use super::{
    Inner,
    runtime::{INDEX_DIRECTORY, Installation, now},
};
use crate::{
    filesystem::{Scope, paths},
    logging,
};
use anyhow::{Context, Result, ensure};
use cantrip_wire::{JsString, Value, parse_json_text, value::json};
use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use std::{
    ffi::OsString,
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::{
    sync::{Notify, watch},
    time::Instant,
};
use uuid::Uuid;

const MARKER: &str = "# BEGIN CANTRIP CODEGRAPH";
const STATUS_LIMIT: Duration = Duration::from_secs(30);
const SYNC_LIMIT: Duration = Duration::from_secs(300);
const INDEX_LIMIT: Duration = Duration::from_secs(1800);
const CHECK_INTERVAL: Duration = Duration::from_secs(120);
const CLEAN_INTERVAL: Duration = Duration::from_secs(1800);
const WATCH_RETRY: Duration = Duration::from_secs(5);
const AGENT_CATCH_UP_INTERVAL: Duration = Duration::from_secs(30);
const AGENT_WAIT: Duration = Duration::from_secs(1);

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(super) enum Action {
    Sync,
    Ensure,
    Rebuild,
}

impl Action {
    fn label(self) -> &'static str {
        match self {
            Self::Sync => "sync",
            Self::Ensure => "ensure",
            Self::Rebuild => "rebuild",
        }
    }
}

struct State {
    status: Value,
    request: Option<(Action, Instant)>,
    failures: u32,
    published: bool,
    working: bool,
    last_sync: Option<Instant>,
}

pub(super) struct Project {
    pub target: Value,
    pub root: PathBuf,
    pub stop: watch::Sender<bool>,
    state: Mutex<State>,
    wake: Notify,
    settled: Notify,
    failed_watch: AtomicBool,
}

impl Project {
    pub(super) fn start(target: Value, root: PathBuf) -> Arc<Self> {
        let (stop, _) = watch::channel(false);
        Arc::new(Self {
            target: target.clone(),
            root,
            stop,
            state: Mutex::new(State {
                status: json!({"projectId":target["projectId"],"worktreeId":target["worktreeId"],"state":"queued",
                    "lastIndexedAt":Value::Null,"lastSuccessfulSyncAt":Value::Null,"fileCount":Value::Null,
                    "nodeCount":Value::Null,"edgeCount":Value::Null,"pendingChanges":Value::Null,
                    "statusMessage":Value::Null,"job":Value::Null}),
                request: Some((Action::Ensure, Instant::now())),
                failures: 0,
                published: false,
                working: false,
                last_sync: None,
            }),
            wake: Notify::new(),
            settled: Notify::new(),
            failed_watch: AtomicBool::new(false),
        })
    }

    pub(super) fn status(&self) -> Value {
        self.state.lock().unwrap().status.clone()
    }

    pub(super) fn request(&self, action: Action) -> Value {
        let at = now();
        let id = Uuid::new_v4().to_string();
        let mut state = self.state.lock().unwrap();
        state.status["job"] = json!({"id":id,"action":action.label(),"state":"queued",
            "requestedAt":at,"completedAt":Value::Null});
        state.request = Some((
            action.max(state.request.map_or(action, |(queued, _)| queued)),
            Instant::now(),
        ));
        if !matches!(state.status["state"].as_str(), Some("syncing" | "indexing")) {
            state.status["state"] = json!("queued");
        }
        state.published = false;
        self.wake.notify_one();
        json!({"jobId":id,"action":action.label(),"acceptedAt":at,"status":"queued"})
    }

    pub(super) fn touched(&self) {
        let now = Instant::now();
        let mut state = self.state.lock().unwrap();
        if state
            .request
            .is_none_or(|(action, due)| action == Action::Sync && due > now)
        {
            state.request = Some((Action::Sync, now + Duration::from_secs(1)));
        }
        self.wake.notify_one();
    }

    pub(super) async fn prepare_for_agent(&self) {
        let mut stop = self.stop.subscribe();
        let now = Instant::now();
        {
            let mut state = self.state.lock().unwrap();
            let stale = state
                .last_sync
                .is_none_or(|last| now.saturating_duration_since(last) >= AGENT_CATCH_UP_INTERVAL)
                || state.status["pendingChanges"].as_u64() != Some(0)
                || state.status["state"] == "degraded";
            if stale && !state.working {
                let action = state.request.map_or(Action::Sync, |(action, _)| action);
                state.request = Some((action, now));
                self.wake.notify_one();
            }
        }
        let deadline = tokio::time::sleep_until(now + AGENT_WAIT);
        tokio::pin!(deadline);
        loop {
            let settled = self.settled.notified();
            tokio::pin!(settled);
            settled.as_mut().enable();
            {
                let state = self.state.lock().unwrap();
                if *stop.borrow()
                    || (!state.working
                        && state.request.is_none_or(|(_, due)| due > now + AGENT_WAIT))
                {
                    return;
                }
            }
            tokio::select! {
                _ = stop.changed() => return,
                _ = &mut deadline => return,
                _ = settled => {},
            }
        }
    }

    fn watcher(self: &Arc<Self>) -> Result<RecommendedWatcher> {
        let project = Arc::downgrade(self);
        let mut watcher = RecommendedWatcher::new(
            move |event: notify::Result<Event>| {
                let Some(project) = project.upgrade() else {
                    return;
                };
                match event {
                    Ok(event)
                        if !event.kind.is_access()
                            && (event.paths.is_empty()
                                || event
                                    .paths
                                    .iter()
                                    .any(|path| relevant(&project.root, path))) =>
                    {
                        project.touched()
                    }
                    Ok(_) => {}
                    Err(_) => {
                        project.failed_watch.store(true, Ordering::Release);
                        project.wake.notify_one();
                    }
                }
            },
            notify::Config::default(),
        )?;
        watcher.watch(&self.root, RecursiveMode::Recursive)?;
        Ok(watcher)
    }

    fn publish(&self, inner: &Inner) {
        let mut state = self.state.lock().unwrap();
        if !state.published {
            state.published =
                (inner.publish)(json!({"type":"codegraph.status.observed","status":state.status}));
        }
    }

    pub(super) async fn run(self: Arc<Self>, inner: Arc<Inner>) {
        let mut stop = self.stop.subscribe();
        let scope = Scope::with_stop(stop.clone());
        let mut watcher = None;
        let mut next_watch = Instant::now();
        let mut next_check = Instant::now() + CHECK_INTERVAL;
        let mut next_publication = Instant::now();
        loop {
            if scope.check().is_err() {
                return;
            }
            let now = Instant::now();
            if self.failed_watch.swap(false, Ordering::AcqRel) {
                watcher = None;
                next_watch = now + WATCH_RETRY;
                next_check = next_check.min(now + CHECK_INTERVAL);
            }
            if watcher.is_none() && now >= next_watch {
                match self.watcher() {
                    Ok(handle) => watcher = Some(handle),
                    Err(error) => {
                        inner.logs.repeated(format!("codegraph-watch:{}", self.root.display()), "warn",
                            "CodeGraph worktree watcher is unavailable",
                            json!({"event":"codegraph.project.watcher-failed","subsystem":"codegraph",
                                "worktreePath":paths::text(&self.root),"error":logging::error(&error)}));
                        next_watch = now + WATCH_RETRY;
                    }
                }
            }
            let (action, wait, unpublished) = {
                let mut state = self.state.lock().unwrap();
                if now >= next_check && state.request.is_none() {
                    state.request = Some((Action::Sync, now));
                }
                let action = match state.request {
                    Some((action, due)) if due <= now => {
                        state.request = None;
                        state.working = true;
                        Some(action)
                    }
                    _ => None,
                };
                (action, state.request.map(|(_, due)| due), !state.published)
            };
            if unpublished && now >= next_publication {
                self.publish(&inner);
                next_publication = now + Duration::from_secs(1);
            }
            if let Some(action) = action {
                let permit = tokio::select! {
                    _ = scope.stopped() => return,
                    result = inner.slots.acquire() => match result { Ok(permit) => permit, Err(_) => return },
                };
                let Some(installed) = inner.runtime.active() else {
                    return;
                };
                self.perform(&inner, &installed, &scope, action).await;
                self.state.lock().unwrap().working = false;
                self.settled.notify_waiters();
                drop(permit);
                let status = self.status();
                next_check = Instant::now()
                    + if watcher.is_some()
                        && status["state"] == "ready"
                        && status["pendingChanges"].as_u64() == Some(0)
                    {
                        CLEAN_INTERVAL
                    } else {
                        CHECK_INTERVAL
                    };
                continue;
            }
            let mut until = wait.map_or(next_check, |due| due.min(next_check));
            // A pending retry owns the next attempt even if the safety sweep is due.
            if let Some(due) = wait
                && now >= next_check
            {
                until = due;
            }
            if watcher.is_none() {
                until = until.min(next_watch);
            }
            if unpublished {
                until = until.min(next_publication);
            }
            tokio::select! {
                _ = stop.changed() => return,
                _ = self.wake.notified() => {},
                _ = tokio::time::sleep_until(until) => {},
            }
        }
    }

    async fn perform(
        &self,
        inner: &Inner,
        installation: &Installation,
        scope: &Scope,
        action: Action,
    ) {
        let active = {
            let mut state = self.state.lock().unwrap();
            state.status["state"] = json!(if action == Action::Sync {
                "syncing"
            } else {
                "indexing"
            });
            state.status["statusMessage"] = Value::Null;
            let covers_job = state.status["job"]["action"] == "sync" || action == Action::Rebuild;
            let id = if covers_job && state.status["job"]["state"] == "queued" {
                state.status["job"]["state"] = json!("running");
                state.status["job"]["id"].clone()
            } else {
                Value::Null
            };
            state.published = false;
            id
        };
        self.publish(inner);
        let result = match inner.runtime.project_lock(&self.root, scope).await {
            Ok(initialization) => {
                apply(installation, scope, &self.root, action, initialization).await
            }
            Err(error) => Err(error),
        };
        if scope.check().is_err() {
            return;
        }
        let mut state = self.state.lock().unwrap();
        let successful = result.is_ok();
        match result {
            Ok(snapshot) => {
                state.failures = 0;
                state.last_sync = Some(Instant::now());
                state.status["state"] = json!("ready");
                state.status["lastSuccessfulSyncAt"] = json!(now());
                for field in [
                    "fileCount",
                    "nodeCount",
                    "edgeCount",
                    "pendingChanges",
                    "lastIndexedAt",
                ] {
                    state.status[field] = snapshot[field].clone();
                }
            }
            Err(error) => {
                state.failures = state.failures.saturating_add(1);
                state.status["state"] = json!("degraded");
                state.status["statusMessage"] = public_message(&error);
                let delay = Duration::from_secs(
                    (5_u64 << state.failures.saturating_sub(1).min(6)).min(300),
                );
                if state.request.is_none() {
                    state.request = Some((action, Instant::now() + delay));
                }
                inner.logs.repeated(format!("codegraph-sync:{}", self.root.display()), "warn",
                    "CodeGraph worktree synchronization failed",
                    json!({"event":"codegraph.project.sync-failed","subsystem":"codegraph","operation":action.label(),
                        "worktreePath":paths::text(&self.root),"error":logging::error(&error)}));
            }
        }
        if !active.is_null() && state.status["job"]["id"] == active {
            state.status["job"]["state"] = json!(if successful { "completed" } else { "failed" });
            state.status["job"]["completedAt"] = json!(now());
        }
        state.published = false;
        drop(state);
        self.publish(inner);
    }
}

fn relevant(root: &Path, file: &Path) -> bool {
    file.strip_prefix(root)
        .ok()
        .and_then(|relative| relative.components().next())
        .is_none_or(|part| part.as_os_str() != INDEX_DIRECTORY && part.as_os_str() != ".git")
}

fn public_message(error: &anyhow::Error) -> Value {
    let error = logging::error(error);
    let message = error["message"]
        .as_js_string()
        .map(|text| JsString::new(text.units()[..text.len().min(1000)].to_vec()));
    json!(message)
}

fn safe_index(root: &Path) -> Result<()> {
    match fs::symlink_metadata(root.join(INDEX_DIRECTORY)) {
        Ok(entry) => ensure!(
            entry.is_dir() && !entry.is_symlink(),
            "CodeGraph index location is not a local directory."
        ),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    Ok(())
}

async fn apply(
    installation: &Installation,
    scope: &Scope,
    root: &Path,
    action: Action,
    initialization: fs::File,
) -> Result<Value> {
    safe_index(root)?;
    let before = inspect(installation, scope, root, true).await?;
    let _initialization = (before["initialized"] != true).then_some(initialization);
    if action == Action::Sync
        && before["initialized"] == true
        && before["pendingChanges"].as_u64() == Some(0)
        && before["reindexRecommended"] != true
    {
        return Ok(before);
    }
    let name = if before["initialized"] != true {
        "init"
    } else if action == Action::Rebuild || before["reindexRecommended"] == true {
        "index"
    } else {
        "sync"
    };
    run_operation(installation, scope, root, name).await
}

pub(super) async fn ensure_mcp_index(
    installation: &Installation,
    scope: &Scope,
    root: &Path,
) -> Result<()> {
    safe_index(root)?;
    if inspect(installation, scope, root, true).await?["initialized"] != true {
        run_operation(installation, scope, root, "init").await?;
    }
    Ok(())
}

async fn run_operation(
    installation: &Installation,
    scope: &Scope,
    root: &Path,
    name: &str,
) -> Result<Value> {
    let result = installation
        .run(
            scope,
            root,
            &[name.into(), root.as_os_str().to_owned()],
            if name == "sync" {
                SYNC_LIMIT
            } else {
                INDEX_LIMIT
            },
        )
        .await?;
    Installation::succeeded(name, &result)?;
    let after = inspect(installation, scope, root, false).await?;
    ensure!(
        after["initialized"] == true,
        "CodeGraph did not initialize its index."
    );
    Ok(after)
}

async fn inspect(
    installation: &Installation,
    scope: &Scope,
    root: &Path,
    accept_ancestor: bool,
) -> Result<Value> {
    let args = inspect_arguments(root);
    let result = installation.run(scope, root, &args, STATUS_LIMIT).await?;
    inspect_output(root, accept_ancestor, result).await
}

pub(super) async fn inspect_existing(
    installation: &Installation,
    scope: &Scope,
    root: &Path,
) -> Result<Value> {
    safe_index(root)?;
    let result = installation
        .run_read_only(scope, root, &inspect_arguments(root))
        .await?;
    inspect_output(root, true, result).await
}

fn inspect_arguments(root: &Path) -> [OsString; 3] {
    [
        "status".into(),
        "--json".into(),
        root.as_os_str().to_owned(),
    ]
}

async fn inspect_output(
    root: &Path,
    accept_ancestor: bool,
    result: crate::filesystem::command::Captured,
) -> Result<Value> {
    if result.code != Some(0) {
        let mut output = String::from_utf8_lossy(if result.stderr.is_empty() {
            &result.stdout
        } else {
            &result.stderr
        })
        .into_owned();
        output.make_ascii_lowercase();
        if output.contains("not initialized") || output.contains("not found") {
            return Ok(json!({"initialized":false}));
        }
        Installation::succeeded("status", &result)?;
    }
    let output = std::str::from_utf8(&result.stdout)?;
    let json = output
        .lines()
        .rev()
        .map(str::trim)
        .find(|line| line.starts_with('{') && line.ends_with('}'))
        .context("CodeGraph status did not return JSON.")?;
    let payload =
        parse_json_text(json).map_err(|_| anyhow::anyhow!("CodeGraph status JSON is invalid."))?;
    ensure!(
        payload["initialized"].is_boolean(),
        "CodeGraph returned an invalid initialized state."
    );
    if let Some(path) = payload["projectPath"].as_str() {
        let actual = paths::canonical(Path::new(path)).await?;
        if actual != root {
            if accept_ancestor && root.starts_with(&actual) {
                return Ok(json!({"initialized":false}));
            }
            anyhow::bail!("CodeGraph status resolved a different project path.");
        }
    }
    let count = |value: &Value| value.as_u64().filter(|count| *count <= (1 << 53) - 1);
    let changes = &payload["pendingChanges"];
    let pending = count(&changes["added"])
        .zip(count(&changes["modified"]))
        .zip(count(&changes["removed"]))
        .and_then(|((a, b), c)| count(&json!(a + b + c)));
    let indexed = payload["lastIndexed"]
        .as_str()
        .and_then(|time| chrono::DateTime::parse_from_rfc3339(time).ok())
        .map(|time| {
            time.with_timezone(&chrono::Utc)
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        });
    Ok(
        json!({"initialized":payload["initialized"],"reindexRecommended":payload["index"]["reindexRecommended"] == true,
        "fileCount":count(&payload["fileCount"]),"nodeCount":count(&payload["nodeCount"]),"edgeCount":count(&payload["edgeCount"]),
        "pendingChanges":pending,"lastIndexedAt":indexed}),
    )
}

pub(super) fn exclude(common: &Path) -> Result<()> {
    let common = common.canonicalize()?;
    let info = common.join("info");
    fs::create_dir_all(&info)?;
    let directory = info.canonicalize()?;
    ensure!(
        directory.starts_with(&common) && directory != common,
        "CodeGraph Git exclude path is unsafe."
    );
    let exclude = directory.join("exclude");
    match fs::symlink_metadata(&exclude) {
        Ok(entry) => ensure!(
            entry.is_file() && !entry.is_symlink(),
            "CodeGraph Git exclude path is unsafe."
        ),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    let original = match fs::read(&exclude) {
        Ok(original) => original,
        Err(error) if error.kind() == io::ErrorKind::NotFound => Vec::new(),
        Err(error) => return Err(error.into()),
    };
    if original
        .windows(MARKER.len())
        .any(|line| line == MARKER.as_bytes())
    {
        return Ok(());
    }
    let mut temp = tempfile::NamedTempFile::new_in(directory)?;
    temp.write_all(&original)?;
    if !original.is_empty() && !original.ends_with(b"\n") {
        writeln!(temp)?;
    }
    writeln!(
        temp,
        "{MARKER}\n/{INDEX_DIRECTORY}/\n# END CANTRIP CODEGRAPH"
    )?;
    temp.as_file().sync_all()?;
    temp.persist(exclude).map_err(|error| error.error)?;
    Ok(())
}
