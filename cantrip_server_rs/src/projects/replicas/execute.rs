use super::{service::ReplicaService, *};
use crate::{
    settings::parse_response,
    workers::bridge::{CommandError, EventHandler},
};
use std::time::Duration;
fn truth(value: &Value, key: &str) -> bool {
    crate::wire::coercion::truthy(value.get(key))
}
fn placement(context: &Value) -> Value {
    json!({"mode":context.get("placementMode").filter(|v|!v.is_null()).cloned().unwrap_or(json!("managed")),"materialization":"reused","ownership":context.get("ownershipKind").filter(|v|!v.is_null()).cloned().unwrap_or(json!("cantrip")),"canonicalPath":context["sourcePath"],"requestedPath":copy(context,"requestedPath"),"linkPath":copy(context,"linkPath")})
}
fn assert_current(job: &Value, result: &Value) -> Result<()> {
    anyhow::ensure!(
        result["jobId"] == job["id"] && result["attempt"] == job["attempt"],
        ReplicaError::Stale("The worker response does not match the active replica job attempt.")
    );
    Ok(())
}
impl ReplicaService {
    async fn blocked(&self, id: &str, command: &str, code: &str, retryable: bool) -> Result<Value> {
        self.repository
            .block(id, command, &json!({"code":code,"retryable":retryable}))
            .await
    }
    pub(super) async fn perform(self: &Arc<Self>, claimed: &Value) -> Result<()> {
        let job = &claimed["job"];
        let owner = text(&claimed["ownerId"])?;
        let id = text(&job["id"])?;
        let command = text(&claimed["commandId"])?;
        let worker_id = text(&job["workerId"])?;
        let project = text(&job["projectId"])?;
        let kind = text(&job["kind"])?;
        let worker =
            crate::projects::targets::TargetRepository::new(self.repository.database.clone())
                .worker(&owner, &job["workerId"])
                .await?;
        let Some(worker) = worker.filter(|_| self.bridge.is_connected(&worker_id)) else {
            let blocked = self.blocked(&id, &command, "worker-offline", true).await?;
            self.publish(&owner, &blocked);
            return Ok(());
        };
        let converted = if kind == "remove" && truth(job, "projectReplicaId") {
            let rows=self.repository.database.query("SELECT j.project_source_id FROM project_github_conversion_jobs j INNER JOIN project_sources s ON s.id=j.project_source_id WHERE j.owner_id=$1 AND j.project_id=$2 AND j.state='succeeded' AND s.ownership_kind='cantrip' AND s.removed_at IS NULL ORDER BY j.completed_at DESC LIMIT 1",&[&owner,&project]).await?;
            rows.first()
                .map(|r| r.get::<String>(0))
                .transpose()?
                .is_some_and(|source| job["projectReplicaId"] == source)
        } else {
            false
        };
        let mode = job["placementMode"].as_str().unwrap_or("managed");
        let storage =
            crate::projects::folders::FolderRepository::new(self.repository.database.clone())
                .workspace_storage(&owner, &project)
                .await?
                .context("Project workspace storage is unavailable.")?;
        let caps = &worker["projectReplicas"];
        anyhow::ensure!(
            !caps.is_null(),
            "Cannot read project replica capabilities from null"
        );
        let direct = kind != "provision"
            || (truth(caps, "attachExisting")
                && (!truth(job, "repository") || truth(caps, "recursiveParentCreation")));
        let placement_capable = (storage["kind"] != "managed"
            || mode == "direct"
            || truth(caps, "workspaceScopedRoots"))
            && (mode == "managed"
                || if mode == "managed-link" {
                    truth(caps, "managedLinkPlacement")
                        && (kind != "provision" || truth(caps, "recursiveParentCreation"))
                } else {
                    truth(caps, "directPlacement") && direct
                });
        let delete = job
            .get("deleteLocalFiles")
            .filter(|v| !v.is_null())
            .is_none_or(|v| crate::wire::coercion::truthy(Some(v)));
        let capable = match kind.as_str() {
            "provision" => {
                truth(caps, "provision") && truth(caps, "exactRevision") && placement_capable
            }
            "synchronize" => {
                truth(caps, "synchronize") && truth(caps, "exactRevision") && placement_capable
            }
            _ if converted => !delete || truth(&worker["managedFolders"], "remove"),
            _ => truth(caps, "remove") && placement_capable,
        };
        if !capable {
            let blocked = self
                .blocked(&id, &command, "capability-missing", false)
                .await?;
            self.publish(&owner, &blocked);
            return Ok(());
        }
        let event_service = self.clone();
        let event_job = job.clone();
        let event_owner = owner.clone();
        let event_command = command.clone();
        let events: EventHandler = Arc::new(move |event| {
            let (service, job, owner, command) = (
                event_service.clone(),
                event_job.clone(),
                event_owner.clone(),
                event_command.clone(),
            );
            Box::pin(async move {
                if event["type"] != "project.replica.progress" {
                    return Ok(());
                }
                if event["jobId"] != job["id"] || event["attempt"] != job["attempt"] {
                    ReplicaService::diagnostic("replica.job.stale-progress");
                    return Ok(());
                }
                let result: Result<()> = async {
                    if let Some(updated) = service
                        .repository
                        .update_progress(
                            &text(&job["id"])?,
                            &command,
                            job["attempt"].as_f64().context("Replica attempt")?,
                            &event["progress"],
                        )
                        .await?
                    {
                        service.publish(&owner, &updated)
                    }
                    Ok(())
                }
                .await;
                result.map_err(|error| CommandError {
                    message: error.to_string().into(),
                    code: None,
                    unavailable: false,
                    request_id: None,
                    encoding_error: None,
                })
            })
        });
        let timeout = Some(Duration::from_secs(if kind == "provision" {
            7260
        } else {
            1800
        }));
        let repository = if truth(job, "repository") {
            json!({"nameWithOwner":job["repository"]})
        } else {
            Value::Null
        };
        let settled = if kind == "provision" {
            let request = json!({"type":"project.replica.provision","jobId":job["id"],"attempt":job["attempt"],"projectId":job["projectId"],"repository":repository,"workspaceStorage":storage,"placement":if mode=="managed"{json!({"mode":"managed"})}else{json!({"mode":mode,"path":job["placementPath"]})},"expectedRevision":job["expectedRevision"]});
            let response = self
                .commands
                .request(&worker_id, request, timeout, Some(events))
                .await?;
            let result = parse_response("projectReplicaProvisionResultSchema", response.as_ref())?;
            assert_current(job, &result)?;
            if result["status"] == "blocked" {
                self.repository
                    .block(&id, &command, &result["error"])
                    .await?
            } else {
                self.repository
                    .complete_provision(&id, &command, &result)
                    .await?
            }
        } else {
            let context = self.repository.operation_context(&id, &command).await?;
            match context.filter(|_| truth(job, "projectReplicaId")) {
                None => {
                    self.blocked(&id, &command, "target-not-found", false)
                        .await?
                }
                Some(context) => {
                    let context_mode = context["placementMode"].as_str().unwrap_or("managed");
                    if context_mode != mode
                        || (context_mode != "managed" && !truth(&context, "repositoryFingerprint"))
                    {
                        self.blocked(&id, &command, "replica-not-ready", false)
                            .await?
                    } else if kind == "synchronize" {
                        anyhow::ensure!(
                            truth(job, "repository")
                                && truth(job, "expectedRevision")
                                && truth(job, "synchronizationPolicy"),
                            "Synchronization job payload is incomplete."
                        );
                        let mut request = json!({"type":"project.replica.synchronize","jobId":job["id"],"attempt":job["attempt"],"projectId":job["projectId"],"repository":repository,"sourcePath":context["sourcePath"],"placement":placement(&context),"expectedRevision":job["expectedRevision"],"policy":job["synchronizationPolicy"]});
                        if !context["repositoryFingerprint"].is_null() {
                            request["repositoryFingerprint"] =
                                context["repositoryFingerprint"].clone()
                        }
                        let response = self
                            .commands
                            .request(&worker_id, request, timeout, Some(events))
                            .await?;
                        let result = parse_response(
                            "projectReplicaSynchronizeResultSchema",
                            response.as_ref(),
                        )?;
                        assert_current(job, &result)?;
                        if result["status"] == "blocked" {
                            self.repository
                                .block(&id, &command, &result["error"])
                                .await?
                        } else {
                            self.repository
                                .complete_synchronize(&id, &command, &result)
                                .await?
                        }
                    } else {
                        let replica = text(&job["projectReplicaId"])?;
                        if self
                            .repository
                            .removal_blocker(&replica, &id)
                            .await?
                            .is_some()
                        {
                            self.blocked(&id, &command, "replica-in-use", false).await?
                        } else if !self.repository.mark_removal_started(&replica).await? {
                            self.blocked(&id, &command, "replica-not-ready", false)
                                .await?
                        } else {
                            let result = if converted {
                                if delete {
                                    let response=self.commands.request(&worker_id,json!({"type":"project.folder.delete","projectId":job["projectId"],"workspaceStorage":storage}),None,None).await?;
                                    parse_response(
                                        "managedFolderDeleteResultSchema",
                                        response.as_ref(),
                                    )?;
                                }
                                parse_response(
                                    "projectReplicaRemoveResultSchema",
                                    Some(
                                        &json!({"status":"removed","jobId":job["id"],"attempt":job["attempt"],"path":context["sourcePath"],"localFilesDeleted":delete}),
                                    ),
                                )?
                            } else {
                                let mut request = json!({"type":"project.replica.remove","jobId":job["id"],"attempt":job["attempt"],"projectId":job["projectId"],"repository":repository,"sourcePath":context["sourcePath"],"placement":placement(&context),"deleteLocalFiles":delete});
                                if !context["repositoryFingerprint"].is_null() {
                                    request["repositoryFingerprint"] =
                                        context["repositoryFingerprint"].clone()
                                }
                                let response = self
                                    .commands
                                    .request(&worker_id, request, timeout, Some(events))
                                    .await?;
                                parse_response(
                                    "projectReplicaRemoveResultSchema",
                                    response.as_ref(),
                                )?
                            };
                            assert_current(job, &result)?;
                            if result["status"] == "blocked" {
                                self.repository.restore_removal_ready(&replica).await?;
                                self.repository
                                    .block(&id, &command, &result["error"])
                                    .await?
                            } else {
                                self.repository
                                    .complete_remove(&id, &command, &result)
                                    .await?
                            }
                        }
                    }
                }
            }
        };
        self.publish(&owner, &settled);
        Ok(())
    }
}
