//! Durable device-workspace transitions, independent of renderer lifetimes.
mod commands;
mod error;
mod legacy;
mod legacy_import;
mod overview;
mod queries;
mod repository;
mod seed;
mod tree;

pub use commands::apply;
pub use error::ModelError;
pub use legacy::Invariant as LegacyInvariant;
pub use legacy_import::import_legacy_files;
pub use repository::Repository;
pub(crate) use repository::resolve_on;
pub(crate) use seed::component;
pub use seed::seed;

use crate::wire::{self, Value};
type Result<T> = std::result::Result<T, ModelError>;

/// The legacy pane API reads outside a transaction and opens one only for its
/// lazy Overview cleanup. Device seeding uses the same reader inside its lock.
pub async fn legacy_layout(
    database: &crate::database::Database,
    owner: &str,
    project: &str,
) -> anyhow::Result<Option<Value>> {
    legacy::get_on(
        crate::database::Executor::Database(database),
        &crate::wire::value::json!({"owner":owner,"project":project}),
    )
    .await
}

fn parse(name: &str, input: &Value) -> Result<Value> {
    wire::parse(name, Some(input)).map_err(ModelError::validation)
}
fn values<'a>(value: &'a Value, key: &str) -> &'a [Value] {
    value
        .get(key)
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

/// Node's deep strict equality for the plain JSON values in command receipts.
/// Unlike ordinary numeric equality, retry identity distinguishes -0 from +0.
pub fn strict_equal(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(a), Value::Number(b)) => {
            a.to_bits() == b.to_bits() || (a.is_nan() && b.is_nan())
        }
        (Value::Array(a), Value::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(a, b)| strict_equal(a, b))
        }
        (Value::Object(a), Value::Object(b)) => {
            a.len() == b.len()
                && a.iter()
                    .all(|(key, value)| b.get(key).is_some_and(|other| strict_equal(value, other)))
        }
        _ => a == b,
    }
}
