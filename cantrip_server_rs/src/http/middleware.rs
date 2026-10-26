use super::json_response;
use crate::{
    auth::{
        crypto,
        service::{AuthService, ConflictingSessionCookies, Principal},
    },
    config::AuthMode,
};
use axum::{
    body::Body,
    extract::{ConnectInfo, Request, State},
    http::{HeaderMap, HeaderValue, Method, StatusCode, header},
    middleware::Next,
    response::{IntoResponse, Response},
};
use serde_json::json;
use std::{
    net::{IpAddr, SocketAddr},
    sync::Arc,
};
use uuid::Uuid;

#[derive(Clone)]
pub(super) struct Context {
    pub id: String,
    pub principal: Principal,
    pub ip: String,
}

pub(super) fn value(headers: &HeaderMap, name: &str) -> Option<String> {
    let values: Vec<_> = headers
        .get_all(name)
        .iter()
        .map(|value| {
            value
                .as_bytes()
                .iter()
                .map(|b| char::from(*b))
                .collect::<String>()
        })
        .collect();
    if values.is_empty() {
        None
    } else if ["host", "content-type", "content-length", "authorization"].contains(&name) {
        Some(values[0].clone())
    } else {
        Some(values.join(if name == "cookie" { "; " } else { ", " }))
    }
}
pub(super) fn cookies(response: &mut Response, values: Vec<String>) {
    for value in values {
        response.headers_mut().append(
            header::SET_COOKIE,
            HeaderValue::from_str(&value).expect("serialized authentication cookie"),
        );
    }
}
fn public(path: &str) -> bool {
    [
        "/api",
        "/version",
        "/healthz",
        "/readyz",
        "/metrics",
        "/api/bootstrap",
        "/api/auth/login",
        "/api/auth/register",
        "/api/auth/mobile-sign-in/exchange",
        "/api/auth/session",
    ]
    .contains(&path)
        || path.starts_with("/api/internal/")
}
fn trusted(ip: IpAddr, rules: &[String]) -> bool {
    let ip = match ip {
        IpAddr::V6(v) => v.to_ipv4_mapped().map_or(IpAddr::V6(v), IpAddr::V4),
        v => v,
    };
    rules.iter().any(|rule| {
        let expanded: &[&str] = match rule.as_str() {
            "loopback" => &["127.0.0.0/8", "::1/128"],
            "linklocal" => &["169.254.0.0/16", "fe80::/10"],
            "uniquelocal" => &["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fc00::/7"],
            _ => &[],
        };
        let matches = |rule: &str| {
            let (network, prefix) = rule
                .split_once('/')
                .map_or((rule, None), |(a, b)| (a, Some(b)));
            let Ok(network) = network.split('%').next().unwrap().parse::<IpAddr>() else {
                return false;
            };
            let bits = if network.is_ipv4() { 32 } else { 128 };
            let Some(prefix) = prefix
                .map_or(Some(bits), |v| v.parse::<u32>().ok())
                .filter(|p| *p <= bits)
            else {
                return false;
            };
            match (ip, network) {
                (IpAddr::V4(a), IpAddr::V4(b)) => {
                    prefix == 0 || u32::from(a) >> (32 - prefix) == u32::from(b) >> (32 - prefix)
                }
                (IpAddr::V6(a), IpAddr::V6(b)) => {
                    prefix == 0
                        || u128::from(a) >> (128 - prefix) == u128::from(b) >> (128 - prefix)
                }
                _ => false,
            }
        };
        if expanded.is_empty() {
            matches(rule)
        } else {
            expanded.iter().any(|v| matches(v))
        }
    })
}
fn forwarded_ip(value: &str) -> Option<IpAddr> {
    if let Some((address, zone)) = value.split_once('%') {
        if zone.is_empty()
            || !zone
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-.:".contains(&b))
        {
            return None;
        }
        let address = address.parse::<IpAddr>().ok()?;
        if address.is_ipv6() {
            Some(address)
        } else {
            None
        }
    } else {
        value.parse().ok()
    }
}
fn transport(
    service: &AuthService,
    request: &Request,
    peer: IpAddr,
) -> Result<String, &'static str> {
    let headers = request.headers();
    let cfg = &service.config;
    let forwarded = value(headers, "forwarded");
    let xff = value(headers, "x-forwarded-for");
    let host = value(headers, "x-forwarded-host");
    let proto = value(headers, "x-forwarded-proto");
    let has_forwarded = [&forwarded, &xff, &host, &proto]
        .iter()
        .any(|v| v.as_ref().is_some_and(|s| !s.is_empty()));
    let mut ip = peer;
    let mut client_ip = peer.to_string();
    if let Some(chain) = &xff {
        for next in chain.split(',').rev() {
            if !trusted(ip, &cfg.trusted_proxies) {
                break;
            }
            if let Some(parsed) = forwarded_ip(crate::text::trim(next)) {
                ip = parsed;
                client_ip = crate::text::trim(next).to_owned();
            } else {
                break;
            }
        }
    }
    if ["/healthz", "/readyz"].contains(&request.uri().path())
        && !has_forwarded
        && ["127.0.0.1", "::1"].contains(&ip.to_string().as_str())
    {
        return Ok(client_ip);
    }
    if has_forwarded && cfg.trusted_proxies.is_empty() {
        return Err("Forwarding headers require a configured trusted proxy.");
    }
    if forwarded.as_ref().is_some_and(|v| !v.is_empty()) {
        return Err("Use validated X-Forwarded-* headers through the trusted proxy.");
    }
    if [&xff, &host, &proto]
        .iter()
        .filter_map(|v| v.as_ref())
        .map(|s| crate::text::length(s))
        .sum::<usize>()
        > 2048
    {
        return Err("Forwarding headers are invalid.");
    }
    if let Some(xff) = &xff {
        let addresses: Vec<_> = xff.split(',').collect();
        if addresses.len() > 16
            || addresses
                .iter()
                .any(|a| forwarded_ip(crate::text::trim(a)).is_none())
        {
            return Err("Forwarding headers are invalid.");
        }
    }
    if proto
        .as_ref()
        .is_some_and(|p| !["http", "https"].contains(&p.to_lowercase().as_str()))
    {
        return Err("Forwarding headers are invalid.");
    }
    if host.as_ref().is_some_and(|h| {
        h.is_empty()
            || h.len() > 255
            || !h
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b".[]:_-".contains(&b))
    }) {
        return Err("Forwarding headers are invalid.");
    }
    let immediate = trusted(peer, &cfg.trusted_proxies);
    let protocol = if immediate {
        proto.as_deref().unwrap_or("http")
    } else {
        "http"
    };
    if cfg.require_https && protocol != "https" {
        return Err("HTTPS is required.");
    }
    let actual_host = if immediate {
        host.or_else(|| value(headers, "host"))
    } else {
        value(headers, "host")
    };
    if let Some(expected) = &cfg.public_origin {
        let url = url::Url::parse(expected).expect("validated public origin");
        let expected = &url[url::Position::BeforeHost..url::Position::AfterPort];
        if actual_host.unwrap_or_default().to_lowercase() != expected {
            return Err("Request host is not configured for this server.");
        }
    }
    let origin = value(headers, "origin");
    let websocket = value(headers, "upgrade").is_some_and(|v| v.eq_ignore_ascii_case("websocket"));
    if !websocket
        && origin
            .as_ref()
            .is_some_and(|o| !o.is_empty() && !cfg.app_origins.contains(o))
    {
        return Err("Origin is not allowed.");
    }
    Ok(client_ip)
}
fn finish(
    service: &AuthService,
    id: &str,
    origin: Option<&str>,
    cors: bool,
    preflight: bool,
    requested_headers: Option<&str>,
    mut response: Response,
) -> Response {
    let headers = response.headers_mut();
    for (name, value) in [
        (
            "content-security-policy",
            "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
        ),
        (
            "permissions-policy",
            "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
        ),
        ("referrer-policy", "no-referrer"),
        ("x-content-type-options", "nosniff"),
        ("x-frame-options", "DENY"),
        ("x-permitted-cross-domain-policies", "none"),
    ] {
        headers.insert(name, HeaderValue::from_static(value));
    }
    headers.insert("x-request-id", HeaderValue::from_str(id).unwrap());
    if !headers.contains_key(header::CACHE_CONTROL) {
        headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    }
    if service.config.require_https {
        headers.insert(
            "strict-transport-security",
            HeaderValue::from_static("max-age=31536000"),
        );
    }
    if cors {
        headers.insert(
            header::VARY,
            HeaderValue::from_static(if preflight {
                "Origin, Access-Control-Request-Headers"
            } else {
                "Origin"
            }),
        );
        headers.insert(
            "access-control-allow-credentials",
            HeaderValue::from_static("true"),
        );
        if let Some(origin) = origin.filter(|o| service.config.app_origins.iter().any(|v| v == o)) {
            headers.insert(
                "access-control-allow-origin",
                HeaderValue::from_str(origin).unwrap(),
            );
        }
        if preflight {
            headers.insert(
                "access-control-allow-methods",
                HeaderValue::from_static("GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS"),
            );
            if let Some(value) = requested_headers {
                headers.insert(
                    "access-control-allow-headers",
                    HeaderValue::from_str(value).unwrap(),
                );
            }
        }
    }
    response
}
pub(super) fn internal_error(id: &str) -> Response {
    eprintln!(
        "{}",
        json!({"event":"http.request-failed","requestId":id,"status":500})
    );
    json_response(
        StatusCode::INTERNAL_SERVER_ERROR,
        json!({"error":"Internal server error.","requestId":id}),
    )
}
pub(super) fn failure(service: &AuthService, id: &str, error: &anyhow::Error) -> Response {
    if error.is::<ConflictingSessionCookies>() {
        let mut response = json_response(
            StatusCode::UNAUTHORIZED,
            json!({"code":"session-cookie-conflict","error":error.to_string()}),
        );
        cookies(&mut response, service.cookies.clear());
        response
    } else {
        internal_error(id)
    }
}
pub(super) async fn guard(
    State(service): State<Arc<AuthService>>,
    mut request: Request,
    next: Next,
) -> Response {
    let id = Uuid::new_v4().to_string();
    let origin = value(request.headers(), "origin");
    let requested_headers = value(request.headers(), "access-control-request-headers");
    let peer = request
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map_or("127.0.0.1".parse().unwrap(), |v| v.0.ip());
    let ip = match transport(&service, &request, peer) {
        Ok(ip) => ip,
        Err(message) => {
            return finish(
                &service,
                &id,
                origin.as_deref(),
                false,
                false,
                None,
                json_response(
                    if message == "Origin is not allowed." {
                        StatusCode::FORBIDDEN
                    } else {
                        StatusCode::BAD_REQUEST
                    },
                    json!({"error":message}),
                ),
            );
        }
    };
    if request.method() == Method::OPTIONS {
        let valid = origin.as_ref().is_some_and(|s| !s.is_empty())
            && value(request.headers(), "access-control-request-method")
                .is_some_and(|s| !s.is_empty());
        let response = if valid {
            let mut response = Response::new(Body::empty());
            *response.status_mut() = StatusCode::NO_CONTENT;
            response
                .headers_mut()
                .insert(header::CONTENT_LENGTH, HeaderValue::from_static("0"));
            response
        } else {
            (
                StatusCode::BAD_REQUEST,
                [(header::CONTENT_TYPE, "text/plain")],
                "Invalid Preflight Request",
            )
                .into_response()
        };
        return finish(
            &service,
            &id,
            origin.as_deref(),
            true,
            valid,
            requested_headers.as_deref(),
            response,
        );
    }
    let cookie = value(request.headers(), "cookie");
    let principal = match service.principal(cookie.as_deref()).await {
        Ok(value) => value,
        Err(error) => {
            let response = failure(&service, &id, &error);
            return finish(
                &service,
                &id,
                origin.as_deref(),
                true,
                false,
                None,
                response,
            );
        }
    };
    let path = request.uri().path();
    let rejection = if service.config.auth_mode != AuthMode::None {
        if !public(path) && !principal.authenticated() {
            Some(json_response(
                StatusCode::UNAUTHORIZED,
                json!({"error":"Authentication is required."}),
            ))
        } else if (!public(path) || path == "/api/auth/session")
            && value(request.headers(), "x-cantrip-account-id")
                .is_some_and(|v| principal.user.as_ref().is_some_and(|u| u.id != v))
        {
            let mut response = json_response(
                StatusCode::UNAUTHORIZED,
                json!({"code":"session-account-mismatch","error":"This server connection changed accounts. Sign in again."}),
            );
            cookies(&mut response, service.cookies.clear());
            Some(response)
        } else if ![Method::GET, Method::HEAD].contains(request.method()) && !public(path) {
            match service.resolve(cookie.as_deref()).await {
                Ok(Some(resolved))
                    if crypto::csrf_matches(
                        &resolved.session.csrf_token_hash,
                        &value(request.headers(), "x-cantrip-csrf")
                            .map_or(serde_json::Value::Null, |v| json!(v)),
                    ) =>
                {
                    None
                }
                Ok(_) => Some(json_response(
                    StatusCode::FORBIDDEN,
                    json!({"error":"CSRF validation failed."}),
                )),
                Err(_) => Some(internal_error(&id)),
            }
        } else {
            None
        }
    } else {
        None
    };
    let response = if let Some(response) = rejection {
        response
    } else {
        request.extensions_mut().insert(Arc::new(Context {
            id: id.clone(),
            principal,
            ip,
        }));
        next.run(request).await
    };
    finish(
        &service,
        &id,
        origin.as_deref(),
        true,
        false,
        None,
        response,
    )
}
