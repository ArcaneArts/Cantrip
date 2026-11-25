use super::{Authorized, Inner};
mod automations;
mod messages;
mod peer;
use crate::{
    encryption::Service,
    mcp::bindings::COUNCIL_TOOLS,
    protected_content::{council_inventory, council_memory},
};
use anyhow::{Context, Result, ensure};
use cantrip_crypto::{
    Zeroizing,
    content::{decrypt_private_label, encrypt_private_label},
    derive_field_key, encrypt_payload,
};
use cantrip_protocol::external_mcp::orchestration::resource_id;
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
        let name = COUNCIL_TOOLS
            .iter()
            .find(|(id, _)| *id == operation)
            .map(|(_, name)| *name)
            .context("Unrecognized Council tool")?;
        let input = mcp_host::parse(&format!("mcpStdioInput/{name}"), call.get("arguments"))
            .map_err(response_error)?;
        let request = uuid::Uuid::new_v4().to_string();
        if operation == "council.peer.send" {
            let reply = self
                .send_council_peer(authorization, &input, &request)
                .await?;
            return mcp_host::parse(&format!("mcpStdioOutput/{name}"), Some(&reply))
                .map_err(response_error);
        }
        let agent_id = &authorization.active.binding["chatId"];
        let arguments = match operation {
            "council.message.post" => messages::protect(
                self.encryption
                    .as_ref()
                    .context("Council encryption is unavailable")?
                    .clone(),
                authorization,
                agent_id,
                &input,
            )?,
            "council.create" => protect(service, authorization, &request, &input)?,
            "council.automation.create" => {
                automations::protect_create(service, authorization, agent_id, &input)?
            }
            "council.automation.update" => {
                automations::protect_update(service, authorization, &input)?
            }
            "council.project.chat.create" | "council.project.task.create" => {
                let task = operation == "council.project.task.create";
                let operation_id = input["operationId"]
                    .as_str()
                    .context("Creation operation ID")?;
                let id = resource_id(
                    authorization.identity.0.as_str().context("Council owner")?,
                    agent_id.as_str().context("Council agent ID")?,
                    uuid::Uuid::parse_str(operation_id)?,
                    if task {
                        "council-project-task"
                    } else {
                        "council-project-chat"
                    },
                )
                .to_string();
                if task {
                    let (title, definition) =
                        super::tasks::protect_task_creation(service, authorization, &input, &id)?;
                    json!({"projectId":input["projectId"],"operationId":operation_id,"taskId":id,"titleProtection":title,"task":definition,"start":input["start"]})
                } else {
                    let title = protect_title(service, authorization, &id, &input["title"])?;
                    json!({"projectId":input["projectId"],"operationId":operation_id,"chatId":id,"titleProtection":title})
                }
            }
            "council.memory.write" => {
                let key = grant(service, authorization, "chat-content", None)?;
                json!({"expectedRevision":input["expectedRevision"],"protectedMemory":council_memory::seal(&key, agent_id,
                    input["text"].as_str().context("Council memory must be valid UTF-8.")?)?})
            }
            _ => input,
        };
        let mut reply = self
            .relay_project(
                authorization,
                json!({"operation":operation,"arguments":arguments}),
                &request,
            )
            .await?;
        match operation {
            "council.create" => {
                reply["data"]["agent"] = open(service, authorization, &reply["data"]["agent"])?;
            }
            "council.list" => {
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
            "council.inventory" => {
                let identity = (
                    authorization.identity.0.clone(),
                    json!(authorization.identity.1),
                );
                reply["data"] = council_inventory::open(service, &identity, &reply["data"])?;
            }
            "council.automation.list" => {
                let routines = reply["data"]["routines"]
                    .as_array()
                    .context("Council routines")?;
                reply["data"]["routines"] = json!(
                    routines
                        .iter()
                        .map(|routine| automations::open(service, authorization, routine, false))
                        .collect::<Result<Vec<_>>>()?
                );
            }
            "council.automation.read" => {
                reply["data"] = automations::open(service, authorization, &reply["data"], true)?;
            }
            "council.automation.create" | "council.automation.update" | "council.message.post" => {}
            "council.project.chat.create"
            | "council.project.task.create"
            | "council.project.task.start"
            | "council.project.interrupt" => {}
            _ => {
                reply["data"] = open_memory(service, authorization, agent_id, &reply["data"])?;
            }
        }
        mcp_host::parse(&format!("mcpStdioOutput/{name}"), Some(&reply)).map_err(response_error)
    }
}

fn open_memory(
    service: &Service,
    authorization: &Authorized,
    agent: &Value,
    input: &Value,
) -> Result<Value> {
    let record = crate::http::checked("councilMemoryWireSchema", input)?;
    ensure!(
        record["agentId"] == *agent,
        "Council memory belongs to another agent."
    );
    let envelope = &record["protectedMemory"];
    let text = if envelope.is_null() {
        json!("")
    } else {
        let revision = envelope["keyRevision"]
            .as_u64()
            .context("Council memory key revision")?;
        let key = grant(service, authorization, "chat-content", Some(revision))?;
        let bytes = council_memory::open(&key, agent, envelope)?;
        json!(std::str::from_utf8(&bytes).context("Council memory encoding")?)
    };
    Ok(json!({"revision":record["revision"],"text":text}))
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

fn protect_title(
    service: &Service,
    authorization: &Authorized,
    id: &str,
    title: &Value,
) -> Result<Value> {
    let label = grant(service, authorization, "private-surface-metadata", None)?;
    encrypt_private_label(
        &label.component.key,
        &json!({
            "ownerId":label.owner_id,"keyRevision":label.component.key_revision,"recordKind":"chat","rowId":id,
        }),
        title,
    )
}

fn protect(
    service: &Service,
    authorization: &Authorized,
    id: &str,
    input: &Value,
) -> Result<Value> {
    let title = protect_title(service, authorization, id, &input["title"])?;
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
    let title = open_title(
        service,
        authorization,
        &agent["id"],
        &agent["titleProtection"],
    )?;
    Ok(
        json!({"id":agent["id"],"title":title,"primary":agent["primary"],"scratchStatus":agent["scratchStatus"]}),
    )
}

fn open_title(
    service: &Service,
    authorization: &Authorized,
    agent: &Value,
    opaque: &Value,
) -> Result<Value> {
    let revision = opaque["protectedLabel"]["keyRevision"]
        .as_u64()
        .context("Council label revision")?;
    let label = grant(
        service,
        authorization,
        "private-surface-metadata",
        Some(revision),
    )?;
    decrypt_private_label(
        &label.component.key,
        &json!({
            "ownerId":label.owner_id,"keyRevision":revision,"recordKind":"chat","rowId":agent,
        }),
        opaque,
    )
}
