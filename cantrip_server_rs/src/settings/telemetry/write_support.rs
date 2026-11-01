use crate::{
    database::{Parameters, Transaction},
    wire::{Value, coercion, value::json},
};
use anyhow::{Context, Result};

pub(super) fn text(value: &Value) -> Result<String> {
    Ok(value
        .as_js_string()
        .context("Telemetry identity")?
        .lossy()
        .into_owned())
}
pub(super) fn nullish(value: Option<&Value>) -> Value {
    value.cloned().unwrap_or(Value::Null)
}
pub(super) fn fallback(value: Option<&Value>, default: &Value) -> Value {
    value.filter(|v| !v.is_null()).unwrap_or(default).clone()
}
pub(super) fn column_text(value: &Value) -> Value {
    if let Some(value) = value.as_js_string() {
        json!(value.lossy())
    } else {
        value.clone()
    }
}
pub(super) fn count(value: Option<&Value>) -> Result<Value> {
    let number = coercion::number(value.filter(|v| !v.is_null()))
        .map_err(|_| anyhow::anyhow!("Cannot convert object to primitive value"))?;
    let number = if value.is_none_or(|v| v.is_null()) {
        0.0
    } else {
        number
    };
    let rounded = crate::settings::round_nonnegative(number);
    Ok(json!(super::max_zero(rounded)))
}
pub(super) fn nullable_count(value: Option<&Value>) -> Result<Value> {
    if value.is_some_and(|v| matches!(v, Value::Number(_))) {
        count(value)
    } else {
        Ok(Value::Null)
    }
}
pub(super) async fn rows(
    tx: &Transaction<'_>,
    sql: &str,
    parameters: Parameters<'_>,
) -> Result<Vec<Value>> {
    tx.query(sql, parameters)
        .await?
        .iter()
        .map(|row| Ok(serde_json::from_str(&row.get::<String>(0)?)?))
        .collect()
}
pub(super) async fn one(
    tx: &Transaction<'_>,
    sql: &str,
    parameters: Parameters<'_>,
) -> Result<Option<Value>> {
    Ok(rows(tx, sql, parameters).await?.into_iter().next())
}
pub(super) async fn routes(
    tx: &Transaction<'_>,
    owner: &str,
    ids: &[String],
) -> Result<Vec<Value>> {
    rows(tx,"SELECT jsonb_build_object('modelId',m.id,'modelRouteId',r.id,'providerId',p.id)::text FROM model_routes r INNER JOIN model_profiles m ON m.id=r.model_id AND m.owner_id=$1 INNER JOIN model_providers p ON p.id=r.provider_id AND p.owner_id=$1 WHERE r.id=ANY($2::text[])",&[&owner,&ids]).await
}
