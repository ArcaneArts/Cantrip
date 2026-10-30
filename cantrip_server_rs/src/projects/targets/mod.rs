pub mod catalog;
mod context;
mod lifecycle;
mod observations;
mod reads;
mod resolve;
mod worktree_context;
mod worktree_state;

use crate::{
    database::Database,
    projects::{placement::Connected, repository::ProjectRepository},
    wire::Value,
};
use anyhow::Result;
use futures::FutureExt;
pub(crate) use reads::worktree as worktree_summary;
use reads::{Kind, Reads};
use std::sync::Arc;

pub struct TargetRepository {
    database: Arc<Database>,
}
impl TargetRepository {
    pub async fn worktrees(&self, owner: &str, project: &str) -> Result<Vec<Value>> {
        Reads::new(self.database.clone())
            .worktrees(owner, project)
            .await
    }
    pub async fn ready_worktree(
        &self,
        owner: &str,
        project: &str,
        id: &Value,
    ) -> Result<Option<Value>> {
        Reads::new(self.database.clone())
            .primary(owner, project, id)
            .await
            .map_err(terminal_error)
    }
    pub async fn remote_execution_context(&self, owner: &str, id: &Value) -> Result<Option<Value>> {
        Reads::new(self.database.clone())
            .remote_execution_context(owner, id)
            .await
    }
    pub async fn terminals(&self, owner: &str, project: &str) -> Result<Vec<Value>> {
        Reads::new(self.database.clone())
            .resources(Kind::Terminal, owner, project)
            .await
            .map_err(terminal_error)
    }
    pub async fn worker(&self, owner: &str, id: &Value) -> Result<Option<Value>> {
        Reads::new(self.database.clone()).worker(owner, id).await
    }
    pub fn new(database: Arc<Database>) -> Self {
        Self { database }
    }
    pub async fn catalog(
        &self,
        owner: &str,
        project_id: &str,
        connected: Connected<'_>,
    ) -> Result<Option<Value>> {
        let projects = ProjectRepository::new(self.database.clone())?;
        let reads = Reads::new(self.database.clone());
        // Run all collaborators before deciding whether the project exists.
        // In particular, invalid owned worker/resource data must retain its
        // actual mapper error, even when another read returns no project.
        // Box the component reads so callers do not embed all eleven query
        // futures in their stack frames when constructing and polling this join.
        let (
            project,
            replicas,
            workers,
            worktrees,
            chats,
            terminals,
            explorers,
            code,
            browsers,
            desktops,
            remotes,
        ) = tokio::try_join!(
            projects.get(owner, project_id).boxed(),
            projects.replicas(owner, project_id).boxed(),
            reads.workers(owner).boxed(),
            reads.worktrees(owner, project_id).boxed(),
            reads.resources(Kind::Chat, owner, project_id).boxed(),
            reads.resources(Kind::Terminal, owner, project_id).boxed(),
            reads.resources(Kind::Explorer, owner, project_id).boxed(),
            reads.resources(Kind::Code, owner, project_id).boxed(),
            reads.resources(Kind::Browser, owner, project_id).boxed(),
            reads.desktops(owner, project_id).boxed(),
            reads.remotes(owner, project_id).boxed(),
        )?;
        let (Some(project), Some(replicas)) = (project, replicas) else {
            return Ok(None);
        };
        let bound =
            project["originKind"] == "managed-folder" && project["capabilities"]["git"] == false;
        let local_git =
            project["originKind"] == "managed-folder" && project["capabilities"]["git"] == true;
        let owning = project
            .get("preferredWorkerId")
            .filter(|v| !v.is_null())
            .unwrap_or(&project["source"]["workerId"]);
        let workers = workers
            .into_iter()
            .filter(|worker| {
                if bound {
                    worker["workerId"] == *owning
                } else {
                    !local_git
                        || replicas
                            .iter()
                            .any(|r| r["ready"] == true && r["workerId"] == worker["workerId"])
                }
            })
            .collect();
        let input = Value::object([
            ("projectId", Value::String(project_id.into())),
            ("workers", Value::Array(workers)),
            ("replicas", Value::Array(replicas)),
            ("worktrees", Value::Array(worktrees)),
            ("chats", Value::Array(chats)),
            ("terminals", Value::Array(terminals)),
            ("explorers", Value::Array(explorers)),
            ("codeTabs", Value::Array(code)),
            ("browsers", Value::Array(browsers)),
            ("desktops", Value::Array(desktops)),
            ("remoteSurfaces", Value::Array(remotes)),
        ]);
        let mut result = catalog::build(&input, connected)?;
        if bound && let Value::Array(targets) = &mut result["targets"] {
            targets.retain(|t| t["resourceKind"] != "replica" && t["resourceKind"] != "worktree");
        }
        Ok(Some(result))
    }
}

pub(crate) fn terminal_summary(raw: &Value) -> Result<Value> {
    reads::resource(Kind::Terminal, raw).map_err(terminal_error)
}
fn terminal_error(error: anyhow::Error) -> anyhow::Error {
    if error.to_string() == "Invalid stored resource date" {
        anyhow::anyhow!("Invalid time value")
    } else {
        error
    }
}
