use super::{CommandError, receipt};
use crate::{
    database::{Executor, Row, Transaction},
    wire::{self, Value, coercion::truthy},
};
use anyhow::Result;

fn same(left: Option<&Value>, right: Option<&Value>) -> bool {
    !matches!(left, Some(Value::Array(_) | Value::Object(_)))
        && !matches!(right, Some(Value::Array(_) | Value::Object(_)))
        && left == right
}

pub fn same_placement(
    context: Option<&Value>,
    worker: &Value,
    session: Option<&Value>,
) -> Result<bool> {
    if !truthy(context) {
        return Ok(false);
    }
    if !same(wire::property(context, "workerId")?, Some(worker)) {
        return Ok(false);
    }
    for field in ["chatId", "projectId", "contextKind"] {
        if !same(
            wire::property(context, field)?,
            wire::property(session, field)?,
        ) {
            return Ok(false);
        }
    }
    let placement = wire::property(context, "worktreeId")?.filter(|value| !value.is_null());
    let placement = match placement {
        Some(value) => Some(value),
        None => wire::property(context, "scratchRootId")?,
    };
    Ok(same(placement, wire::property(session, "placementId")?))
}
pub fn same_runtime_route(context: Option<&Value>, session: Option<&Value>) -> Result<bool> {
    if !same(
        wire::property(context, "modelRouteId")?,
        wire::property(session, "modelRouteId")?,
    ) {
        return Ok(false);
    }
    Ok(same(
        wire::property(context, "providerAccountId")?,
        wire::property(session, "providerAccountId")?,
    ))
}
fn raw(row: &Row) -> Result<Value> {
    Ok(serde_json::from_str(&row.get::<String>(0)?)?)
}

pub async fn execution(tx: &Transaction<'_>, owner: &str, chat: &str) -> Result<Option<Value>> {
    crate::chats::Repository::execution_context_with(Executor::Transaction(tx), owner, chat).await
}
pub use crate::chats::guard::lock_chat;
pub async fn read(
    executor: Executor<'_, '_>,
    owner: &str,
    worker: &str,
    operation: &str,
    generation: &str,
) -> Result<Value> {
    let rows = executor.query("SELECT to_jsonb(n)::text FROM native_commands n WHERE owner_id=$1 AND worker_id=$2 AND operation_id=$3 AND operation_generation=$4", &[&owner,&worker,&operation,&generation]).await?;
    rows.first().map(raw).transpose()?.ok_or_else(|| {
        CommandError::new("operation-not-found", Some("Operation not found."), 404).into()
    })
}
impl super::Repository {
    pub async fn lookup(
        &self,
        owner: &str,
        worker: &str,
        operation: &str,
    ) -> Result<Option<Value>> {
        let rows = self.database.query("SELECT to_jsonb(n)::text FROM native_commands n WHERE owner_id=$1 AND worker_id=$2 AND operation_id=$3", &[&owner,&worker,&operation]).await?;
        rows.first()
            .map(|row| receipt::from_row(&raw(row)?))
            .transpose()
    }
    pub async fn get(
        &self,
        owner: &str,
        worker: &str,
        operation: &str,
        generation: &str,
    ) -> Result<Value> {
        let (owner, worker, operation, generation) = (
            owner.to_owned(),
            worker.to_owned(),
            operation.to_owned(),
            generation.to_owned(),
        );
        self.database
            .transaction(|tx| {
                Box::pin(async move {
                    receipt::from_row(
                        &read(
                            Executor::Transaction(tx),
                            &owner,
                            &worker,
                            &operation,
                            &generation,
                        )
                        .await?,
                    )
                })
            })
            .await
    }
}
