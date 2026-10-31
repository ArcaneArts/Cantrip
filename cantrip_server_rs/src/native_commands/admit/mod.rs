//! Fresh admission records durable rejection only for the source's typed policy errors.
mod checks;
mod persist;
mod queue;
use super::{CommandError, Repository, admission, context, receipt};
use crate::{
    database::Transaction,
    wire::{Value, value::json},
};
use anyhow::{Context, Result};
use futures::FutureExt;

pub(super) struct Admission<'a> {
    owner: &'a str,
    input: &'a Value,
    options: &'a Value,
    queue_claim: Option<&'a Value>,
    context: Value,
    row: Value,
    starts: bool,
    consume_reply: bool,
}
pub(super) fn text(value: &Value) -> Result<String> {
    value
        .as_js_string()
        .map(|s| s.lossy().into_owned())
        .context("Native admission identity")
}
pub(super) fn optional(value: &Value) -> Result<Option<String>> {
    if value.is_null() {
        Ok(None)
    } else {
        text(value).map(Some)
    }
}
pub(super) fn reject<T>(code: &'static str) -> Result<T> {
    Err(CommandError::new(code, None, 409).into())
}
pub(super) fn includes(value: &Value, key: &str) -> bool {
    value
        .as_array()
        .is_some_and(|values| values.iter().any(|v| v == key))
}
pub(super) async fn raw_one(
    tx: &Transaction<'_>,
    sql: &str,
    params: crate::database::Parameters<'_>,
) -> Result<Option<Value>> {
    tx.query(sql, params)
        .await?
        .first()
        .map(|row| Ok(serde_json::from_str(&row.get::<String>(0)?)?))
        .transpose()
}
pub(super) async fn admit(
    tx: &Transaction<'_>,
    owner: &str,
    input: &Value,
    options: &Value,
) -> Result<Value> {
    let chat = text(&input["session"]["chatId"])?;
    context::lock_chat(tx, owner, &chat).await?;
    if let Some(existing) = admission::existing(tx, owner, input).await? {
        return Ok(existing);
    }
    let current = context::execution(tx, owner, &chat).await?;
    if !context::same_placement(current.as_ref(), &input["workerId"], input.get("session"))? {
        return reject("stale-placement");
    }
    let queue_claim = options
        .get("queueClaim")
        .filter(|v| !v.is_null())
        .or_else(|| input.get("queueClaim"));
    let mut state = Admission {
        owner,
        input,
        options,
        queue_claim,
        context: current.unwrap(),
        starts: false,
        consume_reply: false,
        row: json!({"operation_id":input["operationId"],"owner_id":owner,"worker_id":input["workerId"],"chat_id":input["session"]["chatId"],"operation_generation":uuid::Uuid::new_v4().to_string(),"logical_operation_id":Value::Null,"logical_client_message_id":options.get("clientMessageId").cloned().unwrap_or(Value::Null),"activation_generation":Value::Null,"execution_lane_id":Value::Null,"origin":input["origin"],"method":input["method"],"kind":"unknown","payload_digest":input["payloadDigest"],"protected_payload":input["protectedPayload"],"identity":input["session"],"intent":input["intent"],"reply_identity":input.get("reply").cloned().unwrap_or(Value::Null),"status":"accepted","rejection_code":Value::Null}),
    };
    if let Err(error) = state.check(tx).boxed().await {
        let code = if let Some(error) = error.downcast_ref::<CommandError>() {
            error.code.as_str()
        } else if error.is::<crate::chats::execution_lanes::LaneError>() {
            "execution-conflict"
        } else {
            return Err(error);
        };
        state.row["status"] = json!("rejected");
        state.row["rejection_code"] = json!(code);
    }
    let inserted = state.persist(tx).await?;
    Ok(json!({"receipt":receipt::from_row(&inserted)?,"execution":state.context}))
}
impl Repository {
    pub async fn admit(&self, owner: &str, input: &Value, options: &Value) -> Result<Value> {
        let (owner, input, options) = (owner.to_owned(), input.clone(), options.clone());
        self.database
            .transaction(|tx| Box::pin(async move { admit(tx, &owner, &input, &options).await }))
            .await
    }
}
