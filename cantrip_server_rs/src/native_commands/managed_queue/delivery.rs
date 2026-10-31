use super::*;
use crate::database::Executor;
impl QueueRepository {
    pub async fn pending_dispatches(&self) -> Result<Vec<Value>> {
        self.database.query(&format!("SELECT DISTINCT c.owner_id,c.id FROM queued_prompts p INNER JOIN chats c ON c.id=p.chat_id WHERE c.experience='agent' AND c.context_kind='project' AND c.automation_paused=false AND c.managed_autonomy_stopped=false AND {NO_PERMISSION} AND {NO_HANDOFF} AND ((p.state='pending' AND p.frozen=false AND NOT EXISTS(SELECT 1 FROM managed_queue_claims q WHERE q.prompt_id=p.id AND q.prompt_revision=p.revision AND q.status='rejected')) OR (p.state='claimed' AND EXISTS(SELECT 1 FROM managed_queue_claims q WHERE q.prompt_id=p.id AND q.status='claimed' AND q.operation_id IS NULL)))"),&[]).await?.iter().map(|r|Ok(json!({"ownerId":r.get::<String>(0)?,"chatId":r.get::<String>(1)?}))).collect()
    }
    pub async fn pending_notifications(&self, limit: Option<f64>) -> Result<Vec<Value>> {
        let limit = limit.unwrap_or(64.0);
        let limit = (limit >= 0.0).then(|| {
            crate::wire::coercion::string(&Value::Number(limit))
                .unwrap()
                .lossy()
                .into_owned()
        });
        let rows=self.database.query("SELECT s.chat_id,s.revision,c.owner_id FROM managed_queue_states s INNER JOIN chats c ON c.id=s.chat_id WHERE s.notified_revision<s.revision AND s.notification_due_at<=now() ORDER BY s.notification_due_at ASC LIMIT $1::text::bigint",&[&limit]).await?;
        let mut result = Vec::new();
        for row in rows {
            let chat = row.get::<String>(0)?;
            let owner = row.get::<String>(2)?;
            if let Some(context) = crate::chats::Repository::execution_context_with(
                Executor::Database(&self.database),
                &owner,
                &chat,
            )
            .await?
            {
                result.push(json!({"ownerId":owner,"workerId":context["workerId"],"chatId":chat,"revision":row.get::<i32>(1)?}));
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
