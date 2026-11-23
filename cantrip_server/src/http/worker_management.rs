//! Owner-scoped management, restart acknowledgment and permanent unlink.
use super::{
    body, json_response,
    middleware::{self, Context},
    settings::{error, output, parse},
};
use crate::{
    auth::service::AuthService,
    operations::{logging, shared_failure::downcast_ref},
    wire::{Value, value::json},
    workers::{command_bus::CommandFailure, credentials},
};
use anyhow::{Context as _, Result};
use axum::{
    Extension, Router,
    extract::{Path, Request, State},
    http::{Method, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{delete, get, post},
};
use std::{collections::HashMap, sync::Arc, time::Duration};

async fn operate(
    service: Arc<AuthService>,
    ctx: Arc<Context>,
    owner: String,
    worker: Option<String>,
    method: Method,
    input: Option<Value>,
) -> Result<Response> {
    let input = if method == Method::PATCH {
        match parse("workerUpdateSchema", input.as_ref())? {
            Ok(input) => Some(input),
            Err(response) => return Ok(response),
        }
    } else {
        None
    };
    let records = service.workers.repository.list_management(&owner).await?;
    let development = credentials::development_allowed(&service.config);
    if matches!(method, Method::GET | Method::HEAD) {
        let entries = records
            .into_iter()
            .map(|record| {
                let internal = development && record.credential_count == 0;
                let mut worker = Value::from_serialize(&record.worker);
                for (field, value) in [
                    ("runtimeName", json!(record.runtime_name)),
                    ("internal", json!(internal)),
                    ("editable", json!(!internal)),
                    ("removable", json!(!internal)),
                    ("credentialCount", json!(record.credential_count)),
                    (
                        "activeCredentialCount",
                        json!(record.active_credential_count),
                    ),
                    ("sources", Value::from_serialize(&record.sources)),
                ] {
                    worker[field] = value;
                }
                worker
            })
            .collect::<Vec<_>>();
        return output(200, "workerManagementListSchema", &Value::Array(entries));
    }
    let worker = worker.context("Worker management identity")?;
    let Some(record) = records
        .iter()
        .find(|record| record.worker["workerId"] == worker)
    else {
        return Ok(error(404, "Worker not found."));
    };
    if method == Method::POST {
        let response = service
            .workers
            .commands
            .request(
                &worker,
                json!({"type":"worker.restart"}),
                Some(Duration::from_secs(10)),
                None,
            )
            .await;
        let response = match response {
            Ok(value) => value,
            Err(cause) if matches!(&cause,CommandFailure::Bridge(bridge) if bridge.unavailable) => {
                return Ok(error(409, "The worker is offline and cannot be restarted."));
            }
            Err(cause) => return Err(cause.into()),
        };
        crate::settings::parse_response("workerRestartAcknowledgementSchema", response.as_ref())?;
        logging::server().dispatch(logging::LogCall::event("info","Worker restart requested",json!({"event":"worker.runtime.restart-requested","subsystem":"worker-command","operation":"worker.restart","status":"accepted","requestId":ctx.id,"workerId":worker})))?;
        return output(
            202,
            "workerRestartResultSchema",
            &json!({"workerId":worker,"status":"restarting"}),
        );
    }
    if development && record.credential_count == 0 {
        return Ok(error(
            409,
            if method == Method::PATCH {
                "The internal worker cannot be renamed."
            } else {
                "The internal worker cannot be unlinked."
            },
        ));
    }
    if method == Method::PATCH {
        return match service
            .workers
            .repository
            .update_display_name(
                &owner,
                &worker,
                &input.context("Worker rename input")?["name"],
            )
            .await?
        {
            Some(worker) => Ok(json_response(StatusCode::OK, worker)),
            None => Ok(error(404, "Worker not found.")),
        };
    }
    let credentials = service
        .workers
        .repository
        .list_credentials(&owner, &worker)
        .await?;
    if !service.workers.repository.unlink(&owner, &worker).await? {
        return Ok(error(404, "Worker not found."));
    }
    for credential in credentials.as_ref().into_iter().flatten() {
        if credential["active"] == true {
            service
                .workers
                .mark_revoked(credential["id"].as_str().context("Worker credential")?);
        }
    }
    service
        .workers
        .bridge
        .disconnect(&worker, "Worker was unlinked", 1008);
    service
        .workers
        .invalidate(&owner, "worker-availability", &worker);
    logging::server().dispatch(logging::LogCall::event("info","Worker unlinked",json!({"event":"worker.enrollment.unlinked","subsystem":"worker-auth","operation":"unlink","status":"completed","requestId":ctx.id,"workerId":worker,"counts":json!({"credentials":credentials.as_ref().map_or(0,Vec::len)})})))?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

async fn handle(
    State(service): State<Arc<AuthService>>,
    Extension(ctx): Extension<Arc<Context>>,
    Path(params): Path<HashMap<String, String>>,
    request: Request,
) -> Response {
    let mutation = !matches!(
        *request.method(),
        Method::GET | Method::HEAD | Method::OPTIONS
    );
    let result: Result<Response> = async {
        let method = request.method().clone();
        let binary = (service.config.upload_limit_bytes * 3).div_ceil(2) + 1024 * 1024;
        let input = if method == Method::PATCH {
            match body::parse_js_buffer(request, service.config.api_body_limit_bytes, binary).await
            {
                Ok(body) => body,
                Err(response) => return Ok(response),
            }
        } else {
            if let Err(response) =
                body::parse_ignored(request, service.config.api_body_limit_bytes, binary).await
            {
                return Ok(response);
            }
            None
        };
        let owner = ctx
            .principal
            .user
            .as_ref()
            .context("Worker management principal")?
            .id
            .clone();
        service
            .project_operations
            .own(operate(
                service.clone(),
                ctx.clone(),
                owner,
                params.get("workerId").cloned(),
                method,
                input,
            ))
            .await
    }
    .await;
    match result {
        Ok(response) if mutation && response.status().as_u16() < 400 => {
            let owner = ctx
                .principal
                .user
                .as_ref()
                .expect("admitted worker principal")
                .id
                .clone();
            let worker = params
                .get("workerId")
                .cloned()
                .expect("worker mutation identity");
            let workers = service.workers.clone();
            // Source's global onResponse hook publishes the worker catalog
            // only after a successful mutating HTTP response completes.
            super::on_response::completed(response, move || {
                workers.invalidate(&owner, "worker", &worker)
            })
        }
        Ok(response) => response,
        Err(cause) => {
            if let Some(CommandFailure::Limit(limit)) = downcast_ref::<CommandFailure>(&cause) {
                let mut response = error(429, limit.message);
                response.headers_mut().insert(
                    header::RETRY_AFTER,
                    limit.retry_after_seconds.to_string().parse().unwrap(),
                );
                response
            } else {
                middleware::failure(&service, &ctx.id, &cause)
            }
        }
    }
}

pub(super) fn routes() -> Router<Arc<AuthService>> {
    Router::new()
        .route("/api/workers/management", get(handle))
        .route("/api/workers/{workerId}/restart", post(handle))
        .route("/api/workers/{workerId}", delete(handle).patch(handle))
}
