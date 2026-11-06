use super::{execute::execution_error, service::Service, *};
use crate::{
    projects::{
        replicas::{ReplicaError, ReplicaRepository},
        targets::TargetRepository,
    },
    settings::{parse_response, repository::SettingsRepository},
    wire::coercion::truthy,
};
use futures::FutureExt;
use std::time::Duration;

const METHODS: &[&str] = &[
    "thread/start",
    "thread/inject_items",
    "thread/unsubscribe",
    "skills/list",
    "permissionProfile/list",
    "collaborationMode/list",
    "thread/settings/update",
];
fn dirty(status: &Value) -> Result<bool> {
    Ok(!status["status"]["files"]
        .as_array()
        .context("Worktree status files")?
        .is_empty())
}
impl Service {
    pub(super) async fn worktree_status(&self, context: &Value) -> Result<Value> {
        let response=self.dependencies.commands.request(&text(&context["workerId"])?,json!({"type":"worktree.status","sourcePath":context["sourcePath"],"worktreePath":context["worktree"]["path"]}),Some(Duration::from_secs(30)),None).await?;
        parse_response("worktreeStatusResultSchema", response.as_ref())
    }
    pub(super) async fn validate(&self, claimed: &Value) -> Result<(Value, Value)> {
        let job = &claimed["job"];
        let (owner, project, chat, target_tree) = (
            text(&claimed["ownerId"])?,
            text(&job["projectId"])?,
            text(&job["chatId"])?,
            text(&job["targetPlacement"]["worktreeId"])?,
        );
        let chats = crate::chats::Repository::new(self.repository.database.clone());
        let targets = TargetRepository::new(self.repository.database.clone());
        let (source, target, source_worker, target_worker) = tokio::try_join!(
            chats.execution_context(&owner, &chat).boxed(),
            targets
                .worktree_context(&owner, &project, &target_tree)
                .boxed(),
            targets
                .worker(&owner, &job["sourcePlacement"]["workerId"])
                .boxed(),
            targets
                .worker(&owner, &job["targetPlacement"]["workerId"])
                .boxed(),
        )?;
        let source = source
            .filter(|source| {
                source["contextKind"] == "project"
                    && source["workerId"] == job["sourcePlacement"]["workerId"]
                    && source["worktreeId"] == job["sourcePlacement"]["worktreeId"]
                    && source["status"] == "idle"
            })
            .ok_or_else(|| {
                execution_error(
                    "stale-attempt",
                    "The source chat placement or execution state changed before relocation.",
                    false,
                )
            })?;
        let target = target
            .filter(|target| {
                target["workerId"] == job["targetPlacement"]["workerId"]
                    && target["projectSourceId"] == job["targetPlacement"]["projectReplicaId"]
            })
            .ok_or_else(|| {
                execution_error(
                    "target-not-found",
                    "The target project worktree is no longer available.",
                    false,
                )
            })?;
        let (Some(source_worker), Some(target_worker)) = (source_worker, target_worker) else {
            return Err(execution_error(
                "target-not-found",
                "A required worker is no longer enrolled.",
                false,
            ));
        };
        if !truthy(source_worker.get("chatRelocation"))
            || !truthy(target_worker.get("chatRelocation"))
        {
            return Err(execution_error(
                "capability-missing",
                "Both workers must advertise durable chat relocation support. Upgrade the incompatible worker and retry.",
                false,
            ));
        }
        if !self
            .dependencies
            .commands
            .is_connected(&text(&source["workerId"])?)
            || !self
                .dependencies
                .commands
                .is_connected(&text(&target["workerId"])?)
        {
            return Err(execution_error(
                "worker-offline",
                "Both source and target workers must be online. Relocation will resume after they reconnect.",
                true,
            ));
        }
        if matches!(
            target_worker["codexRuntime"]["compatibility"].as_str(),
            Some("missing" | "incompatible")
        ) {
            return Err(execution_error(
                "runtime-incompatible",
                format!(
                    "{} does not have a compatible Codex runtime.",
                    text(&target_worker["name"])?
                ),
                false,
            ));
        }
        let missing = METHODS
            .iter()
            .filter(|method| target_worker["codexRuntime"]["methods"][**method] != "available")
            .copied()
            .collect::<Vec<_>>();
        if !missing.is_empty() {
            return Err(execution_error(
                "capability-missing",
                format!(
                    "{} cannot relocate chats because Codex methods are unavailable: {}.",
                    text(&target_worker["name"])?,
                    missing.join(", ")
                ),
                false,
            ));
        }
        if truthy(source.get("threadId"))
            && source_worker["codexRuntime"]["methods"]["thread/unsubscribe"] != "available"
        {
            return Err(execution_error(
                "capability-missing",
                format!(
                    "{} cannot safely release the source Codex thread.",
                    text(&source_worker["name"])?
                ),
                false,
            ));
        }
        let source_tree = targets
            .worktree_context(&owner, &project, &text(&source["worktreeId"])?)
            .await?
            .ok_or_else(|| {
                execution_error(
                    "target-not-found",
                    "The source worktree is no longer available.",
                    false,
                )
            })?;
        let (source_status, target_status) = tokio::try_join!(
            self.worktree_status(&source_tree),
            self.worktree_status(&target)
        )?;
        if dirty(&source_status)? {
            return Err(execution_error(
                "worktree-dirty",
                "The source worktree has uncommitted changes. Commit or preserve them before relocating this chat.",
                false,
            ));
        }
        if dirty(&target_status)? {
            return Err(execution_error(
                "worktree-dirty",
                "The target worktree has uncommitted changes and will not be modified.",
                false,
            ));
        }
        if source_status["status"]["head"] != claimed["snapshot"]["summary"]["requiredRevision"] {
            return Err(execution_error(
                "revision-diverged",
                "The source worktree revision changed after the relocation snapshot was captured.",
                false,
            ));
        }
        Ok((source, target))
    }
    pub(super) async fn prepare_replica(&self, claimed: &Value, target: &Value) -> Result<()> {
        let revision = &claimed["snapshot"]["summary"]["requiredRevision"];
        let status = self.worktree_status(target).await?;
        if dirty(&status)? {
            return Err(execution_error(
                "worktree-dirty",
                "The target worktree became dirty during relocation and was left untouched.",
                false,
            ));
        }
        if &status["status"]["head"] == revision {
            return Ok(());
        }
        if !truthy(target["worktree"].get("isPrimary")) {
            return Err(execution_error(
                "revision-diverged",
                "Only a clean target Primary worktree can be synchronized automatically. Select a matching worktree or reconcile it first.",
                false,
            ));
        }
        let owner = text(&claimed["ownerId"])?;
        let project = text(&claimed["job"]["projectId"])?;
        let preferences = SettingsRepository::new(self.repository.database.clone())
            .get_user_settings(&owner)
            .await?;
        if preferences["automaticReplicaSynchronization"] != "fast-forward-primary" {
            return Err(execution_error(
                "revision-diverged",
                "The target replica is at a different revision. Enable safe automatic Primary synchronization or reconcile it manually.",
                false,
            ));
        }
        let replicas = ReplicaRepository::new(self.repository.database.clone());
        let created:Result<Value>=async {
            let github=TargetRepository::new(self.repository.database.clone()).github_context(&owner,&project,Some(&text(&target["workerId"])?)).await?
                .ok_or_else(||execution_error("replica-not-ready","The target replica has no protected repository identity.",false))?;
            replicas.create_synchronize(&owner,&project,&text(&target["projectSourceId"])?,&json!({"repository":github["nameWithOwner"],"expectedRevision":revision,"idempotencyKey":format!("chat-relocation:{}:{}",text(&claimed["job"]["id"])?,text(revision)?),"policy":"fast-forward-primary"})).await
        }.await;
        let mut job = match created {
            Err(error)
                if matches!(
                    error.downcast_ref::<ReplicaError>(),
                    Some(ReplicaError::Conflict(_))
                ) =>
            {
                return Err(execution_error(
                    "replica-not-ready",
                    "Another replica operation is active on the target. Retry relocation after it finishes.",
                    true,
                ));
            }
            result => result?,
        };
        if matches!(job["state"].as_str(), Some("blocked" | "failed"))
            && truthy(job["error"].get("retryable"))
        {
            job = replicas
                .retry(
                    &owner,
                    &text(&job["id"])?,
                    job["stateRevision"].as_f64().context("Replica revision")?,
                )
                .await?
                .unwrap_or(job);
        }
        (self.dependencies.queue_replica_jobs)();
        let deadline = crate::auth::now().timestamp_millis() + 300000;
        while matches!(job["state"].as_str(), Some("queued" | "running")) {
            if crate::auth::now().timestamp_millis() >= deadline {
                return Err(execution_error(
                    "replica-not-ready",
                    "Target replica synchronization did not finish within five minutes.",
                    true,
                ));
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
            job = replicas
                .get(&owner, &text(&job["id"])?)
                .await?
                .unwrap_or(job);
        }
        if job["state"] != "succeeded" {
            return Err(replica_error(&job)?);
        }
        let status = self.worktree_status(target).await?;
        if dirty(&status)? || &status["status"]["head"] != revision {
            return Err(execution_error(
                "revision-diverged",
                "The synchronized target did not materialize the captured revision cleanly.",
                false,
            ));
        }
        Ok(())
    }
}
fn replica_error(job: &Value) -> Result<anyhow::Error> {
    let error = &job["error"];
    if error.is_null() {
        return Ok(execution_error(
            "replica-not-ready",
            "The target replica did not reach the required revision.",
            true,
        ));
    }
    let original = text(&error["code"])?;
    let code = match original.as_str() {
        "target-not-found"
        | "target-mismatch"
        | "worker-offline"
        | "capability-missing"
        | "replica-not-ready"
        | "worktree-dirty"
        | "revision-diverged"
        | "attachment-unavailable"
        | "runtime-incompatible"
        | "stale-attempt"
        | "policy-denied"
        | "worker-error" => original.as_str(),
        "remote-unavailable" => "revision-diverged",
        _ => "policy-denied",
    };
    Ok(execution_error(
        code,
        format!("Replica operation failed with code {original}."),
        truthy(error.get("retryable")),
    ))
}
