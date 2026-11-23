use super::super::{
    api::{member, number, string, text},
    issues::{count_field, login, nullable_string, parse_issue},
};
use anyhow::Result;
use cantrip_crypto::checked;
use cantrip_wire::{JsString, Value, coercion, value::json};

pub(super) fn crop(value: &JsString, maximum: usize) -> JsString {
    JsString::new(value.units().iter().take(maximum).copied().collect())
}
pub(super) fn bounded(value: Option<&Value>, maximum: usize) -> Value {
    Value::String(
        value
            .and_then(Value::as_js_string)
            .map_or_else(|| "".into(), |value| crop(value, maximum)),
    )
}
pub(super) fn url(value: Option<&Value>) -> Value {
    value
        .and_then(Value::as_js_string)
        .filter(|value| {
            value
                .units()
                .starts_with(&"http://".encode_utf16().collect::<Vec<_>>())
                || value
                    .units()
                    .starts_with(&"https://".encode_utf16().collect::<Vec<_>>())
        })
        .cloned()
        .map(Value::String)
        .unwrap_or(Value::Null)
}
pub(super) fn numeric(value: Option<&Value>) -> Result<f64> {
    coercion::number(value).map_err(|_| anyhow::anyhow!("Cannot convert object to primitive value"))
}
pub(super) fn positive(value: Option<&Value>) -> Result<Value> {
    let value = numeric(value)?;
    Ok(
        if value.is_finite() && value.fract() == 0.0 && value > 0.0 {
            Value::Number(value)
        } else {
            Value::Null
        },
    )
}
pub(super) fn side(value: Option<&Value>) -> Value {
    value
        .filter(|value| **value == "LEFT" || **value == "RIGHT")
        .cloned()
        .unwrap_or(Value::Null)
}
pub(super) fn summary(value: &Value) -> Result<Value> {
    member(value, "head")?;
    let mut result = parse_issue(value)?;
    for (prefix, field) in [("head", "head"), ("base", "base")] {
        let branch = value
            .get(field)
            .filter(|value| value.is_object() || value.is_array());
        result[&format!("{prefix}Ref")] = branch
            .and_then(|v| v.get("ref"))
            .filter(|v| v.is_string())
            .cloned()
            .unwrap_or_else(|| json!("unknown"));
        result[&format!("{prefix}Sha")] = branch
            .and_then(|v| v.get("sha"))
            .filter(|v| v.is_string())
            .cloned()
            .unwrap_or_else(|| json!(""));
    }
    result["body"] = nullable_string(value.get("body"));
    result["draft"] = json!(value["draft"] == true);
    result["merged"] =
        json!(value["merged"] == true || value.get("merged_at").is_some_and(|v| v.is_string()));
    result["mergeable"] = value
        .get("mergeable")
        .filter(|v| v.is_boolean())
        .cloned()
        .unwrap_or(Value::Null);
    result["reviewDecision"] = json!("none");
    result["checksState"] = json!("unknown");
    checked("githubPullRequestSummarySchema", &result)
}
pub(super) fn commit(value: &Value) -> Result<Value> {
    let sha = string(value, "sha")?;
    let empty = json!({});
    let commit = value
        .get("commit")
        .filter(|v| v.is_object() || v.is_array())
        .unwrap_or(&empty);
    let author = commit
        .get("author")
        .filter(|v| v.is_object() || v.is_array())
        .unwrap_or(&empty);
    Ok(
        json!({"sha":sha,"shortSha":crop(sha.as_js_string().unwrap(),7),"message":bounded(commit.get("message"),1_000_000),
        "author":author.get("name").filter(|v|v.is_string()&&coercion::truthy(Some(v))).cloned().unwrap_or_else(||login(value.get("author"))),
        "authoredAt":nullable_string(author.get("date")),"url":string(value,"html_url")?}),
    )
}
pub(super) fn file(value: &Value) -> Result<Value> {
    let patch = member(value, "patch")?.filter(|value| value.is_string());
    Ok(
        json!({"sha":string(value,"sha")?,"path":string(value,"filename")?,"previousPath":nullable_string(value.get("previous_filename")),
        "status":string(value,"status")?,"additions":count_field(value,"additions")?,"deletions":count_field(value,"deletions")?,"changes":count_field(value,"changes")?,
        "blobUrl":string(value,"blob_url")?,"rawUrl":url(value.get("raw_url")),"patch":patch.map(|v|bounded(Some(v),1_000_000)).unwrap_or(Value::Null),
        "patchTruncated":patch.is_some_and(|v|v.as_js_string().unwrap().len()>1_000_000),"viewed":Value::Null}),
    )
}
pub(super) fn check_run(value: &Value) -> Result<Value> {
    let output = member(value, "output")?.filter(|v| v.is_object() || v.is_array());
    let mut combined = Vec::new();
    for field in ["title", "summary", "text"] {
        if let Some(part) = output
            .and_then(|v| v.get(field))
            .and_then(Value::as_js_string)
            .filter(|v| !v.is_empty())
        {
            if !combined.is_empty() {
                combined.extend([10, 10]);
            }
            combined.extend(part.units());
        }
    }
    let combined = crop(&JsString::new(combined), 100_000);
    let status = text(value.get("status"))?.lowercase();
    let details = url(value.get("details_url"));
    Ok(
        json!({"id":string(value,"id")?,"name":string(value,"name")?,"source":"check-run",
        "status":match status.as_str() {Some("completed")=>"completed",Some("in_progress")=>"in-progress",_=>"queued"},
        "conclusion":nullable_string(value.get("conclusion")),"url":if details.is_null(){url(value.get("html_url"))}else{details},
        "startedAt":nullable_string(value.get("started_at")),"completedAt":nullable_string(value.get("completed_at")),
        "summary":if combined.is_empty(){Value::Null}else{Value::String(combined)}}),
    )
}
pub(super) fn status(value: &Value) -> Result<Value> {
    let state = text(member(value, "state")?)?.lowercase();
    let pending = state.as_str() == Some("pending");
    Ok(
        json!({"id":super::super::api::prefix("status-",&text(value.get("id"))?),"name":string(value,"context")?,"source":"commit-status",
        "status":if pending{"in-progress"}else{"completed"},"conclusion":if pending{Value::Null}else{Value::String(state)},
        "url":url(value.get("target_url")),"startedAt":nullable_string(value.get("created_at")),"completedAt":if pending{Value::Null}else{nullable_string(value.get("updated_at"))},
        "summary":value.get("description").filter(|v|v.is_string()).map(|v|bounded(Some(v),100_000)).unwrap_or(Value::Null)}),
    )
}
pub(super) fn review(value: &Value) -> Result<Value> {
    let sha = member(value, "commit_id")?
        .and_then(Value::as_str)
        .filter(|sha| {
            sha.len() == 40
                && sha
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        });
    let state = text(value.get("state"))?.lossy().to_uppercase();
    Ok(
        json!({"id":string(value,"id")?,"author":login(value.get("user")),"state":match state.as_str(){"APPROVED"=>"approved","CHANGES_REQUESTED"=>"changes-requested","DISMISSED"=>"dismissed","PENDING"=>"pending",_=>"commented"},
        "body":bounded(value.get("body"),1_000_000),"commitSha":sha.map_or(Value::Null,|sha|json!(sha)),"submittedAt":nullable_string(value.get("submitted_at")),"url":url(value.get("html_url"))}),
    )
}
pub(super) fn review_comment(value: &Value) -> Result<Value> {
    Ok(
        json!({"id":number(value,"id")?,"reviewId":positive(value.get("pull_request_review_id"))?,"author":login(value.get("user")),"body":bounded(value.get("body"),1_000_000),
        "url":string(value,"html_url")?,"path":string(value,"path")?,"line":positive(value.get("line"))?,"side":side(value.get("side")),
        "startLine":positive(value.get("start_line"))?,"startSide":side(value.get("start_side")),"diffHunk":bounded(value.get("diff_hunk"),100_000),
        "inReplyToId":positive(value.get("in_reply_to_id"))?,"createdAt":string(value,"created_at")?,"updatedAt":string(value,"updated_at")?,"pending":false}),
    )
}
pub(super) fn review_decision(reviews: &[Value], requested: &[Value]) -> &'static str {
    let mut latest = indexmap::IndexMap::new();
    for review in reviews {
        if matches!(
            review["state"].as_str(),
            Some("approved" | "changes-requested" | "dismissed")
        ) {
            latest.insert(
                review["author"].as_js_string().unwrap(),
                review["state"].as_str().unwrap(),
            );
        }
    }
    if latest.values().any(|v| *v == "changes-requested") {
        "changes-requested"
    } else if latest.values().any(|v| *v == "approved") {
        "approved"
    } else if !requested.is_empty() {
        "review-required"
    } else if !reviews.is_empty() {
        "reviewed"
    } else {
        "none"
    }
}
pub(super) fn checks_state(checks: &[Value]) -> &'static str {
    if checks.is_empty() {
        "none"
    } else if checks.iter().any(|check| {
        matches!(
            check["conclusion"].as_str(),
            Some("failure" | "error" | "timed_out" | "cancelled" | "action_required")
        )
    }) {
        "failure"
    } else if checks.iter().any(|check| check["status"] != "completed") {
        "pending"
    } else if checks.iter().all(|check| check["conclusion"] == "success") {
        "success"
    } else {
        "neutral"
    }
}
