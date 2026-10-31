//! Owner-authorized archive reads require neither a worker nor a live binding.
use super::{Repository, catalog, message_writes::HistoryError};
use crate::wire::{Value, value::json};
use anyhow::{Context, Result};
impl Repository {
    pub async fn read_native_history_turns(
        &self,
        owner: &str,
        chat: &str,
        input: &Value,
    ) -> Result<Value> {
        let input =
            crate::settings::parse_response("nativeHistoryTurnReadRequestSchema", Some(input))?;
        let (owner, chat) = (owner.to_owned(), chat.to_owned());
        self.database.transaction(|tx|Box::pin(async move{
            let rows=tx.query("SELECT id FROM chats WHERE id=$1 AND owner_id=$2",&[&chat,&owner]).await?;
            if rows.is_empty(){return Err(HistoryError::new("chat-not-found",404).into())}
            let requested=input["turns"].as_array().context("Native history turn identities")?;
            if requested.is_empty(){return Ok(json!({"chatId":chat,"turns":Vec::<Value>::new()}))}
            let mut parameters=vec![owner,chat.clone()];let mut clauses=Vec::new();
            for turn in requested{
                let thread=turn["threadId"].as_js_string().context("Native history thread")?.lossy().into_owned();
                let turn=turn["turnId"].as_js_string().context("Native history turn")?.lossy().into_owned();
                parameters.push(thread);let thread_index=parameters.len();parameters.push(turn);let turn_index=parameters.len();
                clauses.push(format!("(b.thread_id=${thread_index} AND t.turn_id=${turn_index})"));
            }
            let refs=parameters.iter().map(|p|p as &(dyn postgres_types::ToSql+Sync)).collect::<Vec<_>>();
            let rows=tx.query(&format!("SELECT jsonb_build_object('binding_id',b.id,'worker_id',b.worker_id,'thread_id',b.thread_id,'turn',to_jsonb(t))::text FROM native_history_turns t INNER JOIN native_history_bindings b ON b.id=t.binding_id WHERE b.owner_id=$1 AND b.chat_id=$2 AND({}) ORDER BY b.id ASC,t.turn_id ASC",clauses.join(" OR ")),&refs).await?;
            let mut turns=Vec::new();
            for row in &rows{
                let raw=catalog::raw(row)?;let t=&raw["turn"];
                let mut turn=json!({"threadId":raw["thread_id"],"turnId":t["turn_id"],"revision":t["revision"],"ordinal":t["ordinal"],"status":t["status"],"startedAtMs":t["started_at_ms"],"completedAtMs":t["completed_at_ms"],"metadata":t["metadata"]});
                for (target,column) in [("usage","usage"),("modelAttribution","model_attribution")]{if !t[column].is_null(){turn[target]=t[column].clone();}}
                turns.push(json!({"bindingId":raw["binding_id"],"workerId":raw["worker_id"],"turn":turn}));
            }
            crate::settings::parse_response("nativeHistoryTurnReadResponseSchema",Some(&json!({"chatId":chat,"turns":turns})))
        })).await
    }
}
