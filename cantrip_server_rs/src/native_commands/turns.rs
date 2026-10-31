//! Observed root ownership is durable. Proposed activation IDs are not observations.
use super::{
    admit::{raw_one, reject, text},
    settings_persistence::parse,
};
use crate::{
    database::Transaction,
    wire::{self, Value, coercion::truthy, value::json},
};
use anyhow::Result;
async fn find(tx: &Transaction<'_>, operation: &Value) -> Result<Option<Value>> {
    Ok(raw_one(tx,"SELECT to_jsonb(t)::text FROM native_command_turns t WHERE operation_id=$1",&[&text(operation)?]).await?.map(|row|json!({"operationId":row["operation_id"],"chatId":row["chat_id"],"threadId":row["thread_id"],"turnId":row["turn_id"],"runtimeGeneration":row["runtime_generation"]})))
}
/// The caller verifies actual native evidence and holds the owning chat lock.
pub async fn remember(tx: &Transaction<'_>, command: &Value, evidence: &Value) -> Result<()> {
    let session = parse("nativeCommandSessionSchema", &command["identity"])?;
    if command["kind"] != "start"
        || !truthy(session.get("threadId"))
        || session.get("runtimeGeneration") != evidence.get("runtimeGeneration")
    {
        return reject("native-turn-association-mismatch");
    }
    if let Some(existing) = find(tx, &command["operation_id"]).await? {
        if existing.get("chatId") != command.get("chat_id")
            || existing.get("threadId") != session.get("threadId")
            || existing.get("turnId") != evidence.get("nativeTurnId")
            || existing.get("runtimeGeneration") != evidence.get("runtimeGeneration")
        {
            return reject("native-turn-association-conflict");
        }
        return Ok(());
    }
    tx.query("INSERT INTO native_command_turns(operation_id,chat_id,thread_id,turn_id,runtime_generation) VALUES($1,$2,$3,$4,$5)",&[&text(&command["operation_id"])?,&text(&command["chat_id"])?,&text(&session["threadId"])?,&text(&evidence["nativeTurnId"])?,&text(&evidence["runtimeGeneration"])?]).await?;
    Ok(())
}
/// Historical receipts are selected before any optional unique-owner backfill.
pub async fn find_observed_command(
    tx: &Transaction<'_>,
    command: &Value,
    backfill: bool,
) -> Result<Option<Value>> {
    if let Some(existing) = find(tx, &command["operation_id"]).await? {
        return Ok(Some(existing));
    }
    if command["kind"] != "start"
        || command["status"] != "applied"
        || !truthy(command.get("execution_completed_at"))
    {
        return Ok(None);
    }
    let raw = &command["terminal_evidence"];
    if !matches!(raw["kind"].as_str(), Some("terminal" | "native-terminal")) {
        return Ok(None);
    }
    let mut proposed = Value::object([] as [(&str, Value); 0]);
    for field in ["nativeTurnId", "runtimeGeneration"] {
        if let Some(value) = raw.get(field) {
            proposed[field] = value.clone();
        }
    }
    let evidence = wire::parse("nativeCommandTerminalEvidenceSchema", Some(&proposed)).ok();
    let session = wire::parse("nativeCommandSessionSchema", command.get("identity")).ok();
    let Some((evidence, session)) = evidence.zip(session).filter(|(e, s)| {
        truthy(s.get("threadId")) && s.get("runtimeGeneration") == e.get("runtimeGeneration")
    }) else {
        return Ok(None);
    };
    if !backfill {
        return Ok(Some(
            json!({"operationId":command["operation_id"],"chatId":command["chat_id"],"threadId":session["threadId"],"turnId":evidence["nativeTurnId"],"runtimeGeneration":evidence["runtimeGeneration"]}),
        ));
    }
    remember(tx, command, &evidence).await?;
    find(tx, &command["operation_id"]).await
}
/// A steer reuses an observed root; it never reserves a second native-turn owner.
pub async fn find_observed_input(tx: &Transaction<'_>, command: &Value) -> Result<Option<Value>> {
    if command["kind"] == "start" {
        return find_observed_command(tx, command, true).await;
    }
    if command["method"] != "turn/steer" || !truthy(command.get("activation_generation")) {
        return Ok(None);
    }
    let intent = parse("nativeCommandIntentSchema", &command["intent"])?;
    if !truthy(intent.get("expectedTurnId")) {
        return Ok(None);
    }
    let root=raw_one(tx,"SELECT to_jsonb(n)::text FROM native_commands n WHERE chat_id=$1 AND owner_id=$2 AND worker_id=$3 AND activation_generation=$4 AND kind='start'",&[&text(&command["chat_id"])?,&text(&command["owner_id"])?,&text(&command["worker_id"])?,&text(&command["activation_generation"])?]).await?;
    let Some(root) = root else {
        return Ok(None);
    };
    Ok(find_observed_command(tx, &root, true)
        .await?
        .filter(|turn| turn.get("turnId") == intent.get("expectedTurnId")))
}
