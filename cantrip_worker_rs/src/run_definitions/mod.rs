//! Project-owned run definitions on the registered Primary source.
mod discovery;
pub(super) mod environment;
pub(super) mod repository;
mod watch;

use crate::{
    connection::Outbound,
    encryption::Service,
    filesystem::{Scope, paths},
    routing::Registry,
    run_runtime::{self, Environment},
};
use anyhow::{Context, Result, anyhow, bail};
use cantrip_crypto::checked;
use cantrip_wire::{JsString, Value, value::json};
use icu_collator::{Collator, CollatorBorrowed, options::CollatorOptions};
use indexmap::IndexMap;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Weak},
};
use tokio::{
    sync::{Mutex, Semaphore},
    task::JoinHandle,
};

const MAX_OBSERVED_PROJECTS: usize = 256;
const PREFIX: &str = "project.run-configuration-definitions.";

pub(crate) struct Definitions {
    environment: Arc<Environment>,
    observed: Mutex<IndexMap<JsString, Observation>>,
    mutations: Mutex<HashMap<PathBuf, Weak<Mutex<()>>>>,
    scans: Arc<Semaphore>,
}

impl Definitions {
    pub(crate) fn new(environment: Arc<Environment>) -> Self {
        Self {
            environment,
            observed: Mutex::default(),
            mutations: Mutex::default(),
            scans: Arc::new(Semaphore::new(4)),
        }
    }
}

struct Observation {
    root: PathBuf,
    route: Value,
    authority: (JsString, Value),
    job: JoinHandle<()>,
}

impl Drop for Observation {
    fn drop(&mut self) {
        self.job.abort();
    }
}

impl Definitions {
    pub(crate) fn supports(command: &str) -> bool {
        matches!(
            command.strip_prefix(PREFIX),
            Some(
                "get"
                    | "write"
                    | "delete"
                    | "paths"
                    | "capabilities"
                    | "detect"
                    | "validate"
                    | "list"
            )
        )
    }

    pub(crate) async fn execute(
        &self,
        command: &Value,
        routing: &Registry,
        scope: Scope,
        outbound: Arc<Outbound>,
        encryption: Arc<Service>,
    ) -> Result<Value> {
        let source = routing.resolve(&command["sourcePath"]).await?;
        let root = paths::canonical(&paths::native(
            source
                .as_js_string()
                .context("Run configuration source path")?,
        ))
        .await?;
        if !tokio::fs::symlink_metadata(&root).await?.is_dir() {
            let message = if command["type"] == "project.run-configuration-definitions.paths" {
                "The Run configuration source root is not a directory."
            } else {
                "The project root must be a real directory."
            };
            bail!(message);
        }
        let project = command["projectId"]
            .as_js_string()
            .context("Run configuration project")?;
        scope.check()?;
        if let Ok(authority) = encryption.bound_identity() {
            self.observe(
                project,
                &root,
                &command["sourcePath"],
                authority,
                outbound,
                encryption,
            )
            .await;
        }
        let operation = command["type"]
            .as_str()
            .and_then(|kind| kind.strip_prefix(PREFIX))
            .context("Run configuration action")?;
        let lock = if matches!(operation, "write" | "delete") {
            Some(self.mutation_lock(&root).await)
        } else {
            None
        };
        let command = command.clone();
        let guard = match lock {
            Some(lock) => Some(lock.lock_owned().await),
            None => None,
        };
        // Once a filesystem mutation has started, finish publication even if
        // the command socket disconnects or a response is no longer needed.
        let environment = self.environment.clone();
        tokio::task::spawn_blocking(move || {
            let _guard = guard;
            scope.check()?;
            execute(command, root, &scope, &environment)
        })
        .await?
    }

    async fn mutation_lock(&self, root: &Path) -> Arc<Mutex<()>> {
        let mut locks = self.mutations.lock().await;
        locks.retain(|_, lock| lock.strong_count() != 0);
        if let Some(lock) = locks.get(root).and_then(Weak::upgrade) {
            return lock;
        }
        let lock = Arc::new(Mutex::new(()));
        locks.insert(root.to_owned(), Arc::downgrade(&lock));
        lock
    }

