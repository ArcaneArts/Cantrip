use super::*;
use chrono::{DateTime, Utc};
use futures::FutureExt;
use std::collections::HashSet;

impl Repository<'_, '_> {
    pub async fn expire(&self, now: Option<DateTime<Utc>>) -> Result<Vec<Value>> {
        let now = now.unwrap_or_else(crate::auth::now);
        // Expiry is intentionally global, even when an owner-scoped read calls it.
        let rows=self.rows("UPDATE agent_interaction_requests SET status='expired',resolved_at=$1,updated_at=$1 WHERE status='pending' AND expires_at<=$1 RETURNING to_jsonb(agent_interaction_requests)::text", &[&now]).await?;
        let mut chats = HashSet::new();
        for row in &rows {
            if row["interaction_owner"] == "codex"
                && truthy(row.get("chat_id"))
                && chats.insert(text(&row["chat_id"])?)
            {
                self.restore(&text(&row["chat_id"])?).await?;
            }
        }
        rows.iter().map(map).collect()
    }
    pub async fn interrupt(&self, chat: &str, lane: Option<&str>) -> Result<Vec<Value>> {
        let now = crate::auth::now();
        self.rows("UPDATE agent_interaction_requests SET status='interrupted',resolved_at=$1,updated_at=$1 WHERE chat_id=$2 AND ($3::text IS NULL OR execution_lane_id=$3) AND status='pending' RETURNING to_jsonb(agent_interaction_requests)::text", &[&now,&chat,&lane]).await?.iter().map(map).collect()
    }
    pub async fn terminalize(
        &self,
        key: &str,
        chat: &str,
        worker: &str,
        status: &str,
        resolution: Option<&Value>,
    ) -> Result<Option<Value>> {
        if let Some(resolution) = resolution.filter(|v| truthy(Some(v))) {
            let rows=self.rows("SELECT to_jsonb(r)::text FROM agent_interaction_requests r WHERE request_key=$1 AND chat_id=$2 AND worker_id=$3", &[&key,&chat,&worker]).await?;
            let Some(row) = rows.first() else {
                return Ok(None);
            };
            return self
                .resolve(
                    &text(&row["owner_id"])?,
                    &text(&row["id"])?,
                    resolution,
                    resolution.get("protectedResponse").is_some(),
                    true,
                )
                .boxed()
                .await;
        }
        let now = crate::auth::now();
        let rows=self.rows("UPDATE agent_interaction_requests SET status=$1,resolved_at=$2,updated_at=$2 WHERE request_key=$3 AND chat_id=$4 AND worker_id=$5 AND status='pending' RETURNING to_jsonb(agent_interaction_requests)::text", &[&status,&now,&key,&chat,&worker]).await?;
        let Some(row) = rows.first() else {
            return Ok(None);
        };
        if row["interaction_owner"] == "codex" {
            self.restore(chat).await?;
        }
        map(row).map(Some)
    }
}
