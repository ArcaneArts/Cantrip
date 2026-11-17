//! Native Git queries and basic actions. Managed mutations retain their own
//! recovery protocol. No Node worker is invoked.
mod actions;
mod diff;
pub mod editor;
mod history;
mod inspection;
pub mod managed;
mod process;
mod signatures;
mod stashes;
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
        "git.stash.list" => stashes::list(&cwd, scope).await,
        "git.operation.inspect" => {
            managed::inspect(&cwd, &command["context"], &"".into(), None, scope).await
        }
        "git.operation.control" => {
            managed::control(
                &cwd,
                &command["context"],
                command["action"].as_str().unwrap(),
                scope,
            )
            .await
        }
        "git.operation.amend" => {
            managed::amend(
                &cwd,
                &command["context"],
                command["message"].as_js_string(),
                scope,
            )
            .await
        }
        "git.history" => history::history(&cwd, command, scope).await,
        "git.file.history" => history::file_history(&cwd, command, scope).await,
        "git.file.blame" => history::blame(&cwd, command, scope).await,
        "git.commit.search" => history::search(&cwd, command, scope).await,
        "git.commit.get" => inspection::detail(&cwd, command, scope).await,
        "git.commit.signature.get" => {
            signatures::signature(&cwd, command["revision"].as_js_string().unwrap(), scope).await
        }
        "git.refs.list" => inspection::candidates(&cwd, scope).await,
        "git.compare" => inspection::compare(&cwd, command, scope).await,
        "git.revision.diff" => inspection::revision_diff(&cwd, command, scope).await,
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
