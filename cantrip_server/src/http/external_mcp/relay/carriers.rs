//! Carrier negotiation uses the same integration lease as the encrypted channel.
use super::{
    AuthService, Principal, Response, StatusCode, Value, authenticate_hosted, failure,
    integration_response, json, session,
};
use crate::http::worker_link_sessions::{activate_direct, prepare_direct};
use axum::{
    Json,
    extract::{Path, State},
    http::HeaderMap,
    response::IntoResponse,
};
use std::sync::Arc;

pub(super) async fn hosted(
    State(service): State<Arc<AuthService>>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(input): Json<Value>,
) -> Response {
    let principal = match authenticate_hosted(&service, &headers).await {
        Ok(principal) => principal,
        Err(response) => return response,
    };
    execute(&service, principal, &id, &input).await
}

pub(super) async fn local(
    State(service): State<Arc<AuthService>>,
    Path(id): Path<String>,
    Json(input): Json<Value>,
) -> Response {
    execute(&service, Principal::Loopback, &id, &input).await
}

async fn execute(
    service: &Arc<AuthService>,
    principal: Principal,
    id: &str,
    input: &Value,
) -> Response {
    let current = match session(service, &principal, id).await {
        Ok(Some(current)) => current,
        Ok(None) => return failure(StatusCode::NOT_FOUND, "WorkerLink session is unavailable."),
        Err(_) => {
            return failure(
                StatusCode::SERVICE_UNAVAILABLE,
                "WorkerLink authorization is unavailable.",
            );
        }
    };
    let kind = input["kind"].as_str().unwrap_or_default();
    let parameters = &input["parameters"];
    let authority = &service.worker_links.authority;
    let result = match kind {
        "local-open" => {
            return prepare_direct(service, &current)
                .await
                .unwrap_or_else(|_| unavailable());
        }
        "local-activate" => {
            let capability = parameters["capabilityId"]
                .as_str()
                .filter(|value| value.len() <= 200);
            return match capability {
                Some(capability) => activate_direct(service, &current, capability),
                None => failure(
                    StatusCode::BAD_REQUEST,
                    "Invalid WorkerLink direct activation.",
                ),
            };
        }
        "peer-open" => authority
            .open_peer(id, parameters.clone())
            .await
            .map(|mut result| {
                result["configuration"] = Value::from_serialize(&service.config.worker_link_peer);
                result
            }),
        "peer-signal" => {
            let Some(signals) = parameters["signals"]
                .as_array()
                .filter(|signals| (1..=32).contains(&signals.len()))
            else {
                return failure(
                    StatusCode::BAD_REQUEST,
                    "Invalid WorkerLink peer signal batch.",
                );
            };
            for signal in signals {
                if signal["sender"] != "client"
                    || authority.signal_peer(id, signal.clone()).await.is_err()
                {
                    return unavailable();
                }
            }
            return StatusCode::NO_CONTENT.into_response();
        }
        "peer-mailbox" => {
            let Some(peer) = parameters["peerSessionId"].as_str() else {
                return failure(StatusCode::BAD_REQUEST, "Invalid WorkerLink peer mailbox.");
            };
            authority
                .read_peer_mailbox(
                    id,
                    peer,
                    json!({
                        "afterSignalSequence":parameters["afterSignalSequence"],
                        "afterAdvertisementSequence":parameters["afterAdvertisementSequence"],
                    }),
                )
                .await
        }
        _ => {
            return failure(
                StatusCode::BAD_REQUEST,
                "Unknown WorkerLink carrier operation.",
            );
        }
    };
    match result {
        Ok(result) => integration_response(StatusCode::OK, result),
        Err(_) => unavailable(),
    }
}

fn unavailable() -> Response {
    failure(
        StatusCode::CONFLICT,
        "The requested WorkerLink carrier is unavailable.",
    )
}
