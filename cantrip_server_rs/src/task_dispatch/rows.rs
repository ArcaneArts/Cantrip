use super::*;
pub(super) fn parse(name: &str, value: &Value) -> Result<Value> {
    crate::settings::parse_response(name, Some(value))
}
pub(super) async fn one(
    ex: Executor<'_, '_>,
    sql: &str,
    params: Parameters<'_>,
) -> Result<Option<Value>> {
    ex.query(sql, params)
        .await?
        .first()
        .map(|row| Ok(serde_json::from_str(&row.get::<String>(0)?)?))
        .transpose()
}
pub(super) async fn all(
    ex: Executor<'_, '_>,
    sql: &str,
    params: Parameters<'_>,
) -> Result<Vec<Value>> {
    ex.query(sql, params)
        .await?
        .iter()
        .map(|row| Ok(serde_json::from_str(&row.get::<String>(0)?)?))
        .collect()
}
pub(super) fn summaries(rows: &[Value]) -> Result<Value> {
    parse(
        "taskDispatchCycleListSchema",
        &Value::Array(rows.iter().map(summary).collect::<Result<Vec<_>>>()?),
    )
}
pub(super) async fn lock_owner(tx: &Transaction<'_>, owner: &str) -> Result<bool> {
    Ok(!tx
        .query(
            "SELECT id FROM users WHERE id=$1 LIMIT 1 FOR UPDATE",
            &[&owner],
        )
        .await?
        .is_empty())
}
pub(super) fn number_next(value: &Value) -> Result<Value> {
    Ok(json!(value.as_f64().context("Task counter")? + 1.0))
}
pub(crate) fn model_configuration(worker: &Value) -> Value {
    json!({"modelId":worker["model_id"],"reasoningEffort":worker["reasoning_effort"],"customSubagentModel":worker["custom_subagent_model"],"subagentModelId":worker["subagent_model_id"],"subagentReasoningEffort":worker["subagent_reasoning_effort"]})
}
pub(crate) fn worker_summary(worker: &Value, active: i64) -> Result<Value> {
    let mut value =
        json!({"modelConfiguration":model_configuration(worker),"activeTaskCount":active});
    for (key, column) in [
        ("id", "id"),
        ("name", "name"),
        ("enabled", "enabled"),
        ("maxConcurrency", "max_concurrency"),
        ("allowsPlanGoal", "allows_plan_goal"),
        ("continuityFamily", "continuity_family"),
        ("continuityFamilyOverride", "continuity_family_override"),
        ("position", "position"),
        ("rowVersion", "row_version"),
    ] {
        value[key] = worker[column].clone();
    }
    value["createdAt"] = crate::native_commands::receipt::iso(&worker["created_at"])?;
    value["updatedAt"] = crate::native_commands::receipt::iso(&worker["updated_at"])?;
    parse("taskWorkerSummarySchema", &value)
}
pub(super) fn lease(cycle: &Value) -> Result<Value> {
    parse(
        "taskDispatchWorkerLeaseSchema",
        &json!({"cycleId":cycle["id"],"operationId":cycle["operationId"],"leaseOwner":cycle["leaseOwner"],"leaseExpiresAt":cycle["leaseExpiresAt"],"fencingToken":cycle["fencingToken"]}),
    )
}
pub(super) fn expiry(now: &str, duration: f64) -> Result<String> {
    let at = crate::wire::date_milliseconds(&now.into()).context("Invalid time value")? as f64
        + duration;
    anyhow::ensure!(at.is_finite() && at.abs() <= 8.64e15, "Invalid time value");
    crate::wire::date_iso_milliseconds(at.trunc() as i64).context("Invalid time value")
}
pub(super) fn duration(options: &Value) -> Result<f64> {
    options
        .get("leaseMs")
        .filter(|v| !v.is_null())
        .map_or(Some(LEASE_MS as f64), Value::as_f64)
        .filter(|n| n.is_finite() && n.fract() == 0.0 && *n > 0.0 && *n <= 9_007_199_254_740_991.0)
        .context("Task dispatch lease duration must be positive.")
}
pub(super) fn capture_clock(options: &Value) -> Value {
    let mut captured = options
        .as_object()
        .map(|_| options.clone())
        .unwrap_or_else(|| Value::object([] as [(&str, Value); 0]));
    if captured.get("now").is_none_or(|v| v.is_null()) {
        captured["now"] =
            json!(crate::auth::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
    }
    captured
}
pub(super) fn identity(value: &str, message: &'static str) -> Result<()> {
    anyhow::ensure!(
        !crate::text::trim(value).is_empty() && value.encode_utf16().count() <= 200,
        "{message}"
    );
    Ok(())
}
pub(super) fn reset_fields(now: &str, reason: Value, clear_paused: bool) -> Value {
    let mut fields = json!({"state":"queued","eligibility_code":reason,"updated_at":now});
    for key in [
        "selected_task_worker_id",
        "task_worker_revision",
        "continuity_family",
        "model_configuration",
        "model_route_id",
        "provider_account_id",
        "physical_worker_id",
        "worktree_id",
        "codex_thread_id",
        "turn_id",
        "lease_owner",
        "lease_expires_at",
        "last_heartbeat_at",
        "claimed_at",
        "started_at",
        "completed_at",
    ] {
        fields[key] = Value::Null;
    }
    if clear_paused {
        fields["paused_at"] = Value::Null;
    }
    fields
}
pub(super) async fn change(
    ex: Executor<'_, '_>,
    id: &str,
    fields: &Value,
    state: Option<&str>,
    token: Option<&Value>,
    extra: &str,
) -> Result<Option<Value>> {
    let assignments = fields
        .as_object()
        .context("Task cycle columns")?
        .keys()
        .map(|k| format!("{k}=d.{k}"))
        .collect::<Vec<_>>()
        .join(",");
    let token = token.map(Value::stringify);
    one(ex,&format!("UPDATE task_dispatch_cycles c SET {assignments}{extra} FROM jsonb_populate_record(NULL::task_dispatch_cycles,$2::text::jsonb) d WHERE c.id=$1 AND ($3::text IS NULL OR c.state=$3) AND ($4::text IS NULL OR c.fencing_token=$4::text::bigint) RETURNING to_jsonb(c)::text"),&[&id,&fields.stringify(),&state,&token]).await
}
