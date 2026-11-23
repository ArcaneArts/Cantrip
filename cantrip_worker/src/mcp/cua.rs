//! The stdio adapter only relays authenticated tool requests to the worker.
use super::{broker::Broker, rpc};
use anyhow::{Result, ensure};
use base64::{Engine, engine::general_purpose::STANDARD};
use cantrip_crypto::Zeroizing;
use cantrip_protocol::{ValidationError, mcp_host};
use cantrip_wire::{JsString, Value, value::json};

pub(super) const MAXIMUM_RESPONSE: usize = 8 * 1024 * 1024;
pub(super) const MAXIMUM_REQUEST: usize = 16 * 1024 * 1024;
const IMAGE_LIMIT: usize = 5 * 1024 * 1024 / 2;
const IMAGES_LIMIT: usize = 5 * 1024 * 1024;
const MAX_IMAGES: usize = 2;
const INVALID_REQUEST: &str =
    "CUA requires a bounded request and actual Codex thread/turn metadata.";

pub(super) async fn call(
    broker: &Broker,
    name: &str,
    arguments: Option<&Value>,
    metadata: &Value,
) -> Value {
    let request = match request(name, arguments, metadata) {
        Ok(request) => request,
        Err(reply) => return reply,
    };
    match broker.call_cua(request).await.and_then(validate_result) {
        Ok(reply) => reply,
        Err(error) => failure(&error.to_string()),
    }
}

pub(super) fn request(
    name: &str,
    arguments: Option<&Value>,
    metadata: &Value,
) -> Result<Value, Value> {
    let schema = match name {
        "js" => "cuaMcpScriptArgumentsSchema",
        "js_reset" => "cuaMcpResetArgumentsSchema",
        _ => {
            return Err(rpc::tool_error(format!(
                "MCP error -32602: Tool {name} not found"
            )));
        }
    };
    let arguments = match mcp_host::parse(schema, arguments) {
        Ok(arguments) => arguments,
        Err(ValidationError::Invalid(issues)) => {
            return Err(rpc::input_error(name, Value::Array(issues)));
        }
        Err(ValidationError::Operation) => return Err(rpc::tool_error(INVALID_REQUEST)),
    };
    let mut request = json!({
        "operation":name,"threadId":metadata["threadId"],
        "turnId":metadata["x-codex-turn-metadata"]["turn_id"],
        "itemId":metadata["itemId"],"callId":metadata["callId"],
    });
    if name == "js" {
        request["script"] = arguments["script"].clone();
    }
    Ok(request)
}

pub(super) fn failure(message: &str) -> Value {
    rpc::tool_error(JsString::new(message.encode_utf16().take(2000).collect()))
}

pub(super) fn bounded_result(id: &Value, payload: Value) -> Value {
    let frame = rpc::result(id, payload);
    // The limit includes the JSON-RPC wrapper, escaped request ID and LF.
    if frame.stringify().len() < MAXIMUM_RESPONSE {
        frame
    } else {
        rpc::result(
            id,
            rpc::tool_error("CUA result exceeds the 8 MiB MCP line limit."),
        )
    }
}

pub(super) fn validate_result(raw: Value) -> Result<Value> {
    let value = mcp_host::parse("cuaMcpResultSchema", Some(&raw))
        .map_err(|_| anyhow::anyhow!("CUA MCP result has unsupported content."))?;
    let mut total = 0;
    let mut images = 0;
    for content in value["content"].as_array().expect("validated CUA result") {
        if content["type"] == "text" {
            continue;
        }
        images += 1;
        ensure!(
            content["mimeType"] == "image/png" && images <= MAX_IMAGES,
            "CUA MCP result has unsupported or excessive image content."
        );
        let invalid = || anyhow::anyhow!("CUA MCP result contains invalid image data.");
        let data = content["data"].as_str().ok_or_else(invalid)?;
        ensure!(
            !data.is_empty() && data.len() <= 4 * IMAGE_LIMIT.div_ceil(3),
            invalid()
        );
        let bytes = Zeroizing::new(STANDARD.decode(data).map_err(|_| invalid())?);
        ensure!(bytes.len() <= IMAGE_LIMIT, invalid());
        total += bytes.len();
        ensure!(
            total <= IMAGES_LIMIT,
            "CUA MCP image result exceeds the aggregate image limit."
        );
    }
    Ok(value)
}
