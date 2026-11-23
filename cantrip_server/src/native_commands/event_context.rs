//! The event writer captures its receipt before acquiring the canonical Chat lock.
use super::{
    Repository,
    admit::{raw_one, reject, text},
    context,
    transaction::TransactionRepository,
};
use crate::{
    database::{Executor, TransactionFuture},
    wire::{Value, coercion::truthy},
};
use anyhow::Result;
use futures::FutureExt;
impl Repository {
    pub async fn with_event_context<T, F>(
        &self,
        owner: &str,
        worker: &Value,
        operation: &str,
        generation: &str,
        apply: F,
    ) -> Result<T>
    where
        T: Send,
        F: for<'a, 'db> FnOnce(Value, TransactionRepository<'a, 'db>) -> TransactionFuture<'a, T>
            + Send
            + 'static,
    {
        let (owner, worker, operation, generation) = (
            owner.to_owned(),
            worker.clone(),
            operation.to_owned(),
            generation.to_owned(),
        );
        self.database.transaction(|tx|Box::pin(async move{
            let row=context::read(Executor::Transaction(tx),&owner,&text(&worker)?,&operation,&generation).boxed().await?;
            let chat=text(&row["chat_id"])?;
            context::lock_chat(tx,&owner,&chat).await?;
            let activation=raw_one(tx,"SELECT to_jsonb(a)::text FROM native_command_activations a WHERE chat_id=$1",&[&chat]).await?.unwrap_or(Value::Null);
            let context=context::execution(tx,&owner,&chat).boxed().await?;
            if !context::same_placement(context.as_ref(),&worker,row.get("identity"))?
                || !context::same_runtime_route(context.as_ref(),row.get("identity"))?
                || row["kind"]!="start"
                || !matches!(row["status"].as_str(),Some("dispatched"|"applied"|"uncertain"))
                || !truthy(activation.get("active"))
                || activation.get("generation")!=row.get("activation_generation")
                || activation.get("execution_lane_id")!=context.as_ref().and_then(|c|c.get("executionLaneId"))
            {return reject("stale-operation-event")}
            apply(context.unwrap(),TransactionRepository::new(tx)).await
        })).await
    }
}
