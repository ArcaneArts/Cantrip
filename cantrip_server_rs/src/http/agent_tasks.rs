//! Project-scoped agent Task admission uses the normal durable Task scheduler.
use super::{
    agent_alerts::failure,
    settings::{output, parse},
};
use crate::{
    auth::service::AuthService,
    chats, tasks,
    wire::{Value, value::json},
};
use anyhow::{Context, Result};
use axum::response::Response;
use sha2::{Digest, Sha256};
use std::sync::Arc;

fn text(value: &Value) -> Result<&str> {
    value.as_str().context("Task identity")
}

async fn status(
    service: &AuthService,
    owner: &str,
    context: &Value,
    tasks: Vec<Value>,
    missing: Vec<Value>,
    next: Value,
    mutated: bool,
) -> Result<Response> {
    let chats = chats::Repository::new(service.repository.database.clone())
        .list_project(owner, text(&context["projectId"])?)
        .await?;
    let descriptors = tasks.iter().map(|task| {
        let chat = chats.iter().find(|chat| chat["id"] == task["chatId"]).context("Task chat is unavailable")?;
        let retrying = matches!(task["automaticRetry"]["status"].as_str(), Some("scheduled" | "retrying"));
        let active = matches!(task["dispatch"]["state"].as_str(), Some("queued" | "claimed" | "running" | "paused"));
        Ok(json!({
            "id":task["chatId"], "titleProtection":chat["titleProtection"], "state":task["state"],
            "dispatchState":task["dispatch"]["state"], "eligibilityCode":task["dispatch"]["eligibilityCode"],
            "configuration":task["modelConfiguration"],
            "terminal":!active && (task["state"]=="complete" || (task["state"]=="failed" && !retrying)),
            "completedAt":task["completedAt"], "updatedAt":task["updatedAt"]
        }))
    }).collect::<Result<Vec<Value>>>()?;
    let data = crate::settings::parse_response(
        "agentTaskStatusWireSchema",
        Some(&json!({"tasks":descriptors,"missingTaskIds":missing,"nextCursor":next})),
    )?;
    output(
        200,
        "cantripAgentOperationResultSchema",
        &json!({
            "summary":if mutated {"Task queued for direct execution with the caller's model; goal mode is off."} else {"Read project Task statuses."},
            "data":data,"mutated":mutated,"target":Value::Null,"worktreeId":context["worktreeId"],"continuationScheduled":false
        }),
    )
}

pub(super) async fn execute(
    service: &Arc<AuthService>,
    owner: &str,
    context: &Value,
    operation: &str,
    arguments: &Value,
) -> Result<Response> {
    if context["contextKind"] != "project" {
        return Ok(failure(
            403,
            "invalid",
            "Task tools require a project Chat.",
        ));
    }
    let repository = tasks::Repository::new(service.repository.database.clone());
    let project = text(&context["projectId"])?;
    if operation == "task.create" {
        let input = match parse("agentTaskCreateWireSchema", Some(arguments))? {
            Ok(input) => input,
            Err(response) => return Ok(response),
        };
        let operation_id = text(&input["operationId"])?;
        let hex = format!(
            "{:x}",
            Sha256::digest(format!(
                "agent-task:{}:{operation_id}",
                text(&context["chatId"])?
            ))
        );
        let id = format!(
            "{}-{}-5{}-a{}-{}",
            &hex[0..8],
            &hex[8..12],
            &hex[13..16],
            &hex[17..20],
            &hex[20..32]
        );
        if input["task"]["chatId"] != id.as_str() {
            return Ok(failure(
                403,
                "invalid",
                "Task identity does not match the caller and operation.",
            ));
        }
        let mut configuration = context["modelConfiguration"].clone();
        if context["experience"] == "task"
            && let Some(caller) = repository.get(owner, text(&context["chatId"])?).await?
        {
            configuration = if caller["dispatch"]["modelConfiguration"].is_null() {
                caller["modelConfiguration"].clone()
            } else {
                caller["dispatch"]["modelConfiguration"].clone()
            };
        }
        if configuration["modelId"].is_null() {
            let rows = service
                .repository
                .database
                .query(
                    "SELECT default_model_id FROM user_settings WHERE user_id=$1",
                    &[&owner],
                )
                .await?;
            configuration["modelId"] = rows
                .first()
                .map(|row| row.get::<Option<String>>(0))
                .transpose()?
                .flatten()
                .map_or(Value::Null, |id| json!(id));
        }
        if configuration["modelId"].is_null() {
            return Ok(failure(
                409,
                "conflict",
                "The calling Chat has no selected model.",
            ));
        }
        let mut current = repository
            .list(owner, project)
            .await?
            .into_iter()
            .find(|task| task["chatId"] == id.as_str());
        if current.is_none() {
            let create = json!({
                "chatId":id,"worktreeMode":"agent-managed","titleProtection":input["task"]["titleProtection"],"autoTitle":false,
                "planGoalEnabled":false,"priority":0,"modelConfiguration":configuration,"task":input["task"]["task"]
            });
            let connected = |id: &str| service.workers.bridge.is_connected(id);
            match chats::Repository::new(service.repository.database.clone())
                .create_task(owner, project, &create, Some(&connected))
                .await
            {
                Ok(Some(created)) => current = Some(created["task"].clone()),
                Ok(None) => return Ok(failure(404, "not-found", "Project source not found.")),
                Err(cause) => {
                    current = repository
                        .list(owner, project)
                        .await?
                        .into_iter()
                        .find(|task| task["chatId"] == id.as_str());
                    if current.is_none() {
                        return Err(cause);
                    }
                }
            }
        }
        let mut task = current.context("Created Task")?;
        if task["state"] == "draft" && task["dispatch"].is_null() {
            task = service
                .execution
                .queue
                .queue(
                    owner,
                    &id,
                    &json!({"operationId":operation_id,"rowVersion":task["rowVersion"]}),
                    "direct",
                    false,
                )
                .await?
                .context("Queued Task")?;
        }
        service
            .chat_mutations
            .publish_summary(owner, &json!(id), &context["projectId"]);
        service
            .chat_mutations
            .publish_invalidation(owner, &id, "task", None);
        return status(
            service,
            owner,
            context,
            vec![task],
            vec![],
            Value::Null,
            true,
        )
        .await;
    }
    let tasks = repository.list(owner, project).await?;
    if operation == "task.list" {
        let input = match parse("cantripMcpTaskListInputSchema", Some(arguments))? {
            Ok(input) => input,
            Err(response) => return Ok(response),
        };
        let cursor = input["cursor"].as_u64().context("Task cursor")? as usize;
        let limit = input["limit"].as_u64().context("Task limit")? as usize;
        let selected = tasks
            .iter()
            .skip(cursor)
            .take(limit)
            .cloned()
            .collect::<Vec<_>>();
        let next = if cursor + selected.len() < tasks.len() {
            json!(cursor + selected.len())
        } else {
            Value::Null
        };
        return status(service, owner, context, selected, vec![], next, false).await;
    }
    let input = match parse("cantripMcpTaskStatusInputSchema", Some(arguments))? {
        Ok(input) => input,
        Err(response) => return Ok(response),
    };
    let ids = input["taskIds"].as_array().context("Task IDs")?;
    let selected = tasks
        .into_iter()
        .filter(|task| ids.contains(&task["chatId"]))
        .collect::<Vec<_>>();
    let missing = ids
        .iter()
        .filter(|id| !selected.iter().any(|task| &task["chatId"] == *id))
        .cloned()
        .collect();
    status(
        service,
        owner,
        context,
        selected,
        missing,
        Value::Null,
        false,
    )
    .await
}
