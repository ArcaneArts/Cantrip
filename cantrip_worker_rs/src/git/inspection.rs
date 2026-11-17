//! Commit metadata, revision candidates, comparisons and object-side diffs.
use super::{diff, history, process};
use crate::filesystem::Scope;
use anyhow::{Result, bail};
use cantrip_crypto::checked;
use cantrip_wire::{JsString, Value, value::json};
use indexmap::{IndexMap, IndexSet};
use std::path::Path;
const FILE_LIMIT: usize = 100_000;
const MESSAGE_LIMIT: usize = 1_000_000;

fn status(code: &str) -> &'static str {
    match code.as_bytes().first() {
        Some(b'A') => "added",
        Some(b'M') => "modified",
        Some(b'D') => "deleted",
        Some(b'R') => "renamed",
        Some(b'C') => "copied",
        Some(b'T') => "type-changed",
        Some(b'U') => "unmerged",
        _ => "unknown",
    }
}
struct Files {
    files: Vec<Value>,
    total: usize,
    truncated: bool,
}
async fn files(cwd: &Path, base: Option<&str>, hash: &str, scope: &Scope) -> Result<Files> {
    let args = |format| {
        let mut args = if base.is_some() {
            vec!["diff"]
        } else {
            vec!["diff-tree", "--root", "--no-commit-id", "-r"]
        };
        args.extend([format, "-z", "-M", "-C"]);
        if let Some(base) = base {
            args.push(base);
        }
        args.push(hash);
        args
    };
    let names_args = args("--name-status");
    let stats_args = args("--numstat");
    let (names, stats) = tokio::join!(
        process::raw(cwd, &names_args, scope),
        process::raw(cwd, &stats_args, scope)
    );
    let stats = stats?;
    let mut stat_fields = stats.split('\0');
    let mut stats = IndexMap::<&str, (Option<&str>, Option<f64>, Option<f64>)>::new();
    while let Some(record) = stat_fields.next() {
        let Some((add, remaining)) = record.split_once('\t') else {
            continue;
        };
        let Some((delete, mut path)) = remaining.split_once('\t') else {
            continue;
        };
        let mut original = None;
        if path.is_empty() {
            original = stat_fields.next();
            path = stat_fields.next().unwrap_or("");
        }
        if !diff::safe(&path.into()) {
            continue;
        }
        stats.insert(
            path,
            (
                original,
                (add != "-").then(|| history::integer(add)),
                (delete != "-").then(|| history::integer(delete)),
            ),
        );
    }
    let names = names?;
    let mut names = names.split('\0');
    let mut files = Vec::new();
    let mut total = 0;
    while let Some(code) = names.next() {
        if code.is_empty() {
            continue;
        }
        let original = if code.starts_with(['R', 'C']) {
            names.next()
        } else {
            None
        };
        let path = names.next().unwrap_or("");
        if !diff::safe(&path.into()) {
            continue;
        }
        total += 1;
        if files.len() == FILE_LIMIT {
            continue;
        }
        let (stat_original, additions, deletions) = stats.get(path).copied().unwrap_or_default();
        files.push(json!({"path":path,"originalPath":original.or(stat_original),"status":status(code),"additions":additions,"deletions":deletions,"binary":additions.is_none()||deletions.is_none()}));
    }
    Ok(Files {
        files,
        total,
        truncated: total > FILE_LIMIT,
    })
}
fn sum(files: &[Value], field: &str) -> f64 {
    files.iter().map(|v| v[field].as_f64().unwrap_or(0.0)).sum()
}
async fn children(cwd: &Path, hash: &str, revisions: &Value, scope: &Scope) -> Result<Vec<String>> {
    let revisions = history::verified(cwd, revisions, scope).await?;
    let mut args = vec!["rev-list", "--children", "--all"];
    args.extend(revisions.iter().map(String::as_str));
    let output = process::raw(cwd, &args, scope).await.unwrap_or_default();
    scope.check()?;
    let mut children = IndexSet::new();
    for line in output.split('\n') {
        let line = process::trim(line);
        let mut values = line.split_whitespace();
        if values.next() != Some(hash) {
            continue;
        }
        for child in values {
            if history::hash(child) {
                children.insert(child.to_owned());
            }
        }
    }
    Ok(children.into_iter().take(10_000).collect())
}
pub async fn detail(cwd: &Path, command: &Value, scope: &Scope) -> Result<Value> {
    let revision = command["revision"].as_js_string().unwrap();
    let hash = history::resolve(cwd, revision, scope).await?;
    let metadata = process::raw(
        cwd,
        &[
            "show",
            "-s",
            "--date=iso-strict",
            "--format=%H%x00%h%x00%P%x00%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00%s%x00%B%x00%D",
            &hash,
        ],
        scope,
    )
    .await?;
    let metadata = metadata.trim_end_matches(cantrip_wire::text::whitespace);
    let fields: Vec<_> = metadata.split('\0').collect();
    let field = |index| fields.get(index).copied().unwrap_or("");
    let parents: Vec<_> = field(2).split(' ').filter(|s| !s.is_empty()).collect();
    let index = command["parentIndex"].as_u64().unwrap_or(0) as usize;
    if !parents.is_empty() && index >= parents.len() {
        return Err(history::message(
            "Commit ",
            revision,
            &format!(" does not have parent {}.", index + 1),
        ));
    }
    let index = (!parents.is_empty()).then_some(index);
    let base = index.map(|index| parents[index]);
    let branch = process::text(cwd, &["branch", "--show-current"], scope).await?;
    let remotes = process::text(cwd, &["remote"], scope)
        .await
        .unwrap_or_default();
    let (files, children) = tokio::join!(
        files(cwd, base, &hash, scope),
        children(cwd, &hash, &command["revisions"], scope)
    );
    let files = files?;
    let message = JsString::from(field(10));
    let author = json!({"name":field(3),"email":field(4),"date":field(5)});
    let committer = json!({"name":field(6),"email":field(7),"date":field(8)});
    checked(
        "gitCommitDetailSchema",
        &json!({"hash":field(0),"shortHash":field(1),"parents":parents,"children":children?,"subject":field(9),"message":JsString::new(message.units().iter().take(MESSAGE_LIMIT).copied().collect()),"messageTruncated":message.len()>MESSAGE_LIMIT,"parentIndex":index,"baseHash":base,"author":author,"committer":committer,"signature":Value::Null,"refs":history::refs(field(11),&branch,&remotes),"filesChanged":files.total,"filesTruncated":files.truncated,"additions":sum(&files.files,"additions"),"deletions":sum(&files.files,"deletions"),"files":files.files}),
    )
}
pub async fn candidates(cwd: &Path, scope: &Scope) -> Result<Value> {
    let (head, refs) = tokio::join!(
        async { history::resolve(cwd, &"HEAD".into(), scope).await },
        process::raw(
            cwd,
            &[
                "for-each-ref",
                "--format=%(refname)%00%(refname:short)%00%(objectname)%00%(objecttype)%00%(*objectname)%00%(*objecttype)%00%(HEAD)",
                "refs/heads",
                "refs/remotes",
                "refs/tags"
            ],
            scope
        )
    );
    let head = head.unwrap_or_default();
    scope.check()?;
    let mut result = Vec::new();
    if !head.is_empty() {
        result.push(json!({"revision":head,"hash":head,"shortHash":&head[..10],"name":"HEAD","kind":"head","current":true,"worktreeId":Value::Null,"worktreeName":Value::Null}));
    }
    for line in refs?.split('\n').filter(|s| !s.is_empty()) {
        let fields: Vec<_> = line.split('\0').collect();
        let f = |index| fields.get(index).copied().unwrap_or("");
        let hash = if f(5) == "commit" { f(4) } else { f(2) };
        if f(0).is_empty()
            || f(1).is_empty()
            || (f(5) != "commit" && f(3) != "commit")
            || !history::hash(hash)
        {
            continue;
        }
        let kind = if f(0).starts_with("refs/tags/") {
            "tag"
        } else if f(0).starts_with("refs/remotes/") {
            "remote"
        } else {
            "local"
        };
        result.push(json!({"revision":hash,"hash":hash,"shortHash":&hash[..10],"name":f(1),"kind":kind,"current":f(6)=="*","worktreeId":Value::Null,"worktreeName":Value::Null}));
        if result.len() >= 20_000 {
            break;
        }
    }
    checked("gitRevisionCandidateListSchema", &json!(result))
}
async fn comparison_commits(
    cwd: &Path,
    include: &str,
    exclude: &str,
    scope: &Scope,
) -> Result<(Vec<Value>, bool)> {
    let output = process::raw(
        cwd,
        &[
            "log",
            "--topo-order",
            "--date=iso-strict",
            "--max-count=101",
            "--pretty=format:%H%x00%h%x00%an%x00%aI%x00%s%x1e",
            include,
            &format!("^{exclude}"),
        ],
        scope,
    )
    .await?;
    let mut parsed = output.split('\x1e').map(process::trim).filter(|s|!s.is_empty()).filter_map(|record| {
        let fields: Vec<_> = record.split('\0').collect();
        let f = |index|fields.get(index).copied().unwrap_or("");
        if [0,1,2,3].iter().any(|&i|f(i).is_empty()){return None;}
        Some(json!({"hash":f(0),"shortHash":f(1),"authorName":f(2),"authoredAt":f(3),"subject":f(4)}))
    }).collect::<Vec<_>>();
    let truncated = parsed.len() > 100;
    parsed.truncate(100);
    Ok((parsed, truncated))
}
pub async fn compare(cwd: &Path, command: &Value, scope: &Scope) -> Result<Value> {
    let (left, right) = tokio::join!(
        history::resolve(cwd, command["left"].as_js_string().unwrap(), scope),
        history::resolve(cwd, command["right"].as_js_string().unwrap(), scope)
    );
    let left = left?;
    let right = right?;
    let merge_base = process::text(cwd, &["merge-base", &left, &right], scope)
        .await
        .unwrap_or_default();
    scope.check()?;
    let mode = command["mode"].as_str().unwrap();
    if mode == "merge-base" && !history::hash(&merge_base) {
        bail!("The selected revisions do not share a merge base.");
    }
    let base = if mode == "merge-base" {
        &merge_base
    } else {
        &left
    };
    let counts_args = [
        "rev-list",
        "--left-right",
        "--count",
        &format!("{left}...{right}"),
    ];
    let (counts, l, r, files) = tokio::join!(
        process::text(cwd, &counts_args, scope),
        comparison_commits(cwd, &left, &right, scope),
        comparison_commits(cwd, &right, &left, scope),
        files(cwd, Some(base), &right, scope)
    );
    let counts = counts?;
    let mut counts = counts.split_whitespace();
    let (l, lt) = l?;
    let (r, rt) = r?;
    let files = files?;
    checked(
        "gitComparisonSchema",
        &json!({"mode":mode,"left":left,"right":right,"mergeBase":history::hash(&merge_base).then_some(&merge_base),"diffBase":base,"leftAhead":history::integer(counts.next().unwrap_or("0")),"rightAhead":history::integer(counts.next().unwrap_or("0")),"leftCommits":l,"rightCommits":r,"leftCommitsTruncated":lt,"rightCommitsTruncated":rt,"filesChanged":files.total,"filesTruncated":files.truncated,"additions":sum(&files.files,"additions"),"deletions":sum(&files.files,"deletions"),"files":files.files}),
    )
}
pub async fn revision_diff(cwd: &Path, command: &Value, scope: &Scope) -> Result<Value> {
    let path = command["path"].as_js_string().unwrap();
    if !diff::safe(path) {
        bail!("Invalid Git diff path.");
    }
    let hash = history::resolve(cwd, command["revision"].as_js_string().unwrap(), scope).await?;
    let base = if let Some(revision) = command["baseRevision"]
        .as_js_string()
        .filter(|s| !s.is_empty())
    {
        Some(history::resolve(cwd, revision, scope).await?)
    } else {
        None
    };
    let files = files(cwd, base.as_deref(), &hash, scope).await?;
    let file = files
        .files
        .iter()
        .find(|file| file["path"].as_js_string() == Some(path))
        .ok_or_else(|| history::message("No revision change exists for ", path, "."))?;
    let original = file["originalPath"].as_js_string().unwrap_or(path);
    let unified = format!(
        "--unified={}",
        command["contextLines"].as_u64().unwrap_or(3)
    );
    let common = [
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        &unified,
        "-M",
        "-C",
    ];
    let mut args = if base.is_some() {
        vec!["diff"]
    } else {
        vec!["diff-tree", "--root", "--no-commit-id", "-r", "-p"]
    };
    args.extend(common);
    if let Some(base) = &base {
        args.push(base);
    }
    args.extend([&hash, "--"]);
    let original_text = original.lossy();
    let path_text = path.lossy();
    if base.is_some() {
        args.push(&original_text);
    }
    args.push(&path_text);
    let output = process::capture(cwd, &args, scope).await?;
    if !output.overflow && output.code != Some(0) {
        bail!("{}", output.error);
    }
    let patch = JsString::from(String::from_utf8_lossy(&output.bytes).as_ref());
    let binary = file["binary"] == true;
    let (old, new) = tokio::join!(
        diff::object(
            cwd,
            base.as_ref().map(|base| format!("{base}:{original_text}")),
            original,
            binary,
            scope
        ),
        diff::object(
            cwd,
            Some(format!("{hash}:{path_text}")),
            path,
            binary,
            scope
        )
    );
    checked(
        "gitRevisionFileDiffSchema",
        &json!({"revision":hash,"baseRevision":base,"path":path,"originalPath":file["originalPath"].clone(),"patch":JsString::new(patch.units().iter().take(diff::PATCH_LIMIT).copied().collect()),"truncated":output.overflow||patch.len()>diff::PATCH_LIMIT,"binary":binary,"oldFile":old?,"newFile":new?}),
    )
}
