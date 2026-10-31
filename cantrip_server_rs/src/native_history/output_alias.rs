use super::*;
use crate::{
    native_commands::turns,
    wire::{coercion::truthy, value::json},
};

fn root(binding: &Value, item: &Value) -> Result<(Value, Value)> {
    let ancestors = binding.get("ancestorThreadIds").and_then(Value::as_array);
    let ancestor = ancestors.and_then(|v| v.first());
    let proposed = if item["association"]["kind"] == "output" {
        item["association"].get("rootTurnId")
    } else {
        None
    };
    if ancestor.is_some() && !truthy(proposed) {
        return reject("child-output-root-turn-missing", 409);
    }
    if ancestor.is_none() && truthy(proposed) && proposed != Some(&item["identity"]["turnId"]) {
        return reject("root-output-turn-mismatch", 409);
    }
    Ok((
        ancestor.unwrap_or(&binding["threadId"]).clone(),
        proposed.unwrap_or(&item["identity"]["turnId"]).clone(),
    ))
}
async fn observed_command(
    tx: &Transaction<'_>,
    owner: &str,
    binding: &Value,
    item: &Value,
) -> Result<Value> {
    let (thread, turn) = root(binding, item)?;
    if item["identity"]["identityKind"] != "canonical" {
        return reject("observed-output-identity-mismatch", 409);
    }
    let chat = text(&binding["chatId"])?;
    let thread_text = text(&thread)?;
    let turn_text = text(&turn)?;
    let candidates=all(tx,"SELECT to_jsonb(n)::text FROM native_commands n LEFT JOIN native_command_turns t ON t.operation_id=n.operation_id WHERE n.owner_id=$1 AND n.chat_id=$2 AND n.kind='start' AND n.identity->>'threadId'=$3 AND (t.turn_id=$4 OR(t.operation_id IS NULL AND n.terminal_evidence->>'nativeTurnId'=$4))",&[&owner,&chat,&thread_text,&turn_text]).await?;
    let mut matches = Vec::new();
    for command in candidates {
        let session = input_alias::session(&command)?;
        if turns::find_observed_command(tx, &command, false)
            .await?
            .is_some_and(|t| {
                t["chatId"] == binding["chatId"]
                    && t["threadId"] == thread
                    && t["turnId"] == turn
                    && t["runtimeGeneration"] == session["runtimeGeneration"]
            })
        {
            matches.push(command);
        }
    }
    if matches.len() != 1 {
        return reject(
            if matches.is_empty() {
                "output-provenance-unavailable"
            } else {
                "output-provenance-ambiguous"
            },
            409,
        );
    }
    Ok(matches.pop().unwrap())
}
pub(super) struct Alias {
    pub message: Value,
    pub operation: Value,
    pub claimed: Value,
}

/// Adopt a live output only after exact historical command/turn evidence. New
/// native output has no GUI alias; child output retains its root-turn scope.
pub(super) async fn find(
    tx: &Transaction<'_>,
    owner: &str,
    binding: &Value,
    item: &Value,
) -> Result<Option<Alias>> {
    let a = &item["association"];
    if !matches!(
        a["kind"].as_str(),
        Some("command-output" | "observed-output" | "output")
    ) {
        return Ok(None);
    }
    let prefix = match item["identity"]["component"].as_str() {
        Some("assistant") => "agent-message",
        Some("activity") => "activity",
        _ => return reject("output-alias-component-mismatch", 409),
    };
    if a["kind"] == "output" && item["identity"]["identityKind"] != "canonical" {
        return reject("observed-output-identity-mismatch", 409);
    }
    let (thread, turn) = root(binding, item)?;
    let scopes = if binding
        .get("ancestorThreadIds")
        .and_then(Value::as_array)
        .is_some_and(|v| !v.is_empty())
    {
        vec![format!("{}:{}", text(&turn)?, text(&binding["threadId"])?)]
    } else {
        vec![
            "root".to_owned(),
            format!(
                "{}:{}",
                text(&item["identity"]["turnId"])?,
                text(&binding["threadId"])?
            ),
        ]
    };
    let keys = scopes
        .into_iter()
        .map(|s| {
            Ok(format!(
                "{prefix}:{s}:{}:{}",
                text(&item["identity"]["turnId"])?,
                text(&item["identity"]["itemId"])?
            ))
        })
        .collect::<Result<Vec<_>>>()?;
    let chat = text(&binding["chatId"])?;
    let matches=all(tx,"SELECT to_jsonb(m)::text FROM chat_messages m WHERE chat_id=$1 AND idempotency_key=ANY($2::text[])",&[&chat,&keys]).await?;
    if a["kind"] == "output" && matches.is_empty() {
        return Ok(None);
    }
    let command = if a["kind"] != "command-output" {
        Some(observed_command(tx, owner, binding, item).await?)
    } else {
        let operation = text(&a["operationId"])?;
        let generation = text(&a["operationGeneration"])?;
        one(tx,"SELECT to_jsonb(n)::text FROM native_commands n WHERE operation_id=$1 AND operation_generation=$2 AND owner_id=$3 AND chat_id=$4",&[&operation,&generation,&owner,&chat]).await?
    };
    let Some(command) = command.filter(|c| c["kind"] == "start") else {
        return reject("output-command-not-bound", 409);
    };
    let session = input_alias::session(&command)?;
    let observed = turns::find_observed_command(tx, &command, true).await?;
    if session["threadId"] != thread
        || session["chatId"] != binding["chatId"]
        || !observed.is_some_and(|t| {
            t["chatId"] == binding["chatId"]
                && t["threadId"] == thread
                && t["turnId"] == turn
                && t["runtimeGeneration"] == session["runtimeGeneration"]
        })
    {
        return reject("output-command-turn-mismatch", 409);
    }
    if matches.len() != 1 {
        return reject(
            if matches.is_empty() {
                "output-message-unavailable"
            } else {
                "output-alias-ambiguous"
            },
            409,
        );
    }
    let message = matches.into_iter().next().unwrap();
    if message["role"] != "assistant"
        || !truthy(message.get("protected_content"))
        || !truthy(message.get("idempotency_key"))
        || message["id"]
            != json!(crate::chats::message_writes::event_id(
                &chat,
                &text(&message["idempotency_key"])?
            ))
    {
        return reject("output-message-identity-mismatch", 409);
    }
    let id = text(&message["id"])?;
    let claimed=one(tx,"SELECT jsonb_build_object('key',key)::text FROM native_history_items WHERE chat_id=$1 AND message_id=$2",&[&chat,&id]).await?.map(|r|r["key"].clone()).unwrap_or(Value::Null);
    Ok(Some(Alias {
        message,
        operation: command["operation_id"].clone(),
        claimed,
    }))
}
