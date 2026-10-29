//! Opaque tunnel routing and durable attachment/lease generations.
mod attachments;
pub mod broker;
mod catalog;
pub mod frame;
mod leases;
mod managed;
mod management;
mod recovery;
mod references;
pub mod runtime;
pub mod sweep;
use crate::{
    database::{Database, Row, Transaction},
    wire::{Value, coercion, value::json},
};
use anyhow::{Context, Result, bail};
pub use attachments::{CreateAttachment, StopFence};
use chrono::{DateTime, Utc};
pub use management::ManagementError;
use std::sync::Arc;
pub type Time = DateTime<Utc>;
pub type Clock = Arc<dyn Fn() -> Time + Send + Sync>;
#[derive(Clone)]
pub struct Repository {
    pub(crate) database: Arc<Database>,
    clock: Clock,
}
impl Repository {
    pub fn new(database: Arc<Database>) -> Self {
        Self::with_clock(database, Arc::new(crate::auth::now))
    }
    pub fn with_clock(database: Arc<Database>, clock: Clock) -> Self {
        Self { database, clock }
    }
    fn now(&self) -> Time {
        (self.clock)()
    }
}
fn raw(row: &Row, column: usize) -> Result<Value> {
    Ok(serde_json::from_str(&row.get::<String>(column)?)?)
}
fn text(v: &Value, key: &str) -> Result<String> {
    Ok(v[key]
        .as_js_string()
        .with_context(|| format!("Tunnel {key}"))?
        .lossy()
        .into_owned())
}
fn optional(v: &Value, key: &str) -> Result<Option<String>> {
    if v[key].is_null() {
        Ok(None)
    } else {
        text(v, key).map(Some)
    }
}
fn time(v: &Value, key: &str) -> Result<Option<Time>> {
    optional(v, key)?
        .map(|s| {
            let date = DateTime::parse_from_rfc3339(&s)?;
            Time::from_timestamp_millis(date.timestamp_millis()).context("Tunnel timestamp range")
        })
        .transpose()
}
fn iso(v: Time) -> Value {
    Value::String(crate::auth::iso(v).into())
}
fn change(tunnel: &Value, attachment: &str) -> Value {
    json!({"attachmentId":attachment,"ownerId":tunnel["owner_id"],"projectId":tunnel["project_id"],"tunnelId":tunnel["id"]})
}
pub fn publish(live: &crate::live::LiveService, change: &Value) {
    let scope = if coercion::truthy(change.get("projectId")) {
        json!({"kind":"project","projectId":change["projectId"]})
    } else {
        json!({"kind":"current-user"})
    };
    let _=live.publish_event(json!({"ownerId":change["ownerId"],"scope":scope,"resource":"tunnel","action":"invalidated","entityId":change["tunnelId"],"revision":Value::Null,"payload":Value::Null}));
}
fn destination(tunnel: &Value) -> Result<Value> {
    if tunnel["destination_kind"] == "worker-tcp" {
        return Ok(json!({"kind":"worker-tcp","workerId":tunnel["destination_worker_id"]}));
    }
    if tunnel["destination_kind"] == "worker-adapter"
        && coercion::truthy(tunnel.get("destination_adapter"))
        && coercion::truthy(tunnel.get("destination_resource_id"))
    {
        return Ok(
            json!({"kind":"worker-adapter","workerId":tunnel["destination_worker_id"],"adapter":tunnel["destination_adapter"],"resourceId":tunnel["destination_resource_id"]}),
        );
    }
    bail!("Tunnel destination routing metadata is invalid.")
}
fn protected(tunnel: &Value) -> Option<Value> {
    (coercion::truthy(tunnel.get("protected_content")) && coercion::truthy(tunnel.get("protected_operation_id")) && tunnel["protected_revision"].as_f64().is_some_and(|r|r>=1.0))
        .then(||json!({"operationId":tunnel["protected_operation_id"],"revision":tunnel["protected_revision"],"protectedContent":tunnel["protected_content"]}))
}
async fn lock_attachment(
    tx: &Transaction<'_>,
    attachment: &str,
    owner: Option<&str>,
    client: Option<&str>,
) -> Result<Option<(Value, Value)>> {
    // The attachment is deliberately observed before the parent lock. Renewal
    // retains that source snapshot; activation performs its later fenced read.
    let rows=tx.query("SELECT to_jsonb(a)::text FROM tunnel_attachments a WHERE id=$1 AND ($2::text IS NULL OR client_id=$2) LIMIT 1",&[&attachment,&client]).await?;
    let Some(row) = rows.first() else {
        return Ok(None);
    };
    let attachment = raw(row, 0)?;
    let tunnel = text(&attachment, "tunnel_id")?;
    let rows=tx.query("SELECT to_jsonb(t)::text FROM tunnels t WHERE id=$1 AND ($2::text IS NULL OR owner_id=$2) LIMIT 1 FOR UPDATE",&[&tunnel,&owner]).await?;
    rows.first()
        .map(|row| Ok((attachment, raw(row, 0)?)))
        .transpose()
}
async fn recompute(tx: &Transaction<'_>, tunnel: &str, now: Time) -> Result<()> {
    let rows = tx
        .query(
            "SELECT to_jsonb(a)::text FROM tunnel_attachments a WHERE tunnel_id=$1",
            &[&tunnel],
        )
        .await?;
    let attachments = rows.iter().map(|r| raw(r, 0)).collect::<Result<Vec<_>>>()?;
    if attachments.is_empty() {
        return Ok(());
    }
    let ids = attachments
        .iter()
        .map(|a| text(a, "id"))
        .collect::<Result<Vec<_>>>()?;
    let direct=tx.query("SELECT attachment_id FROM tunnel_attachment_direct_leases WHERE attachment_id=ANY($1::text[]) AND status='active' AND lease_expires_at>$2",&[&ids,&now]).await?.iter().map(|r|r.get::<String>(0)).collect::<Result<std::collections::HashSet<_>>>()?;
    let mut effective = Vec::new();
    for attachment in &attachments {
        let id = text(attachment, "id")?;
        let previous = text(attachment, "status")?;
        if ["stopped", "failed"].contains(&previous.as_str()) {
            effective.push(previous);
            continue;
        }
        let status = if !attachment["last_seen_at"].is_null() || direct.contains(&id) {
            "active"
        } else if ["starting", "degraded", "stopping"].contains(&previous.as_str()) {
            previous.as_str()
        } else {
            "offline"
        };
        let error = if ["active", "starting"].contains(&status) {
            None
        } else {
            Some(
                optional(attachment, "error_code")?
                    .unwrap_or_else(|| "attachment-disconnected".into()),
            )
        };
        if previous != status || optional(attachment, "error_code")? != error {
            tx.query(
                "UPDATE tunnel_attachments SET error_code=$2,status=$3,updated_at=$4 WHERE id=$1",
                &[&id, &error, &status, &now],
            )
            .await?;
        }
        effective.push(status.to_owned());
    }
    let Some(status) = ["active", "degraded", "starting", "stopping", "offline"]
        .into_iter()
        .find(|s| effective.iter().any(|v| v == s))
    else {
        return Ok(());
    };
    // Source chooses an error from the original snapshot, after writing each
    // effective attachment status. Empty strings remain distinct from null.
    let error = if ["active", "starting"].contains(&status) {
        None
    } else {
        Some(
            attachments
                .iter()
                .zip(&effective)
                .find(|(a, s)| s.as_str() == status && coercion::truthy(a.get("error_code")))
                .map(|(a, _)| text(a, "error_code"))
                .transpose()?
                .unwrap_or_else(|| "attachment-disconnected".into()),
        )
    };
    crate::database::query_error::context(tx.query("UPDATE tunnels SET active_connection_count=0,desired_state='started',error_code=$2,status=$3,updated_at=$4 WHERE id=$1",&[&tunnel,&error,&status,&now]).await,
        "update \"tunnels\" set \"desired_state\" = $1, \"status\" = $2, \"error_code\" = $3, \"active_connection_count\" = $4, \"updated_at\" = $5 where \"tunnels\".\"id\" = $6",
        &[json!("started"),json!(status),error.map_or(Value::Null,|s|json!(s)),json!(0),iso(now),json!(tunnel)])?;
    Ok(())
}
