use super::{Authorized, Inner};
use crate::encryption::Service;
use anyhow::{Context, Result, ensure};
use cantrip_crypto::{
    Zeroizing,
    content::{decrypt_private_label, encrypt_private_label},
    derive_field_key, encrypt_payload,
};
use cantrip_protocol::{mcp_host, response::response_error};
use cantrip_wire::{Value, value::json};

impl Inner {
    pub(super) async fn council(
        &self,
        authorization: &Authorized,
        call: &Value,
        operation: &str,
    ) -> Result<Value> {
        let service = self
            .encryption
            .as_deref()
            .context("Council encryption is unavailable")?;
        let name = if operation == "council.create" {
            "council_create"
        } else {
            "council_list"
        };
        let input = mcp_host::parse(&format!("mcpStdioInput/{name}"), call.get("arguments"))
            .map_err(response_error)?;
        let request = uuid::Uuid::new_v4().to_string();
        let arguments = if operation == "council.create" {
            protect(service, authorization, &request, &input)?
        } else {
            input
        };
        let mut reply = self
            .relay_project(
                authorization,
                json!({"operation":operation,"arguments":arguments}),
                &request,
            )
            .await?;
        if operation == "council.create" {
            reply["data"]["agent"] = open(service, authorization, &reply["data"]["agent"])?;
        } else {
            let agents = reply["data"]["agents"]
                .as_array()
                .context("Council roster")?;
            reply["data"]["agents"] = json!(
                agents
                    .iter()
                    .map(|agent| open(service, authorization, agent))
                    .collect::<Result<Vec<_>>>()?
            );
        }
        mcp_host::parse(&format!("mcpStdioOutput/{name}"), Some(&reply)).map_err(response_error)
    }
}

fn grant(
    service: &Service,
    authorization: &Authorized,
    component: &str,
    revision: Option<u64>,
) -> Result<crate::encryption::BoundComponentKey> {
    let grant = service.bound_component(component, revision)?;
    ensure!(
        grant.owner_id == authorization.identity.0
            && grant.server_id.as_js_string() == Some(&authorization.identity.1),
        "The worker binding changed while processing Council content."
    );
    Ok(grant)
}

fn protect(
    service: &Service,
    authorization: &Authorized,
    id: &str,
    input: &Value,
) -> Result<Value> {
    let label = grant(service, authorization, "private-surface-metadata", None)?;
    let title = encrypt_private_label(
        &label.component.key,
        &json!({
            "ownerId":label.owner_id,"keyRevision":label.component.key_revision,"recordKind":"chat","rowId":id,
        }),
        &input["title"],
    )?;
    let role = Zeroizing::new(
        input["role"]
            .as_str()
            .context("Council role")?
            .as_bytes()
            .to_vec(),
    );
    ensure!(
        !role.is_empty() && role.len() <= 32 * 1024,
        "Council roles are limited to 32 KiB."
    );
    let content = grant(service, authorization, "chat-content", None)?;
    let aad = json!({
        "ownerId":content.owner_id,"component":"chat-content","table":"council_agents",
        "rowId":id,"field":"role","formatVersion":1,"keyRevision":content.component.key_revision,
    });
    let key = derive_field_key(&content.component.key, &aad)?;
    let protected_role = encrypt_payload(&key, &role, &aad)?;
    crate::http::checked(
        "councilAgentCreateSchema",
        &json!({"id":id,"titleProtection":title,"protectedRole":protected_role}),
    )
}

fn open(service: &Service, authorization: &Authorized, agent: &Value) -> Result<Value> {
    let agent = crate::http::checked("councilAgentWireSummarySchema", agent)?;
    let opaque = &agent["titleProtection"];
    let revision = opaque["protectedLabel"]["keyRevision"]
        .as_u64()
        .context("Council label revision")?;
    let label = grant(
        service,
        authorization,
        "private-surface-metadata",
        Some(revision),
    )?;
    let title = decrypt_private_label(
        &label.component.key,
        &json!({
            "ownerId":label.owner_id,"keyRevision":revision,"recordKind":"chat","rowId":agent["id"],
        }),
        opaque,
    )?;
    Ok(
        json!({"id":agent["id"],"title":title,"primary":agent["primary"],"scratchStatus":agent["scratchStatus"]}),
    )
}
