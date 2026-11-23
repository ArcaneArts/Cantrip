use super::super::{
    api::{self, member, text},
    issues::{login, nullable_string},
};
use super::parse::{bounded, crop, numeric, positive, side};
use anyhow::{Result, bail};
use cantrip_wire::{JsString, Value, coercion, value::json};

pub(super) fn nodes(value: Option<&Value>) -> &[Value] {
    value
        .and_then(|v| v.get("nodes"))
        .and_then(Value::as_array)
        .map_or(&[], Vec::as_slice)
}
fn comment(value: &Value, thread: &Value) -> Result<Option<Value>> {
    let id = positive(member(value, "databaseId")?)?;
    let path = value
        .get("path")
        .filter(|v| v.is_string())
        .or_else(|| thread.get("path"));
    let url = value.get("url").filter(|v| v.is_string());
    let created = nullable_string(value.get("createdAt"));
    let updated = nullable_string(value.get("updatedAt"));
    if id.is_null()
        || !path.is_some_and(|v| v.is_string())
        || !url.is_some_and(|v| coercion::truthy(Some(v)))
        || !coercion::truthy(Some(&created))
        || !coercion::truthy(Some(&updated))
    {
        return Ok(None);
    }
    let line = positive(value.get("line"))?;
    let start = positive(value.get("startLine"))?;
    Ok(Some(
        json!({"id":id,"reviewId":positive(value.get("pullRequestReview").and_then(|v|v.get("databaseId")))?,"author":login(value.get("author")),
        "body":bounded(value.get("body"),1_000_000),"url":url.unwrap(),"path":path.unwrap(),
        "line":if line.is_null(){positive(thread.get("line"))?}else{line},"side":side(thread.get("diffSide")),
        "startLine":if start.is_null(){positive(thread.get("startLine"))?}else{start},"startSide":side(thread.get("startDiffSide")),
        "diffHunk":bounded(value.get("diffHunk"),100_000),"inReplyToId":positive(value.get("replyTo").and_then(|v|v.get("databaseId")))?,"createdAt":created,"updatedAt":updated,
        "pending":text(value.get("pullRequestReview").and_then(|v|v.get("state")))?.lossy().to_uppercase()=="PENDING"}),
    ))
}
pub fn context(value: &Value) -> Result<Value> {
    let data = member(value, "data")?;
    let viewer = data
        .and_then(|v| v.get("viewer"))
        .and_then(|v| v.get("login"));
    let pull = data
        .and_then(|v| v.get("repository"))
        .and_then(|v| v.get("pullRequest"));
    if !viewer.is_some_and(|v| v.is_string() && coercion::truthy(Some(v)))
        || !pull
            .and_then(|v| v.get("id"))
            .is_some_and(|v| v.is_string() && coercion::truthy(Some(v)))
    {
        bail!("GitHub returned an invalid pull request review context.");
    }
    let pull = pull.unwrap();
    let viewer = viewer.unwrap();
    let mut pending = None;
    for value in nodes(pull.get("reviews")) {
        if text(member(value, "state")?)?.lossy().to_uppercase() == "PENDING"
            && value.get("author").and_then(|v| v.get("login")) == Some(viewer)
        {
            pending = Some(value);
            break;
        }
    }
    let mut truncated = false;
    let mut threads = Vec::new();
    for thread in nodes(pull.get("reviewThreads")) {
        if !member(thread, "id")?.is_some_and(|v| v.is_string())
            || !thread.get("path").is_some_and(|v| v.is_string())
        {
            continue;
        }
        let mut comments = Vec::new();
        for value in nodes(thread.get("comments")) {
            if let Some(value) = comment(value, thread)? {
                comments.push(value);
            }
        }
        if numeric(thread.get("comments").and_then(|v| v.get("totalCount")))?
            > comments.len() as f64
        {
            truncated = true;
        }
        if comments.is_empty() {
            continue;
        }
        threads.push(json!({"id":thread["id"],"path":thread["path"],"line":positive(thread.get("line"))?,"side":side(thread.get("diffSide")),
            "startLine":positive(thread.get("startLine"))?,"startSide":side(thread.get("startDiffSide")),"resolved":thread.get("isResolved").filter(|v|v.is_boolean()).cloned().unwrap_or(Value::Null),
            "outdated":thread["isOutdated"]==true,"viewerCanResolve":thread["viewerCanResolve"]==true,"viewerCanUnresolve":thread["viewerCanUnresolve"]==true,"comments":comments.into_iter().take(100).collect::<Vec<_>>()}));
    }
    truncated = truncated
        || numeric(pull.get("reviewThreads").and_then(|v| v.get("totalCount")))?
            > threads.len() as f64;
    let auto = pull.get("autoMergeRequest");
    let enabled = nullable_string(auto.and_then(|v| v.get("enabledAt")));
    let method = text(auto.and_then(|v| v.get("mergeMethod")))?.lowercase();
    let auto = if coercion::truthy(Some(&enabled))
        && matches!(method.as_str(), Some("merge" | "squash" | "rebase"))
    {
        json!({"enabledAt":enabled,"method":method})
    } else {
        Value::Null
    };
    let queue = pull.get("mergeQueueEntry").filter(|v| {
        v.get("id").is_some_and(|v| v.is_string()) && v.get("state").is_some_and(|v| v.is_string())
    });
    let queue = if let Some(queue) = queue {
        let position = numeric(queue.get("position"))?;
        json!({"id":queue["id"],"position":if position.is_finite()&&position.fract()==0.0&&position>=0.0{json!(position)}else{Value::Null},"state":queue["state"].as_js_string().unwrap().lowercase()})
    } else {
        Value::Null
    };
    let pending =
        if let Some(value) = pending.filter(|v| v.get("id").is_some_and(|v| v.is_string())) {
            let count = numeric(value.get("comments").and_then(|v| v.get("totalCount")))?;
            json!({"id":value["id"],"commentCount":if count.is_nan()||count<0.0{0.0}else{count}})
        } else {
            Value::Null
        };
    Ok(
        json!({"nodeId":pull["id"],"viewerLogin":viewer,"pendingReview":pending,"autoMerge":auto,"mergeQueueEnabled":pull["isMergeQueueEnabled"]==true,"mergeQueueEntry":queue,
        "reviewThreads":threads.into_iter().take(100).collect::<Vec<_>>(),"reviewThreadsTruncated":truncated}),
    )
}
pub(super) fn viewed(value: &Value) -> Result<Value> {
    let nodes = member(value, "data")?
        .and_then(|v| v.get("repository"))
        .and_then(|v| v.get("pullRequest"))
        .and_then(|v| v.get("files"))
        .and_then(|v| v.get("nodes"))
        .and_then(Value::as_array);
    let Some(nodes) = nodes else {
        bail!("GitHub returned invalid pull request file review state.");
    };
    let mut result = cantrip_wire::value::Object::new();
    for node in nodes {
        if let Some(path) = member(node, "path")?.and_then(Value::as_js_string) {
            result.insert(path.clone(), json!(node["viewerViewedState"] == "VIEWED"));
        }
    }
    Ok(Value::Object(result))
}
pub fn group(comments: &[Value]) -> Result<Value> {
    let mut roots = indexmap::IndexMap::<JsString, Vec<Value>>::new();
    let mut root_for = indexmap::IndexMap::new();
    for comment in comments {
        if comment["inReplyToId"].is_null() {
            let id = text(Some(&comment["id"]))?;
            roots.insert(id.clone(), vec![comment.clone()]);
            root_for.insert(id.clone(), id);
        }
    }
    for comment in comments {
        if comment["inReplyToId"].is_null() {
            continue;
        }
        let id = text(Some(&comment["id"]))?;
        let parent = text(Some(&comment["inReplyToId"]))?;
        let root = root_for.get(&parent).cloned().unwrap_or(parent);
        if let Some(thread) = roots.get_mut(&root) {
            thread.push(comment.clone());
            root_for.insert(id, root);
        } else {
            roots.insert(id.clone(), vec![comment.clone()]);
            root_for.insert(id.clone(), id);
        }
    }
    Ok(json!(roots.into_iter().take(100).map(|(id,comments)| {
        let root=&comments[0];json!({"id":id,"path":root["path"],"line":root["line"],"side":root["side"],"startLine":root["startLine"],"startSide":root["startSide"],
            "resolved":Value::Null,"outdated":false,"viewerCanResolve":false,"viewerCanUnresolve":false,"comments":comments.iter().take(100).cloned().collect::<Vec<_>>()})
    }).collect::<Vec<_>>()))
}
pub(super) fn warning(section: &str, error: &anyhow::Error) -> Value {
    let message = crate::error::message(error);
    let message = if message.is_empty() {
        "GitHub request failed.".into()
    } else {
        message
    };
    warning_text(section, &message)
}
pub(super) async fn query(
    document: &str,
    repository: &JsString,
    number: &Value,
    scope: &crate::filesystem::Scope,
) -> Result<Value> {
    api::repository_path(repository)?;
    let (owner, name) = repository.as_str().unwrap().split_once('/').unwrap();
    api::request(
        "graphql",
        &[
            "-f".into(),
            format!("query={document}").into(),
            "-f".into(),
            format!("owner={owner}").into(),
            "-f".into(),
            format!("repository={name}").into(),
            "-F".into(),
            api::prefix("number=", &text(Some(number))?),
        ],
        scope,
    )
    .await
}

pub(super) fn warning_text(section: &str, message: &JsString) -> Value {
    let message = if message.is_empty() {
        "GitHub request failed.".into()
    } else {
        message.clone()
    };
    json!({"section":section,"message":crop(&message,1000)})
}
