use super::*;
pub(super) async fn snapshot(tx: &Transaction<'_>, owner: &str, chat: &str) -> Result<Value> {
    let state = raw_one(
        tx,
        "SELECT to_jsonb(s)::text FROM managed_queue_states s WHERE chat_id=$1",
        &[&chat],
    )
    .await?
    .unwrap_or(Value::Null);
    let current = raw_one(
        tx,
        "SELECT to_jsonb(c)::text FROM chats c WHERE id=$1",
        &[&chat],
    )
    .await?
    .unwrap_or(Value::Null);
    let items = TransactionRepository::new(tx)
        .encrypted_prompts(owner, chat)
        .await?;
    let rows=tx.query("SELECT to_jsonb(c)::text FROM managed_queue_claims c WHERE chat_id=$1 AND (status IN ('claimed','accepted','dispatched','uncertain') OR (status='rejected' AND EXISTS(SELECT 1 FROM queued_prompts p WHERE p.id=c.prompt_id AND p.revision=c.prompt_revision AND p.state='pending'))) ORDER BY created_at ASC",&[&chat]).await?;
    let claims = rows
        .iter()
        .map(|r| claim_value(&serde_json::from_str(&r.get::<String>(0)?)?))
        .collect::<Result<Vec<_>>>()?;
    let rows=tx.query("SELECT jsonb_build_object('record',to_jsonb(i),'prompt',to_jsonb(p))::text FROM managed_queue_imports i INNER JOIN queued_prompts p ON p.id=i.prompt_id WHERE i.chat_id=$1 AND i.status IN ('pending','conflict','uncertain') ORDER BY i.created_at ASC",&[&chat]).await?;
    let imports=rows.iter().map(|r|{let r:Value=serde_json::from_str(&r.get::<String>(0)?)?;Ok(json!({"importId":r["record"]["id"],"nativeItemId":r["record"]["native_item_id"],"status":r["record"]["status"],"prompt":super::super::queued_prompt::encrypted(&r["prompt"])?}))}).collect::<Result<Vec<_>>>()?;
    parse(
        "managedQueueSnapshotSchema",
        &json!({"revision":state.get("revision").cloned().unwrap_or(json!(0)),"paused":truthy(current.get("automation_paused"))||truthy(current.get("managed_autonomy_stopped")),"items":items,"claims":claims,"pendingImports":imports}),
    )
}
impl QueueRepository {
    pub async fn snapshot(&self, owner: &str, chat: &str) -> Result<Value> {
        let (owner, chat) = (owner.to_owned(), chat.to_owned());
        self.database
            .transaction(|tx| {
                Box::pin(async move {
                    authority::lock(tx, &owner, &chat).await?;
                    snapshot(tx, &owner, &chat).await
                })
            })
            .await
    }
    pub async fn read(&self, owner: &str, worker: &Value, session: &Value) -> Result<Value> {
        let (owner, worker, session) = (owner.to_owned(), worker.clone(), session.clone());
        self.database
            .transaction(|tx| {
                Box::pin(async move {
                    authority::authorize(tx, &owner, &worker, &session).await?;
                    snapshot(tx, &owner, &text(&session["chatId"])?).await
                })
            })
            .await
    }
}
