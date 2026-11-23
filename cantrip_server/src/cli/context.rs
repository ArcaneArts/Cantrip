use super::{Error, concat, is_mutation};
use crate::wire::{JsString, Value, coercion::truthy, value::json};
use anyhow::{Context, Result};
use futures::{FutureExt, future::BoxFuture};
use std::sync::Arc;
use std::task::Poll;

pub trait Reader: Send + Sync {
    fn chat<'a>(&'a self, id: &'a Value) -> BoxFuture<'a, Result<Option<Value>>>;
    fn thread<'a>(
        &'a self,
        worker: &'a Value,
        thread: &'a Value,
    ) -> BoxFuture<'a, Result<Vec<Value>>>;
    fn terminal<'a>(&'a self, id: &'a Value) -> BoxFuture<'a, Result<Option<Value>>>;
    fn roots<'a>(&'a self, worker: &'a Value) -> BoxFuture<'a, Result<Vec<Value>>>;
}
pub fn from_chat(context: &Value) -> Result<Value> {
    if context["contextKind"] != "project" {
        return Err(Error::new(
            409,
            "unsupported-capability",
            "Standalone Chats do not support IDE execution operations.",
        )
        .into());
    }
    let mut result = Value::object([("terminalId", Value::Null)]);
    for key in [
        "chatId",
        "executionLaneId",
        "projectId",
        "rootKind",
        "workerId",
        "worktreeId",
        "worktreeMode",
    ] {
        result[key] = context[key].clone();
    }
    result["permissionProfileId"] =
        crate::chats::managed_console::permission_profile(context)["effectiveId"].clone();
    Ok(result)
}
async fn bound(reader: &impl Reader, call: &Value) -> Result<Option<Value>> {
    let worker = &call["workerId"];
    if truthy(call.get("chatContext")) {
        let claim = &call["chatContext"];
        let context = reader.chat(&claim["chatId"]).await?.ok_or_else(|| {
            Error::new(
                404,
                "context-not-found",
                "Chat execution context not found.",
            )
        })?;
        if context["workerId"] != *worker
            || context["executionLaneId"] != claim["executionLaneId"]
            || !executing(&context)
        {
            return Err(Error::new(
                409,
                "conflict",
                "The CLI command did not originate from the active chat lane.",
            )
            .into());
        }
        return from_chat(&context).map(Some);
    }
    if truthy(call["context"].get("codexThreadId")) {
        let contexts = reader
            .thread(worker, &call["context"]["codexThreadId"])
            .await?;
        if contexts.len() > 1 {
            return Err(Error::new(
                409,
                "ambiguous",
                "More than one chat uses this Codex thread. Open the intended chat and retry.",
            )
            .into());
        }
        if let Some(context) = contexts.first() {
            return from_chat(context).map(Some);
        }
    }
    if truthy(call["context"].get("terminalId")) {
        let terminal = reader.terminal(&call["context"]["terminalId"]).await?;
        if let Some(terminal) = terminal.filter(|t| t["workerId"] == *worker) {
            let chat = if truthy(terminal.get("linkedChatId")) {
                reader.chat(&terminal["linkedChatId"]).await?
            } else {
                None
            };
            let chat = chat.filter(|c| {
                c["workerId"] == terminal["workerId"] && c["worktreeId"] == terminal["worktreeId"]
            });
            let mut context = Value::object([] as [(&str, Value); 0]);
            for key in [
                "projectId",
                "rootKind",
                "terminalId",
                "workerId",
                "worktreeId",
            ] {
                context[key] = terminal[key].clone();
            }
            for key in ["chatId", "executionLaneId", "worktreeMode"] {
                context[key] = chat.as_ref().map_or(Value::Null, |c| c[key].clone());
            }
            context["permissionProfileId"] = chat.as_ref().map_or(Value::Null, |c| {
                crate::chats::managed_console::permission_profile(c)["effectiveId"].clone()
            });
            return Ok(Some(context));
        }
    }
    Ok(None)
}
fn executing(context: &Value) -> bool {
    matches!(
        context["status"].as_str(),
        Some("running" | "waiting-for-approval")
    )
}

