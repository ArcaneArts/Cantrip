//! Existing canonical admission identities; no execution authority is inferred.
use cantrip_wire::{JsString, Value, coercion, value::json};
use sha2::{Digest, Sha256};
fn field(value: &Value, name: &str) -> Value {
    value.get(name).cloned().unwrap_or(Value::Null)
}
fn zero(value: &Value, name: &str) -> Value {
    value
        .get(name)
        .filter(|v| !v.is_null())
        .cloned()
        .unwrap_or(json!(0))
}
pub fn digest(value: &Value) -> String {
    Sha256::digest(value.stringify().as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
pub fn key(worker: &JsString, runtime: &JsString, operation: &JsString) -> String {
    digest(&json!([worker, runtime, operation]))
}
pub fn recovery(value: &Value) -> String {
    let mut out = [
        "commandId",
        "commandGeneration",
        "messageId",
        "threadId",
        "turnId",
    ]
    .map(|k| field(value, k))
    .to_vec();
    let task = &value["taskInput"];
    out.push(if coercion::truthy(Some(task)) {
        let mut task_values = [
            "operationId",
            "chatId",
            "clientMessageId",
            "workerId",
            "worktreeId",
            "executionLaneId",
            "executionLaneActivatedAt",
            "providerId",
            "modelRouteId",
            "providerAccountId",
        ]
        .map(|k| field(task, k))
        .to_vec();
        task_values.extend(
            ["cycleId", "operationId", "leaseOwner", "fencingToken"]
                .map(|k| field(&task["dispatch"], k)),
        );
        Value::Array(task_values)
    } else {
        Value::Null
    });
    out.push(field(&value["autonomousGoal"], "goalEpoch"));
    if coercion::truthy(value.get("autonomousGoal")) {
        out.push(zero(&value["autonomousGoal"], "orderEpoch"));
    }
    if coercion::truthy(value.get("taskGoalCycle")) {
        out.extend(
            [
                "cycleId",
                "goalEpoch",
                "scopeId",
                "gateAttemptId",
                "runnerGeneration",
                "modelRouteId",
                "providerAccountId",
                "orderEpoch",
            ]
            .map(|k| field(&value["taskGoalCycle"], k)),
        );
    }
    Value::Array(out).stringify()
}
pub fn queue(chat: &Value, value: &Value) -> Option<String> {
    let yes = |v: &Value, k: &str| coercion::truthy(v.get(k));
    if !coercion::truthy(Some(chat)) || !coercion::truthy(Some(value)) {
        return None;
    }
    let f = |k| field(value, k);
    let goal = &value["taskGoalCycle"];
    if yes(value, "taskGoalCycle") {
        if [
            "messageId",
            "commandId",
            "commandGeneration",
            "taskInput",
            "autonomousGoal",
        ]
        .iter()
        .any(|k| yes(value, k))
            || !yes(value, "threadId")
            || !yes(value, "turnId")
        {
            return None;
        }
        return Some(
            json!([
                json!("task-goal"),
                chat.clone(),
                field(goal, "cycleId"),
                f("threadId"),
                field(goal, "goalEpoch"),
                field(goal, "orderEpoch")
            ])
            .stringify(),
        );
    }
    let goal = &value["autonomousGoal"];
    if yes(value, "autonomousGoal") {
        if yes(value, "messageId")
            || yes(value, "taskInput")
            || ["threadId", "turnId", "commandId", "commandGeneration"]
                .iter()
                .any(|k| !yes(value, k))
            || !yes(goal, "goalEpoch")
        {
            return None;
        }
        return Some(
            json!([
                json!("goal"),
                chat.clone(),
                f("threadId"),
                field(goal, "goalEpoch"),
                zero(goal, "orderEpoch")
            ])
            .stringify(),
        );
    }
    let task = &value["taskInput"];
    if yes(value, "messageId")
        && yes(value, "taskInput")
        && !yes(task, "kind")
        && coercion::number(Some(&zero(task, "queueOrderEpoch"))).unwrap_or(f64::NAN) > 0.
    {
        return Some(
            json!([
                json!("message"),
                chat.clone(),
                f("messageId"),
                json!("task-round-episode"),
                field(task, "queueOrderEpoch")
            ])
            .stringify(),
        );
    }
    yes(value, "messageId")
        .then(|| json!([json!("message"), chat.clone(), f("messageId")]).stringify())
}
