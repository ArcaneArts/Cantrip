//! Source ORM diagnostics for the actual pause writes. Apply only after a real
//! database error; the native statements and transaction boundaries stay intact.
use crate::wire::Value;
use anyhow::Result;
use std::{collections::HashMap, sync::LazyLock};
static QUERIES: LazyLock<HashMap<String, String>> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../contracts/task-pause-queries.json"))
        .expect("Task pause diagnostic SQL")
});
pub(crate) fn context<T>(result: Result<T>, key: &str, parameters: &[Value]) -> Result<T> {
    match result {
        Ok(value) => Ok(value),
        Err(error) => super::query_error::context(Err(error), &QUERIES[key], parameters),
    }
}
