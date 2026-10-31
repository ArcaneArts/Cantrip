use super::*;
use anyhow::Context;
async fn claim_item(
    tx: &Transaction<'_>,
    owner: &str,
    chat: &str,
    prompt: &Value,
    revision: &Value,
    id: &Value,
) -> Result<Value> {
    authority::lock(tx, owner, chat).await?;
    let claim = text(id)?;
    if let Some(existing) = raw_one(
        tx,
        "SELECT to_jsonb(c)::text FROM managed_queue_claims c WHERE id=$1",
        &[&claim],
    )
    .await?
    {
        if existing["chat_id"] != json!(chat)
            || existing.get("prompt_id") != Some(prompt)
            || existing.get("prompt_revision") != Some(revision)
        {
            return reject("queue-claim-conflict");
        }
        return claim_value(&existing);
    }
    let row = raw_one(
        tx,
        "SELECT to_jsonb(p)::text FROM queued_prompts p WHERE id=$1 AND chat_id=$2",
        &[&text(prompt)?, &chat],
    )
    .await?;
    let Some(row) = row.filter(|r| r["state"] == "pending" && r.get("revision") == Some(revision))
    else {
        return reject("queue-item-revision-conflict");
    };
    let created=raw_one(tx,"INSERT INTO managed_queue_claims(id,chat_id,prompt_id,prompt_revision) VALUES($1,$2,$3,$4::text::integer) RETURNING to_jsonb(managed_queue_claims)::text",&[&claim,&chat,&text(prompt)?,&revision.stringify()]).await?.context("Queue claim insert returned no row")?;
    retain_input(tx, &claim, &row).await?;
    tx.query(
        "UPDATE queued_prompts SET state='claimed' WHERE id=$1",
        &[&text(prompt)?],
    )
    .await?;
    bump(tx, chat).await?;
    claim_value(&created)
}
async fn claim_next(tx: &Transaction<'_>, owner: &str, chat: &str) -> Result<Option<Value>> {
    let current = authority::lock(tx, owner, chat).await?;
    if truthy(current.get("automation_paused")) || truthy(current.get("managed_autonomy_stopped")) {
        return Ok(None);
    }
    if tx
        .query(
            &format!("SELECT c.id FROM chats c WHERE c.id=$1 AND {NO_PERMISSION} AND {NO_HANDOFF}"),
            &[&chat],
        )
        .await?
        .is_empty()
    {
        return Ok(None);
    }
    if let Some(existing)=raw_one(tx,"SELECT to_jsonb(c)::text FROM managed_queue_claims c WHERE chat_id=$1 AND status IN ('claimed','accepted','dispatched','uncertain') ORDER BY created_at ASC LIMIT 1",&[&chat]).await?{return if existing["status"]=="claimed"{claim_value(&existing).map(Some)}else{Ok(None)};}
    let row=raw_one(tx,"SELECT to_jsonb(p)::text FROM queued_prompts p WHERE chat_id=$1 AND state='pending' AND frozen=false AND NOT EXISTS(SELECT 1 FROM managed_queue_claims c WHERE c.prompt_id=p.id AND c.prompt_revision=p.revision AND c.status='rejected') ORDER BY position ASC,created_at ASC LIMIT 1",&[&chat]).await?;
    let Some(row) = row else {
        return Ok(None);
    };
    let id = uuid::Uuid::new_v4().to_string();
    let claim=raw_one(tx,"INSERT INTO managed_queue_claims(id,chat_id,prompt_id,prompt_revision) VALUES($1,$2,$3,$4::text::integer) RETURNING to_jsonb(managed_queue_claims)::text",&[&id,&chat,&text(&row["id"])?,&row["revision"].stringify()]).await?.context("Queue claim insert returned no row")?;
    retain_input(tx, &id, &row).await?;
    tx.query(
        "UPDATE queued_prompts SET state='claimed' WHERE id=$1",
        &[&text(&row["id"])?],
    )
    .await?;
    bump(tx, chat).await?;
    claim_value(&claim).map(Some)
}
impl QueueRepository {
    pub async fn claim_item(
        &self,
        owner: &str,
        chat: &str,
        prompt: &Value,
        revision: &Value,
        id: &Value,
    ) -> Result<Value> {
        let (owner, chat, prompt, revision, id) = (
            owner.to_owned(),
            chat.to_owned(),
            prompt.clone(),
            revision.clone(),
            id.clone(),
        );
        self.database
            .transaction(|tx| {
                Box::pin(
                    async move { claim_item(tx, &owner, &chat, &prompt, &revision, &id).await },
                )
            })
            .await
    }
    pub async fn claim_next(&self, owner: &str, chat: &str) -> Result<Option<Value>> {
        let (owner, chat) = (owner.to_owned(), chat.to_owned());
        self.database
            .transaction(|tx| Box::pin(async move { claim_next(tx, &owner, &chat).await }))
            .await
    }
    pub async fn claim(&self, owner: &str, chat: &str, id: &str) -> Result<Option<Value>> {
        let (owner, chat, id) = (owner.to_owned(), chat.to_owned(), id.to_owned());
        self.database.transaction(|tx|Box::pin(async move{authority::lock(tx,&owner,&chat).await?;raw_one(tx,"SELECT to_jsonb(c)::text FROM managed_queue_claims c WHERE id=$1 AND chat_id=$2",&[&id,&chat]).await?.map(|r|claim_value(&r)).transpose()})).await
    }
    pub async fn release_unadmitted(&self, owner: &str, chat: &str, id: &str) -> Result<bool> {
        let (owner, chat, id) = (owner.to_owned(), chat.to_owned(), id.to_owned());
        self.database.transaction(|tx|Box::pin(async move{
  authority::lock(tx,&owner,&chat).await?;
  let row=raw_one(tx,"SELECT to_jsonb(c)::text FROM managed_queue_claims c WHERE id=$1 AND chat_id=$2",&[&id,&chat]).await?;
  let Some(row)=row.filter(|r|r["status"]=="claimed"&&!truthy(r.get("operation_id")))else{return Ok(false);};
  tx.query("UPDATE managed_queue_claims SET status='rejected' WHERE id=$1",&[&id]).await?;tx.query("UPDATE queued_prompts SET state='pending' WHERE id=$1",&[&text(&row["prompt_id"])?]).await?;bump(tx,&chat).await?;Ok(true)
 })).await
    }
}
