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
    if super::super::goal_recovery::read(tx, chat).await?.is_some() {
        return reject("canonical-goal-recovery-pending");
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
    create_claim(tx, &claim, chat, &row).await
}

async fn create_claim(tx: &Transaction<'_>, id: &str, chat: &str, prompt: &Value) -> Result<Value> {
    let prompt_id = text(&prompt["id"])?;
    let row = raw_one(
        tx,
        "INSERT INTO managed_queue_claims(id,chat_id,prompt_id,prompt_revision)
         VALUES($1,$2,$3,$4::text::integer) RETURNING to_jsonb(managed_queue_claims)::text",
        &[&id, &chat, &prompt_id, &prompt["revision"].stringify()],
    )
    .await?
    .context("Queue claim insert returned no row")?;
    retain_input(tx, id, prompt).await?;
    tx.query(
        "UPDATE queued_prompts SET state='claimed' WHERE id=$1",
        &[&prompt_id],
    )
    .await?;
    bump(tx, chat).await?;
    claim_value(&row)
}

async fn claim_next(
    tx: &Transaction<'_>,
    owner: &str,
    chat: &str,
    steer_activation: Option<&str>,
) -> Result<Option<Value>> {
    let current = authority::lock(tx, owner, chat).await?;
    if truthy(current.get("automation_paused")) || truthy(current.get("managed_autonomy_stopped")) {
        return Ok(None);
    }
    let council = current["context_kind"] == "council";
    let active = matches!(
        current["status"].as_str(),
        Some("running" | "waiting-for-approval")
    );
    if (steer_activation.is_some() && !active) || (council && active && steer_activation.is_none())
    {
        return Ok(None);
    }
    let explicit_steer_only = steer_activation.is_some() && !council;
    if tx
        .query(
            &format!("SELECT c.id FROM chats c WHERE c.id=$1 AND {NO_PERMISSION} AND {NO_HANDOFF}
              AND NOT EXISTS (SELECT 1 FROM managed_queue_states s WHERE s.chat_id=c.id AND s.goal_recovery IS NOT NULL)
              AND ($2::text IS NULL OR EXISTS (
                  SELECT 1 FROM native_command_activations a WHERE a.chat_id=c.id
                  AND a.active=true AND a.generation=$2 AND a.native_turn_id IS NOT NULL
              ))"),
            &[&chat, &steer_activation],
        )
        .await?
        .is_empty()
    {
        return Ok(None);
    }
    if let Some(existing) = raw_one(tx,
        "SELECT (to_jsonb(c) || jsonb_build_object('mode',p.mode,'method',p.opaque_content->'executionMethod',
            'explicitSteer',EXISTS(SELECT 1 FROM council_project_deliveries d WHERE d.queued_prompt_id=p.id AND d.target_chat_id=c.chat_id AND d.steer_requested)))::text
         FROM managed_queue_claims c JOIN queued_prompts p ON p.id=c.prompt_id
         WHERE c.chat_id=$1 AND c.status IN ('claimed','accepted','dispatched','uncertain')
         ORDER BY c.created_at ASC LIMIT 1", &[&chat],
    ).await? {
        return if existing["status"] == "claimed"
            && (!explicit_steer_only || existing["explicitSteer"] == true)
            && (steer_activation.is_none() || steerable(&existing["mode"], &existing["method"]))
        {
            claim_value(&existing).map(Some)
        } else {
            Ok(None)
        };
    }
    let row=raw_one(tx,"SELECT to_jsonb(p)::text FROM queued_prompts p WHERE chat_id=$1 AND state='pending' AND frozen=false AND NOT EXISTS(SELECT 1 FROM managed_queue_claims c WHERE c.prompt_id=p.id AND c.prompt_revision=p.revision AND c.status='rejected')
        AND (NOT $2 OR EXISTS(SELECT 1 FROM council_project_deliveries d WHERE d.queued_prompt_id=p.id AND d.target_chat_id=p.chat_id AND d.steer_requested))
        ORDER BY position ASC,created_at ASC LIMIT 1",&[&chat,&explicit_steer_only]).await?;
    let Some(row) = row else {
        return Ok(None);
    };
    if let Some(activation) = steer_activation {
        if !steerable(&row["mode"], &row["opaque_content"]["executionMethod"]) {
            return Ok(None);
        }
        if !tx
            .query(
                "SELECT n.operation_id FROM managed_queue_claims q JOIN native_commands n
             ON n.operation_id=q.operation_id AND n.operation_generation=q.operation_generation
             WHERE q.chat_id=$1 AND q.prompt_id=$2 AND q.prompt_revision=$3::text::integer
             AND q.status='deferred' AND n.activation_generation=$4
             AND n.rejection_code='native-steer-target-ended' LIMIT 1",
                &[
                    &chat,
                    &text(&row["id"])?,
                    &row["revision"].stringify(),
                    &activation,
                ],
            )
            .await?
            .is_empty()
        {
            return Ok(None);
        }
    }
    create_claim(tx, &uuid::Uuid::new_v4().to_string(), chat, &row)
        .await
        .map(Some)
}

