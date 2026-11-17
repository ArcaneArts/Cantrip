//! Worktree-scoped submodule inventory and the source's reviewed actions.
use super::{GitError, branches::render, process, remote_text, review, status};
use crate::filesystem::{Scope, paths};
use anyhow::{Result, bail};
use cantrip_crypto::checked;
use cantrip_wire::{JsString, Value, value::json};
use indexmap::IndexMap;
use regress::Regex;
use std::{path::Path, sync::LazyLock};

static STATUS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::with_flags(r"^([ +\-U])([0-9a-f]{40,64})\s+(.+?)(?:\s+\(.*\))?$", "u").unwrap()
});
static EXPECTED: LazyLock<Regex> =
    LazyLock::new(|| Regex::with_flags(r"^160000\s+([0-9a-f]{40,64})\s", "u").unwrap());
static CONFIGURATION: LazyLock<Regex> =
    LazyLock::new(|| Regex::with_flags(r"^submodule\.(.*)\.(path|url|branch)$", "u").unwrap());
#[derive(Default)]
struct Section {
    path: Option<String>,
    url: Option<String>,
    branch: Option<String>,
}
struct Configuration {
    name: String,
    path: String,
    local_path: String,
    parent_path: String,
    url: JsString,
    branch: Option<String>,
}
/// Keep source lexical slash normalization and prefix checks; do not silently
/// canonicalize configured paths or change their serialized review-token bytes.
fn safe_path(cwd: &Path, candidate: &str) -> Result<Option<String>> {
    let normalized = candidate.replace('\\', "/");
    let normalized = normalized.strip_prefix("./").unwrap_or(&normalized);
    if normalized.is_empty() || normalized == "." {
        return Ok(None);
    }
    let root = paths::resolve(cwd)?;
    let absolute = cantrip_config::resolve(&root, &paths::native(&normalized.into()));
    let mut prefix = paths::text(&root).units().to_vec();
    prefix.push(std::path::MAIN_SEPARATOR as u16);
    Ok(paths::text(&absolute)
        .units()
        .starts_with(&prefix)
        .then(|| normalized.to_owned()))
}
async fn text_or_empty(cwd: &Path, args: &[&str], scope: &Scope) -> Result<String> {
    let text = process::text(cwd, args, scope).await.unwrap_or_default();
    scope.check()?;
    Ok(text)
}
async fn configuration(
    cwd: &Path,
    file: &str,
    parent: &str,
    scope: &Scope,
) -> Result<Vec<Configuration>> {
    let metadata = tokio::fs::symlink_metadata(cantrip_config::resolve(cwd, Path::new(file))).await;
    scope.check()?;
    if !metadata.is_ok_and(|metadata| metadata.is_file()) {
        return Ok(Vec::new());
    }
    let output = text_or_empty(
        cwd,
        &[
            "config",
            "-f",
            file,
            "--get-regexp",
            r"^submodule\..*\.(path|url|branch)$",
        ],
        scope,
    )
    .await?;
    let mut sections: IndexMap<String, Section> = IndexMap::new();
    for line in output.split('\n') {
        let Some((key, value)) = line.split_once(' ') else {
            continue;
        };
        let Some(found) = CONFIGURATION.find(key) else {
            continue;
        };
        let name = &key[found.group(1).unwrap()];
        let field = &key[found.group(2).unwrap()];
        if name.is_empty() {
            continue;
        }
        let section = sections.entry(name.to_owned()).or_default();
        match field {
            "path" => section.path = Some(value.to_owned()),
            "url" => section.url = Some(value.to_owned()),
            _ => section.branch = Some(value.to_owned()),
        }
    }
    let mut result = Vec::new();
    for (name, section) in sections {
        let (Some(path), Some(url)) = (section.path, section.url) else {
            continue;
        };
        if path.is_empty() || url.is_empty() {
            continue;
        }
        let Some(local_path) = safe_path(cwd, &path)? else {
            continue;
        };
        let Some(full_path) = safe_path(
            cwd,
            &if parent.is_empty() {
                path
            } else {
                format!("{parent}/{path}")
            },
        )?
        else {
            continue;
        };
        result.push(Configuration {
            name: if parent.is_empty() {
                name
            } else {
                format!("{parent}:{name}")
            },
            path: full_path,
            local_path,
            parent_path: parent.to_owned(),
            url: remote_text::sanitize(&url.into()).0,
            branch: section.branch.filter(|value| !value.is_empty()),
        });
    }
    Ok(result)
}
struct Observed {
    hash: String,
    marker: u8,
}
fn statuses(output: &str) -> IndexMap<String, Observed> {
    let mut result = IndexMap::new();
    for line in output.split('\n') {
        if let Some(found) = STATUS.find(line) {
            let f = |index| &line[found.group(index).unwrap()];
            result.insert(
                f(3).to_owned(),
                Observed {
                    hash: f(2).to_owned(),
                    marker: f(1).as_bytes()[0],
                },
            );
        }
    }
    result
}
pub async fn list(cwd: &Path, scope: &Scope) -> Result<Value> {
    let output = process::raw(
        cwd,
        &[
            "-c",
            "core.quotePath=false",
            "submodule",
            "status",
            "--recursive",
        ],
        scope,
    )
    .await
    .unwrap_or_default();
    scope.check()?;
    let statuses = statuses(&output);
    let mut files = IndexMap::from([(String::new(), ".gitmodules".to_owned())]);
    for (path, observed) in &statuses {
        if observed.marker != b'-' {
            files.insert(path.clone(), format!("{path}/.gitmodules"));
        }
    }
    // Join every accepted query before propagating stop/errors, preserving the
    // collectors' opportunity to terminate and reap their owned process groups.
    let rows = futures::future::join_all(
        files
            .into_iter()
            .map(|(parent, file)| async move { configuration(cwd, &file, &parent, scope).await }),
    )
    .await
    .into_iter()
    .collect::<Result<Vec<_>>>()?;
    let mut configured = rows.into_iter().flatten().collect::<Vec<_>>();
    let collator = status::collator()?;
    configured.sort_by(|a, b| {
        collator.compare_utf16_icu4c(
            JsString::from(a.path.as_str()).units(),
            JsString::from(b.path.as_str()).units(),
        )
    });
    let truncated = configured.len() > 10_000;
    configured.truncate(10_000);
    let statuses = &statuses;
    let submodules =
        futures::future::join_all(configured.into_iter().map(|configuration| async move {
            let observed = statuses.get(&configuration.path);
            let initialized = observed.is_some_and(|value| value.marker != b'-');
            let parent = if configuration.parent_path.is_empty() {
                cwd.to_owned()
            } else {
                cantrip_config::resolve(cwd, Path::new(&configuration.parent_path))
            };
            let child = cantrip_config::resolve(cwd, Path::new(&configuration.path));
            let expected_args = ["ls-files", "--stage", "--", &configuration.local_path];
            let (expected, dirty) =
                tokio::join!(text_or_empty(&parent, &expected_args, scope), async {
                    if initialized {
                        Ok::<_, anyhow::Error>(
                            !text_or_empty(
                                &child,
                                &["status", "--porcelain=v1", "--untracked-files=normal"],
                                scope,
                            )
                            .await?
                            .is_empty(),
                        )
                    } else {
                        Ok(false)
                    }
                });
            let expected = expected?;
            let expected = EXPECTED
                .find(&expected)
                .and_then(|found| found.group(1))
                .map(|range| expected[range].to_owned());
            let dirty = dirty?;
            let state = match observed.map(|value| value.marker) {
                None => "missing",
                Some(b'-') => "uninitialized",
                Some(b'U') => "conflicted",
                Some(b'+') => "changed",
                _ if dirty => "changed",
                _ => "clean",
            };
            Ok::<_, anyhow::Error>(json!({
                "name": configuration.name, "path": configuration.path,
                "url": configuration.url, "branch": configuration.branch,
                "expectedHash": expected,
                "currentHash": observed.filter(|_| initialized).map(|value| value.hash.as_str()),
                "initialized": initialized, "dirty": dirty,
                "nested": !configuration.parent_path.is_empty(), "state": state
            }))
        }))
        .await
        .into_iter()
        .collect::<Result<Vec<_>>>()?;
    checked(
        "gitSubmoduleListSchema",
        &json!({"submodules":submodules,"truncated":truncated,"generatedAt":chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis,true)}),
    )
}
fn failure(path: &JsString) -> anyhow::Error {
    GitError(render("Submodule {} does not exist.", &[path])).into()
}
fn child_of(path: &JsString, parent: &JsString) -> bool {
    let mut prefix = parent.units().to_vec();
    prefix.push(47);
    path.units().starts_with(&prefix)
}
fn selected(inventory: &Value, action: &Value) -> Result<Vec<Value>> {
    let rows = inventory["submodules"].as_array().unwrap();
    let path = action["path"].as_js_string();
    if action["type"] == "deinitialize" {
        let path = path.unwrap();
        return rows
            .iter()
            .find(|row| row["path"].as_js_string() == Some(path))
            .cloned()
            .map(|row| vec![row])
            .ok_or_else(|| failure(path));
    }
    let Some(path) = path else {
        return Ok(rows
            .iter()
            .filter(|row| action["recursive"] == true || row["nested"] != true)
            .cloned()
            .collect());
    };
    let selected = rows
        .iter()
        .filter(|row| {
            row["path"].as_js_string() == Some(path)
                || (action["recursive"] == true
                    && child_of(row["path"].as_js_string().unwrap(), path))
        })
        .cloned()
        .collect::<Vec<_>>();
    if !selected
        .iter()
        .any(|row| row["path"].as_js_string() == Some(path))
    {
        return Err(failure(path));
    }
    Ok(selected)
}
pub async fn preview(cwd: &Path, action: &Value, scope: &Scope) -> Result<Value> {
    let (inventory, workspace) = tokio::join!(list(cwd, scope), review::workspace(cwd, scope));
    let inventory = inventory?;
    let workspace = workspace?;
    let targets = selected(&inventory, action)?;
    if targets.is_empty() {
        bail!("No submodules match this action.");
    }
    let default_scope = JsString::from("all top-level submodules");
    let target = action["path"].as_js_string().unwrap_or(&default_scope);
    let nested = JsString::from(if action["recursive"] == true {
        " and nested submodules"
    } else {
        ""
    });
    let kind = action["type"].as_str().unwrap();
    let mut warnings = Vec::<&str>::new();
    let summary = match kind {
        "initialize" => render(
            "Initialize {}{} at the commits recorded by the repository.",
            &[target, &nested],
        ),
        "update" => {
            let prefix = JsString::from(if action["remote"] == true {
                "Fetch configured remote branches and update"
            } else {
                "Update"
            });
            if action["remote"] == true {
                warnings.push("Remote update can check out commits that differ from the superproject's recorded submodule commits.");
            }
            render("{} {}{}.", &[&prefix, target, &nested])
        }
        "sync" => render("Synchronize configured URLs for {}{}.", &[target, &nested]),
        _ => {
            if targets[0]["dirty"] == true && action["force"] != true {
                return Err(GitError(render("Submodule {} has local changes. Review again with force only if those changes may be discarded.",&[target])).into());
            }
            warnings.push("Deinitializing removes the submodule worktree but keeps its Git data and the superproject configuration.");
            if action["force"] == true {
                warnings.push("Force deinitialize discards local submodule changes.");
            }
            render(
                "Deinitialize submodule {} and remove its checked-out worktree.",
                &[target],
            )
        }
    };
    let header =
        json!({"action":action,"submodules":inventory["submodules"],"workspace":workspace})
            .stringify();
    checked(
        "gitSubmoduleActionPreviewSchema",
        &json!({"action":action,"token":review::digest(&[header.as_bytes()]),"destructive":kind=="deinitialize","summary":summary,"warnings":warnings,"targets":targets}),
    )
}
pub async fn apply(cwd: &Path, action: &Value, token: &JsString, scope: &Scope) -> Result<Value> {
    if preview(cwd, action, scope).await?["token"].as_js_string() != Some(token) {
        bail!(
            "The submodules or selected worktree changed after this preview. Review the action again."
        );
    }
    let action_path = action["path"].as_js_string();
    let inventory = if action_path.is_some() {
        Some(list(cwd, scope).await?)
    } else {
        None
    };
    let parent = action_path.and_then(|path| {
        inventory.as_ref().unwrap()["submodules"]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| row["path"].as_js_string().unwrap())
            .filter(|candidate| *candidate != path && child_of(path, candidate))
            .max_by_key(|candidate| candidate.len())
    });
    let directory = parent
        .map(|parent| cantrip_config::resolve(cwd, &paths::native(parent)))
        .unwrap_or_else(|| cwd.to_owned());
    let relative = action_path
        .map(|path| {
            parent
                .map(|parent| JsString::new(path.units()[parent.len() + 1..].to_vec()))
                .unwrap_or_else(|| path.clone())
        })
        .map(|path| path.lossy().into_owned());
    let mut args = vec!["submodule"];
    match action["type"].as_str().unwrap() {
        "initialize" => {
            args.extend(["update", "--init"]);
            if action["recursive"] == true {
                args.push("--recursive");
            }
        }
        "update" => {
            args.push("update");
            if action["recursive"] == true {
                args.push("--recursive");
            }
            if action["remote"] == true {
                args.push("--remote");
            }
        }
        "sync" => {
            args.push("sync");
            if action["recursive"] == true {
                args.push("--recursive");
            }
        }
        _ => {
            args.push("deinit");
            if action["force"] == true {
                args.push("--force");
            }
        }
    }
    if let Some(path) = relative.as_deref() {
        args.extend(["--", path]);
    }
    let output = process::run_bounded(&directory, &args, scope).await?;
    checked(
        "gitSubmoduleMutationResultSchema",
        &json!({"output":output,"status":status::status(cwd,scope).await?,"submodules":list(cwd,scope).await?}),
    )
}
