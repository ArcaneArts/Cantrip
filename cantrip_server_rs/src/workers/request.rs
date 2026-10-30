//! Explicit Node UTF-8 text and Date boundaries. Capability JSON is not
//! recursively converted: PostgreSQL still owns its JSONB acceptance rules.
use crate::{
    auth::iso,
    wire::{JsString, Value},
};
use anyhow::{Context, Result};

pub fn text(value: &Value) -> Option<String> {
    value.as_js_string().map(|value| value.lossy().into_owned())
}

fn date(input: &str) -> Result<String> {
    // The authoritative datetime validator accepts HH:MMZ and fractions longer
    // than nanoseconds. JavaScript Date supplies seconds and truncates to ms.
    let (day, time) = input.split_once('T').context("validated heartbeat date")?;
    let time = time
        .strip_suffix('Z')
        .context("validated UTC heartbeat date")?;
    let (clock, fraction) = time.split_once('.').unwrap_or((time, ""));
    let clock = if clock.len() == 5 {
        format!("{clock}:00")
    } else {
        clock.to_owned()
    };
    let mut millis = fraction.chars().take(3).collect::<String>();
    while millis.len() < 3 {
        millis.push('0');
    }
    let parsed = chrono::DateTime::parse_from_rfc3339(&format!("{day}T{clock}.{millis}Z"))?;
    Ok(iso(parsed.with_timezone(&chrono::Utc)))
}
pub fn heartbeat(mut value: Value) -> Result<serde_json::Value> {
    for key in [
        "workerId",
        "name",
        "platform",
        "architecture",
        "codexVersion",
    ] {
        if let Some(text) = text(&value[key]) {
            value[key] = Value::String(JsString::from(text));
        }
    }
    let started = date(
        value["startedAt"]
            .as_str()
            .context("validated heartbeat timestamp")?,
    )?;
    value["startedAt"] = Value::String(started.into());
    Ok(serde_json::from_str(&value.stringify())?)
}
