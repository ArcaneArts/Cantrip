//! Native GitHub catalog, inbox, issues, PRs, Actions and releases. Protected
//! dispatch supplies repository bindings; only catalog operations are worker scoped.
mod actions;
mod api;
mod catalog;
mod common;
pub(crate) mod conversion;
mod inbox;
mod issues;
pub(crate) mod process;
mod pulls;
mod reads;
mod releases;
mod search;
use crate::filesystem::Scope;
use anyhow::{Result, bail};
pub use api::repository_for_checkout;
use cantrip_wire::Value;
pub use pulls::{group_review_threads, parse_review_context};
pub use search::query as search_query;
use std::path::{Path, PathBuf};

pub(crate) fn repository_parts(
    name: &cantrip_wire::JsString,
) -> Result<Vec<cantrip_wire::JsString>> {
    api::repository_path(name)?;
    Ok(name
        .units()
        .split(|unit| *unit == 47)
        .map(|part| cantrip_wire::JsString::new(part.to_vec()))
        .collect())
}

pub struct Client {
    directory: PathBuf,
    reads: std::sync::Mutex<reads::Reads>,
}
impl Client {
    pub fn new(directory: &Path) -> Self {
        Self {
            directory: directory.to_owned(),
            reads: std::sync::Mutex::default(),
        }
    }
    pub fn supports(kind: &str) -> bool {
        matches!(
            kind,
            "github.auth.status"
                | "github.repositories.cached"
                | "github.repositories.list"
                | "github.repository-owners.list"
                | "github.repositories.create"
                | "github.issues.list"
                | "github.pull-requests.list"
                | "github.issue.get"
                | "github.issue.create"
                | "github.issue.comment"
                | "github.issue.close"
                | "github.pull-request.get"
                | "github.pull-request.create"
                | "github.pull-request.comment"
                | "github.pull-request.review.submit"
                | "github.pull-request.review.comment"
                | "github.pull-request.review.reply"
                | "github.pull-request.review.mutate"
                | "github.pull-request.lifecycle.preview"
                | "github.pull-request.lifecycle.apply"
                | "github.pull-request.checkout.prepare"
                | "github.pull-request.agent-context"
                | "github.inbox.list"
                | "github.actions.overview"
                | "github.actions.run.get"
                | "github.actions.run.logs"
                | "github.actions.workflow.dispatch"
                | "github.actions.run.action"
                | "github.actions.run.checkout.prepare"
                | "github.releases.list"
                | "github.release.get"
                | "github.release.create"
        )
    }
    pub fn requires_checkout(kind: &str) -> bool {
        kind.starts_with("github.")
            && !matches!(
                kind,
                "github.auth.status"
                    | "github.repositories.cached"
                    | "github.repositories.list"
                    | "github.repository-owners.list"
                    | "github.repositories.create"
            )
    }
    pub async fn execute(&self, command: &Value, scope: &Scope) -> Result<Value> {
        scope.check()?;
        match command["type"].as_str().unwrap_or("") {
            "github.auth.status" => self.auth_status(scope).await,
            "github.repositories.cached" => Ok(self.cached(&command["login"]).await),
            "github.repositories.list" => self.repositories(scope).await,
            "github.repository-owners.list" => self.owners(scope).await,
            "github.repositories.create" => self.create(&command["request"], scope).await,
            "github.issues.list" | "github.pull-requests.list" => {
                self.list_issues(command, scope).await
            }
            "github.issue.get" => {
                self.get_issue(
                    command["repository"].as_js_string().unwrap(),
                    &command["number"],
                    scope,
                )
                .await
            }
            "github.issue.create" => self.create_issue(command, scope).await,
            "github.issue.comment" | "github.issue.close" => {
                self.mutate_issue(command, scope).await
            }
            "github.pull-request.get" => self.pull_request(command, scope).await,
            "github.pull-request.create" => self.create_pull(command, scope).await,
            "github.pull-request.comment"
            | "github.pull-request.review.submit"
            | "github.pull-request.review.comment"
            | "github.pull-request.review.reply"
            | "github.pull-request.review.mutate" => self.mutate_pull(command, scope).await,
            "github.pull-request.lifecycle.preview" => {
                self.preview_pull(command, &command["action"], scope).await
            }
            "github.pull-request.lifecycle.apply" => self.apply_pull(command, scope).await,
            "github.pull-request.checkout.prepare" => self.checkout_pull(command, scope).await,
            "github.pull-request.agent-context" => self.agent_pull(command, scope).await,
            "github.inbox.list" => self.inbox(command, scope).await,
            "github.actions.overview" => self.actions_overview(command, scope).await,
            "github.actions.run.get" => self.actions_run(command, scope).await,
            "github.actions.run.logs" => self.actions_logs(command, scope).await,
            "github.actions.workflow.dispatch" | "github.actions.run.action" => {
                self.actions_mutate(command, scope).await
            }
            "github.actions.run.checkout.prepare" => self.actions_checkout(command, scope).await,
            "github.releases.list" | "github.release.get" | "github.release.create" => {
                self.releases(command, scope).await
            }
            _ => bail!("Native GitHub command is not implemented."),
        }
    }
}
