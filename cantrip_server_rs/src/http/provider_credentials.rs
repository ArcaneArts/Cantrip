//! Worker access to opaque provider credentials. The worker's credential owner,
//! rather than an optional browser session, scopes every repository operation.
use super::{
    account, body, json_response,
    middleware::{self, Context},
};
use crate::{
    auth::service::AuthService,
    settings::{accounts::CredentialConflict, repository::SettingsRepository},
    wire::{self, ValidationError, Value},
    workers::credentials,
};
use anyhow::{Context as _, Result};
use axum::{
    Extension, Router,
    extract::{Path, Request, State},
    http::{Method, StatusCode},
    response::Response,
    routing::get,
};
use serde_json::json;
use std::{collections::HashMap, sync::Arc};

fn error(status: u16, message: &str) -> Response {
    json_response(
        StatusCode::from_u16(status).unwrap(),
        json!({"error":message}),
    )
}
fn record(value: &serde_json::Value) -> Result<Response> {
    let value = Value::from_serialize(&json!({
        "accountId":value["accountId"],
        "credential":value["credential"],
        "credentialRevision":value["revision"],
        "providerId":value["providerId"],
        "providerKind":value["providerKind"],
    }));
    Ok(json_response(
        StatusCode::OK,
        crate::settings::parse_response("providerCredentialWireRecordSchema", Some(&value))?,
    ))
}
async fn execute(
    service: &AuthService,
    params: &HashMap<String, String>,
    request: Request,
) -> Result<Response> {
    let read = request.method() == Method::GET || request.method() == Method::HEAD;
    let query = account::query(request.uri());
    let authorization = middleware::value(request.headers(), "authorization");
    // Fastify's payload parser runs before route-level worker authentication.
    let input = if read {
        None
    } else {
        match body::parse_js(request, service.config.api_body_limit_bytes).await {
            Ok(value) => value,
            Err(response) => return Ok(response),
        }
    };
    if !wire::coercion::truthy(query.get("workerId")) {
        return Ok(error(400, "workerId is required."));
    }
    // Repeated query keys are arrays. Both reference database drivers bind
    // these text parameters through JS string conversion (comma joining),
    // including valid worker identities containing commas.
    let worker_id = wire::coercion::string(&query["workerId"])
        .map_err(|_| anyhow::anyhow!("Worker query text conversion failed."))?
        .lossy()
        .into_owned();
    let Some(authenticated) = credentials::authenticate(
        &service.workers.repository,
        &service.config,
        authorization.as_deref(),
        &worker_id,
        "worker:connect",
    )
    .await?
    else {
        return Ok(error(401, "Unauthorized"));
    };
    let owner = &authenticated.credential.owner_id;
    let worker = service
        .workers
        .repository
        .get_worker(owner, &worker_id)
        .await?;
    if read && worker.is_none() {
        return Ok(error(404, "Worker not found."));
    }
    if !worker.as_ref().is_some_and(|worker| {
        worker["encryption"]["grants"]
            .as_array()
            .is_some_and(|grants| {
                grants
                    .iter()
                    .any(|grant| grant["component"] == "provider-credential")
            })
    }) {
        return Ok(error(
            403,
            "Worker lacks provider credential authorization.",
        ));
    }
    let repository = SettingsRepository::new(service.repository.database.clone());
    let provider = &params["providerId"];
    let account = &params["accountId"];
    if read {
        let Some(value) = repository
            .get_provider_account_credential(owner, provider, account)
            .await?
        else {
            return Ok(error(404, "Provider credential not found."));
        };
        if value["state"] == "reauth-required" {
            return Ok(json_response(
                StatusCode::CONFLICT,
                json!({"code":"reauth-required","error":"ChatGPT authentication expired. Sign in again to reconnect this provider account."}),
            ));
        }
        if value["state"] == "conflict" {
            return Ok(json_response(
                StatusCode::CONFLICT,
                json!({"code":"identity-conflict","error":"The provider account has a credential identity conflict."}),
            ));
        }
        return record(&value);
    }
    let input = match wire::parse("providerCredentialUploadSchema", input.as_ref()) {
        Ok(value) => value,
        Err(ValidationError::Invalid(issues)) => {
            return Ok(json_response(
                StatusCode::BAD_REQUEST,
                Value::object([
                    ("error", Value::String("Invalid request body".into())),
                    ("issues", Value::Array(issues)),
                ]),
            ));
        }
        Err(ValidationError::Operation) => anyhow::bail!("Provider credential validation failed."),
    };
    match repository
        .store_provider_account_credential(
            owner,
            provider,
            account,
            &input["credential"],
            &serde_json::from_str(input["metadata"].stringify().as_str())?,
            Some(
                input["expectedRevision"]
                    .as_f64()
                    .context("credential revision")?,
            ),
        )
        .await
    {
        Ok(Some(value)) => record(&value),
        Ok(None) => Ok(error(404, "Provider account not found.")),
        // The source route only handles revision conflicts. Identity conflicts
        // retain its ordinary sanitized server-error boundary.
        Err(failure) if failure.downcast_ref() == Some(&CredentialConflict::Revision) => {
            Ok(error(409, &failure.to_string()))
        }
        Err(failure) => Err(failure),
    }
}
async fn handle(
    State(service): State<Arc<AuthService>>,
    Extension(ctx): Extension<Arc<Context>>,
    Path(params): Path<HashMap<String, String>>,
    request: Request,
) -> Response {
    match execute(&service, &params, request).await {
        Ok(response) => response,
        Err(error) => middleware::failure(&service, &ctx.id, &error),
    }
}
pub(super) fn routes() -> Router<Arc<AuthService>> {
    Router::new().route(
        "/api/internal/workers/providers/{providerId}/accounts/{accountId}/credential",
        get(handle).put(handle),
    )
}
