//! OAuth authority for the separately deployed public MCP bridge.
mod consent;
mod repository;

use super::{
    AuthService, HeaderMap, IntoResponse, Json, Response, Router, State, StatusCode, header,
};
use crate::auth::crypto::{authentication_secret as secret, hash_secret, safe_secret_match};
use anyhow::Result;
use axum::{
    Form,
    extract::DefaultBodyLimit,
    routing::{get, post},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use cantrip_protocol::external_mcp::{
    OAUTH_AUTHORIZE_PATH, OAUTH_EXCHANGE_PATH, OAUTH_METADATA_PATH, OAUTH_REGISTER_PATH,
    OAUTH_SCOPE, OAUTH_TOKEN_PATH, opaque_secret,
};
use repository::{ACCESS, BRIDGE, CODE, REFRESH, Repository};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::sync::Arc;
use url::Url;

pub(super) fn routes() -> Router<Arc<AuthService>> {
    Router::new()
        .route(OAUTH_METADATA_PATH, get(metadata))
        .route(OAUTH_REGISTER_PATH, post(register))
        .route(
            OAUTH_AUTHORIZE_PATH,
            get(consent::start).post(consent::finish),
        )
        .route(OAUTH_TOKEN_PATH, post(token))
        .route(OAUTH_EXCHANGE_PATH, post(exchange))
        .layer(DefaultBodyLimit::max(16 * 1024))
}

pub(super) async fn authenticate_bridge(
    service: &AuthService,
    credential: &str,
) -> Result<Option<crate::auth::external_mcp::IntegrationPrincipal>> {
    if !opaque_secret(credential, BRIDGE) {
        return Ok(None);
    }
    repository::bridge_principal(service, credential).await
}

fn reply(status: StatusCode, value: Value) -> Response {
    let mut response = (status, Json(value)).into_response();
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static("no-store"),
    );
    response
        .headers_mut()
        .insert(header::PRAGMA, header::HeaderValue::from_static("no-cache"));
    response
}

fn invalid(error: &'static str) -> Response {
    reply(StatusCode::BAD_REQUEST, json!({"error":error}))
}

fn missing() -> Response {
    StatusCode::NOT_FOUND.into_response()
}

fn unavailable() -> Response {
    reply(
        StatusCode::SERVICE_UNAVAILABLE,
        json!({"error":"temporarily_unavailable"}),
    )
}

async fn metadata(State(service): State<Arc<AuthService>>) -> Response {
    let Some(config) = &service.config.external_mcp_oauth else {
        return missing();
    };
    reply(
        StatusCode::OK,
        json!({
            "issuer":config.issuer,
            "authorization_endpoint":format!("{}{OAUTH_AUTHORIZE_PATH}",config.issuer),
            "token_endpoint":format!("{}{OAUTH_TOKEN_PATH}",config.issuer),
            "registration_endpoint":format!("{}{OAUTH_REGISTER_PATH}",config.issuer),
            "response_types_supported":["code"],
            "grant_types_supported":["authorization_code","refresh_token"],
            "token_endpoint_auth_methods_supported":["none"],
            "code_challenge_methods_supported":["S256"],
            "authorization_response_iss_parameter_supported":true,
            "scopes_supported":[OAUTH_SCOPE],
        }),
    )
}

#[derive(Deserialize)]
struct Registration {
    client_name: Option<String>,
    redirect_uris: Vec<String>,
    token_endpoint_auth_method: Option<String>,
}

async fn register(
    State(service): State<Arc<AuthService>>,
    Json(input): Json<Registration>,
) -> Response {
    if service.config.external_mcp_oauth.is_none() {
        return missing();
    }
    let name = input.client_name.as_deref().unwrap_or("MCP client").trim();
    if name.is_empty()
        || name.len() > 120
        || name.chars().any(char::is_control)
        || !(1..=8).contains(&input.redirect_uris.len())
        || !input
            .redirect_uris
            .iter()
            .all(|value| redirect(value).is_some())
        || input
            .token_endpoint_auth_method
            .as_deref()
            .is_some_and(|method| method != "none")
    {
        return invalid("invalid_client_metadata");
    }
    let database = Repository(service.repository.database.clone());
    match database.register(name, &input.redirect_uris).await {
        Ok(client) => reply(
            StatusCode::CREATED,
            json!({
                "client_id":client,"client_name":name,"redirect_uris":input.redirect_uris,
                "token_endpoint_auth_method":"none","grant_types":["authorization_code","refresh_token"],
                "response_types":["code"],"scope":OAUTH_SCOPE,
            }),
        ),
        Err(_) => unavailable(),
    }
}

