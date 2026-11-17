//! Actual workspace repository discovery and import validation. Public command
//! paths/results cross the worker routing registry, never the Server in clear.
mod discovery;
mod origin;
mod paths;
mod process;
use anyhow::Result;
use cantrip_wire::{JsString, Value, value::json};
pub use discovery::{Limits, discover, validate_import};
pub use origin::{classify_origin, parse_github_origin};
pub use process::{ProcessError, Scope};

#[derive(Debug)]
pub struct WorkspaceError {
    pub code: &'static str,
    pub message: &'static str,
}
impl std::fmt::Display for WorkspaceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.message)
    }
}
impl std::error::Error for WorkspaceError {}
fn error(code: &'static str, message: &'static str) -> anyhow::Error {
    WorkspaceError { code, message }.into()
}
pub async fn execute(command: &Value, scope: &Scope, mut emit: impl FnMut(Value)) -> Result<Value> {
    match command["type"].as_str().unwrap_or("") {
        "workspace.repositories.discover" => {
            let mut limits = Limits::default();
            let depth = command["depth"].as_i64().unwrap();
            limits.max_depth = if depth == -1 {
                f64::INFINITY
            } else {
                depth as f64
            };
            let result=discover(command["rootPath"].as_js_string().unwrap(),&limits,scope,|progress|{
                emit(json!({"type":"workspace.repositories.discovery-progress","jobId":command["jobId"],"attempt":command["attempt"],"progress":progress}));
            }).await?;
            let candidates=result["candidates"].as_array().unwrap().iter().map(|item|json!({"path":item["canonicalPath"],"displayPath":item["relativePath"],"originUrl":item["originUrl"],"github":item["github"],"repositoryFingerprint":item["repositoryFingerprint"],"classification":item["classification"],"diagnosticCode":item["diagnosticCode"]})).collect::<Vec<_>>();
            Ok(
                json!({"jobId":command["jobId"],"attempt":command["attempt"],"candidates":candidates,"counts":json!({"candidates":candidates.len(),"collapsedRepositories":result["collapsedRepositories"],"rejectedRepositories":result["rejectedRepositories"],"scannedDirectories":result["scannedDirectories"],"scannedEntries":result["scannedEntries"],"skippedSymlinks":result["skippedSymlinks"],"unreadableDirectories":result["unreadableDirectories"]}),"diagnosticCode":if result["truncated"]==true {json!("scan-truncated")}else{Value::Null},"truncated":result["truncated"]}),
            )
        }
        "workspace.repository-import.validate" => validate_import(command, scope).await,
        _ => anyhow::bail!("Unsupported workspace command."),
    }
}
fn string(value: &Value, field: &str) -> JsString {
    value[field].as_js_string().unwrap().clone()
}

/// Shared production entry point, including the routing/privacy boundary.
pub async fn execute_routed(
    command: &Value,
    registry: &crate::routing::Registry,
    scope: &Scope,
    emit: impl FnMut(Value),
) -> Result<Value> {
    let kind = command["type"].as_str().unwrap_or("");
    let result = async {
        let resolved = registry.resolve(command).await?;
        let result = execute(&resolved, scope, emit).await?;
        registry.protect_result(kind, &result).await
    }
    .await;
    result.map_err(|error| crate::routing::protect_error(kind, error))
}
