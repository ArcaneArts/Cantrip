use super::{
    direct_attachments::authorization,
    settings::{error, output, parse},
    worker_links,
};
use crate::{
    auth::service::AuthService,
    direct_attachments::{PrepareInput, Scope, Unavailable},
    wire::{Value, value::json},
};
use anyhow::Result;
use axum::{
    Router,
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{delete, post},
};
use std::sync::Arc;
fn scope(ctx: &super::middleware::Context, session: &str) -> Scope {
    Scope::Resource {
        owner: authorization(ctx)["ownerId"].clone(),
        kind: json!("worker-link"),
        resource: json!(session),
    }
}
pub(super) async fn execute(
    service: &Arc<AuthService>,
    ctx: &super::middleware::Context,
    session: &str,
    path: &str,
    deleting: bool,
    body: Option<&Value>,
) -> Result<Response> {
    let schema = if path.ends_with("/route") {
        Some("workerLinkRouteUpdateRequestSchema")
    } else if path.ends_with("/direct-activate") {
        Some("workerLinkDirectActivationSchema")
    } else if path.ends_with("/telemetry") {
        Some("workerLinkTelemetryBatchSchema")
    } else {
        None
    };
    let input = if let Some(schema) = schema {
        match parse(schema, body)? {
            Ok(v) => v,
            Err(r) => return Ok(r),
        }
    } else {
        Value::Null
    };
    let Some(current) = worker_links::authorized(service, ctx, session) else {
        return Ok(if deleting {
            StatusCode::NO_CONTENT.into_response()
        } else {
            error(404, "WorkerLink session not found.")
        });
    };
    if deleting {
        service
            .direct_attachments
            .revoke_scope(scope(ctx, session))
            .await;
        service
            .worker_links
            .revoke_session(session, "released")
            .await;
        return Ok(StatusCode::NO_CONTENT.into_response());
    }
    if path.ends_with("/route") {
        return Ok(
            match service
                .worker_links
                .replace_route(session, input["preferredRoute"].clone())
                .await
            {
                Ok(current) => {
                    if current["preferredRoute"] == "relay" {
                        service
                            .direct_attachments
                            .revoke_scope(scope(ctx, session))
                            .await;
                    }
                    output(200, "workerLinkSessionSchema", &current)?
                }
                Err(cause) => worker_links::failure(&cause),
            },
        );
    }
    if path.ends_with("/telemetry") {
        if input["routeGeneration"].as_f64().unwrap() > current["routeGeneration"].as_f64().unwrap()
        {
            return Ok(error(409, "WorkerLink route generation is not current."));
        }
        service.transport_metrics.worker_link(&input["samples"]);
        return Ok(StatusCode::NO_CONTENT.into_response());
    }
    let core = &service.direct_attachments;
    let mut authorization = authorization(ctx);
    authorization["attachmentId"] = json!(session);
    if path.ends_with("/direct-activate") {
        let capability = input["capabilityId"].as_str().unwrap();
        if !core.matches(capability, &authorization) {
            core.activate(capability, &authorization, "capability_mismatch");
            return Ok(error(404, "Direct attachment not found."));
        }
        return Ok(if core.activate(capability, &authorization, "completed") {
            StatusCode::NO_CONTENT.into_response()
        } else {
            error(409, "Direct attachment changed while activating.")
        });
    }
    if !current["routePolicy"]["enabled"]
        .as_array()
        .unwrap()
        .contains(&json!("local"))
    {
        return Ok(error(409, "WorkerLink LOCAL is not enabled."));
    }
    let lease_input = json!({"ownerId":authorization["ownerId"],"authSessionId":authorization["authSessionId"],"resourceId":session,"resourceKind":"worker-link"});
    let Some(lease) = core.acquire_preparation(lease_input.clone()) else {
        return Ok(error(409, "WorkerLink route is changing."));
    };
    let result = async {
        let Some(worker) = service
            .workers
            .repository
            .get_worker(
                authorization["ownerId"].as_str().unwrap(),
                current["identity"]["workerId"].as_str().unwrap(),
            )
            .await?
        else {
            return Ok(error(404, "Worker not found."));
        };
        let mut input = lease_input;
        input["attachmentId"] = json!(session);
        input["channels"] = json!(["worker-link"]);
        input["leaseExpiresAt"] = current["lease"]["expiresAt"].clone();
        input["maxLeaseExpiresAt"] = current["lease"]["absoluteExpiresAt"].clone();
        input["worker"] = Value::from_serialize(&worker);
        let ticket = core
            .prepare(PrepareInput {
                value: input,
                lease: lease.clone(),
            })
            .await?;
        output(201, "directAttachmentTicketSchema", &ticket)
    }
    .await;
    core.release_preparation(&lease);
    Ok(match result {
        Ok(response) => response,
        Err(cause) if cause.is::<Unavailable>() => error(409, cause.to_string()),
        Err(cause) => worker_links::request_failure(&cause),
    })
}
pub(super) fn routes() -> Router<Arc<AuthService>> {
    Router::new()
        .route(
            "/api/worker-links/{sessionId}",
            delete(worker_links::handle),
        )
        .route(
            "/api/worker-links/{sessionId}/route",
            post(worker_links::handle),
        )
        .route(
            "/api/worker-links/{sessionId}/telemetry",
            post(worker_links::handle),
        )
        .route(
            "/api/worker-links/{sessionId}/direct",
            post(worker_links::handle),
        )
        .route(
            "/api/worker-links/{sessionId}/direct-activate",
            post(worker_links::handle),
        )
}
