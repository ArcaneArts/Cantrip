//! Preserve the current public 410 contract without restoring retired plaintext
//! repository handlers. The guard runs after authentication and before limits
//! or body parsing, and only for methods the reference actually registers.
use super::{body, json_response};
use crate::auth::service::AuthService;
use axum::{
    Router,
    extract::{MatchedPath, Request, State},
    http::{Method, StatusCode},
    response::Response,
    routing::{MethodFilter, on},
};
use serde::Deserialize;
use std::sync::{Arc, OnceLock};

const REMOVED: &str =
    "This plaintext repository route was removed. Use the protected repository operation endpoint.";
const GIT_AGENT: &str =
    "This plaintext Git agent route was removed. Use the protected repository operation endpoint.";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Route {
    method: String,
    path: String,
    git_agent: bool,
}

fn contract() -> &'static [Route] {
    static ROUTES: OnceLock<Vec<Route>> = OnceLock::new();
    ROUTES.get_or_init(|| {
        serde_json::from_str(include_str!(
            "../../contracts/removed-repository-routes.json"
        ))
        .expect("generated retired repository route contract")
    })
}

fn method_matches(route: &Route, method: &Method) -> bool {
    route.method == method.as_str() || (*method == Method::HEAD && route.method == "GET")
}

pub(super) fn unregistered_method(method: &Method, path: &str) -> bool {
    let mut present = false;
    for route in contract().iter().filter(|route| route.path == path) {
        present = true;
        if method_matches(route, method) {
            return false;
        }
    }
    present
}

pub(super) fn rejection(method: &Method, path: &str) -> Option<&'static str> {
    contract().iter().find_map(|route| {
        (!route.git_agent && route.path == path && method_matches(route, method)).then_some(REMOVED)
    })
}

async fn gone(
    State(service): State<Arc<AuthService>>,
    matched: MatchedPath,
    request: Request,
) -> Response {
    let path = matched
        .as_str()
        .split('/')
        .map(|part| {
            part.strip_prefix('{')
                .and_then(|part| part.strip_suffix('}'))
                .map_or_else(|| part.to_owned(), |part| format!(":{part}"))
        })
        .collect::<Vec<_>>()
        .join("/");
    let git_agent = contract()
        .iter()
        .any(|route| route.path == path && route.git_agent);
    if git_agent
        && let Err(response) = body::parse_ignored(
            request,
            service.config.api_body_limit_bytes,
            service.config.upload_limit_bytes,
        )
        .await
    {
        return response;
    }
    json_response(
        StatusCode::GONE,
        serde_json::json!({"error":if git_agent {GIT_AGENT} else {REMOVED}}),
    )
}

pub(super) fn routes() -> Router<Arc<AuthService>> {
    contract().iter().fold(Router::new(), |router, route| {
        let path = route
            .path
            .split('/')
            .map(|part| {
                part.strip_prefix(':')
                    .map_or_else(|| part.to_owned(), |part| format!("{{{part}}}"))
            })
            .collect::<Vec<_>>()
            .join("/");
        let method = Method::from_bytes(route.method.as_bytes()).expect("generated HTTP method");
        router.route(
            &path,
            on(
                MethodFilter::try_from(method).expect("HTTP method filter"),
                gone,
            ),
        )
    })
}
