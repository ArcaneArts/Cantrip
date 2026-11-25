use super::super::agent_operations::{OperationError, parse};
use crate::{
    auth::service::AuthService,
    project_automations::{
        dispatch,
        repository::{Conflict, CouncilAutomationMutation, Repository},
    },
    wire::{Value, value::json},
};
use anyhow::{Context, Result};
use cantrip_protocol::external_mcp::orchestration::resource_id;
use uuid::Uuid;

fn not_found() -> OperationError {
    OperationError::new(404, "not-found", "Council routine or agent not found.")
}

fn text(value: &Value) -> Result<&str> {
    value.as_str().context("Council routine identity")
}

pub(super) async fn run(
    service: &AuthService,
    owner: &str,
    context: &Value,
    operation: &str,
    arguments: &Value,
) -> Result<Value> {
    let repository = Repository::new(service.repository.database.clone());
    let source = text(&context["chatId"])?;
    match operation {
        "council.automation.list" => {
            let input = parse("councilAutomationListInputSchema", arguments)?;
            let target = input["agentId"].as_str().unwrap_or(source);
            let offset = input["offset"].as_u64().context("Routine offset")? as u32;
            let limit = input["limit"].as_u64().context("Routine page size")? as u32;
            let page = repository
                .list_council_page(owner, target, offset, Some(limit + 1))
                .await?;
            let rows = page.as_array().context("Council routine page")?;
            let next = (rows.len() > limit as usize).then(|| offset + limit);
            Ok(json!({
                "summary":"Loaded Council routines.",
                "data":json!({"routines":rows.iter().take(limit as usize).cloned().collect::<Vec<_>>(),"nextOffset":next}),
            }))
        }
        "council.automation.read" => {
            let input = parse("councilAutomationReadInputSchema", arguments)?;
            let routine = repository
                .get(owner, text(&input["automationId"])?)
                .await?
                .filter(|routine| routine["projectId"].is_null())
                .ok_or_else(not_found)?;
            Ok(json!({"summary":"Loaded the Council routine.","data":routine}))
        }
        _ => {
            let (input, mutation, summary) = if operation == "council.automation.create" {
                let input = parse("councilAutomationCreateWireSchema", arguments)?;
                let expected = resource_id(
                    owner,
                    source,
                    Uuid::parse_str(text(&input["operationId"])?)?,
                    "council-automation",
                )
                .to_string();
                if input["routine"]["id"] != expected {
                    return Err(OperationError::new(
                        400,
                        "invalid",
                        "The routine identity does not match this operation.",
                    )
                    .into());
                }
                (
                    input,
                    CouncilAutomationMutation::Create,
                    "Created the Council routine.",
                )
            } else {
                (
                    parse("councilAutomationUpdateWireSchema", arguments)?,
                    CouncilAutomationMutation::Update,
                    "Updated the Council routine.",
                )
            };
            let (receipt, changed) = match repository
                .mutate_council(owner, source, mutation, input)
                .await
            {
                Ok(Some(result)) => result,
                Ok(None) => return Err(not_found().into()),
                Err(error) if error.is::<Conflict>() => {
                    return Err(OperationError::new(409, "conflict", error.to_string()).into());
                }
                Err(error) => return Err(error),
            };
            if changed {
                dispatch::publish(service, owner, &receipt);
            }
            Ok(json!({"summary":summary,"mutated":true,"data":receipt}))
        }
    }
}
