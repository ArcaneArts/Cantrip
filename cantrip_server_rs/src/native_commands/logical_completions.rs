//! Delivery state. Creation belongs to the logical input's completion transaction.
use super::{Repository, admit::text, receipt};
use crate::wire::{Value, coercion, value::json};
use anyhow::Result;

fn completion(row: &crate::database::Row) -> Result<Value> {
    let row: Value = serde_json::from_str(&row.get::<String>(0)?)?;
    Ok(
        json!({"attempts":row["attempts"],"rootOperationId":row["root_operation_id"],"rootOperationGeneration":row["root_operation_generation"],"ownerId":row["owner_id"],"workerId":row["worker_id"],"chatId":row["chat_id"],"createdAt":receipt::iso(&row["created_at"])?}),
    )
}
impl Repository {
    pub async fn list_pending_logical_completions(&self, limit: Option<f64>) -> Result<Vec<Value>> {
        // Drizzle omits negative/NaN limits; PostgreSQL itself rejects positive
        // fractions and infinity. Do not turn these into a different API guard.
        let limit = limit.unwrap_or(100.0);
        let limit = (limit >= 0.0).then(|| {
            coercion::string(&Value::Number(limit))
                .unwrap()
                .lossy()
                .into_owned()
        });
        self.database.query("SELECT to_jsonb(c)::text FROM native_logical_completions c WHERE next_attempt_at <= $1 ORDER BY next_attempt_at ASC,root_operation_id ASC LIMIT $2::text::bigint",&[&crate::auth::now(),&limit]).await?.iter().map(completion).collect()
    }
    pub async fn get_logical_completion(
        &self,
        owner: &str,
        worker: &str,
        chat: &str,
        root: &str,
        generation: &str,
    ) -> Result<Option<Value>> {
        self.database.query("SELECT to_jsonb(c)::text FROM native_logical_completions c WHERE owner_id=$1 AND worker_id=$2 AND chat_id=$3 AND root_operation_id=$4 AND root_operation_generation=$5",&[&owner,&worker,&chat,&root,&generation]).await?.first().map(completion).transpose()
    }
    pub async fn acknowledge_logical_completion(
        &self,
        owner: &str,
        worker: &str,
        chat: &str,
        root: &str,
        generation: &str,
    ) -> Result<bool> {
        Ok(self.database.query("DELETE FROM native_logical_completions WHERE owner_id=$1 AND worker_id=$2 AND chat_id=$3 AND root_operation_id=$4 AND root_operation_generation=$5 RETURNING root_operation_id",&[&owner,&worker,&chat,&root,&generation]).await?.len()==1)
    }
    pub async fn defer_logical_completion(
        &self,
        owner: &str,
        worker: &str,
        chat: &str,
        root: &str,
        generation: &str,
        next_attempt_at: &Value,
    ) -> Result<bool> {
        let due = text(&receipt::iso(next_attempt_at)?)?;
        Ok(self.database.query("UPDATE native_logical_completions SET next_attempt_at=$6::text::timestamptz,attempts=attempts+1 WHERE owner_id=$1 AND worker_id=$2 AND chat_id=$3 AND root_operation_id=$4 AND root_operation_generation=$5 RETURNING root_operation_id",&[&owner,&worker,&chat,&root,&generation,&due]).await?.len()==1)
    }
}
