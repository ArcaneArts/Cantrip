use super::{
    TargetRepository,
    reads::{Reads, copy},
};
use crate::{
    projects::{
        placement::{Connected, PlacementRepository, unavailable},
        repository::ProjectRepository,
    },
    wire::Value,
};
use anyhow::{Context, Result};

fn text(s: &str) -> Value {
    Value::String(s.into())
}
fn place(project: &str, worker: Value, replica: Value, tree: Value, surface: Value) -> Value {
    Value::object([
        ("projectId", text(project)),
        ("workerId", worker),
        ("projectReplicaId", replica),
        ("worktreeId", tree),
        ("surface", surface),
    ])
}
impl TargetRepository {
    pub async fn resolve(
        &self,
        owner: &str,
        project_id: &str,
        target: &Value,
        connected: Connected<'_>,
        allow_unavailable: bool,
    ) -> Result<Value> {
        if target["projectId"] != project_id {
            return unavailable(
                "target-mismatch",
                "The execution target belongs to a different project.",
            );
        }
        let projects = ProjectRepository::new(self.database.clone())?;
        let Some(replicas) = projects.replicas(owner, project_id).await? else {
            return unavailable("project-not-found", "Project not found.");
        };
        let Some(project) = projects.get(owner, project_id).await? else {
            return unavailable("project-not-found", "Project not found.");
        };
        let reads = Reads::new(self.database.clone());
        let mut capability = None;
        let mut resource_code = None;
        let mut resource_reason = None;
        let placement = if target["kind"] == "project" {
            PlacementRepository::new(self.database.clone())?
                .resolve(
                    owner,
                    project_id,
                    "terminal",
                    Some(target),
                    connected,
                    allow_unavailable,
                )
                .await?["placement"]
                .clone()
        } else if target["kind"] == "worker" {
            if reads.worker(owner, &target["workerId"]).await?.is_none() {
                return unavailable(
                    "target-not-found",
                    "The selected worker is not linked to this account.",
                );
            }
            let replica = replicas
                .iter()
                .find(|r| r["workerId"] == target["workerId"]);
            let primary = if let Some(r) = replica.filter(|r| !r["primaryWorktreeId"].is_null()) {
                reads
                    .primary(owner, project_id, &r["primaryWorktreeId"])
                    .await?
            } else {
                None
            };
            place(
                project_id,
                target["workerId"].clone(),
                replica.map_or(Value::Null, |r| copy(r, "id")),
                primary.as_ref().map_or(Value::Null, |w| copy(w, "id")),
                Value::Null,
            )
        } else if target["kind"] == "replica" {
            let Some(replica) = replicas
                .iter()
                .find(|r| r["id"] == target["projectReplicaId"])
            else {
                return unavailable(
                    "target-not-found",
                    "The selected project replica was not found.",
                );
            };
            let primary = if !replica["primaryWorktreeId"].is_null() {
                reads
                    .primary(owner, project_id, &replica["primaryWorktreeId"])
                    .await?
            } else {
                None
            };
            if replica["ready"] != true || primary.is_none() {
                resource_code = Some("replica-unavailable");
                resource_reason = Some(format!(
                    "The project replica on {} is not ready.",
                    replica["workerName"]
                        .as_str()
                        .context("Replica worker name")?
                ));
            }
            place(
                project_id,
                copy(replica, "workerId"),
                copy(replica, "id"),
                primary.as_ref().map_or(Value::Null, |w| copy(w, "id")),
                Value::Null,
            )
        } else if target["kind"] == "worktree" {
            let worktrees = reads.worktrees(owner, project_id).await?;
            let Some(tree) = worktrees.iter().find(|w| w["id"] == target["worktreeId"]) else {
                return unavailable("target-not-found", "The selected worktree was not found.");
            };
            if tree["lifecycleState"] != "ready" {
                resource_code = Some("worktree-unavailable");
                resource_reason = Some(tree_reason(tree)?);
            }
            place(
                project_id,
                copy(tree, "workerId"),
                copy(tree, "projectSourceId"),
                copy(tree, "id"),
                Value::Null,
            )
        } else {
            let kind = target["surfaceKind"]
                .as_str()
                .context("Target surface kind")?;
            let surface =
                Value::object([("kind", text(kind)), ("id", target["surfaceId"].clone())]);
            if matches!(kind, "chat" | "terminal" | "explorer" | "code") {
                let context = reads.context(owner, kind, &target["surfaceId"]).await?;
                let Some(context) = context.filter(|c| c["projectId"] == project_id) else {
                    return unavailable(
                        "target-not-found",
                        match kind {
                            "chat" => "The selected chat was not found.",
                            "terminal" => "The selected terminal was not found.",
                            "explorer" => "The selected Explorer was not found.",
                            _ => "The selected Code tab was not found.",
                        },
                    );
                };
                let worktrees = reads.worktrees(owner, project_id).await?;
                let Some(tree) = worktrees.iter().find(|w| w["id"] == context["worktreeId"]) else {
                    return unavailable(
                        "target-not-found",
                        "The target worktree was not found in this project.",
                    );
                };
                if tree["workerId"] != context["workerId"] {
                    return unavailable(
                        "target-mismatch",
                        "The target resource and worktree belong to different workers.",
                    );
                }
                if tree["lifecycleState"] != "ready" {
                    resource_code = Some("worktree-unavailable");
                    resource_reason = Some(tree_reason(tree)?);
                }
                place(
                    project_id,
                    copy(&context, "workerId"),
                    copy(tree, "projectSourceId"),
                    copy(tree, "id"),
                    surface,
                )
            } else {
                let concrete = async {
                    if kind == "browser" {
                        reads.browser_owned(owner, &target["surfaceId"]).await
                    } else if kind == "remote-desktop" {
                        Ok(reads
                            .desktop_context(owner, &target["surfaceId"])
                            .await?
                            .is_some_and(|d| d["projectId"] == project_id))
                    } else {
                        Ok(true)
                    }
                };
                let (context, concrete) =
                    tokio::try_join!(reads.remote_context(owner, &target["surfaceId"]), concrete)?;
                let expected = match kind {
                    "browser" => Some("browser"),
                    "remote-desktop" => Some("desktop"),
                    _ => None,
                };
                let Some(context) = context.filter(|c| {
                    concrete
                        && c["projectId"] == project_id
                        && expected.is_none_or(|k| c["kind"] == k)
                }) else {
                    return unavailable(
                        "target-not-found",
                        format!("The selected {kind} was not found."),
                    );
                };
                capability = Some(if context["kind"] == "browser" {
                    "browser"
                } else {
                    "desktop"
                });
                place(
                    project_id,
                    copy(&context, "workerId"),
                    Value::Null,
                    Value::Null,
                    surface,
                )
            }
        };
        let bound =
            project["originKind"] == "managed-folder" && project["capabilities"]["git"] == false;
        let local_git =
            project["originKind"] == "managed-folder" && project["capabilities"]["git"] == true;
        let owning = project
            .get("preferredWorkerId")
            .filter(|v| !v.is_null())
            .or_else(|| project["source"].get("workerId"));
        if bound && placement.get("workerId") != owning {
            return unavailable(
                "target-mismatch",
                "This worker-managed folder is bound to its owning worker.",
            );
        }
        if local_git
            && !replicas
                .iter()
                .any(|r| r["ready"] == true && r["workerId"] == placement["workerId"])
        {
            return unavailable(
                "target-mismatch",
                "This local Git project has no ready source on the selected worker.",
            );
        }
        let Some(worker) = reads.worker(owner, &placement["workerId"]).await? else {
            return unavailable(
                "target-not-found",
                "The target worker is not linked to this account.",
            );
        };
        if !allow_unavailable && let Some(code) = resource_code {
            return unavailable(code, resource_reason.as_ref().unwrap());
        }
        let mut availability = super::catalog::availability(&worker, capability, connected)?;
        if !allow_unavailable && availability["availability"] != "available" {
            return unavailable(
                if availability["availability"] == "worker-offline" {
                    "worker-offline"
                } else {
                    "capability-unavailable"
                },
                availability["unavailableReason"]
                    .as_str()
                    .context("Unavailable reason")?,
            );
        }
        if availability["availability"] == "available"
            && let Some(reason) = resource_reason
        {
            availability["availability"] = text("resource-unavailable");
            availability["online"] = Value::Bool(true);
            availability["unavailableReason"] = text(&reason);
        }
        Ok(Value::object([
            ("target", target.clone()),
            ("placement", placement),
            (
                "worker",
                Value::object([
                    ("workerId", copy(&worker, "workerId")),
                    ("name", copy(&worker, "name")),
                    ("online", copy(&availability, "online")),
                ]),
            ),
            ("availability", copy(&availability, "availability")),
            (
                "unavailableReason",
                copy(&availability, "unavailableReason"),
            ),
        ]))
    }
}
fn tree_reason(tree: &Value) -> Result<String> {
    Ok(format!(
        "Worktree {} is {}.",
        tree["name"].as_str().context("Worktree name")?,
        tree["lifecycleState"].as_str().context("Worktree state")?
    ))
}
