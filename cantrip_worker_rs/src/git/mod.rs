//! Native Git queries and basic actions. Managed mutations retain their own
//! recovery protocol. No Node worker is invoked.
mod actions;
mod branches;
pub(crate) mod commits;
mod conflicts;
mod diff;
pub mod editor;
mod graph;
mod history;
mod inspection;
mod lfs;
pub mod managed;
mod patches;
mod plans;
mod process;
mod remote_text;
mod remotes;
mod review;
mod signatures;
mod stash_actions;
mod stashes;
mod status;
pub mod stored;
mod submodules;
mod tags;
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
        "git.graph.snapshot" => graph::snapshot(&cwd, command, scope).await,
        "git.graph.metrics" => graph::metrics(&cwd, command, scope).await,
        "git.graph.commit-overlay" => graph::overlay(&cwd, command, scope).await,
        "git.lfs.status" => lfs::status(&cwd, command["refreshLocks"] == true, scope).await,
        "git.lfs.action.preview" => lfs::preview(&cwd, &command["action"], scope).await,
        "git.lfs.action.apply" => {
            lfs::apply(
                &cwd,
                &command["action"],
                command["token"].as_js_string().unwrap(),
                scope,
            )
            .await
        }
        "git.submodule.list" => submodules::list(&cwd, scope).await,
        "git.submodule.action.preview" => {
            submodules::preview(&cwd, &command["action"], scope).await
        }
        "git.submodule.action.apply" => {
            submodules::apply(
                &cwd,
                &command["action"],
                command["token"].as_js_string().unwrap(),
                scope,
            )
            .await
        }
        "git.tag.list" => tags::list(&cwd, scope).await,
        "git.tag.get" => tags::detail(&cwd, command["name"].as_js_string().unwrap(), scope).await,
        "git.tag.action.preview" => tags::preview(&cwd, &command["action"], scope).await,
        "git.tag.action.apply" => {
            tags::apply(
                &cwd,
                &command["action"],
                command["token"].as_js_string().unwrap(),
                scope,
            )
            .await
        }
        "git.remote.list" => remotes::list(&cwd, scope).await,
        "git.remote.action.preview" => remotes::preview(&cwd, &command["action"], scope).await,
        "git.remote.action.apply" => {
            remotes::apply(
                &cwd,
                &command["action"],
                command["token"].as_js_string().unwrap(),
                scope,
            )
            .await
        }
        "git.branch.list" => branches::list(&cwd, scope).await,
        "git.branch.action.preview" => branches::preview(&cwd, &command["action"], scope).await,
        "git.branch.action.apply" => {
            branches::apply(
                &cwd,
                &command["action"],
                command["token"].as_js_string().unwrap(),
                scope,
            )
            .await
        }
        "git.patch.preview" => patches::preview(&cwd, &command["request"], scope).await,
        "git.patch.apply" => {
            patches::apply(
                &cwd,
                &command["request"],
                command["token"].as_js_string().unwrap(),
                scope,
            )
            .await
        }
        "git.stash.create" => stash_actions::create(&cwd, &command["request"], scope).await,
        "git.stash.diff" => stash_actions::file_diff(&cwd, command, scope).await,
        "git.stash.action.preview" => stash_actions::preview(&cwd, &command["action"], scope).await,
        "git.stash.action.apply" => {
            stash_actions::apply(
                &cwd,
                &command["action"],
                command["token"].as_js_string().unwrap(),
                scope,
            )
            .await
        }
        "git.commit.action.preview" => commits::preview(&cwd, &command["action"], scope).await,
        "git.commit.action.apply" => {
            commits::apply(
                &cwd,
                &command["action"],
                command["token"].as_js_string().unwrap(),
                scope,
            )
            .await
        }
        "git.conflicts.list" => conflicts::list(&cwd, scope).await,
        "git.conflicts.get" => {
            conflicts::detail(&cwd, command["path"].as_js_string().unwrap(), scope).await
        }
        "git.conflicts.preview" => conflicts::preview(&cwd, &command["request"], scope).await,
        "git.conflicts.apply" => {
            conflicts::apply(
                &cwd,
                &command["request"],
                command["token"].as_js_string().unwrap(),
                scope,
            )
            .await
        }
        "git.operation.preview" => plans::preview(&cwd, &command["action"], scope).await,
        "git.operation.start" => {
            plans::start(
                &cwd,
                &command["action"],
                command["token"].as_js_string().unwrap(),
                scope,
            )
            .await
        }
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
