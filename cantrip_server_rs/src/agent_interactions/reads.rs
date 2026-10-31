use super::*;
impl Repository<'_, '_> {
    pub async fn list(&self, owner: &str, query: &Value) -> Result<Vec<Value>> {
        self.expire(None).await?;
        let chat = truthy(query.get("chatId"))
            .then(|| text(&query["chatId"]))
            .transpose()?;
        let status = truthy(query.get("status"))
            .then(|| text(&query["status"]))
            .transpose()?;
        // HTTP parses/coerces the query. Repository collaborators receive the
        // same already-parsed limit, without introducing a second validation.
        let limit = query["limit"].as_f64().context("Interaction query limit")? as i64;
        self.rows("SELECT to_jsonb(r)::text FROM agent_interaction_requests r WHERE owner_id=$1 AND ($2::text IS NULL OR chat_id=$2) AND ($3::text IS NULL OR status=$3) ORDER BY created_at DESC LIMIT $4", &[&owner,&chat,&status,&limit]).await?.iter().map(map).collect()
    }
    pub async fn get(&self, owner: &str, id: &str) -> Result<Option<Value>> {
        self.expire(None).await?;
        self.rows("SELECT to_jsonb(r)::text FROM agent_interaction_requests r WHERE id=$1 AND owner_id=$2 LIMIT 1", &[&id,&owner]).await?.first().map(map).transpose()
    }
    pub async fn get_by_key(&self, owner: &str, key: &str) -> Result<Option<Value>> {
        self.expire(None).await?;
        self.rows("SELECT to_jsonb(r)::text FROM agent_interaction_requests r WHERE request_key=$1 AND owner_id=$2 LIMIT 1", &[&key,&owner]).await?.first().map(map).transpose()
    }
    pub(super) async fn restore(&self, chat: &str) -> Result<()> {
        if !self.executor.query("SELECT id FROM agent_interaction_requests WHERE chat_id=$1 AND interaction_owner='codex' AND status='pending' LIMIT 1", &[&chat]).await?.is_empty() { return Ok(()); }
        self.executor.query("UPDATE chats SET status='running',updated_at=$1 WHERE id=$2 AND status='waiting-for-approval'", &[&crate::auth::now(),&chat]).await?;
        Ok(())
    }
}
