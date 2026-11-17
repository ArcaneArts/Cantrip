//! Branch inventory, worktree ownership and the existing reviewed Git actions.
use super::{GitError, history, process, review, status};
use crate::filesystem::{Scope, paths};
use anyhow::{Result, bail};
use cantrip_crypto::checked;
use cantrip_wire::{JsString, Value, value::json};
use indexmap::{IndexMap, IndexSet};
use std::path::{Path, PathBuf};

pub(super) fn render(pattern: &str, args: &[&JsString]) -> JsString {
    let mut parts = pattern.split("{}");
    let mut units = parts.next().unwrap().encode_utf16().collect::<Vec<_>>();
    for (arg, part) in args.iter().zip(parts) {
        units.extend_from_slice(arg.units());
        units.extend(part.encode_utf16());
    }
    JsString::new(units)
}
fn failure(pattern: &str, args: &[&JsString]) -> anyhow::Error {
    GitError(render(pattern, args)).into()
}
async fn canonical(path: &Path) -> Result<PathBuf> {
    match tokio::fs::canonicalize(path).await {
        Ok(path) => Ok(path),
        Err(_) => {
            let base = if path.is_absolute() {
                PathBuf::new()
            } else {
                std::env::current_dir()?
            };
            Ok(cantrip_config::resolve(&base, path))
        }
    }
}
async fn owners(cwd: &Path, scope: &Scope) -> Result<IndexMap<String, Value>> {
    let output = process::raw(cwd, &["worktree", "list", "--porcelain", "-z"], scope).await?;
    let current = canonical(cwd).await?;
    let mut path = "";
    let mut owners = IndexMap::new();
    for record in output.split('\0') {
        if let Some(value) = record.strip_prefix("worktree ") {
            path = value;
            continue;
        }
        if let Some(branch) = record.strip_prefix("branch refs/heads/")
            && !path.is_empty()
        {
            let resolved = canonical(Path::new(path)).await?;
            let label = Path::new(path)
                .file_name()
                .map(|name| paths::text(Path::new(name)))
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| path.into());
            owners.insert(
                branch.to_owned(),
                json!({"label":label,"current":resolved==current}),
            );
        }
    }
    scope.check()?;
    Ok(owners)
}
fn count(track: &str, prefix: &str) -> f64 {
    track
        .split_once(prefix)
        .map(|(_, value)| {
            value
                .chars()
                .take_while(char::is_ascii_digit)
                .collect::<String>()
        })
        .map(|v| history::integer(&v))
        .filter(|v| v.is_finite())
        .unwrap_or(0.0)
}
pub async fn list(cwd: &Path, scope: &Scope) -> Result<Value> {
    let head = process::text(cwd, &["rev-parse", "--verify", "HEAD"], scope)
        .await
        .unwrap_or_default();
    scope.check()?;
    let (branch, remotes, refs, owners, merged) = tokio::join!(
        process::text(cwd, &["branch", "--show-current"], scope),
        process::text(cwd, &["remote"], scope),
        process::raw(
            cwd,
            &[
                "for-each-ref",
                "--format=%(refname)%00%(refname:short)%00%(objectname)%00%(upstream:short)%00%(upstream:track)%00%(authorname)%00%(authordate:iso-strict)%00%(subject)",
                "refs/heads",
                "refs/remotes"
            ],
            scope
        ),
        owners(cwd, scope),
        async {
            if head.is_empty() {
                return Ok::<_, anyhow::Error>(Vec::<String>::new());
            }
            let (local, remote) = tokio::join!(
                process::text(
                    cwd,
                    &["branch", "--format=%(refname:short)", "--merged", "HEAD"],
                    scope
                ),
                process::text(
                    cwd,
                    &[
                        "branch",
                        "-r",
                        "--format=%(refname:short)",
                        "--merged",
                        "HEAD"
                    ],
                    scope
                )
            );
            Ok(vec![local?, remote?])
        }
    );
    let branch = branch?;
    let owners = owners?;
    let remote_output = remotes?;
    let mut remotes = remote_output
        .split('\n')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>();
    remotes.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    let remote_set = remotes.iter().copied().collect::<IndexSet<_>>();
    let merged = merged?
        .iter()
        .flat_map(|s| s.split('\n').filter(|s| !s.is_empty()).map(str::to_owned))
        .collect::<IndexSet<_>>();
    let mut branches = Vec::new();
    for line in refs?
        .split('\n')
        .map(|s| s.trim_end_matches(cantrip_wire::text::whitespace))
        .filter(|s| !s.is_empty())
    {
        let fields = line.split('\0').collect::<Vec<_>>();
        let f = |i| fields.get(i).copied().unwrap_or("");
        if [0, 1, 2, 6].iter().any(|&i| f(i).is_empty()) || f(0).ends_with("/HEAD") {
            continue;
        }
        let remote = f(0).starts_with("refs/remotes/");
        let name = f(1);
        let upstream = f(3);
        let track = f(4);
        let remote_name = if remote {
            Some(name.split('/').next().unwrap_or(""))
        } else if !upstream.is_empty() {
            Some(upstream.split('/').next().unwrap_or(""))
        } else {
            None
        };
        let gone = track.contains("gone");
        let worktree = if remote {
            Value::Null
        } else {
            owners.get(name).cloned().unwrap_or(Value::Null)
        };
        branches.push(json!({"name":name,"fullRef":f(0),"kind":if remote{"remote"}else{"local"},"current":!remote&&name==branch,"hash":f(2),"upstream":(!upstream.is_empty()).then_some(upstream),"upstreamGone":gone,"ahead":count(track,"ahead "),"behind":count(track,"behind "),"mergedIntoHead":(!head.is_empty()).then(||merged.contains(name)),"remoteName":remote_name,"remoteAvailable":if remote{remote_name.is_some_and(|n|remote_set.contains(n))}else{!upstream.is_empty()&&!gone},"trackingLocalBranches":Vec::<Value>::new(),"worktree":worktree,"lastCommit":json!({"hash":f(2),"shortHash":f(2).chars().take(8).collect::<String>(),"subject":f(7),"authorName":if f(5).is_empty(){"Unknown"}else{f(5)},"authoredAt":f(6)})}));
    }
    let locals = branches
        .iter()
        .filter(|b| b["kind"] == "local")
        .cloned()
        .collect::<Vec<_>>();
    for branch in &mut branches {
        if branch["kind"] == "remote" {
            branch["trackingLocalBranches"] = json!(
                locals
                    .iter()
                    .filter(|local| local["upstream"] == branch["name"])
                    .map(|local| local["name"].clone())
                    .collect::<Vec<_>>()
            );
        }
    }
    let collator = status::collator()?;
    branches.sort_by(|a, b| {
        let current = (b["current"] == true).cmp(&(a["current"] == true));
        if !current.is_eq() {
            return current;
        }
        let kind = (b["kind"] == "local").cmp(&(a["kind"] == "local"));
        if !kind.is_eq() {
            return kind;
        }
        collator.compare_utf16_icu4c(
            a["name"].as_js_string().unwrap().units(),
            b["name"].as_js_string().unwrap().units(),
        )
    });
    let truncated = branches.len() > 20_000;
    branches.truncate(20_000);
    let configured = if !branch.is_empty() {
        let value = process::text(
            cwd,
            &["config", "--get", &format!("branch.{branch}.remote")],
            scope,
        )
        .await
        .unwrap_or_default();
        scope.check()?;
        value
    } else {
        String::new()
    };
    let default = if !configured.is_empty() && configured != "." {
        Some(configured.as_str())
    } else if remotes.contains(&"origin") {
        Some("origin")
    } else {
        remotes.first().copied()
    };
    checked(
        "gitBranchListSchema",
        &json!({"currentBranch":(!branch.is_empty()).then_some(branch.as_str()),"head":(!head.is_empty()).then_some(head),"detached":branch.is_empty(),"defaultRemote":default,"remotes":remotes,"pullStrategy":json!({"mode":"fast-forward-only","description":"Cantrip pulls with --ff-only after fetching, so it never creates an implicit merge or rebase."}),"branches":branches,"truncated":truncated,"generatedAt":chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis,true)}),
    )
}
fn find(inventory: &Value, name: &JsString, kind: Option<&str>) -> Value {
    inventory["branches"]
        .as_array()
        .unwrap()
        .iter()
        .find(|b| {
            b["name"].as_js_string() == Some(name) && kind.is_none_or(|kind| b["kind"] == kind)
        })
        .cloned()
        .unwrap_or(Value::Null)
}
fn local(inventory: &Value, name: &JsString) -> Result<Value> {
    let branch = find(inventory, name, Some("local"));
    if branch.is_null() {
        return Err(failure("Local branch {} does not exist.", &[name]));
    }
    Ok(branch)
}
fn remote(inventory: &Value, name: &JsString) -> Result<()> {
    if !inventory["remotes"]
        .as_array()
        .unwrap()
        .iter()
        .any(|v| v.as_js_string() == Some(name))
    {
        return Err(failure("Git remote {} does not exist.", &[name]));
    }
    Ok(())
}
async fn validate(
    cwd: &Path,
    action: &Value,
    inventory: &Value,
    scope: &Scope,
) -> Result<(Value, JsString, Vec<JsString>)> {
    let kind = action["type"].as_str().unwrap();
    let empty = JsString::from("");
    let name = action["name"].as_js_string().unwrap_or(&empty);
    let mut branch = Value::Null;
    let mut warnings = Vec::new();
    let summary;
    if action.get("name").is_some() && kind != "switch" {
        process::run(cwd, &["check-ref-format", "--branch", &name.lossy()], scope).await?;
    }
    match kind {
        "create" => {
            if !find(inventory, name, Some("local")).is_null() {
                return Err(failure("Local branch {} already exists.", &[name]));
            }
            let point = action["startPoint"]
                .as_js_string()
                .filter(|v| !v.is_empty());
            if point.is_none() && inventory["head"].is_null() {
                bail!(
                    "An unborn repository needs an existing start point before a branch can be created."
                );
            }
            if let Some(point) = point {
                process::run(
                    cwd,
                    &[
                        "rev-parse",
                        "--verify",
                        "--end-of-options",
                        &format!("{}^{{commit}}", point.lossy()),
                    ],
                    scope,
                )
                .await?;
            }
            if action["checkout"] == true
                && !status::status(cwd, scope).await?["files"]
                    .as_array()
                    .unwrap()
                    .is_empty()
            {
                warnings.push(
                    "Local changes will remain in the worktree while switching to the new branch."
                        .into(),
                );
            }
            let prefix: JsString = if action["checkout"] == true {
                "Create and switch to"
            } else {
                "Create"
            }
            .into();
            let ending = point
                .map(|point| render(" at {}", &[point]))
                .unwrap_or_else(|| " at the current HEAD".into());
            summary = render("{} local branch {}{}.", &[&prefix, name, &ending]);
        }
        "switch" => {
            process::run(cwd, &["check-ref-format", "--branch", &name.lossy()], scope).await?;
            branch = find(inventory, name, action["kind"].as_str());
            if branch.is_null() {
                return Err(failure("Branch {} does not exist.", &[name]));
            }
            if branch["kind"] == "local"
                && !branch["worktree"].is_null()
                && branch["worktree"]["current"] != true
            {
                return Err(failure(
                    "{} is checked out in worktree {}. Switch to that worktree instead.",
                    &[name, branch["worktree"]["label"].as_js_string().unwrap()],
                ));
            }
            if !status::status(cwd, scope).await?["files"]
                .as_array()
                .unwrap()
                .is_empty()
            {
                warnings.push("Local changes must be compatible with the target branch or Git will refuse the switch.".into());
            }
            summary = render("Switch this worktree to {}.", &[name]);
        }
        "publish" => {
            branch = local(inventory, name)?;
            let target = action["remote"].as_js_string().unwrap();
            remote(inventory, target)?;
            summary = render(
                "Push {} to {} and set {}/{} as its upstream.",
                &[name, target, target, name],
            );
        }
        "rename" => {
            branch = local(inventory, name)?;
            let new = action["newName"].as_js_string().unwrap();
            process::run(cwd, &["check-ref-format", "--branch", &new.lossy()], scope).await?;
            if !find(inventory, new, Some("local")).is_null() {
                return Err(failure("Local branch {} already exists.", &[new]));
            }
            if !branch["worktree"].is_null() && branch["worktree"]["current"] != true {
                return Err(failure(
                    "{} is checked out in worktree {} and cannot be renamed here.",
                    &[name, branch["worktree"]["label"].as_js_string().unwrap()],
                ));
            }
            if let Some(upstream) = branch["upstream"].as_js_string() {
                warnings.push(render(
                    "The upstream remains {}; renaming does not rename the remote branch.",
                    &[upstream],
                ));
            }
            summary = render("Rename local branch {} to {}.", &[name, new]);
        }
        "deleteLocal" => {
            branch = local(inventory, name)?;
            if branch["current"] == true {
                bail!("The current branch cannot be deleted.");
            }
            if !branch["worktree"].is_null() {
                return Err(failure(
                    "{} is checked out in worktree {} and cannot be deleted.",
                    &[name, branch["worktree"]["label"].as_js_string().unwrap()],
                ));
            }
            if branch["mergedIntoHead"] != true && action["force"] == true {
                warnings.push("This branch is not merged into the current HEAD. Its commits may become reachable only through the reflog.".into());
            }
            let suffix = JsString::from(if action["force"] == true {
                " even though it is unmerged"
            } else {
                " if it is merged"
            });
            summary = render("Delete local branch {}{}.", &[name, &suffix]);
        }
        "deleteRemote" => {
            let target = action["remote"].as_js_string().unwrap();
            remote(inventory, target)?;
            process::run(cwd, &["check-ref-format", "--branch", &name.lossy()], scope).await?;
            let full = render("{}/{}", &[target, name]);
            branch = find(inventory, &full, Some("remote"));
            if branch.is_null() {
                return Err(failure(
                    "Remote branch {} does not exist locally. Fetch before retrying.",
                    &[&full],
                ));
            }
            warnings
                .push("This deletes the branch for every collaborator using this remote.".into());
            summary = render("Delete remote branch {}.", &[&full]);
        }
        "setUpstream" => {
            branch = local(inventory, name)?;
            if let Some(upstream) = action["upstream"].as_js_string() {
                if find(inventory, upstream, Some("remote")).is_null() {
                    return Err(failure("Remote branch {} does not exist.", &[upstream]));
                }
                summary = render("Set {} as the upstream for {}.", &[upstream, name]);
            } else {
                if branch["upstream"].is_null() {
                    return Err(failure("{} does not have an upstream to unset.", &[name]));
                }
                summary = render("Unset the upstream for {}.", &[name]);
            }
        }
        _ => {
            let target = action["remote"].as_js_string();
            if let Some(target) = target {
                remote(inventory, target)?;
            }
            if action["prune"] == true {
                warnings.push(
                    "Prune removes local remote-tracking refs that no longer exist on the remote."
                        .into(),
                );
            }
            let prefix = JsString::from(if action["prune"] == true {
                "Fetch and prune"
            } else {
                "Fetch"
            });
            let all = JsString::from("all remotes");
            summary = render("{} {}.", &[&prefix, target.unwrap_or(&all)]);
        }
    }
    Ok((branch, summary, warnings))
}
pub async fn preview(cwd: &Path, action: &Value, scope: &Scope) -> Result<Value> {
    let inventory = list(cwd, scope).await?;
    let (branch, summary, warnings) = validate(cwd, action, &inventory, scope).await?;
    let workspace = review::workspace(cwd, scope).await?;
    let refs=inventory["branches"].as_array().unwrap().iter().map(|b|json!({"fullRef":b["fullRef"].clone(),"hash":b["hash"].clone(),"upstream":b["upstream"].clone(),"worktree":b["worktree"].clone()})).collect::<Vec<_>>();
    let header =
        json!({"action":action,"head":inventory["head"].clone(),"refs":refs,"workspace":workspace})
            .stringify();
    checked(
        "gitBranchActionPreviewSchema",
        &json!({"action":action,"token":review::digest(&[header.as_bytes()]),"destructive":matches!(action["type"].as_str(),Some("deleteLocal"|"deleteRemote"))||(action["type"]=="fetch"&&action["prune"]==true),"branch":branch,"summary":summary,"warnings":warnings}),
    )
}
pub async fn apply(cwd: &Path, action: &Value, token: &JsString, scope: &Scope) -> Result<Value> {
    let preview = preview(cwd, action, scope).await?;
    if preview["token"].as_js_string() != Some(token) {
        bail!("The branches or worktree changed after this preview. Review the action again.");
    }
    let kind = action["type"].as_str().unwrap();
    let name = action["name"]
        .as_js_string()
        .map(|s| s.lossy().into_owned())
        .unwrap_or_default();
    let args: Vec<String> = match kind {
        "create" => {
            let mut args = if action["checkout"] == true {
                vec!["switch".into(), "-c".into(), name]
            } else {
                vec!["branch".into(), name]
            };
            if let Some(point) = action["startPoint"].as_js_string() {
                args.push(point.lossy().into_owned());
            }
            args
        }
        "switch" => {
            let selected = &preview["branch"];
            let name = selected["name"].as_str().unwrap();
            if selected["kind"] == "local" {
                vec!["switch".into(), name.into()]
            } else {
                let local = name.split('/').skip(1).collect::<Vec<_>>().join("/");
                if local.is_empty() {
                    bail!("The remote branch has no local branch name.");
                }
                vec![
                    "switch".into(),
                    "--track".into(),
                    "-c".into(),
                    local,
                    name.into(),
                ]
            }
        }
        "publish" => vec![
            "push".into(),
            "--set-upstream".into(),
            action["remote"]
                .as_js_string()
                .unwrap()
                .lossy()
                .into_owned(),
            name,
        ],
        "rename" => {
            let new = action["newName"]
                .as_js_string()
                .unwrap()
                .lossy()
                .into_owned();
            if preview["branch"]["current"] == true {
                vec!["branch".into(), "-m".into(), new]
            } else {
                vec!["branch".into(), "-m".into(), name, new]
            }
        }
        "deleteLocal" => vec![
            "branch".into(),
            if action["force"] == true { "-D" } else { "-d" }.into(),
            name,
        ],
        "deleteRemote" => vec![
            "push".into(),
            action["remote"]
                .as_js_string()
                .unwrap()
                .lossy()
                .into_owned(),
            "--delete".into(),
            name,
        ],
        "setUpstream" => vec![
            "branch".into(),
            action["upstream"]
                .as_js_string()
                .map(|s| format!("--set-upstream-to={}", s.lossy()))
                .unwrap_or_else(|| "--unset-upstream".into()),
            name,
        ],
        _ => {
            let mut args = vec![
                "fetch".into(),
                action["remote"]
                    .as_js_string()
                    .map(|s| s.lossy().into_owned())
                    .unwrap_or_else(|| "--all".into()),
            ];
            if action["prune"] == true {
                args.push("--prune".into());
            }
            args
        }
    };
    let output = process::run(
        cwd,
        &args.iter().map(String::as_str).collect::<Vec<_>>(),
        scope,
    )
    .await?;
    checked(
        "gitBranchMutationResultSchema",
        &json!({"output":output,"status":status::status(cwd,scope).await?,"branches":list(cwd,scope).await?}),
    )
}
