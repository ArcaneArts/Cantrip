pub mod catalog;
mod context;
mod reads;
mod resolve;

use crate::{
    database::Database,
    projects::{placement::Connected, repository::ProjectRepository},
    wire::Value,
};
use anyhow::Result;
use reads::{Kind, Reads};
use std::sync::Arc;

pub struct TargetRepository {
    database: Arc<Database>,
}
impl TargetRepository {
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
            projects.get(owner, project_id),
            projects.replicas(owner, project_id),
            reads.workers(owner),
            reads.worktrees(owner, project_id),
            reads.resources(Kind::Chat, owner, project_id),
            reads.resources(Kind::Terminal, owner, project_id),
            reads.resources(Kind::Explorer, owner, project_id),
            reads.resources(Kind::Code, owner, project_id),
            reads.resources(Kind::Browser, owner, project_id),
            reads.desktops(owner, project_id),
            reads.remotes(owner, project_id),
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
