//! Serialized worker-owned worktree mutations and catalog recovery.
mod removal;
use super::{coordinator::Coordinator, targets::TargetRepository};
use crate::{
    database::Database,
    wire::{JsString, Value, coercion::truthy, value::json},
    workers::{bridge::WorkerBridge, command_bus::LimitedCommandBus},
};
use anyhow::{Context, Result, bail};
use futures::{FutureExt, future::BoxFuture};
use std::sync::Arc;

#[derive(Debug)]
pub struct MutationError {
    pub failure: Value,
}
impl std::fmt::Display for MutationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(
            &self.failure["error"]
                .as_js_string()
                .map(|s| s.lossy())
                .unwrap_or_default(),
        )
    }
}
impl std::error::Error for MutationError {}
fn mutation(
    outcome: &str,
    project: &str,
    worktree: Option<&str>,
    message: &str,
    retryable: bool,
) -> anyhow::Error {
    let message = match worktree {
        Some(id) => format!("{message} Recovery target: project {project}, worktree {id}."),
        None => message.to_owned(),
    };
    let message = Value::String(JsString::new(message.encode_utf16().take(2000).collect()));
    let code = match outcome {
        "notStarted" => "not-started",
        "rolledBack" => "rolled-back",
        other => other,
    };
    let failure = json!({"code":format!("worktree-create-{code}"),"error":message,"mutation":json!({"outcome":outcome,"retryable":retryable,"target":worktree.map(|id|json!({"kind":"worktree","projectId":project,"worktreeId":id}))})});
    match crate::settings::parse_response("worktreeCreateMutationFailureSchema", Some(&failure)) {
        Ok(failure) => MutationError { failure }.into(),
        Err(error) => error,
    }
}
fn text<'a>(v: &'a Value, key: &str) -> Result<&'a str> {
    v[key].as_str().context("Worktree mutation field")
}

