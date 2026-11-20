//! Physical Git worktree authority, inventory and serialized managed mutations.
mod inventory;
mod mutations;
pub mod observations;
use super::{process, status};
use crate::{
    filesystem::{Scope, explorer::io_error, paths, storage},
    routing::Registry,
};
use anyhow::{Result, bail};
use cantrip_crypto::checked;
use cantrip_wire::{JsString, Value, value::json};
use futures::future::BoxFuture;
use indexmap::IndexMap;
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex, Weak},
};
use tokio::sync::Mutex as Queue;
/// The owning runtime supplies service retirement when those services exist.
pub type BeforeRemove = dyn Fn(PathBuf) -> BoxFuture<'static, Result<()>> + Send + Sync;
pub struct Manager {
    data: PathBuf,
    queues: Mutex<IndexMap<PathBuf, Weak<Queue<()>>>>,
}
impl Manager {
    pub fn new(directory: &Path) -> Self {
        Self {
            data: directory.to_owned(),
            queues: Mutex::default(),
        }
    }
    pub async fn execute_routed(
        &self,
        command: &Value,
        registry: &Registry,
        scope: &Scope,
        before_remove: Option<&BeforeRemove>,
    ) -> Result<(Value, Option<PathBuf>)> {
        let kind = command["type"].as_str().unwrap();
        let result = async {
            let command = registry.resolve(command).await?;
            let result = self.execute(&command, scope, before_remove).await?;
            let removed = result["removedPath"].as_js_string().map(paths::native);
            let receipt = registry.protect_result(kind, &result).await?;
            Ok((receipt, removed))
        }
        .await;
        result.map_err(|error| crate::routing::protect_error(kind, error))
    }
    pub async fn execute(
        &self,
        command: &Value,
        scope: &Scope,
        before_remove: Option<&BeforeRemove>,
    ) -> Result<Value> {
        scope.check()?;
        let source = paths::native(command["sourcePath"].as_js_string().unwrap());
        match command["type"].as_str().unwrap() {
            "worktree.list" | "worktree.reconcile" => self.list(&source, scope).await,
            "worktree.status" => {
                self.status(
                    &source,
                    &paths::native(command["worktreePath"].as_js_string().unwrap()),
                    scope,
                )
                .await
            }
            kind => {
                let key = common(&source, scope).await?;
                let queue = {
                    let mut queues = self.queues.lock().unwrap();
                    let queue = queues
                        .get(&key)
                        .and_then(Weak::upgrade)
                        .unwrap_or_else(|| Arc::new(Queue::new(())));
                    queues.insert(key.clone(), Arc::downgrade(&queue));
                    queue
                };
                let guard = queue.lock().await;
                let result = async {
                    scope.check()?;
                    match kind {
                        "worktree.create" => self.create(&source, command, scope).await,
                        "worktree.remove" => {
                            self.remove(&source, command, scope, before_remove).await
                        }
                        "worktree.lock" | "worktree.unlock" => {
                            self.lock(&source, command, scope).await
                        }
                        "worktree.prune" => {
                            self.prune(&source, command["allowExternal"] == true, scope)
                                .await
                        }
                        _ => bail!("Worktree command is not implemented by the native worker."),
                    }
                }
                .await;
                drop(guard);
                let mut queues = self.queues.lock().unwrap();
                if Arc::strong_count(&queue) == 1 {
                    queues.shift_remove(&key);
                }
                result
            }
        }
    }
    pub async fn status(&self, source: &Path, target: &Path, scope: &Scope) -> Result<Value> {
        let (_, worktree) = self.resolve(source, target, scope).await?;
        if worktree["missing"] == true {
            bail!("Cannot read status from a missing worktree.");
        }
        checked(
            "worktreeStatusResultSchema",
            &json!({"worktree":worktree,
            "status":status::status(&paths::native(worktree["path"].as_js_string().unwrap()),scope).await?}),
        )
    }
}
async fn raw(cwd: &Path, args: &[&str], scope: &Scope) -> Result<String> {
    let output = process::capture(cwd, args, scope).await?;
    if output.code != Some(0) || output.overflow {
        let stderr = process::trim(&String::from_utf8_lossy(&output.stderr));
        let stdout = process::trim(&String::from_utf8_lossy(&output.bytes));
        bail!(
            "{}",
            if !stderr.is_empty() {
                stderr
            } else if !stdout.is_empty() {
                stdout
            } else {
                output.error
            }
        );
    }
    Ok(String::from_utf8_lossy(&output.bytes).into_owned())
}
async fn text(cwd: &Path, args: &[&str], scope: &Scope) -> Result<String> {
    Ok(process::trim(&raw(cwd, args, scope).await?))
}
async fn canonical(path: &Path) -> Result<PathBuf> {
    paths::canonical(path)
        .await
        .map_err(|error| io_error("realpath", path, error))
}
async fn exists(path: &Path) -> Result<bool> {
    match tokio::fs::symlink_metadata(path).await {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(io_error("lstat", path, error)),
    }
}
async fn requested(path: &Path) -> Result<PathBuf> {
    if exists(path).await? {
        canonical(path).await
    } else {
        Ok(paths::resolve(path)?)
    }
}
async fn common(source: &Path, scope: &Scope) -> Result<PathBuf> {
    canonical(Path::new(
        &text(
            source,
            &["rev-parse", "--path-format=absolute", "--git-common-dir"],
            scope,
        )
        .await?,
    ))
    .await
}
fn within(root: &Path, target: &Path) -> bool {
    // Source path.relative additionally rejects a child whose first name starts
    // with two dots, even when it is a lexical descendant.
    paths::within(root, target)
        && !paths::equal(root, target)
        && !paths::relative(root, target).units().starts_with(&[46, 46])
}
fn digest(value: &JsString) -> String {
    Sha256::digest(value.lossy().as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
