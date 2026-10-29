//! WorkerLink session authority and peer signaling. Resource grants and direct
//! attachment routes are installed with their resource/lifecycle consumers.
use super::{
    body,
    middleware::{self, Context},
    settings::{error, output, parse},
};
use crate::{
    auth::service::AuthService,
    wire::{self, ValidationError, Value, value::json},
    worker_links::Error,
    workers::command_bus::CommandFailure,
};
use anyhow::{Context as _, Result};
use axum::{
    Extension, Router,
    extract::{Path, Request, State},
    http::Method,
    response::Response,
    routing::{delete, post},
};
use std::{collections::HashMap, sync::Arc};

pub(super) fn authorized(service: &AuthService, ctx: &Context, session: &str) -> Option<Value> {
    let user = ctx.principal.user.as_ref()?;
    service.worker_links.local.session_for_authorization(
        session,
        &Value::String(user.id.clone().into()),
        &Value::String(
            ctx.principal
                .session_id
                .clone()
                .unwrap_or_else(|| format!("local:{}", user.id))
                .into(),
        ),
    )
}
fn uuid(schema: &str, field: &str, id: &str) -> Result<bool> {
    match wire::parse_property(schema, field, &Value::String(id.into())) {
        Ok(_) => Ok(true),
        Err(ValidationError::Invalid(_)) => Ok(false),
        Err(ValidationError::Operation) => {
            anyhow::bail!("WorkerLink identity schema validation failed.")
        }
    }
}
pub(super) fn request_failure(cause: &anyhow::Error) -> Response {
    error(
        cause
            .downcast_ref::<CommandFailure>()
            .map_or(502, |cause| cause.status(502)),
        crate::settings::operation_error_message(cause),
    )
}
pub(super) fn failure(cause: &Error) -> Response {
    match cause {
        Error::Unavailable(message) => error(409, message.clone()),
        Error::Failure(cause) => request_failure(cause),
    }
}
async fn execute(
    service: Arc<AuthService>,
    ctx: Arc<Context>,
    params: HashMap<String, String>,
    request: Request,
) -> Result<Response> {
    let path = request.uri().path().to_owned();
    let deleting = request.method() == Method::DELETE;
    let body = match body::parse_js(request, service.config.api_body_limit_bytes).await {
        Ok(v) => v,
        Err(r) => return Ok(r),
    };
    let owner = &ctx
        .principal
        .user
        .as_ref()
        .context("Authenticated WorkerLink owner")?
        .id;
    let local = &service.worker_links.local;
    if let Some(worker) = params.get("workerId") {
        let input = match parse("workerLinkSessionOpenRequestSchema", body.as_ref())? {
            Ok(v) => v,
            Err(r) => return Ok(r),
        };
        if service
            .workers
            .repository
            .get_worker(owner, worker)
            .await?
            .is_none()
        {
            return Ok(error(404, "Worker not found."));
        }
        if !service.workers.bridge.is_connected(worker) {
            return Ok(error(503, "Worker is offline."));
        }
        return Ok(match local.open_session(json!({"ownerId":owner,"accountSessionId":ctx.principal.session_id.clone().unwrap_or_else(||format!("local:{owner}")),"clientInstanceId":input["clientInstanceId"],"workerId":worker})).await {
            Ok(value) => output(201, "workerLinkSessionSchema", &value)?, Err(cause) => failure(&cause),
        });
    }
    let session = &params["sessionId"];
    if path.ends_with("/observations/grant") {
        return super::worker_link_observations::execute(&service, &ctx, session, body.as_ref())
            .await;
    }
    if let Some(terminal) = params.get("terminalId") {
        return super::worker_link_terminals::execute(
            &service,
            &ctx,
            session,
            terminal,
            body.as_ref(),
        )
        .await;
    }
    if let Some(surface) = params.get("surfaceId") {
        return super::worker_link_surfaces::execute(
            &service,
            &ctx,
            session,
            surface,
            body.as_ref(),
        )
        .await;
    }
    if let Some(attachment) = params.get("attachmentId") {
        return super::worker_link_tunnels::execute(
            &service,
            &ctx,
            session,
            attachment,
            body.as_ref(),
        )
        .await;
    }
    let peer = params.get("peerSessionId");
    let grant = params.get("grantId");
    if peer.is_none() && grant.is_none() && !path.ends_with("/renew") && !path.ends_with("/peers") {
        return super::worker_link_sessions::execute(
            &service,
            &ctx,
            session,
            &path,
            deleting,
            body.as_ref(),
        )
        .await;
    }
    if let Some(peer) = peer
        && !uuid("workerLinkPeerSessionSchema", "peerSessionId", peer)?
    {
        return Ok(error(400, "Invalid peer session ID."));
    }
    if let Some(grant) = grant
        && !uuid("workerLinkGrantBindingSchema", "grantId", grant)?
    {
        return Ok(error(400, "Invalid WorkerLink grant ID."));
    }
    // Reference routes validate request bodies before looking up authority.
    let schema = if path.ends_with("/signals") {
        Some("workerLinkPeerSignalBatchSchema")
    } else if path.ends_with("/mailbox") {
        Some("workerLinkPeerMailboxReadRequestSchema")
    } else if path.ends_with("/peers") {
        Some("workerLinkPeerSessionOpenRequestSchema")
    } else {
        None
    };
    let input = if let Some(schema) = schema {
        match parse(schema, body.as_ref())? {
            Ok(v) => v,
            Err(r) => return Ok(r),
        }
    } else {
        Value::Null
    };
    if authorized(&service, &ctx, session).is_none() {
        return Ok(if deleting {
            axum::http::StatusCode::NO_CONTENT.into_response()
        } else {
            error(404, "WorkerLink session not found.")
        });
    }
    if let Some(peer) = peer {
        if deleting {
            local.revoke_peer(session, peer, "released").await;
            return Ok(axum::http::StatusCode::NO_CONTENT.into_response());
        }
        if path.ends_with("/signals") {
            let signals = input["signals"].as_array().unwrap();
            let first = &signals[0];
            if signals.iter().enumerate().any(|(index, signal)| {
                signal["sessionId"] != session.as_str()
                    || signal["peerSessionId"] != peer.as_str()
                    || signal["sender"] != "client"
                    || signal["route"] != first["route"]
                    || signal["routeGeneration"] != first["routeGeneration"]
                    || signal["signalSequence"].as_f64()
                        != Some(first["signalSequence"].as_f64().unwrap() + index as f64)
            }) {
                return Ok(error(
                    400,
                    "WorkerLink peer signal authority does not match.",
                ));
            }
            for signal in signals {
                if let Err(cause) = local.signal_peer(signal.clone()).await {
                    return Ok(failure(&cause));
                }
            }
            return Ok(axum::http::StatusCode::NO_CONTENT.into_response());
        }
        return Ok(match local.read_peer_mailbox(session, peer, input) {
            Ok(value) => output(200, "workerLinkPeerMailboxSchema", &value)?,
            Err(cause) => failure(&cause),
        });
    }
    if let Some(grant) = grant {
        if deleting {
            local.revoke_grant(session, grant, "released").await;
            return Ok(axum::http::StatusCode::NO_CONTENT.into_response());
        }
        return Ok(match local.renew_grant(session, grant, None).await {
            Ok(value) => output(200, "workerLinkLeaseSchema", &value)?,
            Err(cause) => failure(&cause),
        });
    }
    Ok(if path.ends_with("/peers") {
        match service.worker_links.open_peer(session, &input).await {
            Ok(value) => output(201, "workerLinkPeerSessionDescriptorSchema", &value)?,
            Err(cause) => failure(&cause),
        }
    } else {
        match local.renew_session(session, None).await {
            Ok(value) => output(200, "workerLinkSessionSchema", &value)?,
            Err(cause) => failure(&cause),
        }
    })
}
use axum::response::IntoResponse;
pub(super) async fn handle(
    State(service): State<Arc<AuthService>>,
    Extension(ctx): Extension<Arc<Context>>,
    Path(params): Path<HashMap<String, String>>,
    request: Request,
) -> Response {
    let (retained, context) = (service.clone(), ctx.clone());
    let mutation = request.method() == Method::POST;
    let resource = params
        .get("surfaceId")
        .map(|id| (id.clone(), true))
        .or_else(|| params.get("terminalId").map(|id| (id.clone(), false)));
    match service
        .worker_links
        .local
        .owned(async move { execute(retained, context, params, request).await })
        .await
    {
        Ok(response) if mutation && response.status().as_u16() < 400 && resource.is_some() => {
            let (id, surface) = resource.unwrap();
            let owner = ctx.principal.user.as_ref().unwrap().id.clone();
            let live = service.live.clone();
            super::on_response::completed(response, move || {
                let resources: &[&str] = if surface {
                    &[
                        "browser",
                        "remote-desktop",
                        "project-view",
                        "project-tab-layout",
                    ]
                } else {
                    &["terminal", "project-tab-layout"]
                };
                for resource in resources {
                    live.invalidate(&owner, resource, &id);
                }
            })
        }
        Ok(response) => response,
        Err(cause) => {
            if let Some(cause) = cause.downcast_ref::<Error>() {
                failure(cause)
            } else {
                middleware::failure(&service, &ctx.id, &cause)
            }
        }
    }
}
pub(super) fn routes() -> Router<Arc<AuthService>> {
    Router::new()
        .route("/api/workers/{workerId}/worker-link/sessions", post(handle))
        .route("/api/worker-links/{sessionId}/renew", post(handle))
        .route(
            "/api/worker-links/{sessionId}/tunnel-attachments/{attachmentId}/grant",
            post(handle),
        )
        .route(
            "/api/worker-links/{sessionId}/remote-surfaces/{surfaceId}/grant",
            post(handle),
        )
        .route(
            "/api/worker-links/{sessionId}/terminals/{terminalId}/grant",
            post(handle),
        )
        .route(
            "/api/worker-links/{sessionId}/observations/grant",
            post(handle),
        )
        .route("/api/worker-links/{sessionId}/peers", post(handle))
        .route(
            "/api/worker-links/{sessionId}/peers/{peerSessionId}/signals",
            post(handle),
        )
        .route(
            "/api/worker-links/{sessionId}/peers/{peerSessionId}/mailbox",
            post(handle),
        )
        .route(
            "/api/worker-links/{sessionId}/peers/{peerSessionId}",
            delete(handle),
        )
        .route(
            "/api/worker-links/{sessionId}/grants/{grantId}",
            delete(handle),
        )
        .route(
            "/api/worker-links/{sessionId}/grants/{grantId}/renew",
            post(handle),
        )
}
