use super::{Kind, Repository, missing, summary};
use crate::http::{
    json_response,
    settings::{error, output},
};
use crate::{
    auth::service::AuthService,
    wire::{Value, value::json},
    workers::command_bus::CommandFailure,
};
use anyhow::{Context, Result};
use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
};
use futures::FutureExt;
use std::sync::Arc;

pub(super) async fn capability(
    service: &Arc<AuthService>,
    owner: &str,
    id: &str,
    capability: &str,
) -> Result<Option<Response>> {
    let project =
        crate::projects::repository::ProjectRepository::new(service.repository.database.clone())?
            .get(owner, id)
            .await?;
    Ok(project.filter(|p| p["capabilities"][capability] != true).map(|p| json_response(StatusCode::CONFLICT,json!({"code":"project-capability-unavailable","capability":capability,"error":format!("This {} project does not support the {capability} capability.",p["originKind"].as_str().unwrap_or("undefined"))}))))
}
pub(super) async fn worktree(
    service: Arc<AuthService>,
    owner: &str,
    kind: Kind,
    id: &str,
    input: &Value,
) -> Result<Response> {
    let repo = Repository::new(service.repository.database.clone());
    let project = if kind == Kind::View {
        repo.view_project(owner, id).await?
    } else {
        repo.context(kind, owner, id).await?.and_then(|v| {
            (if kind == Kind::Code {
                &v["codeTab"]["projectId"]
            } else {
                &v["projectId"]
            })
            .as_str()
            .map(str::to_owned)
        })
    };
    if let Some(project) = project
        && let Some(response) = capability(&service, owner, &project, "worktrees").await?
    {
        return Ok(response);
    }
    let result = async {
        match repo.update_worktree(kind, owner, id, input).await? {
            Some(value) => output(200, summary(kind), &value),
            None => Ok(error(
                404,
                match kind {
                    Kind::Explorer => "Explorer or worktree not found.",
                    Kind::Code => "Code tab or worktree not found.",
                    Kind::View => "History view or worktree not found.",
                },
            )),
        }
    }
    .await;
    if kind == Kind::Explorer {
        result
    } else {
        Ok(result
            .unwrap_or_else(|cause| error(409, crate::settings::operation_error_message(&cause))))
    }
}
pub(super) async fn operation(
    service: Arc<AuthService>,
    owner: &str,
    id: &str,
    input: &Value,
) -> Result<Response> {
    let Some(context) = Repository::new(service.repository.database.clone())
        .context(Kind::Explorer, owner, id)
        .await?
    else {
        return Ok(error(404, "Explorer not found."));
    };
    if let Some(binding) = input.get("binding")
        && ["workerId", "projectId", "worktreeId"]
            .iter()
            .any(|key| binding[key] != context[key])
    {
        return Ok(error(
            409,
            "This Explorer moved to another checkout. Reopen the file there; your draft has not been saved.",
        ));
    }
    let result: Result<Response> = async {
        let command = json!({"type":"explorer.operation","explorerId":context["explorerId"],"serverId":service.server_id,"root":context["root"],"operationId":input["operationId"],"sequence":input["sequence"],"protectedRequest":input["protectedRequest"]});
        let value=service.workers.commands.request(context["workerId"].as_str().context("Explorer worker")?,command,None,None).await?;
        let value=crate::settings::parse_response("surfaceStreamWireResponseSchema",value.as_ref())?;
        output(200,"surfaceStreamWireResponseSchema",&value)
    }.await;
    Ok(result.unwrap_or_else(|cause| {
        error(
            cause
                .downcast_ref::<CommandFailure>()
                .map_or(502, |e| e.status(502)),
            crate::settings::operation_error_message(&cause),
        )
    }))
}
pub(super) async fn delete(
    service: Arc<AuthService>,
    owner: &str,
    kind: Kind,
    id: &str,
) -> Result<Response> {
    let context = if kind == Kind::View {
        crate::remote_surfaces::Repository::new(service.repository.database.clone())
            .context(owner, id)
            .await?
    } else {
        None
    };
    if Repository::new(service.repository.database.clone())
        .delete(kind, owner, id)
        .await?
        .is_none()
    {
        return Ok(error(404, missing(kind)));
    }
    if let Some(context) = context {
        let resource = if context["surface"]["kind"] == "browser" {
            "browser"
        } else {
            "remote-desktop"
        };
        let surface = context["surface"]["id"]
            .as_str()
            .context("Deleted project view identity")?;
        service
            .worker_links
            .revoke_resource(owner, resource, surface, "resource-deleted")
            .await;
        let worker = context["workerId"]
            .as_str()
            .context("Deleted project view worker")?;
        if service.workers.bridge.is_connected(worker) {
            let commands = service.workers.commands.clone();
            let worker = worker.to_owned();
            let command = json!({"type":"surface.close","surfaceId":surface});
            let mut close = Box::pin(async move {
                let _ = commands.request(&worker, command, None, None).await;
                Ok(())
            });
            if close.as_mut().now_or_never().is_none() {
                service.worker_maintenance.spawn_child(close);
            }
        }
    }
    Ok(StatusCode::NO_CONTENT.into_response())
}
