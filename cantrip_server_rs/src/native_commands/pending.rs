//! Idempotent registration of native approval and other server requests.
use super::{CommandError, Repository, context, policy};
use crate::{
    database::Transaction,
    wire::{Value, coercion::truthy},
};
use anyhow::{Context, Result};

async fn register(tx: &Transaction<'_>, owner: &str, input: &Value) -> Result<()> {
    let text = |value: &Value| {
        value
            .as_js_string()
            .map(|v| v.lossy().into_owned())
            .context("Native pending request identity")
    };
    let session = &input["session"];
    let chat = text(&session["chatId"])?;
    context::lock_chat(tx, owner, &chat).await?;
    let current = context::execution(tx, owner, &chat).await?;
    let rows = tx
        .query(
            "SELECT to_jsonb(a)::text FROM native_command_activations a WHERE chat_id=$1",
            &[&chat],
        )
        .await?;
    let activation: Value = rows
        .first()
        .map(|row| Ok::<_, anyhow::Error>(serde_json::from_str(&row.get::<String>(0)?)?))
        .transpose()?
        .unwrap_or(Value::Null);
    if !context::same_placement(current.as_ref(), &input["workerId"], Some(session))?
        || current.as_ref().unwrap()["threadId"] != session["threadId"]
        || !context::same_runtime_route(current.as_ref(), Some(session))?
        || !truthy(session.get("runtimeGeneration"))
        || !truthy(activation.get("active"))
        || activation["generation"] != input["activationGeneration"]
        || activation["runtime_generation"] != session["runtimeGeneration"]
        || activation["execution_lane_id"] != current.as_ref().unwrap()["executionLaneId"]
        || !policy::managed_server_request(&text(&input["requestMethod"])?)
    {
        return Err(CommandError::new("stale-native-request", None, 409).into());
    }
    let runtime = text(&session["runtimeGeneration"])?;
    let request = text(&input["nativeRequestId"])?;
    let rows = tx.query("SELECT to_jsonb(n)::text FROM native_pending_requests n WHERE chat_id=$1 AND runtime_generation=$2 AND native_request_id=$3", &[&chat,&runtime,&request]).await?;
    if let Some(row) = rows.first() {
        let prior: Value = serde_json::from_str(&row.get::<String>(0)?)?;
        if prior["activation_generation"] != input["activationGeneration"]
            || prior["request_method"] != input["requestMethod"]
            || prior.get("turn_id") != input.get("turnId")
            || truthy(prior.get("resolution_operation_id"))
        {
            return Err(CommandError::new("native-request-id-conflict", None, 409).into());
        }
        return Ok(());
    }
    let turn = input["turnId"]
        .as_js_string()
        .map(|v| v.lossy().into_owned());
    tx.query("INSERT INTO native_pending_requests(chat_id,runtime_generation,native_request_id,activation_generation,request_method,turn_id) VALUES($1,$2,$3,$4,$5,$6)", &[&chat,&runtime,&request,&text(&input["activationGeneration"])?,&text(&input["requestMethod"])?,&turn]).await?;
    Ok(())
}

impl Repository {
    pub async fn register_pending(&self, owner: &str, input: &Value) -> Result<()> {
        let (owner, input) = (owner.to_owned(), input.clone());
        self.database
            .transaction(|tx| Box::pin(async move { register(tx, &owner, &input).await }))
            .await
    }
}
