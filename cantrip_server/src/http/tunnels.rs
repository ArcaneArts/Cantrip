use super::{
    body,
    middleware::{self, Context},
    on_response,
    settings::{error, output, parse},
};
use crate::{
    auth::service::AuthService,
    projects::repository::ProjectRepository,
    tunnels::{ManagementError, Repository},
    wire::{Value, value::json},
};
use anyhow::{Context as _, Result};
use axum::{
    Extension, Router,
    extract::{Path, Request, State},
    http::{Method, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
};
use std::{collections::HashMap, sync::Arc};

async fn execute(
    service: Arc<AuthService>,
    owner: &str,
    params: &HashMap<String, String>,
    request: Request,
) -> Result<Response> {
    let repo = Repository::new(service.repository.database.clone());
    let method = request.method().clone();
    let id = params.get("tunnelId");
    if method == Method::GET || method == Method::HEAD {
        if let Some(id) = id {
            return match repo.get(owner, id).await? {
                Some(value) => output(200, "tunnelWireSummarySchema", &value),
                None => Ok(error(404, "Tunnel not found.")),
            };
        }
        let project = params.get("projectId");
        if let Some(project) = project
            && !ProjectRepository::new(service.repository.database.clone())?
                .list(owner)
                .await?
                .iter()
                .any(|p| p["id"] == project.as_str())
        {
            return Ok(error(404, "Project not found."));
        }
        return output(
            200,
            "tunnelWireListSchema",
            &Value::Array(repo.list(owner, project.map(String::as_str)).await?),
        );
    }
    let body = match body::parse_js(request, service.config.api_body_limit_bytes).await {
        Ok(value) => value,
        Err(response) => return Ok(response),
    };
    let input = if method == Method::DELETE {
        Value::Null
    } else {
        match parse(
            if method == Method::POST {
                "tunnelUserWireCreateSchema"
            } else {
                "tunnelUserWireUpdateSchema"
            },
            body.as_ref(),
        )? {
            Ok(value) => value,
            Err(response) => return Ok(response),
        }
    };
    let owner = owner.to_owned();
    let id = id.cloned();
    service
        .worker_maintenance
        .owned(async move {
            if method == Method::DELETE {
                return Ok(
                    if repo
                        .delete_user(&owner, &id.context("Tunnel identity")?)
                        .await?
                    {
                        StatusCode::NO_CONTENT.into_response()
                    } else {
                        error(404, "Tunnel not found.")
                    },
                );
            }
            let creating = method == Method::POST;
            let value = if creating {
                repo.create_user(&owner, &input).await?
            } else {
                repo.update_user(&owner, &id.context("Tunnel identity")?, &input)
                    .await?
            };
            match value {
                Some(value) => output(
                    if creating { 201 } else { 200 },
                    "tunnelWireSummarySchema",
                    &value,
                ),
                None => Ok(error(
                    404,
                    if creating {
                        "Project or destination worker not found."
                    } else {
                        "Tunnel, project, or destination worker not found."
                    },
                )),
            }
        })
        .await
}
async fn handle(
    State(service): State<Arc<AuthService>>,
    Extension(ctx): Extension<Arc<Context>>,
    Path(params): Path<HashMap<String, String>>,
    request: Request,
) -> Response {
    let mutation = ![Method::GET, Method::HEAD].contains(request.method());
    let owner = ctx.principal.user.as_ref().unwrap().id.clone();
    let result = execute(service.clone(), &owner, &params, request).await;
    let response = match result {
        Ok(response) => response,
        Err(failure) => {
            if let Some(failure) = failure.downcast_ref::<ManagementError>() {
                error(409, failure.0)
            } else {
                middleware::failure(&service, &ctx.id, &failure)
            }
        }
    };
    if mutation && response.status().as_u16() < 400 {
        let live = service.live.clone();
        let entity = params.get("tunnelId").cloned();
        // Source invalidation scope comes from route parameters, not body or
        // persisted project ownership. POST /api/tunnels has no entity id.
        on_response::completed(response, move || {
            let _=live.publish_event(json!({"ownerId":owner,"scope":json!({"kind":"current-user"}),"resource":"tunnel","action":"invalidated","entityId":entity,"revision":Value::Null,"payload":Value::Null}));
        })
    } else {
        response
    }
}
pub(super) fn routes() -> Router<Arc<AuthService>> {
    Router::new()
        .route("/api/tunnels", get(handle).post(handle))
        .route(
            "/api/tunnels/{tunnelId}",
            get(handle).patch(handle).delete(handle),
        )
        .route("/api/projects/{projectId}/tunnels", get(handle))
}
