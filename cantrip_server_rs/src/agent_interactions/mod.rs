//! Durable approvals and requests. Ordinary calls preserve the source's
//! statement boundaries; native events bind the same code to their transaction.
mod mapping;
mod reads;
mod record;
mod resolution;
mod responses;
mod terminal;

use crate::{
    database::{Executor, Parameters},
    wire::{Value, coercion::truthy, value::json},
};
use anyhow::{Context, Result};
use mapping::{map, parse, text};

#[derive(Clone, Copy)]
pub struct Repository<'a, 'db> {
    executor: Executor<'a, 'db>,
}
impl<'a, 'db> Repository<'a, 'db> {
    pub fn new(executor: Executor<'a, 'db>) -> Self {
        Self { executor }
    }
    async fn rows(&self, sql: &str, parameters: Parameters<'_>) -> Result<Vec<Value>> {
        self.executor
            .query(sql, parameters)
            .await?
            .iter()
            .map(|row| Ok(serde_json::from_str(&row.get::<String>(0)?)?))
            .collect()
    }
    async fn raw_id(&self, id: &str) -> Result<Option<Value>> {
        Ok(self
            .rows(
                "SELECT to_jsonb(r)::text FROM agent_interaction_requests r WHERE id=$1 LIMIT 1",
                &[&id],
            )
            .await?
            .into_iter()
            .next())
    }
}

#[derive(Debug)]
pub struct Conflict(pub String);
impl std::fmt::Display for Conflict {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for Conflict {}
fn conflict(message: &str) -> anyhow::Error {
    Conflict(message.to_owned()).into()
}
