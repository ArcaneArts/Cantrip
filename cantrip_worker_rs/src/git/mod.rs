//! Native working-tree queries and basic Git actions. History and managed
//! operations retain their separate protocols. No Node worker is invoked.
mod actions;
mod diff;
mod process;
mod status;
pub mod stored;
use crate::filesystem::{Scope, paths};
pub use actions::action;
use anyhow::Result;
use cantrip_wire::{JsString, Value};
pub use diff::file_diff;
pub use status::status;

#[derive(Debug)]
pub struct GitError(pub JsString);
impl std::fmt::Display for GitError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0.lossy())
    }
}
impl std::error::Error for GitError {}
pub fn error_message(error: &anyhow::Error) -> JsString {
    error
        .downcast_ref::<GitError>()
        .map_or_else(|| error.to_string().into(), |e| e.0.clone())
}
pub async fn execute(command: &Value, scope: &Scope) -> Result<Value> {
    let cwd = paths::native(command["cwd"].as_js_string().unwrap());
    match command["type"].as_str().unwrap() {
        "git.status" => status(&cwd, scope).await,
        "git.action" => action(&cwd, &command["action"], scope).await,
        "git.diff" => {
            file_diff(
                &cwd,
                command["path"].as_js_string().unwrap(),
                command["scope"].as_str().unwrap(),
                command["contextLines"].as_u64().unwrap_or(3),
                scope,
            )
            .await
        }
        _ => anyhow::bail!("Git command is not implemented by the native worker."),
    }
}
