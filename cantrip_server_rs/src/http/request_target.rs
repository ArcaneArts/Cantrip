//! Fastify validates the target before authentication, CORS and request logging.
use axum::{
    Router,
    body::Body,
    extract::{OriginalUri, Request},
    http::{Method, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
};
use serde_json::json;
use tower::Layer;

#[derive(Clone)]
pub(super) struct InvalidFallbackTarget;

pub(super) fn wrap(router: Router) -> Router {
    // An ordinary Router layer runs after route matching. This outer service
    // performs decoding before the inner Axum router selects its real handler.
    Router::new().fallback_service(middleware::from_fn(normalize).layer(router))
}
async fn normalize(mut request: Request, next: Next) -> Response {
    match super::route_table::routing_uri(request.method().as_str(), request.uri()) {
        Ok(uri) => {
            let original = request.uri().clone();
            request.extensions_mut().insert(OriginalUri(original));
            *request.uri_mut() = uri;
            dispatch(request, next).await
        }
        Err(_) if !super::route_table::known_method(request.method().as_str()) => {
            // Fastify's separate 404 router sends its basic error through
            // onSend, bypassing onRequest, parsing and completion diagnostics.
            request.extensions_mut().insert(InvalidFallbackTarget);
            dispatch(request, next).await
        }
        Err(error) => {
            let body = serde_json::to_vec(&json!({"error":"Bad Request","code":error.code,"message":error.message(),"statusCode":error.status()})).expect("target error JSON");
            let length = body.len().to_string();
            let body = if request.method() == Method::HEAD {
                Body::empty()
            } else {
                Body::from(body)
            };
            (
                StatusCode::from_u16(error.status()).unwrap(),
                [
                    (header::CONTENT_TYPE, "application/json"),
                    (header::CONTENT_LENGTH, length.as_str()),
                ],
                body,
            )
                .into_response()
        }
    }
}
async fn dispatch(request: Request, next: Next) -> Response {
    let mut response = next.run(request).await;
    // Axum's method fallback adds Allow after our 404 handler returns. Fastify
    // preserves its ordinary fallback contract without this 405-only header.
    response.headers_mut().remove(header::ALLOW);
    response
}
