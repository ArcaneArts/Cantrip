//! Current facade identities exercised through the production repositories.
use super::*;
use cantrip_server::{
    projects::{
        replicas::ReplicaRepository, targets::TargetRepository, workspaces::WorkspaceRepository,
    },
    run_configurations,
};
use futures::FutureExt;

pub async fn run(database: Arc<Database>, request: &Value) -> Result<Value> {
    let text = |key: &str| request[key].as_str().context("Project state fixture field");
    let owner = text("owner")?;
    let project = request["project"].as_str().unwrap_or("github");
    let projects = ProjectRepository::new(database.clone())?;
    let targets = TargetRepository::new(database.clone());
    let runs = run_configurations::Repository::new(database.clone());
    let references = || {
        request["references"]
            .as_array()
            .context("Secret references")?
            .iter()
            .map(|v| v.as_str().map(str::to_owned).context("Secret reference"))
            .collect::<Result<Vec<_>>>()
    };
    match text("op")? {
        "project-state-policy" => Ok(projects
            .update_worktree_policy(owner, project, text("policy")?)
            .boxed()
            .await?
            .unwrap_or(Value::Null)),
        "project-state-preferred" => Ok(projects
            .update_preferred_worker(owner, project, request["worker"].as_js_string().cloned())
            .boxed()
            .await?
            .unwrap_or(Value::Null)),
        "project-state-replica" => Ok(projects
            .replicas(owner, project)
            .boxed()
            .await?
            .and_then(|replicas| replicas.into_iter().find(|v| v["id"] == request["replica"]))
            .unwrap_or(Value::Null)),
        "project-state-worktrees" => Ok(Value::Array(
            targets.worktrees(owner, project).boxed().await?,
        )),
        "project-state-selector" => {
            let connected = |worker: &str| {
                request["connected"]
                    .as_array()
                    .is_some_and(|ids| ids.iter().any(|id| id == worker))
            };
            Ok(targets
                .select_cli(
                    owner,
                    project,
                    request["kind"].as_str(),
                    request["selector"].as_js_string(),
                    &request["context"],
                    request["connected"]
                        .as_array()
                        .map(|_| &connected as &(dyn Fn(&str) -> bool + Send + Sync)),
                )
                .boxed()
                .await?
                .unwrap_or(Value::Null))
        }
        "project-state-skill-keys" => Ok(Value::Array(
            cantrip_server::chats::Repository::new(database)
                .skill_audience_keys(owner, text("worker")?, text("provider")?)
                .boxed()
                .await?,
        )),
        "project-state-secret-statuses" => Ok(Value::Array(
            runs.secret_statuses(owner, project, &references()?)
                .boxed()
                .await?,
        )),
        "project-state-protected-secrets" => Ok(Value::Array(
            runs.protected_secrets(owner, project, &references()?)
                .boxed()
                .await?,
        )),
        "project-state-operation-result" => Ok(runs
            .operation_result_in_execution(
                owner,
                text("operation")?,
                request["executionKey"].as_str().unwrap_or("worker"),
            )
            .boxed()
            .await?
            .unwrap_or(Value::Null)),
        "project-state-runtime-capture" => Ok(runs
            .captured(owner, text("runtime")?)
            .boxed()
            .await?
            .unwrap_or(Value::Null)),
        "project-state-has-github" => Ok(Value::Bool(
            ReplicaRepository::new(database)
                .has_github_project(owner, text("blindIndex")?)
                .boxed()
                .await?,
        )),
        "project-state-create-github" => {
            ReplicaRepository::new(database)
                .create_github_project(owner, &request["input"])
                .boxed()
                .await
        }
        "project-state-delete" => Ok(Value::Bool(
            WorkspaceRepository::new(database)
                .delete_project(owner, project)
                .boxed()
                .await?,
        )),
        _ => anyhow::bail!("Unknown project state fixture operation"),
    }
}
