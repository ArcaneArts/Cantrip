use super::{
    body, json_response,
    middleware::{self, Context},
};
use crate::{
    auth::{crypto, repository::AuditRecord, service::AuthService},
    config::AuthMode,
    encryption::{repository::EncryptionRepository, request::storage_input},
    wire::{self, ValidationError, Value},
};
use anyhow::{Context as _, Result};
use axum::{
    Extension, Router,
    extract::{Path, Request, State},
    http::{Method, StatusCode, header},
    response::Response,
    routing::{get, patch, post},
};
use serde_json::{Value as JsonValue, json};
use std::{collections::HashMap, sync::Arc};

fn response(status: u16, value: impl serde::Serialize) -> Response {
    json_response(StatusCode::from_u16(status).unwrap(), value)
}
fn error(status: u16, message: &str) -> Response {
    response(status, json!({"error":message}))
}
fn output(schema: &str, value: JsonValue) -> Result<Response> {
    let value = Value::from_serialize(&value);
    let validated = wire::parse(schema, Some(&value))
        .map_err(|_| anyhow::anyhow!("Stored encryption record violates its protocol contract."))?;
    let mut result = response(200, validated);
    result
        .headers_mut()
        .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    Ok(result)
}
async fn audit(
    service: &AuthService,
    ctx: &Context,
    action: &str,
    resource_type: &str,
    resource: Option<&str>,
    result: &str,
) {
    let owner = ctx.principal.user.as_ref().map(|u| u.id.as_str());
    if service
        .repository
        .audit(AuditRecord {
            action,
            result,
            owner,
            actor: owner,
            session: ctx.principal.session_id.as_deref(),
            resource_type,
            resource,
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
    service: &AuthService,
    ctx: &Context,
    path: &str,
    method: &Method,
    params: &HashMap<String, String>,
    body: Option<&Value>,
) -> Result<Response> {
    let owner = &ctx
        .principal
        .user
        .as_ref()
        .context("authenticated encryption owner")?
        .id;
    let repository = EncryptionRepository::new(service.repository.database.clone());
    if path == "/api/encryption/profile" {
        let profile = repository.get_profile(owner).await?;
        return output(
            "accountEncryptionProfileStateSchema",
            json!({"status":if profile.is_some(){"initialized"}else{"uninitialized"},"profile":profile}),
        );
    }
    let read = *method == Method::GET || *method == Method::HEAD;
    if path == "/api/encryption/principals" && read {
        return output(
            "encryptionPrincipalListSchema",
            json!(repository.list_principals(owner).await?),
        );
    }
    if params.contains_key("principalId") && read {
        let grants = repository
            .active_grants(owner, &params["principalId"])
            .await?;
        return match grants["status"].as_str() {
            Some("missing") => Ok(error(404, "Encryption principal not found.")),
            Some("unavailable") => Ok(error(
                409,
                "Encryption principal is not approved or was revoked.",
            )),
            _ => output("encryptionKeyGrantListSchema", grants["grants"].clone()),
        };
    }
    if path == "/api/account/password" && service.config.auth_mode != AuthMode::Accounts {
        return Ok(error(404, "Account passwords are unavailable."));
    }
    let schema = if path.ends_with("/profile/initialize") {
        "accountEncryptionProfileInitializeSchema"
    } else if path.ends_with("/profile/migration") {
        "encryptionProfileMigrationUpdateSchema"
    } else if path == "/api/account/password" {
        "accountPasswordEncryptionChangeSchema"
    } else if path == "/api/encryption/principals" {
        "encryptionPrincipalCreateSchema"
    } else if path.ends_with("/approve") {
        "encryptionPrincipalApprovalSchema"
    } else if path.ends_with("/revoke") {
        "encryptionRevocationSchema"
    } else {
        "encryptionKeyGrantCreateSchema"
    };
    let input = match wire::parse(schema, body) {
        Ok(value) => storage_input(value)?,
        Err(ValidationError::Invalid(issues)) => {
            return Ok(response(
                400,
                Value::object([
                    ("error", Value::String("Invalid request body".into())),
                    ("issues", Value::Array(issues)),
                ]),
            ));
        }
        Err(ValidationError::Operation) => anyhow::bail!("Request validation failed."),
    };
    if path.ends_with("/profile/initialize") {
        if service.config.auth_mode != AuthMode::None
            && input["profile"]["passwordWrappedMasterKey"].is_null()
        {
            return Ok(error(
                400,
                "Password-authenticated profiles require a password wrapper.",
            ));
        }
        let result = repository.initialize(owner, &input).await?;
        let status = if result["created"] == true { 201 } else { 409 };
        let mut response = output("accountEncryptionProfileInitializeResultSchema", result)?;
        *response.status_mut() = StatusCode::from_u16(status).unwrap();
        return Ok(response);
    }
    if path.ends_with("/profile/migration") {
        return match repository.update_migration(owner, &input).await? {
            Some(profile) => output("accountEncryptionProfileSchema", profile),
            None => Ok(error(
                409,
                "Encryption profile revision changed or was not found.",
            )),
        };
    }
    if path == "/api/account/password" {
        let user = ctx.principal.user.as_ref().unwrap();
        if service.config.admin_password.is_some()
            && user.email.as_ref().is_some_and(|email| {
                Some(crypto::normalize_email(email)) == service.normalized_admin
            })
        {
            return Ok(error(
                409,
                "This administrator password is managed by CANTRIP_ADMIN_PASSWORD.",
            ));
        }
        if let Some(retry) = service.limited("password-change", &ctx.ip, owner).await {
            let mut response = error(429, "Too many authentication attempts. Try again later.");
            response
                .headers_mut()
                .insert(header::RETRY_AFTER, retry.to_string().parse().unwrap());
            return Ok(response);
        }
        let credential = service.repository.credential(owner, true).await?;
        let verified = if let Some((_, hash)) = credential {
            service
                .passwords
                .verify(hash, input["currentPassword"].as_str().unwrap().into())
                .await
        } else {
            false
        };
        if !verified {
            audit(
                service,
                ctx,
                "auth.password-change-failed",
                "account",
                Some(owner),
                "denied",
            )
            .await;
            return Ok(error(403, "Current password is incorrect."));
        }
        let hash = service
            .passwords
            .hash(input["newPassword"].as_str().unwrap().into())
            .await?;
        return match repository.change_password(owner, &input, &hash).await? {
            Some(profile) => {
                audit(
                    service,
                    ctx,
                    "auth.password-changed",
                    "account",
                    Some(owner),
                    "succeeded",
                )
                .await;
                output("accountEncryptionProfileSchema", profile)
            }
            None => Ok(error(
                409,
                "Encryption profile revision changed or was not found.",
            )),
        };
    }
    if path == "/api/encryption/principals" {
        return match repository.create_principal(owner, &input, None).await? {
            Some(principal) => {
                let mut response = output("encryptionPrincipalSchema", principal)?;
                *response.status_mut() = StatusCode::CREATED;
                Ok(response)
            }
            None => Ok(error(
                409,
                "Encryption principal already exists or its worker is unavailable.",
            )),
        };
    }
    if let Some(id) = params.get("principalId") {
        if path.ends_with("/approve") || path.ends_with("/revoke") {
            let principal = if path.ends_with("/approve") {
                repository
                    .approve_principal(
                        owner,
                        id,
                        input["expectedRevision"].as_i64().unwrap() as i32,
                    )
                    .await?
            } else {
                repository.revoke_principal(owner, id, &input).await?
            };
            return match principal {
                Some(principal) => output("encryptionPrincipalSchema", principal),
                None => Ok(error(
                    409,
                    "Encryption principal revision or state changed.",
                )),
            };
        }
        let result = repository.create_grant(owner, id, &input).await?;
        return match result["status"].as_str() {
            Some("created") => {
                let mut response = output("encryptionKeyGrantSchema", result["grant"].clone())?;
                *response.status_mut() = StatusCode::CREATED;
                Ok(response)
            }
            Some("missing") => Ok(error(404, "Encryption principal not found.")),
            Some("wrapper-mismatch") => Ok(error(
                400,
                "Wrapped key does not match the target principal.",
            )),
            Some("unavailable") => Ok(error(
                409,
                "Encryption principal is not approved or was revoked.",
            )),
            _ => Ok(error(
                409,
                "A grant for this component revision already exists.",
            )),
        };
    }
    let id = params.get("grantId").context("grant route parameter")?;
    match repository.revoke_grant(owner, id, &input).await? {
        Some(grant) => output("encryptionKeyGrantSchema", grant),
        None => Ok(error(409, "Encryption grant revision or state changed.")),
    }
}
async fn handle(
    State(service): State<Arc<AuthService>>,
    Extension(ctx): Extension<Arc<Context>>,
    Path(params): Path<HashMap<String, String>>,
    request: Request,
) -> Response {
    let path = request.uri().path().to_owned();
    let method = request.method().clone();
    let body = if method == Method::GET || method == Method::HEAD {
        None
    } else {
        match body::parse_js(request, service.config.api_body_limit_bytes).await {
            Ok(value) => value,
            Err(response) => return response,
        }
    };
    match execute(&service, &ctx, &path, &method, &params, body.as_ref()).await {
        Ok(response) => response,
        Err(error) => middleware::failure(&service, &ctx.id, &error),
    }
}
pub(super) fn routes() -> Router<Arc<AuthService>> {
    Router::new()
        .route("/api/encryption/profile", get(handle))
        .route("/api/encryption/profile/initialize", post(handle))
        .route("/api/encryption/profile/migration", patch(handle))
        .route("/api/account/password", post(handle))
        .route("/api/encryption/principals", get(handle).post(handle))
        .route(
            "/api/encryption/principals/{principalId}/approve",
            post(handle),
        )
        .route(
            "/api/encryption/principals/{principalId}/revoke",
            post(handle),
        )
        .route(
            "/api/encryption/principals/{principalId}/grants",
            get(handle).post(handle),
        )
        .route("/api/encryption/grants/{grantId}/revoke", post(handle))
}
