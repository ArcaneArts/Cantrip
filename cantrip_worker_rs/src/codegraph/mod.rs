//! Own the CodeGraph indexes selected through the worker's existing routing.
mod project;
mod runtime;

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
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    sync::{Mutex as Queue, Semaphore},
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
    transitions: Queue<()>,
    probe: Queue<Option<JoinHandle<()>>>,
}

pub(crate) fn supports(kind: &str) -> bool {
    matches!(
        kind,
        "codegraph.status" | "codegraph.sync" | "codegraph.rebuild"
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
        scope: Scope,
        manager: Arc<Manager>,
        logs: Arc<Logs>,
        publish: Arc<Emitter>,
    ) -> Self {
        let inner = Arc::new(Inner {
            runtime: Runtime::new(data),
            scope,
            slots: Semaphore::new(2),
            logs,
            publish,
        });
        let probe = tokio::spawn({
            let inner = inner.clone();
            async move {
                let _ = inner.runtime.ready(&inner.scope).await;
            }
        });
        Self {
            inner,
            manager,
            projects: Mutex::default(),
            transitions: Queue::new(()),
            probe: Queue::new(Some(probe)),
        }
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
        let _transition = self.transitions.lock().await;
        if self.inner.scope.check().is_err()
            || self.inner.runtime.ready(&self.inner.scope).await.is_err()
        {
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
                .push(target);
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

    fn install(&self, root: PathBuf, common: Option<PathBuf>, target: Value) -> Result<()> {
        self.inner.scope.check()?;
        if let Some(common) = common {
            project::exclude(&common)?;
        }
        self.start(root, target);
        Ok(())
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

    pub(crate) async fn execute(&self, command: &Value, routing: &Registry) -> Result<Value> {
        let kind = command["type"].as_str().unwrap();
        let result = async {
            let command = routing.resolve(command).await?;
            let _transition = self.transitions.lock().await;
            self.inner.scope.check()?;
            self.inner.runtime.ready(&self.inner.scope).await
                .context("CodeGraph is unavailable.")?;
            if !command["sourcePath"].is_null() && !command["worktreePath"].is_null()
                && !command["rootKind"].is_null()
            {
                let target = json!({"projectId":command["projectId"],"worktreeId":command["worktreeId"],
                    "rootKind":command["rootKind"],"sourcePath":command["sourcePath"],
                    "worktreePath":command["worktreePath"]});
                let (root, common, target) = self.authorize(vec![target]).await?.pop().unwrap();
                let retired = {
                    let mut projects = self.projects.lock().unwrap();
                    let mut retired: Vec<_> = projects.extract_if(.., |existing, entry| {
                        (existing == &root || identity(&entry.project.target, &target))
                            && entry.project.target != target
                    }).map(|(_, entry)| entry).collect();
                    if projects.len() == MAX_TARGETS && !projects.contains_key(&root) {
                        retired.extend(projects.shift_remove_index(0).map(|(_, entry)| entry));
                    }
                    retired
                };
                stop_all(retired).await;
                if !self.projects.lock().unwrap().contains_key(&root) {
                    self.install(root, common, target)?;
                }
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
        let _transition = self.transitions.lock().await;
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
        let _transition = self.transitions.lock().await;
        let prior = self.projects.lock().unwrap().shift_remove(&root);
        let prior = match prior {
            Some(entry) => Some(entry.stop().await),
            None => None,
        };
        if let Err(error) = self.retire_index(&root).await {
            self.warn("retirement", &error);
        }
        let result = operation.await;
        if let Some(project) = prior
            && !result
                .as_ref()
                .is_ok_and(|value| value["status"] == "removed")
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
        let installation = self.inner.runtime.ready(&self.inner.scope).await?;
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
        let _transition = self.transitions.lock().await;
        let retired = std::mem::take(&mut *self.projects.lock().unwrap());
        stop_all(retired.into_values()).await;
        if let Some(probe) = self.probe.lock().await.take() {
            let _ = probe.await;
        }
    }
}

async fn stop_all(entries: impl IntoIterator<Item = Entry>) {
    let entries = entries.into_iter().collect::<Vec<_>>();
    for entry in &entries {
        entry.project.stop.send_replace(true);
    }
    futures::future::join_all(entries.into_iter().map(Entry::stop)).await;
}
