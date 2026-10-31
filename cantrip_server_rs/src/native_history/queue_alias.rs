use super::*;
use crate::{
    native_commands::{managed_queue::retain_input, turns},
    wire::{coercion::truthy, value::json},
};
pub(super) async fn find(
    tx: &Transaction<'_>,
    owner: &str,
    binding: &Value,
    item: &Value,
) -> Result<Option<Value>> {
    let a = &item["association"];
    if a["kind"] != "queue-input" && a["kind"] != "queue-goal" {
        return Ok(None);
    }
    let id = text(&a["claimId"])?;
    let chat = text(&binding["chatId"])?;
    let claim = one(
        tx,
        "SELECT to_jsonb(q)::text FROM managed_queue_claims q WHERE id=$1 AND chat_id=$2",
        &[&id, &chat],
    )
    .await?;
    let Some(claim) = claim else {
        return reject("queue-input-claim-mismatch", 409);
    };
    let goal = truthy(claim.get("awaiting_goal"));
    let (operation, generation) = if goal {
        (
            &claim["goal_operation_id"],
            &claim["goal_operation_generation"],
        )
    } else {
        (&claim["operation_id"], &claim["operation_generation"])
    };
    if claim["status"] != "consumed"
        || claim["prompt_revision"] != a["promptRevision"]
        || operation != &a["operationId"]
        || generation != &a["operationGeneration"]
    {
        return reject("queue-input-claim-mismatch", 409);
    }
    if if goal {
        a["kind"] != "queue-goal"
            || item["identity"]["component"] != "goal-request"
            || item["identity"]["identityKind"] != "canonical"
            || item["identity"]["itemId"] != claim["id"]
    } else {
        a["kind"] != "queue-input" || item["identity"]["component"] != "user"
    } {
        return reject("queue-input-component-mismatch", 409);
    }
    let operation = text(&a["operationId"])?;
    let generation = text(&a["operationGeneration"])?;
    let command=one(tx,"SELECT to_jsonb(n)::text FROM native_commands n WHERE operation_id=$1 AND operation_generation=$2 AND owner_id=$3 AND chat_id=$4",&[&operation,&generation,&owner,&chat]).await?;
    let Some(command) = command.filter(|c| {
        c["status"] == "applied"
            && truthy(c.get("protected_result"))
            && truthy(c.get("result_digest"))
    }) else {
        return reject("queue-input-command-unacknowledged", 409);
    };
    let session = input_alias::session(&command)?;
    let turn = turns::find_observed_input(tx, &command).await?;
    if !turn.as_ref().is_some_and(|t| {
        session["threadId"] == binding["threadId"]
            && session["chatId"] == binding["chatId"]
            && input_alias::same_turn(binding, item, &session, t)
            && (!truthy(claim.get("native_turn_id")) || claim["native_turn_id"] == t["turnId"])
    }) {
        return reject("queue-input-turn-mismatch", 409);
    }
    let mut snapshot=one(tx,"SELECT to_jsonb(s)::text FROM managed_queue_input_snapshots s WHERE claim_id=$1",&[&id]).await?.map(|r|json!({"promptId":r["prompt_id"],"promptRevision":r["prompt_revision"],"protectedInput":r["protected_input"]}));
    if snapshot.is_none() {
        let prompt = text(&claim["prompt_id"])?;
        let revision = claim["prompt_revision"].stringify();
        if let Some(prompt)=one(tx,"SELECT to_jsonb(p)::text FROM queued_prompts p WHERE id=$1 AND chat_id=$2 AND revision=$3::text::integer",&[&prompt,&chat,&revision]).await?{snapshot=retain_input(tx,&id,&prompt).await?;}
    }
    let Some(snapshot) = snapshot.filter(|s| {
        s["promptId"] == claim["prompt_id"] && s["promptRevision"] == claim["prompt_revision"]
    }) else {
        return reject("queue-input-revision-unavailable", 409);
    };
    let prompt = &snapshot["protectedInput"];
    let client = prompt
        .get("nativeClientUserMessageId")
        .filter(|v| !v.is_null())
        .cloned()
        .unwrap_or(json!(format!(
            "cantrip:{}",
            text(&prompt["pendingMessage"]["id"])?
        )));
    if prompt["pendingMessage"]["classification"]["role"] != "user"
        || (a["kind"] == "queue-input" && a["clientUserMessageId"] != client)
    {
        return reject("queue-input-client-id-mismatch", 409);
    }
    Ok(Some(prompt["pendingMessage"].clone()))
}
