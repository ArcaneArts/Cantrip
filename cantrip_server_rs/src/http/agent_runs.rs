//! MCP Run operations retain the managed worker binding and native services.
use super::agent_operations::{OperationError, parse};
use crate::{
    auth::service::AuthService,
    projects::targets::TargetRepository,
    run_configurations::{Repository, definitions, lifecycle, output},
    wire::{Value, value::json},
};
use anyhow::{Context, Result};
use std::sync::Arc;

fn bound(context: &Value, worker: &Value) -> Result<()> {
    if context["workerId"] != *worker {
        return Err(OperationError::new(
            409,
            "stale-binding",
            "The Run configuration target is outside the managed MCP worker binding.",
        )
        .into());
    }
    Ok(())
}
pub(super) async fn target(
    service: &AuthService,
    owner: &str,
    project: &str,
    requested: &Value,
) -> Result<Value> {
    let repository = TargetRepository::new(service.repository.database.clone());
    let raw_id = requested.as_js_string().map(|_| requested.clone());
    let requested = requested.as_js_string().map(|id| id.lossy().into_owned());
    let tree = if let Some(requested) = requested {
        requested
    } else {
        let primary = repository
            .observation_source(owner, project, &|id| {
                service.workers.bridge.is_connected(id)
            })
            .await?
            .ok_or_else(|| {
                OperationError::new(
                    404,
                    "not-found",
                    "The project Primary source was not found.",
                )
            })?;
        primary["worktreeId"]
            .as_str()
            .context("Run Primary worktree")?
            .to_owned()
    };
    let raw_id = raw_id.unwrap_or_else(|| json!(tree));
    let target = repository
        .mcp_worktree_context(owner, project, &tree, &raw_id)
        .await?
        .filter(|value| value["worktree"]["lifecycleState"] == "ready")
        .ok_or_else(|| {
            OperationError::new(
                404,
                "not-found",
                "The Run configuration target worktree is not ready.",
            )
        })?;
    let worker = target["workerId"].as_str().context("Run target worker")?;
    if !service.workers.bridge.is_connected(worker) {
        return Err(OperationError::new(
            503,
            "unavailable",
            "The Run configuration target worker is offline.",
        )
        .into());
    }
    service.run_configuration_observations.subscribe(worker);
    Ok(target)
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
    let project = context["projectId"].as_str().context("MCP Run project")?;
    let action = operation
        .strip_prefix("run-configuration.")
        .context("MCP Run operation")?;
    let project_target = json!({"kind":"project","projectId":project});
    let repository = Repository::new(service.repository.database.clone());
    let mutation = crate::agent_alerts::is_mutation(operation);
    if mutation && context["permissionProfileId"] == ":read-only" {
        return Err(OperationError::new(
            409,
            "conflict",
            "Run mutations are unavailable in a read-only execution context.",
        )
        .into());
    }
    if matches!(action, "create" | "update" | "delete" | "secret-set") {
        let source = definitions::source(service, owner, project).await?;
        bound(context, &source["workerId"])?;
    }
    let result = match action {
        "list" | "get" | "detect" => {
            let schema = match action {
                "list" => "cantripMcpRunConfigurationListInputSchema",
                "get" => "cantripMcpRunConfigurationGetInputSchema",
                _ => "cantripMcpRunConfigurationDetectInputSchema",
            };
            let mut input = parse(schema, arguments)?;
            input["operationId"] = json!(uuid::Uuid::new_v4().to_string());
            input["projectId"] = json!(project);
            let (mut data, source) =
                definitions::read_with_source(service, owner, action, &input).await?;
            bound(context, &source["workerId"])?;
            let summary = match action {
                "list" => {
                    let runtimes = repository.list(owner, project, None, None, 256).await?;
                    let active: Vec<_> = runtimes
                        .iter()
                        .filter(|runtime| {
                            matches!(
                                runtime["state"].as_str(),
                                Some("starting" | "running" | "restarting" | "stopping")
                            )
                        })
                        .map(|runtime| &runtime["configurationId"])
                        .collect();
                    let entries = data["inventory"]["entries"]
                        .as_array()
                        .context("Run inventory entries")?;
                    let mut entries = entries.clone();
                    entries.sort_by_key(|entry| !active.contains(&&entry["id"]));
                    let count = entries.len();
                    data["inventory"]["entries"] = Value::Array(entries);
                    data["runtimes"] = Value::Array(runtimes);
                    format!(
                        "Found {count} project Run configuration{}.",
                        if count == 1 { "" } else { "s" }
                    )
                }
                "get" => {
                    let id = input["configurationId"]
                        .as_str()
                        .context("Run definition ID")?;
                    if data["result"]["found"] != true {
                        return Err(OperationError::new(
                            404,
                            "not-found",
                            format!("Run configuration {id} was not found."),
                        )
                        .into());
                    }
                    format!("Read Run configuration {id}.")
                }
                _ => {
                    let count = data["candidates"]
                        .as_array()
                        .context("Run detection candidates")?
                        .len();
                    format!(
                        "Detected {count} Run configuration candidate{}.",
                        if count == 1 { "" } else { "s" }
                    )
                }
            };
            json!({"summary":summary,"target":project_target,"worktreeId":source["worktreeId"],"data":data})
        }
        "create" | "update" | "delete" => {
            let schema = match action {
                "create" => "cantripMcpRunConfigurationCreateInputSchema",
                "update" => "cantripMcpRunConfigurationUpdateInputSchema",
                _ => "cantripMcpRunConfigurationDeleteInputSchema",
            };
            let mut input = parse(schema, arguments)?;
            input["projectId"] = json!(project);
            if action == "create" {
                input["expectedRevision"] = Value::Null;
            }
            let dispatch = if action == "delete" {
                "delete"
            } else {
                "write"
            };
            let (data, source) = definitions::mutate_with_source(
                service.clone(),
                owner.to_owned(),
                dispatch,
                input.clone(),
            )
            .await?;
            bound(context, &source["workerId"])?;
            let outcome = data["result"]["outcome"]
                .as_str()
                .context("Run definition outcome")?;
            if action == "delete" {
                if outcome != "deleted" {
                    return Err(OperationError::new(
                        if outcome == "not-found" { 404 } else { 409 },
                        if outcome == "not-found" {
                            "not-found"
                        } else {
                            "conflict"
                        },
                        format!("Run configuration delete was rejected: {outcome}."),
                    )
                    .into());
                }
            } else if data["result"].get("entry").is_none() {
                return Err(OperationError::new(
                    409,
                    "conflict",
                    format!("Run configuration write was rejected: {outcome}."),
                )
                .into());
            }
            let summary = if action == "delete" {
                format!(
                    "Deleted Run configuration {}.",
                    input["configurationId"]
                        .as_str()
                        .context("Run deletion ID")?
                )
            } else {
                format!(
                    "{} Run configuration {}.",
                    if outcome == "created" {
                        "Created"
                    } else {
                        "Updated"
                    },
                    data["result"]["entry"]["id"]
                        .as_str()
                        .context("Run entry ID")?
                )
            };
            json!({"summary":summary,"target":project_target,"worktreeId":source["worktreeId"],"mutated":if action=="delete"{true}else{outcome!="unchanged"},"data":data})
        }
        "start" | "restart" | "stop" => {
            let schema = match action {
                "start" => "cantripMcpRunConfigurationStartInputSchema",
                "restart" => "cantripMcpRunConfigurationRestartInputSchema",
                _ => "cantripMcpRunConfigurationStopInputSchema",
            };
            let input = parse(schema, arguments)?;
            let target = target(service, owner, project, &input["worktreeId"]).await?;
            bound(context, &target["workerId"])?;
            let request = json!({"operationId":input["operationId"],"projectId":project,"configurationId":input["configurationId"],"targetWorktreeId":target["worktree"]["id"],"operation":action});
            let data = lifecycle::operate(service.clone(), owner.to_owned(), request).await?;
            let outcome = data["operation"]["outcome"]
                .as_str()
                .context("Run operation outcome")?;
            json!({"summary":format!("{action} {outcome} for Run configuration {}.",input["configurationId"].as_str().context("Run configuration ID")?),"target":json!({"kind":"worktree","projectId":project,"worktreeId":data["operation"]["worktreeId"]}),"worktreeId":data["operation"]["worktreeId"],"mutated":outcome=="accepted","data":data})
        }
        "status" => {
            let input = parse("cantripMcpRunConfigurationStatusInputSchema", arguments)?;
            if !input["worktreeId"].is_null() {
                let target = target(service, owner, project, &input["worktreeId"]).await?;
                bound(context, &target["workerId"])?;
            }
            let query = parse(
                "runConfigurationRuntimeStatusQuerySchema",
                &json!({"operationId":uuid::Uuid::new_v4().to_string(),"projectId":project,"configurationId":input["configurationId"],"targetWorktreeId":input["worktreeId"],"limit":input["limit"]}),
            )?;
            let worktree = query["targetWorktreeId"]
                .as_js_string()
                .map(|id| id.lossy());
            let runtimes = repository
                .list(
                    owner,
                    project,
                    query["configurationId"].as_str(),
                    worktree.as_deref(),
                    query["limit"].as_i64().context("Run status limit")?,
                )
                .await?;
            let count = runtimes.len();
            let data = parse(
                "runConfigurationRuntimeStatusResultSchema",
                &json!({"operationId":query["operationId"],"projectId":project,"runtimes":runtimes}),
            )?;
            json!({"summary":format!("Found {count} Run configuration runtime{}.",if count==1{""}else{"s"}),"target":project_target,"worktreeId":input["worktreeId"],"data":data})
        }
        "read-output" => {
            let input = parse("cantripMcpRunConfigurationReadOutputInputSchema", arguments)?;
            let target = target(service, owner, project, &input["worktreeId"]).await?;
            bound(context, &target["workerId"])?;
            let query = parse(
                "runConfigurationRuntimeOutputQuerySchema",
                &json!({"operationId":input["operationId"],"projectId":project,"configurationId":input["configurationId"],"worktreeId":target["worktree"]["id"],"tail":input["tail"]}),
            )?;
            let runtime = repository
                .get(
                    owner,
                    project,
                    query["configurationId"]
                        .as_str()
                        .context("Run output configuration")?,
                    query["worktreeId"]
                        .as_str()
                        .context("Run output worktree")?,
                )
                .await?;
            let data = output::read(service, runtime.as_ref(), &query, None).await?;
            json!({"summary":format!("Read Run configuration {} output.",data["configurationId"].as_str().context("Run output configuration")?),"target":json!({"kind":"worktree","projectId":project,"worktreeId":target["worktree"]["id"]}),"worktreeId":target["worktree"]["id"],"data":data})
        }
        "secret-set" => {
            let mut request = Value::Object(Default::default());
            for key in ["operationId", "reference", "protectedValue"] {
                if let Some(value) = arguments.get(key) {
                    request[key] = value.clone();
                }
            }
            let input = parse("runConfigurationSecretSetRequestSchema", &request)?;
            let data = repository.set_secret(owner, project, &input).await?;
            definitions::invalidate(&service.live, owner, project, Value::Null);
            json!({"summary":format!("Stored Run configuration secret {}.",data["secret"]["reference"].as_str().context("Run secret reference")?),"target":project_target,"worktreeId":Value::Null,"mutated":data["replayed"]==false,"data":data})
        }
        _ => unreachable!("registered Run MCP operation"),
    };
    parse("cantripAgentOperationResultSchema", &result)
}
