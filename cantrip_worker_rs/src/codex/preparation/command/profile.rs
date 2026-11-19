use super::native::{Configuration, LoadedThread};
use crate::{
    codex::{guest_environment::Environment, managed::Runtime},
    history::live::observation::{Observer, Runtime as _},
};
use anyhow::{Context, Result, bail};
use cantrip_wire::{JsString, Value, value::json};
use std::{io::ErrorKind, path::Path, sync::Arc, time::Duration};

const WAIT: Duration = Duration::from_secs(120);

pub(super) fn external_servers(servers: Vec<Value>) -> Value {
    let mut mcp = json!({});
    for server in servers {
        let name = server["name"].as_str().unwrap();
        if matches!(
            name.trim().to_ascii_lowercase().as_str(),
            "cantrip" | "cantrip_cua" | "codegraph"
        ) {
            continue;
        }
        mcp[name] = if server["transport"] == "stdio" {
            json!({
                "command": server["command"], "args": server["args"],
                "env": server["environment"], "enabled": true,
            })
        } else {
            let mut http = json!({
                "url": server["url"], "http_headers": server["headers"],
                "env_http_headers": server["environmentHeaders"], "enabled": true,
            });
            if !server["bearerTokenEnvironmentVariable"].is_null() {
                http["bearer_token_env_var"] = server["bearerTokenEnvironmentVariable"].clone();
            }
            http
        };
    }
    mcp
}

pub(super) async fn configuration(
    command: &Value,
    cwd: &JsString,
    mcp: Value,
    generation: JsString,
    provider: &str,
    standalone: bool,
    permission_profiles: bool,
    environment: Option<&Environment>,
) -> Result<Configuration> {
    let path = cwd.as_str().context("Invalid Unicode workspace path")?;
    let (workspace, instructions) = if let Some(environment) = environment {
        (path.to_owned(), environment.instructions.clone())
    } else {
        let workspace = std::path::absolute(Path::new(path))?;
        let instructions = developer_instructions(standalone, &workspace).await;
        let workspace = workspace
            .to_str()
            .context("Invalid Unicode workspace path")?
            .to_owned();
        (workspace, instructions)
    };
    let cwd = workspace.as_str();
    let defaults = if standalone {
        &Value::Null
    } else {
        &command["subagentDefaults"]["model"]
    };
    let permission = &command["permissionProfileId"];
    let structured = command["structuredTask"] == true;
    let yolo = permission_profiles && permission == ":yolo";
    let mut start = json!({
        "cwd": cwd,
        "runtimeWorkspaceRoots": vec![cwd],
        "model": command["model"]["name"],
        "modelProvider": provider,
        "developerInstructions": instructions,
        "dynamicTools": Vec::<Value>::new(),
        "approvalPolicy": if yolo || structured { "never" } else { "on-request" },
        "config": json!({
            "features": json!({"multi_agent": !standalone}),
            "agents": json!({"enabled": !standalone}),
            "mcp_servers": mcp,
        }),
    });
    if let Some(environment) = environment {
        start["environments"] = json!(vec![environment.selection.clone()]);
    }
    if structured {
        start["sandbox"] = json!("read-only");
    } else if permission_profiles {
        start["permissions"] = if yolo {
            json!(":danger-full-access")
        } else {
            permission.clone()
        };
    } else {
        start["sandbox"] = json!("workspace-write");
    }
    if !command["model"]["reasoningEffort"].is_null() {
        start["effort"] = command["model"]["reasoningEffort"].clone();
    }
    if !defaults.is_null() {
        start["config"]["agents"]["default_subagent_model"] = defaults["name"].clone();
        if !defaults["reasoningEffort"].is_null() {
            start["config"]["agents"]["default_subagent_reasoning_effort"] =
                defaults["reasoningEffort"].clone();
        }
    }

    Ok(Configuration {
        start,
        // Existing threads retain native ownership of model/security and
        // recovering a partial preparation refreshes the same managed overlay.
        configure_existing: json!({}),
        managed_overlay: Some(json!({
            "mcpServers": mcp,
            "developerInstructions": instructions,
            "multiAgentEnabled": !standalone,
            "subagentModel": defaults["name"],
            "subagentReasoningEffort": defaults["reasoningEffort"],
            "canonicalHistory": !standalone,
            "executionGate": if command["taskOwned"] == true {
                json!({"runnerGeneration": generation, "inferenceOnly": true})
            } else {
                json!({"runnerGeneration": generation})
            },
        })),
        expected_suspension: None,
    })
}

