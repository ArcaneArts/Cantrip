//! Owner-scoped telemetry. Exports contain opaque dimension IDs and structured
//! metrics, never message content, credential data or raw provider payloads.
pub mod changes;
mod exports;
pub mod quota;
mod repository;
pub mod repository_agent;
pub mod statistics;
use crate::wire::Value;
use anyhow::{Context, Result};
pub use repository::TelemetryQuery;

// Internal calculations must retain NaN/infinity until the final JSON boundary.
// Serializing intermediate records would prematurely turn those values to null.
pub(super) trait Datum {
    fn datum(&self) -> Value;
}
impl Datum for Value {
    fn datum(&self) -> Value {
        self.clone()
    }
}
impl<T: Datum + ?Sized> Datum for &T {
    fn datum(&self) -> Value {
        (**self).datum()
    }
}
impl<T: Datum> Datum for Vec<T> {
    fn datum(&self) -> Value {
        Value::Array(self.iter().map(Datum::datum).collect())
    }
}
impl Datum for str {
    fn datum(&self) -> Value {
        Value::String(self.into())
    }
}
impl Datum for String {
    fn datum(&self) -> Value {
        self.as_str().datum()
    }
}
impl Datum for crate::wire::JsString {
    fn datum(&self) -> Value {
        Value::String(self.clone())
    }
}
impl Datum for bool {
    fn datum(&self) -> Value {
        Value::Bool(*self)
    }
}
macro_rules! numeric_datum { ($($kind:ty),*) => { $(impl Datum for $kind { fn datum(&self) -> Value { Value::Number(*self as f64) } })* }; }
numeric_datum!(f64, usize, i32);
macro_rules! object {
    ({$($key:literal:$value:expr),*$(,)?}) => {
        $crate::wire::Value::object([$(( $key, $crate::settings::telemetry::Datum::datum(&$value) )),*])
    };
}
pub(super) use object;
pub(super) fn text(value: impl Into<crate::wire::JsString>) -> Value {
    Value::String(value.into())
}

// JSONB text reaches the existing stack-safe wire parser directly. Decoding a
// whole row through serde_json::Value imposes its recursion limit on otherwise
// valid unknown structured telemetry values before the protocol can see them.
pub(super) async fn json_rows(
    repository: &crate::settings::repository::SettingsRepository,
    sql: &str,
    parameters: crate::database::Parameters<'_>,
) -> Result<Vec<Value>> {
    repository
        .database
        .query(sql, parameters)
        .await?
        .iter()
        .map(|row| {
            let text: String = row.get(0)?;
            Ok(serde_json::from_str(&text)?)
        })
        .collect()
}
pub(super) fn stored_date(value: &Value) -> Result<Value> {
    if value.is_null() {
        return Ok(Value::Null);
    }
    // Only the timestamp scalar crosses this adapter; structured fields stay
    // in wire values through projection, validation and response serialization.
    let scalar = serde_json::Value::String(value.as_str().context("stored timestamp")?.into());
    Ok(Value::from_serialize(&crate::settings::repository::date(
        &scalar,
    )?))
}

pub(super) fn number(row: &Value, key: &str) -> f64 {
    row[key].as_f64().unwrap_or(f64::NAN)
}
pub(super) fn milliseconds(value: &Value) -> f64 {
    value
        .as_f64()
        .map(|value| {
            if value.is_finite() && value.abs() <= 8.64e15 {
                value.trunc()
            } else {
                f64::NAN
            }
        })
        .unwrap_or_else(|| {
            value
                .as_js_string()
                .and_then(crate::wire::date_milliseconds)
                .map_or(f64::NAN, |value| value as f64)
        })
}
pub(super) fn iso(value: f64) -> Result<String> {
    anyhow::ensure!(
        value.is_finite() && value.abs() <= 8.64e15,
        "Invalid time value"
    );
    crate::wire::date_iso_milliseconds(value.trunc() as i64).context("Invalid time value")
}
pub(super) fn max_zero(value: f64) -> f64 {
    if value.is_nan() {
        value
    } else {
        value.max(0.0)
    }
}
