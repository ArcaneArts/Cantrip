use super::{
    Active, Entry, Failure, Inner, MAXIMUM_OPERATIONS, Reply, RequestSlot,
    json_response_with_limit, unauthorized,
};
use crate::{
    mcp::{bindings::computer_use::checked_authority, cua},
    metadata::{Abort, Signal},
};
use cantrip_protocol::mcp_host;
use cantrip_wire::{JsString, Value, parse_json_text, value::json};
use http_body_util::{BodyExt, Limited};
use hyper::{StatusCode, body::Incoming};
use std::sync::{Arc, atomic::Ordering};

struct Call {
    cancel: Option<Abort>,
}

impl Drop for Call {
    fn drop(&mut self) {
        if let Some(cancel) = self.cancel.take() {
            cancel.abort(anyhow::anyhow!("Computer-use MCP call closed."));
        }
    }
}

pub(super) fn disabled() -> Failure {
    Failure::new(
        StatusCode::FORBIDDEN,
        None,
        "Computer use is not enabled for this agent binding.",
    )
}

fn inactive() -> Failure {
    Failure::new(
        StatusCode::CONFLICT,
        Some("inactive-binding"),
        "This MCP session has no active execution binding.",
    )
}

fn unavailable() -> Failure {
    Failure::new(
        StatusCode::SERVICE_UNAVAILABLE,
        None,
        "Computer-use authorization is unavailable.",
    )
}

fn revoked() -> Failure {
    Failure::new(
        StatusCode::CONFLICT,
        Some("stale-binding"),
        "Computer-use execution is no longer authorized.",
    )
}

fn admit(entry: &mut Entry) -> Result<(Arc<Active>, (JsString, JsString), RequestSlot), Failure> {
    if !entry.computer_use {
        return Err(disabled());
    }
    let active = entry.active.as_ref().ok_or_else(inactive)?;
    if let Some(stale) = active.stale.lock().unwrap().as_ref() {
        return Err(Failure::new(
            StatusCode::CONFLICT,
            Some("stale-binding"),
            stale.clone(),
        ));
    }
    if active.computer_use.get().is_none() {
        return Err(inactive());
    }
    if entry.computer_use_requests.load(Ordering::Acquire) >= MAXIMUM_OPERATIONS {
        return Err(Failure::new(
            StatusCode::TOO_MANY_REQUESTS,
            None,
            "Too many computer-use operations in flight.",
        ));
    }
    entry.computer_use_requests.fetch_add(1, Ordering::AcqRel);
    Ok((
        active.clone(),
        entry.identity.clone(),
        RequestSlot(entry.computer_use_requests.clone()),
    ))
}

impl Inner {
    pub(super) async fn cua_broker(&self, credential: Option<&str>, body: Incoming) -> Reply {
        let Ok(body) = Limited::new(body, cua::MAXIMUM_REQUEST).collect().await else {
            return Failure::invalid("Computer-use MCP broker request is too large.").reply();
        };
        let bytes = body.to_bytes();
        let request = std::str::from_utf8(&bytes)
            .ok()
            .and_then(|text| parse_json_text(text).ok());
        let Ok(envelope) = mcp_host::parse("cuaMcpBrokerRequestSchema", request.as_ref()) else {
            return Failure::invalid("Invalid computer-use MCP broker request.").reply();
        };
        let binding = envelope["bindingId"]
            .as_js_string()
            .expect("validated MCP binding");
        match self
            .cua_call(binding, credential, envelope["request"].clone())
            .await
        {
            Ok(result) => {
                json_response_with_limit(StatusCode::OK, result, cua::MAXIMUM_RESPONSE, false)
            }
            Err(error) => error.reply(),
        }
    }

    pub(super) async fn cua_call(
        &self,
        binding: &JsString,
        credential: Option<&str>,
        request: Value,
    ) -> Result<Value, Failure> {
        let envelope = mcp_host::parse(
            "cuaMcpBrokerRequestSchema",
            Some(&json!({"bindingId":binding,"request":request})),
        )
        .map_err(|_| {
            Failure::invalid(
                "CUA requires a bounded request and actual Codex thread/turn metadata.",
            )
        })?;
        let request = &envelope["request"];
        let (active, identity, _slot) = self.authenticated(binding, credential, admit)?;
        let execution = active
            .computer_use
            .get()
            .expect("admitted computer-use runtime");
        if !execution.owns(request) {
            return Err(revoked());
        }
        let request_id = uuid::Uuid::new_v4();
        if !execution.executor.begin_call(request, request_id) {
            return Err(revoked());
        }

        let (cancel, signal) = Abort::new();
        let mut call = Call {
            cancel: Some(cancel),
        };
        let lifetime = Signal::any(vec![signal, execution.revoked.clone()]);
        let mut stopped = active.stopped.subscribe();
        let run = async {
            let raw = self
                .server
                .computer_use_authority(&active.binding)
                .await
                .map_err(|error| {
                    match error
                        .downcast_ref::<super::Rejected>()
                        .map(|rejected| rejected.status)
                    {
                        Some(401 | 403 | 409) => {
                            execution.revoke();
                            revoked()
                        }
                        _ => unavailable(),
                    }
                })?;
            let current = checked_authority(&raw, &active.binding, &identity.1);
            if current.as_ref().ok() != Some(&execution.authority) {
                execution.revoke();
                return Err(revoked());
            }
            if (self.identity)().as_ref().ok() != Some(&identity) {
                return Err(unauthorized());
            }
            if !execution.owns(request) {
                return Err(revoked());
            }
            let result = execution
                .executor
                .execute(request.clone(), request_id, lifetime)
                .await
                .map_err(|error| Failure::invalid(&error.to_string()))?;
            if (self.identity)().as_ref().ok() != Some(&identity) {
                return Err(unauthorized());
            }
            if !execution.owns(request) {
                return Err(revoked());
            }
            cua::validate_result(result).map_err(|error| Failure::invalid(&error.to_string()))
        };
        let result = tokio::select! {
            biased;
            _ = stopped.wait_for(|stopped| *stopped) => Err(revoked()),
            _ = execution.revoked.cancelled() => Err(revoked()),
            result = run => result,
        };
        if result.is_ok() {
            // Successful results can leave an observation attached to the turn.
            // Only a failed or abandoned call revokes this request signal.
            call.cancel.take();
        }
        result
    }
}
