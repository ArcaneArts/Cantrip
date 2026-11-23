//! CLI selection keeps Source's exact-before-prefix/substring precedence.
use super::{Error, concat};
use crate::wire::{JsString, Value, value::json};
use anyhow::Result;
use unicode_normalization::UnicodeNormalization;

fn contains(haystack: &JsString, needle: &JsString) -> bool {
    needle.is_empty()
        || haystack
            .units()
            .windows(needle.len())
            .any(|at| at == needle.units())
}
pub fn ambiguous(noun: &str, matches: &[Value]) -> Error {
    let mut parts = vec![json!(format!("Multiple {noun} targets match: "))];
    for (index, item) in matches.iter().take(8).enumerate() {
        if index > 0 {
            parts.push(json!(", "));
        }
        let id = item["id"].as_js_string().expect("CLI selector identity");
        parts.extend([
            item["title"].clone(),
            json!(" ("),
            Value::String(JsString::new(id.units()[..id.len().min(8)].to_vec())),
            json!(")"),
        ]);
    }
    parts.push(json!(". Retry with a unique title or full ID."));
    Error::new(409, "ambiguous", concat(&parts))
}
pub fn worktree(
    context: &Value,
    worktrees: &[Value],
    selector: Option<&JsString>,
) -> Result<Value> {
    let Some(selector) = selector else {
        return worktrees
            .iter()
            .find(|w| w["id"] == context["worktreeId"])
            .cloned()
            .ok_or_else(|| {
                Error::new(
                    404,
                    "not-found",
                    "The current worktree is no longer registered.",
                )
                .into()
            });
    };
    let wanted = selector.lowercase();
    let exact = worktrees
        .iter()
        .filter(|w| {
            w["id"].as_js_string() == Some(selector)
                || ["name", "branch"].iter().any(|key| {
                    w[*key]
                        .as_js_string()
                        .is_some_and(|s| s.lowercase() == wanted)
                })
        })
        .collect::<Vec<_>>();
    let matches = if exact.is_empty() {
        worktrees
            .iter()
            .filter(|w| {
                w["id"]
                    .as_js_string()
                    .is_some_and(|id| id.units().starts_with(selector.units()))
            })
            .collect::<Vec<_>>()
    } else {
        exact
    };
    match matches.as_slice() {
        [one] => Ok((*one).clone()),
        [] => Err(Error::new(
            404,
            "not-found",
            concat(&[
                json!("Worktree "),
                Value::String(selector.clone()),
                json!(" was not found. Run `cantrip worktree list` to see available worktrees."),
            ]),
        )
        .into()),
        _ => Err(ambiguous(
            "worktree",
            &matches
                .into_iter()
                .map(|w| json!({"id":w["id"],"title":w["name"]}))
                .collect::<Vec<_>>(),
        )
        .into()),
    }
}
pub fn derived_branch(name: &JsString, worktrees: &[Value]) -> Result<JsString> {
    // Every unpaired unit is a non-ASCII slug separator. Replacement at this
    // normalization seam therefore preserves the resulting ASCII branch slug.
    let normalized = name.lossy().nfkd().collect::<String>().to_lowercase();
    let mut slug = String::new();
    let mut separator = false;
    for ch in normalized.chars() {
        if ch.is_ascii_lowercase() || ch.is_ascii_digit() {
            if separator && !slug.is_empty() {
                slug.push('-');
            }
            separator = false;
            slug.push(ch);
        } else {
            separator = true;
        }
    }
    slug.truncate(slug.len().min(48));
    let prefix = format!(
        "cantrip/{}",
        if slug.is_empty() { "worktree" } else { &slug }
    );
    let present = |candidate: &str| worktrees.iter().any(|w| w["branch"] == candidate);
    if !present(&prefix) {
        return Ok(prefix.into());
    }
    for suffix in 2..=999 {
        let candidate = format!("{prefix}-{suffix}");
        if !present(&candidate) {
            return Ok(candidate.into());
        }
    }
    Err(Error::new(
        409,
        "conflict",
        "Could not derive a unique worktree branch. Retry with --branch.",
    )
    .into())
}
pub fn target_id(target: &Value) -> Result<&Value> {
    let key = match target["kind"].as_str() {
        Some("project") => "projectId",
        Some("worker") => "workerId",
        Some("replica") => "projectReplicaId",
        Some("worktree") => "worktreeId",
        Some("surface") => "surfaceId",
        _ => anyhow::bail!("CLI target kind"),
    };
    Ok(&target[key])
}
fn selected(candidate: &Value) -> Value {
    json!({"outcome":"selected","target":candidate["target"]})
}
fn target_matches(matches: &[&Value]) -> Result<Value> {
    let matches = matches
        .iter()
        .map(|item| {
            let id = target_id(&item["target"])?;
            let title = if item["title"].is_null() {
                Value::String(concat(&[
                    item["resourceKind"].clone(),
                    json!(" "),
                    id.clone(),
                ]))
            } else {
                item["title"].clone()
            };
            Ok(json!({"id":id,"title":title}))
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(json!({"outcome":"ambiguous","matches":matches}))
}
pub fn target_exact(candidates: &[Value], selector: &JsString) -> Result<Option<Value>> {
    let wanted = selector.lowercase();
    let exact = candidates
        .iter()
        .filter_map(|item| {
            let id = target_id(&item["target"]).ok()?;
            (id.as_js_string() == Some(selector)
                || item["title"]
                    .as_js_string()
                    .is_some_and(|t| t.lowercase() == wanted))
            .then_some(item)
        })
        .collect::<Vec<_>>();
    match exact.as_slice() {
        [] => Ok(None),
        [one] => Ok(Some(selected(one))),
        _ => target_matches(&exact).map(Some),
    }
}
pub fn target_explicit(candidates: &[Value], selector: &JsString) -> Result<Value> {
    if let Some(result) = target_exact(candidates, selector)? {
        return Ok(result);
    }
    let wanted = selector.lowercase();
    let matches = candidates
        .iter()
        .filter_map(|item| {
            let id = target_id(&item["target"]).ok()?;
            (id.as_js_string()
                .is_some_and(|id| id.units().starts_with(selector.units()))
                || item["title"]
                    .as_js_string()
                    .is_some_and(|t| contains(&t.lowercase(), &wanted)))
            .then_some(item)
        })
        .collect::<Vec<_>>();
    match matches.as_slice() {
        [] => Ok(json!({"outcome":"not-found"})),
        [one] => Ok(selected(one)),
        _ => target_matches(&matches),
    }
}
pub fn target_default(candidates: &[Value], input: &Value) -> Result<Value> {
    if let Some(selector) = input
        .get("selector")
        .and_then(Value::as_js_string)
        .filter(|s| !s.is_empty())
    {
        return target_explicit(candidates, selector);
    }
    if input["resourceKind"] == "terminal"
        && !input["currentTerminalId"].is_null()
        && let Some(current) = candidates.iter().find(|c| {
            c["target"]["kind"] == "surface"
                && c["target"]["surfaceId"] == input["currentTerminalId"]
        })
    {
        return Ok(selected(current));
    }
    if input["resourceKind"] == "worktree"
        && let Some(current) = candidates.iter().find(|c| {
            c["target"]["kind"] == "worktree"
                && c["target"]["worktreeId"] == input["currentWorktreeId"]
        })
    {
        return Ok(selected(current));
    }
    let available = candidates
        .iter()
        .filter(|c| c["availability"] == "available")
        .collect::<Vec<_>>();
    let local = available
        .iter()
        .copied()
        .filter(|c| {
            c["placement"]["workerId"] == input["currentWorkerId"]
                && c["placement"]["worktreeId"] == input["currentWorktreeId"]
        })
        .collect::<Vec<_>>();
    let matches = if local.len() == 1 { &local } else { &available };
    match matches.as_slice() {
        [] => Ok(json!({"outcome":"unavailable"})),
        [one] => Ok(selected(one)),
        _ => target_matches(matches),
    }
}
