//! Observe actual response completion without changing the response or its bytes.
#[path = "request_log_policy.rs"]
mod policy;
use crate::{
    operations::{log_format, log_runtime, log_sanitize},
    wire::{JsString, value::json},
};
use axum::{extract::Request, http::Method, middleware::Next, response::Response};
pub use policy::LogLevel;
use std::time::Instant;

#[derive(Clone)]
pub(super) struct RequestId(pub String);
pub fn safe_path(raw: &JsString) -> JsString {
    let base = url::Url::parse("http://cantrip.invalid").expect("fixed log base");
    match url::Url::options()
        .base_url(Some(&base))
        .parse(&raw.lossy())
    {
        Ok(url) => {
            if url.path().is_empty() {
                "/".into()
            } else {
                url.path().into()
            }
        }
        Err(_) => {
            let units = raw.units();
            let end = units
                .iter()
                .position(|c| matches!(*c, 35 | 63))
                .unwrap_or(units.len());
            if end == 0 {
                "/".into()
            } else {
                JsString::new(units[..end].to_vec())
            }
        }
    }
}
pub fn completed(id: &str, method: &str, path: &str, code: u16, duration: f64) {
    let level = if code >= 500 {
        "error"
    } else if code >= 400 {
        "warn"
    } else {
        "debug"
    };
    let method = log_sanitize::text(&method.into());
    let path = log_sanitize::text(&safe_path(&path.into()));
    let mut message = method.units().to_vec();
    message.push(32);
    message.extend(path.units());
    message.extend(format!(" -> {code} {} (", log_format::status_name(code as f64)).encode_utf16());
    message.extend(log_format::duration(duration).units());
    message.push(41);
    let context = json!({"event":"http.request.completed","subsystem":"http","operation":method.clone(),"status":if code>=400{"failed"}else{"completed"},"durationMs":duration,"requestId":id,"method":method,"path":path,"statusCode":code});
    let record = json!({"timestamp":crate::auth::now().to_rfc3339_opts(chrono::SecondsFormat::Millis,true),"system":"server","level":level,"message":log_sanitize::text(&JsString::new(message)),"context":log_sanitize::context(&context)});
    log_runtime::capture_http(record);
}
pub async fn observe(request: Request, next: Next) -> Response {
    if !log_runtime::is_initialized()
        || request
            .extensions()
            .get::<super::request_target::InvalidFallbackTarget>()
            .is_some()
    {
        return next.run(request).await;
    }
    let level = policy::level(request.method().as_str(), &request.uri().to_string());
    observe_with_level(request, next, level).await
}
/// The production wrapper always selects actual registered-route policy. A
/// controlled HTTP fixture can supply the same level as its Fastify route.
pub async fn observe_with_level(mut request: Request, next: Next, level: LogLevel) -> Response {
    if !log_runtime::is_initialized() {
        return next.run(request).await;
    }
    let started = Instant::now();
    let id = uuid::Uuid::new_v4().to_string();
    let method = request.method().clone();
    let path = request
        .extensions()
        .get::<axum::extract::OriginalUri>()
        .map_or_else(
            || request.uri().to_string(),
            |original| original.0.to_string(),
        );
    request.extensions_mut().insert(RequestId(id.clone()));
    let response = next.run(request).await;
    // The existing Fastify WebSocket plugin writes successful upgrades directly
    // to the socket, outside its ordinary onResponse/request-completed hook.
    if response
        .extensions()
        .get::<super::websocket::RawUpgradeResponse>()
        .is_some()
    {
        return response;
    }
    let code = response.status().as_u16();
    let head = method == Method::HEAD;
    let method = method.as_str().to_owned();
    let completion = move |error: Option<&axum::Error>| {
        if let Some(error) = error {
            if !level.stream_warning() {
                return;
            }
            let mut cause: &(dyn std::error::Error + 'static) = error;
            while let Some(inner) = cause.source() {
                cause = inner;
            }
            let context = json!({"reqId":id,"err":json!({"message":cause.to_string()})});
            crate::operations::logging::server_logger()(
                crate::operations::logging::LogCall::event(
                    "warn",
                    "response terminated with an error with headers already sent",
                    context,
                ),
            );
        } else if level.incoming() {
            completed(
                &id,
                &method,
                &path,
                code,
                started.elapsed().as_secs_f64() * 1000.0,
            )
        }
    };
    super::on_response::outcome(response, head, completion)
}
