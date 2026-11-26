use super::super::agent_operations::{OperationError, parse};
use crate::{
    auth::service::AuthService,
    settings::repository::SettingsRepository,
    wire::{Value, value::json},
};
use anyhow::{Context, Result};
use cantrip_protocol::external_mcp::orchestration::resource_id;
use uuid::Uuid;

pub(super) async fn create(
    service: &AuthService,
    owner: &str,
    context: &Value,
    arguments: &Value,
) -> Result<Value> {
    let input = parse("councilMcpSetupWireSchema", arguments)?;
    let source = context["chatId"].as_str().context("Council agent ID")?;
    let worker = context["workerId"].as_str().context("Council Worker")?;
    let operation = Uuid::parse_str(input["operationId"].as_str().context("MCP operation ID")?)?;
    let id = resource_id(owner, source, operation, "council-mcp-server").to_string();
    let request = &input["server"];
    if request["id"] != id || request["workerId"] != worker || request["audience"] != "chat" {
        return Err(OperationError::validation().into());
    }

    let repository = SettingsRepository::new(service.repository.database.clone());
    let server = match repository.create_mcp_server(owner, None, request).await {
        Ok(Some(server)) => server,
        Ok(None) => {
            return Err(
                OperationError::new(404, "not-found", "MCP settings are unavailable.").into(),
            );
        }
        Err(cause) if unique_constraint(&cause) => {
            // The stable resource identity makes a retry recover the committed
            // configuration. The Worker compares the plaintext after opening it.
            let existing = repository.list_mcp_servers(owner, None).await?;
            existing
                .and_then(|rows| {
                    rows.as_array()?
                        .iter()
                        .find(|server| {
                            server["id"] == id
                                && server["workerId"] == worker
                                && server["audience"] == "chat"
                        })
                        .cloned()
                })
                .ok_or_else(|| {
                    OperationError::new(
                        409,
                        "conflict",
                        "An MCP server already uses that identity or name.",
                    )
                })?
        }
        Err(cause) => return Err(cause),
    };

    Ok(json!({"summary":"Configured the MCP server on this Worker.","mutated":true,"data":server}))
}

fn unique_constraint(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        cause
            .downcast_ref::<tokio_postgres::Error>()
            .and_then(|error| error.code())
            .is_some_and(|code| *code == tokio_postgres::error::SqlState::UNIQUE_VIOLATION)
            || matches!(cause.downcast_ref::<pglite::Error>(),
                Some(pglite::Error::Database { sqlstate, .. }) if sqlstate.as_str() == "23505")
    })
}
