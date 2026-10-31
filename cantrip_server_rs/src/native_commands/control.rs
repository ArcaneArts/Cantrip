use super::{
    Repository,
    admit::{raw_one, text},
    context, queue,
};
use crate::{
    chats::{execution_lanes, managed_console},
    database::{Executor, Transaction},
    wire::{self, Value, coercion::truthy, value::json},
};
use anyhow::Result;
use futures::FutureExt;

async fn activation(tx: &Transaction<'_>, chat: &str) -> Result<Value> {
    Ok(raw_one(
        tx,
        "SELECT to_jsonb(a)::text FROM native_command_activations a WHERE chat_id=$1",
        &[&chat],
    )
    .await?
    .unwrap_or(Value::Null))
}
async fn stop(
    tx: &Transaction<'_>,
    owner: &str,
    chat: &str,
    expected: Option<&str>,
) -> Result<bool> {
    context::lock_chat(tx, owner, chat).await?;
    let current = context::execution(tx, owner, chat).await?;
    if current
        .as_ref()
        .and_then(managed_console::session_context)
        .is_none()
    {
        return Ok(false);
    }
    let active = activation(tx, chat).await?;
    let actual = if truthy(active.get("active")) {
        active["generation"].as_str()
    } else {
        None
    };
    if actual != expected {
        return Ok(false);
    }
    queue::stop_autonomy(tx, chat).await?;
    Ok(true)
}
pub(super) async fn resume(tx: &Transaction<'_>, owner: &str, chat: &str) -> Result<()> {
    context::lock_chat(tx, owner, chat).await?;
    let current = context::execution(tx, owner, chat).await?;
    if current
        .as_ref()
        .and_then(managed_console::session_context)
        .is_none()
    {
        return Ok(());
    }
    tx.query(
        "UPDATE chats SET managed_autonomy_stopped=false WHERE id=$1",
        &[&chat],
    )
    .await?;
    queue::changed(tx, chat).await
}
async fn cancel_preparing(
    tx: &Transaction<'_>,
    owner: &str,
    chat: &str,
    generation: &str,
) -> Result<Option<Value>> {
    context::lock_chat(tx, owner, chat).await?;
    let active = activation(tx, chat).await?;
    if !truthy(active.get("active")) || active["generation"] != generation {
        return Ok(None);
    }
    let operation = raw_one(
        tx,
        "SELECT to_jsonb(n)::text FROM native_commands n WHERE operation_id=$1",
        &[&text(&active["operation_id"])?],
    )
    .await?;
    let Some(operation) = operation.filter(|o| o["status"] == "accepted") else {
        return Ok(None);
    };
    let logical = if truthy(operation.get("logical_operation_id")) {
        raw_one(tx,"SELECT to_jsonb(n)::text FROM native_commands n WHERE operation_id=$1 AND owner_id=$2 AND chat_id=$3",&[&text(&operation["logical_operation_id"])?,&owner,&chat]).await?
    } else {
        None
    };
    queue::stop_autonomy(tx, chat).await?;
    let id = text(&operation["operation_id"])?;
    let now = crate::auth::now();
    tx.query("UPDATE native_commands SET status='rejected',rejection_code='cancelled-before-dispatch',updated_at=$1 WHERE operation_id=$2",&[&now,&id]).await?;
    execution_lanes::finish_in_transaction(
        tx,
        chat,
        &text(&active["execution_lane_id"])?,
        "idle",
        &Value::Null,
    )
    .boxed()
    .await?;
    tx.query(
        "UPDATE native_command_activations SET active=false WHERE chat_id=$1",
        &[&chat],
    )
    .await?;
    if let Some(root) = &logical {
        let at = crate::auth::now();
        tx.query(
            "UPDATE native_commands SET logical_completed_at=$1 WHERE operation_id=$2",
            &[&at, &text(&root["operation_id"])?],
        )
        .await?;
    }
    let cancelled = raw_one(
        tx,
        "SELECT to_jsonb(n)::text FROM native_commands n WHERE operation_id=$1",
        &[&id],
    )
    .await?
    .unwrap_or(Value::Null);
    queue::settle(tx, &cancelled, None, None).await?;
    Ok(Some(
        json!({"workerId":operation["worker_id"],"logicalRoot":logical.map(|root|json!({"operationId":root["operation_id"],"operationGeneration":root["operation_generation"]})).unwrap_or(Value::Null)}),
    ))
}
pub(super) async fn control_context(
    tx: &Transaction<'_>,
    owner: &str,
    chat: &str,
) -> Result<Value> {
    if context::execution(tx, owner, chat).await?.is_none() {
        return Ok(
            json!({"context":Value::Null,"activationGeneration":Value::Null,"runtimeGeneration":Value::Null}),
        );
    }
    context::lock_chat(tx, owner, chat).await?;
    let current = context::execution(tx, owner, chat)
        .await?
        .unwrap_or(Value::Null);
    let active = activation(tx, chat).await?;
    let operation = if truthy(active.get("active")) {
        raw_one(
            tx,
            "SELECT to_jsonb(n)::text FROM native_commands n WHERE operation_id=$1",
            &[&text(&active["operation_id"])?],
        )
        .await?
    } else {
        None
    };
    let valid = truthy(Some(&current))
        && truthy(active.get("active"))
        && active.get("execution_lane_id") == current.get("executionLaneId");
    let runtime = if valid && operation.is_some() {
        wire::property(
            operation.as_ref().and_then(|o| o.get("identity")),
            "runtimeGeneration",
        )?
        .cloned()
    } else {
        Some(Value::Null)
    };
    let mut result = json!({"context":current});
    if let Some(runtime) = runtime {
        result["runtimeGeneration"] = runtime;
    }
    result["activationGeneration"] = if valid {
        active["generation"].clone()
    } else {
        Value::Null
    };
    Ok(result)
}
async fn finish(
    tx: &Transaction<'_>,
    owner: &str,
    worker: &str,
    id: &str,
    generation: &str,
    status: &str,
) -> Result<bool> {
    let original = context::read(Executor::Transaction(tx), owner, worker, id, generation).await?;
    let chat = text(&original["chat_id"])?;
    context::lock_chat(tx, owner, &chat).await?;
    let row = context::read(Executor::Transaction(tx), owner, worker, id, generation).await?;
    let active = activation(tx, &chat).await?;
    if row["kind"] != "start"
        || !truthy(row.get("execution_lane_id"))
        || !truthy(active.get("active"))
        || active.get("generation") != row.get("activation_generation")
    {
        return Ok(false);
    }
    let finished = execution_lanes::finish_in_transaction(
        tx,
        &chat,
        &text(&row["execution_lane_id"])?,
        status,
        &Value::Null,
    )
    .boxed()
    .await?;
    tx.query(
        "UPDATE native_command_activations SET active=false WHERE chat_id=$1",
        &[&chat],
    )
    .await?;
    if matches!(row["status"].as_str(), Some("accepted" | "dispatched")) {
        let accepted = row["status"] == "accepted";
        let next = if accepted { "rejected" } else { "uncertain" };
        let code = if accepted {
            "not-dispatched"
        } else {
            "missing-native-receipt"
        };
        let at = crate::auth::now();
        tx.query("UPDATE native_commands SET status=$1,rejection_code=$2,updated_at=$3 WHERE operation_id=$4",&[&next,&code,&at,&id]).await?;
    }
    Ok(finished)
}
impl Repository {
    pub async fn stop_autonomy(
        &self,
        owner: &str,
        chat: &str,
        expected: Option<&str>,
    ) -> Result<bool> {
        let (owner, chat, expected) = (
            owner.to_owned(),
            chat.to_owned(),
            expected.map(str::to_owned),
        );
        self.database
            .transaction(|tx| {
                Box::pin(async move { stop(tx, &owner, &chat, expected.as_deref()).await })
            })
            .await
    }
    pub async fn resume_autonomy(&self, owner: &str, chat: &str) -> Result<()> {
        let (owner, chat) = (owner.to_owned(), chat.to_owned());
        self.database
            .transaction(|tx| Box::pin(async move { resume(tx, &owner, &chat).await }))
            .await
    }
    pub async fn cancel_preparing(
        &self,
        owner: &str,
        chat: &str,
        generation: &str,
    ) -> Result<Option<Value>> {
        let (owner, chat, generation) = (owner.to_owned(), chat.to_owned(), generation.to_owned());
        self.database
            .transaction(|tx| {
                Box::pin(async move { cancel_preparing(tx, &owner, &chat, &generation).await })
            })
            .await
    }
    pub async fn control_context(&self, owner: &str, chat: &str) -> Result<Value> {
        let (owner, chat) = (owner.to_owned(), chat.to_owned());
        self.database
            .transaction(|tx| Box::pin(async move { control_context(tx, &owner, &chat).await }))
            .await
    }
    pub async fn finish_execution(
        &self,
        owner: &str,
        worker: &str,
        id: &str,
        generation: &str,
        status: &str,
    ) -> Result<bool> {
        let (owner, worker, id, generation, status) = (
            owner.to_owned(),
            worker.to_owned(),
            id.to_owned(),
            generation.to_owned(),
            status.to_owned(),
        );
        self.database
            .transaction(|tx| {
                Box::pin(
                    async move { finish(tx, &owner, &worker, &id, &generation, &status).await },
                )
            })
            .await
    }
}
