use super::{RPC_TIMEOUT, Runtime, protected_mode};
use anyhow::{Context, Result, bail};
use cantrip_wire::{JsString, Value, value::json};
use std::path::Path;

pub(super) fn validate(command: &Value) -> Result<()> {
    let task = super::task::is_round(command) || super::task::is_goal(command);
    let queued = super::queued::is_queued(command);
    let supported_content = if task {
        command["contextKind"] == "project" && command["taskDispatchLease"].is_object()
    } else if protected_mode(command) {
        command["protectedPrompt"].is_object()
    } else {
        command["resultMode"]["kind"] == "visible" && command["prompt"].is_string()
    };
    if !supported_content
        || (queued
            && (task || !protected_mode(command) || !command["nativeCommandReceipt"].is_object()))
        || (!queued && !command["protectedNativeInput"].is_null())
        || command["executionProfile"] == "cantrip-os"
        || (!task
            && (!command["taskDispatchLease"].is_null()
                || !command["taskInferenceInput"].is_null()))
        || [
            "computerUseAuthority",
            "taskResumption",
            "initialLabel",
            "subagentDefaults",
        ]
        .iter()
        .any(|field| command.get(field).is_some_and(|value| !value.is_null()))
        || (!queued
            && command["attachments"]
                .as_array()
                .is_some_and(|items| !items.is_empty()))
        || ["skillNames", "chatSkillAudienceKeys"].iter().any(|field| {
            command[*field]
                .as_array()
                .is_some_and(|value| !value.is_empty())
        })
        || ["policies", "standalonePolicies"].iter().any(|field| {
            command[*field]["policies"]
                .as_array()
                .is_some_and(|value| !value.is_empty())
        })
    {
        bail!("This turn requires native features outside the host text execution path.");
    }
    Ok(())
}

pub(super) fn preparation(command: &Value) -> Value {
    json!({
        "cwd": command["cwd"],
        "threadId": command["threadId"],
        "planMode": command["planMode"],
        "taskOwned": super::task::is_round(command) || super::task::is_goal(command),
        "taskGoalFirstInput": if super::task::is_goal(command) { command["clientMessageId"].clone() } else { Value::Null },
        "structuredTask": super::task::is_structured(command),
        "model": command["model"],
        "provider": command["provider"],
        "mcpServers": command["mcpServers"],
        "permissionProfileId": command["permissionProfileId"],
        "session": json!({
            "chatId": command["chatId"], "contextKind": command["contextKind"],
            "projectId": command["policyProjectId"], "worktreeId": command["worktreeId"],
            "scratchRootId": command["scratchRootId"], "rootKind": command["rootKind"],
            "computerUseEnabled": false,
        }),
    })
}

