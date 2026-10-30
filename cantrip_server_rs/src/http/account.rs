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
    query_string(uri.query().unwrap_or(""))
}
fn query_component(raw: &str) -> String {
    let value = raw.replace('+', " ");
    let bytes = value.as_bytes();
    let mut position = 0;
    while position < bytes.len() {
        if bytes[position] == b'%' {
            if position + 2 >= bytes.len()
                || !bytes[position + 1].is_ascii_hexdigit()
                || !bytes[position + 2].is_ascii_hexdigit()
            {
                return value;
            }
            position += 3;
        } else {
            position += 1;
        }
    }
    // fast-querystring falls back to the entire plus-normalized component
    // when any escaped sequence is malformed; lossy UTF-8 changes issue keys.
    let decoded = percent_encoding::percent_decode_str(&value)
        .decode_utf8()
        .map(|v| v.into_owned());
    decoded.unwrap_or(value)
}
fn query_string(raw: &str) -> Value {
    let mut pairs = crate::wire::value::Object::new();
    for part in raw.split('&').filter(|part| !part.is_empty()) {
        let (key, value) = part.split_once('=').unwrap_or((part, ""));
        let key = query_component(key);
        let value = Value::String(query_component(value).into());
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

#[cfg(test)]
mod query_tests {
    use super::*;
    use std::{
        io::{BufRead, BufReader},
        path::PathBuf,
        process::{Child, Command, Stdio},
    };
    struct Oracle(Option<Child>);
    impl Drop for Oracle {
        fn drop(&mut self) {
            if let Some(child) = self.0.as_mut() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
    #[test]
    fn query_parser_matches_actual_fastify_duplicates_percent_escapes_and_utf8() -> Result<()> {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .to_owned();
        let mut oracle = Oracle(Some(
            Command::new("node")
                .arg("scripts/server-rust/querystring-oracle.mjs")
                .current_dir(root)
                .stdout(Stdio::piped())
                .stderr(Stdio::inherit())
                .spawn()?,
        ));
        let stdout = oracle
            .0
            .as_mut()
            .unwrap()
            .stdout
            .take()
            .context("query oracle stdout")?;
        let mut count = 0;
        let mut receipt = None;
        for line in BufReader::new(stdout).lines() {
            let case: serde_json::Value = serde_json::from_str(&line?)?;
            if let Some(done) = case.get("done") {
                anyhow::ensure!(receipt.is_none(), "duplicate query receipt");
                receipt = Some(done.as_u64().context("query count")?);
                continue;
            }
            anyhow::ensure!(receipt.is_none(), "query case after completion");
            let input = case["input"].as_str().context("query input")?;
            assert_eq!(
                query_string(input).stringify(),
                case["output"].as_str().unwrap(),
                "query {input:?}"
            );
            count += 1;
        }
        let status = oracle.0.as_mut().unwrap().wait()?;
        oracle.0 = None;
        anyhow::ensure!(
            status.success() && count > 0 && receipt == Some(count),
            "incomplete query oracle: {status}, count {count}, receipt {receipt:?}"
        );
        println!("{count} actual Fastify query strings matched");
        Ok(())
    }
}
