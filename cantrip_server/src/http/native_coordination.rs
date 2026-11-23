//! Native pending registration and permission policy reads retain their
//! distinct errors and do not add the admission routes' extra worker lookup.
use super::{
    body, json_response,
    middleware::{self, Context},
};
use crate::{
    auth::service::AuthService,
    native_commands::{CommandError, Repository},
    wire::{self, value::json},
    workers::credentials,
};
use axum::{
    Extension, Router,
    extract::{Request, State},
    http::StatusCode,
    response::Response,
    routing::post,
};
use std::sync::Arc;
fn code(status: u16, key: &str) -> Response {
    json_response(StatusCode::from_u16(status).unwrap(), json!({"code":key}))
}
async fn handle(
    State(service): State<Arc<AuthService>>,
    Extension(ctx): Extension<Arc<Context>>,
    request: Request,
) -> Response {
    let pending = request.uri().path().ends_with("/pending");
    let authorization = middleware::value(request.headers(), "authorization");
    let body = match body::parse_js(request, service.config.api_body_limit_bytes).await {
        Ok(v) => v,
        Err(r) => return r,
    };
    let input = match wire::parse(
        if pending {
            "nativePendingRequestSchema"
        } else {
            "nativePermissionTransitionResolveSchema"
        },
        body.as_ref(),
    ) {
        Ok(v) => v,
        Err(_) => {
            return code(
                400,
                if pending {
                    "invalid-native-request"
                } else {
                    "invalid-permission-transition"
                },
            );
        }
    };
    let worker = input["workerId"]
        .as_js_string()
        .unwrap()
        .lossy()
        .into_owned();
    let authentication = match credentials::authenticate(
        &service.workers.repository,
        &service.config,
        authorization.as_deref(),
        &worker,
        "worker:agent-tools",
    )
    .await
    {
        Ok(Some(a)) => a,
        Ok(None) => return code(401, "unauthorized"),
        Err(cause) => return middleware::failure(&service, &ctx.id, &cause),
    };
    let owner = authentication.credential.owner_id;
    let database = service.repository.database.clone();
    match service
        .scratch_roots
        .owned(async move {
            let repo = Repository::new(database);
            if pending {
                repo.register_pending(&owner, &input).await?;
                Ok(json!({"registered":true}))
            } else {
                repo.resolve_permission_transition(&owner, &input).await
            }
        })
        .await
    {
        Ok(v) => json_response(StatusCode::OK, v),
        Err(cause) => {
            if let Some(e) = cause.downcast_ref::<CommandError>() {
                if pending {
                    code(e.status, &e.code)
                } else {
                    json_response(
                        StatusCode::from_u16(e.status).unwrap(),
                        json!({"code":e.code,"error":e.message}),
                    )
                }
            } else {
                middleware::failure(&service, &ctx.id, &cause)
            }
        }
    }
}
pub(super) fn routes() -> Router<Arc<AuthService>> {
    Router::new()
        .route(
            "/api/internal/native-commands/permission-transition",
            post(handle),
        )
        .route("/api/internal/native-commands/pending", post(handle))
}
