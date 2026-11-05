//! Project Agent discovery and opaque transcript reads. Workers open the content.
use super::agent_operations::{OperationError, parse};
use crate::{
    auth::service::AuthService,
    chats,
    wire::{Value, value::json},
};
use anyhow::{Context, Result};
use sha2::{Digest, Sha256};

fn descriptor(chat: &Value, default_model: &Value) -> Value {
    json!({"id":chat["id"],"titleProtection":chat["titleProtection"],"status":chat["status"],"automationPaused":chat["automationPaused"],"configuration":json!({
        "modelId":if chat["modelId"].is_null(){default_model}else{&chat["modelId"]},
        "reasoningEffort":chat["reasoningEffort"],"customSubagentModel":chat["customSubagentModel"],"subagentModelId":chat["subagentModelId"],"subagentReasoningEffort":chat["subagentReasoningEffort"]
    })})
}

pub(super) async fn execute(
    service: &AuthService,
    owner: &str,
    context: &Value,
    operation: &str,
    arguments: &Value,
) -> Result<Value> {
    if context["contextKind"] != "project" || context["experience"] != "agent" {
        return Err(OperationError::new(
            403,
            "invalid",
            "Chat tools require a project Agent chat.",
        )
        .into());
    }
    let repository = chats::Repository::new(service.repository.database.clone());
    let project = context["projectId"].as_str().context("Chat project")?;
    let chats = super::agent_operations::project_chats(service, owner, project)
        .await?
        .into_iter()
        .filter(|chat| chat["experience"] == "agent")
        .collect::<Vec<_>>();
    let sender = chats
        .iter()
        .find(|chat| chat["id"] == context["chatId"])
        .ok_or_else(|| OperationError::new(404, "not-found", "The sending chat is unavailable."))?;
    let default_model = if chats.iter().any(|chat| chat["modelId"].is_null()) {
        let settings = crate::settings::repository::SettingsRepository::new(
            service.repository.database.clone(),
        )
        .get_user_settings_with_query_context(
            owner,
            Some((
                crate::chats::mcp_read_queries::sql("settings"),
                &[json!(owner), json!(1)],
            )),
        )
        .await?;
        Value::from_serialize(&settings["defaultModelId"])
    } else {
        Value::Null
    };
    let result = |summary: &str, data: Value| json!({"summary":summary,"data":data,"mutated":false,"target":Value::Null,"worktreeId":context["worktreeId"],"continuationScheduled":false});
    if operation == "chat.list" {
        let input = parse("cantripMcpChatListInputSchema", arguments)?;
        let cursor = input["cursor"].as_u64().context("Chat cursor")? as usize;
        let limit = input["limit"].as_u64().context("Chat limit")? as usize;
        let selected = chats
            .iter()
            .skip(cursor)
            .take(limit)
            .map(|chat| descriptor(chat, &default_model))
            .collect::<Vec<_>>();
        let next = if cursor + selected.len() < chats.len() {
            json!(cursor + selected.len())
        } else {
            Value::Null
        };
        return Ok(result(
            &format!("Found {} project chats.", selected.len()),
            json!({"chats":selected,"nextCursor":next}),
        ));
    }
    let target = chats
        .iter()
        .find(|chat| chat.get("id") == arguments.get("chatId"))
        .ok_or_else(|| {
            OperationError::new(404, "not-found", "Chat not found in the current project.")
        })?;
    let input = parse("cantripMcpChatReadInputSchema", arguments)?;
    let id = target["id"].as_str().context("Chat identity")?;
    let mut page = repository
        .opaque_message_page_for_mcp(owner, id, &input)
        .await?;
    let latest = if input["limit"] == 20 && input.get("beforeSequence").is_none() {
        page.clone()
    } else {
        repository
            .opaque_message_page_for_mcp(owner, id, &json!({"limit":20}))
            .await?
    };
    let identities = latest["messages"]
        .as_array()
        .context("Chat cursor messages")?
        .iter()
        .map(|message| {
            json!([
                message["id"].clone(),
                message["sequence"].clone(),
                message["protectedContent"].clone()
            ])
        })
        .collect::<Vec<_>>();
    let cursor=format!("{:x}",Sha256::digest(json!({"chatId":target["id"],"status":target["status"],"paused":target["automationPaused"],"messages":identities}).stringify().as_bytes()));
    let messages = page["messages"].as_array().context("Chat messages")?;
    let mut bytes = 0;
    let mut first = messages.len();
    while first > 0 {
        let size = messages[first - 1].stringify().len();
        if bytes + size > 6 * 1024 * 1024 {
            break;
        }
        bytes += size;
        first -= 1;
    }
    if first > 0 {
        let retained = messages[first..].to_vec();
        let oldest = retained.first();
        page["page"]["hasMore"] = json!(true);
        if let Some(oldest) = oldest {
            page["page"]["nextBeforeSequence"] = oldest["sequence"].clone();
        }
        page["page"]["oldestSequence"] =
            oldest.map_or(Value::Null, |message| message["sequence"].clone());
        page["page"]["startsAtUserTurn"] =
            json!(oldest.is_some_and(|message| message["role"] == "user"));
        page["messages"] = Value::Array(retained);
    }
    let data = parse(
        "agentChatReadWireSchema",
        &json!({"cursor":cursor,"chat":descriptor(target,&default_model),"sender":descriptor(sender,&default_model),"messages":page["messages"],"page":page["page"]}),
    )?;
    Ok(result("Read protected chat history.", data))
}
