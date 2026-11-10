//! Preserve the existing public ORM error only after a real replacement fails.
//! Successful native SQL and its transaction remain unchanged.
use crate::{
    database::query_error,
    wire::{Value, value::json},
};
use anyhow::Result;
use std::{collections::HashMap, sync::LazyLock};

static QUERIES: LazyLock<HashMap<String, String>> = LazyLock::new(|| {
    serde_json::from_str(include_str!(
        "../../../contracts/queued-prompt-queries.json"
    ))
    .expect("Queued prompt diagnostic SQL")
});

pub(super) fn replacement<T>(
    result: Result<T>,
    owner: &str,
    id: &str,
    prompt: &Value,
    attachments: &Value,
    at: Value,
) -> Result<T> {
    let Err(cause) = result else {
        return result;
    };
    let parameters = [
        json!(prompt.stringify()),
        prompt["classification"]["mode"].clone(),
        json!(attachments.stringify()),
        prompt["reasoningEffort"].clone(),
        prompt["customSubagentModel"].clone(),
        prompt["subagentModelId"].clone(),
        prompt["subagentReasoningEffort"].clone(),
        prompt["worktreeId"].clone(),
        prompt["frozen"].clone(),
        at,
        json!(id),
        json!(owner),
    ];
    query_error::context(Err(cause), &QUERIES["replace"], &parameters)
}
