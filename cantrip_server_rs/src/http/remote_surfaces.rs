//! Public encrypted surface management, separate from its binary socket relay.
use super::{
    body,
    middleware::{self, Context},
    on_response,
    settings::{error, output, parse},
};
use crate::{
    auth::service::AuthService,
    projects::placement::{PlacementRepository, Unavailable},
    remote_surfaces::{Repository, StateConflict},
    wire::{Value, value::json},
};
use anyhow::{Context as _, Result};
use axum::{
    Extension, Router,
    extract::{MatchedPath, Path, Request, State},
    http::{Method, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, patch, post},
};
use futures::FutureExt;
use std::{collections::HashMap, sync::Arc};

pub(super) fn placement_failure(cause: &anyhow::Error) -> Option<Response> {
    cause.downcast_ref::<Unavailable>().map(|value| {
        super::json_response(
            if value.code == "project-not-found" {
                StatusCode::NOT_FOUND
            } else {
                StatusCode::CONFLICT
            },
            json!({"code":value.code,"error":value.message}),
        )
    })
}
async fn execute(
    service: Arc<AuthService>,
    owner: String,
    params: HashMap<String, String>,
    route: String,
    method: Method,
    input: Option<Value>,
) -> Result<Response> {
    let repository = Repository::new(service.repository.database.clone());
    if let Some(project) = params.get("projectId") {
        if method == Method::GET || method == Method::HEAD {
            return output(
                200,
                "remoteSurfaceWireListSchema",
                &Value::Array(repository.list(&owner, project).await?),
            );
        }
        let input = match parse("encryptedRemoteSurfaceCreateSchema", input.as_ref())? {
            Ok(value) => value,
            Err(response) => return Ok(response),
        };
        if input["configuration"]["kind"] == "desktop" {
            return Ok(error(
                400,
                "Create desktop surfaces through the managed Remote Desktop endpoint.",
            ));
        }
        let connected = |worker: &str| service.workers.commands.is_connected(worker);
        let target = json!({"kind":"worker","projectId":project,"workerId":input["workerId"]});
        if let Err(cause) = PlacementRepository::new(service.repository.database.clone())?
            .resolve(
                &owner,
                project,
                "browser",
                Some(&target),
                Some(&connected),
                false,
            )
            .await
        {
            if let Some(response) = placement_failure(&cause) {
                return Ok(response);
            }
            return Err(cause);
        }
        return match repository.create(&owner, project, &input).await? {
            Some(value) => output(201, "remoteSurfaceWireSummarySchema", &value),
            None => Ok(error(404, "Project or worker not found.")),
        };
    }
    let id = &params["surfaceId"];
    if method == Method::PATCH {
        let input = match parse("encryptedRemoteSurfaceUpdateSchema", input.as_ref())? {
            Ok(value) => value,
            Err(response) => return Ok(response),
        };
        if input["configuration"]["kind"] == "desktop" {
            return Ok(error(
                400,
                "Desktop surface configuration is managed by the project worker.",
            ));
        }
        return match repository.update(&owner, id, &input).await {
            Ok(Some(value)) => output(200, "remoteSurfaceWireSummarySchema", &value),
            Ok(None) => Ok(error(404, "Remote Surface not found.")),
            Err(cause) if cause.is::<StateConflict>() => Ok(super::json_response(
                StatusCode::CONFLICT,
                json!({"code":"stale-state","error":"Remote Surface state changed before this update."}),
            )),
            Err(cause) => Err(cause),
        };
    }
    if method == Method::DELETE {
        let Some(context) = repository.delete(&owner, id).await? else {
            return Ok(error(404, "Remote Surface not found."));
        };
        let resource = if context["surface"]["kind"] == "browser" {
            "browser"
        } else {
            "remote-desktop"
        };
        let surface = context["surface"]["id"]
            .as_str()
            .context("Deleted surface identity")?;
        service
            .worker_links
            .revoke_resource(&owner, resource, surface, "resource-deleted")
            .await?;
        let worker = context["workerId"]
            .as_str()
            .context("Deleted surface worker")?;
        if service.workers.commands.is_connected(worker) {
            let (worker, surface) = (worker.to_owned(), surface.to_owned());
            let commands = service.workers.commands.clone();
            let mut close = Box::pin(async move {
                if let Err(cause) = commands
                    .request(
                        &worker,
                        json!({"type":"surface.close","surfaceId":surface}),
                        None,
                        None,
                    )
                    .await
                {
                    crate::operations::logging::server_logger()(
                        crate::operations::logging::LogCall::event(
                            "warn",
                            "Could not close deleted Remote Surface",
                            json!({"surfaceId":surface,"err":crate::operations::logging::error_details(&cause.into())}),
                        ),
                    );
                }
                Ok(())
            });
            if close.as_mut().now_or_never().is_none() {
                service.worker_maintenance.spawn_child(close);
            }
        }
        return Ok(StatusCode::NO_CONTENT.into_response());
    }
    let Some(context) = repository.context(&owner, id).await? else {
        return Ok(error(404, "Remote Surface not found."));
    };
    let worker = context["workerId"].as_str().context("Surface worker")?;
    if !service.workers.commands.is_connected(worker) {
        repository
            .record_status(
                &service.live,
                &owner,
                id,
                "offline",
                Some("Worker is offline."),
            )
            .await?;
        return Ok(error(503, "Worker is offline."));
    }
    let suspended = route.ends_with("/suspend");
    let result:Result<Response>=async {
        service.workers.commands.request(worker,json!({"type":if suspended{"surface.suspend"}else{"surface.resume"},"surfaceId":context["surface"]["id"]}),None,None).await?;
        repository.record_status(&service.live,&owner,id,if suspended{"suspended"}else{"active"},None).await?;
        match repository.context(&owner,id).await? {
            Some(value)=>output(200,"remoteSurfaceWireSummarySchema",&value["surface"]),
            None=>Ok(error(404,"Remote Surface was removed during the request.")),
        }
    }.await;
    Ok(result.unwrap_or_else(|cause| error(502, crate::settings::operation_error_message(&cause))))
}
pub(super) fn publish(
    service: &AuthService,
    owner: String,
    params: HashMap<String, String>,
    response: Response,
) -> Response {
    if response.status().as_u16() >= 400 {
        return response;
    }
    let scope = params.get("projectId").map_or(
        json!({"kind":"current-user"}),
        |id| json!({"kind":"project","projectId":id}),
    );
    let entity = params
        .get("surfaceId")
        .or_else(|| params.get("desktopId"))
        .or_else(|| params.get("projectId"))
        .cloned();
    let live = service.live.clone();
    on_response::completed(response, move || {
        for resource in [
            "browser",
            "remote-desktop",
            "project-view",
            "project-tab-layout",
        ] {
            let _=live.publish_event(json!({"ownerId":owner,"scope":scope,"resource":resource,"action":"invalidated","entityId":entity,"revision":Value::Null,"payload":Value::Null}));
        }
    })
}
async fn handle(
    State(service): State<Arc<AuthService>>,
    Extension(ctx): Extension<Arc<Context>>,
    Path(params): Path<HashMap<String, String>>,
    route: MatchedPath,
    request: Request,
) -> Response {
    let owner = ctx
        .principal
        .user
        .as_ref()
        .expect("Admitted surface request")
        .id
        .clone();
    let method = request.method().clone();
    let mutation = method != Method::GET && method != Method::HEAD;
    let result: Result<Response> = async {
        let input = if mutation {
            match body::parse_js_buffer(
                request,
                service.config.api_body_limit_bytes,
                (service.config.upload_limit_bytes * 3).div_ceil(2) + 1024 * 1024,
            )
            .await
            {
                Ok(value) => value,
                Err(response) => return Ok(response),
            }
        } else {
            drop(request);
            None
        };
        service
            .worker_maintenance
            .owned(execute(
                service.clone(),
                owner.clone(),
                params.clone(),
                route.as_str().to_owned(),
                method.clone(),
                input,
            ))
            .await
    }
    .await;
    let response = result.unwrap_or_else(|cause| middleware::failure(&service, &ctx.id, &cause));
    if mutation {
        publish(&service, owner, params, response)
    } else {
        response
    }
}
pub(super) fn unregistered_method(method: &Method, route: &str) -> bool {
    let get = method == Method::GET || method == Method::HEAD;
    match route {
        "/api/projects/:projectId/remote-surfaces" | "/api/projects/:projectId/remote-desktops" => {
            !get && *method != Method::POST
        }
        "/api/projects/:projectId/remote-desktop-fleet"
        | "/api/remote-surfaces/:surfaceId/connect" => !get,
        "/api/remote-desktops/:desktopId" => !get && *method != Method::PATCH,
        "/api/remote-surfaces/:surfaceId" => *method != Method::PATCH && *method != Method::DELETE,
        "/api/remote-surfaces/:surfaceId/suspend" | "/api/remote-surfaces/:surfaceId/resume" => {
            *method != Method::POST
        }
        _ => false,
    }
}
pub(super) fn routes() -> Router<Arc<AuthService>> {
    Router::new()
        .route(
            "/api/projects/{projectId}/remote-surfaces",
            get(handle).post(handle),
        )
        .route(
            "/api/remote-surfaces/{surfaceId}",
            patch(handle).delete(handle),
        )
        .route("/api/remote-surfaces/{surfaceId}/suspend", post(handle))
        .route("/api/remote-surfaces/{surfaceId}/resume", post(handle))
        .route(
            "/api/remote-surfaces/{surfaceId}/connect",
            get(super::remote_surface_socket::connect).head(super::remote_surface_socket::head),
        )
}
