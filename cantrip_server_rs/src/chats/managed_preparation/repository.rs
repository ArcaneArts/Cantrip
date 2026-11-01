use crate::{
    database::{Database, Executor, Parameters},
    wire::{Value, value::json},
};
use anyhow::{Context, Result};
use std::sync::Arc;

#[derive(Clone)]
pub struct Repository {
    pub(super) database: Arc<Database>,
}
fn wire(raw: &str) -> Result<Value> {
    let row: Value = serde_json::from_str(raw)?;
    let at = chrono::DateTime::parse_from_rfc3339(
        row["updated_at"]
            .as_str()
            .context("Preparation timestamp")?,
    )?;
    crate::settings::parse_response(
        "managedChatPreparationSchema",
        Some(&json!({
            "chatId":row["chat_id"],"workerId":row["worker_id"],"terminalId":row["terminal_id"],
            "generation":row["generation"],"phase":row["phase"],"failedPhase":row["failed_phase"],
            "updatedAt":crate::auth::iso(at.with_timezone(&chrono::Utc))
        })),
    )
}
async fn one(
    executor: Executor<'_, '_>,
    sql: &str,
    params: Parameters<'_>,
) -> Result<Option<Value>> {
    executor
        .query(sql, params)
        .await?
        .first()
        .map(|row| wire(&row.get::<String>(0)?))
        .transpose()
}
impl Repository {
    pub fn new(database: Arc<Database>) -> Self {
        Self { database }
    }
    pub async fn get(&self, owner: &str, chat: &str) -> Result<Option<Value>> {
        one(Executor::Database(&self.database), "SELECT to_jsonb(p)::text FROM managed_chat_preparations p WHERE owner_id=$1 AND chat_id=$2", &[&owner,&chat]).await
    }
    pub async fn request(&self, owner: &str, chat: &str, worker: &str) -> Result<Option<Value>> {
        let (terminal, generation, at) = (
            uuid::Uuid::new_v4().to_string(),
            uuid::Uuid::new_v4().to_string(),
            crate::auth::now(),
        );
        self.database.query("INSERT INTO managed_chat_preparations(owner_id,chat_id,worker_id,terminal_id,generation) VALUES($1,$2,$3,$4,$5) ON CONFLICT(chat_id) DO UPDATE SET phase='pending',failed_phase=NULL,updated_at=$6 WHERE managed_chat_preparations.owner_id=$1", &[&owner,&chat,&worker,&terminal,&generation,&at]).await?;
        self.get(owner, chat).await
    }
    pub async fn claim(&self, owner: &str, chat: &str, worker: &str) -> Result<Option<Value>> {
        one(Executor::Database(&self.database), "UPDATE managed_chat_preparations p SET worker_id=$3,generation=$4,phase='thread',failed_phase=NULL,updated_at=$5 WHERE owner_id=$1 AND chat_id=$2 RETURNING to_jsonb(p)::text", &[&owner,&chat,&worker,&uuid::Uuid::new_v4().to_string(),&crate::auth::now()]).await
    }
    pub async fn update(
        &self,
        owner: &str,
        state: &Value,
        phase: &str,
        failed: Option<&str>,
        terminal: Option<&str>,
    ) -> Result<Option<Value>> {
        let (owner, state, phase, failed) = (
            owner.to_owned(),
            state.clone(),
            phase.to_owned(),
            failed.map(str::to_owned),
        );
        let terminal = terminal.map(str::to_owned).unwrap_or_else(|| {
            state["terminalId"]
                .as_str()
                .expect("Preparation terminal")
                .to_owned()
        });
        self.database.transaction(move |tx|Box::pin(async move {
            let row=one(Executor::Transaction(tx), "UPDATE managed_chat_preparations p SET phase=$1,failed_phase=$2,terminal_id=$3,updated_at=$4 WHERE owner_id=$5 AND chat_id=$6 AND generation=$7 AND ($1<>'ready' OR phase='console') RETURNING to_jsonb(p)::text", &[&phase,&failed,&terminal,&crate::auth::now(),&owner,&state["chatId"].as_str(),&state["generation"].as_str()]).await?;
            if row.is_some() && (phase=="ready" || (phase=="failed" && failed.as_deref()==Some("console"))) {
                let status=if phase=="ready"{"running"}else{"failed"};
                tx.query("UPDATE terminals SET status=$1,updated_at=$2 WHERE id=$3", &[&status,&crate::auth::now(),&terminal]).await?;
            }
            Ok(row)
        })).await
    }
    pub async fn console_exited(
        &self,
        owner: &str,
        worker: &str,
        terminal: &str,
        generation: &str,
    ) -> Result<Option<Value>> {
        let (owner, worker, terminal, generation) = (
            owner.to_owned(),
            worker.to_owned(),
            terminal.to_owned(),
            generation.to_owned(),
        );
        self.database.transaction(move |tx|Box::pin(async move {
            let row=one(Executor::Transaction(tx), "UPDATE managed_chat_preparations p SET phase='failed',failed_phase='console',updated_at=$1 WHERE owner_id=$2 AND worker_id=$3 AND terminal_id=$4 AND generation=$5 AND phase IN ('console','ready') RETURNING to_jsonb(p)::text", &[&crate::auth::now(),&owner,&worker,&terminal,&generation]).await?;
            if row.is_some() { tx.query("UPDATE terminals SET status='exited',updated_at=$1 WHERE id=$2", &[&crate::auth::now(),&terminal]).await?; }
            Ok(row)
        })).await
    }
    pub async fn for_worker(&self, owner: &str, worker: &str) -> Result<Vec<String>> {
        self.database.query("SELECT p.chat_id FROM managed_chat_preparations p INNER JOIN chats c ON c.id=p.chat_id WHERE p.owner_id=$1 AND p.worker_id=$2 AND c.archived_at IS NULL", &[&owner,&worker]).await?.iter().map(|r|r.get::<String>(0)).collect()
    }
}
