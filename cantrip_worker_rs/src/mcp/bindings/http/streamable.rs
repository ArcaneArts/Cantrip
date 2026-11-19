use super::{Inner, MAXIMUM_RESPONSE, Reply, json_response};
use crate::mcp::{broker::operation_timeout, rpc};
use cantrip_protocol::mcp_host;
use cantrip_wire::{JsString, Value, parse_json_text, value::json};
use http_body_util::{BodyExt, Limited};
use hyper::{Method, Response, StatusCode, body::Incoming, header, http::request::Parts};

// Bound JSON-RPC frames separately from the broker's operation payloads.
const MAXIMUM_BODY: usize = 4 * 1024 * 1024;
const MAXIMUM_BATCH: usize = 32;

impl Inner {
    pub(super) async fn streamable(
        &self,
        id: &JsString,
        credential: Option<&str>,
        parts: &Parts,
        body: Incoming,
    ) -> Reply {
        let (profile, allowed) = match self.authenticated(id, credential, |entry| {
            Ok((entry.attachment.profile, entry.attachment.tools.clone()))
        }) {
            Ok(attachment) => attachment,
            Err(error) => return error.reply(),
        };
        if parts.method != Method::POST {
            let mut reply = empty(StatusCode::METHOD_NOT_ALLOWED);
            reply
                .headers_mut()
                .insert(header::ALLOW, "POST".parse().unwrap());
            return reply;
        }
        let accepts = |content: &str| {
            parts
                .headers
                .get_all(header::ACCEPT)
                .iter()
                .any(|value| value.to_str().is_ok_and(|value| value.contains(content)))
        };
        if !accepts("application/json") || !accepts("text/event-stream") {
            return bad_request(
                StatusCode::NOT_ACCEPTABLE,
                -32000,
                "Not Acceptable: Client must accept both application/json and text/event-stream",
            );
        }
        if !parts
            .headers
            .get(header::CONTENT_TYPE)
            .is_some_and(|value| {
                value
                    .to_str()
                    .is_ok_and(|value| value.contains("application/json"))
            })
        {
            return bad_request(
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                -32000,
                "Unsupported Media Type: Content-Type must be application/json",
            );
        }
        let Ok(body) = Limited::new(body, MAXIMUM_BODY).collect().await else {
            return bad_request(StatusCode::BAD_REQUEST, -32700, "Parse error: Invalid JSON");
        };
        let body = body.to_bytes();
        let Ok(frame) = parse_json_text(&String::from_utf8_lossy(&body)) else {
            return bad_request(StatusCode::BAD_REQUEST, -32700, "Parse error: Invalid JSON");
        };
        let messages = frame
            .as_array()
            .map_or(std::slice::from_ref(&frame), Vec::as_slice);
        if messages.len() > MAXIMUM_BATCH {
            return bad_request(
                StatusCode::PAYLOAD_TOO_LARGE,
                -32600,
                "Cantrip MCP batch exceeds the request limit",
            );
        }
        if !messages.iter().all(valid_message) {
            return bad_request(
                StatusCode::BAD_REQUEST,
                -32700,
                "Parse error: Invalid JSON-RPC message",
            );
        }
        if messages
            .iter()
            .any(|message| message["method"] == "initialize" && message.get("id").is_some())
        {
            if messages.len() > 1 {
                return bad_request(
                    StatusCode::BAD_REQUEST,
                    -32600,
                    "Invalid Request: Only one initialization request is allowed",
                );
            }
        } else if let Some(version) = parts.headers.get("mcp-protocol-version") {
            let supported = rpc::catalog()["protocol"]["supported"].as_array().unwrap();
            if !version
                .to_str()
                .is_ok_and(|version| supported.iter().any(|candidate| candidate == version))
            {
                let versions = supported
                    .iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join(", ");
                return bad_request(
                    StatusCode::BAD_REQUEST,
                    -32000,
                    &format!(
                        "Bad Request: Unsupported protocol version: {} (supported versions: {versions})",
                        String::from_utf8_lossy(version.as_bytes())
                    ),
                );
            }
        }

        let responses = futures::future::join_all(
            messages
                .iter()
                .filter(|frame| frame.get("id").is_some() && frame["method"].is_string())
                .map(|frame| self.mcp_reply(id, credential, frame, profile, &allowed)),
        )
        .await;
        match responses.len() {
            0 => empty(StatusCode::ACCEPTED),
            1 => json_response(StatusCode::OK, responses.into_iter().next().unwrap()),
            _ => json_response(StatusCode::OK, Value::Array(responses)),
        }
    }

