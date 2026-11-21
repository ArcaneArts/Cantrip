//! Encrypted repository command admission and the native attachment/metadata
//! operations, plus host Git queries/basic actions. Remaining Git/GitHub domains are
//! added by their owning milestones.
use crate::{
    encryption::Service,
    protected_content::{
        RepositoryOperationReplayGuard, open_repository_content, protect_repository_content,
    },
    routing::Registry,
    workspace::{Scope, WorkspaceError},
};
use anyhow::{Result, bail};
use cantrip_crypto::checked;
use cantrip_wire::{JsString, Value, value::json};
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

#[derive(Default)]
pub struct RepositoryOperations {
    replay: Mutex<RepositoryOperationReplayGuard>,
    profile: Option<(PathBuf, JsString)>,
    worktrees: Option<Arc<crate::git::worktrees::Manager>>,
    github: Option<Arc<crate::github::Client>>,
}
impl RepositoryOperations {
    pub fn new(directory: &Path, worker: &JsString) -> Self {
        Self {
            replay: Mutex::default(),
            profile: Some((directory.to_owned(), worker.clone())),
            worktrees: Some(Arc::new(crate::git::worktrees::Manager::new(directory))),
            github: Some(Arc::new(crate::github::Client::new(directory))),
        }
    }
    pub fn worktrees(&self) -> Result<Arc<crate::git::worktrees::Manager>> {
        self.worktrees
            .clone()
            .ok_or_else(|| anyhow::anyhow!("Repository worker profile is not configured."))
    }
    pub fn github(&self) -> Result<Arc<crate::github::Client>> {
        self.github
            .clone()
            .ok_or_else(|| anyhow::anyhow!("Repository worker profile is not configured."))
    }
    pub async fn execute(
        &self,
        command: &Value,
        service: &Service,
        registry: &Registry,
        scope: &Scope,
    ) -> Result<Value> {
        self.execute_with_drafts(command, service, registry, scope, None)
            .await
    }