pub(super) async fn apply_plan_mode(
    runtime: &Runtime,
    thread: &LoadedThread,
    command: &Value,
) -> Result<()> {
    let mode = &command["planMode"];
    let status = call(
        runtime,
        "thread/settings/read",
        json!({"threadId": thread.id()}),
    )
    .await?;
    thread.assert_current(runtime)?;
    if status["threadId"].as_js_string() != Some(thread.id()) {
        bail!("Native settings read returned another thread.");
    }
    if status["threadSettings"]["collaborationMode"]["mode"] == *mode {
        return Ok(());
    }
    let collaboration = collaboration_mode(runtime, mode, &command["model"]).await?;
    let expected = collaboration["settings"].clone();
    apply_settings(
        runtime,
        thread,
        json!({"collaborationMode":collaboration}),
        |settings| {
            let actual = &settings["collaborationMode"];
            if actual["mode"] != *mode
                || actual["settings"]["model"] != expected["model"]
                || actual["settings"]["reasoning_effort"] != expected["reasoning_effort"]
            {
                bail!("Native preparation applied different collaboration settings.");
            }
            Ok(())
        },
    )
    .await
}

pub(in crate::codex) async fn collaboration_mode(
    runtime: &Runtime,
    mode: &Value,
    model: &Value,
) -> Result<Value> {
    let presets = call(runtime, "collaborationMode/list", json!({})).await?;
    let preset = presets["data"]
        .as_array()
        .and_then(|list| list.iter().find(|preset| preset["mode"] == *mode))
        .context("Codex does not advertise the requested collaboration mode.")?;
    let name = preset
        .get("model")
        .filter(|v| !v.is_null())
        .unwrap_or(&model["name"]);
    let effort = preset
        .get("reasoning_effort")
        .filter(|v| !v.is_null())
        .cloned()
        .unwrap_or_else(|| {
            if mode == "plan" {
                json!("medium")
            } else {
                model["reasoningEffort"].clone()
            }
        });
    Ok(json!({
        "mode": mode,
        "settings": json!({"model": name, "reasoning_effort": effort, "developer_instructions": Value::Null}),
    }))
}

pub(super) async fn apply_goal_permissions(
    runtime: &Runtime,
    thread: &LoadedThread,
    command: &Value,
    named: bool,
) -> Result<()> {
    let target = &command["permissionProfileId"];
    let yolo = named && target == ":yolo";
    let approval = if yolo { "never" } else { "on-request" };
    let permissions = if yolo {
        json!(":danger-full-access")
    } else {
        target.clone()
    };
    if named {
        let observed = call(
            runtime,
            "thread/settings/read",
            json!({"threadId":thread.id()}),
        )
        .await?;
        thread.assert_current(runtime)?;
        if observed["threadId"].as_js_string() != Some(thread.id()) {
            bail!("Native Goal settings read returned another thread.");
        }
        let actual = &observed["threadSettings"];
        if actual["approvalPolicy"] == approval
            && actual["activePermissionProfile"]["id"] == permissions
        {
            return Ok(());
        }
    }
    let mut settings = json!({"approvalPolicy":approval});
    if named {
        settings["permissions"] = permissions.clone();
    } else {
        let cwd = Path::new(
            command["cwd"]
                .as_str()
                .context("Invalid native workspace")?,
        );
        let cwd = std::path::absolute(cwd)?;
        let cwd = cwd.to_str().context("Invalid native workspace path")?;
        settings["sandboxPolicy"] = if target == ":read-only" {
            json!({"type":"readOnly","networkAccess":false})
        } else {
            json!({"type":"workspaceWrite","networkAccess":false,"writableRoots":vec![cwd],
                   "excludeTmpdirEnvVar":false,"excludeSlashTmp":false})
        };
    }
    apply_settings(runtime, thread, settings, |actual| {
        if actual["approvalPolicy"] != approval
            || (named && actual["activePermissionProfile"]["id"] != permissions)
        {
            bail!("Native Goal did not apply the selected implementation permissions.");
        }
        Ok(())
    })
    .await
}

