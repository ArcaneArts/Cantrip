//! Read-only history queries, with the existing Git argument and pagination
//! semantics. Git remains the source of repository metadata.
use super::{GitError, diff, process};
use crate::filesystem::Scope;
use anyhow::{Result, bail};
use cantrip_crypto::checked;
use cantrip_wire::{JsString, Value, value::json};
use indexmap::{IndexMap, IndexSet};
use std::path::Path;

pub(super) fn hash(value: &str) -> bool {
    (40..=64).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
pub(super) fn message(prefix: &str, value: &JsString, suffix: &str) -> anyhow::Error {
    let mut units = JsString::from(prefix).units().to_vec();
    units.extend_from_slice(value.units());
    units.extend_from_slice(JsString::from(suffix).units());
    GitError(JsString::new(units)).into()
}
pub(super) async fn resolve(cwd: &Path, revision: &JsString, scope: &Scope) -> Result<String> {
    let object = format!("{}^{{commit}}", revision.lossy());
    let value = process::text(
        cwd,
        &["rev-parse", "--verify", "--end-of-options", &object],
        scope,
    )
    .await
    .unwrap_or_default();
    scope.check()?;
    if !hash(&value) {
        return Err(message("Commit ", revision, " does not exist."));
    }
    Ok(value)
}
pub(super) async fn verified(cwd: &Path, revisions: &Value, scope: &Scope) -> Result<Vec<String>> {
    let revisions: IndexSet<String> = revisions
        .as_array()
        .into_iter()
        .flatten()
        .map(|v| v.as_js_string().unwrap().lossy().into_owned())
        .collect();
    let results = futures::future::join_all(revisions.into_iter().map(|revision| async move {
        let object = format!("{revision}^{{commit}}");
        let valid = process::bytes(cwd, &["cat-file", "-e", &object], scope)
            .await
            .is_ok();
        (revision, valid)
    }))
    .await;
    scope.check()?;
    Ok(results
        .into_iter()
        .filter_map(|(revision, valid)| valid.then_some(revision))
        .collect())
}
pub(super) fn refs(decorations: &str, branch: &str, remotes: &str) -> Vec<Value> {
    let remote_names: IndexSet<&str> = remotes.split('\n').filter(|s| !s.is_empty()).collect();
    let mut refs = IndexMap::<(String, String), bool>::new();
    let mut add = |name: &str, kind: &str, current: bool| {
        // The map preserves the insertion order of the source Map, including
        // repeated decorations whose current flag is promoted later.
        *refs.entry((kind.to_owned(), name.to_owned())).or_default() |= current;
    };
    // Kept separate from classification so remote aliases and HEAD arrows
    // follow the source decoration order.
    let classify = |name: &str| {
        if remote_names.contains(name.split('/').next().unwrap_or("")) {
            "remote"
        } else {
            "local"
        }
    };
    for raw in decorations.split(',') {
        let name = process::trim(raw);
        if name.is_empty() {
            continue;
        }
        if let Some(name) = name.strip_prefix("tag: ") {
            add(name, "tag", false);
        } else if name == "HEAD" {
            add("HEAD", "head", true);
        } else if let Some(name) = name.strip_prefix("HEAD -> ") {
            add("HEAD", "head", true);
            add(name, "local", name == branch);
        } else if let Some((source, target)) = name.split_once(" -> ") {
            add(source, classify(source), false);
            add(target, classify(target), false);
        } else {
            add(&name, classify(&name), name == branch);
        }
    }
    refs.into_iter()
        .map(|((kind, name), current)| json!({"name":name,"kind":kind,"current":current}))
        .collect()
}
pub(super) fn integer(value: &str) -> f64 {
    // Number.parseInt(value, 10), including its prefix parsing and f64 result.
    let value = value.trim_start_matches(cantrip_wire::text::whitespace);
    let (negative, value) = match value.strip_prefix('-') {
        Some(v) => (true, v),
        None => (false, value.strip_prefix('+').unwrap_or(value)),
    };
    let value = value
        .bytes()
        .take_while(u8::is_ascii_digit)
        .fold(0.0, |n, b| n * 10.0 + f64::from(b - b'0'));
    if negative { -value } else { value }
}
fn escape(value: &str) -> String {
    let mut result = String::new();
    for ch in value.chars() {
        if "\\^$.*+?()[]{}|".contains(ch) {
            result.push('\\');
        }
        result.push(ch);
    }
    result
}
fn prefixed(prefix: &str, value: &JsString) -> JsString {
    JsString::new(
        prefix
            .encode_utf16()
            .chain(value.units().iter().copied())
            .collect(),
    )
}
async fn filtered_revision(cwd: &Path, filters: &Value, scope: &Scope) -> Result<Option<String>> {
    if let Some(value) = filters["hash"].as_js_string() {
        return Ok(Some(resolve(cwd, value, scope).await?));
    }
    if let Some(value) = filters["branch"].as_js_string() {
        let local = prefixed("refs/heads/", value);
        let revision = match resolve(cwd, &local, scope).await {
            Ok(value) => value,
            Err(_) => resolve(cwd, &prefixed("refs/remotes/", value), scope).await?,
        };
        return Ok(Some(revision));
    }
    if let Some(value) = filters["tag"].as_js_string() {
        return Ok(Some(
            resolve(cwd, &prefixed("refs/tags/", value), scope).await?,
        ));
    }
    Ok(None)
}
fn filters(args: &mut Vec<String>, query: &Value, search: bool) {
    if let Some(value) = query["message"].as_js_string() {
        if !search {
            args.push("--regexp-ignore-case".into());
        }
        args.extend([
            "--fixed-strings".into(),
            format!("--grep={}", value.lossy()),
        ]);
    }
    if let Some(value) = query["author"].as_js_string() {
        args.push(format!("--author={}", escape(&value.lossy())));
    }
    if let Some(value) = query["dateFrom"].as_str() {
        args.push(format!("--since={value}"));
    }
    if let Some(value) = query["dateTo"].as_str() {
        args.push(format!("--until={value} 23:59:59"));
    }
}
fn path_args(query: &Value) -> Vec<String> {
    query["path"]
        .as_js_string()
        .map_or_else(Vec::new, |v| vec!["--".into(), v.lossy().into_owned()])
}
fn commits(
    output: &str,
    branch: &str,
    remotes: &str,
    head: &str,
    skip_invalid: bool,
) -> Vec<Value> {
    output.split('\x1e').map(process::trim).filter(|s| !s.is_empty()).filter_map(|record| {
        let fields: Vec<&str> = record.split('\0').collect();
        let field = |index| fields.get(index).copied().unwrap_or("");
        if skip_invalid && [0,1,3,5].iter().any(|&i| field(i).is_empty()) { return None; }
        Some(json!({"hash":field(0),"shortHash":field(1),"parents":field(2).split(' ').filter(|s| !s.is_empty()).collect::<Vec<_>>(),"authorName":field(3),"authorEmail":field(4),"authoredAt":field(5),"subject":field(6),"refs":refs(field(7),branch,remotes),"isHead":field(0)==head}))
    }).collect()
}
const COMMIT_FORMAT: &str = "--pretty=format:%H%x00%h%x00%P%x00%an%x00%ae%x00%aI%x00%s%x00%D%x1e";
pub async fn history(cwd: &Path, command: &Value, scope: &Scope) -> Result<Value> {
    let verified = verified(cwd, &command["revisions"], scope).await?;
    let options = &command["options"];
    let query = &options["filters"];
    let revision = filtered_revision(cwd, query, scope).await?;
    let mut revisions = revision.map_or_else(
        || {
            if options["firstParent"] == true {
                vec!["HEAD".into()]
            } else {
                std::iter::once("--all".into()).chain(verified).collect()
            }
        },
        |v| vec![v],
    );
    let mut traversal = Vec::<String>::new();
    if options["firstParent"] == true {
        traversal.push("--first-parent".into());
    }
    if options["hideMerges"] == true {
        traversal.push("--no-merges".into());
    }
    filters(&mut traversal, query, false);
    let paths = path_args(query);
    let mut count_args = vec!["rev-list".to_owned(), "--count".into()];
    count_args.extend(traversal.iter().chain(&revisions).chain(&paths).cloned());
    let count_refs: Vec<_> = count_args.iter().map(String::as_str).collect();
    let (branch, head, remotes, total) = tokio::join!(
        process::text(cwd, &["branch", "--show-current"], scope),
        process::text(cwd, &["rev-parse", "--verify", "HEAD"], scope),
        process::text(cwd, &["remote"], scope),
        process::text(cwd, &count_refs, scope)
    );
    let branch = branch?;
    let head = head.unwrap_or_default();
    let remotes = remotes.unwrap_or_default();
    let total = integer(&total.unwrap_or_else(|_| "0".into()));
    let limit = command["limit"].as_u64().unwrap() as usize;
    let cursor = command["cursor"].as_u64().unwrap_or(0);
    let mut args = vec![
        "log".into(),
        "--topo-order".into(),
        "--date-order".into(),
        format!("--skip={cursor}"),
        format!("--max-count={}", limit + 1),
        "--date=iso-strict".into(),
        COMMIT_FORMAT.into(),
    ];
    args.append(&mut traversal);
    args.append(&mut revisions);
    args.extend(paths);
    let output = process::capture(
        cwd,
        &args.iter().map(String::as_str).collect::<Vec<_>>(),
        scope,
    )
    .await?;
    let output = if output.code == Some(0) && !output.overflow {
        process::trim(&String::from_utf8_lossy(&output.bytes))
    } else if String::from_utf8_lossy(&output.stderr).contains("does not have any commits yet") {
        String::new()
    } else {
        bail!("{}", output.error);
    };
    let mut commits = commits(&output, &branch, &remotes, &head, false);
    let more = commits.len() > limit;
    commits.truncate(limit);
    checked(
        "gitHistorySchema",
        &json!({"branch":branch,"head":if head.is_empty(){None}else{Some(head)},"totalCount":total,"nextCursor":more.then_some(cursor+commits.len() as u64),"hasMore":more,"commits":commits}),
    )
}
pub async fn search(cwd: &Path, command: &Value, scope: &Scope) -> Result<Value> {
    let query = checked("gitCommitSearchQuerySchema", &command["query"])?;
    let revision = filtered_revision(cwd, &query, scope)
        .await?
        .unwrap_or_else(|| "--all".into());
    let branch = process::text(cwd, &["branch", "--show-current"], scope).await?;
    let remotes = process::text(cwd, &["remote"], scope)
        .await
        .unwrap_or_default();
    let limit = command["limit"].as_u64().unwrap() as usize;
    let cursor = command["cursor"].as_u64().unwrap_or(0);
    let mut args = vec![
        "log".into(),
        "--topo-order".into(),
        "--date-order".into(),
        format!("--skip={cursor}"),
        format!("--max-count={}", limit + 1),
        "--date=iso-strict".into(),
        "--regexp-ignore-case".into(),
        COMMIT_FORMAT.into(),
    ];
    filters(&mut args, &query, true);
    args.push(revision);
    args.extend(path_args(&query));
    let output = process::raw(
        cwd,
        &args.iter().map(String::as_str).collect::<Vec<_>>(),
        scope,
    )
    .await?;
    let head = resolve(cwd, &"HEAD".into(), scope)
        .await
        .unwrap_or_default();
    scope.check()?;
    let mut commits = commits(&output, &branch, &remotes, &head, true);
    let more = commits.len() > limit;
    commits.truncate(limit);
    checked(
        "gitCommitSearchResultSchema",
        &json!({"query":query,"nextCursor":more.then_some(cursor+commits.len() as u64),"hasMore":more,"commits":commits}),
    )
}
pub async fn file_history(cwd: &Path, command: &Value, scope: &Scope) -> Result<Value> {
    let path = command["path"].as_js_string().unwrap();
    if !diff::safe(path) {
        bail!("Invalid Git history path.");
    }
    let revision = resolve(cwd, command["revision"].as_js_string().unwrap(), scope).await?;
    let limit = command["limit"].as_u64().unwrap() as usize;
    let cursor = command["cursor"].as_u64().unwrap_or(0);
    let output = process::raw(
        cwd,
        &[
            "log",
            "--follow",
            "--date=iso-strict",
            &format!("--skip={cursor}"),
            &format!("--max-count={}", limit + 1),
            "--format=%H%x00%h%x00%an%x00%ae%x00%aI%x00%s%x1e",
            &revision,
            "--",
            &path.lossy(),
        ],
        scope,
    )
    .await?;
    let mut commits = output.split('\x1e').map(process::trim).filter(|s| !s.is_empty()).filter_map(|record| {
        let fields: Vec<_> = record.split('\0').collect();
        let f = |index| fields.get(index).copied().unwrap_or("");
        if [0,1,2,4].iter().any(|&i| f(i).is_empty()) { return None; }
        Some(json!({"hash":f(0),"shortHash":f(1),"authorName":f(2),"authorEmail":f(3),"authoredAt":f(4),"subject":f(5)}))
    }).collect::<Vec<_>>();
    let more = commits.len() > limit;
    commits.truncate(limit);
    checked(
        "gitFileHistorySchema",
        &json!({"path":path,"revision":revision,"nextCursor":more.then_some(cursor+commits.len() as u64),"hasMore":more,"commits":commits}),
    )
}
pub async fn blame(cwd: &Path, command: &Value, scope: &Scope) -> Result<Value> {
    let path = command["path"].as_js_string().unwrap();
    if !diff::safe(path) {
        bail!("Invalid Git blame path.");
    }
    let revision = resolve(cwd, command["revision"].as_js_string().unwrap(), scope).await?;
    let limit = command["limit"].as_u64().unwrap() as usize;
    let cursor = command["cursor"].as_u64().unwrap_or(0);
    let output = process::raw(
        cwd,
        &[
            "blame",
            "--line-porcelain",
            "-L",
            &format!("{},+{}", cursor + 1, limit + 1),
            &revision,
            "--",
            &path.lossy(),
        ],
        scope,
    )
    .await?;
    let mut input = output.split('\n');
    let mut ranges = Vec::<Value>::new();
    let mut count = 0;
    let mut more = false;
    while let Some(header) = input.next() {
        let fields: Vec<_> = header.split_whitespace().collect();
        if !(fields.len() == 3 || fields.len() == 4)
            || !hash(fields[0])
            || fields[1..]
                .iter()
                .any(|s| s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()))
        {
            continue;
        }
        let line = integer(fields[2]);
        let mut name = "Unknown".to_owned();
        let mut email = String::new();
        let mut date = "1970-01-01T00:00:00.000Z".to_owned();
        let mut summary = String::new();
        let mut content = String::new();
        for item in input.by_ref() {
            if let Some(value) = item.strip_prefix('\t') {
                content = value.to_owned();
                break;
            }
            if let Some(value) = item.strip_prefix("author ") {
                name = if value.is_empty() { "Unknown" } else { value }.to_owned();
            } else if let Some(value) = item.strip_prefix("author-mail ") {
                email = value
                    .strip_prefix('<')
                    .unwrap_or(value)
                    .strip_suffix('>')
                    .unwrap_or(value.strip_prefix('<').unwrap_or(value))
                    .to_owned();
            } else if let Some(value) = item.strip_prefix("author-time ") {
                let seconds = integer(value);
                if seconds.is_finite()
                    && value
                        .trim_start_matches(cantrip_wire::text::whitespace)
                        .trim_start_matches(['+', '-'])
                        .starts_with(|c: char| c.is_ascii_digit())
                {
                    let milliseconds = seconds * 1000.0;
                    if milliseconds.abs() > 8_640_000_000_000_000.0 {
                        bail!("Invalid time value");
                    }
                    date = cantrip_wire::date::iso_milliseconds(milliseconds as i64)
                        .ok_or_else(|| anyhow::anyhow!("Invalid time value"))?;
                }
            } else if let Some(value) = item.strip_prefix("summary ") {
                summary = value.to_owned();
            }
        }
        if count == limit {
            more = true;
            break;
        }
        count += 1;
        if let Some(previous) = ranges.last_mut()
            && previous["commit"] == fields[0]
            && previous["endLine"].as_f64().unwrap() + 1.0 == line
        {
            previous["endLine"] = json!(line);
            if let Value::Array(lines) = &mut previous["lines"] {
                lines.push(json!(content));
            }
        } else {
            ranges.push(json!({"commit":fields[0],"shortCommit":&fields[0][..10],"authorName":name,"authorEmail":email,"authoredAt":date,"summary":summary,"startLine":line,"endLine":line,"lines":[content]}));
        }
    }
    checked(
        "gitBlameSchema",
        &json!({"path":path,"revision":revision,"ranges":ranges,"hasMore":more,"nextCursor":more.then_some(cursor+count as u64)}),
    )
}
