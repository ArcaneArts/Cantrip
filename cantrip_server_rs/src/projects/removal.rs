//! Explicit project removal. Filesystem effects remain worker-owned, and an
//! admitted cleanup survives its HTTP caller's disappearance.
use super::{
    coordinator::Coordinator, github_conversion::ConversionRepository, replicas::ReplicaRepository,
    workspaces::WorkspaceRepository,
};
use crate::{
    auth::service::AuthService,
    wire::{Value, coercion::truthy, value::json},
};
use anyhow::{Context, Result};
use futures::future::BoxFuture;
use std::{
    sync::Arc,
    task::{Context as TaskContext, Poll, Waker},
};

#[derive(Debug)]
pub struct Rejection {
    pub status: u16,
    pub code: Option<&'static str>,
    pub message: &'static str,
}
impl std::fmt::Display for Rejection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.message)
    }
}
impl std::error::Error for Rejection {}
fn reject<T>(status: u16, code: Option<&'static str>, message: &'static str) -> Result<T> {
    Err(Rejection {
        status,
        code,
        message,
    }
    .into())
}
fn text(value: &Value) -> Result<String> {
    Ok(value
        .as_js_string()
        .context("Project cleanup identity")?
        .lossy()
        .into_owned())
}

// Source promises begin at construction. Poll each future once before detaching
// it; a sibling's early rejection must not cancel already-started cleanup.
fn start<T: Send + 'static>(
    coordinator: &Arc<Coordinator>,
    mut pending: BoxFuture<'static, Result<T>>,
) -> BoxFuture<'static, Result<T>> {
    match pending
        .as_mut()
        .poll(&mut TaskContext::from_waker(Waker::noop()))
    {
        Poll::Ready(result) => Box::pin(async move { result }),
        Poll::Pending => coordinator.own(pending),
    }
}

/// These reads and share revocation precede Source's worker-error boundary.
pub async fn prepare(
    service: &Arc<AuthService>,
    owner: &str,
    project: &str,
) -> Result<Option<Value>> {
    let database = service.repository.database.clone();
    let Some(context) = WorkspaceRepository::new(database.clone())
        .project_removal_context(owner, project)
        .await?
    else {
        return Ok(None);
    };
    if matches!(
        context["setupStatus"].as_str(),
        Some("cloning" | "preparing")
    ) {
        return reject(409, None, "Wait for project setup to finish.");
    }
    let jobs = ReplicaRepository::new(database.clone())
        .list(owner, project)
        .await?
        .unwrap_or_else(|| Value::Array(Vec::new()));
    if jobs
        .as_array()
        .context("Project replica jobs")?
        .iter()
        .any(|job| matches!(job["state"].as_str(), Some("queued" | "running")))
    {
        return reject(
            409,
            None,
            "Cancel or wait for active project replica jobs before deleting the project.",
        );
    }
    if ConversionRepository::new(database)
        .has_active(project)
        .await?
    {
        return reject(
            409,
            None,
            "Wait for the active GitHub conversion to finish before deleting the project.",
        );
    }
    service
        .project_shares
        .revoke_managed_resource(owner, project)
        .await?;
    Ok(Some(context))
}

fn managed_source(context: &Value) -> Option<&Value> {
    let source = &context["convertedManagedFolderSource"];
    (source["localFilesDeleted"] == false).then_some(source)
}
fn folder_worker(context: &Value) -> Result<Option<String>> {
    let replica = context["replicas"]
        .as_array()
        .context("Project sources")?
        .first()
        .map(|r| &r["workerId"]);
    replica
        .filter(|v| !v.is_null())
        .or_else(|| context.get("preferredWorkerId").filter(|v| !v.is_null()))
        .map(text)
        .transpose()
}
async fn require_folder_worker(
    service: &AuthService,
    owner: &str,
    worker: &str,
    converted: bool,
) -> Result<()> {
    let record = service.workers.repository.get_worker(owner, worker).await?;
    if !record.as_ref().is_some_and(|w| {
        w["managedFolders"]
            .get("remove")
            .is_some_and(|v| truthy(Some(&Value::from_serialize(v))))
    }) {
        return reject(
            409,
            Some("managed-folder-capability-unavailable"),
            if converted {
                "The converted folder's worker does not support safe managed folder deletion."
            } else {
                "The owning worker does not support safe managed folder deletion."
            },
        );
    }
    if !service.workers.bridge.is_connected(worker) {
        return reject(
            503,
            None,
            if converted {
                "The converted folder's worker must be online before deleting its local files."
            } else {
                "The owning worker must be online before deleting local folder files."
            },
        );
    }
    Ok(())
}
async fn delete_folder(
    service: &AuthService,
    worker: &str,
    project: &str,
    context: &Value,
) -> Result<()> {
    let result=service.workers.commands.request(worker,json!({"type":"project.folder.delete","projectId":project,"workspaceStorage":context["workspaceStorage"]}),None,None).await?;
    crate::settings::parse_response("managedFolderDeleteResultSchema", result.as_ref())?;
    Ok(())
}

