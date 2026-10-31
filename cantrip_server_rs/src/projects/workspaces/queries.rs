use super::*;
use std::{collections::HashMap, sync::OnceLock};
pub(super) fn annotate<T>(result: Result<T>, key: &str, params: &[Value]) -> Result<T> {
    static QUERIES: OnceLock<HashMap<String, String>> = OnceLock::new();
    let queries = QUERIES.get_or_init(|| {
        serde_json::from_str(include_str!("queries.json"))
            .expect("embedded workspace catalog queries")
    });
    crate::database::query_error::context(result, &queries[key], params)
}