    async fn observe(
        &self,
        project: &JsString,
        root: &Path,
        route: &Value,
        authority: (JsString, Value),
        outbound: Arc<Outbound>,
        encryption: Arc<Service>,
    ) {
        let mut observed = self.observed.lock().await;
        if let Some(current) = observed.shift_remove(project)
            && current.root == root
            && &current.route == route
            && current.authority == authority
            && !current.job.is_finished()
        {
            observed.insert(project.clone(), current);
            return;
        }
        let root = root.to_owned();
        let port = watch::Port {
            project: project.clone(),
            route: route.clone(),
            authority: authority.clone(),
            outbound,
            encryption,
        };
        let Ok(job) = watch::start(root.clone(), port, self.scans.clone()).await else {
            return;
        };
        observed.insert(
            project.clone(),
            Observation {
                root,
                route: route.clone(),
                authority,
                job,
            },
        );
        if observed.len() > MAX_OBSERVED_PROJECTS {
            observed.shift_remove_index(0);
        }
    }

    pub(crate) async fn close(&self) {
        let mut observed = self.observed.lock().await;
        for (_, mut entry) in observed.drain(..) {
            entry.job.abort();
            let _ = (&mut entry.job).await;
        }
    }
}

fn execute(
    command: Value,
    root: PathBuf,
    scope: &Scope,
    environment: &Environment,
) -> Result<Value> {
    let operation = command["type"]
        .as_str()
        .unwrap()
        .strip_prefix(PREFIX)
        .unwrap();
    let mut response = json!({"operation":operation,"operationId":command["operationId"],"projectId":command["projectId"]});
    let schema = match operation {
        "capabilities" => {
            response["capabilities"] = run_runtime::capabilities();
            "runConfigurationCapabilitiesResponseSchema"
        }
        "detect" => {
            let (candidates, diagnostics) =
                run_runtime::detect(&root, command["providerKind"].as_str(), scope)?;
            response["candidates"] = json!(candidates);
            response["diagnostics"] = json!(diagnostics);
            "runConfigurationDetectResponseSchema"
        }
        "validate" => {
            response["validation"] =
                run_runtime::validation(&command["document"], &root, environment)?;
            "runConfigurationValidateResponseSchema"
        }
        "list" => {
            let inventory = repository::Repository::new(root.clone()).scan()?;
            let mut validations = Vec::new();
            for entry in inventory["entries"].as_array().unwrap() {
                scope.check()?;
                if entry["status"] == "ready" {
                    validations.push(run_runtime::validation(
                        &entry["document"],
                        &root,
                        environment,
                    )?);
                }
            }
            response["inventory"] = inventory;
            response["validations"] = json!(validations);
            "runConfigurationListResponseSchema"
        }
        "paths" => {
            let purpose = command["purpose"].as_str().unwrap();
            let paths = discovery::paths(
                &root,
                purpose,
                command["query"].as_js_string().unwrap(),
                scope,
            )?;
            response["purpose"] = command["purpose"].clone();
            response["query"] = command["query"].clone();
            response["suggestions"] = paths["suggestions"].clone();
            response["truncated"] = paths["truncated"].clone();
            "runConfigurationPathsResponseSchema"
        }
        "get" => {
            let id = command["configurationId"].as_str().unwrap();
            let entry = repository::Repository::new(root.clone()).read(id)?;
            let enabled = entry.as_ref().filter(|entry| entry["status"] == "ready").is_some_and(|entry| {
                let doc = &entry["document"];
                doc["platformOverrides"][crate::platform::platform()]["environment"]["includeCodexEnvironment"].as_bool()
                    .or_else(|| doc["environment"]["includeCodexEnvironment"].as_bool())
                    .unwrap_or(false)
            });
            response["result"] = match entry {
                Some(entry) => json!({"found":true,"entry":entry}),
                None => json!({"found":false,"id":id}),
            };
            response["codexEnvironment"] = environment::status(&root, enabled)?;
            response["secretReferences"] = Value::Array(vec![]);
            "runConfigurationGetResponseSchema"
        }
        "write" => {
            response["result"] = repository::Repository::new(root).write(&command["request"])?;
            "runConfigurationWriteResponseSchema"
        }
        "delete" => {
            response["result"] = repository::Repository::new(root).delete(&command["request"])?;
            "runConfigurationDeleteResponseSchema"
        }
        _ => bail!("Unknown Run configuration definition action."),
    };
    checked(schema, &response)
}

pub(crate) fn collator() -> Result<CollatorBorrowed<'static>> {
    let locale: icu_locale_core::Locale = cantrip_wire::environment::locale()
        .unwrap_or("en-US")
        .parse()
        .unwrap_or_else(|_| "en-US".parse().unwrap());
    Collator::try_new(locale.into(), CollatorOptions::default())
        .map_err(|error| anyhow!("Run configuration sorting locale: {error}"))
}

fn diagnostic(code: &str, message: &str, relative: Option<&str>, field: Value) -> Value {
    json!({"severity":"error","code":code,"message":message,"relativePath":relative,"field":field})
}
