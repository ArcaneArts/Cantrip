//! Authorized observation subscriptions installed in the worker's real hub.
use super::{
    middleware::Context,
    settings::{error, output, parse},
    worker_links::{authorized, failure},
};
use crate::{
    auth::service::AuthService,
    wire::{Value, value::json},
};
use anyhow::{Context as _, Result};
use axum::response::Response;

pub(super) async fn execute(
    service: &AuthService,
    ctx: &Context,
    session_id: &str,
    body: Option<&Value>,
) -> Result<Response> {
    let input = match parse("workerLinkObservationGrantRequestSchema", body)? {
        Ok(value) => value,
        Err(response) => return Ok(response),
    };
    let Some(session) = authorized(service, ctx, session_id) else {
        return Ok(error(404, "WorkerLink session not found."));
    };
    let owner = &ctx.principal.user.as_ref().context("Observation owner")?.id;
    let worker_id = session["identity"]["workerId"]
        .as_str()
        .context("Observation worker")?;
    if service
        .workers
        .repository
        .get_worker(owner, worker_id)
        .await?
        .is_none()
    {
        return Ok(error(404, "Worker not found."));
    }
    if !service.workers.bridge.is_connected(worker_id) {
        return Ok(error(503, "Worker is offline."));
    }
    let subscription = uuid::Uuid::new_v4().to_string();
    Ok(
        match service
            .worker_links
            .local
            .issue_grant(json!({
                "attachmentId": subscription,
                "lanes": ["events"],
                "maxChannels": 1,
                "observation": json!({"subscriptionId": subscription, "topics": input["topics"]}),
                "operations": ["events:subscribe"],
                "resourceId": worker_id,
                "resourceKind": "observations",
                "sessionId": session["sessionId"]
            }))
            .await
        {
            Ok(grant) => output(201, "workerLinkResourceGrantSchema", &grant)?,
            Err(cause) => failure(&cause),
        },
    )
}
