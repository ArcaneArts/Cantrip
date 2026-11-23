use super::*;
use indexmap::IndexSet;
impl Repository {
    pub async fn hydration_context(&self, id: &str, command: &str) -> Result<Option<Value>> {
        let rows=self.database.query("SELECT chat_id FROM chat_import_jobs WHERE id=$1 AND command_id=$2 AND state='hydrating' LIMIT 1",&[&id,&command]).await?;
        let chat = rows
            .first()
            .map(|r| r.get::<Option<String>>(0))
            .transpose()?
            .flatten();
        let Some(chat) = chat.filter(|c| !c.is_empty()) else {
            return Ok(None);
        };
        let rows=self.database.query("SELECT to_jsonb(m)::text FROM chat_messages m WHERE chat_id=$1 ORDER BY sequence ASC",&[&chat]).await?;
        if rows.len() > 100_000 {
            return Err(conflict(
                "The imported transcript is too large to hydrate safely.",
            ));
        }
        let messages = rows.iter().map(raw).collect::<Result<Vec<_>>>()?;
        let mut ids = IndexSet::new();
        for message in &messages {
            if !crate::wire::coercion::truthy(message.get("protected_content"))
                || crate::wire::coercion::truthy(message.get("content"))
                || crate::wire::coercion::truthy(message.get("task_protected_content"))
            {
                return Err(conflict(
                    "The imported transcript contains an invalid encrypted message.",
                ));
            }
            for id in message["attachment_ids"]
                .as_array()
                .context("Imported attachment IDs")?
            {
                ids.insert(text(id)?);
            }
        }
        let ids = ids.into_iter().collect::<Vec<_>>();
        let records = if ids.is_empty() {
            vec![]
        } else {
            self.database.query("SELECT jsonb_build_object('attachment',to_jsonb(a),'replica',to_jsonb(r))::text FROM chat_attachments a LEFT JOIN chat_attachment_replicas r ON r.attachment_id=a.id WHERE a.chat_id=$1 AND a.id=ANY($2)",&[&chat,&ids]).await?.iter().map(raw).collect::<Result<Vec<_>>>()?
        };
        let mut attachments = Vec::new();
        for id in ids {
            let available = records
                .iter()
                .filter(|r| r["attachment"]["id"] == id.as_str())
                .collect::<Vec<_>>();
            let Some(first) = available.first() else {
                return Err(conflict(
                    "An imported attachment is missing from canonical chat state.",
                ));
            };
            let attachment = &first["attachment"];
            if attachment["status"] == "ready"
                && !available.iter().any(|r| r["replica"]["status"] == "ready")
            {
                return Err(conflict(
                    "An imported attachment is missing from canonical chat state.",
                ));
            }
            let mut workers = available
                .iter()
                .filter(|r| r["replica"]["status"] == "ready")
                .map(|r| r["replica"]["worker_id"].clone())
                .collect::<Vec<_>>();
            workers.sort_by(|a, b| {
                a.as_js_string()
                    .unwrap()
                    .units()
                    .cmp(b.as_js_string().unwrap().units())
            });
            workers.dedup();
            attachments.push(json!({"attachment":json!({"id":attachment["id"],"chatId":attachment["chat_id"],"sizeBytes":attachment["size_bytes"],"status":attachment["status"],"protectedMetadata":attachment["protected_metadata"],"createdAt":date(&attachment["created_at"])?}),"sourceWorkerId":attachment["worker_id"],"availableWorkerIds":workers}));
        }
        let mut opaque = Vec::new();
        for message in messages {
            let mut value = Value::object(
                [
                    ("id", "id"),
                    ("chatId", "chat_id"),
                    ("worktreeId", "worktree_id"),
                    ("executionLaneId", "execution_lane_id"),
                    ("sequence", "sequence"),
                    ("role", "role"),
                    ("mode", "mode"),
                    ("attachmentIds", "attachment_ids"),
                    ("protectedContent", "protected_content"),
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
                .map(|(key, column)| (key, message[column].clone())),
            );
            value["createdAt"] = date(&message["created_at"])?;
            opaque.push(crate::settings::parse_response(
                "chatMessageOpaqueSummarySchema",
                Some(&value),
            )?);
        }
        let payload = crate::settings::parse_response(
            "chatRelocationContextPayloadSchema",
            Some(
                &json!({"version":1,"kind":"chat-encrypted","messages":opaque,"attachments":attachments}),
            ),
        )?;
        Ok(Some(json!({"payload":payload})))
    }
    pub async fn complete_hydration(
        &self,
        id: &str,
        command: &str,
        attempt: f64,
        input: &Value,
    ) -> Result<Value> {
        let (id, command, input) = (id.to_owned(), command.to_owned(), input.clone());
        let at = crate::auth::now();
        let row=self.database.transaction(|tx|Box::pin(async move {
            let job=first(&tx.query("SELECT to_jsonb(j)::text FROM chat_import_jobs j WHERE id=$1 LIMIT 1 FOR UPDATE",&[&id]).await?)?;
            if !crate::wire::coercion::truthy(job.get("chat_id")) || job["command_id"]!=command.as_str() || job["attempt"]!=Value::Number(attempt) || job["state"]!="hydrating" {return Err(Error::Stale.into());}
            if input["threadId"]==job["source_thread_id"] {return Err(conflict("The external source thread cannot be adopted as a Cantrip-managed runtime."));}
            let chat=text(&job["chat_id"])?;let worker=text(&job["target_placement"]["workerId"])?;let tree=optional(&job["target_placement"]["worktreeId"])?;
            let rows=if crate::wire::coercion::truthy(job["target_placement"].get("worktreeId")) {
                tx.query("SELECT id FROM chat_runtime_sessions WHERE chat_id=$1 AND worker_id=$2 AND worktree_id=$3 LIMIT 1",&[&chat,&worker,&tree]).await?
            } else {vec![]};
            let Some(session)=rows.first() else {return Err(conflict("The imported chat runtime session no longer exists."));};
            let session=session.get::<String>(0)?;let thread=text(&input["threadId"])?;let route=text(&input["modelRouteId"])?;let account=optional(&input["providerAccountId"])?;let model=text(&input["modelId"])?;
            tx.query("UPDATE chat_runtime_sessions SET codex_thread_id=$2,model_route_id=$3,provider_account_id=$4,status='attached',updated_at=$5 WHERE id=$1",&[&session,&thread,&route,&account,&at]).await?;
            tx.query("UPDATE chat_execution_lanes SET codex_thread_id=$3,runtime_session_id=$2,updated_at=$4 WHERE chat_id=$1 AND runtime_session_id=$2 AND state='suspended'",&[&chat,&session,&thread,&at]).await?;
            tx.query("UPDATE chats SET model_id=$2,status='idle',updated_at=$3 WHERE id=$1",&[&chat,&model,&at]).await?;
            let p=progress("succeeded",100,at).stringify();
            first(&tx.query("UPDATE chat_import_jobs SET state='succeeded',state_revision=state_revision+1,command_id=NULL,lease_expires_at=NULL,managed_thread_id=$3,target_model_route_id=$4,target_provider_account_id=$5,progress=$6::text::jsonb,last_error_code=NULL,error_retryable=NULL,completed_at=$7,updated_at=$7 WHERE id=$1 AND command_id=$2 AND state='hydrating' RETURNING to_jsonb(chat_import_jobs)::text",&[&id,&command,&thread,&route,&account,&p,&at]).await?)
        })).await?;
        mapping::job(&row)
    }
    pub async fn complete_without_hydration(
        &self,
        id: &str,
        command: &str,
        attempt: f64,
    ) -> Result<Value> {
        let at = crate::auth::now();
        let p = progress("succeeded", 100, at).stringify();
        let attempt = Value::Number(attempt).stringify();
        mapping::job(&first(&self.database.query("UPDATE chat_import_jobs SET state='succeeded',state_revision=state_revision+1,command_id=NULL,lease_expires_at=NULL,progress=$4::text::jsonb,last_error_code=NULL,error_retryable=NULL,completed_at=$5,updated_at=$5 WHERE id=$1 AND command_id=$2 AND attempt=$3::text::integer AND state='hydrating' AND chat_id IS NOT NULL RETURNING to_jsonb(chat_import_jobs)::text",&[&id,&command,&attempt,&p,&at]).await?)?)
    }
    pub async fn complete_unsupported(&self) -> Result<usize> {
        let at = crate::auth::now();
        let p = progress("succeeded", 100, at).stringify();
        Ok(self.database.query("UPDATE chat_import_jobs SET state='succeeded',state_revision=state_revision+1,command_id=NULL,lease_expires_at=NULL,progress=$1::text::jsonb,last_error_code=NULL,error_retryable=NULL,completed_at=$2,updated_at=$2 WHERE state IN ('blocked','failed') AND last_error_code IN ('capability-missing','runtime-incompatible') AND chat_id IS NOT NULL AND managed_thread_id IS NULL RETURNING id",&[&p,&at]).await?.len())
    }
}
