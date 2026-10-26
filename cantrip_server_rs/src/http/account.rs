use super::{
    body, json_response,
    middleware::{self, Context},
};
use crate::{
    auth::{UserRole, crypto, service::AuthService},
    wire::{self, ValidationError, Value},
};
use anyhow::{Context as _, Result};
use axum::{
    Extension, Router,
    extract::{Path, Request, State},
    http::{Method, StatusCode, header},
    response::Response,
    routing::get,
};
use serde_json::{Value as JsonValue, json};
use std::{collections::HashMap, sync::Arc};

fn error(status: u16, message: &str) -> Response {
    json_response(
        StatusCode::from_u16(status).unwrap(),
        json!({"error":message}),
    )
}
fn output(schema: &str, value: JsonValue) -> Result<Response> {
    let parsed = wire::parse(schema, Some(&Value::from_serialize(&value)))
        .map_err(|_| anyhow::anyhow!("Stored account record violates its protocol contract."))?;
    Ok(json_response(StatusCode::OK, parsed))
}
fn input(schema: &str, value: Option<&Value>) -> Result<Result<Value, Response>> {
    match wire::parse(schema, value) {
        Ok(value) => Ok(Ok(value)),
        Err(ValidationError::Invalid(issues)) => Ok(Err(json_response(
            StatusCode::BAD_REQUEST,
            Value::object([
                ("error", Value::String("Invalid request body".into())),
                ("issues", Value::Array(issues)),
            ]),
        ))),
        Err(ValidationError::Operation) => anyhow::bail!("Request validation failed."),
    }
}
// find-my-way's query parser accumulates duplicate names in arrays. Axum's
// ordinary Query extractor rejects those before the protocol can coerce them.
pub(super) fn query(uri: &axum::http::Uri) -> Value {
    let mut pairs = crate::wire::value::Object::new();
    for (key, value) in url::form_urlencoded::parse(uri.query().unwrap_or("").as_bytes()) {
        let key = key.into_owned();
        let value = Value::String(value.into_owned().into());
        if let Some(previous) = pairs.get_mut(key.as_str()) {
            if let Value::Array(values) = previous {
                values.push(value)
            } else {
                *previous = Value::Array(vec![previous.clone(), value]);
            }
        } else {
            pairs.insert(key.into(), value);
        }
    }
    Value::Object(pairs)
}
async fn execute(
    service: &AuthService,
    ctx: &Context,
    params: &HashMap<String, String>,
    request: Request,
) -> Result<Response> {
    let path = request.uri().path().to_owned();
    let method = request.method().clone();
    let user = ctx
        .principal
        .user
        .as_ref()
        .context("authenticated account owner")?;
    let repository = &service.repository;
    if path == "/api/account/sessions" {
        let mut sessions = repository
            .list_sessions(&user.id, ctx.principal.session_id.as_deref())
            .await?;
        for session in &mut sessions {
            if session["id"]
                .as_str()
                .is_some_and(|id| service.live.sessions.connected(id))
            {
                session["connected"] = json!(true);
            }
        }
        return output("accountSessionListSchema", json!(sessions));
    }
    if path.starts_with("/api/admin/") && !matches!(user.role, UserRole::Owner | UserRole::Admin) {
        return Ok(error(403, "Administrator access is required."));
    }
    if path.ends_with("/audit-events") {
        let parsed = match input("auditEventQuerySchema", Some(&query(request.uri())))? {
            Ok(value) => value,
            Err(response) => return Ok(response),
        };
        return output(
            "auditEventListSchema",
            repository
                .list_audit(
                    if path.starts_with("/api/admin/") {
                        None
                    } else {
                        Some(&user.id)
                    },
                    parsed.get("before").and_then(Value::as_i64),
                    parsed["limit"].as_i64().unwrap(),
                )
                .await?,
        );
    }
    if path == "/api/admin/accounts" {
        let mut response = output(
            "accountAdminSummarySchema",
            json!({"userCount":repository.count_accounts().await?,"licenseWhitelist":{"enabled":service.config.license_whitelist_enabled,"adminEmail":service.config.admin_email,"entries":repository.list_whitelist().await?}}),
        )?;
        response
            .headers_mut()
            .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
        return Ok(response);
    }
    if method == Method::DELETE {
        return Ok(
            if repository
                .delete_whitelist(params.get("entryId").context("whitelist entry parameter")?)
                .await?
            {
                StatusCode::NO_CONTENT.into_response()
            } else {
                error(404, "Whitelist entry not found.")
            },
        );
    }
    let body = match body::parse_js(request, service.config.api_body_limit_bytes).await {
        Ok(body) => body,
        Err(response) => return Ok(response),
    };
    let parsed = match input("accountLicenseWhitelistCreateSchema", body.as_ref())? {
        Ok(value) => value,
        Err(response) => return Ok(response),
    };
    let email = parsed["email"].as_str().context("validated email")?;
    let normalized = crypto::normalize_email(email);
    if Some(&normalized) == service.normalized_admin.as_ref() {
        return Ok(error(
            409,
            "The configured administrator is licensed automatically.",
        ));
    }
    match repository
        .create_whitelist(&user.id, email, &normalized)
        .await?
    {
        Some(entry) => {
            let mut response = output("accountLicenseWhitelistEntrySchema", entry)?;
            *response.status_mut() = StatusCode::CREATED;
            Ok(response)
        }
        None => Ok(error(409, "That email is already whitelisted.")),
    }
}
use axum::response::IntoResponse;
async fn handle(
    State(service): State<Arc<AuthService>>,
    Extension(ctx): Extension<Arc<Context>>,
    Path(params): Path<HashMap<String, String>>,
    request: Request,
) -> Response {
    match execute(&service, &ctx, &params, request).await {
        Ok(response) => response,
        Err(error) => middleware::failure(&service, &ctx.id, &error),
    }
}
pub(super) fn routes() -> Router<Arc<AuthService>> {
    Router::new()
        .route("/api/account/sessions", get(handle))
        .route("/api/account/audit-events", get(handle))
        .route("/api/admin/audit-events", get(handle))
        .route("/api/admin/accounts", get(handle))
        .route("/api/admin/license-whitelist", axum::routing::post(handle))
        .route(
            "/api/admin/license-whitelist/{entryId}",
            axum::routing::delete(handle),
        )
}
