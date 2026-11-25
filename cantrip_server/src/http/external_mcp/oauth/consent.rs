use super::{Authorize, Repository, ResourceOwner, invalid, missing, redirect, unavailable};
use crate::{
    auth::{now, service::AuthService},
    http::middleware::Context,
};
use axum::{
    Extension, Form,
    extract::{Query, State},
    http::{StatusCode, header},
    response::{Html, IntoResponse, Response},
};
use cantrip_protocol::external_mcp::{OAUTH_AUTHORIZE_PATH, OAUTH_SCOPE, opaque_secret};
use serde::Deserialize;
use std::sync::Arc;

fn browser(context: &Context) -> Option<ResourceOwner> {
    Some(ResourceOwner {
        owner: context.principal.user.as_ref()?.id.clone(),
        session: context.principal.session_id.clone()?,
    })
}

pub(super) async fn start(
    State(service): State<Arc<AuthService>>,
    Extension(context): Extension<Arc<Context>>,
    Query(request): Query<Authorize>,
) -> Response {
    let Some(config) = &service.config.external_mcp_oauth else {
        return missing();
    };
    if request.resource != config.resource {
        return invalid("invalid_target");
    }
    let Some(callback) = redirect(&request.redirect_uri) else {
        return invalid("invalid_request");
    };
    if request.response_type != "code"
        || request.code_challenge_method != "S256"
        || !opaque_secret(&request.code_challenge, "")
        || request
            .state
            .as_ref()
            .is_some_and(|state| state.len() > 512)
        || request.scope.as_ref().is_some_and(|scope| {
            !scope
                .split_ascii_whitespace()
                .all(|value| value == OAUTH_SCOPE)
        })
    {
        return invalid("invalid_request");
    }
    let repository = Repository(service.repository.database.clone());
    let name = match repository
        .client(&request.client_id, &request.redirect_uri)
        .await
    {
        Ok(Some(name)) => name,
        Ok(None) => return invalid("invalid_client"),
        Err(_) => return unavailable(),
    };
    let Some(browser) = browser(&context) else {
        let application = service
            .config
            .app_origins
            .iter()
            .find(|origin| origin.starts_with("https://"))
            .unwrap_or(&config.issuer);
        return page(
            StatusCode::UNAUTHORIZED,
            format!(
                r#"<p><a href="{}/" target="_blank" rel="noopener noreferrer">Sign in to Cantrip</a>, then reload this page to continue.</p>"#,
                escape(application),
            ),
            None,
        );
    };
    let integrations = match service
        .repository
        .list_mcp_integrations(&browser.owner)
        .await
    {
        Ok(integrations) => integrations,
        Err(_) => return unavailable(),
    };
    let options: String = integrations
        .iter()
        .filter(|integration| integration.revoked_at.is_none() && integration.expires_at > now())
        .map(|integration| {
            format!(
                r#"<option value="{}">{}</option>"#,
                escape(&integration.id),
                escape(&integration.label)
            )
        })
        .collect();
    if options.is_empty() {
        return page(
            StatusCode::FORBIDDEN,
            "<p>Create a scoped external MCP integration in Cantrip, then reload this page.</p>"
                .to_owned(),
            None,
        );
    }
    let consent = match repository.begin(&browser, &request).await {
        Ok(consent) => consent,
        Err(_) => return unavailable(),
    };
    let name = escape(&name);
    let destination = escape(&request.redirect_uri);
    page(
        StatusCode::OK,
        format!(
            r#"
<p><strong>{name}</strong> is requesting access to Cantrip.</p>
<p>Approval returns to <code>{destination}</code>. Access follows the selected integration’s project and tool permissions.</p>
<form method="post" action="{OAUTH_AUTHORIZE_PATH}">
<input type="hidden" name="consent" value="{consent}">
<label for="integration">Integration</label>
<select id="integration" name="integration" required><option value="">Choose an integration</option>{options}</select>
<p><button type="submit">Approve access</button> <button type="submit" name="deny" value="true" formnovalidate>Deny access</button></p>
</form>"#
        ),
        Some(&callback),
    )
}

#[derive(Deserialize)]
pub(super) struct Approval {
    consent: String,
    integration: Option<String>,
    #[serde(default)]
    deny: bool,
}

pub(super) async fn finish(
    State(service): State<Arc<AuthService>>,
    Extension(context): Extension<Arc<Context>>,
    headers: axum::http::HeaderMap,
    Form(input): Form<Approval>,
) -> Response {
    let Some(config) = &service.config.external_mcp_oauth else {
        return missing();
    };
    let Some(browser) = browser(&context) else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    if !opaque_secret(&input.consent, "ctop_")
        || headers
            .get(header::ORIGIN)
            .and_then(|origin| origin.to_str().ok())
            .is_some_and(|origin| origin != config.issuer)
    {
        return invalid("invalid_request");
    }
    let repository = Repository(service.repository.database.clone());
    if input.deny {
        return match repository.deny(&browser, &input.consent).await {
            Ok(Some(request)) => callback(request, &config.issuer, None),
            Ok(None) => invalid("invalid_request"),
            Err(_) => unavailable(),
        };
    }
    let Some(integration) = input
        .integration
        .filter(|integration| uuid::Uuid::parse_str(integration).is_ok())
    else {
        return invalid("invalid_request");
    };
    match repository
        .approve(&browser, &input.consent, &integration)
        .await
    {
        Ok(Some((request, code))) => callback(request, &config.issuer, Some(code)),
        Ok(None) => invalid("invalid_request"),
        Err(_) => unavailable(),
    }
}

fn callback(request: Authorize, issuer: &str, code: Option<String>) -> Response {
    let Some(mut destination) = redirect(&request.redirect_uri) else {
        return invalid("invalid_request");
    };
    let mut query = destination.query_pairs_mut();
    match code {
        Some(code) => query.append_pair("code", &code),
        None => query.append_pair("error", "access_denied"),
    };
    query.append_pair("iss", issuer);
    if let Some(state) = request.state.as_deref() {
        query.append_pair("state", state);
    }
    drop(query);
    (
        StatusCode::SEE_OTHER,
        [
            (header::LOCATION, destination.as_str()),
            (header::CACHE_CONTROL, "no-store"),
            (header::REFERRER_POLICY, "no-referrer"),
        ],
    )
        .into_response()
}

fn escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

fn page(status: StatusCode, content: String, callback: Option<&url::Url>) -> Response {
    let policy = match callback {
        Some(callback) => format!(
            "default-src 'none'; form-action 'self' {}; frame-ancestors 'none'; base-uri 'none'",
            callback.origin().ascii_serialization(),
        ),
        None => "default-src 'none'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'"
            .to_owned(),
    };
    (
        status,
        [
            (header::CACHE_CONTROL,"no-store".to_owned()),
            (header::REFERRER_POLICY,"no-referrer".to_owned()),
            (header::CONTENT_SECURITY_POLICY,policy),
        ],
        Html(format!("<!doctype html><html lang=\"en\"><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><title>Cantrip integration access</title><main><h1>Cantrip integration access</h1>{content}</main></html>")),
    ).into_response()
}
