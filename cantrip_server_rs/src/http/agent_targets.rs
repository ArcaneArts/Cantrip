//! MCP discovery uses the same owned target catalog and placement as the API.
use super::agent_operations::{OperationError, parse};
use crate::{
    auth::service::AuthService,
    projects::targets::TargetRepository,
    wire::{self, Value, value::json},
};
use anyhow::{Context, Result};

fn integer(
    arguments: &Value,
    key: &str,
    default: usize,
    minimum: usize,
    maximum: usize,
) -> Result<usize> {
    let number = arguments
        .get(key)
        .filter(|value| !value.is_null())
        .map_or(Some(default as f64), Value::as_f64);
    match number {
        Some(value)
            if value.fract() == 0.0 && value >= minimum as f64 && value <= maximum as f64 =>
        {
            Ok(value as usize)
        }
        _ => Err(OperationError::new(
            400,
            "invalid",
            format!("{key} must be an integer from {minimum} to {maximum}."),
        )
        .into()),
    }
}

pub(super) async fn execute(
    service: &AuthService,
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
    let project = context["projectId"]
        .as_str()
        .context("MCP project identity")?;
    let repository = TargetRepository::for_mcp(service.repository.database.clone());
    let connected = |worker: &str| service.workers.bridge.is_connected(worker);
    if operation == "target.list" {
        // Source performs the catalog reads before validating filter/paging arguments.
        let mut catalog = repository
            .catalog(owner, project, Some(&connected))
            .await?
            .ok_or_else(|| OperationError::new(400, "invalid", "Project not found."))?;
        let kind = match arguments.get("kind").filter(|value| !value.is_null()) {
            None => None,
            Some(Value::String(value)) => {
                let value = value.trim();
                if value.is_empty() {
                    None
                } else {
                    Some(parse(
                        "executionTargetResourceKindSchema",
                        &Value::String(value),
                    )?)
                }
            }
            Some(_) => {
                return Err(OperationError::new(400, "invalid", "kind must be a string.").into());
            }
        };
        let targets = catalog["targets"]
            .as_array()
            .context("MCP target catalog")?;
        let matching: Vec<Value> = targets
            .iter()
            .filter(|target| {
                kind.as_ref()
                    .is_none_or(|kind| &target["resourceKind"] == kind)
            })
            .cloned()
            .collect();
        let (summary, data) = if arguments.get("cursor").is_none()
            && arguments.get("limit").is_none()
        {
            let count = matching.len();
            catalog["targets"] = Value::Array(matching);
            (
                format!(
                    "Found {count} authorized target{}.",
                    if count == 1 { "" } else { "s" }
                ),
                catalog,
            )
        } else {
            let cursor = integer(arguments, "cursor", 0, 0, 1_999)?;
            let limit = integer(arguments, "limit", 100, 1, 200)?;
            let total = matching.len();
            let targets: Vec<Value> = matching.into_iter().skip(cursor).take(limit).collect();
            let count = targets.len();
            let next = cursor + count;
            let next_cursor = if next < total {
                json!(next)
            } else {
                Value::Null
            };
            let more = !next_cursor.is_null() || catalog["truncated"] == true;
            (
                format!(
                    "Found {count} authorized execution target{}{}.",
                    if count == 1 { "" } else { "s" },
                    if more {
                        "; more targets are available"
                    } else {
                        ""
                    }
                ),
                json!({"projectId":catalog["projectId"],"targets":targets,"cursor":cursor,"nextCursor":next_cursor,"total":total,"truncated":more}),
            )
        };
        return parse(
            "cantripAgentOperationResultSchema",
            &json!({"summary":summary,"worktreeId":context["worktreeId"],"data":data}),
        );
    }
    let target = wire::parse("executionTargetSchema", arguments.get("target")).map_err(|_| {
        OperationError::new(400, "invalid", "A valid execution target is required.")
    })?;
    let mut resolution = repository
        .resolve(owner, project, &target, Some(&connected), true)
        .await?;
    let browser = if target["kind"] == "surface" && target["surfaceKind"] == "browser" {
        repository
            .remote_execution_context(owner, &target["surfaceId"])
            .await?
    } else {
        None
    };
    let summary = if resolution["availability"] == "available" {
        json!(format!(
            "{} can serve this target.",
            resolution["worker"]["name"]
                .as_str()
                .context("MCP target worker name")?
        ))
    } else {
        resolution
            .get("unavailableReason")
            .filter(|value| !value.is_null())
            .cloned()
            .unwrap_or_else(|| json!("The target is unavailable."))
    };
    let worktree = resolution["placement"]["worktreeId"].clone();
    resolution["serverId"] = json!(service.server_id);
    resolution["stateRevision"] = browser.map_or(Value::Null, |context| {
        context["surface"]["stateRevision"].clone()
    });
    parse(
        "cantripAgentOperationResultSchema",
        &json!({"summary":summary,"target":target,"worktreeId":worktree,"data":resolution}),
    )
}