    pub(crate) async fn execute_with_drafts(
        &self,
        command: &Value,
        service: &Service,
        registry: &Registry,
        scope: &Scope,
        drafts: Option<(&crate::codex::turn::Turns, crate::metadata::Signal)>,
    ) -> Result<Value> {
        scope.check()?;
        // The existing public command wrapper resolves routing metadata before
        // dispatch, even though attachment's private root is inside ciphertext.
        let command = registry.resolve(command).await?;
        let mut context = json!({"serverId":command["serverId"],"projectId":command["projectId"],"worktreeId":command["worktreeId"],"operationId":command["operationId"],"direction":"request"});
        self.replay.lock().unwrap().reserve(&context)?;
        let request = open_repository_content(
            service,
            &context,
            &command["protectedRequest"],
            "repositoryOperationRequestContentSchema",
            false,
        )?;
        let kind = request["type"].as_str().unwrap();
        if command["access"].as_str()
            != cantrip_protocol::repository_operations::operation_access(kind)
        {
            bail!("Repository operation access metadata is invalid.");
        }
        let attaches = kind == "workspace.root.attach";
        if attaches != (command["routingPurpose"] == "workspace-root-attachment") {
            bail!("Repository operation routing purpose is invalid.");
        }
        let mut attachment = None;
        let mut agent_execution = Value::Null;
        let result = async {
            if command["agent"] != json!(kind == "git.agent.generate") {
                bail!("Repository agent routing metadata is invalid.");
            }
            scope.check()?;
            match kind {
                "git.agent.generate" => {
                    let (drafts, signal) = drafts
                        .ok_or_else(|| anyhow::anyhow!("Repository model execution is unavailable."))?;
                    let github = self.github()?;
                    let (result, execution) = drafts.repository_draft(
                        &command, &request["arguments"], &github, scope, signal,
                    ).await?;
                    agent_execution = execution;
                    Ok(result)
                }
                kind if crate::github::Client::supports(kind) => {
                    let (directory, worker) = self.profile.as_ref().ok_or_else(|| anyhow::anyhow!("Repository worker profile is not configured."))?;
                    // Source reads the scoped journal for every GitHub request.
                    // Catalog requests do not require a checkout; GitHub issue
                    // operations require a trusted repository but no idle Git state.
                    crate::git::stored::read(directory, &command, &Value::String(service.owner_id()?), &Value::String(worker.clone())).await?;
                    let repository = if crate::github::Client::requires_checkout(kind) {
                        match command.get("repository").filter(|value|!value.is_null()) {
                            Some(value)=>value.clone(),
                            None=>crate::github::repository_for_checkout(&crate::filesystem::paths::native(command["cwd"].as_js_string().unwrap()),scope).await.map(Value::String).unwrap_or(Value::Null),
                        }
                    } else { command["repository"].clone() };
                    if crate::github::Client::requires_checkout(kind) && !cantrip_wire::coercion::truthy(Some(&repository)) {
                        bail!("This checkout does not have a GitHub origin available to the worker.");
                    }
                    if command.get("peerWorktree").is_some_and(|value| !value.is_null()) {
                        bail!("A peer worktree is only valid for a worktree changes move.");
                    }
                    let mut trusted = request["arguments"].clone();
                    trusted["type"] = json!(kind);
                    trusted["repository"] = repository;
                    trusted["cwd"] = command["cwd"].clone();
                    trusted["sourcePath"] = command["sourcePath"].clone();
                    trusted["worktreePath"] = command["cwd"].clone();
                    let trusted = checked("workerCommandSchema", &trusted)?;
                    self.github()?.execute(&trusted, scope).await
                }
                "repository.metadata.register" | "repository.metadata.resolve" => {
                    let values = checked(
                        "repositoryMetadataValuesSchema",
                        &request["arguments"]["values"],
                    )?;
                    let values = if kind == "repository.metadata.register" {
                        registry.protect_metadata(&values).await?
                    } else {
                        registry.resolve_metadata(&values).await?
                    };
                    checked("repositoryMetadataResultSchema", &json!({"values":values}))
                }
                "workspace.root.attach" => {
                    let arguments =
                        checked("workspaceRootAttachArgumentsSchema", &request["arguments"])?;
                    let result = crate::workspace::attach_root(
                        arguments["rootPath"].as_js_string().unwrap(),
                        registry,
                        scope,
                    )
                    .await?;
                    attachment = Some(result.clone());
                    Ok(result)
                }
                "git.status"
                | "git.diff"
                | "git.action"
                | "git.history"
                | "git.change-summary"
                | "git.graph.snapshot"
                | "git.graph.metrics"
                | "git.graph.commit-overlay"
                | "git.worktree.changes.preview"
                | "git.worktree.changes.apply"
                | "git.recovery.list"
                | "git.recovery.preview"
                | "git.recovery.apply"
                | "worktree.status"
                | "git.file.history"
                | "git.file.blame"
                | "git.commit.search"
                | "git.commit.get"
                | "git.commit.signature.get"
                | "git.refs.list"
                | "git.compare"
                | "git.revision.diff"
                | "git.stash.list"
                | "git.operation.preview"
                | "git.operation.start"
                | "git.operation.current"
                | "git.operation.control"
                | "git.operation.amend"
                | "git.conflicts.list"
                | "git.conflicts.get"
                | "git.conflicts.preview"
                | "git.conflicts.apply"
                | "git.commit.action.preview"
                | "git.commit.action.apply"
                | "git.stash.create"
                | "git.stash.diff"
                | "git.stash.action.preview"
                | "git.stash.action.apply"
                | "git.patch.preview"
                | "git.patch.apply"
                | "git.branch.list"
                | "git.branch.action.preview"
                | "git.branch.action.apply"
                | "git.remote.list"
                | "git.remote.action.preview"
                | "git.remote.action.apply"
                | "git.tag.list"
                | "git.tag.get"
                | "git.tag.action.preview"
                | "git.tag.action.apply"
                | "git.submodule.list"
                | "git.submodule.action.preview"
                | "git.submodule.action.apply"
                | "git.lfs.status"
                | "git.lfs.action.preview"
                | "git.lfs.action.apply" => {
                    let (directory, worker) = self.profile.as_ref().ok_or_else(|| {
                        anyhow::anyhow!("Repository worker profile is not configured.")
                    })?;
                    let owner = Value::String(service.owner_id()?);
                    let mut stored = crate::git::stored::read(
                        directory,
                        &command,
                        &owner,
                        &Value::String(worker.clone()),
                    )
                    .await?;
                    let worker = Value::String(worker.clone());
                    if kind == "git.operation.current" {
                        if crate::git::stored::active(stored.as_ref()) {
                            let state = crate::git::managed::inspect(
                                &crate::filesystem::paths::native(
                                    command["cwd"].as_js_string().unwrap(),
                                ),
                                &checked(
                                    "gitManagedOperationContextSchema",
                                    stored.as_ref().unwrap(),
                                )?,
                                &"".into(),
                                None,
                                scope,
                            )
                            .await?;
                            let record = crate::git::stored::record(
                                &command,
                                &worker,
                                &state,
                                stored.as_ref(),
                                None,
                                None,
                            )?;
                            crate::git::stored::put(directory, &command, &owner, &worker, &record)
                                .await?;
                            stored = Some(record);
                        }
                        return checked(
                            "gitManagedOperationResponseSchema",
                            &json!({"operation":stored}),
                        );
                    }
                    if matches!(
                        kind,
                        "git.action"
                            | "git.operation.preview"
                            | "git.operation.start"
                            | "git.commit.action.preview"
                            | "git.commit.action.apply"
                            | "git.stash.create"
                            | "git.stash.action.preview"
                            | "git.stash.action.apply"
                            | "git.patch.apply"
                            | "git.branch.action.apply"
                            | "git.remote.action.apply"
                            | "git.tag.action.apply"
                            | "git.submodule.action.apply"
                            | "git.lfs.action.apply"
                            | "git.worktree.changes.apply"
                            | "git.recovery.apply"
                    ) && crate::git::stored::active(stored.as_ref())
                    {
                        bail!("Finish or abort the active Git operation first.");
                    }
                    let control = matches!(kind, "git.operation.control" | "git.operation.amend");
                    if control
                        && (!crate::git::stored::active(stored.as_ref())
                            || stored.as_ref().is_none_or(|record| {
                                request["arguments"]["operationId"] != record["id"]
                            }))
                    {
                        bail!("Git operation not found.");
                    }
                    let moves = matches!(
                        kind,
                        "git.worktree.changes.preview" | "git.worktree.changes.apply"
                    );
                    if moves {
                        if command["peerWorktree"].is_null()
                            || !request["arguments"]["request"].is_object()
                            || request["arguments"]["request"]["sourceWorktreeId"]
                                != command["peerWorktree"]["id"]
                        {
                            bail!("The protected source worktree does not match the routed peer worktree.");
                        }
                    } else if !command["peerWorktree"].is_null() {
                        bail!("A peer worktree is only valid for a worktree changes move.");
                    }
                    let mut trusted = request["arguments"].clone();
                    trusted["type"] = request["type"].clone();
                    trusted["cwd"] = command["cwd"].clone();
                    trusted["sourcePath"] = command["sourcePath"].clone();
                    trusted["worktreePath"] = command["cwd"].clone();
                    if moves {
                        trusted["sourceCwd"] = command["peerWorktree"]["cwd"].clone();
                    }
                    if control {
                        trusted["context"] =
                            checked("gitManagedOperationContextSchema", stored.as_ref().unwrap())?;
                    }
                    let trusted = checked("workerCommandSchema", &trusted)?;
                    let result = if kind == "worktree.status" {
                        self.worktrees()?.execute(&trusted, scope, None).await?
                    } else {
                        crate::git::execute(&trusted, scope).await?
                    };
                    if control || kind == "git.operation.start" {
                        let record = crate::git::stored::record(
                            &command,
                            &worker,
                            &checked("gitManagedOperationWorkerStateSchema", &result)?,
                            if kind == "git.operation.start" {
                                None
                            } else {
                                stored.as_ref()
                            },
                            Some(&command["operationId"]),
                            None,
                        )?;
                        crate::git::stored::put(directory, &command, &owner, &worker, &record)
                            .await?;
                        checked(
                            "gitManagedOperationResponseSchema",
                            &json!({"operation":record}),
                        )
                    } else if kind == "git.commit.action.apply" {
                        if let Some(state) = crate::git::commits::managed_state(&result)? {
                            let record = crate::git::stored::record(
                                &command,
                                &worker,
                                &state,
                                None,
                                Some(&command["operationId"]),
                                None,
                            )?;
                            crate::git::stored::put(directory, &command, &owner, &worker, &record)
                                .await?;
                        }
                        Ok(result)
                    } else if matches!(
                        kind,
                        "git.stash.action.apply" | "git.worktree.changes.apply"
                    ) {
                        if !result["operation"].is_null() {
                            let mut state = result["operation"].clone();
                            state["state"] = json!("conflicted");
                            state["output"] = result["output"].clone();
                            state["status"] = result["status"].clone();
                            let state = checked("gitManagedOperationWorkerStateSchema", &state)?;
                            let record = crate::git::stored::record(
                                &command,
                                &worker,
                                &state,
                                None,
                                Some(&command["operationId"]),
                                None,
                            )?;
                            crate::git::stored::put(directory, &command, &owner, &worker, &record)
                                .await?;
                        }
                        Ok(result)
                    } else if kind == "git.conflicts.apply"
                        && crate::git::stored::active(stored.as_ref())
                    {
                        let state = crate::git::managed::inspect(
                            &crate::filesystem::paths::native(
                                command["cwd"].as_js_string().unwrap(),
                            ),
                            &checked("gitManagedOperationContextSchema", stored.as_ref().unwrap())?,
                            &"".into(),
                            None,
                            scope,
                        )
                        .await?;
                        let record = crate::git::stored::record(
                            &command,
                            &worker,
                            &state,
                            stored.as_ref(),
                            None,
                            None,
                        )?;
                        crate::git::stored::put(directory, &command, &owner, &worker, &record)
                            .await?;
                        Ok(result)
                    } else {
                        Ok(result)
                    }
                }
                _ => bail!("Repository operation is not implemented by the native worker."),
            }
        }
        .await;
        let outcome = match result {
            Ok(result) => json!({"ok":true,"result":result}),
            Err(error) => {
                let message = crate::git::error_message(&error);
                let mut outcome = json!({"ok":false,"error":JsString::new(message.units().iter().take(2000).copied().collect())});
                if let Some(error) = error.downcast_ref::<WorkspaceError>() {
                    outcome["code"] = json!(error.code);
                }
                outcome
            }
        };
        context["direction"] = json!("response");
        let protected = protect_repository_content(
            service,
            &context,
            &outcome,
            "repositoryOperationOutcomeContentSchema",
        )?;
        let mut response = json!({"operationId":command["operationId"],"protectedResponse":protected,"agentExecution":agent_execution});
        if let Some(attachment) = attachment {
            response["workspaceRootAttachment"] = attachment;
        }
        checked("repositoryOperationWireResponseSchema", &response)
    }
}
