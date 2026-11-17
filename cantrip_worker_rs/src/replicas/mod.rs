//! Worker-local replica provisioning, ownership and managed-link repair.
//! Existing persistent formats are preserved; no server/database is linked.
mod clone;
mod git;
pub mod placement;
mod provision;
mod repair;
use crate::filesystem::{Scope, paths, storage};
use anyhow::Result;
use cantrip_wire::{JsString, Value, value::json};
pub use clone::{clone_failure, parse_clone_progress, summarize_clone_failure};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

pub type Progress<'a> = dyn Fn(Value) + Send + Sync + 'a;
pub struct Manager {
    directory: PathBuf,
    placement: placement::Manager,
    queues: Mutex<HashMap<JsString, Arc<tokio::sync::Mutex<()>>>>,
}
impl Manager {
    pub fn new(directory: &Path, worker: &JsString) -> Self {
        Self {
            directory: directory.to_owned(),
            placement: placement::Manager::new(directory, worker.clone()),
            queues: Mutex::default(),
        }
    }
    pub async fn execute(
        &self,
        command: &Value,
        scope: &Scope,
        progress: &Progress<'_>,
    ) -> Result<Value> {
        if command["type"] == "project.replica.link.repair" {
            return self
                .queued(
                    crate::filesystem::source_path::normalize(
                        command["sourcePath"].as_js_string().unwrap(),
                        cfg!(windows),
                    )?,
                    scope,
                    self.repair(command, scope),
                )
                .await;
        }
        anyhow::ensure!(
            command["type"] == "project.replica.provision",
            "Unsupported native replica command."
        );
        let input = json!({
            "jobId":command["jobId"], "attempt":command["attempt"],
            "projectId":command.get("projectId").cloned().unwrap_or_else(||command["jobId"].clone()),
            "nameWithOwner":command["repository"].get("nameWithOwner").cloned().unwrap_or(Value::Null),
            "placement":command.get("placement").cloned().unwrap_or_else(||json!({"mode":"managed"})),
            "workspaceStorage":command.get("workspaceStorage").cloned().unwrap_or_else(||json!({"kind":"system"})),
            "expectedRevision":command["expectedRevision"],
        });
        let identity = input["nameWithOwner"]
            .as_js_string()
            .map(crate::github::repository_parts)
            .transpose()?;
        let queue_target = if input["placement"]["mode"] == "direct" {
            input["placement"]["path"].as_js_string().unwrap().clone()
        } else if let Some(identity) = &identity {
            paths::text(&self.managed_target(&input["workspaceStorage"], identity)?)
        } else {
            JsString::from(format!(
                "invalid-local-git:{}",
                input["jobId"].as_str().unwrap()
            ))
        };
        self.queued(
            queue_target,
            scope,
            self.provision(&input, identity.as_deref(), scope, progress),
        )
        .await
    }
    async fn queued(
        &self,
        queue_target: JsString,
        scope: &Scope,
        operation: impl std::future::Future<Output = Result<Value>>,
    ) -> Result<Value> {
        let queue = self
            .queues
            .lock()
            .unwrap()
            .entry(queue_target.clone())
            .or_default()
            .clone();
        let result = async {
            let _guard = tokio::select! {
                _=scope.stopped()=>{scope.check()?; unreachable!()},
                guard=queue.lock()=>guard,
            };
            scope.check()?;
            operation.await
        }
        .await;
        let mut queues = self.queues.lock().unwrap();
        if Arc::strong_count(&queue) == 2 {
            queues.remove(&queue_target);
        }
        result
    }
    pub async fn execute_routed(
        &self,
        command: &Value,
        registry: &crate::routing::Registry,
        scope: &Scope,
        progress: &Progress<'_>,
    ) -> Result<Value> {
        let kind = command["type"].as_str().unwrap();
        let result = async {
            let command = registry.resolve(command).await?;
            let result = self.execute(&command, scope, progress).await?;
            registry.protect_result(kind, &result).await
        }
        .await;
        result.map_err(|error| crate::routing::protect_error(kind, error))
    }
    fn managed_target(&self, storage: &Value, identity: &[JsString]) -> Result<PathBuf> {
        Ok(storage::workspace_root(&self.directory, storage)?
            .root
            .join("repositories")
            .join(paths::native(&identity[0]))
            .join(paths::native(&identity[1])))
    }
}
fn stage(progress: &Progress<'_>, stage: &str, percent: u8) {
    progress(json!({"stage":stage,"percent":percent}));
}
fn clipped(text: &JsString, maximum: usize) -> JsString {
    JsString::new(text.units()[..text.len().min(maximum)].to_vec())
}
fn blocked(
    input: &Value,
    code: &str,
    message: impl Into<JsString>,
    retryable: bool,
) -> Result<Value> {
    cantrip_crypto::checked(
        "projectReplicaProvisionResultSchema",
        &json!({"status":"blocked","jobId":input["jobId"],"attempt":input["attempt"],
            "error":json!({"code":code,"message":clipped(&message.into(),4000),"retryable":retryable})}),
    )
}
fn placement_failure(input: &Value, error: &anyhow::Error) -> Option<Result<Value>> {
    error
        .downcast_ref::<placement::PlacementError>()
        .map(|error| blocked(input, error.code, error.message, error.retryable))
}
