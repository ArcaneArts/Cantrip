use super::*;
use crate::wire::{coercion::truthy, value::json};
pub(super) async fn persist(
    tx: &Transaction<'_>,
    owner: &str,
    binding: &Value,
    items: &[Value],
) -> Result<()> {
    let chat = text(&binding["chatId"])?;
    for item in items {
        if let Some(e) = item.get("evidence")
            && (e["bindingId"] != binding["id"] || e["workerId"] != binding["workerId"])
        {
            return reject("item-evidence-binding-mismatch", 409);
        }
        if item["attachments"]
            .as_array()
            .context("History item attachments")?
            .iter()
            .any(|a| a["chatId"] != binding["chatId"])
        {
            return reject("item-attachment-mismatch", 409);
        }
        let key = items::key(&binding["chatId"], &item["identity"]);
        let mapping = one(
            tx,
            "SELECT to_jsonb(i)::text FROM native_history_items i WHERE key=$1 FOR UPDATE",
            &[&key],
        )
        .await?;
        let Some(mapping) = mapping
            .filter(|r| r["chat_id"] == binding["chatId"] && r["thread_id"] == binding["threadId"])
        else {
            return reject("item-not-resolved", 409);
        };
        let message = &item["message"];
        if message["id"] != mapping["message_id"]
            || message["idempotencyKey"] != mapping["idempotency_key"]
        {
            return reject("item-message-identity-conflict", 409);
        }
        if truthy(mapping.get("preserved_input")) && message != &mapping["preserved_input"] {
            return reject("input-alias-content-conflict", 409);
        }
        let revision = item["revision"].as_f64().context("History item revision")?;
        let stored = mapping["revision"]
            .as_f64()
            .context("Reserved item revision")?;
        if let Some(expected) = item.get("expectedRevision")
            && (expected != &mapping["revision"] || revision <= stored)
        {
            return reject("item-revision-conflict", 409);
        }
        let digest = payload_digest(item);
        if revision < stored {
            continue;
        }
        if revision == stored {
            if mapping["payload_digest"] != json!(digest) {
                return reject("item-revision-conflict", 409);
            }
            continue;
        }
        if mapping["state"] == "completed" && item["state"] != "completed" {
            if item.get("expectedRevision").is_some() {
                return reject("item-revision-conflict", 409);
            }
            continue;
        }
        let id = text(&message["id"])?;
        let idempotency = text(&message["idempotencyKey"])?;
        let matches=all(tx,"SELECT to_jsonb(m)::text FROM chat_messages m WHERE id=$1 OR(chat_id=$2 AND idempotency_key=$3) FOR UPDATE",&[&id,&chat,&idempotency]).await?;
        let existing = matches.first();
        let provisional = stored == 0.0
            && mapping["payload_digest"].is_null()
            && !truthy(mapping.get("preserved_input"))
            && !truthy(mapping.get("alias_operation_id"))
            && !truthy(mapping.get("alias_claim_id"))
            && mapping["identity_kind"] == "canonical"
            && matches!(
                mapping["component"].as_str(),
                Some("assistant" | "activity")
            )
            && existing.is_some_and(|m| m["role"] == "assistant" && m["mode"] == "default")
            && message["classification"]["mode"] == "plan"
            && item.get("evidence").is_some();
        if matches.len() > 1
            || existing.is_some_and(|e| {
                e["chat_id"] != binding["chatId"]
                    || e["id"] != message["id"]
                    || e["idempotency_key"] != message["idempotencyKey"]
                    || e["role"] != message["classification"]["role"]
                    || (e["mode"] != message["classification"]["mode"] && !provisional)
                    || !truthy(e.get("protected_content"))
            })
        {
            return reject("item-canonical-message-conflict", 409);
        }
        attachments::persist(tx, binding, item).await?;
        let role = text(&message["classification"]["role"])?;
        let mode = text(&message["classification"]["mode"])?;
        let content = message["protectedContent"].stringify();
        let attachment_ids = message["classification"]["attachmentIds"].stringify();
        let reasoning = optional(&message["reasoningEffort"])?;
        if existing.is_some() {
            if !truthy(mapping.get("preserved_input")) {
                tx.query("UPDATE chat_messages SET role=$1,mode=$2,content=NULL,protected_content=$3::text::jsonb,attachment_ids=$4::text::jsonb,reasoning_effort=$5,idempotency_key=$6 WHERE id=$7",&[&role,&mode,&content,&attachment_ids,&reasoning,&idempotency,&id]).await?;
            }
        } else {
            let thread = text(&binding["threadId"])?;
            let turn = text(&item["identity"]["turnId"])?;
            let worker = text(&binding["workerId"])?;
            let command=one(tx,"SELECT to_jsonb(n)::text FROM native_command_turns t INNER JOIN native_commands n ON n.operation_id=t.operation_id WHERE t.chat_id=$1 AND t.thread_id=$2 AND t.turn_id=$3 AND n.owner_id=$4 AND n.worker_id=$5",&[&chat,&thread,&turn,&owner,&worker]).await?;
            let session = command.as_ref().map(input_alias::session).transpose()?;
            let worktree = text(
                session
                    .as_ref()
                    .map(|s| &s["placementId"])
                    .unwrap_or(&binding["worktreeId"]),
            )?;
            let lane = command
                .as_ref()
                .map(|c| optional(&c["execution_lane_id"]))
                .transpose()?
                .flatten();
            tx.query("INSERT INTO chat_messages(id,chat_id,role,mode,content,protected_content,attachment_ids,reasoning_effort,idempotency_key,worktree_id,execution_lane_id) VALUES($1,$2,$3,$4,NULL,$5::text::jsonb,$6::text::jsonb,$7,$8,$9,$10)",&[&id,&chat,&role,&mode,&content,&attachment_ids,&reasoning,&idempotency,&worktree,&lane]).await?;
        }
        let revision = item["revision"].stringify();
        let state = text(&item["state"])?;
        let turn = item["order"]["turn"].stringify();
        let ordinal = item["order"]["item"].stringify();
        let component = item["order"]["component"].stringify();
        let evidence = item.get("evidence").map(Value::stringify);
        tx.query("UPDATE native_history_items SET revision=$1::text::bigint,state=$2,payload_digest=$3,protected_evidence=CASE WHEN $4::text IS NULL THEN protected_evidence ELSE $4::text::jsonb END,turn_ordinal=$5::text::bigint,item_ordinal=$6::text::bigint,component_ordinal=$7::text::bigint WHERE key=$8",&[&revision,&state,&digest,&evidence,&turn,&ordinal,&component,&key]).await?;
    }
    Ok(())
}
