//! Refresh actual worker truth before recovering a removed Task checkout.
use super::{Repository, execution_lanes::LaneError};
use crate::{
    database::Database,
    projects::targets::TargetRepository,
    wire::{Value, value::json},
    workers::command_bus::LimitedCommandBus,
};
use anyhow::{Context, Result};
use futures::{FutureExt, future::BoxFuture};
use std::sync::Arc;

pub type Connected = Arc<dyn Fn(&str) -> bool + Send + Sync>;
pub type Request =
    Arc<dyn Fn(String, Value) -> BoxFuture<'static, Result<Option<Value>>> + Send + Sync>;
pub struct TurnPlacement {
    projects: TargetRepository,
    chats: Repository,
    connected: Connected,
    request: Request,
}
fn text(value: &Value) -> Result<&str> {
    value.as_str().context("Task placement identity")
}
fn removed(value: &Value) -> bool {
    matches!(value.as_str(), Some("missing" | "prunable"))
}
impl TurnPlacement {
    pub fn new(database: Arc<Database>, commands: Arc<LimitedCommandBus>) -> Self {
        let connected = commands.clone();
        Self::with_dependencies(
            database,
            Arc::new(move |worker| connected.is_connected(worker)),
            Arc::new(move |worker, command| {
                let commands = commands.clone();
                async move { Ok(commands.request(&worker, command, None, None).await?) }.boxed()
            }),
        )
    }
    pub fn with_dependencies(
        database: Arc<Database>,
        connected: Connected,
        request: Request,
    ) -> Self {
        Self {
            projects: TargetRepository::new(database.clone()),
            chats: Repository::new(database),
            connected,
            request,
        }
    }
    pub async fn reconcile(&self, owner: &str, context: &Value) -> Result<Value> {
        if context["contextKind"] != "project"
            || context["experience"] != "task"
            || context["rootKind"] != "git-worktree"
            || matches!(
                context["status"].as_str(),
                Some("running" | "waiting-for-approval")
            )
        {
            return Ok(context.clone());
        }
        let project = text(&context["projectId"])?;
        let worker = text(&context["workerId"])?;
        let worktrees = self.projects.worktrees(owner, project).await?;
        let Some(selected) = worktrees
            .iter()
            .find(|item| item["id"] == context["worktreeId"])
        else {
            return Ok(context.clone());
        };
        if selected["lifecycleState"] == "ready" {
            return Ok(context.clone());
        }
        let source = worktrees.iter().find(|item| {
            item["isPrimary"] == true
                && item["projectSourceId"] == selected["projectSourceId"]
                && item["workerId"] == context["workerId"]
        });
        let Some(source) = source.filter(|_| (self.connected)(worker)) else {
            return Ok(context.clone());
        };
        let response = (self.request)(
            worker.to_owned(),
            json!({"type":"worktree.reconcile","sourcePath":source["path"]}),
        )
        .await?;
        let inventory =
            crate::settings::parse_response("worktreeInventorySchema", response.as_ref())?;
        let reconciled = self
            .projects
            .reconcile_worktrees(owner, project, worker, &inventory, None)
            .await?;
        let reconciled = reconciled.as_deref().unwrap_or(&[]);
        let observed = reconciled
            .iter()
            .find(|item| item["id"] == context["worktreeId"]);
        if observed.is_some_and(|item| item["lifecycleState"] == "ready") {
            return Ok(context.clone());
        }
        if context["worktreeMode"] != "agent-managed"
            || selected["isPrimary"] == true
            || !removed(&selected["lifecycleState"])
            || !observed.is_some_and(|item| removed(&item["lifecycleState"]))
        {
            return Ok(context.clone());
        }
        let Some(primary) = reconciled.iter().find(|item| {
            item["isPrimary"] == true
                && item["projectSourceId"] == selected["projectSourceId"]
                && item["workerId"] == context["workerId"]
                && item["lifecycleState"] == "ready"
        }) else {
            return Ok(context.clone());
        };
        let chat = text(&context["chatId"])?;
        self.chats
            .update_worktree(
                owner,
                chat,
                &json!({"worktreeId":primary["id"],"mode":"agent-managed"}),
                context.get("worktreeId"),
            )
            .await?;
        let latest = self.chats.execution_context(owner, chat).await?;
        if !latest.as_ref().is_some_and(|latest| {
            latest["worktreeId"] == primary["id"] && latest["workerId"] == context["workerId"]
        }) {
            return Err(LaneError::Conflict(
                "The Task placement changed while preparing your follow-up. Please retry."
                    .to_owned(),
            )
            .into());
        }
        Ok(latest.unwrap())
    }
}
