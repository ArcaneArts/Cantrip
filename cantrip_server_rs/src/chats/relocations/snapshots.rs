use super::*;
use indexmap::IndexSet;
use sha2::{Digest, Sha256};
pub(super) async fn get(ex: Executor<'_, '_>, owner: &str, id: &str) -> Result<Option<Value>> {
    ex.query("SELECT to_jsonb(s)::text FROM chat_relocation_snapshots s INNER JOIN chat_relocation_jobs j ON j.id=s.job_id AND j.owner_id=$1 WHERE s.job_id=$2 LIMIT 1",&[&owner,&id]).await?.first().map(|r|mapping::snapshot(&raw(r)?)).transpose()
}
pub(super) async fn capture(ex: Executor<'_, '_>, chat: &Value) -> Result<Value> {
    let chat_id = text(&chat["id"])?;
    let rows = ex
        .query(
            "SELECT to_jsonb(m)::text FROM chat_messages m WHERE chat_id=$1 ORDER BY sequence ASC",
            &[&chat_id],
        )
        .await?;
    if rows.len() > 100_000 {
        return Err(conflict(
            "The canonical transcript is too large to snapshot safely.",
        ));
    }
    let messages = rows.iter().map(raw).collect::<Result<Vec<_>>>()?;
    let mut ids = IndexSet::new();
    for m in &messages {
        if crate::wire::coercion::truthy(m.get("task_protected_content"))
            || crate::wire::coercion::truthy(m.get("protected_content"))
        {
            let field = if crate::wire::coercion::truthy(m.get("task_protected_content")) {
                "task_attachment_ids"
            } else {
                "attachment_ids"
            };
            for id in m[field].as_array().context("Relocation attachment IDs")? {
                ids.insert(text(id)?);
            }
        } else if let Some(content) = m["content"].as_array() {
            for item in content {
                if item["type"] == "attachment" && item["attachment"]["id"].is_string() {
                    ids.insert(text(&item["attachment"]["id"])?);
                }
            }
        }
    }
    if let Some(task) = ex
        .query(
            "SELECT to_jsonb(t)::text FROM tasks t WHERE chat_id=$1 LIMIT 1",
            &[&chat_id],
        )
        .await?
        .first()
        .map(raw)
        .transpose()?
    {
        for id in task["draft_attachment_ids"]
            .as_array()
            .context("Task draft attachment IDs")?
        {
            ids.insert(text(id)?);
        }
    }
    if ids.len() > 2000 {
        return Err(conflict(
            "The chat has too many referenced attachments to relocate safely.",
        ));
    }
    let ids = ids.into_iter().collect::<Vec<_>>();
    let mut attachments = Vec::new();
    if !ids.is_empty() {
        let records=ex.query("SELECT jsonb_build_object('attachment',to_jsonb(a),'replica',to_jsonb(r))::text FROM chat_attachments a LEFT JOIN chat_attachment_replicas r ON r.attachment_id=a.id AND r.status='ready' WHERE a.chat_id=$1 AND a.id=ANY($2)",&[&chat_id,&ids]).await?.iter().map(raw).collect::<Result<Vec<_>>>()?;
        for id in &ids {
            let matches = records
                .iter()
                .filter(|r| r["attachment"]["id"] == id.as_str())
                .collect::<Vec<_>>();
            let Some(available) = matches
                .first()
                .filter(|r| r["attachment"]["status"] == "ready")
            else {
                return Err(conflict(
                    "A referenced attachment is missing from canonical chat state.",
                ));
            };
            let a = &available["attachment"];
            let mut workers = matches
                .iter()
                .filter_map(|r| {
                    if r["replica"].is_null() {
                        None
                    } else {
                        Some(r["replica"]["worker_id"].clone())
                    }
                })
                .collect::<Vec<_>>();
            workers.sort_by(|a, b| {
                a.as_js_string()
                    .unwrap()
                    .units()
                    .cmp(b.as_js_string().unwrap().units())
            });
            workers.dedup();
            attachments.push(json!({"attachment":json!({"id":a["id"],"chatId":a["chat_id"],"sizeBytes":a["size_bytes"],"status":a["status"],"protectedMetadata":a["protected_metadata"],"createdAt":date(&a["created_at"])?}),"sourceWorkerId":a["worker_id"],"availableWorkerIds":workers}));
        }
    }
    let task = chat["experience"] == "task";
    if !task && chat["experience"] != "agent" {
        return Err(conflict("The chat experience cannot be relocated."));
    }
    let mut protected = Vec::new();
    for m in &messages {
        let valid = if task {
            crate::wire::coercion::truthy(m.get("task_protected_content"))
                && !crate::wire::coercion::truthy(m.get("content"))
        } else {
            crate::wire::coercion::truthy(m.get("protected_content"))
                && !crate::wire::coercion::truthy(m.get("content"))
                && !crate::wire::coercion::truthy(m.get("task_protected_content"))
        };
        if !valid {
            return Err(conflict(if task {
                "The encrypted Task transcript contains an invalid message."
            } else {
                "The encrypted chat transcript contains an invalid message."
            }));
        }
        let mut message = Value::object(
            [
                ("id", "id"),
                ("chatId", "chat_id"),
                ("worktreeId", "worktree_id"),
                ("executionLaneId", "execution_lane_id"),
                ("sequence", "sequence"),
                ("role", "role"),
                ("mode", "mode"),
                ("modelId", "model_id"),
                ("modelRouteId", "model_route_id"),
                ("providerId", "provider_id"),
                ("providerName", "provider_name"),
                ("providerModelName", "provider_model_name"),
                ("reasoningEffort", "reasoning_effort"),
                ("appliedReasoningEffort", "applied_reasoning_effort"),
                ("reasoningAdjusted", "reasoning_adjusted"),
                ("idempotencyKey", "idempotency_key"),
            ]
            .into_iter()
            .map(|(k, f)| (k, m[f].clone())),
        );
        message["attachmentIds"] = m[if task {
            "task_attachment_ids"
        } else {
            "attachment_ids"
        }]
        .clone();
        message["protectedContent"] = m[if task {
            "task_protected_content"
        } else {
            "protected_content"
        }]
        .clone();
        message["createdAt"] = date(&m["created_at"])?;
        protected.push(message);
    }
    let payload = crate::settings::parse_response(
        "chatRelocationContextPayloadSchema",
        Some(
            &json!({"version":1,"kind":if task{"task-encrypted"}else{"chat-encrypted"},"messages":protected,"attachments":attachments}),
        ),
    )?;
    let digest = format!(
        "{:x}",
        Sha256::digest(super::super::hydration::encode_canonical_payload(&payload))
    );
    Ok(
        json!({"payload":payload,"transcriptSha256":digest,"throughSequence":messages.last().map(|m|m["sequence"].clone()).unwrap_or(json!(0)),"messageCount":messages.len(),"attachmentCount":ids.len()}),
    )
}
pub(super) async fn refresh(database: &Database, id: String) -> Result<()> {
    database.transaction(move|tx|Box::pin(async move{
        let row=tx.query("SELECT jsonb_build_object('job',to_jsonb(j),'chat',to_jsonb(c),'worktree',to_jsonb(w),'runtime',to_jsonb(r))::text FROM chat_relocation_jobs j INNER JOIN chats c ON c.id=j.chat_id INNER JOIN project_worktrees w ON w.id=c.active_worktree_id LEFT JOIN chat_runtime_sessions r ON r.chat_id=c.id AND r.worker_id=w.worker_id AND r.worktree_id=w.id WHERE j.id=$1 LIMIT 1",&[&id]).await?.first().map(raw).transpose()?;
        let Some(row)=row else{return Ok(())};let j=&row["job"];let c=&row["chat"];let w=&row["worktree"];
        if j["state"]!="waiting-for-idle" || c["status"]=="running" || c["status"]=="waiting-for-approval" {return Ok(())}
        if c["placement_revision"]!=j["source_placement_revision"] || w["id"]!=j["source_placement"]["worktreeId"] || w["worker_id"]!=j["source_placement"]["workerId"] {return Err(conflict("The source placement changed before the idle snapshot could be captured."))}
        if !crate::wire::coercion::truthy(w.get("head")){return Err(conflict("The source worktree revision has not been observed yet."))}
        let s=capture(Executor::Transaction(tx),c).await?;let payload=s["payload"].stringify();let digest=text(&s["transcriptSha256"])?;let sequence=s["throughSequence"].stringify();let messages=s["messageCount"].stringify();let attachments=s["attachmentCount"].stringify();let model=optional(&c["model_id"])?;let route=optional(&row["runtime"]["model_route_id"])?;let permission=optional(&c["permission_profile_id"])?;let head=text(&w["head"])?;
        tx.query("UPDATE chat_relocation_snapshots SET through_sequence=$2::text::integer,transcript_sha256=$3,payload=$4::text::jsonb,message_count=$5::text::integer,attachment_count=$6::text::integer,model_id=$7,model_route_id=$8,permission_profile_id=$9,required_revision=$10 WHERE job_id=$1",&[&id,&sequence,&digest,&payload,&messages,&attachments,&model,&route,&permission,&head]).await?;Ok(())
    })).await
}
