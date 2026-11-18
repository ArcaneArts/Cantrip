//! Raw documents selected by the actual native item variant.
use super::*;
// Raw capture visits explicit JavaScript object fields before JSON serialization.
// An absent RPC field becomes the text "undefined", rather than disappearing.
fn raw_copy(target: &mut Value, source: &Value, keys: &[&str]) {
    for key in keys {
        target[key] = source.get(key).cloned().unwrap_or_else(|| s("undefined"));
    }
}
pub(super) fn capture(item: &Value, telemetry: &Value) -> Result<Value> {
    let kind = item["type"].as_str().unwrap_or("");
    let mut metadata = obj([
        ("itemId", item["id"].clone()),
        ("itemType", item["type"].clone()),
    ]);
    let (request, response) = match kind {
        "commandExecution" => {
            let mut request = obj([]);
            raw_copy(&mut request, item, &["command", "cwd"]);
            let mut response = obj([("durationMs", item["durationMs"].clone())]);
            raw_copy(&mut response, item, &["exitCode"]);
            response["output"] = telemetry["commandOutput"]
                .get("output")
                .filter(|v| !v.is_null())
                .or(item.get("aggregatedOutput"))
                .cloned()
                .unwrap_or_else(|| s("undefined"));
            response["outputTruncated"] = telemetry["commandOutput"]
                .get("truncated")
                .filter(|v| !v.is_null())
                .cloned()
                .unwrap_or(Value::Bool(false));
            raw_copy(&mut response, item, &["status"]);
            (Some(request), Some(response))
        }
        "fileChange" => {
            let mut request = obj([]);
            raw_copy(&mut request, item, &["changes"]);
            let changes = array(&item["changes"])?
                .iter()
                .map(|change| {
                    let mut v = obj([]);
                    v["kind"] = change["kind"]
                        .get("type")
                        .cloned()
                        .unwrap_or_else(|| s("undefined"));
                    raw_copy(&mut v, change, &["path"]);
                    v
                })
                .collect();
            let mut response = obj([("changes", Value::Array(changes))]);
            raw_copy(&mut response, item, &["status"]);
            (Some(request), Some(response))
        }
        "plan" => {
            let mut response = obj([]);
            raw_copy(&mut response, item, &["text"]);
            (None, Some(response))
        }
        "reasoning" => {
            let mut response = obj([]);
            raw_copy(&mut response, item, &["content", "summary"]);
            (None, Some(response))
        }
        "mcpToolCall" => {
            let mut response = obj([]);
            raw_copy(&mut response, item, &["error", "result", "status"]);
            metadata["server"] = item["server"].clone();
            metadata["tool"] = item["tool"].clone();
            (item.get("arguments").cloned(), Some(response))
        }
        "dynamicToolCall" => {
            let mut response = obj([]);
            raw_copy(&mut response, item, &["durationMs", "status", "success"]);
            metadata["namespace"] = item["namespace"].clone();
            metadata["tool"] = item["tool"].clone();
            (None, Some(response))
        }
        "collabAgentToolCall" => {
            let mut request = obj([]);
            raw_copy(
                &mut request,
                item,
                &["model", "prompt", "receiverThreadIds", "senderThreadId"],
            );
            let mut response = obj([]);
            response["agentStates"] = item
                .get("agentsStates")
                .cloned()
                .unwrap_or_else(|| s("undefined"));
            raw_copy(&mut response, item, &["status"]);
            metadata["tool"] = item["tool"].clone();
            (Some(request), Some(response))
        }
        "subAgentActivity" => {
            let mut response = obj([]);
            raw_copy(&mut response, item, &["agentPath", "agentThreadId", "kind"]);
            (None, Some(response))
        }
        "webSearch" => {
            let mut request = obj([]);
            raw_copy(&mut request, item, &["query"]);
            let mut response = obj([]);
            raw_copy(&mut response, item, &["action"]);
            (Some(request), Some(response))
        }
        "imageView" => {
            let mut request = obj([]);
            raw_copy(&mut request, item, &["path"]);
            (Some(request), None)
        }
        "enteredReviewMode" | "exitedReviewMode" => {
            let mut request = obj([]);
            raw_copy(&mut request, item, &["review"]);
            (Some(request), None)
        }
        "contextCompaction" => (None, None),
        _ => return Ok(Value::Null),
    };
    raw::envelope(
        request.as_ref().map(raw::Input::Json),
        response.as_ref().map(raw::Input::Json),
        &metadata,
    )
}