pub struct Service {
    repository: TargetRepository,
    bridge: Arc<WorkerBridge>,
    commands: Arc<LimitedCommandBus>,
    coordinator: Arc<Coordinator>,
}
impl Service {
    pub fn lock(
        self: &Arc<Self>,
        owner: String,
        project: String,
        worktree: String,
        reason: Option<Value>,
    ) -> BoxFuture<'static, Result<Option<Value>>> {
        let service = self.clone();
        self.coordinator.serialize(&owner.clone(),&project.clone(),true,move || async move {
            let Some(context)=service.repository.worktree_context(&owner,&project,&worktree).await? else {return Ok(None);};
            let worker=text(&context,"workerId")?;
            let mut command=json!({"type":if reason.is_some(){"worktree.lock"}else{"worktree.unlock"},"sourcePath":context["sourcePath"],"worktreePath":context["worktree"]["path"]});
            if let Some(reason)=reason {command["reason"]=reason;}
            let result=service.request(worker,command,"worktreeMutationResultSchema").await?;
            Ok(service.repository.reconcile_worktrees(&owner,&project,worker,&result["inventory"],None).await?.and_then(|rows|rows.into_iter().find(|row|row["id"]==worktree.as_str())))
        }.boxed())
    }
    pub fn prune(
        self: &Arc<Self>,
        owner: String,
        project: String,
        allow_external: Value,
    ) -> BoxFuture<'static, Result<Option<Vec<Value>>>> {
        let service = self.clone();
        self.coordinator.serialize(&owner.clone(),&project.clone(),true,move || async move {
            let Some(source)=service.repository.observation_source(&owner,&project,&|id|service.bridge.is_connected(id)).await? else {return Ok(None);};
            let worker=text(&source,"workerId")?;
            let result=service.request(worker,json!({"type":"worktree.prune","sourcePath":source["cwd"],"allowExternal":allow_external}),"worktreePruneResultSchema").await?;
            service.repository.reconcile_worktrees(&owner,&project,worker,&result["inventory"],None).await
        }.boxed())
    }
    pub fn new(
        database: Arc<Database>,
        bridge: Arc<WorkerBridge>,
        commands: Arc<LimitedCommandBus>,
        coordinator: Arc<Coordinator>,
    ) -> Arc<Self> {
        Arc::new(Self {
            repository: TargetRepository::new(database),
            bridge,
            commands,
            coordinator,
        })
    }
    async fn request(&self, worker: &str, command: Value, schema: &str) -> Result<Value> {
        let response = self.commands.request(worker, command, None, None).await?;
        crate::settings::parse_response(schema, response.as_ref())
    }
    pub fn create(
        self: &Arc<Self>,
        owner: String,
        project: String,
        input: Value,
    ) -> BoxFuture<'static, Result<Option<Value>>> {
        let service = self.clone();
        self.coordinator
            .serialize(&owner.clone(), &project.clone(), true, move || {
                async move { service.create_in_project(&owner, &project, &input).await }.boxed()
            })
    }
    pub fn reconcile(
        self: &Arc<Self>,
        owner: String,
        project: String,
    ) -> BoxFuture<'static, Result<Option<Vec<Value>>>> {
        let service = self.clone();
        self.coordinator
            .serialize(&owner.clone(), &project.clone(), true, move || {
                async move {
                    let Some(source) = service
                        .repository
                        .observation_source(&owner, &project, &|id| service.bridge.is_connected(id))
                        .await?
                    else {
                        return Ok(None);
                    };
                    let worker = text(&source, "workerId")?;
                    let inventory = service
                        .request(
                            worker,
                            json!({"type":"worktree.reconcile","sourcePath":source["cwd"]}),
                            "worktreeInventorySchema",
                        )
                        .await?;
                    service
                        .repository
                        .reconcile_worktrees(&owner, &project, worker, &inventory, None)
                        .await
                }
                .boxed()
            })
    }
    pub fn checkout_pull_request(
        self: &Arc<Self>,
        owner: String,
        project: String,
        source_worktree: String,
        repository: Value,
        number: Value,
    ) -> BoxFuture<'static, Result<Option<Value>>> {
        let service = self.clone();
        self.coordinator.serialize(&owner.clone(), &project.clone(), true, move || async move {
            let Some(context) = service.repository.worktree_context(&owner,&project,&source_worktree).await? else { return Ok(None); };
            if context["worktree"]["lifecycleState"] != "ready" { bail!("The selected worktree is not ready."); }
            let worker = text(&context,"workerId")?;
            let prepared = service.request(worker,json!({"type":"github.pull-request.checkout.prepare","cwd":context["worktree"]["path"],"repository":repository,"number":number}),"githubPullRequestCheckoutPreparedSchema").await?;
            let existing = service.repository.worktrees(&owner,&project).await?.into_iter().find(|w| w["branch"] == prepared["branch"]);
            let (worktree,reused) = if let Some(existing) = existing {
                if existing["lifecycleState"] != "ready" || existing["head"] != prepared["headSha"] || existing["workerId"] != worker {
                    bail!("The checkout branch {} already belongs to a different or unavailable worktree.", text(&prepared,"branch")?);
                }
                (existing,true)
            } else {
                let Some(created) = service.create_in_project(&owner,&project,&json!({"name":prepared["name"],"origin":"user","mode":json!({"type":"newBranch","branch":prepared["branch"],"startPoint":prepared["headSha"]})})).await? else {return Ok(None);};
                (created,false)
            };
            Ok(Some(crate::settings::parse_response("githubPullRequestCheckoutResultSchema",Some(&json!({"pullRequest":prepared["pullRequest"],"worktree":worktree,"reused":reused})))?))
        }.boxed())
    }
    async fn create_in_project(
        &self,
        owner: &str,
        project: &str,
        input: &Value,
    ) -> Result<Option<Value>> {
        let source = if truthy(input.get("sourceWorktreeId")) {
            self.repository
                .worktree_context(owner, project, text(input, "sourceWorktreeId")?)
                .await?
                .map(|context| json!({"cwd":context["sourcePath"],"workerId":context["workerId"]}))
        } else {
            self.repository
                .observation_source(owner, project, &|id| self.bridge.is_connected(id))
                .await?
        };
        let Some(source) = source else {
            return Err(mutation(
                "notStarted",
                project,
                None,
                "Project source not found; worktree creation did not start.",
                false,
            ));
        };
        let id = input
            .get("worktreeId")
            .filter(|v| !v.is_null())
            .cloned()
            .unwrap_or_else(|| Value::String(uuid::Uuid::new_v4().to_string().into()));
        let worktree = id.as_str().context("Created worktree identity")?;
        let worker = text(&source, "workerId")?;
        let result = self.request(worker,json!({"type":"worktree.create","sourcePath":source["cwd"],"worktreeId":id,"name":input["name"],"mode":input["mode"]}),"worktreeCreateResultSchema").await.map_err(|_| mutation("partial",project,Some(worktree),"The worker did not confirm whether worktree creation completed. Reconcile the exact recovery target before retrying.",true))?;
        let created = json!({"id":id,"lifecycleState":"ready","name":input["name"],"origin":input["origin"],"path":result["worktree"]["path"]});
        let reconciled = self
            .repository
            .reconcile_worktrees(owner, project, worker, &result["inventory"], Some(&created))
            .await;
        if let Ok(Some(rows)) = reconciled
            && let Some(candidate) = rows.into_iter().find(|row| row["id"] == id)
        {
            return Ok(Some(candidate));
        }
        if result["created"] != true || (input["origin"] != "agent" && input["origin"] != "cantrip")
        {
            return Err(mutation(
                "partial",
                project,
                Some(worktree),
                "A preexisting or user-owned worktree could not be reconciled and was left untouched. Reconcile the exact recovery target before retrying.",
                true,
            ));
        }
        let rolled_back: Result<()> = async {
            let removed = self.request(worker,json!({"type":"worktree.remove","sourcePath":source["cwd"],"worktreePath":created["path"],"force":false,"allowExternal":false}),"worktreeRemoveResultSchema").await?;
            if removed["removedPath"] != created["path"] || removed["inventory"]["worktrees"].as_array().context("Removed inventory")?.iter().any(|w|w["path"]==created["path"]) { bail!("Worker removal did not match the created worktree."); }
            if !self.repository.rollback_worktree_creation(owner,project,worker,&created).await? { bail!("The exact worktree catalog row could not be removed."); }
            Ok(())
        }.await;
        Err(if rolled_back.is_ok() {
            mutation(
                "rolledBack",
                project,
                Some(worktree),
                "Worktree reconciliation failed, and the newly created worktree was rolled back. Retrying is safe.",
                true,
            )
        } else {
            mutation(
                "partial",
                project,
                Some(worktree),
                "Worktree reconciliation failed, and automatic rollback could not be verified. Reconcile the exact recovery target before retrying.",
                true,
            )
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn mutation_errors_match_source_including_utf16_truncation() -> Result<()> {
        let output = std::process::Command::new("node")
            .args([
                "--import",
                "tsx",
                "scripts/server-rust/worktree-mutation-error-oracle.mjs",
            ])
            .current_dir(
                std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .parent()
                    .unwrap(),
            )
            .output()?;
        anyhow::ensure!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let cases: Value = serde_json::from_slice(&output.stdout)?;
        let cases = cases.as_array().context("Mutation constructor cases")?;
        for case in cases {
            let input = &case["input"];
            let error = mutation(
                text(input, "outcome")?,
                text(input, "project")?,
                input["worktree"].as_str(),
                text(input, "message")?,
                input["retryable"] == true,
            );
            let failure = &error
                .downcast_ref::<MutationError>()
                .context("Native mutation error")?
                .failure;
            assert_eq!(*failure, case["failure"]);
        }
        assert_eq!(cases.len(), 8);
        Ok(())
    }
}
