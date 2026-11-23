//! MCP worktree operations use the existing project coordinator and lane ledger.
//! Worker commands own Git/files; the server retains ownership and continuation.
use super::agent_operations::{OperationError, parse};
use crate::{
    auth::service::AuthService,
    chats::execution_lanes::{LaneError, LaneRepository},
    projects::{repository::ProjectRepository, targets::TargetRepository},
    wire::{JsString, Value, coercion::truthy, value::json},
};
use anyhow::{Context, Result, bail};
use futures::FutureExt;
use std::{collections::HashSet, sync::Arc};

fn required(arguments: &Value, key: &str) -> Result<Value> {
    arguments[key]
        .as_js_string()
        .map(JsString::trim)
        .filter(|value| !value.is_empty())
        .map(Value::String)
        .with_context(|| format!("{key} is required."))
}
fn optional(arguments: &Value, key: &str) -> Result<Value> {
    match arguments.get(key) {
        None | Some(Value::Null) => Ok(Value::Null),
        Some(Value::String(value)) => {
            let value = value.trim();
            Ok(if value.is_empty() {
                Value::Null
            } else {
                Value::String(value)
            })
        }
        _ => bail!("{key} must be a string."),
    }
}
fn integer(arguments: &Value, key: &str, default: usize, min: usize, max: usize) -> Result<usize> {
    let value = arguments
        .get(key)
        .filter(|v| !v.is_null())
        .map_or(Some(default as f64), Value::as_f64);
    match value {
        Some(value) if value.fract() == 0.0 && value >= min as f64 && value <= max as f64 => {
            Ok(value as usize)
        }
        _ => bail!("{key} must be an integer from {min} to {max}."),
    }
}
fn target(
    arguments: &Value,
    context: &Value,
    project: &str,
    fallback: Option<Value>,
) -> Result<Value> {
    let target = if truthy(arguments.get("target")) {
        crate::wire::parse("executionTargetSchema", arguments.get("target"))
            .map_err(|_| anyhow::anyhow!("A valid execution target is required."))?
    } else {
        json!({"kind":"worktree","projectId":project,"worktreeId":fallback.unwrap_or_else(||context["worktreeId"].clone())})
    };
    Ok(target)
}
async fn worktree(
    repository: &TargetRepository,
    owner: &str,
    project: &str,
    id: &Value,
) -> Result<Value> {
    let encoded = id.as_js_string().context("MCP worktree identity")?.lossy();
    repository
        .mcp_worktree_context(owner, project, &encoded, id)
        .await?
        .ok_or_else(|| anyhow::anyhow!("Worktree not found."))
}
async fn create(
    service: &Arc<AuthService>,
    owner: &str,
    project: &str,
    arguments: &Value,
) -> Result<Value> {
    // Retain Source's validation order, including optional fields for every intent.
    let name = required(arguments, "name")?;
    let intent = required(arguments, "intent")?;
    let branch = optional(arguments, "branch")?;
    let revision = optional(arguments, "baseRevision")?;
    let mode = if intent == "newBranch" {
        json!({"type":"newBranch","branch":if branch.is_null(){required(arguments,"branch")?}else{branch},"startPoint":revision})
    } else if intent == "existingBranch" {
        json!({"type":"existingBranch","branch":if branch.is_null(){required(arguments,"branch")?}else{branch}})
    } else if intent == "detached" {
        json!({"type":"detached","revision":if revision.is_null(){required(arguments,"baseRevision")?}else{revision}})
    } else {
        bail!("intent must be newBranch, existingBranch, or detached.");
    };
    service
        .worktrees
        .create(
            owner.to_owned(),
            project.to_owned(),
            json!({"name":name,"mode":mode,"origin":"agent"}),
        )
        .await?
        .ok_or_else(|| anyhow::anyhow!("Project source not found."))
}
async fn schedule(
    service: &AuthService,
    owner: &str,
    context: &Value,
    id: &Value,
    kind: &str,
    purpose: Value,
) -> Result<Value> {
    if !truthy(context.get("chatId")) || !truthy(context.get("executionLaneId")) {
        return Err(OperationError::new(
            409,
            "stale-binding",
            "This operation must run inside an active Cantrip chat.",
        )
        .into());
    }
    LaneRepository::new(service.repository.database.clone())
        .schedule_mcp_transition(
            owner,
            context["chatId"].as_str().context("MCP chat")?,
            &context["executionLaneId"],
            id,
            kind,
            &purpose,
        )
        .await
        .map_err(|cause| {
            if let Some(error) = cause.downcast_ref::<LaneError>() {
                OperationError::new(409, "stale-binding", error.to_string()).into()
            } else {
                cause
            }
        })?
        .ok_or_else(|| anyhow::anyhow!("Target worktree is not ready."))
}
async fn status(service: &AuthService, target: &Value) -> Result<Value> {
    let reply=service.workers.commands.request(target["workerId"].as_str().context("MCP target worker")?,json!({"type":"worktree.status","sourcePath":target["sourcePath"],"worktreePath":target["worktree"]["path"]}),None,None).await?;
    crate::settings::parse_response("worktreeStatusResultSchema", reply.as_ref())
}
fn named_summary(prefix: &str, name: &Value, suffix: &str) -> Result<Value> {
    Ok(Value::String(JsString::new(
        prefix
            .encode_utf16()
            .chain(
                name.as_js_string()
                    .context("MCP worktree name")?
                    .units()
                    .iter()
                    .copied(),
            )
            .chain(suffix.encode_utf16())
            .collect(),
    )))
}
fn status_summary(target: &Value, status: &Value) -> Result<Value> {
    let mut units = target["worktree"]["name"]
        .as_js_string()
        .context("MCP worktree name")?
        .units()
        .to_vec();
    let dirty = !status["status"]["files"]
        .as_array()
        .context("Worktree files")?
        .is_empty();
    units.extend(format!(" is {} on ", if dirty { "dirty" } else { "clean" }).encode_utf16());
    if truthy(status["status"].get("branch")) {
        units.extend_from_slice(
            status["status"]["branch"]
                .as_js_string()
                .context("Worktree branch")?
                .units(),
        );
    } else {
        units.extend("detached HEAD".encode_utf16());
    }
    units.push(b'.' as u16);
    Ok(Value::String(JsString::new(units)))
}