fn redirect(value: &str) -> Option<Url> {
    if value.len() > 2048 {
        return None;
    }
    let url = Url::parse(value).ok()?;
    let scheme = url.scheme();
    let host = url.host_str()?;
    let local = matches!(host, "localhost" | "127.0.0.1" | "[::1]");
    ((scheme == "https" || (scheme == "http" && local))
        && url.username().is_empty()
        && url.password().is_none()
        && !url.query_pairs().any(|(name, _)| {
            matches!(
                name.as_ref(),
                "code" | "error" | "error_description" | "state" | "iss"
            )
        })
        && url.fragment().is_none())
    .then_some(url)
}

#[derive(Deserialize, serde::Serialize)]
struct Authorize {
    response_type: String,
    client_id: String,
    redirect_uri: String,
    code_challenge: String,
    code_challenge_method: String,
    state: Option<String>,
    resource: String,
    scope: Option<String>,
}

struct ResourceOwner {
    owner: String,
    session: String,
}

#[derive(Deserialize)]
struct TokenRequest {
    grant_type: String,
    client_id: String,
    code: Option<String>,
    code_verifier: Option<String>,
    redirect_uri: Option<String>,
    refresh_token: Option<String>,
    resource: Option<String>,
}

async fn token(
    State(service): State<Arc<AuthService>>,
    Form(request): Form<TokenRequest>,
) -> Response {
    let Some(config) = &service.config.external_mcp_oauth else {
        return missing();
    };
    if request
        .resource
        .as_deref()
        .is_some_and(|resource| resource != config.resource)
    {
        return invalid("invalid_target");
    }
    let database = Repository(service.repository.database.clone());
    let resource = config.resource.clone();
    let issued = match request.grant_type.as_str() {
        "authorization_code" => {
            let (Some(code), Some(verifier), Some(redirect)) =
                (request.code, request.code_verifier, request.redirect_uri)
            else {
                return invalid("invalid_request");
            };
            if !opaque_secret(&code, CODE) || !valid_verifier(&verifier) {
                return invalid("invalid_grant");
            }
            let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
            database
                .redeem(request.client_id, code, challenge, redirect, resource)
                .await
        }
        "refresh_token" => {
            let Some(refresh) = request
                .refresh_token
                .filter(|refresh| opaque_secret(refresh, REFRESH))
            else {
                return invalid("invalid_grant");
            };
            database.refresh(request.client_id, refresh, resource).await
        }
        _ => return invalid("unsupported_grant_type"),
    };
    match issued {
        Ok(Some(tokens)) => reply(StatusCode::OK, json!(tokens)),
        Ok(None) => invalid("invalid_grant"),
        Err(_) => unavailable(),
    }
}

fn valid_verifier(value: &str) -> bool {
    (43..=128).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~'))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Exchange {
    access_token: String,
    resource: String,
}

async fn exchange(
    State(service): State<Arc<AuthService>>,
    headers: HeaderMap,
    Json(input): Json<Exchange>,
) -> Response {
    let Some(config) = &service.config.external_mcp_oauth else {
        return missing();
    };
    let mut values = headers.get_all(header::AUTHORIZATION).iter();
    let can_exchange = values
        .next()
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .filter(|value| opaque_secret(value, "ctbk_"))
        .is_some_and(|key| safe_secret_match(&hash_secret(key), &config.bridge_key_hash))
        && values.next().is_none();
    if !can_exchange
        || input.resource != config.resource
        || !opaque_secret(&input.access_token, ACCESS)
    {
        return reply(StatusCode::UNAUTHORIZED, json!({"error":"invalid_token"}));
    }
    let database = Repository(service.repository.database.clone());
    match database.exchange(input.access_token, input.resource).await {
        Ok(Some(credential)) => reply(
            StatusCode::OK,
            json!({"credential":credential,"resource":config.resource,"issuer":config.issuer}),
        ),
        Ok(None) => reply(StatusCode::UNAUTHORIZED, json!({"error":"invalid_token"})),
        Err(_) => unavailable(),
    }
}
