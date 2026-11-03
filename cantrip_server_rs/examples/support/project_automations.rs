use anyhow::{Context, Result};
use cantrip_server::{
    database::Database,
    project_automations::repository::{DispatchLease, Repository},
    wire::Value,
};
use chrono::{TimeZone, Utc};
use std::sync::Arc;

fn date(ms: i64) -> Value {
    Value::String(
        Utc.timestamp_millis_opt(ms)
            .single()
            .unwrap()
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
            .into(),
    )
}
fn milliseconds(v: &Value) -> Result<i64> {
    Ok(
        chrono::DateTime::parse_from_rfc3339(v.as_str().context("Fixture date")?)?
            .timestamp_millis(),
    )
}
fn lease(v: &Value) -> Result<DispatchLease> {
    Ok(DispatchLease {
        automation: v["automation"].clone(),
        dispatch_instance_id: v["dispatchInstanceId"].as_str().context("Instance")?.into(),
        fencing_token: v["fencingToken"].as_f64().context("Fence")? as i64,
        lease_token: v["leaseToken"].as_str().context("Lease token")?.into(),
        next_run_at: if v["nextRunAt"].is_null() {
            None
        } else {
            Some(milliseconds(&v["nextRunAt"])?)
        },
        run_id: v["runId"].as_str().context("Run")?.into(),
        reasoning_effort: v["reasoningEffort"].clone(),
        scheduled_for: milliseconds(&v["scheduledFor"])?,
    })
}
fn serialize(lease: DispatchLease) -> Value {
    Value::object([
        ("automation", lease.automation),
        (
            "dispatchInstanceId",
            Value::String(lease.dispatch_instance_id.into()),
        ),
        ("fencingToken", Value::from_serialize(&lease.fencing_token)),
        ("leaseToken", Value::String(lease.lease_token.into())),
        (
            "nextRunAt",
            lease.next_run_at.map(date).unwrap_or(Value::Null),
        ),
        ("runId", Value::String(lease.run_id.into())),
        ("reasoningEffort", lease.reasoning_effort),
        ("scheduledFor", date(lease.scheduled_for)),
    ])
}
pub async fn run(database: Arc<Database>, input: &Value) -> Result<Value> {
    let r = Repository::new(database);
    let key = |key: &str| {
        input[key]
            .as_str()
            .with_context(|| format!("Fixture {key}"))
    };
    let value = match key("op")? {
        "automation-create" => r
            .create(key("owner")?, key("project")?, &input["input"])
            .await?
            .unwrap_or(Value::Null),
        "automation-list" => r.list(key("owner")?, key("project")?).await?,
        "automation-list-worker" => r.list_for_worker(key("owner")?, key("worker")?).await?,
        "automation-get" => r
            .get(key("owner")?, key("automationId")?)
            .await?
            .unwrap_or(Value::Null),
        "automation-update" => r
            .update(key("owner")?, key("automationId")?, &input["input"])
            .await?
            .unwrap_or(Value::Null),
        "automation-delete" => Value::Bool(r.delete(key("owner")?, key("automationId")?).await?),
        "automation-claim" => r
            .claim_due_at(
                key("owner")?,
                key("worker")?,
                key("automationId")?,
                &input["input"],
                key("instance")?,
                input["ttlMs"].as_f64().context("TTL")? as i64,
                milliseconds(&input["now"])?,
            )
            .await?
            .map(serialize)
            .unwrap_or(Value::Null),
        "automation-finish" => Value::Bool(
            r.finish_dispatch_at(
                &lease(&input["lease"])?,
                key("status")?,
                input["error"].as_js_string(),
                milliseconds(&input["now"])?,
            )
            .await?,
        ),
        _ => anyhow::bail!("Unknown automation fixture operation"),
    };
    Ok(value)
}