    async fn mcp_reply(
        &self,
        binding: &JsString,
        credential: Option<&str>,
        frame: &Value,
        profile_name: &str,
        allowed: &[JsString],
    ) -> Value {
        let id = &frame["id"];
        let params = &frame["params"];
        let profile = &rpc::catalog()["profiles"][profile_name];
        match frame["method"].as_str().unwrap() {
            "initialize" => rpc::initialize(id, params, profile),
            "ping" => rpc::result(id, json!({})),
            "tools/list" => rpc::result(id, json!({"tools":available_tools(profile, allowed)})),
            "tools/call" => {
                let Some(name) = params["name"].as_str() else {
                    return rpc::rpc_error(id, -32602, "Invalid tool call parameters");
                };
                let payload = rpc::call(
                    async |operation, arguments| {
                        self.mcp_operation(binding, credential, operation, arguments)
                            .await
                    },
                    |name| allowed.iter().any(|allowed| allowed.as_str() == Some(name)),
                    profile_name == "standalone-web",
                    name,
                    params.get("arguments"),
                )
                .await;
                rpc::result(id, payload)
            }
            _ => rpc::rpc_error(id, -32601, "Method not found"),
        }
    }

    async fn mcp_operation(
        &self,
        binding: &JsString,
        credential: Option<&str>,
        operation: &str,
        arguments: Value,
    ) -> Result<Value, JsString> {
        let request = json!({
            "bindingId":binding,
            "request":json!({"operation":operation,"arguments":arguments}),
        });
        let invalid = || JsString::from("Cantrip MCP result validation failed.");
        let request = mcp_host::parse("cantripMcpBrokerOperationRequestSchema", Some(&request))
            .map_err(|_| invalid())?;
        let call = self.operate(binding, credential, &request["request"]);
        let result = if let Some(timeout) = operation_timeout(operation) {
            tokio::time::timeout(timeout, call)
                .await
                .map_err(|_| JsString::from("The operation was aborted due to timeout"))?
        } else {
            call.await
        }
        .map_err(|error| error.message)?;
        if result.stringify().len() >= MAXIMUM_RESPONSE {
            return Err("The MCP operation result exceeded the worker output limit.".into());
        }
        mcp_host::parse("cantripAgentOperationResultSchema", Some(&result)).map_err(|_| invalid())
    }
}

fn available_tools(profile: &Value, allowed: &[JsString]) -> Value {
    let mut tools = profile["tools"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|tool| {
            tool["name"]
                .as_js_string()
                .is_some_and(|name| allowed.contains(name))
        })
        .cloned()
        .collect::<Vec<_>>();
    let names = tools
        .iter()
        .map(|tool| tool["name"].clone())
        .collect::<Vec<_>>();
    if let Some(help) = tools.iter_mut().find(|tool| tool["name"] == "tool_help") {
        for field in ["tool", "toolName"] {
            help["inputSchema"]["properties"][field]["enum"] = json!(names);
        }
    }
    Value::Array(tools)
}

fn valid_message(frame: &Value) -> bool {
    if frame["jsonrpc"] != "2.0" {
        return false;
    }
    let id = frame.get("id");
    if frame["method"].is_string() {
        return id.is_none_or(|id| id.is_string() || id.as_i64().is_some())
            && frame.get("params").is_none_or(Value::is_object);
    }
    id.is_some_and(|id| id.is_string() || id.as_i64().is_some() || id.is_null())
        && (frame.get("result").is_some() || frame["error"].is_object())
}

fn empty(status: StatusCode) -> Reply {
    Response::builder()
        .status(status)
        .body(Default::default())
        .unwrap()
}

fn bad_request(status: StatusCode, code: i32, message: &str) -> Reply {
    json_response(status, rpc::rpc_error(&Value::Null, code, message))
}
