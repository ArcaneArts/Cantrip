//! Actual Source message INSERT diagnostics, attached after that INSERT fails.
use crate::{database::query_error, wire::Value};
use anyhow::{Context, Result};
use serde::Deserialize;
use std::sync::OnceLock;
#[derive(Deserialize)]
struct Contract {
    insert: Insert,
}
#[derive(Deserialize)]
struct Insert {
    sql: String,
    parameters: Vec<Parameter>,
}
#[derive(Deserialize)]
struct Parameter {
    column: String,
    json: bool,
}
pub(super) fn insert_failure<T>(cause: anyhow::Error, fields: &[(&str, Value)]) -> Result<T> {
    static CONTRACT: OnceLock<Contract> = OnceLock::new();
    let contract = CONTRACT.get_or_init(|| {
        serde_json::from_str(include_str!("../../contracts/mcp-delivery-queries.json"))
            .expect("generated Source delivery queries")
    });
    let parameters = contract
        .insert
        .parameters
        .iter()
        .map(|p| {
            let value = &fields
                .iter()
                .find(|(name, _)| *name == p.column)
                .with_context(|| format!("Source message diagnostic has no column {}", p.column))?
                .1;
            Ok(if p.json && !value.is_null() {
                Value::String(value.stringify().into())
            } else {
                value.clone()
            })
        })
        .collect::<Result<Vec<_>>>()?;
    query_error::context(Err(cause), &contract.insert.sql, &parameters)
}