async fn apply_settings(
    runtime: &Runtime,
    thread: &LoadedThread,
    mut updates: Value,
    verify: impl FnOnce(&Value) -> Result<()>,
) -> Result<()> {
    let operation = uuid::Uuid::new_v4().to_string();
    let (events, mut received) = tokio::sync::mpsc::unbounded_channel();
    let observer = runtime.history().observe(
        thread.id().clone(),
        Observer {
            capture: Arc::new({
                let operation = operation.clone();
                move |frame| {
                    if frame["method"] == "thread/closed"
                        || (frame["method"] == "thread/settings/updated"
                            && frame["params"]["operationId"] == operation)
                        || (frame["method"] == "error" && frame["params"]["willRetry"] == false)
                    {
                        let _ = events.send(frame);
                    }
                    Ok(None)
                }
            }),
            on_error: Arc::new(|_, _| Ok(())),
        },
    )?;
    let signal = observer.signal();
    let applied = async {
        thread.assert_current(runtime)?;
        updates["threadId"] = json!(thread.id());
        updates["operationId"] = json!(operation);
        let ack = call(runtime, "thread/settings/update", updates).await?;
        thread.assert_current(runtime)?;
        if ack["operationId"] != operation {
            bail!("Codex acknowledged a different preparation settings operation.");
        }
        let submission = ack["submissionId"]
            .as_js_string()
            .context("Missing settings submission identity")?;
        loop {
            let frame = received
                .recv()
                .await
                .context("The settings observation closed.")?;
            thread.assert_current(runtime)?;
            if frame["method"] == "thread/closed" {
                bail!("Native preparation thread closed before settings applied.");
            }
            if frame["method"] == "error" {
                let params = &frame["params"];
                let rejected =
                    &params["error"]["codexErrorInfo"]["threadSettingsUpdateFailed"]["operationId"];
                if params["turnId"].as_js_string() == Some(submission)
                    && (rejected.is_null() || rejected == &json!(operation))
                {
                    bail!("Native preparation settings were rejected.");
                }
                continue;
            }
            if frame["params"]["submissionId"].as_js_string() != Some(submission) {
                continue;
            }
            return verify(&frame["params"]["threadSettings"]);
        }
    };
    let result = tokio::select! {
        error = signal.cancelled() => Err(error.into()),
        result = tokio::time::timeout(WAIT, applied) => {
            result.context("Native preparation settings application was not confirmed.").and_then(|result| result)
        }
    };
    observer.close();
    result
}

async fn call(runtime: &Runtime, method: &str, params: Value) -> Result<Value> {
    runtime
        .request(method.into(), Some(params), Some(WAIT), None)
        .await?
        .with_context(|| format!("Codex did not return a {method} result."))
}

async fn developer_instructions(standalone: bool, workspace: &Path) -> String {
    let base = if standalone { STANDALONE } else { PROJECT };
    let mut instructions = format!("Computer use is not enabled.\n\n{base}");
    if !standalone && !has_git_metadata(workspace).await {
        instructions.push_str("\n\n");
        instructions.push_str(NON_GIT);
    }
    instructions
}

async fn has_git_metadata(workspace: &Path) -> bool {
    for directory in workspace.ancestors() {
        match tokio::fs::symlink_metadata(directory.join(".git")).await {
            Err(error)
                if matches!(error.kind(), ErrorKind::NotFound | ErrorKind::NotADirectory) => {}
            _ => return true,
        }
    }
    false
}

// Keep the host thread instruction strings in sync with the Node reference.
const PROJECT: &str = r#"The managed `cantrip` MCP server is the preferred interface for Cantrip-owned state and surfaces. Start with `context_get`; use its exact context-window occupancy to judge whether imminent high-volume work fits. Call `context_compact` when the user requests `/compact` or the remaining context is inadequate, then finish the current turn so native compaction can run at the idle boundary. List targets instead of guessing identifiers, and call `tool_help` for the live exact schema before guessing tool arguments. Use `policy_list` plus `policy_read` whenever an effective policy summary requires its current full body. Use `run_configuration_detect` for typed project discovery, then `run_configuration_create`, `run_configuration_get`, and revision-checked `run_configuration_update` to author shared definitions under `.cantrip/run-configurations`. Always use stable configuration IDs and exact worktree IDs, never display names. Run lifecycle intent is explicit through `run_configuration_start`, `run_configuration_restart`, `run_configuration_stop`, `run_configuration_status`, and `run_configuration_read_output`; omitting the worktree selects Primary. Use `run_configuration_secret_set` for write-only encrypted values. If the managed MCP server or a required tool is unavailable, use the worker-authenticated `cantrip` CLI as a fallback and run `cantrip -h` for concise help. When a Cantrip tool or command reports that continuation was scheduled, finish the current turn so Cantrip can checkpoint and continue safely."#;
const NON_GIT: &str = r#"The current project path has no local `.git` metadata in it or any parent directory, so treat this project as a non-Git folder. Do not run Git or GitHub commands, inspect branches, remotes, or worktrees, or attempt commits or pull requests. Work directly with its files. Do not initialize Git unless the user explicitly asks."#;
const STANDALONE: &str = r#"You are in a standalone Cantrip Chat with an isolated scratch folder. This is not an IDE project. The managed `cantrip` MCP exposes only `tool_help`, `web_search`, and `web_read`; use those tools for web research and do not request unavailable project tools through `tool_help`. Do not use or request Cantrip project, worktree, Task, Code, CodeGraph, console, relocation, trajectory, interactive browser, or subagent features. Treat the current scratch folder as the only normal workspace root."#;
