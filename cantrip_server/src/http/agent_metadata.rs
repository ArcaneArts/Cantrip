//! Transport-neutral MCP context control and opaque effective-policy access.
use super::agent_operations::{OperationError, parse};
use crate::{
    auth::service::AuthService,
    policies::repository::PolicyRepository,
    wire::{Value, value::json},
};
use anyhow::{Context, Result};

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
    if operation == "context.compact" {
        return parse(
            "cantripAgentOperationResultSchema",
            &json!({"summary":"Current-turn context compaction is authorized.","worktreeId":context["worktreeId"],"mutated":true}),
        );
    }
    // Source trims the required string before any policy repository reads.
    // Retain its UTF-16 identity until the effective-policy membership check.
    let policy_id = if operation == "policy.read" {
        Some(
            arguments["policyId"]
                .as_js_string()
                .map(|value| value.trim())
                .filter(|value| !value.is_empty())
                .ok_or_else(|| OperationError::new(400, "invalid", "policyId is required."))?,
        )
    } else {
        None
    };
    let repository = PolicyRepository::for_mcp(service.repository.database.clone());
    let project = context["projectId"]
        .as_str()
        .context("MCP project identity")?;
    let effective = repository.resolve_effective(owner, project).await?;
    let (summary, data) = if let Some(id) = policy_id {
        let not_found = || {
            OperationError::new(
                404,
                "not-found",
                "That policy is not effective for the current project.",
            )
        };
        if !effective.as_ref().is_some_and(|effective| {
            effective["policies"].as_array().is_some_and(|policies| {
                policies.iter().any(|policy| {
                    policy["id"]
                        .as_str()
                        .is_some_and(|stored| stored.encode_utf16().eq(id.units().iter().copied()))
                })
            })
        }) {
            return Err(not_found().into());
        }
        let current = repository
            .get(owner, &id.lossy())
            .await?
            .filter(|policy| policy["enabled"] == true)
            .ok_or_else(not_found)?;
        (
            "Returned opaque policy content.",
            parse(
                "policyCliWireReadResultSchema",
                &json!({"policy":Value::from_serialize(&current)}),
            )?,
        )
    } else {
        let effective = effective.ok_or_else(|| {
            OperationError::new(404, "not-found", "The current project no longer exists.")
        })?;
        (
            "Returned opaque effective policy metadata.",
            parse(
                "policyCliWireListResultSchema",
                &Value::from_serialize(&effective),
            )?,
        )
    };
    parse(
        "cantripAgentOperationResultSchema",
        &json!({"summary":summary,"worktreeId":context["worktreeId"],"data":data}),
    )
}
