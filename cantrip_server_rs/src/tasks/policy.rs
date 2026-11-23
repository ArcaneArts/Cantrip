use super::*;
#[derive(Debug)]
pub struct StateTransitionError {
    pub from: String,
    pub to: String,
}
impl std::fmt::Display for StateTransitionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "A Task cannot transition from {} to {}.",
            self.from, self.to
        )
    }
}
impl std::error::Error for StateTransitionError {}
pub fn transition_error<T>(from: &str, to: &str) -> Result<T> {
    Err(StateTransitionError {
        from: from.into(),
        to: to.into(),
    }
    .into())
}
pub fn can_transition(from: &str, to: &str) -> bool {
    let states: &[&str] = match from {
        "draft" => &["planning", "implementing"],
        "planning" => &["review", "failed"],
        "review" => &["planning", "finalizing"],
        "finalizing" => &["implementing", "failed"],
        "implementing" => &["paused", "blocked", "complete", "failed"],
        "paused" => &["implementing", "blocked", "complete", "failed"],
        "blocked" => &["implementing", "complete", "failed"],
        "failed" => &[
            "planning",
            "finalizing",
            "implementing",
            "paused",
            "blocked",
        ],
        _ => &[],
    };
    states.contains(&to)
}
pub fn validate_start(state: &str, stable: Option<&str>, kind: &str) -> Result<Value> {
    let expected = if matches!(kind, "direct" | "initial-plan") {
        "draft"
    } else {
        "review"
    };
    let next = if kind == "direct" {
        "implementing"
    } else if kind == "finalize" {
        "finalizing"
    } else {
        "planning"
    };
    if state == "failed" {
        if stable != Some(expected) {
            return transition_error(state, next);
        }
    } else if state != expected || !can_transition(state, next) {
        return transition_error(state, next);
    }
    Ok(
        json!({"nextState":next,"stableState":if state=="failed" { stable.unwrap_or(expected) } else { expected }}),
    )
}
pub fn retry_summary(record: &Value, now: i64) -> Result<Value> {
    if record.is_null() || record["status"] == "idle" {
        return Ok(Value::Null);
    }
    let next = if record["status"] == "scheduled" && !record["dueAt"].is_null() {
        json!(
            crate::wire::date_iso_milliseconds(
                record["dueAt"]
                    .as_f64()
                    .filter(|v| v.is_finite() && v.abs() <= 8.64e15)
                    .map(|v| v.trunc() as i64)
                    .context("Invalid time value")?
            )
            .context("Invalid time value")?
        )
    } else {
        Value::Null
    };
    let recent = record["attempts"]
        .as_array()
        .context("Task retry attempts")?
        .iter()
        .filter(|v| v.as_f64().is_some_and(|n| n > (now - 60_000) as f64))
        .count();
    Ok(
        json!({"status":record["status"],"failureKind":record["failureKind"],"nextAttemptAt":next,"recentAttempts":recent}),
    )
}
pub fn schedule_retry(
    previous: Option<&Value>,
    failure_key: &str,
    failure_kind: &str,
    now: f64,
) -> Result<Value> {
    let previous = previous.filter(|v| !v.is_null());
    if let Some(previous) = previous.filter(|p| p["failureKey"] == failure_key) {
        return Ok(previous.clone());
    }
    let attempts = previous
        .and_then(|p| p.get("attempts"))
        .filter(|v| !v.is_null())
        .map(|v| v.as_array().context("Task retry attempts"))
        .transpose()?
        .map(|a| {
            a.iter()
                .filter(|at| at.as_f64().is_some_and(|at| at > now - 60_000.0))
                .cloned()
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let latched = previous.is_some_and(|p| p["status"] == "latched") || attempts.len() >= 5;
    let retryable = matches!(
        failure_kind,
        "timeout" | "capacity" | "rate-limit" | "connection" | "runtime"
    );
    Ok(
        json!({"status":if latched { "latched" } else if retryable { "scheduled" } else { "manual" },"failureKind":failure_kind,"failureKey":failure_key,"attempts":attempts,"claim":Value::Null,"dueAt":if !latched && retryable { json!(now+5000.0) } else { Value::Null }}),
    )
}
pub fn same_operation(request: &Value, prior: &Value) -> bool {
    ["chatId", "operationId", "fingerprint"]
        .iter()
        .all(|k| request[*k] == prior[*k])
        && ["kind", "ordinal"]
            .iter()
            .all(|k| request["classification"][*k] == prior["classification"][*k])
}
pub(super) fn assert_mutation(current: &Value, mutation: &Value) -> Result<()> {
    let next = &mutation["task"]["classification"];
    if [
        "state",
        "stableStateBeforeFailure",
        "activeOperationKind",
        "planningRound",
        "hasFinalPlan",
        "hasGoalPrompt",
    ]
    .iter()
    .any(|k| next[*k] != current[*k])
        || next["lastError"].stringify() != current["lastError"].stringify()
    {
        return conflict(
            "stale-version",
            "The encrypted Task mutation changed server-owned state.",
        );
    }
    Ok(())
}
