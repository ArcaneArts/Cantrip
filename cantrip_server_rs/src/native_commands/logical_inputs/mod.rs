//! One accepted GUI input may own several native executions and one durable closure.
mod continuation;
mod outcomes;
use super::{Repository, admit::text, context};
use crate::{
    database::{Executor, Transaction},
    wire::Value,
};
use anyhow::Result;

async fn activation(tx: &Transaction<'_>, chat: &str) -> Result<Value> {
    Ok(super::admit::raw_one(
        tx,
        "SELECT to_jsonb(a)::text FROM native_command_activations a WHERE chat_id=$1",
        &[&chat],
    )
    .await?
    .unwrap_or(Value::Null))
}
impl Repository {
    pub async fn continue_execution(&self, owner: &str, input: &Value) -> Result<Value> {
        let (owner, input) = (owner.to_owned(), input.clone());
        self.database
            .transaction(|tx| Box::pin(async move { continuation::run(tx, &owner, &input).await }))
            .await
    }
    pub async fn logical_gui_outcome_root(
        &self,
        owner: &str,
        worker: &str,
        input: &Value,
    ) -> Result<Option<Value>> {
        let (owner, worker, input) = (owner.to_owned(), worker.to_owned(), input.clone());
        self.database
            .transaction(|tx| {
                Box::pin(async move { outcomes::root(tx, &owner, &worker, &input).await })
            })
            .await
    }
    pub async fn finish_logical_gui(
        &self,
        owner: &str,
        worker: &str,
        root: &str,
        generation: &str,
        status: &str,
    ) -> Result<bool> {
        let (owner, worker, root, generation, status) = (
            owner.to_owned(),
            worker.to_owned(),
            root.to_owned(),
            generation.to_owned(),
            status.to_owned(),
        );
        self.database
            .transaction(|tx| {
                Box::pin(async move {
                    outcomes::finish(tx, &owner, &worker, &root, &generation, &status).await
                })
            })
            .await
    }
    pub async fn has_deferred_logical_gui(
        &self,
        owner: &str,
        worker: &str,
        operation: &str,
        generation: &str,
    ) -> Result<bool> {
        let (owner, worker, operation, generation) = (
            owner.to_owned(),
            worker.to_owned(),
            operation.to_owned(),
            generation.to_owned(),
        );
        self.database.transaction(|tx|Box::pin(async move {
            let root=context::read(Executor::Transaction(tx),&owner,&worker,&operation,&generation).await?;
            if root["origin"]!="gui" || root.get("logical_operation_id")!=root.get("operation_id") {return Ok(false);}
            Ok(!tx.query("SELECT operation_id FROM native_commands WHERE owner_id=$1 AND worker_id=$2 AND logical_operation_id=$3 AND status='rejected' AND rejection_code='native-settings-pending' AND terminal_evidence->>'kind'='deferred' AND execution_completed_at IS NOT NULL LIMIT 1",&[&owner,&worker,&text(&root["operation_id"])?]).await?.is_empty())
        })).await
    }
}
