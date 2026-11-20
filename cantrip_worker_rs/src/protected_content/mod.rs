//! Native equivalents of the worker endpoint/surface content helpers. Resource
//! authorization and cancellation remain with the owning execution adapters.
mod endpoint;
mod policy;
mod private_state;
mod replay;
mod repository;
mod surface;
use crate::encryption::BoundComponentKey;
use anyhow::{Result, anyhow};
use cantrip_crypto::{DecryptionError, Zeroizing, checked};
use cantrip_wire::{Value, parse_json_text, value::json};
pub use endpoint::*;
pub(crate) use policy::{
    EffectivePolicies, open_policy_body, open_policy_detail, open_policy_summary,
};
pub use private_state::*;
pub use replay::SurfaceStreamReplayGuard;
pub use repository::*;
pub use surface::*;

pub(crate) fn open_tunnel_record(
    service: &crate::encryption::Service,
    tunnel: &Value,
    record: &Value,
) -> Result<Value> {
    let scope = Value::Array(vec![json!("tunnel"), tunnel.clone()]).stringify();
    let binding = json!({
        "domain":"tunnel-content", "serverId":service.server_identity()?,
        "workerId":service.worker_id(), "scopeId":scope, "operationId":record["operationId"],
        "operation":"tunnel.record", "direction":"stored", "sequence":record["revision"],
    });
    open_endpoint_content(
        service,
        &binding,
        &record["protectedContent"],
        "tunnelContentRecordSchema",
    )
}

fn context(grant: &BoundComponentKey, binding: &Value) -> Value {
    json!({"ownerId":grant.owner_id,"keyRevision":grant.component.key_revision,"context":binding})
}
fn encode_content(schema: &str, content: &Value) -> Result<Zeroizing<Vec<u8>>> {
    Ok(Zeroizing::new(
        checked(schema, content)?.stringify().into_bytes(),
    ))
}
fn decode_content(schema: &str, plaintext: &[u8]) -> Result<Value> {
    decode_content_with_input(schema, plaintext).map(|(parsed, _)| parsed)
}
fn decode_content_with_input(schema: &str, plaintext: &[u8]) -> Result<(Value, Value)> {
    let text = std::str::from_utf8(plaintext)
        .map_err(|_| anyhow!("The encoded data was not valid for encoding utf-8"))?;
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let value = parse_json_text(text).map_err(|error| anyhow!("{}", error.lossy()))?;
    Ok((checked(schema, &value)?, value))
}
fn authentication_error(error: anyhow::Error, message: &'static str) -> anyhow::Error {
    if error.is::<DecryptionError>() {
        anyhow!(message)
    } else {
        error
    }
}
