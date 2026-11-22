//! Own the CodeGraph indexes selected through the worker's existing routing.
mod agent;
mod project;
mod release;
mod runtime;
mod storage;
pub use agent::launch_mcp;
#[cfg(all(test, unix))]
mod tests;

use crate::{
    filesystem::{Scope, paths, source_path},
    git::worktrees::Manager,
    http::checked,
    logging::{self, Logs},
    routing::Registry,
};
use anyhow::{Context, Result, ensure};
use cantrip_wire::{JsString, Value, value::json};
use futures::{StreamExt, future::BoxFuture, stream};
use indexmap::IndexMap;
use project::{Action, Project};
use runtime::{INDEX_DIRECTORY, Installation, Runtime};
use std::{
    io,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::{
    sync::{Mutex as Queue, Notify, Semaphore, watch},
    task::JoinHandle,
};

const MAX_TARGETS: usize = 128;
const AUTHORIZATIONS: usize = 4;
type Emitter = dyn Fn(Value) -> bool + Send + Sync;
type Authorized = (PathBuf, Option<PathBuf>, Value);

struct Inner {
    runtime: Runtime,
    scope: Scope,
    slots: Semaphore,
    logs: Arc<Logs>,
    publish: Arc<Emitter>,
}

struct Entry {
    project: Arc<Project>,
    task: JoinHandle<()>,
}

impl Entry {
    async fn stop(self) -> Arc<Project> {
        self.project.stop.send_replace(true);
        let _ = self.task.await;
        self.project
    }
}

pub(crate) struct Supervisor {
    inner: Arc<Inner>,
    manager: Arc<Manager>,
    projects: Mutex<IndexMap<PathBuf, Entry>>,
    transitions: Queue<Vec<Value>>,
    update_requested: AtomicBool,
    update: Notify,
    updater: Queue<Option<JoinHandle<()>>>,
}

pub(crate) fn supports(kind: &str) -> bool {
    matches!(
        kind,
        "codegraph.status" | "codegraph.sync" | "codegraph.rebuild" | "codegraph.update.check"
    )
}

fn identity(target: &Value, other: &Value) -> bool {
    target["projectId"] == other["projectId"] && target["worktreeId"] == other["worktreeId"]
}

fn path(target: &Value, field: &str) -> Result<PathBuf> {
    Ok(paths::native(
        target[field]
            .as_js_string()
            .context("Missing CodeGraph project path.")?,
    ))
}

impl Supervisor {
    pub(crate) fn new(
        data: &Path,
        stop: watch::Receiver<bool>,
        manager: Arc<Manager>,
        logs: Arc<Logs>,
        publish: Arc<Emitter>,
    ) -> Arc<Self> {
        let inner = Arc::new(Inner {
            runtime: Runtime::new(data),
            scope: Scope::with_stop(stop.clone()),
            slots: Semaphore::new(2),
            logs,
            publish,
        });
        let supervisor = Arc::new(Self {
            inner,
            manager,
            projects: Mutex::default(),
            transitions: Queue::new(Vec::new()),
            update_requested: AtomicBool::new(false),
            update: Notify::new(),
            updater: Queue::new(None),
        });
        if Runtime::supported() {
            *supervisor.updater.try_lock().unwrap() = Some(tokio::spawn({
                let supervisor = supervisor.clone();
                async move {
                    supervisor.run_updates(stop).await;
                }
            }));
        }
        supervisor
    }

    async fn run_updates(&self, stop: watch::Receiver<bool>) {
        match self.inner.runtime.reopen(&self.inner.scope).await {
            Ok(true) => {
                self.refresh().await;
                self.schedule_update();
            }
            Ok(false) => {}
            Err(error) => {
                self.inner.runtime.failed(&error);
                self.schedule_update();
            }
        }
        let source = release::Source::github();
        loop {
            tokio::select! {
                _ = self.inner.scope.stopped() => return,
                _ = self.update.notified() => {},
            }
            if self.inner.scope.check().is_err() {
                return;
            }
            let result = match &source {
                Ok(source) => {
                    self.inner
                        .runtime
                        .update(source, &self.inner.scope, stop.clone())
                        .await
                }
                Err(error) => Err(anyhow::anyhow!(
                    "Could not initialize the CodeGraph release client: {error}"
                )),
            };
            if self.inner.scope.check().is_err() {
                return;
            }
            match result {
                Ok((installed, cleanup_error)) => {
                    if let Some(error) = cleanup_error {
                        self.warn("prune", &error);
                    }
                    if installed {
                        let status = self.inner.runtime.status();
                        self.inner.logs.event("info", "CodeGraph managed runtime installed",
                            json!({"event":"codegraph.runtime.installed","subsystem":"codegraph",
                                "operation":"install-runtime","status":"completed",
                                "version":status["installedVersion"],"previousVersion":status["previousVersion"]}));
                        self.refresh().await;
                    }
                }
                Err(error) => {
                    self.inner.runtime.failed(&error);
                    self.inner.logs.event(
                        "warn",
                        "CodeGraph managed runtime update failed",
                        json!({"event":"codegraph.runtime.update-failed","subsystem":"codegraph",
                            "operation":"update-runtime","reasonCode":"update-failed",
                            "error":logging::error(&error)}),
                    );
                }
            }
            self.update_requested.store(false, Ordering::Release);
        }
    }

    fn schedule_update(&self) {
        if !self.update_requested.swap(true, Ordering::AcqRel) {
            self.update.notify_one();
        }
    }

    fn request_update(&self) -> Result<Value> {
        ensure!(Runtime::supported(), "CodeGraph is unavailable.");
        self.inner.scope.check()?;
        self.schedule_update();
        checked(
            "codeGraphActionAcknowledgementSchema",
            &json!({
                "action":"update-check","jobId":uuid::Uuid::new_v4().to_string(),
                "acceptedAt":runtime::now(),"status":"queued",
            }),
        )
    }

    pub(crate) fn status(&self) -> Value {
        let mut status = self.inner.runtime.status();
        let (mut ready, mut indexing, mut queued, mut degraded) = (0, 0, 0, 0);
        for entry in self.projects.lock().unwrap().values() {
            match entry.project.status()["state"].as_str() {
                Some("ready") => ready += 1,
                Some("indexing" | "syncing") => indexing += 1,
                Some("queued") => queued += 1,
                _ => degraded += 1,
            }
        }
        status["projectCounts"] =
            json!({"ready":ready,"indexing":indexing,"queued":queued,"degraded":degraded});
        status
    }

    async fn authorize(&self, targets: Vec<Value>) -> Result<Vec<Authorized>> {
        let first = &targets[0];
        let source = source_path::canonical(first["sourcePath"].as_js_string().unwrap()).await?;
        let paths = targets
            .iter()
            .map(|target| path(target, "worktreePath"))
            .collect::<Result<Vec<_>>>()?;
        let roots = if first["rootKind"] == "folder-root" {
            let mut roots = Vec::with_capacity(targets.len());
            for target in &targets {
                let root =
                    source_path::canonical(target["worktreePath"].as_js_string().unwrap()).await?;
                ensure!(
                    root == source,
                    "CodeGraph folder root does not match its project source."
                );
                roots.push((root, None));
            }
            roots
        } else {
            self.manager
                .authorize_targets(&source, &paths, &self.inner.scope)
                .await?
                .iter()
                .map(|entry| {
                    Ok((
                        path(&entry["worktree"], "path")?,
                        Some(path(&entry["inventory"], "gitCommonDir")?),
                    ))
                })
                .collect::<Result<Vec<_>>>()?
        };
        Ok(roots
            .into_iter()
            .zip(targets)
            .map(|((root, common), mut target)| {
                target["sourcePath"] = json!(crate::filesystem::paths::text(&source));
                target["worktreePath"] = json!(crate::filesystem::paths::text(&root));
                (root, common, target)
            })
            .collect())
    }

    fn warn(&self, operation: &str, error: &anyhow::Error) {
        self.inner.logs.repeated(
            format!("codegraph-{operation}"),
            "warn",
            "CodeGraph project operation failed",
            json!({"event":format!("codegraph.project.{operation}-failed"),"subsystem":"codegraph",
                "operation":operation,"status":"degraded","error":logging::error(error)}),
        );
    }

    pub(crate) async fn configure(&self, targets: Vec<Value>) {
        let mut desired = self.transitions.lock().await;
        *desired = targets;
        self.reconcile(&desired).await;
    }

    async fn refresh(&self) {
        let desired = self.transitions.lock().await;
        self.reconcile(&desired).await;
        for entry in self.projects.lock().unwrap().values() {
            entry.project.touched();
        }
    }

    async fn reconcile(&self, targets: &[Value]) {
        if self.inner.scope.check().is_err() || self.inner.runtime.active().is_none() {
            return;
        }
        let mut groups = IndexMap::<(JsString, bool), Vec<Value>>::new();
        for target in targets {
            let Some(source) = target["sourcePath"].as_js_string() else {
                continue;
            };
            if target["projectId"].is_null() || target["worktreeId"].is_null() {
                continue;
            }
            groups
                .entry((source.clone(), target["rootKind"] == "folder-root"))
                .or_default()
                .push(target.clone());
        }
        let mut authorized = stream::iter(groups.into_values())
            .map(|targets| self.authorize(targets))
            .buffered(AUTHORIZATIONS);
        let mut desired = IndexMap::new();
        while let Some(group) = authorized.next().await {
            match group {
                Ok(group) => desired.extend(
                    group
                        .into_iter()
                        .map(|(root, common, target)| (root, (common, target))),
                ),
                Err(error) => self.warn("authorization", &error),
            }
        }
        let retired = {
            let mut projects = self.projects.lock().unwrap();
            projects
                .extract_if(.., |root, entry| {
                    desired
                        .get(root)
                        .is_none_or(|(_, target)| entry.project.target != *target)
                })
                .map(|(_, entry)| entry)
                .collect::<Vec<_>>()
        };
        stop_all(retired).await;
        for (root, (common, target)) in desired {
            if self.projects.lock().unwrap().contains_key(&root) {
                continue;
            }
            if let Err(error) = self.install(root, common, target) {
                self.warn("prepare", &error);
            }
        }
    }

    fn install(
        &self,
        root: PathBuf,
        common: Option<PathBuf>,
        target: Value,
    ) -> Result<Arc<Project>> {
        self.inner.scope.check()?;
        if let Some(common) = common {
            project::exclude(&common)?;
        }
        Ok(self.start(root, target))
    }

    fn start(&self, root: PathBuf, target: Value) -> Arc<Project> {
        let project = Project::start(target, root.clone());
        let task = tokio::spawn(project.clone().run(self.inner.clone()));
        self.projects.lock().unwrap().insert(
            root,
            Entry {
                project: project.clone(),
                task,
            },
        );
        project
    }

    async fn ensure_target(&self, desired: &mut Vec<Value>, target: Value) -> Result<Arc<Project>> {
        let (root, common, target) = self.authorize(vec![target]).await?.pop().unwrap();
        desired.retain(|existing| !identity(existing, &target));
        if desired.len() >= MAX_TARGETS {
            desired.remove(0);
        }
        desired.push(target.clone());
        ensure!(
            self.inner.runtime.active().is_some(),
            "CodeGraph is unavailable."
        );
        let retired = {
            let mut projects = self.projects.lock().unwrap();
            let mut retired: Vec<_> = projects
                .extract_if(.., |existing, entry| {
                    (existing == &root || identity(&entry.project.target, &target))
                        && entry.project.target != target
                })
                .map(|(_, entry)| entry)
                .collect();
            if projects.len() == MAX_TARGETS && !projects.contains_key(&root) {
                retired.extend(projects.shift_remove_index(0).map(|(_, entry)| entry));
            }
            retired
        };
        stop_all(retired).await;
        let existing = self
            .projects
            .lock()
            .unwrap()
            .get(&root)
            .map(|entry| entry.project.clone());
        match existing {
            Some(project) => Ok(project),
            None => self.install(root, common, target),
        }
    }

    pub(crate) async fn execute(&self, command: &Value, routing: &Registry) -> Result<Value> {
        let kind = command["type"].as_str().unwrap();
        if kind == "codegraph.update.check" {
            return self.request_update();
        }
        let result = async {
            let command = routing.resolve(command).await?;
            let mut desired = self.transitions.lock().await;
            self.inner.scope.check()?;
            if !command["sourcePath"].is_null() && !command["worktreePath"].is_null()
                && !command["rootKind"].is_null()
            {
                let target = json!({"projectId":command["projectId"],"worktreeId":command["worktreeId"],
                    "rootKind":command["rootKind"],"sourcePath":command["sourcePath"],
                    "worktreePath":command["worktreePath"]});
                self.ensure_target(&mut desired, target).await?;
            }
            let project = self.projects.lock().unwrap().values()
                .find(|entry| identity(&entry.project.target, &command))
                .map(|entry| entry.project.clone())
                .context("CodeGraph is unavailable for this worktree.")?;
            if kind == "codegraph.status" {
                checked("codeGraphProjectStatusSchema", &project.status())
            } else {
                let action = if kind == "codegraph.rebuild" { Action::Rebuild } else { Action::Sync };
                checked("codeGraphActionAcknowledgementSchema", &project.request(action))
            }
        }.await;
        result.map_err(|error| crate::routing::protect_error(kind, error))
    }

    pub(crate) async fn detach(&self, root: &Path) {
        let mut desired = self.transitions.lock().await;
        forget(&mut desired, root);
        let prior = self.projects.lock().unwrap().shift_remove(root);
        if let Some(entry) = prior {
            entry.stop().await;
        }
    }

    pub(crate) async fn with_retired_index(
        &self,
        root: PathBuf,
        operation: BoxFuture<'_, Result<Value>>,
    ) -> Result<Value> {
        let mut desired = self.transitions.lock().await;
        let prior = self.projects.lock().unwrap().shift_remove(&root);
        let prior = match prior {
            Some(entry) => Some(entry.stop().await),
            None => None,
        };
        let initialization = self
            .inner
            .runtime
            .project_lock(&root, &self.inner.scope)
            .await;
        match &initialization {
            Ok(_) => {
                if let Err(error) = self.retire_index(&root).await {
                    self.warn("retirement", &error);
                }
            }
            Err(error) => self.warn("retirement", error),
        }
        let result = operation.await;
        drop(initialization);
        if result
            .as_ref()
            .is_ok_and(|value| value["status"] == "removed")
        {
            forget(&mut desired, &root);
            return result;
        }
        if let Some(project) = prior
            && self.inner.scope.check().is_ok()
            && tokio::fs::metadata(&root)
                .await
                .is_ok_and(|entry| entry.is_dir())
        {
            self.start(root, project.target.clone());
        }
        result
    }

    async fn retire_index(&self, root: &Path) -> Result<()> {
        match tokio::fs::symlink_metadata(root.join(INDEX_DIRECTORY)).await {
            Ok(entry) if entry.is_dir() && !entry.is_symlink() => {}
            Ok(_) => return Ok(()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error.into()),
        }
        let installation = self
            .inner
            .runtime
            .active()
            .context("CodeGraph is unavailable.")?;
        let result = installation
            .run(
                &self.inner.scope,
                root,
                &[
                    "uninit".into(),
                    "--force".into(),
                    root.as_os_str().to_owned(),
                ],
                Duration::from_secs(30),
            )
            .await?;
        Installation::succeeded("uninit", &result)?;
        self.inner.logs.event(
            "info",
            "CodeGraph index retired",
            json!({"event":"codegraph.project.retired","subsystem":"codegraph","operation":"uninit",
                "status":"completed","worktreePath":paths::text(root)}),
        );
        Ok(())
    }

    pub(crate) async fn close(&self) {
        {
            let _transition = self.transitions.lock().await;
            let retired = std::mem::take(&mut *self.projects.lock().unwrap());
            stop_all(retired.into_values()).await;
        }
        if let Some(updater) = self.updater.lock().await.take() {
            let _ = updater.await;
        }
    }
}

fn forget(desired: &mut Vec<Value>, root: &Path) {
    let root = paths::text(root);
    desired.retain(|target| target["worktreePath"].as_js_string() != Some(&root));
}

async fn stop_all(entries: impl IntoIterator<Item = Entry>) {
    let entries = entries.into_iter().collect::<Vec<_>>();
    for entry in &entries {
        entry.project.stop.send_replace(true);
    }
    futures::future::join_all(entries.into_iter().map(Entry::stop)).await;
}
