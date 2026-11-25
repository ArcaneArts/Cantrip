use super::{Authorized, grant};
use crate::{
    encryption::Service,
    protected_secrets::{open_mcp_server, seal_mcp_server},
};
use anyhow::{Context, Result, ensure};
use cantrip_protocol::external_mcp::orchestration::resource_id;
use cantrip_wire::{Value, value::json};
use uuid::Uuid;

pub(super) fn protect(
    service: &Service,
    authorization: &Authorized,
    agent_id: &Value,
    input: &Value,
) -> Result<Value> {
    let key = grant(service, authorization, "mcp-secret", None)?;
    let operation = Uuid::parse_str(input["operationId"].as_str().context("MCP operation ID")?)?;
    let id = resource_id(
        authorization.identity.0.as_str().context("Council owner")?,
        agent_id.as_str().context("Council agent ID")?,
        operation,
        "council-mcp-server",
    );
    let server = seal_mcp_server(
        &key,
        &json!(id.to_string()),
        &authorization.active.binding["workerId"],
        "chat",
        &input["configuration"],
    )?;
    Ok(json!({"operationId": input["operationId"], "server": server}))
}

pub(super) fn open(
    service: &Service,
    authorization: &Authorized,
    input: &Value,
    server: &Value,
) -> Result<Value> {
    ensure!(
        server["workerId"] == authorization.active.binding["workerId"]
            && server["audience"] == "chat"
            && server["scope"] == "global",
        "The MCP setup receipt belongs to another scope."
    );
    let revision = server["protectedConfiguration"]["keyRevision"]
        .as_u64()
        .context("MCP secret key revision")?;
    let key = grant(service, authorization, "mcp-secret", Some(revision))?;
    let configuration = open_mcp_server(&key, server)?;
    ensure!(
        configuration == input["configuration"],
        "This operation ID already belongs to a different MCP configuration."
    );
    Ok(json!({
        "id": server["id"], "workerId": server["workerId"], "name": configuration["name"],
        "transport": configuration["transport"], "enabled": configuration["enabled"],
    }))
}
