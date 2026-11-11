use super::*;
use crate::database::Executor;
impl QueueRepository {
    pub async fn pending_dispatches(&self) -> Result<Vec<Value>> {
        self.database.query(&format!("SELECT DISTINCT c.owner_id,c.id FROM queued_prompts p INNER JOIN chats c ON c.id=p.chat_id WHERE c.experience='agent' AND c.automation_paused=false AND c.managed_autonomy_stopped=false AND {NO_PERMISSION} AND {NO_HANDOFF} AND NOT EXISTS(SELECT 1 FROM managed_queue_states s WHERE s.chat_id=c.id AND s.goal_recovery IS NOT NULL) AND ((p.state='pending' AND p.frozen=false AND NOT EXISTS(SELECT 1 FROM managed_queue_claims q WHERE q.prompt_id=p.id AND q.prompt_revision=p.revision AND q.status='rejected')) OR (p.state='claimed' AND EXISTS(SELECT 1 FROM managed_queue_claims q WHERE q.prompt_id=p.id AND q.status='claimed' AND q.operation_id IS NULL)))"),&[]).await?.iter().map(|r|Ok(json!({"ownerId":r.get::<String>(0)?,"chatId":r.get::<String>(1)?}))).collect()
    }
    pub async fn pending_notifications(&self, limit: Option<f64>) -> Result<Vec<Value>> {
        let limit = limit.unwrap_or(64.0);
        let limit = (limit >= 0.0).then(|| {
            crate::wire::coercion::string(&Value::Number(limit))
                .unwrap()
                .lossy()
                .into_owned()
        });
        let rows=self.database.query(&format!("SELECT s.chat_id,s.revision,c.owner_id,s.goal_recovery::text,({NO_PERMISSION} AND {NO_HANDOFF}),(SELECT d.goal_cycle_recovery::text FROM task_dispatch_cycles d WHERE d.chat_id=c.id ORDER BY d.created_at DESC,d.id DESC LIMIT 1) FROM managed_queue_states s INNER JOIN chats c ON c.id=s.chat_id WHERE s.notified_revision<s.revision AND s.notification_due_at<=now() ORDER BY s.notification_due_at ASC LIMIT $1::text::bigint"),&[&limit]).await?;
        let mut result = Vec::new();
        for row in rows {
            let chat = row.get::<String>(0)?;
            let owner = row.get::<String>(2)?;
            let context = crate::chats::Repository::execution_context_with(
                Executor::Database(&self.database),
                &owner,
                &chat,
            )
            .await?;
            let previous = self.database.query("SELECT DISTINCT worker_id FROM native_commands WHERE owner_id=$1 AND chat_id=$2 AND rejection_code='worker-inference-deferred'", &[&owner,&chat]).await?;
            let mut workers = Vec::new();
            let task_recovery: Option<Value> = row
                .get::<Option<String>>(5)?
                .map(|raw| serde_json::from_str(&raw))
                .transpose()?;
            if let Some(context) = &context {
                workers.push(text(&context["workerId"])?);
            }
            if let Some(marker) = &task_recovery {
                let worker = text(&marker["workerId"])?;
                if !workers.contains(&worker) {
                    workers.push(worker);
                }
            }
            for row in previous {
                let worker = row.get::<String>(0)?;
                if !workers.contains(&worker) {
                    workers.push(worker);
                }
            }
            if !workers.is_empty() {
                let worker = workers.remove(0);
                let mut entry = json!({"ownerId":owner,"workerId":worker,"chatId":chat,"revision":row.get::<i32>(1)?});
                if row.get::<bool>(4)?
                    && row.get::<Option<String>>(3)?.is_none()
                    && context.as_ref().is_some_and(|c| c["experience"] == "agent")
                    && let Some(claim) = self.goal_claim_recovery(&owner, &chat).await?
                {
                    entry["goalClaimRecovery"] = claim;
                }
                if row.get::<bool>(4)?
                    && let Some(recovery) = row.get::<Option<String>>(3)?
                {
                    entry["goalRecovery"] = serde_json::from_str(&recovery)?;
                }
                if let Some(source) = task_recovery
                    .as_ref()
                    .and_then(crate::tasks::committed_goal_cycle_source)
                {
                    entry["taskGoalOutcome"] = source.clone();
                    entry["taskGoalOutcomeDeferred"] = json!(!row.get::<bool>(4)?);
                }
                if row.get::<bool>(4)?
                    && let Some(marker) = task_recovery
                    && !truthy(marker.get("settled"))
                {
                    entry["taskGoalRecovery"] = marker;
                }
                if !workers.is_empty() {
                    entry["additionalWorkerIds"] = Value::from_serialize(&workers);
                }
                if context.is_none() {
                    entry["recoveryOnly"] = json!(true);
                }
                result.push(entry);
            } else {
                self.acknowledge_notification(&chat, row.get::<i32>(1)? as f64)
                    .await?;
            }
        }
        Ok(result)
    }
    pub async fn acknowledge_notification(&self, chat: &str, revision: f64) -> Result<()> {
        let revision = crate::wire::coercion::string(&Value::Number(revision))
            .unwrap()
            .lossy()
            .into_owned();
        self.database.query("UPDATE managed_queue_states SET notified_revision=GREATEST(notified_revision,$1::text::integer),notification_due_at=$2 WHERE chat_id=$3 AND revision >= $1::text::integer",&[&revision,&crate::auth::now(),&chat]).await?;
        Ok(())
    }
    pub async fn confirm_goal_recovery(
        &self,
        owner: &str,
        chat: &str,
        receipt: &Value,
    ) -> Result<()> {
        let (owner, chat, receipt) = (owner.to_owned(), chat.to_owned(), receipt.clone());
        self.database
            .transaction(|tx| {
                Box::pin(async move {
                    authority::lock(tx, &owner, &chat).await?;
                    super::super::goal_recovery::confirm_receipt(tx, &owner, &chat, &receipt).await
                })
            })
            .await
    }
    pub async fn goal_claim_recovery(&self, owner: &str, chat: &str) -> Result<Option<Value>> {
        let (owner, chat) = (owner.to_owned(), chat.to_owned());
        self.database
            .transaction(|tx| {
                Box::pin(async move {
                    authority::lock(tx, &owner, &chat).await?;
                    super::super::goal_claim_recovery::read(tx, &owner, &chat).await
                })
            })
            .await
    }
    pub async fn confirm_goal_claim_recovery(
        &self,
        owner: &str,
        chat: &str,
        receipt: &Value,
    ) -> Result<()> {
        let (owner, chat, receipt) = (owner.to_owned(), chat.to_owned(), receipt.clone());
        self.database
            .transaction(|tx| {
                Box::pin(async move {
                    authority::lock(tx, &owner, &chat).await?;
                    super::super::goal_claim_recovery::confirm(tx, &owner, &chat, &receipt).await
                })
            })
            .await
    }
    pub async fn defer_notification(&self, chat: &str) -> Result<()> {
        self.database
            .query(
                "UPDATE managed_queue_states SET notification_due_at=$1 WHERE chat_id=$2",
                &[
                    &(crate::auth::now() + chrono::Duration::milliseconds(5000)),
                    &chat,
                ],
            )
            .await?;
        Ok(())
    }
}
