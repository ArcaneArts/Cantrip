//! Durable operation identity and replay data for external MCP mutations.
use crate::{database::Database, wire::Value};
use anyhow::{Context, Result};
use std::sync::Arc;

#[derive(Debug)]
pub(super) struct OperationConflict;

impl std::fmt::Display for OperationConflict {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("This operation ID is already bound to a different request.")
    }
}
impl std::error::Error for OperationConflict {}

pub(super) struct Key<'a> {
    pub owner: &'a str,
    pub principal: &'a str,
    pub operation: &'a str,
}

pub(super) enum Admission {
    Pending(Value),
    Complete(Value),
}

pub(super) struct Repository(pub Arc<Database>);

impl Repository {
    /// The worker computes a keyed fingerprint and seals the content using the
    /// same worker-held component keys as the corresponding Cantrip operation.
    /// Saving the first envelopes keeps the downstream replay input stable.
    pub async fn reserve(
        &self,
        key: &Key<'_>,
        project: &str,
        tool: &str,
        key_revision: i32,
        fingerprint: &str,
        protected_request: &Value,
    ) -> Result<Admission> {
        let body = protected_request.stringify();
        self.0
            .query(
                "INSERT INTO external_mcp_operation_receipts
                   (owner_id,principal_id,operation_id,project_id,tool,key_revision,fingerprint,protected_request)
                 VALUES($1,$2,$3,$4,$5,$6,$7,$8::text::jsonb)
                 ON CONFLICT (owner_id,principal_id,operation_id) DO NOTHING",
                &[&key.owner,&key.principal,&key.operation,&project,&tool,&key_revision,&fingerprint,&body],
            )
            .await?;
        let rows = self
            .0
            .query(
                "SELECT project_id,tool,key_revision,fingerprint,protected_request,receipt
             FROM external_mcp_operation_receipts
             WHERE owner_id=$1 AND principal_id=$2 AND operation_id=$3",
                &[&key.owner, &key.principal, &key.operation],
            )
            .await?;
        let row = rows
            .first()
            .context("MCP operation reservation disappeared")?;
        if row.get::<String>(0)? != project
            || row.get::<String>(1)? != tool
            || row.get::<i32>(2)? != key_revision
            || row.get::<String>(3)? != fingerprint
        {
            return Err(OperationConflict.into());
        }
        Ok(match row.get::<Option<serde_json::Value>>(5)? {
            Some(receipt) => Admission::Complete(Value::from_serialize(&receipt)),
            None => Admission::Pending(Value::from_serialize(&row.get::<serde_json::Value>(4)?)),
        })
    }

    pub async fn revision(&self, key: &Key<'_>) -> Result<Option<i32>> {
        let rows = self
            .0
            .query(
                "SELECT key_revision FROM external_mcp_operation_receipts
             WHERE owner_id=$1 AND principal_id=$2 AND operation_id=$3",
                &[&key.owner, &key.principal, &key.operation],
            )
            .await?;
        rows.first().map(|row| row.get(0)).transpose()
    }

    pub async fn complete(&self, key: &Key<'_>, receipt: &Value) -> Result<Value> {
        let body = receipt.stringify();
        let rows = self.0.query(
            "UPDATE external_mcp_operation_receipts SET receipt=COALESCE(receipt,$4::text::jsonb)
             WHERE owner_id=$1 AND principal_id=$2 AND operation_id=$3
             RETURNING receipt",
            &[&key.owner, &key.principal, &key.operation, &body],
        ).await?;
        Ok(Value::from_serialize(
            &rows
                .first()
                .context("MCP operation reservation disappeared")?
                .get::<serde_json::Value>(0)?,
        ))
    }
}
