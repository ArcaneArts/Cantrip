//! Owner-serialized Task scheduling and the retained native Goal lease.
mod claim;
mod enqueue;
mod reads;
mod recovery;
mod resume;
mod rows;
use crate::{
    database::{Database, Executor, Parameters, Transaction},
    wire::{Value, value::json},
};
use anyhow::{Context, Result};
use futures::future::BoxFuture;
pub use reads::scheduler_plan;
use rows::*;
pub(crate) use rows::{model_configuration, worker_summary};
use std::sync::Arc;
pub type Eligibility = Arc<dyn Fn(Value) -> BoxFuture<'static, Result<Value>> + Send + Sync>;
pub const LEASE_MS: i64 = 120_000;
#[derive(Debug)]
pub struct Conflict {
    pub code: &'static str,
    pub message: String,
}
impl Conflict {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
    pub fn stale() -> Self {
        Self::new(
            "stale-lease",
            "The Task dispatch lease is stale or no longer active.",
        )
    }
}
impl std::fmt::Display for Conflict {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for Conflict {}
#[derive(Debug)]
pub struct NotFound;
impl std::fmt::Display for NotFound {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Task not found.")
    }
}
impl std::error::Error for NotFound {}
#[derive(Clone)]
pub struct Repository {
    database: Arc<Database>,
}
struct Update<'a> {
    predicate: &'a str,
    extra: &'a str,
    query_context: Option<(&'a str, &'a [Value])>,
}
fn text(value: &Value) -> Result<String> {
    Ok(value
        .as_js_string()
        .context("Task dispatch text")?
        .lossy()
        .into_owned())
}
fn clock(options: &Value) -> Result<String> {
    let ms = options
        .get("now")
        .filter(|v| !v.is_null())
        .map_or_else(
            || Some(crate::auth::now().timestamp_millis()),
            |v| v.as_js_string().and_then(crate::wire::date_milliseconds),
        )
        .context("Invalid time value")?;
    crate::wire::date_iso_milliseconds(ms).context("Invalid time value")
}
fn copy(fields: &mut Value, key: &str, input: &Value, source: &str) {
    if let Some(value) = input.get(source) {
        fields[key] = match value.as_js_string() {
            Some(s) => Value::String(s.lossy().into_owned().into()),
            None => value.clone(),
        };
    }
}
pub(crate) fn summary(row: &Value) -> Result<Value> {
    let mut value = Value::object([] as [(&str, Value); 0]);
    for (name, column) in [
        ("id", "id"),
        ("chatId", "chat_id"),
        ("operationId", "operation_id"),
        ("operationKind", "operation_kind"),
        ("state", "state"),
        ("requestedTaskWorkerId", "requested_task_worker_id"),
        ("selectedTaskWorkerId", "selected_task_worker_id"),
        ("taskWorkerRevision", "task_worker_revision"),
        ("continuityFamily", "continuity_family"),
        ("modelConfiguration", "model_configuration"),
        ("modelRouteId", "model_route_id"),
        ("providerAccountId", "provider_account_id"),
        ("physicalWorkerId", "physical_worker_id"),
        ("worktreeId", "worktree_id"),
        ("codexThreadId", "codex_thread_id"),
        ("turnId", "turn_id"),
        ("leaseOwner", "lease_owner"),
        ("fencingToken", "fencing_token"),
        ("attemptCount", "attempt_count"),
        ("eligibilityCode", "eligibility_code"),
    ] {
        value[name] = row[column].clone();
    }
    for (name, column) in [
        ("fifoCreatedAt", "fifo_created_at"),
        ("leaseExpiresAt", "lease_expires_at"),
        ("lastHeartbeatAt", "last_heartbeat_at"),
        ("queuedAt", "queued_at"),
        ("claimedAt", "claimed_at"),
        ("startedAt", "started_at"),
        ("pausedAt", "paused_at"),
        ("completedAt", "completed_at"),
        ("createdAt", "created_at"),
        ("updatedAt", "updated_at"),
    ] {
        value[name] = if row[column].is_null() {
            Value::Null
        } else {
            let ms = row[column]
                .as_js_string()
                .and_then(crate::wire::date_milliseconds)
                .context("Invalid time value")?;
            json!(crate::wire::date_iso_milliseconds(ms).context("Invalid time value")?)
        };
    }
    crate::settings::parse_response("taskDispatchCycleSummarySchema", Some(&value))
}
impl Repository {
    pub fn new(database: Arc<Database>) -> Self {
        Self { database }
    }
    async fn update(
        &self,
        fence: &Value,
        fields: Value,
        now: &str,
        update: Update<'_>,
    ) -> Result<Value> {
        let Update {
            predicate,
            extra,
            query_context,
        } = update;
        let assignments = fields
            .as_object()
            .context("Task dispatch fields")?
            .keys()
            .map(|key| format!("{key}=d.{key}"))
            .collect::<Vec<_>>()
            .join(",");
        let cycle = text(&fence["cycleId"])?;
        let operation = text(&fence["operationId"])?;
        let owner = text(&fence["leaseOwner"])?;
        let token = fence["fencingToken"].stringify();
        let fields = fields.stringify();
        let rows=self.database.query(&format!("UPDATE task_dispatch_cycles c SET {assignments}{extra} FROM jsonb_populate_record(NULL::task_dispatch_cycles,$6::text::jsonb) d WHERE c.id=$1 AND c.operation_id=$2 AND c.lease_owner=$3 AND c.fencing_token=$4::text::bigint AND c.lease_expires_at>$5::text::timestamptz AND ({predicate}) RETURNING to_jsonb(c)::text"),&[&cycle,&operation,&owner,&token,&now,&fields]).await;
        let rows = if let Some((key, params)) = query_context {
            crate::database::task_pause_queries::context(rows, key, params)?
        } else {
            rows?
        };
        let row = rows.first().ok_or_else(Conflict::stale)?;
        Ok(serde_json::from_str(&row.get::<String>(0)?)?)
    }
    pub async fn mark_running(&self, fence: &Value, options: &Value) -> Result<Value> {
        let now = clock(options)?;
        let mut fields = json!({"state":"running","last_heartbeat_at":now,"updated_at":now});
        copy(&mut fields, "turn_id", options, "turnId");
        if crate::wire::coercion::truthy(options.get("affinity")) {
            for (target, source) in [
                ("worktree_id", "worktreeId"),
                ("codex_thread_id", "threadId"),
                ("model_route_id", "modelRouteId"),
                ("provider_account_id", "providerAccountId"),
            ] {
                copy(&mut fields, target, &options["affinity"], source);
            }
        }
        summary(
            &self
                .update(
                    fence,
                    fields,
                    &now,
                    Update {
                        predicate: "c.state IN ('claimed','running')",
                        extra: ",started_at=coalesce(c.started_at,$5::text::timestamptz)",
                        query_context: None,
                    },
                )
                .await?,
        )
    }
    pub async fn heartbeat(&self, fence: &Value, options: &Value) -> Result<Value> {
        let now = clock(options)?;
        let lease = options
            .get("leaseMs")
            .filter(|v| !v.is_null())
            .map_or(Some(LEASE_MS as f64), Value::as_f64);
        let lease = lease
            .filter(|v| {
                v.is_finite() && v.fract() == 0.0 && *v > 0.0 && *v <= 9_007_199_254_740_991.0
            })
            .context("Task dispatch lease duration must be positive.")?;
        let start =
            crate::wire::date_milliseconds(&now.clone().into()).context("Invalid time value")?;
        let expires = start as f64 + lease;
        let expires = if expires.abs() <= 8.64e15 {
            crate::wire::date_iso_milliseconds(expires.trunc() as i64)
        } else {
            None
        }
        .context("Invalid time value")?;
        let parameters = vec![
            json!(expires),
            json!(now),
            json!(now),
            fence["cycleId"].clone(),
            fence["operationId"].clone(),
            fence["leaseOwner"].clone(),
            fence["fencingToken"].clone(),
            json!(now),
            json!("claimed"),
            json!("running"),
        ];
        self.update(
            fence,
            json!({"lease_expires_at":expires,"last_heartbeat_at":now,"updated_at":now}),
            &now,
            Update {
                predicate: "c.state IN ('claimed','running')",
                extra: "",
                query_context: Some(("heartbeat", &parameters)),
            },
        )
        .await?;
        let mut value = fence.clone();
        value["leaseExpiresAt"] = json!(expires);
        crate::settings::parse_response("taskDispatchWorkerLeaseSchema", Some(&value))
    }
    pub async fn pause(
        &self,
        fence: &Value,
        affinity: &Value,
        options: &Value,
        unstarted: bool,
    ) -> Result<Value> {
        let now = clock(options)?;
        let mut fields =
            json!({"state":"paused","last_heartbeat_at":now,"paused_at":now,"updated_at":now});
        copy(&mut fields, "codex_thread_id", affinity, "threadId");
        copy(&mut fields, "turn_id", affinity, "turnId");
        let mut parameters = vec![
            json!("paused"),
            affinity["threadId"].clone(),
            affinity["turnId"].clone(),
            json!(now),
            json!(now),
            json!(now),
            fence["cycleId"].clone(),
            fence["operationId"].clone(),
            fence["leaseOwner"].clone(),
            fence["fencingToken"].clone(),
            json!(now),
            json!("claimed"),
        ];
        if !unstarted {
            parameters.push(json!("running"));
        }
        summary(
            &self
                .update(
                    fence,
                    fields,
                    &now,
                    Update {
                        predicate: if unstarted {
                            "c.state='claimed' AND c.started_at IS NULL"
                        } else {
                            "c.state IN ('claimed','running')"
                        },
                        extra: if unstarted {
                            ",fencing_token=c.fencing_token+1"
                        } else {
                            ""
                        },
                        query_context: Some((
                            if unstarted { "unstarted" } else { "pause" },
                            &parameters,
                        )),
                    },
                )
                .await?,
        )
    }
    pub async fn settle(&self, fence: &Value, state: &str, options: &Value) -> Result<Value> {
        let now = clock(options)?;
        let parameters = vec![
            json!(state),
            json!(now),
            json!(now),
            fence["cycleId"].clone(),
            fence["operationId"].clone(),
            fence["leaseOwner"].clone(),
            fence["fencingToken"].clone(),
            json!(now),
            json!("claimed"),
            json!("running"),
            json!("paused"),
        ];
        summary(
            &self
                .update(
                    fence,
                    json!({"state":state,"completed_at":now,"updated_at":now}),
                    &now,
                    Update {
                        predicate: "c.state IN ('claimed','running','paused')",
                        extra: "",
                        query_context: Some(("settle", &parameters)),
                    },
                )
                .await?,
        )
    }
}