pub(super) async fn native_input(
    command: &Value,
    input: Vec<Value>,
    runtime: &Runtime,
    thread: &JsString,
    permission_profiles: bool,
) -> Result<Value> {
    let cwd = command["cwd"]
        .as_str()
        .context("Invalid native workspace path")?;
    let workspace = cantrip_config::resolve(&std::env::current_dir()?, Path::new(cwd));
    let cwd = workspace
        .to_str()
        .context("Invalid native workspace path")?;
    let standalone = command["contextKind"] == "standalone";
    let structured = super::task::is_structured(command);
    let primary_read_only = command["rootKind"] == "git-worktree"
        && command["isPrimary"] == true
        && command["worktreePolicy"] == "required-for-writes";
    let (context_key, instructions) = if standalone {
        ("cantrip.standalone-chat", "This is an isolated standalone Chat scratch workspace, not a Cantrip project. Work only with this conversation, the current scratch folder, and the managed Cantrip web tools (`tool_help`, `web_search`, and `web_read`). Project, worktree, Task, Code, CodeGraph, interactive browser, and subagent workflows are unavailable.".into())
    } else if structured {
        ("cantrip.worktree-policy", planning_policy(command).into())
    } else {
        (
            "cantrip.worktree-policy",
            worktree_policy(command, primary_read_only),
        )
    };

    let settings = runtime
        .request(
            "thread/settings/read".into(),
            Some(json!({"threadId": thread})),
            Some(RPC_TIMEOUT),
            None,
        )
        .await?
        .context("Native turn settings are unavailable.")?;
    if settings["threadId"].as_js_string() != Some(thread) {
        bail!("Native settings read returned another thread.");
    }
    let settings = &settings["threadSettings"];
    let permission = command["permissionProfileId"]
        .as_str()
        .context("Missing native permission profile")?;
    if permission_profiles && !structured {
        let expected = if permission == ":yolo" {
            ":danger-full-access"
        } else {
            permission
        };
        if settings["activePermissionProfile"]["id"] != expected {
            bail!("The native thread's permission profile changed before dispatch.");
        }
    }
    if settings["collaborationMode"]["mode"] != command["planMode"] {
        bail!("The native thread's collaboration mode changed before dispatch.");
    }
    let client_message = command["nativeClientUserMessageId"]
        .as_js_string()
        .cloned()
        .unwrap_or_else(|| {
            crate::native_items::concat(&[
                "cantrip:".into(),
                command["clientMessageId"].as_js_string().unwrap().clone(),
            ])
        });
    let mut context = json!({});
    context[context_key] = json!({"kind": "application", "value": instructions});
    let mut params = json!({
        "threadId": thread,
        "cwd": cwd,
        "runtimeWorkspaceRoots": vec![cwd],
        "clientUserMessageId": client_message,
        "input": input,
        "model": command["model"]["name"],
        "collaborationMode": settings["collaborationMode"],
        "additionalContext": context,
    });
    if !command["model"]["reasoningEffort"].is_null() {
        params["effort"] = command["model"]["reasoningEffort"].clone();
    }
    if structured {
        params["approvalPolicy"] = json!("never");
    }
    if structured || !permission_profiles {
        params["sandboxPolicy"] = if structured || primary_read_only {
            json!({"type": "readOnly", "networkAccess": false})
        } else {
            json!({
                "type": "workspaceWrite", "writableRoots": vec![cwd], "networkAccess": false,
                "excludeTmpdirEnvVar": false, "excludeSlashTmp": false,
            })
        };
    }
    Ok(params)
}

fn planning_policy(command: &Value) -> &'static str {
    if command["rootKind"] == "folder-root" {
        "This is a Cantrip Task planning turn in a worker-managed folder. It is unconditionally read-only: inspect the folder and effective policies, but do not modify files or external systems. The folder has no Git protection, writes in implementation turns occur directly in it, Cantrip worktree commands are unavailable, and running git init does not convert the project automatically."
    } else {
        "This is a Cantrip Task planning turn. It is unconditionally read-only: inspect the repository and effective policies, but do not modify files, Git state, GitHub state, or external systems."
    }
}

fn worktree_policy(command: &Value, primary_read_only: bool) -> String {
    if command["rootKind"] == "folder-root" {
        return "This project is a worker-managed folder without Git protection. Writes occur directly in this folder. Cantrip worktree commands are unavailable. Running git init does not convert the project automatically; conversion requires the explicit Cantrip GitHub flow.".into();
    }
    let placement = match command["worktreePolicy"].as_str() {
        Some("required-for-writes") if primary_read_only => {
            "The project policy is Required for writes and this turn is on Primary. Primary is inspection-only: do not mutate files or Git state here. Before writing, call `worktree_create` and then `worktree_switch` with its returned target, or call `worktree_switch` for an existing target. Use `cantrip worktree create --switch` or `cantrip worktree switch` only if managed MCP is unavailable, then finish this turn if the operation schedules continuation."
        }
        Some("required-for-writes") => {
            "The project policy is Required for writes and this turn is in a secondary worktree, so writes are permitted here."
        }
        Some("direct") => {
            "The project policy is Direct. Writes are permitted in the current checkout, including Primary."
        }
        _ => {
            "The project policy is Agent managed. You may work in the current checkout or acquire a secondary worktree when the task benefits from isolation."
        }
    };
    let mode = if command["worktreeMode"] == "pinned" {
        "This chat is pinned to the current worktree. Do not acquire or switch worktrees unless the user first returns the chat to Agent managed mode."
    } else {
        "This chat is Agent managed and may use the managed Cantrip MCP `worktree_create` and `worktree_switch` tools when isolation is appropriate; use `cantrip worktree` only as a fallback."
    };
    format!("{placement} {mode}")
}