pub(super) async fn execute(
    service: &Arc<AuthService>,
    owner: &str,
    context: &Value,
    operation: &str,
    arguments: &Value,
) -> Result<Value> {
    if context["contextKind"] != "project" {
        return Err(OperationError::new(
            409,
            "unsupported-capability",
            "Standalone Chats do not support IDE execution operations.",
        )
        .into());
    }
    let project = context["projectId"].as_str().context("MCP project")?;
    if ProjectRepository::new(service.repository.database.clone())?
        .get(owner, project)
        .await?
        .as_ref()
        .is_none_or(|p| p["capabilities"]["worktrees"] != true)
    {
        return Err(OperationError::new(
            409,
            "unsupported-capability",
            "This worker-managed folder does not support Cantrip worktree commands.",
        )
        .into());
    }
    let repository = TargetRepository::for_mcp(service.repository.database.clone());
    let result = match operation {
        "worktree.list" => {
            let history = arguments["includeLeaseHistory"] == true;
            let lanes = LaneRepository::new(service.repository.database.clone());
            let (items, leases) = tokio::try_join!(
                repository.worktrees(owner, project),
                lanes.list_project(owner, project, history)
            )?;
            let primary: HashSet<_> = items
                .iter()
                .filter(|w| w["isPrimary"] == true)
                .filter_map(|w| w["id"].as_js_string().cloned())
                .collect();
            let leases: Vec<_> = leases
                .into_iter()
                .filter(|l| {
                    history
                        || (l["state"] != "released"
                            && (l["state"] != "suspended"
                                || !l["worktreeId"]
                                    .as_js_string()
                                    .is_some_and(|id| primary.contains(id))))
                })
                .collect();
            if arguments.get("cursor").is_some() || arguments.get("limit").is_some() {
                let cursor = integer(arguments, "cursor", 0, 0, 1999)?;
                let limit = integer(arguments, "limit", 100, 1, 200)?;
                let total = items.len().min(2000);
                let selected: Vec<_> = items
                    .iter()
                    .take(2000)
                    .skip(cursor)
                    .take(limit)
                    .cloned()
                    .collect();
                let ids: HashSet<_> = selected
                    .iter()
                    .filter_map(|w| w["id"].as_js_string().cloned())
                    .collect();
                let selected_leases: Vec<_> = leases
                    .into_iter()
                    .filter(|l| {
                        l["worktreeId"]
                            .as_js_string()
                            .is_some_and(|id| ids.contains(id))
                    })
                    .collect();
                let next = (cursor + selected.len() < total).then_some(cursor + selected.len());
                json!({"summary":format!("Found {} validated worktree{}{}.",selected.len(),if selected.len()==1{""}else{"s"},if next.is_some(){"; more worktrees are available"}else{""}),"worktreeId":context["worktreeId"],"data":json!({"currentWorktreeId":context["worktreeId"],"worktrees":selected,"leases":selected_leases.iter().take(1000).cloned().collect::<Vec<_>>(),"cursor":cursor,"nextCursor":next,"total":total,"truncated":items.len()>total||selected_leases.len()>1000||next.is_some()})})
            } else {
                json!({"summary":format!("Found {} validated worktree{}.",items.len(),if items.len()==1{""}else{"s"}),"worktreeId":context["worktreeId"],"data":json!({"currentWorktreeId":context["worktreeId"],"worktrees":items,"leases":leases})})
            }
        }
        "worktree.status" => {
            let fallback = if truthy(arguments.get("target")) {
                None
            } else {
                let requested = optional(arguments, "worktreeId")?;
                Some(if requested.is_null() {
                    context["worktreeId"].clone()
                } else {
                    requested
                })
            };
            let target = target(arguments, context, project, fallback)?;
            if target["kind"] != "worktree" {
                bail!("Worktree status requires a worktree target.");
            }
            let resolution = repository
                .resolve(
                    owner,
                    project,
                    &target,
                    Some(&|w| service.workers.bridge.is_connected(w)),
                    false,
                )
                .await?;
            let id = &resolution["placement"]["worktreeId"];
            let current = worktree(&repository, owner, project, id).await?;
            let status = status(service, &current).await?;
            if status["worktree"]["path"] != current["worktree"]["path"] {
                bail!("Worker returned status for a different worktree.");
            }
            let summary = status_summary(&current, &status)?;
            let data = if arguments.get("fileLimit").is_some()
                || arguments.get("branchLimit").is_some()
            {
                let files = integer(arguments, "fileLimit", 500, 1, 2000)?;
                let branches = integer(arguments, "branchLimit", 200, 1, 500)?;
                let mut bounded = status["status"].clone();
                let all_files = status["status"]["files"]
                    .as_array()
                    .context("Worktree files")?;
                let all_branches = status["status"]["branches"]
                    .as_array()
                    .context("Worktree branches")?;
                bounded["files"] = json!(all_files.iter().take(files).cloned().collect::<Vec<_>>());
                bounded["branches"] = json!(
                    all_branches
                        .iter()
                        .take(branches)
                        .cloned()
                        .collect::<Vec<_>>()
                );
                json!({"worktree":status["worktree"],"status":bounded,"filesTruncated":all_files.len()>files,"branchesTruncated":all_branches.len()>branches})
            } else {
                status
            };
            json!({"summary":summary,"target":json!({"kind":"worktree","projectId":project,"worktreeId":id}),"worktreeId":id,"data":data})
        }
        // Acquire is a legacy CLI operation and remains absent from the MCP
        // authority allowlist, matching Source's shared operation runtime.
        "worktree.create" | "worktree.acquire" => {
            let acquire = operation == "worktree.acquire";
            if acquire && context["worktreeMode"] == "pinned" {
                bail!(
                    "This chat is pinned. Return it to Agent managed before acquiring another worktree."
                );
            }
            let created = create(service, owner, project, arguments).await?;
            if acquire {
                let pending = schedule(
                    service,
                    owner,
                    context,
                    &created["id"],
                    "switch",
                    required(arguments, "purpose")?,
                )
                .await?;
                json!({"summary":named_summary("Created ",&created["name"],"; continuation is scheduled in that worktree. Finish this turn now.")?,"worktreeId":created["id"],"continuationScheduled":true,"mutated":true,"data":json!({"worktree":created,"lane":pending["lane"]})})
            } else {
                let branch = created["branch"].as_js_string().map_or_else(
                    || "detached HEAD".encode_utf16().collect::<Vec<_>>(),
                    |v| v.units().to_vec(),
                );
                let name = created["name"].as_js_string().context("MCP created name")?;
                let units = "Created "
                    .encode_utf16()
                    .chain(name.units().iter().copied())
                    .chain(" on ".encode_utf16())
                    .chain(branch)
                    .chain(".".encode_utf16())
                    .collect();
                json!({"summary":Value::String(JsString::new(units)),"worktreeId":created["id"],"mutated":true,"data":created})
            }
        }
        "worktree.switch" => {
            let fallback = if truthy(arguments.get("target")) {
                None
            } else {
                Some(required(arguments, "worktreeId")?)
            };
            let target = target(arguments, context, project, fallback)?;
            if target["kind"] != "worktree" {
                bail!("Worktree switching requires a worktree target.");
            }
            let resolution = repository
                .resolve(
                    owner,
                    project,
                    &target,
                    Some(&|w| service.workers.bridge.is_connected(w)),
                    false,
                )
                .await?;
            let id = &resolution["placement"]["worktreeId"];
            let pending = schedule(
                service,
                owner,
                context,
                id,
                "switch",
                required(arguments, "purpose")?,
            )
            .await?;
            json!({"summary":named_summary("Continuation is scheduled in ",&pending["worktree"]["name"],". Finish this turn now.")?,"worktreeId":id,"continuationScheduled":true,"mutated":true,"data":json!({"lane":pending["lane"],"worktree":pending["worktree"]})})
        }
        "worktree.release" => {
            let current = worktree(&repository, owner, project, &context["worktreeId"]).await?;
            if current["worktree"]["isPrimary"] == true {
                bail!("Primary does not have a releasable secondary lease.");
            }
            let current_status = status(service, &current).await?;
            if !current_status["status"]["files"]
                .as_array()
                .context("Worktree files")?
                .is_empty()
            {
                bail!(
                    "The current worktree is dirty. Commit or restore its changes before releasing it."
                );
            }
            let primary = repository
                .worktrees(owner, project)
                .await?
                .into_iter()
                .find(|w| w["isPrimary"] == true)
                .context("Primary worktree not found.")?;
            let pending = schedule(
                service,
                owner,
                context,
                &primary["id"],
                "release",
                required(arguments, "purpose")?,
            )
            .await?;
            json!({"summary":named_summary("Release is scheduled; continuation will return to ",&primary["name"],". Finish this turn now.")?,"worktreeId":primary["id"],"continuationScheduled":true,"mutated":true,"data":json!({"lane":pending["lane"],"worktree":pending["worktree"]})})
        }
        "worktree.remove" => {
            let fallback = if truthy(arguments.get("target")) {
                None
            } else {
                Some(required(arguments, "worktreeId")?)
            };
            let target = target(arguments, context, project, fallback)?;
            if target["kind"] != "worktree" {
                bail!("Worktree removal requires a worktree target.");
            }
            let resolution = repository
                .resolve(
                    owner,
                    project,
                    &target,
                    Some(&|w| service.workers.bridge.is_connected(w)),
                    false,
                )
                .await?;
            let id = &resolution["placement"]["worktreeId"];
            let current = worktree(&repository, owner, project, id).await?;
            if current["worktree"]["isPrimary"] == true {
                bail!("Primary cannot be removed as a worktree.");
            }
            if current["worktree"]["origin"] != "agent" {
                bail!(
                    "Agents may remove only agent-created worktrees; user and external worktrees require explicit user authorization."
                );
            }
            if context["worktreeId"] == *id {
                bail!("Release or switch away from this worktree first.");
            }
            if let Some(blockers) = repository
                .worktree_removal_blockers(
                    owner,
                    project,
                    id.as_str().context("MCP remove identity")?,
                )
                .await?
                && [
                    "activeChatIds",
                    "activeLeaseChatIds",
                    "boundCodeTabIds",
                    "runningTerminalIds",
                ]
                .iter()
                .any(|key| blockers[*key].as_array().is_some_and(|v| !v.is_empty()))
            {
                bail!(
                    "The worktree is still used by a chat, Code tab, or terminal. Retarget or delete bound Code tabs before removal."
                );
            }
            let current_status = status(service, &current).await?;
            if !current_status["status"]["files"]
                .as_array()
                .context("Worktree files")?
                .is_empty()
            {
                bail!("Dirty worktrees cannot be removed by an agent.");
            }
            let owned = service.clone();
            let owned_owner = owner.to_owned();
            let owned_project = project.to_owned();
            let removed_id = id.clone();
            let worker = current["workerId"]
                .as_str()
                .context("MCP remove worker")?
                .to_owned();
            let command = json!({"type":"worktree.remove","sourcePath":current["sourcePath"],"worktreePath":current["worktree"]["path"],"force":false,"allowExternal":false});
            let removed = service
                .project_operations
                .serialize(owner, project, true, move || {
                    async move {
                        crate::run_configurations::retirement::retire(
                            &owned,
                            &owned_owner,
                            &owned_project,
                            None,
                            removed_id.as_str(),
                        )
                        .await?;
                        let response = owned
                            .workers
                            .commands
                            .request(&worker, command, None, None)
                            .await?;
                        let result = crate::settings::parse_response(
                            "worktreeRemoveResultSchema",
                            response.as_ref(),
                        )?;
                        TargetRepository::new(owned.repository.database.clone())
                            .reconcile_worktrees(
                                &owned_owner,
                                &owned_project,
                                &worker,
                                &result["inventory"],
                                None,
                            )
                            .await?;
                        Ok(result)
                    }
                    .boxed()
                })
                .await?;
            json!({"summary":named_summary("Removed ",&current["worktree"]["name"],"; its Git branch was retained.")?,"worktreeId":id,"mutated":true,"data":removed})
        }
        _ => bail!("Unsupported Cantrip agent operation: {operation}"),
    };
    parse("cantripAgentOperationResultSchema", &result)
}