fn steerable(mode: &Value, method: &Value) -> bool {
    mode == "default" && (method.is_null() || method == "turn/start")
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
            .transaction(|tx| Box::pin(async move { claim_next(tx, &owner, &chat, None).await }))
            .await
    }
    pub async fn claim_next_steer(
        &self,
        owner: &str,
        chat: &str,
        activation: &str,
    ) -> Result<Option<Value>> {
        let (owner, chat, activation) = (owner.to_owned(), chat.to_owned(), activation.to_owned());
        self.database
            .transaction(|tx| {
                Box::pin(async move { claim_next(tx, &owner, &chat, Some(&activation)).await })
            })
            .await
    }
    pub async fn claim(&self, owner: &str, chat: &str, id: &str) -> Result<Option<Value>> {
        let (owner, chat, id) = (owner.to_owned(), chat.to_owned(), id.to_owned());
        self.database.transaction(|tx|Box::pin(async move{authority::lock(tx,&owner,&chat).await?;raw_one(tx,"SELECT to_jsonb(c)::text FROM managed_queue_claims c WHERE id=$1 AND chat_id=$2",&[&id,&chat]).await?.map(|r|claim_value(&r)).transpose()})).await
    }
    pub async fn release_unadmitted(&self, owner: &str, chat: &str, id: &str) -> Result<bool> {
        self.release_unadmitted_as(owner, chat, id, false).await
    }
    pub async fn defer_unadmitted(&self, owner: &str, chat: &str, id: &str) -> Result<bool> {
        self.release_unadmitted_as(owner, chat, id, true).await
    }
    async fn release_unadmitted_as(
        &self,
        owner: &str,
        chat: &str,
        id: &str,
        retryable: bool,
    ) -> Result<bool> {
        let (owner, chat, id) = (owner.to_owned(), chat.to_owned(), id.to_owned());
        self.database.transaction(|tx|Box::pin(async move{
  authority::lock(tx,&owner,&chat).await?;
  let row=raw_one(tx,"SELECT to_jsonb(c)::text FROM managed_queue_claims c WHERE id=$1 AND chat_id=$2",&[&id,&chat]).await?;
  let Some(row)=row.filter(|r|r["status"]=="claimed"&&!truthy(r.get("operation_id")))else{return Ok(false);};
  tx.query("UPDATE managed_queue_claims SET status=$2 WHERE id=$1",&[&id,&if retryable {"deferred"}else{"rejected"}]).await?;tx.query("UPDATE queued_prompts SET state='pending' WHERE id=$1",&[&text(&row["prompt_id"])?]).await?;bump(tx,&chat).await?;Ok(true)
 })).await
    }
}
