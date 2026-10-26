use super::{
    body::parse_js as body,
    json_response,
    middleware::{self, Context, cookies, value},
};
use crate::{
    auth::{
        self, SessionState, crypto,
        repository::AuditRecord,
        service::{AuthService, Revocation},
        validation,
    },
    config::AuthMode,
    wire::{ValidationError, Value as WireValue},
};
use anyhow::Result;
use axum::{
    Extension, Router,
    extract::{Request, State},
    http::{StatusCode, header},
    response::Response,
    routing::{get, post},
};
use serde_json::{Value, json};
use std::sync::Arc;

fn response(code: u16, body: Value) -> Response {
    json_response(StatusCode::from_u16(code).unwrap(), body)
}
fn error(code: u16, message: &str) -> Response {
    response(code, json!({"error":message}))
}

async fn audit(
    service: &AuthService,
    ctx: &Context,
    action: &str,
    result: &str,
    owner: Option<Option<&str>>,
    actor: Option<&str>,
    resource: (&str, Option<&str>),
) {
    let principal = ctx.principal.user.as_ref().map(|u| u.id.as_str());
    if service
        .repository
        .audit(AuditRecord {
            action,
            result,
            owner: owner.unwrap_or(principal),
            actor: actor.or(principal),
            session: ctx.principal.session_id.as_deref(),
            resource_type: resource.0,
            resource: resource.1,
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
async fn limited(
    service: &AuthService,
    ctx: &Context,
    scope: &str,
    identity: &str,
) -> Option<Response> {
    service
        .limited(scope, &ctx.ip, identity)
        .await
        .map(|retry| {
            let mut response = error(429, "Too many authentication attempts. Try again later.");
            response
                .headers_mut()
                .insert(header::RETRY_AFTER, retry.to_string().parse().unwrap());
            response
        })
}
async fn signed_in(
    service: &AuthService,
    user: auth::UserSummary,
    method: &str,
    status: u16,
) -> Result<Response> {
    let (body, values) = service.create_session(user, method).await?;
    let mut response = response(status, body);
    cookies(&mut response, values);
    Ok(response)
}

fn version_value() -> Result<Value> {
    let value: Value =
        serde_json::from_slice(include_bytes!(concat!(env!("OUT_DIR"), "/version.json")))?;
    let major = value["major"].as_u64().expect("validated build version");
    let minor = value["minor"].as_u64().expect("validated build version");
    let patch = value["patch"].as_u64().expect("validated build version");
    // Match cantripVersionSchema, including stripping build-only fields and
    // its existing rejection of synthetic versions with a suffix.
    anyhow::ensure!(
        value["version"] == format!("{major}.{minor}.{patch}"),
        "Version string does not match its numeric components."
    );
    Ok(json!({"major":major,"minor":minor,"patch":patch,"version":value["version"]}))
}
async fn version(Extension(ctx): Extension<Arc<Context>>) -> Response {
    let mut response = match version_value() {
        Ok(value) => response(200, value),
        Err(_) => middleware::internal_error(&ctx.id),
    };
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        "public, max-age=300".parse().unwrap(),
    );
    response
}
async fn bootstrap(
    State(service): State<Arc<AuthService>>,
    Extension(ctx): Extension<Arc<Context>>,
) -> Response {
    let config = &service.config;
    let Ok(version) = version_value() else {
        return middleware::internal_error(&ctx.id);
    };
    let account_mode = config.auth_mode == AuthMode::Accounts;
    let body = json!({"protocolVersion":1,"server":{"id":service.server_id,"version":version,"deploymentMode":config.deployment_mode,"bootstrapMode":config.bootstrap_mode},"auth":{"mode":config.auth_mode,"state":if ctx.principal.authenticated(){"authenticated"}else{"authentication-required"},"currentUser":ctx.principal.user,"registration":{"enabled":account_mode,"bootstrapRequired":false,"licenseRequired":config.license_whitelist_enabled}},"routing":{"workerConnection":"server-only","directWorkerConnections":false},"storage":{"conversations":"server","files":"worker"},"agent":{"model":config.agent_model,"modelProvider":config.agent_model_provider},"capabilities":{"accounts":account_mode,"passwordProtection":config.auth_mode==AuthMode::Password,"linkCodes":true,"multipleWorkers":true,"projectReplicas":true,"replicaProvisioning":true,"browserFleetDiscovery":true,"crossWorkerExecutionTargets":true,"remoteDesktopFleet":true,"workerSwitching":true,"gitSync":true,"worktrees":true,"standaloneChat":{"available":true,"protocolVersion":1,"reason":null},"remoteSurfaces":{"enabled":true,"transports":["websocket","webrtc"],"relayOnly":config.remote_surface_web_rtc.ice_transport_policy=="relay"}}});
    // Environment configuration always supplies licenseWhitelistEnabled, so
    // Node's licenseWhitelistConfigured flag is true even when it is false.
    response(200, body)
}

async fn execute(
    service: &AuthService,
    ctx: &Context,
    path: &str,
    headers: &axum::http::HeaderMap,
    body: Option<&WireValue>,
) -> Result<Response> {
    let mode = service.config.auth_mode;
    if path == "/api/auth/session" {
        let state = service
            .resolve(value(headers, "cookie").as_deref())
            .await?
            .map(|r| r.state())
            .unwrap_or(SessionState {
                current_user: None,
                csrf_token: None,
                expires_at: None,
            });
        return Ok(response(200, serde_json::to_value(state)?));
    }
    if mode == AuthMode::None {
        let message = match path {
            "/api/auth/register" => Some("Registration is unavailable."),
            "/api/auth/login" => Some("Sign-in is unavailable."),
            "/api/auth/reauthenticate" => Some("Reauthentication is unavailable."),
            "/api/auth/mobile-sign-in/grants" | "/api/auth/mobile-sign-in/exchange" => {
                Some("Mobile sign-in is unavailable.")
            }
            _ => None,
        };
        if let Some(message) = message {
            return Ok(error(404, message));
        }
    }
    if path == "/api/auth/register" && mode != AuthMode::Accounts {
        return Ok(error(404, "Registration is unavailable."));
    }
    let kind = match path {
        "/api/auth/register" => Some("register"),
        "/api/auth/login" => Some("login"),
        "/api/auth/reauthenticate" => Some("reauthenticate"),
        "/api/auth/mobile-sign-in/exchange" => Some("exchange"),
        _ => None,
    };
    let input = if let Some(kind) = kind {
        match validation::validate(kind, body) {
            Ok(value) => value,
            Err(ValidationError::Invalid(issues)) => {
                return Ok(json_response(
                    StatusCode::BAD_REQUEST,
                    WireValue::object([
                        ("error", WireValue::String("Invalid request body".into())),
                        ("issues", WireValue::Array(issues)),
                    ]),
                ));
            }
            Err(ValidationError::Operation) => anyhow::bail!("Request validation failed."),
        }
    } else {
        WireValue::Null
    };
    match path {
        "/api/auth/register" => {
            let email = input["email"].as_str().unwrap();
            let normalized = crypto::normalize_email(email);
            if let Some(response) = limited(service, ctx, "register", &normalized).await {
                audit(
                    service,
                    ctx,
                    "auth.registration-rate-limited",
                    "denied",
                    Some(None),
                    None,
                    ("account", None),
                )
                .await;
                return Ok(response);
            }
            let _registration = service.registration.lock().await;
            let first = service.repository.count_accounts().await? == 0;
            let admin = service.normalized_admin.as_deref() == Some(&normalized);
            let denied = if service.config.license_whitelist_enabled && first && !admin {
                Some("The configured administrator must create the first account on this server.")
            } else if service.config.license_whitelist_enabled
                && !admin
                && !service.repository.whitelisted(&normalized).await?
            {
                Some("This email is not licensed to create an account on this server.")
            } else {
                None
            };
            if let Some(message) = denied {
                audit(
                    service,
                    ctx,
                    "auth.registration-denied",
                    "denied",
                    Some(None),
                    None,
                    ("account", None),
                )
                .await;
                return Ok(error(403, message));
            }
            let created = async {
                let hash = service
                    .passwords
                    .hash(
                        input["password"]
                            .as_js_string()
                            .unwrap()
                            .lossy()
                            .into_owned(),
                    )
                    .await?;
                let role = if first {
                    "owner"
                } else if admin {
                    "admin"
                } else {
                    "member"
                };
                let user = service
                    .repository
                    .create_account(
                        &input["displayName"].as_js_string().unwrap().lossy(),
                        crate::text::trim(email),
                        &normalized,
                        &hash,
                        role,
                    )
                    .await?;
                service.repository.settings(&user.id).await?;
                audit(
                    service,
                    ctx,
                    "auth.registration-succeeded",
                    "succeeded",
                    Some(Some(&user.id)),
                    Some(&user.id),
                    ("account", Some(&user.id)),
                )
                .await;
                signed_in(service, user, "account-password", 201).await
            }
            .await;
            Ok(match created {
                Ok(response) => response,
                Err(_) => {
                    audit(
                        service,
                        ctx,
                        "auth.registration-failed",
                        "failed",
                        Some(None),
                        None,
                        ("account", None),
                    )
                    .await;
                    error(409, "Account could not be created.")
                }
            })
        }
        "/api/auth/login" => {
            let identity = input
                .get("email")
                .and_then(WireValue::as_str)
                .map(crypto::normalize_email)
                .unwrap_or("single-user".into());
            if let Some(response) = limited(service, ctx, "login", &identity).await {
                audit(
                    service,
                    ctx,
                    "auth.login-rate-limited",
                    "denied",
                    Some(None),
                    None,
                    ("session", None),
                )
                .await;
                return Ok(response);
            }
            let credential = if mode == AuthMode::Accounts {
                if input.get("email").is_some() {
                    service.repository.credential(&identity, false).await?
                } else {
                    None
                }
            } else {
                service.local_user.clone().map(|u| {
                    (
                        u,
                        service
                            .config
                            .password_hash
                            .clone()
                            .unwrap_or(crypto::DUMMY_PASSWORD_HASH.into()),
                    )
                })
            };
            let hash = credential
                .as_ref()
                .map_or(crypto::DUMMY_PASSWORD_HASH, |(_, hash)| hash.as_str());
            let valid = service
                .passwords
                .verify(
                    hash.into(),
                    input["password"]
                        .as_js_string()
                        .unwrap()
                        .lossy()
                        .into_owned(),
                )
                .await;
            if !valid || credential.is_none() {
                audit(
                    service,
                    ctx,
                    "auth.login-failed",
                    "denied",
                    Some(credential.as_ref().map(|(u, _)| u.id.as_str())),
                    None,
                    ("session", None),
                )
                .await;
                return Ok(error(401, "Email or password is incorrect."));
            }
            let (user, _) = credential.unwrap();
            service.repository.settings(&user.id).await?;
            audit(
                service,
                ctx,
                "auth.login-succeeded",
                "succeeded",
                Some(Some(&user.id)),
                Some(&user.id),
                ("session", Some(&user.id)),
            )
            .await;
            signed_in(
                service,
                user,
                if mode == AuthMode::Accounts {
                    "account-password"
                } else {
                    "password"
                },
                200,
            )
            .await
        }
        "/api/auth/reauthenticate" => {
            let user = ctx.principal.user.as_ref().expect("authentication guard");
            if let Some(response) = limited(service, ctx, "reauthenticate", &user.id).await {
                return Ok(response);
            }
            let credential = if mode == AuthMode::Accounts {
                service.repository.credential(&user.id, true).await?
            } else {
                None
            };
            let hash = if mode == AuthMode::Accounts {
                credential
                    .as_ref()
                    .map_or(crypto::DUMMY_PASSWORD_HASH, |(_, h)| h)
            } else {
                service
                    .config
                    .password_hash
                    .as_deref()
                    .unwrap_or(crypto::DUMMY_PASSWORD_HASH)
            };
            if !service
                .passwords
                .verify(
                    hash.into(),
                    input["password"]
                        .as_js_string()
                        .unwrap()
                        .lossy()
                        .into_owned(),
                )
                .await
            {
                audit(
                    service,
                    ctx,
                    "auth.reauthentication-failed",
                    "denied",
                    Some(Some(&user.id)),
                    None,
                    ("account", Some(&user.id)),
                )
                .await;
                return Ok(error(403, "Password is incorrect."));
            }
            audit(
                service,
                ctx,
                "auth.reauthentication-succeeded",
                "succeeded",
                Some(Some(&user.id)),
                Some(&user.id),
                ("account", Some(&user.id)),
            )
            .await;
            Ok(response(200, json!({"verified":true})))
        }
        "/api/auth/mobile-sign-in/grants" => {
            let user = ctx.principal.user.as_ref().expect("authentication guard");
            let Some(session) = &ctx.principal.session_id else {
                return Ok(error(401, "Authentication is required."));
            };
            let generated = crypto::mobile_code()?;
            let expires = auth::now() + chrono::Duration::minutes(2);
            let id = service
                .repository
                .mobile_grant(&user.id, session, &generated.code_hash, expires)
                .await?;
            let repository = service.repository.clone();
            tokio::spawn(async move {
                let _ = repository.prune_mobile().await;
            });
            audit(
                service,
                ctx,
                "auth.mobile-sign-in-grant-created",
                "succeeded",
                Some(Some(&user.id)),
                None,
                ("session-grant", Some(&id)),
            )
            .await;
            Ok(response(
                201,
                json!({"code":generated.code,"expiresAt":auth::iso(expires)}),
            ))
        }
        "/api/auth/mobile-sign-in/exchange" => {
            if let Some(response) = limited(service, ctx, "mobile-qr", "exchange").await {
                return Ok(response);
            }
            let user = service
                .repository
                .consume_mobile_grant(&crypto::hash_secret(input["code"].as_str().unwrap()))
                .await?;
            let Some(user) = user else {
                audit(
                    service,
                    ctx,
                    "auth.mobile-sign-in-failed",
                    "denied",
                    Some(None),
                    None,
                    ("session-grant", None),
                )
                .await;
                return Ok(error(
                    401,
                    "This mobile sign-in code is invalid, expired, or already used.",
                ));
            };
            service.repository.settings(&user.id).await?;
            audit(
                service,
                ctx,
                "auth.mobile-sign-in-succeeded",
                "succeeded",
                Some(Some(&user.id)),
                Some(&user.id),
                ("session", Some(&user.id)),
            )
            .await;
            signed_in(service, user, "mobile-qr", 200).await
        }
        "/api/auth/logout" | "/api/auth/logout-all" => {
            let user = ctx.principal.user.as_ref().expect("authentication guard");
            let all = path.ends_with("logout-all");
            let count = if all {
                service.revoke(&user.id, true, "signed-out-all").await?
            } else if let Some(id) = &ctx.principal.session_id {
                service.revoke(id, false, "signed-out").await?
            } else {
                service.revoke_connections(Revocation::Session(None));
                0
            };
            audit(
                service,
                ctx,
                if all {
                    "auth.all-sessions-revoked"
                } else {
                    "auth.session-revoked"
                },
                "succeeded",
                None,
                None,
                (
                    if all { "account" } else { "session" },
                    if all {
                        Some(user.id.as_str())
                    } else {
                        ctx.principal.session_id.as_deref()
                    },
                ),
            )
            .await;
            let mut response = if all {
                response(200, json!({"revokedSessions":count}))
            } else {
                let mut response = Response::new(axum::body::Body::empty());
                *response.status_mut() = StatusCode::NO_CONTENT;
                response
            };
            cookies(&mut response, service.cookies.clear());
            eprintln!(
                "{}",
                json!({"event":if all {"security.sessions.revoked"}else{"security.session.revoked"},"subsystem":"security","operation":if all {"logout-all"}else{"logout"},"status":"completed","requestId":ctx.id,"sessionId":ctx.principal.session_id,"counts":{"sessions":count}})
            );
            Ok(response)
        }
        _ => unreachable!("registered authentication route"),
    }
}

async fn handle(
    State(service): State<Arc<AuthService>>,
    Extension(ctx): Extension<Arc<Context>>,
    request: Request,
) -> Response {
    let path = request.uri().path().to_owned();
    let headers = request.headers().clone();
    let method = request.method().clone();
    let body = if method == axum::http::Method::GET || method == axum::http::Method::HEAD {
        None
    } else {
        match body(request, service.config.api_body_limit_bytes).await {
            Ok(value) => value,
            Err(response) => return response,
        }
    };
    match execute(&service, &ctx, &path, &headers, body.as_ref()).await {
        Ok(response) => response,
        Err(error) => middleware::failure(&service, &ctx.id, &error),
    }
}

pub(super) fn routes() -> Router<Arc<AuthService>> {
    Router::new()
        .route("/version", get(version))
        .route("/api/bootstrap", get(bootstrap))
        .route("/api/auth/session", get(handle))
        .route("/api/auth/register", post(handle))
        .route("/api/auth/login", post(handle))
        .route("/api/auth/reauthenticate", post(handle))
        .route("/api/auth/mobile-sign-in/grants", post(handle))
        .route("/api/auth/mobile-sign-in/exchange", post(handle))
        .route("/api/auth/logout", post(handle))
        .route("/api/auth/logout-all", post(handle))
}
