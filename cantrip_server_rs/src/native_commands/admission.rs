//! Admission rereads use the owning transaction, including idempotent replays.
use super::{CommandError, context, policy, receipt};
use crate::{
    database::Transaction,
    wire::{JsString, Value, coercion, value::json},
};
use anyhow::{Context, Result};

/// Source compares JSON.stringify(Object.entries(intent).sort()), including
/// nested insertion order and Array-to-string ordering of the entry pairs.
pub(crate) fn intent_identity(value: Option<&Value>) -> Result<String> {
    let mut entries = match value {
        None | Some(Value::Null) => anyhow::bail!("Cannot convert undefined or null to object"),
        Some(Value::Object(object)) => coercion::keys(object)
            .into_iter()
            .map(|key| Value::Array(vec![Value::String(key.clone()), object[key].clone()]))
            .collect::<Vec<_>>(),
        Some(Value::Array(array)) => array
            .iter()
            .enumerate()
            .map(|(i, value)| Value::Array(vec![json!(i.to_string()), value.clone()]))
            .collect(),
        Some(Value::String(string)) => string
            .units()
            .iter()
            .enumerate()
            .map(|(i, unit)| {
                Value::Array(vec![
                    json!(i.to_string()),
                    Value::String(JsString::new(vec![*unit])),
                ])
            })
            .collect(),
        Some(_) => Vec::new(),
    };
    if entries.len() > 1 {
        let mut keyed = entries
            .into_iter()
            .map(|entry| {
                coercion::string(&entry)
                    .map(|key| (key, entry))
                    .map_err(|()| anyhow::anyhow!("Cannot convert object to primitive value"))
            })
            .collect::<Result<Vec<_>>>()?;
        keyed.sort_by(|(left, _), (right, _)| left.units().cmp(right.units()));
        entries = keyed.into_iter().map(|(_, value)| value).collect();
    }
    Ok(Value::Array(entries).stringify())
}

/// Caller holds project/Chat locks. None means fresh admission must continue;
/// it is never represented as an accepted or committed command.
pub async fn existing(tx: &Transaction<'_>, owner: &str, input: &Value) -> Result<Option<Value>> {
    let operation = input["operationId"]
        .as_js_string()
        .context("Command operation")?
        .lossy();
    let rows = tx
        .query(
            "SELECT to_jsonb(n)::text FROM native_commands n WHERE operation_id=$1",
            &[&operation.as_ref()],
        )
        .await?;
    let Some(row) = rows.first() else {
        return Ok(None);
    };
    let row: Value = serde_json::from_str(&row.get::<String>(0)?)?;
    if row["owner_id"] != json!(owner)
        || row["worker_id"] != input["workerId"]
        || row["chat_id"] != input["session"]["chatId"]
        || row["payload_digest"] != input["payloadDigest"]
        || row["method"] != input["method"]
        || row["origin"] != input["origin"]
        || intent_identity(row.get("intent"))? != intent_identity(input.get("intent"))?
    {
        return Err(CommandError::new("operation-id-conflict", None, 409).into());
    }
    let chat = row["chat_id"].as_str().context("Command Chat")?;
    let current = context::execution(tx, owner, chat).await?;
    let activations = tx
        .query(
            "SELECT to_jsonb(a)::text FROM native_command_activations a WHERE chat_id=$1",
            &[&chat],
        )
        .await?;
    let activation = activations
        .first()
        .map(|row| Ok::<Value, anyhow::Error>(serde_json::from_str(&row.get::<String>(0)?)?))
        .transpose()?
        .unwrap_or(Value::Null);
    let identity = row.get("identity");
    let mut active = context::same_placement(current.as_ref(), &row["worker_id"], identity)?;
    if active {
        active = context::same_runtime_route(current.as_ref(), identity)?;
    }
    if active {
        let current = current.as_ref().unwrap();
        active = if coercion::truthy(row.get("activation_generation")) {
            coercion::truthy(activation.get("active"))
                && activation["generation"] == row["activation_generation"]
                && current["executionLaneId"] == row["execution_lane_id"]
        } else {
            policy::contains(
                "sessionDiscoveryMethods",
                row["method"].as_str().unwrap_or(""),
            ) || !(current["status"] == "running" || current["status"] == "waiting-for-approval")
        };
    }
    Ok(Some(
        json!({"receipt":receipt::from_row(&row)?,"replayed":true,"execution":if active{current.unwrap()}else{Value::Null}}),
    ))
}