pub fn execute(
    service: Arc<AuthService>,
    owner: String,
    project: String,
    context: Value,
    delete_files: bool,
) -> BoxFuture<'static, Result<bool>> {
    let coordinator = service.project_operations.clone();
    coordinator.serialize(&owner.clone(),&project.clone(),false,move ||Box::pin(async move {
        let terminals=context["terminals"].as_array().context("Project terminals")?;
        let mut revocations=Vec::new();
        for terminal in terminals {
            let service=service.clone();let owner=owner.clone();let terminal=text(&terminal["id"])?;
            revocations.push(start(&service.project_operations.clone(),Box::pin(async move {
                service.worker_links.revoke_resource(&owner,"terminal",&terminal,"resource-deleted").await?;
                Ok(())
            })));
        }
        futures::future::try_join_all(revocations).await?;
        let folder=context["originKind"]=="managed-folder";
        if delete_files {
            if folder && context["folderManagement"]=="external" {
                return reject(409,Some("external-folder-delete-forbidden"),"Cantrip does not own this attached folder. Remove the project without deleting local files.");
            }
            if folder {
                let Some(worker)=folder_worker(&context)? else {return reject(409,None,"The folder project no longer has an owning worker.")};
                require_folder_worker(&service,&owner,&worker,false).await?;
            } else {
                let converted=managed_source(&context);
                if let Some(converted)=converted {require_folder_worker(&service,&owner,&text(&converted["workerId"])?,true).await?;}
                for replica in context["replicas"].as_array().context("Project sources")? {
                    if converted.is_some_and(|s|s["projectSourceId"]==replica["id"]) {continue}
                    if replica["ownershipKind"]=="cantrip" && !service.workers.bridge.is_connected(&text(&replica["workerId"])?) {
                        return reject(503,None,"Every replica worker must be online before deleting local project files.");
                    }
                }
            }
        }
        crate::run_configurations::retirement::retire(&service,&owner,&project,None,None).await?;
        if delete_files {
            let mut closures=Vec::new();
            for terminal in terminals {
                let service=service.clone();let worker=text(&terminal["workerId"])?;let terminal=terminal["id"].clone();
                closures.push(start(&service.project_operations.clone(),Box::pin(async move {
                    service.workers.commands.request(&worker,json!({"type":"terminal.close","terminalId":terminal}),None,None).await?;
                    Ok(())
                })));
            }
            futures::future::try_join_all(closures).await?;
            if folder {
                delete_folder(&service,&folder_worker(&context)?.context("Prepared folder worker")?,&project,&context).await?;
            } else {
                let converted=managed_source(&context);
                if let Some(converted)=converted {delete_folder(&service,&text(&converted["workerId"])?,&project,&context).await?;}
                for replica in context["replicas"].as_array().context("Project sources")? {
                    if converted.is_some_and(|s|s["projectSourceId"]==replica["id"]) || replica["ownershipKind"]=="user" {continue}
                    service.workers.commands.request(&text(&replica["workerId"])?,json!({"type":"project.files.delete","path":replica["cwd"]}),None,None).await?;
                }
            }
        } else {
            for terminal in terminals {
                let worker=text(&terminal["workerId"])?;
                if !service.workers.bridge.is_connected(&worker) {continue}
                let service=service.clone();let terminal=terminal["id"].clone();
                drop(start(&service.project_operations.clone(),Box::pin(async move {
                    let _=service.workers.commands.request(&worker,json!({"type":"terminal.close","terminalId":terminal}),None,None).await;
                    Ok(())
                })));
            }
        }
        for surface in context["remoteSurfaces"].as_array().context("Project remote surfaces")? {
            let worker=text(&surface["workerId"])?;
            if service.workers.bridge.is_connected(&worker) {
                let _=service.workers.commands.request(&worker,json!({"type":"surface.close","surfaceId":surface["id"]}),None,None).await;
            }
        }
        WorkspaceRepository::new(service.repository.database.clone()).delete_project(&owner,&project).await
    }))
}
