use super::{
    body, json_response,
    middleware::{self, Context},
    settings::{output, parse},
};
use crate::{auth::service::AuthService, project_alerts, wire::value::json, workers::credentials};
use anyhow::{Context as _, Result};
use axum::{
    Extension, Router,
    extract::{Request, State},
    http::StatusCode,
    response::Response,
    routing::post,
};
use std::sync::Arc;
async fn handle(
    State(service): State<Arc<AuthService>>,
    Extension(ctx): Extension<Arc<Context>>,
    request: Request,
) -> Response {
    let authorization = middleware::value(request.headers(), "authorization");
    let raw = match body::parse_js(request, service.config.api_body_limit_bytes).await {
        Ok(v) => v,
        Err(r) => return r,
    };
    let result: Result<Response> = async {
        let input = match parse("projectGoalObservationSchema", raw.as_ref())? {
            Ok(v) => v,
            Err(r) => return Ok(r),
        };
        let worker = input["workerId"]
            .as_str()
            .context("Goal observation worker")?;
        let Some(auth) = credentials::authenticate(
            &service.workers.repository,
            &service.config,
            authorization.as_deref(),
            worker,
            "worker:agent-tools",
        )
        .await?
        else {
            return Ok(json_response(
                StatusCode::UNAUTHORIZED,
                json!({"error":"Unauthorized"}),
            ));
        };
        if !input["snapshot"]["goal"].is_null()
            && input["snapshot"]["goal"]["threadId"] != input["threadId"]
        {
            return Ok(json_response(
                StatusCode::BAD_REQUEST,
                json!({"error":"Goal observation belongs to a different thread."}),
            ));
        }
        let alerts = project_alerts::Repository::new(service.repository.database.clone());
        if let Some(identity) = service.workers.bridge.connection_identity(worker) {
            if identity.owner != auth.credential.owner_id
                || input["generation"] != identity.process_generation
            {
                return output(
                    200,
                    "projectGoalObservationResultSchema",
                    &json!({"accepted":false,"reason":"retired-worker"}),
                );
            }
            alerts
                .register_goal_worker(&identity.owner, worker, &identity.process_generation)
                .await?;
        }
        let value = alerts
            .observe_goal(&auth.credential.owner_id, &input)
            .await?;
        output(200, "projectGoalObservationResultSchema", &value)
    }
    .await;
    result.unwrap_or_else(|e| middleware::failure(&service, &ctx.id, &e))
}
pub(super) fn routes() -> Router<Arc<AuthService>> {
    Router::new().route("/api/internal/project-alerts/goals", post(handle))
}
