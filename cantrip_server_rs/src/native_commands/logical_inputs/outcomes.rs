use super::activation;
use crate::{
    chats::execution_lanes,
    database::{Executor, Transaction},
    native_commands::{
        admit::{raw_one, reject, text},
        context, queue, receipt,
    },
    wire::{Value, coercion::truthy, value::json},
};
use anyhow::Result;
use futures::FutureExt;
use sha2::{Digest, Sha256};

pub(super) async fn root(
    tx: &Transaction<'_>,
    owner: &str,
    worker: &str,
    input: &Value,
) -> Result<Option<Value>> {
    let chat = text(&input["chatId"])?;
    context::lock_chat(tx, owner, &chat).await?;
    let root=raw_one(tx,"SELECT to_jsonb(n)::text FROM native_commands n WHERE operation_id=$1 AND operation_generation=$2 AND owner_id=$3 AND worker_id=$4 AND chat_id=$5",&[&text(&input["nativeLogicalRoot"]["operationId"])?,&text(&input["nativeLogicalRoot"]["operationGeneration"])?,&owner,&worker,&chat]).await?;
    let Some(root) = root.filter(|r| {
        r["origin"] == "gui"
            && r["kind"] == "start"
            && r.get("logical_operation_id") == r.get("operation_id")
            && r.get("execution_lane_id") == input.get("executionLaneId")
    }) else {
        return Ok(None);
    };
    let message=raw_one(tx,"SELECT to_jsonb(m)::text FROM chat_messages m WHERE id=$1 AND chat_id=$2 AND role='user' AND execution_lane_id=$3",&[&text(&input["clientMessageId"])?,&chat,&text(&input["executionLaneId"])?]).await?;
    let Some(message) = message else {
        return Ok(None);
    };
    let legacy = format!(
        "gui:{:x}",
        Sha256::digest(
            Value::Array(vec![
                json!(owner),
                input["chatId"].clone(),
                message["idempotency_key"].clone()
            ])
            .stringify()
            .as_bytes()
        )
    );
    if if truthy(root.get("logical_client_message_id")) {
        root.get("logical_client_message_id") != input.get("clientMessageId")
    } else {
        root["operation_id"] != json!(legacy)
    } {
        return Ok(None);
    }
    let active = activation(tx, &chat).await?;
    if active["worker_id"] != json!(worker)
        || active.get("execution_lane_id") != input.get("executionLaneId")
    {
        return Ok(None);
    }
    let head = raw_one(
        tx,
        "SELECT to_jsonb(n)::text FROM native_commands n WHERE operation_id=$1",
        &[&text(&active["operation_id"])?],
    )
    .await?;
    let Some(head) = head else {
        return Ok(None);
    };
    let identity = head.get("identity");
    if head.get("logical_operation_id") != root.get("operation_id")
        || head.get("execution_lane_id") != input.get("executionLaneId")
        || identity.and_then(|i| i.get("placementId")) != input.get("worktreeId")
        || (truthy(input.get("threadId"))
            && identity.and_then(|i| i.get("threadId")) != input.get("threadId"))
        || (truthy(input.get("turnId"))
            && truthy(active.get("native_turn_id"))
            && active.get("native_turn_id") != input.get("turnId"))
    {
        return Ok(None);
    }
    receipt::from_row(&root).map(Some)
}
async fn enqueue(
    tx: &Transaction<'_>,
    owner: &str,
    worker: &str,
    chat: &str,
    root: &str,
    generation: &str,
) -> Result<()> {
    tx.query("INSERT INTO native_logical_completions(owner_id,worker_id,chat_id,root_operation_id,root_operation_generation) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",&[&owner,&worker,&chat,&root,&generation]).await?;
    Ok(())
}
pub(super) async fn finish(
    tx: &Transaction<'_>,
    owner: &str,
    worker: &str,
    root: &str,
    generation: &str,
    status: &str,
) -> Result<bool> {
    // Preserve the source's read before the lock, including its captured state.
    let original =
        context::read(Executor::Transaction(tx), owner, worker, root, generation).await?;
    let chat = text(&original["chat_id"])?;
    context::lock_chat(tx, owner, &chat).await?;
    if original["origin"] != "gui"
        || original.get("logical_operation_id") != original.get("operation_id")
    {
        return reject("invalid-continuation-lineage");
    }
    if truthy(original.get("logical_completed_at")) {
        enqueue(tx, owner, worker, &chat, root, generation).await?;
        return Ok(false);
    }
    let active = activation(tx, &chat).await?;
    if active.is_null() {
        return Ok(false);
    }
    let head = raw_one(
        tx,
        "SELECT to_jsonb(n)::text FROM native_commands n WHERE operation_id=$1",
        &[&text(&active["operation_id"])?],
    )
    .await?;
    let Some(head) = head.filter(|h| {
        h.get("logical_operation_id") == original.get("operation_id")
            && h.get("execution_lane_id") == original.get("execution_lane_id")
            && truthy(h.get("execution_lane_id"))
    }) else {
        return Ok(false);
    };
    let finished = if truthy(active.get("active")) {
        execution_lanes::finish_in_transaction(
            tx,
            &chat,
            &text(&head["execution_lane_id"])?,
            status,
            &Value::Null,
        )
        .boxed()
        .await?
    } else {
        false
    };
    tx.query(
        "UPDATE native_commands SET logical_completed_at=$1 WHERE operation_id=$2",
        &[&crate::auth::now(), &text(&original["operation_id"])?],
    )
    .await?;
    enqueue(tx, owner, worker, &chat, root, generation).await?;
    tx.query(
        "UPDATE native_command_activations SET active=false WHERE chat_id=$1",
        &[&chat],
    )
    .await?;
    let (status, code) = match head["status"].as_str() {
        Some("accepted") => (json!("rejected"), json!("not-dispatched")),
        Some("dispatched") => (json!("uncertain"), json!("missing-native-receipt")),
        _ => (head["status"].clone(), head["rejection_code"].clone()),
    };
    tx.query("UPDATE native_commands SET execution_completed_at=$1,status=$2,rejection_code=$3 WHERE operation_id=$4",&[&crate::auth::now(),&text(&status)?,&super::super::admit::optional(&code)?,&text(&head["operation_id"])?]).await?;
    let completed = raw_one(
        tx,
        "SELECT to_jsonb(n)::text FROM native_commands n WHERE operation_id=$1",
        &[&text(&head["operation_id"])?],
    )
    .await?
    .unwrap_or(Value::Null);
    queue::settle(tx, &completed, None, None).await?;
    Ok(finished)
}
