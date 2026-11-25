//! Convert a terminal turn diagnostic into an encrypted transcript activity.
use crate::codex::provider_errors::{context_window_exceeded, safe_endpoint};
use cantrip_wire::{JsString, Value, value::json};
use regress::Regex;
use std::sync::LazyLock;

const ITEM_ID: &str = "cantrip:turn-failure";
const ITEM_TYPE: &str = "cantripTurnFailure";
static TOKEN_COUNTS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::with_flags(
        r"request\s*\(\s*([0-9][0-9,]{0,19})\s+tokens?\s*\)\s+exceeds\s+the\s+available\s+context\s+size\s*\(\s*([0-9][0-9,]{0,19})\s+tokens?\s*\)",
        "i",
    )
    .unwrap()
});

fn token_counts(message: &JsString) -> Option<(u64, u64)> {
    let matched = TOKEN_COUNTS.find_from_utf16(message.units(), 0).next()?;
    let count = |index| {
        JsString::new(message.units()[matched.group(index)?].to_vec())
            .as_str()?
            .replace(',', "")
            .parse::<u64>()
            .ok()
    };
    let (requested, available) = (count(1)?, count(2)?);
    (available > 0 && requested > available).then_some((requested, available))
}

fn notice(turn: &Value) -> Value {
    let error = &turn["body"]["error"];
    let message = error["message"]
        .as_js_string()
        .or_else(|| error.as_js_string());
    let diagnostics = [message, error["additionalDetails"].as_js_string()];
    let counts = diagnostics.into_iter().flatten().find_map(token_counts);
    let context_limit = counts.is_some()
        || error["codexErrorInfo"] == "contextWindowExceeded"
        || diagnostics
            .into_iter()
            .flatten()
            .any(context_window_exceeded);
    let (title, details, reason) = if context_limit {
        let advice = "Try starting a new chat or using a model with a larger context window.";
        let details = counts.map_or_else(
            || advice.to_owned(),
            |(requested, available)| {
                format!("The request needed {requested} tokens, but the model allows {available}. {advice}")
            },
        );
        (
            "Model context limit exceeded",
            json!(details),
            json!("contextWindowExceeded"),
        )
    } else {
        (
            "Turn failed",
            json!(message.map(safe_endpoint)),
            Value::Null,
        )
    };
    json!({
        "type":"notice",
        "id":format!("turn:{}:failure", turn["id"].as_js_string().unwrap()),
        "status":"failed",
        "level":"error",
        "message":title,
        "details":details,
        "reasonCode":reason,
        "willRetry":false,
    })
}

pub(in crate::history) fn is_item(item: &Value) -> bool {
    item["identityKind"] == "legacy" && item["id"] == ITEM_ID && item["body"]["type"] == ITEM_TYPE
}

pub(in crate::history) fn item(turn: &Value, ordinal: usize) -> Option<Value> {
    // An observed terminal result is authoritative even if a later snapshot disagrees.
    (turn["terminalNotification"] == "failed").then(|| {
        let body = json!({"type":ITEM_TYPE,"notice":notice(turn)});
        json!({
            "id":ITEM_ID,
            "identityKind":"legacy",
            "ordinal":ordinal,
            "revision":1,
            "body":body,
            "lifecycle":"completed",
            "completeBody":true,
            "origin":turn["origin"],
            "startedAtMs":Value::Null,
            "completedAtMs":Value::Null,
            "conflicts":Vec::<Value>::new(),
        })
    })
}
