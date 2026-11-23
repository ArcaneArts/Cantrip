//! Exact hunk/line selections over the existing Git diff and reviewed stdin path.
use super::{diff, process, review, status};
use crate::filesystem::Scope;
use anyhow::{Result, bail};
use cantrip_crypto::checked;
use cantrip_wire::{JsString, Value, value::json};
use indexmap::{IndexMap, IndexSet};
use std::path::Path;

struct Hunk<'a> {
    header: &'a str,
    lines: Vec<&'a str>,
}
fn parsed(patch: &str) -> (Vec<&str>, Vec<Hunk<'_>>) {
    let mut header = Vec::new();
    let mut hunks = Vec::<Hunk>::new();
    let mut lines = patch.split('\n').collect::<Vec<_>>();
    if lines.last() == Some(&"") {
        lines.pop();
    }
    for line in lines {
        if line.starts_with("@@ ") {
            hunks.push(Hunk {
                header: line,
                lines: Vec::new(),
            });
        } else if let Some(hunk) = hunks.last_mut() {
            hunk.lines.push(line);
        } else if !line.is_empty() {
            header.push(line);
        }
    }
    (header, hunks)
}
fn changed(line: &str) -> bool {
    line.starts_with(['+', '-'])
}
fn start(range: &str) -> Option<u64> {
    let mut parts = range.split(',');
    let first = parts.next()?;
    if first.is_empty() || !first.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    if let Some(count) = parts.next()
        && (count.is_empty() || !count.bytes().all(|b| b.is_ascii_digit()))
    {
        return None;
    }
    if parts.next().is_some() {
        return None;
    }
    first.parse().ok()
}
fn coordinates(header: &str) -> Option<(u64, u64, &str)> {
    let (old, rest) = header.strip_prefix("@@ -")?.split_once(" +")?;
    let (new, suffix) = rest.split_once(" @@")?;
    if suffix
        .chars()
        .any(|c| matches!(c, '\r' | '\n' | '\u{2028}' | '\u{2029}'))
    {
        return None;
    }
    Some((start(old)?, start(new)?, suffix))
}
fn range(start: u64, count: usize) -> String {
    if count == 1 {
        start.to_string()
    } else {
        format!("{start},{count}")
    }
}
struct Selection {
    patch: String,
    lines: usize,
}
fn select(patch: &str, request: &Value) -> Result<Selection> {
    let (header, hunks) = parsed(patch);
    if hunks.is_empty() {
        bail!(
            "This binary, rename-only, or mode-only change does not contain selectable text hunks. Use the file-level action instead."
        );
    }
    if header.iter().any(|s| {
        ["rename from ", "rename to ", "old mode ", "new mode "]
            .iter()
            .any(|prefix| s.starts_with(prefix))
    }) {
        bail!(
            "Partial actions are disabled for renames and mode changes. Use the file-level action so repository metadata stays consistent."
        );
    }
    let mut selections = IndexMap::<u64, Option<IndexSet<u64>>>::new();
    for selection in request["hunks"].as_array().unwrap() {
        let index = selection["hunkIndex"].as_u64().unwrap();
        if selections.contains_key(&index) {
            bail!("Hunk {} was selected more than once.", index + 1);
        }
        selections.insert(
            index,
            selection["lineIndexes"]
                .as_array()
                .map(|a| a.iter().map(|v| v.as_u64().unwrap()).collect()),
        );
    }
    let changed_lines = hunks
        .iter()
        .map(|h| h.lines.iter().filter(|s| changed(s)).count())
        .sum::<usize>();
    let mut requested = 0;
    for (&index, selection) in &selections {
        let hunk = hunks
            .get(index as usize)
            .ok_or_else(|| anyhow::anyhow!("Hunk {} does not exist.", index + 1))?;
        let indexes = hunk
            .lines
            .iter()
            .enumerate()
            .filter(|(_, s)| changed(s))
            .map(|(i, _)| i as u64)
            .collect::<IndexSet<_>>();
        if let Some(selection) = selection {
            if selection.iter().any(|i| !indexes.contains(i)) {
                bail!(
                    "Hunk {} selected context or missing line indexes.",
                    index + 1
                );
            }
            requested += selection.len();
        } else {
            requested += indexes.len();
        }
    }
    let full = selections.len() == hunks.len() && requested == changed_lines;
    let operation = request["operation"].as_str().unwrap();
    let normalize_new =
        header.iter().any(|s| s.starts_with("new file mode ")) && !full && operation != "stage";
    let normalize_deleted =
        header.iter().any(|s| s.starts_with("deleted file mode ")) && !full && operation == "stage";
    let reverse = matches!(operation, "unstage" | "discard");
    let mut selections = selections.into_iter().collect::<Vec<_>>();
    selections.sort_by_key(|(index, _)| *index);
    let mut output = Vec::<String>::new();
    let mut selected = 0;
    for (index, selection) in selections {
        let hunk = &hunks[index as usize];
        let Some(selection) = selection else {
            output.push(hunk.header.into());
            output.extend(hunk.lines.iter().map(|s| (*s).to_owned()));
            selected += hunk.lines.iter().filter(|s| changed(s)).count();
            continue;
        };
        if selection.is_empty() {
            bail!("Hunk {} has no selected lines.", index + 1);
        }
        let (old, new, suffix) = coordinates(hunk.header)
            .ok_or_else(|| anyhow::anyhow!("Hunk {} has an invalid header.", index + 1))?;
        let old_start = if normalize_new { new } else { old };
        let new_start = if normalize_deleted { old } else { new };
        let mut body = Vec::new();
        let mut old_count = 0;
        let mut new_count = 0;
        let mut previous = false;
        for (index, &line) in hunk.lines.iter().enumerate() {
            match line.as_bytes().first() {
                Some(b' ') => {
                    body.push(line.to_owned());
                    old_count += 1;
                    new_count += 1;
                    previous = true;
                }
                Some(prefix @ (b'-' | b'+')) => {
                    if selection.contains(&(index as u64)) {
                        body.push(line.to_owned());
                        if *prefix == b'-' {
                            old_count += 1;
                        } else {
                            new_count += 1;
                        }
                        selected += 1;
                        previous = true;
                    } else if (*prefix == b'-' && !reverse) || (*prefix == b'+' && reverse) {
                        body.push(format!(" {}", &line[1..]));
                        old_count += 1;
                        new_count += 1;
                        previous = true;
                    } else {
                        previous = false;
                    }
                }
                Some(b'\\') => {
                    if previous {
                        body.push(line.to_owned());
                    }
                }
                Some(_) => {
                    body.push(line.to_owned());
                    previous = true;
                }
                None => (),
            }
        }
        output.push(format!(
            "@@ -{} +{} @@{suffix}",
            range(old_start, old_count),
            range(new_start, new_count)
        ));
        output.extend(body);
    }
    if selected == 0 {
        bail!("The selection contains no changed lines.");
    }
    let mut header = header.iter().map(|s| (*s).to_owned()).collect::<Vec<_>>();
    if normalize_new || normalize_deleted {
        let old = header.iter().find(|s| s.starts_with("--- ")).cloned();
        let new = header.iter().find(|s| s.starts_with("+++ ")).cloned();
        let swap = |s: String, from: char, to: char| {
            s.replacen(&format!("{from}/"), &format!("{to}/"), 1)
                .replacen(&format!("\"{from}/"), &format!("\"{to}/"), 1)
        };
        header = header
            .into_iter()
            .filter(|s| {
                !["new file mode ", "deleted file mode ", "index "]
                    .iter()
                    .any(|prefix| s.starts_with(prefix))
            })
            .map(|line| {
                if normalize_new
                    && Some(&line) == old.as_ref()
                    && let Some(new) = &new
                {
                    return swap(new.replacen("+++ ", "--- ", 1), 'b', 'a');
                }
                if normalize_deleted
                    && Some(&line) == new.as_ref()
                    && let Some(old) = &old
                {
                    return swap(old.replacen("--- ", "+++ ", 1), 'a', 'b');
                }
                line
            })
            .collect();
    }
    header.extend(output);
    Ok(Selection {
        patch: format!("{}\n", header.join("\n")),
        lines: selected,
    })
}
fn arguments(operation: &str, check: bool) -> Vec<&str> {
    let mut args = vec!["apply"];
    if check {
        args.push("--check");
    }
    if matches!(operation, "stage" | "unstage") {
        args.push("--cached");
    }
    if matches!(operation, "unstage" | "discard") {
        args.push("--reverse");
    }
    args.extend(["--recount", "-"]);
    args
}
pub async fn preview(cwd: &Path, request: &Value, scope: &Scope) -> Result<Value> {
    let operation = request["operation"].as_str().unwrap();
    let path = request["path"].as_js_string().unwrap();
    let diff_scope = if operation == "unstage" {
        "staged"
    } else {
        "unstaged"
    };
    let source = diff::file_diff(cwd, path, diff_scope, 3, scope).await?;
    if source["truncated"] == true {
        bail!("This patch is truncated and cannot be applied partially.");
    }
    let selected = select(&source["patch"].as_js_string().unwrap().lossy(), request)?;
    process::input(
        cwd,
        &arguments(operation, true),
        &selected.patch,
        scope,
        &[],
    )
    .await?;
    let token = review::digest(&[
        operation.as_bytes(),
        b"\0",
        path.lossy().as_bytes(),
        b"\0",
        selected.patch.as_bytes(),
    ]);
    checked(
        "gitPartialPatchPreviewSchema",
        &json!({"operation":operation,"path":path,"scope":diff_scope,"patch":selected.patch,"token":token,"selectedHunks":request["hunks"].as_array().unwrap().len(),"selectedLines":selected.lines,"warnings":Vec::<Value>::new()}),
    )
}
pub async fn apply(cwd: &Path, request: &Value, token: &JsString, scope: &Scope) -> Result<Value> {
    let preview = preview(cwd, request, scope).await?;
    if preview["token"].as_js_string() != Some(token) {
        bail!("The working changes no longer match this preview. Review the selection again.");
    }
    let output = process::input(
        cwd,
        &arguments(request["operation"].as_str().unwrap(), false),
        &preview["patch"].as_js_string().unwrap().lossy(),
        scope,
        &[],
    )
    .await?;
    checked(
        "gitActionResultSchema",
        &json!({"output":output,"status":status::status(cwd,scope).await?}),
    )
}
