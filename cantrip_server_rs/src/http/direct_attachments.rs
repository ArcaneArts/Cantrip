use super::{
    body,
    middleware::{self, Context},
    settings::{error, output},
};
use crate::{
    auth::service::AuthService,
    direct_attachments::{PrepareInput, Unavailable},
    wire::{Value, value::json},
};
use anyhow::Result;
use axum::{
    Extension, Router,
    extract::{Path, Request, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{delete, post},
};
use std::{collections::HashMap, sync::Arc};
pub(super) fn authorization(ctx: &Context) -> Value {
    let owner = &ctx
        .principal
        .user
        .as_ref()
        .expect("Authenticated direct owner")
        .id;
    json!({"ownerId":owner,"authSessionId":ctx.principal.session_id.clone().unwrap_or_else(||format!("local:{owner}"))})
}
async fn execute(
    service: Arc<AuthService>,
    ctx: Arc<Context>,
    params: HashMap<String, String>,
    request: Request,
) -> Result<Response> {
    let deleting = request.method() == axum::http::Method::DELETE;
    let body = match body::parse_js(request, service.config.api_body_limit_bytes).await {
        Ok(v) => v,
        Err(r) => return Ok(r),
    };
    let authorization = authorization(&ctx);
    let core = &service.direct_attachments;
    if let Some(terminal) = params.get("terminalId") {
        return super::terminal_direct::execute(&service, &ctx, terminal, body.as_ref()).await;
    }
    if let Some(worker_id) = params.get("workerId") {
        let lease_input = json!({"ownerId":authorization["ownerId"],"authSessionId":authorization["authSessionId"],"resourceId":worker_id,"resourceKind":"probe"});
        let Some(lease) = core.acquire_preparation(lease_input.clone()) else {
            return Ok(error(409, "The owning resource is being revoked."));
        };
        let result = async {
            let Some(worker) = service
                .workers
                .repository
                .get_worker(authorization["ownerId"].as_str().unwrap(), worker_id)
                .await?
            else {
                return Ok(error(404, "Worker not found."));
            };
            let mut input = lease_input;
            input["worker"] = Value::from_serialize(&worker);
            input["channels"] = json!(["probe"]);
            let ticket = core
                .prepare(PrepareInput {
                    lease: lease.clone(),
                    value: input,
                })
                .await?;
            if !core.preparation_active(&lease) {
                core.revoke(
                    ticket["binding"]["capabilityId"].as_str().unwrap(),
                    "Owning resource was revoked",
                    None,
                )
                .await;
                return Ok(error(
                    409,
                    "The owning resource changed while direct access was opening.",
                ));
            }
            output(201, "directAttachmentTicketSchema", &ticket)
        }
        .await;
        core.release_preparation(&lease);
        return match result {
            Err(cause) if cause.is::<Unavailable>() => Ok(error(409, cause.to_string())),
            result => result,
        };
    }
    let capability = &params["capabilityId"];
    if deleting {
        core.revoke(
            capability,
            "Client released direct attachment",
            Some(&authorization),
        )
        .await;
        return Ok(StatusCode::NO_CONTENT.into_response());
    }
    // This reference route uses schema.parse rather than safeParse. Preserve its
    // exception/error-handler path instead of returning a different 400 contract.
    let telemetry =
        crate::settings::parse_response("directTransportTelemetrySchema", body.as_ref())?;
    let active = core.record_telemetry(capability, &authorization, telemetry.clone());
    let delta = active
        .clone()
        .or_else(|| core.record_final_telemetry(capability, &authorization, telemetry));
    let Some(delta) = delta else {
        return Ok(error(404, "Direct attachment not found."));
    };
    service
        .transport_metrics
        .direct(delta["resourceKind"].as_str().unwrap(), &delta);
    if active.is_none() {
        return Ok(StatusCode::NO_CONTENT.into_response());
    }
    let renewal = core.renew(capability, &authorization).await?;
    Ok(match renewal["status"].as_str().unwrap() {
        "completed" | "unsupported" | "missing" => StatusCode::NO_CONTENT.into_response(),
        "retryable-failure" => error(503, "Direct attachment renewal is temporarily unavailable."),
        "expired" | "not-active" | "worker-rejected" => {
            error(409, "Direct attachment renewal was rejected.")
        }
        status => anyhow::bail!("Unexpected direct lease outcome {status}"),
    })
}
async fn handle(
    State(service): State<Arc<AuthService>>,
    Extension(ctx): Extension<Arc<Context>>,
    Path(params): Path<HashMap<String, String>>,
    request: Request,
) -> Response {
    let (retained, context) = (service.clone(), ctx.clone());
    let terminal = params.get("terminalId").cloned();
    match service
        .worker_links
        .local
        .owned(async move { execute(retained, context, params, request).await })
        .await
    {
        Ok(response) if response.status().as_u16() < 400 && terminal.is_some() => {
            let terminal = terminal.unwrap();
            let owner = ctx.principal.user.as_ref().unwrap().id.clone();
            let live = service.live.clone();
            super::on_response::completed(response, move || {
                for resource in ["terminal", "project-tab-layout"] {
                    live.invalidate(&owner, resource, &terminal);
                }
            })
        }
        Ok(response) => response,
        Err(cause) => middleware::failure(&service, &ctx.id, &cause),
    }
}
pub(super) fn routes() -> Router<Arc<AuthService>> {
    Router::new()
        .route("/api/terminals/{terminalId}/direct", post(handle))
        .route("/api/workers/{workerId}/direct-probe", post(handle))
        .route("/api/direct-attachments/{capabilityId}", delete(handle))
        .route(
            "/api/direct-attachments/{capabilityId}/telemetry",
            post(handle),
        )
}
