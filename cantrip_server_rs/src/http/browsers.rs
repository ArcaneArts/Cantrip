use super::{
    body,
    middleware::{self, Context},
    on_response,
    settings::{error, output, parse},
};
use crate::{
    auth::service::AuthService,
    browsers::{Repository, StateConflict},
    projects::{placement::Unavailable, repository::ProjectRepository},
    tunnels::ManagementError,
    wire::{Value, value::json},
};
use anyhow::{Context as _, Result};
use axum::{
    Extension, Router,
    extract::{Path, Request, State},
    http::{Method, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, patch, post},
};
use futures::FutureExt;
use std::{collections::HashMap, sync::Arc};

async fn revoke_attachments(
    service: &Arc<AuthService>,
    owner: &str,
    tunnel: &Value,
    preserve: bool,
) -> Result<()> {
    // Source's Promise.all receives an already invoked map of async operations.
    // Admit every child in the caller before observing any failure;
    // try_join_all alone may stop before some large-list futures ever start.
    let operations = tunnel["attachments"]
        .as_array()
        .context("Managed tunnel attachments")?
        .iter()
        .map(|attachment| {
            let runtime = service.tunnel_runtime.clone();
            let owner = owner.to_owned();
            let id = attachment["id"]
                .as_str()
                .context("Managed attachment identity")
                .map(str::to_owned);
            let (send, receive) = tokio::sync::oneshot::channel();
            service.worker_maintenance.spawn_child(async move {
                let result: Result<()> = async {
                    runtime.revoke(&owner, &id?, preserve, None).await?;
                    Ok(())
                }
                .await;
                let _ = send.send(result);
                Ok(())
            });
            async move {
                receive
                    .await
                    .context("Browser attachment cleanup task ended")?
            }
        })
        .collect::<Vec<_>>();
    futures::future::try_join_all(operations).await?;
    Ok(())
}
pub(super) fn allows(project: &Value, worker: &Value) -> bool {
    if project["originKind"] != "managed-folder" {
        return true;
    }
    if project["capabilities"]["git"] == false {
        return project
            .get("preferredWorkerId")
            .filter(|v| !v.is_null())
            .or_else(|| project["source"].get("workerId"))
            == Some(worker);
    }
    project["replicas"].as_array().is_some_and(|rs| {
        rs.iter()
            .any(|r| r["ready"] == true && &r["workerId"] == worker)
    })
}
async fn tunnel(
    service: &Arc<AuthService>,
    owner: &str,
    id: &str,
    input: &Value,
) -> Result<Response> {
    let Some(context) =
        crate::remote_surfaces::Repository::new(service.repository.database.clone())
            .context(owner, id)
            .await?
    else {
        return Ok(error(404, "Browser not found."));
    };
    if context["surface"]["kind"] != "browser" {
        return Ok(error(404, "Browser not found."));
    }
    let project_id = context["surface"]["projectId"]
        .as_str()
        .context("Browser project")?;
    let Some(project) = ProjectRepository::new(service.repository.database.clone())?
        .get(owner, project_id)
        .await?
    else {
        return Ok(error(404, "Project not found."));
    };
    if !allows(&project, &input["workerId"]) {
        return Ok(super::json_response(
            StatusCode::CONFLICT,
            json!({"code":"target-mismatch","error":if project["capabilities"]["git"]==true {"This local Git project has no ready source on the selected worker."} else {"This worker-managed folder is bound to its owning worker."}}),
        ));
    }
    if !service
        .workers
        .repository
        .list_workers(owner)
        .await?
        .iter()
        .any(|w| Value::from_serialize(w)["workerId"] == input["workerId"])
    {
        return Ok(error(404, "Destination worker not found."));
    }
    let managed = json!({"kind":"browser","id":context["surface"]["id"]});
    let repo = crate::tunnels::Repository::new(service.repository.database.clone());
    let existing = repo.get_managed(owner, &managed).await?;
    let changed = existing.as_ref().is_some_and(|v| {
        input["resetAttachments"] == true
            || v["destination"]["kind"] != "worker-tcp"
            || v["destination"]["workerId"] != input["workerId"]
            || v["protocolHint"] != input["protocolHint"]
    });
    let worker = input["workerId"]
        .as_str()
        .context("Browser tunnel worker")?;
    let status = if !changed {
        existing.as_ref().map(|v| v["status"].clone())
    } else {
        None
    }
    .unwrap_or_else(|| {
        json!(if service.workers.bridge.is_connected(worker) {
            "stopped"
        } else {
            "offline"
        })
    });
    let mut value=repo.register_managed(owner,&json!({"name":"Browser tunnel","description":Value::Null,"projectId":project_id,"origin":"browser","management":"managed-ephemeral","protocolHint":input["protocolHint"],"source":json!({"kind":"desktop-loopback"}),"destination":json!({"kind":"worker-tcp","workerId":input["workerId"]}),"managedBy":managed,"desiredState":"started","status":status}),Some(&json!({"id":input["tunnelId"],"protectedRecord":input["protectedRecord"]}))).await?;
    if changed
        && value.is_some()
        && let Some(existing) = existing
    {
        revoke_attachments(service, owner, &existing, true).await?;
        value = repo.get_managed(owner, &managed).await?;
    }
    match value {
        Some(value) => output(200, "tunnelWireSummarySchema", &value),
        None => Ok(error(
            404,
            "Browser project or destination worker not found.",
        )),
    }
}
async fn mutate(
    service: Arc<AuthService>,
    owner: String,
    params: HashMap<String, String>,
    method: Method,
    is_tunnel: bool,
    input: Value,
) -> Result<Response> {
    let repo = Repository::new(service.repository.database.clone());
    if let Some(project) = params.get("projectId") {
        let connected = |worker: &str| service.workers.bridge.is_connected(worker);
        return match repo
            .create(&owner, project, &input, Some(&connected))
            .await?
        {
            Some(value) => output(201, "browserWireSummarySchema", &value),
            None => Ok(error(404, "Project source not found.")),
        };
    }
    let id = params.get("browserId").context("Browser route identity")?;
    if is_tunnel {
        return tunnel(&service, &owner, id, &input).await;
    }
    if method == Method::PATCH {
        return match crate::browsers::runtime::update(&service, &owner, id, &input, None, false)
            .await?
        {
            Some(value) => output(200, "browserWireSummarySchema", &value),
            None => Ok(error(404, "Browser not found.")),
        };
    }
    let remote = crate::remote_surfaces::Repository::new(service.repository.database.clone());
    let context = remote.context(&owner, id).await?;
    let tunnels = crate::tunnels::Repository::new(service.repository.database.clone());
    let managed = json!({"kind":"browser","id":id});
    let existing = tunnels.get_managed(&owner, &managed).await?;
    if !repo.delete(&owner, id).await? {
        return Ok(error(404, "Browser not found."));
    }
    service
        .worker_links
        .revoke_resource(&owner, "browser", id, "resource-deleted")
        .await;
    if let Some(existing) = existing {
        revoke_attachments(&service, &owner, &existing, false).await?;
        tunnels.remove_managed(&owner, &managed).await?;
    }
    if let Some(context) = context
        && let Some(worker) = context["workerId"].as_str()
        && service.workers.bridge.is_connected(worker)
    {
        let commands = service.workers.commands.clone();
        let worker = worker.to_owned();
        let command = json!({"type":"surface.close","surfaceId":context["surface"]["id"]});
        let mut close = Box::pin(async move {
            let _ = commands.request(&worker, command, None, None).await;
            Ok(())
        });
        // Start command admission in the caller, as Source's fire-and-forget
        // request does, then own the remainder through shutdown.
        if close.as_mut().now_or_never().is_none() {
            service.worker_maintenance.spawn_child(close);
        }
    }
    Ok(StatusCode::NO_CONTENT.into_response())
}
async fn handle(
    State(service): State<Arc<AuthService>>,
    Extension(ctx): Extension<Arc<Context>>,
    Path(params): Path<HashMap<String, String>>,
    request: Request,
) -> Response {
    let method = request.method().clone();
    let mutation = ![Method::GET, Method::HEAD].contains(&method);
    let owner = ctx.principal.user.as_ref().unwrap().id.clone();
    let is_tunnel = request.uri().path().ends_with("/tunnel");
    let result: Result<Response> = async {
        if !mutation {
            return output(
                200,
                "browserWireListSchema",
                &Value::Array(
                    Repository::new(service.repository.database.clone())
                        .list(
                            &owner,
                            params.get("projectId").context("Browser project route")?,
                        )
                        .await?,
                ),
            );
        }
        let body = match body::parse_js(request, service.config.api_body_limit_bytes).await {
            Ok(v) => v,
            Err(r) => return Ok(r),
        };
        let input = if method == Method::DELETE {
            Value::Null
        } else {
            match parse(
                if is_tunnel {
                    "browserTunnelWireRequestSchema"
                } else if method == Method::POST {
                    "encryptedBrowserCreateSchema"
                } else {
                    "encryptedBrowserUpdateSchema"
                },
                body.as_ref(),
            )? {
                Ok(v) => v,
                Err(r) => return Ok(r),
            }
        };
        let operation = mutate(
            service.clone(),
            owner.clone(),
            params.clone(),
            method,
            is_tunnel,
            input,
        );
        service.worker_maintenance.owned(operation).await
    }
    .await;
    let response = match result {
        Ok(response) => response,
        Err(failure) => {
            if failure.is::<StateConflict>() {
                super::json_response(
                    StatusCode::CONFLICT,
                    json!({"code":"stale-state","error":"Browser state changed before this update."}),
                )
            } else if let Some(unavailable) = failure.downcast_ref::<Unavailable>() {
                super::json_response(
                    if unavailable.code == "project-not-found" {
                        StatusCode::NOT_FOUND
                    } else {
                        StatusCode::CONFLICT
                    },
                    json!({"code":unavailable.code,"error":unavailable.message}),
                )
            } else if let Some(managed) = failure.downcast_ref::<ManagementError>() {
                error(409, managed.0)
            } else {
                middleware::failure(&service, &ctx.id, &failure)
            }
        }
    };
    if mutation && response.status().as_u16() < 400 {
        let resources: &[&str] = if is_tunnel {
            &["browser", "tunnel"]
        } else if params.contains_key("browserId") {
            &["browser", "tunnel", "project-tab-layout"]
        } else {
            &["browser", "project-tab-layout"]
        };
        let scope = params.get("projectId").map_or(
            json!({"kind":"current-user"}),
            |id| json!({"kind":"project","projectId":id}),
        );
        let entity = params
            .get("browserId")
            .or_else(|| params.get("projectId"))
            .cloned();
        let live = service.live.clone();
        on_response::completed(response, move || {
            for resource in resources {
                let _=live.publish_event(json!({"ownerId":owner,"scope":scope,"resource":resource,"action":"invalidated","entityId":entity,"revision":Value::Null,"payload":Value::Null}));
            }
        })
    } else {
        response
    }
}
pub(super) fn routes() -> Router<Arc<AuthService>> {
    Router::new()
        .route(
            "/api/projects/{projectId}/browsers",
            get(handle).post(handle),
        )
        .route("/api/browsers/{browserId}", patch(handle).delete(handle))
        .route("/api/browsers/{browserId}/tunnel", post(handle))
}
