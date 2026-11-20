//! App-server requests and Cantrip's shared interaction contract.
use crate::{http::checked, native_items::concat};
use anyhow::{Context, Result};
use cantrip_wire::{JsString, Value, value::json};
use std::time::Duration;

const TIMEOUT_MS: u64 = 30 * 60 * 1000;
const DECISIONS: &[&str] = &[
    "accept",
    "acceptForSession",
    "acceptWithExecpolicyAmendment",
    "applyNetworkPolicyAmendment",
    "decline",
    "cancel",
];

pub(in crate::codex) fn kind(method: &Value) -> Option<&'static str> {
    match method.as_str()? {
        "item/commandExecution/requestApproval" => Some("commandExecution"),
        "item/fileChange/requestApproval" => Some("fileChange"),
        "item/permissions/requestApproval" => Some("permissions"),
        "item/tool/requestUserInput" => Some("userInput"),
        "mcpServer/elicitation/request" => Some("mcpElicitation"),
        _ => None,
    }
}

pub(super) fn native_id(id: &Value) -> JsString {
    let (prefix, value) = match id.as_js_string() {
        Some(text) => ("string:", text.clone()),
        None => ("number:", id.stringify().into()),
    };
    concat(&[prefix.into(), value])
}

fn decisions(value: &Value) -> Value {
    let Some(items) = value.as_array() else {
        return Value::Null;
    };
    json!(
        items
            .iter()
            .filter_map(|item| {
                if let Some(name) = item.as_str().filter(|name| DECISIONS.contains(name)) {
                    Some(name)
                } else {
                    [
                        "acceptWithExecpolicyAmendment",
                        "applyNetworkPolicyAmendment",
                    ]
                    .into_iter()
                    .find(|key| item.get(*key).is_some())
                }
            })
            .collect::<Vec<_>>()
    )
}

pub(super) fn request(frame: &Value, generation: &str) -> Result<(Value, Duration)> {
    let kind = kind(&frame["method"]).context("Unknown native interaction method.")?;
    let p = &frame["params"];
    let mut payload = json!({"kind":kind});
    let fields: &[&str] = match kind {
        "commandExecution" => &[
            "startedAtMs",
            "approvalId",
            "environmentId",
            "reason",
            "command",
            "cwd",
            "commandActions",
            "networkApprovalContext",
            "additionalPermissions",
            "proposedExecpolicyAmendment",
            "proposedNetworkPolicyAmendments",
        ],
        "fileChange" => &["startedAtMs", "reason", "grantRoot"],
        "permissions" => &["startedAtMs", "environmentId", "cwd", "reason"],
        "userInput" => &["questions", "autoResolutionMs"],
        _ => &[
            "serverName",
            "mode",
            "message",
            "requestedSchema",
            "url",
            "elicitationId",
        ],
    };
    for key in fields {
        payload[*key] = p[*key].clone();
    }
    match kind {
        "commandExecution" => payload["availableDecisions"] = decisions(&p["availableDecisions"]),
        "permissions" => {
            payload["requestedPermissions"] = p
                .get("permissions")
                .context("The native request has no requested permissions.")?
                .clone();
        }
        "mcpElicitation" => payload["metadata"] = p["_meta"].clone(),
        _ => {}
    }
    let timeout = if kind == "userInput" {
        p["autoResolutionMs"]
            .as_u64()
            .unwrap_or(TIMEOUT_MS)
            .min(TIMEOUT_MS)
    } else {
        TIMEOUT_MS
    };
    let expires = chrono::Utc::now() + chrono::Duration::milliseconds(timeout as i64);
    let key = concat(&[
        format!("codex:{generation}:").into(),
        native_id(&frame["id"]),
    ]);
    let event = checked(
        "workerEventSchema",
        &json!({
            "type":"agent.interaction.requested",
            "request":json!({
                "requestKey":key, "threadId":p["threadId"], "turnId":p["turnId"],
                "itemId":if kind == "mcpElicitation" {Value::Null} else {p["itemId"].clone()},
                "payload":payload, "expiresAt":expires.to_rfc3339_opts(chrono::SecondsFormat::Millis,true),
            }),
        }),
    )?;
    let request = event["request"].clone();
    Ok((request, Duration::from_millis(timeout)))
}

pub(super) fn result(response: &Value) -> Result<Value> {
    let result = match response["kind"].as_str() {
        Some("commandExecution") if response["decision"] == "acceptWithExecpolicyAmendment" => {
            anyhow::ensure!(
                response["execpolicyAmendment"].is_array(),
                "Missing execpolicy amendment."
            );
            json!({"decision":json!({"acceptWithExecpolicyAmendment":json!({"execpolicy_amendment":response["execpolicyAmendment"]})})})
        }
        Some("commandExecution") if response["decision"] == "applyNetworkPolicyAmendment" => {
            anyhow::ensure!(
                response["networkPolicyAmendment"].is_object(),
                "Missing network policy amendment."
            );
            json!({"decision":json!({"applyNetworkPolicyAmendment":json!({"network_policy_amendment":response["networkPolicyAmendment"]})})})
        }
        Some("commandExecution" | "fileChange") => json!({"decision":response["decision"]}),
        Some("permissions") => {
            json!({"permissions":response["permissions"],"scope":response["scope"],"strictAutoReview":response["strictAutoReview"]})
        }
        Some("userInput") => json!({"answers":response["answers"]}),
        Some("mcpElicitation") => {
            json!({"action":response["action"],"content":response["content"],"_meta":response["metadata"]})
        }
        _ => anyhow::bail!("Unknown native interaction response."),
    };
    Ok(result)
}

// Preserve the native response on the wire and normalize only the public resolution.
pub(super) fn response(kind: &str, result: Option<&Value>) -> Option<Value> {
    let mut response = result.filter(|result| result.is_object())?.clone();
    response["kind"] = json!(kind);
    match kind {
        "commandExecution" => {
            let decision = response["decision"].clone();
            for (name, native, public) in [
                (
                    "acceptWithExecpolicyAmendment",
                    "execpolicy_amendment",
                    "execpolicyAmendment",
                ),
                (
                    "applyNetworkPolicyAmendment",
                    "network_policy_amendment",
                    "networkPolicyAmendment",
                ),
            ] {
                if let Some(amendment) = decision[name].get(native) {
                    response["decision"] = json!(name);
                    response[public] = amendment.clone();
                    break;
                }
            }
        }
        "mcpElicitation" => response["metadata"] = response["_meta"].clone(),
        _ => {}
    }
    checked(
        "agentInteractionResolutionCreateSchema",
        &json!({"idempotencyKey":"native", "response":response}),
    )
    .ok()
    .map(|parsed| parsed["response"].clone())
}

pub(in crate::codex) fn deny(id: &Value, kind: &str, reason: &JsString) -> Value {
    let result = match kind {
        "commandExecution" | "fileChange" => json!({"decision":"cancel"}),
        "permissions" => json!({"permissions":{},"scope":"turn","strictAutoReview":false}),
        "mcpElicitation" => json!({"action":"cancel","content":Value::Null,"_meta":Value::Null}),
        _ => return json!({"id":id,"error":json!({"code":-32000,"message":reason})}),
    };
    json!({"id":id,"result":result})
}
