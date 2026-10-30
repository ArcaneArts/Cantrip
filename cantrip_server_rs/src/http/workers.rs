use super::{
    body, json_response,
    middleware::{self, Context, value},
};
use crate::{
    auth::{crypto, repository::AuditRecord, service::AuthService},
    encryption::repository::EncryptionRepository,
    wire::{self, ValidationError, Value},
    workers::{
        DEFAULT_CREDENTIAL_SCOPES, WorkerEnrollmentError, credentials,
        repository::{EnrollmentInput, RotationInput},
        request,
    },
};
use anyhow::{Context as _, Result};
use axum::{
    Extension, Router,
    extract::{Path, Request, State},
    http::{Method, StatusCode},
    response::{IntoResponse, Response},
    routing::{delete, get, post},
};
use serde_json::{Value as JsonValue, json};
use std::{collections::HashMap, sync::Arc, time::Duration};

fn response(status: u16, value: impl serde::Serialize) -> Response {
    json_response(StatusCode::from_u16(status).unwrap(), value)
}
fn error(status: u16, message: &str) -> Response {
    response(status, json!({"error":message}))
}
fn output(status: u16, schema: &str, value: impl serde::Serialize) -> Result<Response> {
    let value = wire::parse(schema, Some(&Value::from_serialize(&value)))
        .map_err(|_| anyhow::anyhow!("Stored worker record violates its protocol contract."))?;
    Ok(response(status, value))
}
fn parse(schema: &str, value: Option<&Value>, message: &str) -> Result<Result<Value, Response>> {
    match wire::parse(schema, value) {
        Ok(value) => Ok(Ok(value)),
        Err(ValidationError::Invalid(issues)) => Ok(Err(response(
            400,
            Value::object([
                ("error", Value::String(message.into())),
                ("issues", Value::Array(issues)),
            ]),
        ))),
        Err(ValidationError::Operation) => anyhow::bail!("Worker request validation failed."),
    }
}
async fn audit(
    service: &AuthService,
    ctx: &Context,
    action: &str,
    owner: Option<&str>,
    worker: &str,
    result: &str,
) {
    if service
        .repository
        .audit(AuditRecord {
            action,
            result,
            owner,
            actor: ctx.principal.user.as_ref().map(|u| u.id.as_str()),
            session: ctx.principal.session_id.as_deref(),
            resource_type: "worker",
            resource: Some(worker),
            request_id: &ctx.id,
        })
        .await
        .is_err()
    {
        eprintln!(
            "{}",
            json!({"event":"security.audit-write-failed","requestId":ctx.id})
        );
    }
}
async fn execute(
    service: &Arc<AuthService>,
    ctx: &Context,
    path: &str,
    method: &Method,
    params: &HashMap<String, String>,
    headers: &axum::http::HeaderMap,
    input: Option<&Value>,
) -> Result<Response> {
    let state = &service.workers;
    let repository = &state.repository;
    let owner = ctx.principal.user.as_ref().map(|u| u.id.as_str());
    let read = *method == Method::GET || *method == Method::HEAD;
    if path == "/api/workers" {
        let mut workers = repository
            .list_workers(owner.context("worker catalog owner")?)
            .await?;
        for worker in &mut workers {
            worker["online"] = json!(
                state
                    .bridge
                    .is_connected(worker["workerId"].as_str().unwrap())
            );
        }
        return output(200, "workerListSchema", json!(workers));
    }
    if let Some(id) = params.get("enrollmentCodeId") {
        return match repository
            .enrollment_code_status(owner.context("enrollment code owner")?, id)
            .await?
        {
            Some(value) => output(200, "workerEnrollmentCodeStatusSchema", value),
            None => Ok(error(404, "Worker link code not found.")),
        };
    }
    if path == "/api/workers/enrollment-codes" {
        let default = Value::object(Vec::<(&str, Value)>::new());
        let input = match parse(
            "workerEnrollmentCodeCreateSchema",
            input.filter(|v| !v.is_null()).or(Some(&default)),
            "Invalid request body",
        )? {
            Ok(value) => value,
            Err(response) => return Ok(response),
        };
        let candidates = input["candidateWorkerIds"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| request::text(v).unwrap())
            .collect::<Vec<_>>();
        let owner = owner.context("worker pairing owner")?;
        let worker = repository.reusable_worker_id(owner, &candidates).await?;
        let (code, hash) = credentials::enrollment_code()?;
        let expires = crate::auth::now()
            + chrono::Duration::seconds(input["expiresInSeconds"].as_i64().unwrap());
        let label = request::text(&input["label"]);
        let id = repository
            .create_enrollment_code(
                owner,
                ctx.principal.session_id.as_deref(),
                &hash,
                label.as_deref(),
                expires,
            )
            .await?;
        let mut result = Value::from_serialize(
            &json!({"code":code,"id":id,"expiresAt":crate::auth::iso(expires),"workerId":worker}),
        );
        result["label"] = input["label"].clone();
        return output(201, "workerEnrollmentCodeResultSchema", result);
    }
    if path == "/api/internal/workers/enroll" {
        let input = match parse(
            "workerEnrollmentExchangeSchema",
            input,
            "Invalid request body",
        )? {
            Ok(value) => value,
            Err(response) => return Ok(response),
        };
        let generated = credentials::credential()?;
        let heartbeat = request::heartbeat(input["heartbeat"].clone())?;
        let worker_id = heartbeat["workerId"].as_str().unwrap().to_owned();
        let replacement = input.get("replacement").filter(|v| !v.is_null()).map(|v| {
            (
                request::text(&v["workerId"]).unwrap(),
                crypto::hash_secret(v["credential"].as_str().unwrap()),
            )
        });
        let provision = match repository
            .exchange_enrollment_code(EnrollmentInput {
                code_hash: crypto::hash_secret(input["code"].as_str().unwrap()),
                credential_hash: generated.hash,
                credential_id: generated.id,
                heartbeat,
                replacement,
                scopes: DEFAULT_CREDENTIAL_SCOPES.map(String::from).into(),
            })
            .await
        {
            Ok(value) => value,
            Err(error) => {
                if let Some(error) = error.downcast_ref::<WorkerEnrollmentError>() {
                    audit(
                        service,
                        ctx,
                        "worker.pairing-failed",
                        None,
                        &worker_id,
                        "denied",
                    )
                    .await;
                    return Ok(super::workers::error(409, error.0));
                }
                return Err(error);
            }
        };
        for id in provision.revoked_credential_ids {
            state.mark_revoked(&id);
        }
        if let Some(previous) = provision.replaced_worker_id {
            state
                .bridge
                .disconnect(&previous, "Worker was reassigned to another account", 1008);
            state.forget_presence(&previous);
            state.invalidate(&provision.owner_id, "worker", &previous);
            state.invalidate(&provision.owner_id, "worker-availability", &previous);
        }
        audit(
            service,
            ctx,
            "worker.paired",
            Some(&provision.owner_id),
            &worker_id,
            "succeeded",
        )
        .await;
        state.publish_presence(&provision.owner_id, &provision.worker);
        state.schedule_offline(&provision.owner_id, &worker_id);
        return output(
            201,
            "workerEnrollmentResultSchema",
            json!({"credential":generated.credential,"credentialSummary":provision.credential,"worker":provision.worker}),
        );
    }
    if path == "/api/internal/workers/heartbeat"
        || path == "/api/internal/workers/encryption/bootstrap"
    {
        let heartbeat = path.ends_with("/heartbeat");
        let id = if heartbeat {
            input
                .and_then(|v| v.get("workerId"))
                .and_then(request::text)
                .unwrap_or_default()
        } else {
            value(headers, "x-cantrip-worker-id")
                .map_or(String::new(), |s| crate::text::trim(&s).to_owned())
        };
        let authorization = value(headers, "authorization");
        let authenticated = credentials::authenticate(
            repository,
            &service.config,
            authorization.as_deref(),
            &id,
            if heartbeat {
                "worker:heartbeat"
            } else {
                "worker:connect"
            },
        )
        .await?;
        let Some(authenticated) = authenticated else {
            return Ok(error(401, "Unauthorized"));
        };
        let owner = &authenticated.credential.owner_id;
        let input = match parse(
            if heartbeat {
                "workerHeartbeatSchema"
            } else {
                "workerEncryptionBootstrapRequestSchema"
            },
            input,
            if heartbeat {
                "Invalid worker heartbeat"
            } else {
                "Invalid request body"
            },
        )? {
            Ok(value) => value,
            Err(response) => return Ok(response),
        };
        if heartbeat {
            let worker = repository
                .record_worker(owner, &request::heartbeat(input)?)
                .await?;
            state.publish_presence(owner, &worker);
            state.schedule_offline(owner, &id);
            let mut result = worker;
            result["computerUseEffects"] = state.computer_use_effects(owner).await?;
            return Ok(response(202, result));
        }
        let registry = EncryptionRepository::new(repository.database.clone());
        let requested = input["principalId"].as_str().unwrap();
        let key = serde_json::from_str::<JsonValue>(&input["publicKey"].stringify())?;
        let mut principal = registry
            .find_worker_principal(owner, &id, Some(requested))
            .await?;
        if principal.is_none() {
            let active = registry.find_worker_principal(owner, &id, None).await?;
            let create = json!({"id":requested,"kind":"worker","workerId":id,"label":"Cantrip worker","publicKey":key});
            principal = if active.is_some() {
                registry
                    .replace_worker_principal(owner, &id, &create)
                    .await?
            } else {
                registry
                    .create_principal(
                        owner,
                        &create,
                        authenticated.development.then_some(id.as_str()),
                    )
                    .await?
            };
            if principal.is_none() {
                principal = registry
                    .find_worker_principal(owner, &id, Some(requested))
                    .await?;
            }
        }
        let Some(principal) = principal
            .filter(|p| p["id"] == requested && p["workerId"] == id && p["publicKey"] == key)
        else {
            return Ok(error(
                409,
                "Worker encryption identity conflicts with the registered principal.",
            ));
        };
        let grants = if principal["state"] == "approved" {
            let result = registry.active_grants(owner, requested).await?;
            if result["status"] == "ok" {
                result["grants"].clone()
            } else {
                json!([])
            }
        } else {
            json!([])
        };
        return output(
            200,
            "workerEncryptionBootstrapResultSchema",
            json!({"serverId":service.server_id,"ownerId":owner,"principal":principal,"grants":grants}),
        );
    }
    let worker = params
        .get("workerId")
        .context("worker credential route identity")?;
    let owner = owner.context("worker credential owner")?;
    if read {
        return match repository.list_credentials(owner, worker).await? {
            Some(value) => output(200, "workerCredentialListSchema", json!(value)),
            None => Ok(error(404, "Worker not found.")),
        };
    }
    if *method == Method::DELETE {
        let Some(revoked) = repository
            .revoke_credential(
                owner,
                worker,
                params.get("credentialId").context("credential identity")?,
                "revoked by owner",
            )
            .await?
        else {
            return Ok(error(404, "Worker credential not found."));
        };
        state.mark_revoked(revoked["id"].as_str().unwrap());
        state
            .bridge
            .disconnect(worker, "Worker credential was revoked", 1008);
        return Ok(StatusCode::NO_CONTENT.into_response());
    }
    let default = Value::object(Vec::<(&str, Value)>::new());
    let input = match parse(
        "workerCredentialRotateSchema",
        input.filter(|v| !v.is_null()).or(Some(&default)),
        "Invalid request body",
    )? {
        Ok(value) => value,
        Err(response) => return Ok(response),
    };
    let generated = credentials::credential()?;
    let previous = repository.list_credentials(owner, worker).await?;
    let credential = match repository
        .rotate_credential(RotationInput {
            credential_hash: generated.hash,
            credential_id: generated.id,
            label: request::text(&input["label"]),
            owner_id: owner.into(),
            worker_id: worker.clone(),
            scopes: DEFAULT_CREDENTIAL_SCOPES.map(String::from).into(),
        })
        .await
    {
        Ok(value) => value,
        Err(error) => {
            if let Some(error) = error.downcast_ref::<WorkerEnrollmentError>() {
                return Ok(super::workers::error(409, error.0));
            }
            return Err(error);
        }
    };
    let Some(credential) = credential else {
        return Ok(error(404, "Worker not found."));
    };
    for previous in previous.unwrap_or_default() {
        if previous["active"] == true {
            state.mark_revoked(previous["id"].as_str().unwrap());
        }
    }
    let delivered = if state.bridge.is_connected(worker) {
        state
            .commands
            .request(
                worker,
                Value::from_serialize(
                    &json!({"type":"worker.credential.rotate","credential":generated.credential}),
                ),
                Some(Duration::from_secs(10)),
                None,
            )
            .await
            .is_ok()
    } else {
        false
    };
    state
        .bridge
        .disconnect(worker, "Worker credential was rotated", 1012);
    output(
        200,
        "workerCredentialRotateResultSchema",
        json!({"credential":generated.credential,"credentialSummary":credential,"delivered":delivered}),
    )
}
async fn handle(
    State(service): State<Arc<AuthService>>,
    Extension(ctx): Extension<Arc<Context>>,
    Path(params): Path<HashMap<String, String>>,
    request: Request,
) -> Response {
    let path = request.uri().path().to_owned();
    let method = request.method().clone();
    let headers = request.headers().clone();
    let input = if method == Method::GET || method == Method::HEAD {
        None
    } else {
        match body::parse_js(request, service.config.api_body_limit_bytes).await {
            Ok(value) => value,
            Err(response) => return response,
        }
    };
    match execute(
        &service,
        &ctx,
        &path,
        &method,
        &params,
        &headers,
        input.as_ref(),
    )
    .await
    {
        Ok(response) => response,
        Err(error) => middleware::failure(&service, &ctx.id, &error),
    }
}
pub(super) fn routes() -> Router<Arc<AuthService>> {
    Router::new()
        .route("/api/workers", get(handle))
        .route("/api/workers/enrollment-codes", post(handle))
        .route(
            "/api/workers/enrollment-codes/{enrollmentCodeId}",
            get(handle),
        )
        .route("/api/internal/workers/enroll", post(handle))
        .route("/api/internal/workers/heartbeat", post(handle))
        .route("/api/internal/workers/encryption/bootstrap", post(handle))
        .route("/api/workers/{workerId}/credentials", get(handle))
        .route("/api/workers/{workerId}/credentials/rotate", post(handle))
        .route(
            "/api/workers/{workerId}/credentials/{credentialId}",
            delete(handle),
        )
}
