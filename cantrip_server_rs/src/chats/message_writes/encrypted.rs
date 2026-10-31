use super::*;
use crate::database::Transaction;
async fn append(
    tx: &Transaction<'_>,
    owner: &str,
    chat: &str,
    input: &Value,
    attribution: Option<&Value>,
) -> Result<Option<Value>> {
    let input = crate::settings::parse_response("chatMessageOpaqueContentSchema", Some(input))?;
    let executor = Executor::Transaction(tx);
    if let Some(saved) = canonical::committed(executor, chat, &input).await? {
        return Ok(Some(saved));
    }
    let rows=checked(tx.query("SELECT to_jsonb(c)::text FROM chats c WHERE id=$1 AND owner_id=$2 AND archived_at IS NULL LIMIT 1",&[&chat,&owner]).await,&[json!(chat),json!(owner)])?;
    let Some(current) = rows.first().map(catalog::raw).transpose()? else {
        return Ok(None);
    };
    if current["experience"] != "agent" {
        return Ok(None);
    }
    if current["active_worktree_id"].is_null() == current["active_scratch_root_id"].is_null() {
        anyhow::bail!("Chat has an invalid execution root.")
    }
    let active = lane(executor, chat, &current, attribution).await?;
    if attribution.is_some() && active.is_none() {
        return Ok(None);
    }
    if let Some(saved) = raw_key(executor, chat, &text(&input["idempotencyKey"])?).await? {
        if saved["id"] != input["id"]
            || saved["role"] != input["classification"]["role"]
            || saved["mode"] != input["classification"]["mode"]
            || saved["reasoning_effort"] != input["reasoningEffort"]
            || saved["attachment_ids"].stringify()
                != input["classification"]["attachmentIds"].stringify()
            || saved["protected_content"].stringify() != input["protectedContent"].stringify()
        {
            anyhow::bail!("Encrypted chat message idempotency metadata is inconsistent.")
        }
        return messages::opaque(&saved).map(Some);
    }
    let worktree = attribution
        .map(|a| nullish(a.get("worktreeId"), &current["active_worktree_id"]))
        .unwrap_or(&current["active_worktree_id"]);
    let scratch = attribution
        .map(|a| a["scratchRootId"].clone())
        .unwrap_or_else(|| current["active_scratch_root_id"].clone());
    let mut fields = protected_fields(&input, false);
    fields.extend([
        ("id", input["id"].clone()),
        ("chat_id", json!(chat)),
        ("worktree_id", worktree.clone()),
        ("scratch_root_id", scratch.clone()),
        ("execution_lane_id", json!(active)),
        ("content", Value::Null),
        ("task_protected_content", Value::Null),
        ("idempotency_key", input["idempotencyKey"].clone()),
    ]);
    let rows = insert(executor, fields).await?;
    touch(executor, chat).await?;
    messages::opaque(&required(&rows, "appending an encrypted chat message")?).map(Some)
}
async fn upsert(
    tx: &Transaction<'_>,
    owner: &str,
    chat: &str,
    input: &Value,
    attribution: Option<&Value>,
) -> Result<Option<Value>> {
    let input = crate::settings::parse_response("chatMessageOpaqueContentSchema", Some(input))?;
    let executor = Executor::Transaction(tx);
    if let Some(saved) = canonical::committed(executor, chat, &input).await? {
        return Ok(Some(saved));
    }
    let Some(saved) = owned_key(
        executor,
        owner,
        chat,
        &text(&input["idempotencyKey"])?,
        MessageKind::Encrypted,
    )
    .await?
    else {
        return append(tx, owner, chat, &input, attribution).await;
    };
    if saved["id"] != input["id"] {
        anyhow::bail!("Encrypted chat message update targets another row.")
    }
    let rows = update(
        executor,
        &text(&input["id"])?,
        protected_fields(&input, false),
    )
    .await?;
    touch(executor, chat).await?;
    messages::opaque(&required(&rows, "updating an encrypted chat message")?).map(Some)
}
impl Repository {
    async fn write_encrypted(
        &self,
        owner: &str,
        chat: &str,
        input: &Value,
        attribution: Option<&Value>,
        is_update: bool,
    ) -> Result<Option<Value>> {
        let (owner, chat, input, attribution) = (
            owner.to_owned(),
            chat.to_owned(),
            input.clone(),
            attribution.cloned(),
        );
        self.database.transaction(|tx|Box::pin(async move{
            checked(tx.query("WITH locked_project AS MATERIALIZED(SELECT p.id FROM projects p INNER JOIN chats c ON c.project_id=p.id WHERE p.owner_id=$1 AND c.id=$2 FOR UPDATE OF p) SELECT c.id FROM locked_project p INNER JOIN chats c ON c.project_id=p.id WHERE c.id=$2 FOR UPDATE OF c",&[&owner,&chat]).await,&[json!(owner),json!(chat)])?;
            let chats=checked(tx.query("SELECT id FROM chats WHERE id=$1 AND owner_id=$2 AND experience='agent' FOR UPDATE",&[&chat,&owner]).await,&[json!(chat),json!(owner)])?;
            if chats.is_empty(){return Ok(None)}
            if is_update{upsert(tx,&owner,&chat,&input,attribution.as_ref()).await}else{append(tx,&owner,&chat,&input,attribution.as_ref()).await}
        })).await
    }
    pub async fn append_encrypted_message(
        &self,
        owner: &str,
        chat: &str,
        input: &Value,
        attribution: Option<&Value>,
    ) -> Result<Option<Value>> {
        self.write_encrypted(owner, chat, input, attribution, false)
            .await
    }
    pub async fn upsert_encrypted_message(
        &self,
        owner: &str,
        chat: &str,
        input: &Value,
        attribution: Option<&Value>,
    ) -> Result<Option<Value>> {
        self.write_encrypted(owner, chat, input, attribution, true)
            .await
    }
}