pub fn normalized_path(value: &JsString) -> JsString {
    let mut units = value
        .units()
        .iter()
        .map(|u| if *u == 92 { 47 } else { *u })
        .collect::<Vec<_>>();
    while units.last() == Some(&47) {
        units.pop();
    }
    let windows = units.len() >= 3
        && ((65..=90).contains(&units[0]) || (97..=122).contains(&units[0]))
        && units[1] == 58
        && units[2] == 47;
    let value = JsString::new(units);
    if windows {
        value.lowercase()
    } else if value.is_empty() {
        "/".into()
    } else {
        value
    }
}
pub fn path_inside(candidate: &JsString, root: &JsString) -> bool {
    let candidate = normalized_path(candidate);
    let root = normalized_path(root);
    if candidate == root {
        return true;
    }
    let prefix = if root == JsString::from("/") {
        root.units().to_vec()
    } else {
        root.units().iter().copied().chain([47]).collect()
    };
    candidate.units().starts_with(&prefix)
}
pub fn from_cwd(cwd: &JsString, roots: &[Value]) -> Result<Option<Value>> {
    let mut candidates = roots
        .iter()
        .filter_map(|r| {
            r["worktreePath"]
                .as_js_string()
                .filter(|path| path_inside(cwd, path))
                .map(|path| (r, normalized_path(path).len()))
        })
        .collect::<Vec<_>>();
    candidates.sort_by_key(|(_, len)| std::cmp::Reverse(*len));
    let Some((best, len)) = candidates.first() else {
        return Ok(None);
    };
    if candidates.iter().skip(1).any(|(_, other)| other == len) {
        return Err(Error::new(
            409,
            "ambiguous",
            "The current directory belongs to more than one Cantrip project root.",
        )
        .into());
    }
    Ok(Some(
        json!({"chatId":Value::Null,"executionLaneId":Value::Null,"permissionProfileId":Value::Null,"projectId":best["projectId"],"rootKind":best["rootKind"],"terminalId":Value::Null,"workerId":best["workerId"],"worktreeId":best["worktreeId"],"worktreeMode":Value::Null}),
    ))
}
async fn cwd(reader: &impl Reader, call: &Value) -> Result<Option<Value>> {
    if !truthy(call["context"].get("cwd")) {
        return Ok(None);
    }
    let roots = reader.roots(&call["workerId"]).await?;
    from_cwd(
        call["context"]["cwd"].as_js_string().context("CLI cwd")?,
        &roots,
    )
}
pub async fn resolve<R: Reader + 'static>(
    reader: Arc<R>,
    call: &Value,
    allow_missing: bool,
) -> Result<Option<Value>> {
    match call["context"]["selection"].as_str() {
        Some("cwd") => return cwd(reader.as_ref(),call).await?.map(Some).ok_or_else(||Error::new(400,"context-not-found","--context cwd was requested, but the current directory is not inside a Cantrip project root.").into()),
        Some("lane") => return bound(reader.as_ref(),call).await?.map(Some).ok_or_else(||Error::new(400,"context-not-found","--context lane was requested, but no active chat or Terminal lane is bound to this process.").into()),
        _=>{}
    }
    // Source starts both reads before awaiting Promise.all. Detached completion
    // after the first failure preserves the other read's ordinary DB lifetime.
    let left = reader.clone();
    let left_call = call.clone();
    let mut left = async move { bound(left.as_ref(), &left_call).await }.boxed();
    let right_call = call.clone();
    let mut right = async move { cwd(reader.as_ref(), &right_call).await }.boxed();
    let mut left = match futures::poll!(left.as_mut()) {
        Poll::Ready(result) => futures::future::ready(result).boxed(),
        Poll::Pending => left,
    };
    let mut right = match futures::poll!(right.as_mut()) {
        Poll::Ready(result) => futures::future::ready(result).boxed(),
        Poll::Pending => right,
    };
    let (bound, cwd) = tokio::select! {
        biased;
        result=&mut left=>match result {
            Ok(bound)=>(bound,right.await?),
            Err(error)=>{tokio::spawn(right);return Err(error);}
        },
        result=&mut right=>match result {
            Ok(cwd)=>(left.await?,cwd),
            Err(error)=>{tokio::spawn(left);return Err(error);}
        }
    };
    if let (Some(bound), Some(cwd)) = (&bound, &cwd)
        && is_mutation(call["command"].as_str().context("CLI command")?)
        && ["projectId", "workerId", "worktreeId"]
            .iter()
            .any(|key| bound[key] != cwd[key])
    {
        let message = concat(&[
            json!("Cantrip refused to mutate because the bound lane targets project "),
            bound["projectId"].clone(),
            json!(", worktree "),
            bound["worktreeId"].clone(),
            json!(", while cwd targets project "),
            cwd["projectId"].clone(),
            json!(", worktree "),
            cwd["worktreeId"].clone(),
            json!(
                ". Retry explicitly with --context lane or --context cwd. The mutation did not start."
            ),
        ]);
        return Err(Error::new(409, "conflict", message).into());
    }
    match bound.or(cwd) {
        Some(value)=>Ok(Some(value)),None if allow_missing=>Ok(None),
        None=>Err(Error::new(400,"context-not-found","Cantrip could not infer a project. Run this command inside a Cantrip chat, Terminal tab, or project root.").into())
    }
}
