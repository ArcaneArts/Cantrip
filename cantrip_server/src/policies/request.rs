use crate::wire::{JsString, Value};
use anyhow::{Context, Result};

/// Assignment/order identifiers cross PostgreSQL's UTF-8 text boundary after
/// protocol validation. Encrypted content is ASCII and stays untouched.
pub fn storage_input(mut value: Value) -> Result<serde_json::Value> {
    if let Some(ids) = value.get("policyIds").and_then(Value::as_array) {
        let ids = ids
            .iter()
            .map(|id| {
                Ok(Value::String(JsString::from(
                    id.as_js_string()
                        .context("validated policy ID")?
                        .lossy()
                        .into_owned(),
                )))
            })
            .collect::<Result<Vec<_>>>()?;
        value["policyIds"] = Value::Array(ids);
    }
    Ok(serde_json::from_str(&value.stringify())?)
}

pub fn validate(schema: &str, value: &serde_json::Value) -> Result<serde_json::Value> {
    let value = crate::wire::parse(schema, Some(&Value::from_serialize(value)))
        .map_err(|_| anyhow::anyhow!("Invalid policy input."))?;
    storage_input(value)
}
