//! Remote configuration/defaults and reviewed bounded fetches through native Git.
use super::{GitError, branches::render, managed, process, remote_text, review, status};
use crate::filesystem::Scope;
use anyhow::{Result, bail};
use cantrip_crypto::checked;
use cantrip_wire::{JsString, Value, value::json};
use std::{path::Path, time::Duration};
async fn config(cwd: &Path, key: &str, scope: &Scope) -> Result<String> {
    let value = process::text(cwd, &["config", "--get", key], scope)
        .await
        .unwrap_or_default();
    scope.check()?;
    Ok(value)
}
pub async fn list(cwd: &Path, scope: &Scope) -> Result<Value> {
    let names = process::text(cwd, &["remote"], scope).await?;
    let mut names = names
        .split('\n')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>();
    names.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    let branch = process::text(cwd, &["branch", "--show-current"], scope).await?;
    let fetch = config(cwd, "cantrip.defaultFetchRemote", scope).await?;
    let branch_remote = if branch.is_empty() {
        String::new()
    } else {
        config(cwd, &format!("branch.{branch}.remote"), scope).await?
    };
    let push = config(cwd, "remote.pushDefault", scope).await?;
    let default_fetch = if !fetch.is_empty() && names.contains(&fetch.as_str()) {
        Some(fetch.as_str())
    } else if !branch_remote.is_empty()
        && branch_remote != "."
        && names.contains(&branch_remote.as_str())
    {
        Some(branch_remote.as_str())
    } else if names.contains(&"origin") {
        Some("origin")
    } else {
        names.first().copied()
    };
    let default_push = if !push.is_empty() && names.contains(&push.as_str()) {
        Some(push.as_str())
    } else {
        default_fetch
    };
    let remotes = futures::future::try_join_all(names.iter().map(|&name| async move {
        let fetch_args = ["remote", "get-url", name];
        let push_args = ["remote", "get-url", "--push", name];
        let (fetch, push) = tokio::join!(
            process::text(cwd, &fetch_args, scope),
            process::text(cwd, &push_args, scope)
        );
        let fetch = fetch?;
        let push = push.unwrap_or_default();
        scope.check()?;
        let (fetch_url, fetch_redacted) = remote_text::sanitize(&fetch.as_str().into());
        let (push_url, push_redacted) =
            remote_text::sanitize(&if push.is_empty() { fetch } else { push }.into());
        Ok::<_, anyhow::Error>(json!({
            "name": name,
            "fetchUrl": fetch_url,
            "fetchUrlRedacted": fetch_redacted,
            "pushUrl": push_url,
            "pushUrlRedacted": push_redacted,
            "defaultFetch": Some(name) == default_fetch,
            "defaultPush": Some(name) == default_push
        }))
    }))
    .await?;
    checked(
        "gitRemoteListSchema",
        &json!({"remotes":remotes,"generatedAt":chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis,true)}),
    )
}
fn selected(inventory: &Value, name: &JsString) -> Value {
    inventory["remotes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["name"].as_js_string() == Some(name))
        .cloned()
        .unwrap_or(Value::Null)
}
fn require(inventory: &Value, name: &JsString) -> Result<Value> {
    let value = selected(inventory, name);
    if value.is_null() {
        return Err(GitError(render("Git remote {} does not exist.", &[name])).into());
    }
    Ok(value)
}
pub async fn preview(cwd: &Path, action: &Value, scope: &Scope) -> Result<Value> {
    let inventory = list(cwd, scope).await?;
    let name = action["name"].as_js_string();
    let kind = action["type"].as_str().unwrap();
    let remote = name
        .or_else(|| (kind == "fetch").then(|| action["remote"].as_js_string().unwrap()))
        .map(|name| selected(&inventory, name))
        .unwrap_or(Value::Null);
    let summary;
    let mut warnings = Vec::<&str>::new();
    match kind {
        "add" => {
            let name = name.unwrap();
            process::run(
                cwd,
                &[
                    "check-ref-format",
                    &format!("refs/remotes/{}/probe", name.lossy()),
                ],
                scope,
            )
            .await?;
            if !remote.is_null() {
                return Err(GitError(render("Git remote {} already exists.", &[name])).into());
            }
            summary = render(
                "Add remote {} with fetch URL {}.",
                &[
                    name,
                    &remote_text::sanitize(action["fetchUrl"].as_js_string().unwrap()).0,
                ],
            );
        }
        "edit" => {
            let name = name.unwrap();
            require(&inventory, name)?;
            summary = render("Replace the fetch and push URLs for remote {}.", &[name]);
            if remote["fetchUrlRedacted"] == true || remote["pushUrlRedacted"] == true {
                warnings.push("The existing URL contains hidden credentials. Saving replaces the complete URL, including those credentials.");
            }
        }
        "remove" => {
            let name = name.unwrap();
            require(&inventory, name)?;
            summary = render("Remove remote {} and its remote-tracking refs.", &[name]);
            warnings.push(
                "Local branches and commits remain, but upstream configuration may become invalid.",
            );
        }
        "setDefaults" => {
            let fetch = action["fetchRemote"].as_js_string();
            let push = action["pushRemote"].as_js_string();
            if let Some(fetch) = fetch {
                require(&inventory, fetch)?;
            }
            if let Some(push) = push {
                require(&inventory, push)?;
            }
            let automatic = JsString::from("Git's automatic choice");
            summary = render(
                "Use {} for fetch and {} for push by default.",
                &[fetch.unwrap_or(&automatic), push.unwrap_or(&automatic)],
            );
        }
        _ => {
            let name = action["remote"].as_js_string().unwrap();
            require(&inventory, name)?;
            let prefix = JsString::from(if action["prune"] == true {
                "Fetch and prune"
            } else {
                "Fetch"
            });
            summary = render("{} remote {}.", &[&prefix, name]);
            if action["prune"] == true {
                warnings.push("Prune removes remote-tracking refs deleted from the remote.");
            }
        }
    }
    let (workspace, configuration) = tokio::join!(
        review::workspace(cwd, scope),
        process::raw(
            cwd,
            &[
                "config",
                "--null",
                "--get-regexp",
                r"^(remote\..*\.(url|pushurl)|remote\.pushDefault|cantrip\.defaultFetchRemote)$"
            ],
            scope
        )
    );
    let workspace = workspace?;
    let configuration = configuration.unwrap_or_default();
    scope.check()?;
    let header = json!({
        "action": action,
        "remotes": inventory["remotes"].clone(),
        "workspace": workspace,
        "configuration": review::digest(&[configuration.as_bytes()])
    })
    .stringify();
    checked(
        "gitRemoteActionPreviewSchema",
        &json!({"action":action,"token":review::digest(&[header.as_bytes()]),"destructive":kind=="remove"||(kind=="fetch"&&action["prune"]==true),"summary":summary,"warnings":warnings,"remote":remote}),
    )
}
async fn fetch(cwd: &Path, args: &[&str], scope: &Scope) -> Result<String> {
    let output = process::bounded(cwd, args, scope, Duration::from_secs(30)).await?;
    let stdout = String::from_utf8_lossy(&output.bytes);
    let stderr = String::from_utf8_lossy(&output.stderr);
    if output.code == Some(0) && !output.overflow && !output.timed_out {
        return Ok(process::trim(&format!("{stdout}{stderr}")));
    }
    let stderr = process::trim(&stderr);
    let stdout = process::trim(&stdout);
    let message = if !stderr.is_empty() {
        stderr
    } else if !stdout.is_empty() {
        stdout
    } else {
        output.error
    };
    Err(GitError(remote_text::sanitize(&message.into()).0).into())
}
pub async fn apply(cwd: &Path, action: &Value, token: &JsString, scope: &Scope) -> Result<Value> {
    let preview = preview(cwd, action, scope).await?;
    if preview["token"].as_js_string() != Some(token) {
        bail!("The remotes or worktree changed after this preview. Review the action again.");
    }
    let kind = action["type"].as_str().unwrap();
    let name = action["name"].as_js_string().map(JsString::lossy);
    let mut outputs = Vec::<String>::new();
    match kind {
        "add" | "edit" => {
            let name = name.as_deref().unwrap();
            let url = action["fetchUrl"].as_js_string().unwrap().lossy();
            let push = action["pushUrl"].as_js_string().map(JsString::lossy);
            let args = if kind == "add" {
                vec!["remote", "add", name, &url]
            } else {
                vec!["remote", "set-url", name, &url]
            };
            outputs.push(process::run(cwd, &args, scope).await?);
            if kind == "edit"
                || (!action["pushUrl"].is_null() && action["pushUrl"] != action["fetchUrl"])
            {
                outputs.push(
                    process::run(
                        cwd,
                        &[
                            "remote",
                            "set-url",
                            "--push",
                            name,
                            push.as_deref().unwrap_or(&url),
                        ],
                        scope,
                    )
                    .await?,
                );
            }
        }
        "remove" => {
            outputs.push(
                process::run(cwd, &["remote", "remove", name.as_deref().unwrap()], scope).await?,
            );
        }
        "setDefaults" => {
            for (field, key) in [
                ("fetchRemote", "cantrip.defaultFetchRemote"),
                ("pushRemote", "remote.pushDefault"),
            ] {
                if let Some(value) = action[field].as_js_string() {
                    outputs.push(process::run(cwd, &["config", key, &value.lossy()], scope).await?);
                } else {
                    managed::outcome(cwd, &["config", "--unset", key], &[], scope).await?;
                }
            }
        }
        _ => {
            let name = action["remote"].as_js_string().unwrap().lossy();
            let mut args = vec!["fetch", &name];
            if action["prune"] == true {
                args.push("--prune");
            }
            outputs.push(fetch(cwd, &args, scope).await?);
        }
    }
    checked(
        "gitRemoteMutationResultSchema",
        &json!({"output":outputs.into_iter().filter(|s|!s.is_empty()).collect::<Vec<_>>().join("\n"),"status":status::status(cwd,scope).await?,"remotes":list(cwd,scope).await?}),
    )
}
