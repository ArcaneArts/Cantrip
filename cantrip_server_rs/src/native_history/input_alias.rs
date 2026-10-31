use super::*;
use crate::{
    native_commands::turns,
    wire::{coercion::truthy, value::json},
};

pub(super) fn session(command: &Value) -> Result<Value> {
    crate::settings::parse_response("nativeCommandSessionSchema", Some(&command["identity"]))
}
pub(super) fn same_turn(binding: &Value, item: &Value, session: &Value, turn: &Value) -> bool {
    turn["chatId"] == binding["chatId"]
        && turn["threadId"] == binding["threadId"]
        && turn["turnId"] == item["identity"]["turnId"]
        && turn["runtimeGeneration"] == session["runtimeGeneration"]
}
pub(super) async fn command_input(
    tx: &Transaction<'_>,
    owner: &str,
    binding: &Value,
    item: &Value,
) -> Result<Option<Value>> {
    let association = &item["association"];
    if association["kind"] != "command-input" {
        return Ok(None);
    }
    if item["identity"]["component"] != "user" {
        return reject("input-alias-component-mismatch", 409);
    }
    let operation = text(&association["operationId"])?;
    let generation = text(&association["operationGeneration"])?;
    let chat = text(&binding["chatId"])?;
    let command=one(tx,"SELECT to_jsonb(n)::text FROM native_commands n WHERE operation_id=$1 AND operation_generation=$2 AND owner_id=$3 AND chat_id=$4",&[&operation,&generation,&owner,&chat]).await?;
    let Some(command) = command.filter(|c| {
        truthy(c.get("logical_client_message_id"))
            && (c["kind"] == "start" || c["method"] == "turn/steer")
    }) else {
        return reject("input-command-not-bound", 409);
    };
    if command["method"] == "turn/steer"
        && (command["status"] != "applied"
            || !truthy(command.get("protected_result"))
            || !truthy(command.get("result_digest")))
    {
        return reject("input-command-unacknowledged", 409);
    }
    let session = session(&command)?;
    if session["threadId"] != binding["threadId"] || session["chatId"] != binding["chatId"] {
        return reject("input-command-thread-mismatch", 409);
    }
    let Some(turn) = turns::find_observed_input(tx, &command).await? else {
        return reject("input-command-turn-unobserved", 409);
    };
    if !same_turn(binding, item, &session, &turn) {
        return reject("input-command-turn-mismatch", 409);
    }
    let client = format!("cantrip:{}", text(&command["logical_client_message_id"])?);
    if association["clientUserMessageId"] != json!(client) {
        return reject("input-client-id-mismatch", 409);
    }
    let id = text(&command["logical_client_message_id"])?;
    let message = one(
        tx,
        "SELECT to_jsonb(m)::text FROM chat_messages m WHERE id=$1 AND chat_id=$2",
        &[&id, &chat],
    )
    .await?;
    let Some(message) = message.filter(|m| {
        m["role"] == "user"
            && truthy(m.get("protected_content"))
            && truthy(m.get("idempotency_key"))
    }) else {
        return reject("input-message-unavailable", 409);
    };
    let result = json!({"id":message["id"],"idempotencyKey":message["idempotency_key"],"classification":json!({"role":message["role"],"mode":message["mode"],"attachmentIds":message["attachment_ids"]}),"protectedContent":message["protected_content"],"reasoningEffort":message["reasoning_effort"]});
    crate::settings::parse_response("chatMessageOpaqueContentSchema", Some(&result)).map(Some)
}

/// A client ID locates candidates; admitted command and observed turn evidence
/// establish ownership. A historical reader never replaces the executing worker.
pub(super) async fn observed(
    tx: &Transaction<'_>,
    owner: &str,
    binding: &Value,
    item: &Value,
) -> Result<Value> {
    if item["association"]["kind"] != "observed-input" {
        return Ok(item["association"].clone());
    }
    if item["identity"]["component"] != "user" || item["identity"]["identityKind"] != "canonical" {
        return reject("observed-input-component-mismatch", 409);
    }
    let client = text(&item["association"]["clientUserMessageId"])?;
    let chat = text(&binding["chatId"])?;
    let mut candidates = Vec::new();
    if let Some(id) = client.strip_prefix("cantrip:") {
        for command in all(tx,"SELECT to_jsonb(n)::text FROM native_commands n WHERE owner_id=$1 AND chat_id=$2 AND logical_client_message_id=$3",&[&owner,&chat,&id]).await? {
            if command["kind"]!="start"&&command["method"]!="turn/steer" {continue}
            let association=json!({"kind":"command-input","operationId":command["operation_id"],"operationGeneration":command["operation_generation"],"clientUserMessageId":client});
            candidates.push((command,association));
        }
    }
    let retained = "coalesce(s.protected_input,p.opaque_content)";
    let sql = format!(
        "SELECT jsonb_build_object('claim',to_jsonb(q),'command',to_jsonb(n))::text FROM managed_queue_claims q INNER JOIN native_commands n ON n.operation_id=q.operation_id AND n.operation_generation=q.operation_generation LEFT JOIN managed_queue_input_snapshots s ON s.claim_id=q.id LEFT JOIN queued_prompts p ON p.id=q.prompt_id AND p.revision=q.prompt_revision WHERE q.chat_id=$1 AND n.owner_id=$2 AND n.chat_id=$1 AND q.awaiting_goal=false AND ({retained} IS NULL OR coalesce({retained}->>'nativeClientUserMessageId','cantrip:'||({retained}->'pendingMessage'->>'id'))=$3)"
    );
    for row in all(tx, &sql, &[&chat, &owner, &client]).await? {
        let claim = &row["claim"];
        let command = &row["command"];
        let association = json!({"kind":"queue-input","operationId":command["operation_id"],"operationGeneration":command["operation_generation"],"claimId":claim["id"],"promptRevision":claim["prompt_revision"],"clientUserMessageId":client});
        candidates.push((command.clone(), association));
    }
    let count = candidates.len();
    let mut unobserved = false;
    let mut matches = Vec::new();
    for (command, association) in candidates {
        let session = session(&command)?;
        if session["threadId"] != binding["threadId"] || session["chatId"] != binding["chatId"] {
            continue;
        }
        let Some(turn) = turns::find_observed_input(tx, &command).await? else {
            unobserved = true;
            continue;
        };
        if same_turn(binding, item, &session, &turn) {
            matches.push((command, association));
        }
    }
    let queued = matches
        .iter()
        .filter(|(_, a)| a["kind"] == "queue-input")
        .map(|(c, _)| c["operation_id"].clone())
        .collect::<Vec<_>>();
    let mut chosen = matches
        .into_iter()
        .filter(|(c, a)| a["kind"] == "queue-input" || !queued.contains(&c["operation_id"]))
        .collect::<Vec<_>>();
    if chosen.len() > 1 {
        return reject("input-provenance-ambiguous", 409);
    }
    if let Some((_, association)) = chosen.pop() {
        return Ok(association);
    }
    if unobserved {
        return reject("input-provenance-unobserved", 409);
    }
    if count > 0 {
        return reject("input-provenance-turn-mismatch", 409);
    }
    if client.starts_with("cantrip:") {
        return reject("input-provenance-unavailable", 409);
    }
    Ok(json!({"kind":"native"}))
}
