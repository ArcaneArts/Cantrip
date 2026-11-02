//! Inferred pull-request associations and advisory warnings. They never infer
//! completion or open encrypted Task content.
use crate::wire::{Value, coercion::truthy, value::json};
use anyhow::{Context, Result};
use indexmap::IndexMap;

fn array<'a>(input: &'a Value, name: &str) -> Result<&'a [Value]> {
    input[name]
        .as_array()
        .map(Vec::as_slice)
        .with_context(|| format!("Task dashboard {name}"))
}
fn date(value: &Value) -> Option<i64> {
    value
        .as_js_string()
        .and_then(crate::wire::date_milliseconds)
}
fn observation<'a>(worktrees: &'a [Value], id: &Value) -> Option<&'a Value> {
    // JS Map construction retains the final value of a repeated identifier.
    worktrees
        .iter()
        .rev()
        .find(|row| row["worktree"]["id"] == *id)
}

pub fn associate_pull_requests(input: &Value) -> Result<Vec<Value>> {
    let worktrees = array(input, "worktrees")?;
    let mut ids = Vec::new();
    for id in array(input, "lanes")?
        .iter()
        .map(|lane| &lane["worktreeId"])
        .chain(std::iter::once(&input["activeWorktreeId"]))
    {
        if !ids.contains(&id) {
            ids.push(id);
        }
    }
    let mut branches = IndexMap::new();
    for id in ids {
        if let Some(observed) = observation(worktrees, id)
            && truthy(observed["worktree"].get("branch"))
        {
            branches.insert(
                observed["worktree"]["branch"]
                    .as_js_string()
                    .context("Task worktree branch")?
                    .clone(),
                observed,
            );
        }
    }
    let started = if truthy(input.get("implementationStartedAt")) {
        date(&input["implementationStartedAt"])
    } else {
        Some(0)
    };
    let mut associated = Vec::new();
    for request in array(input, "pullRequests")? {
        let observed = request["headRef"]
            .as_js_string()
            .and_then(|branch| branches.get(branch));
        if let Some(observed) = observed
            && date(&request["createdAt"])
                .zip(started)
                .is_some_and(|(created, started)| created >= started)
        {
            let active = observed["worktree"]["id"] == input["activeWorktreeId"];
            let mut row = json!({"associationKind":"inferred","associationSource":if active {"worktree"}else{"lane-branch"},"confidence":if active {"high"}else{"medium"},"worktreeId":observed["worktree"]["id"],"worktreeName":observed["worktree"]["name"]});
            for key in [
                "number",
                "title",
                "url",
                "state",
                "draft",
                "merged",
                "headRef",
                "headSha",
                "baseRef",
                "baseSha",
                "createdAt",
                "updatedAt",
                "closedAt",
            ] {
                row[key] = request[key].clone();
            }
            associated.push(row);
        }
    }
    // Array.sort is stable and treats a NaN date comparison as equality.
    associated.sort_by(|left, right| {
        date(&left["updatedAt"])
            .zip(date(&right["updatedAt"]))
            .map_or(std::cmp::Ordering::Equal, |(a, b)| b.cmp(&a))
    });
    Ok(associated)
}

pub fn advisory_warnings(input: &Value) -> Result<Vec<Value>> {
    let requests = array(input, "pullRequests")?;
    let lanes = array(input, "lanes")?;
    let worktrees = array(input, "worktrees")?;
    let open = requests
        .iter()
        .filter(|request| request["state"] == "open")
        .collect::<Vec<_>>();
    let mut warnings = Vec::new();
    let mut push = |code: &str, message: String, request: &Value, worktree: &Value| {
        warnings.push(json!({"code":code,"message":message,"pullRequestNumber":request,"worktreeId":worktree}));
    };
    if open.len() > 1 {
        push(
            "multiple-open-pull-requests",
            format!(
                "{} Task-associated pull requests are open. Finish the intended cycle before starting another when your policies require sequential PRs.",
                open.len()
            ),
            &Value::Null,
            &Value::Null,
        );
    }
    let active_lane = lanes
        .iter()
        .find(|lane| lane["worktreeId"] == input["activeWorktreeId"]);
    for request in &open {
        if truthy(request.get("worktreeId"))
            && request["worktreeId"] != input["activeWorktreeId"]
            && let Some(active) = active_lane
            && lanes.iter().any(|lane| {
                lane["worktreeId"] == request["worktreeId"]
                    && date(&lane["createdAt"])
                        .zip(date(&active["createdAt"]))
                        .is_some_and(|(a, b)| a < b)
            })
        {
            push(
                "new-worktree-before-merge",
                format!(
                    "Work continued in a newer worktree while PR #{} remains open.",
                    request["number"].stringify()
                ),
                &request["number"],
                &request["worktreeId"],
            );
        }
    }
    if input["state"] != "complete" {
        for request in requests {
            if request["state"] == "closed" && !truthy(request.get("merged")) {
                push(
                    "closed-unmerged",
                    format!(
                        "PR #{} closed without merging while this Task continued.",
                        request["number"].stringify()
                    ),
                    &request["number"],
                    &request["worktreeId"],
                );
            }
        }
    }
    for request in requests {
        if truthy(request.get("merged"))
            && truthy(request.get("worktreeId"))
            && let Some(observed) = observation(worktrees, &request["worktreeId"])
            && truthy(observed.get("dirty"))
        {
            let name = crate::wire::coercion::string(&observed["worktree"]["name"])
                .map_err(|()| anyhow::anyhow!("Task worktree name cannot be converted to text"))?;
            let count = &observed["dirtyFileCount"];
            // Build strings in UTF-16 so worker-provided names retain their JS
            // spelling, including a lone surrogate in an internal observation.
            let suffix = format!(
                " still has {} local change{} after PR #{} merged.",
                count.stringify(),
                if count == &1 { "" } else { "s" },
                request["number"].stringify()
            );
            let message = crate::wire::JsString::new(
                name.units()
                    .iter()
                    .copied()
                    .chain(suffix.encode_utf16())
                    .collect(),
            );
            warnings.push(json!({"code":"dirty-after-merge","message":message,"pullRequestNumber":request["number"],"worktreeId":observed["worktree"]["id"]}));
        }
    }
    if input["state"] == "complete" {
        for request in open {
            warnings.push(json!({"code":"complete-with-open-pull-request","message":format!("This Task is complete but PR #{} remains open.",request["number"].stringify()),"pullRequestNumber":request["number"],"worktreeId":request["worktreeId"]}));
        }
    }
    Ok(warnings)
}
