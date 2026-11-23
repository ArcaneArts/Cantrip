use super::super::{api, common::*, issues};
use super::{Notice, cutoff};
use anyhow::Result;
use cantrip_crypto::checked;
use cantrip_wire::{Value, value::json};
pub(super) fn nodes(value: &Value) -> &[Value] {
    array(&value["nodes"])
}
pub(super) fn item(
    value: &Value,
    viewer: &Value,
    notice: Option<&Notice>,
) -> Result<Option<Value>> {
    let kind = match value["__typename"].as_str() {
        Some("PullRequest") => "pull-request",
        Some("Issue") => "issue",
        _ => return Ok(None),
    };
    let assignees = nodes(&value["assignees"])
        .iter()
        .map(|value| issues::login(Some(value)))
        .filter(|login| *login != "ghost")
        .take(100)
        .collect::<Vec<_>>();
    let mut attention = Vec::<Value>::new();
    if let Some(notice) = notice {
        if notice.unread {
            attention.push(json!("unread"));
        }
        if notice.reason.lossy() == "mention" || notice.reason.lossy() == "team_mention" {
            attention.push(json!("mention"));
        }
        if notice.reason.lossy() == "review_requested" {
            attention.push(json!("review-requested"));
        }
        if notice.reason.lossy() == "assign" {
            attention.push(json!("assigned"));
        }
    }
    if assignees.contains(viewer) {
        attention.push(json!("assigned"));
    }
    let updated = api::string(value, "updatedAt")?;
    if crop(updated.as_js_string().unwrap(), 10).units()
        < cutoff().encode_utf16().collect::<Vec<_>>().as_slice()
    {
        attention.push(json!("stale"));
    }
    let pull = if kind == "pull-request" {
        let last = nodes(&value["commits"]).last();
        let rollup = last
            .and_then(|last| last.get("commit"))
            .and_then(|commit| commit.get("statusCheckRollup"));
        let checks = match rollup.and_then(|rollup| rollup.get("state")) {
            None => "none",
            Some(state) => match state.as_str() {
                Some("SUCCESS") => "success",
                Some("FAILURE" | "ERROR") => "failure",
                Some("EXPECTED" | "PENDING") => "pending",
                _ => "neutral",
            },
        };
        let mergeable = match value["mergeable"].as_str() {
            Some("MERGEABLE") => "mergeable",
            Some("CONFLICTING") => "conflicting",
            _ => "unknown",
        };
        let review = match value["reviewDecision"].as_str() {
            Some("APPROVED") => "approved",
            Some("CHANGES_REQUESTED") => "changes-requested",
            Some("REVIEW_REQUIRED") => "review-required",
            _ => "none",
        };
        if nodes(&value["reviewRequests"]).iter().any(|request| {
            request["requestedReviewer"]
                .get("login")
                .filter(|login| login.is_string())
                == Some(viewer)
        }) {
            attention.push(json!("review-requested"));
        }
        if checks == "failure" {
            attention.push(json!("failed-checks"));
        }
        if mergeable == "conflicting" {
            attention.push(json!("merge-conflict"));
        }
        if value["isDraft"] != true
            && review == "approved"
            && mergeable == "mergeable"
            && !["failure", "pending"].contains(&checks)
        {
            attention.push(json!("approved-ready"));
        }
        json!({"draft":value["isDraft"]==true,"headRef":value.get("headRefName").filter(|v|v.is_string()).cloned().unwrap_or_else(||json!("unknown")),"baseRef":value.get("baseRefName").filter(|v|v.is_string()).cloned().unwrap_or_else(||json!("unknown")),"mergeable":mergeable,"reviewDecision":review,"checksState":checks})
    } else {
        Value::Null
    };
    let mut unique = Vec::new();
    for item in attention {
        if !unique.contains(&item) {
            unique.push(item);
        }
    }
    let labels = nodes(&value["labels"])
        .iter()
        .filter_map(|label| {
            let name = label.get("name").filter(|v| v.is_string())?;
            let color = label.get("color").filter(|v| v.is_string())?;
            Some(json!({"name":name,"color":color}))
        })
        .collect::<Vec<_>>();
    checked(
        "githubInboxItemSchema",
        &object([
            ("number", api::number(value, "number")?),
            ("title", api::string(value, "title")?),
            (
                "state",
                json!(if value["state"] == "OPEN" {
                    "open"
                } else {
                    "closed"
                }),
            ),
            ("url", api::string(value, "url")?),
            ("author", issues::login(value.get("author"))),
            (
                "commentCount",
                if value["comments"].get("totalCount").is_some() {
                    fallback_number(&value["comments"], "totalCount", 0.0)?
                } else {
                    json!(0)
                },
            ),
            ("labels", json!(labels)),
            ("createdAt", api::string(value, "createdAt")?),
            ("updatedAt", updated),
            ("closedAt", nullable(value.get("closedAt"))),
            ("kind", json!(kind)),
            ("assignees", json!(assignees)),
            ("attention", json!(unique)),
            ("pullRequest", pull),
        ]),
    )
    .map(Some)
}
