//! Exact native counterpart of the durable suspension record's semantic checks.
use super::{Parsed, ValidationError, Value, value::json};

pub(super) fn refine(
    tag: &str,
    result: &mut Parsed,
    path: &[Value],
) -> Result<bool, ValidationError> {
    if tag != "native-suspension-record" {
        return Ok(false);
    }
    let value = result.value.as_ref().ok_or(ValidationError::Operation)?;
    let phase = value["phase"].as_str().unwrap_or_default();
    let checkpoint = !value["checkpoint"].is_null();
    let active = !value["active"].is_null();
    let task = &value["target"]["taskRound"];
    if !task.is_null()
        && (value["target"]["contextKind"] != "project"
            || !super::coercion::truthy(value["target"].get("projectId"))
            || !super::coercion::truthy(value["target"].get("executionLaneId"))
            || value["target"]["originalOperationId"] != task["inputOperationId"])
    {
        let mut at = path.to_vec();
        at.extend([json!("target"), json!("taskRound")]);
        result.issues.push(json!({"code":"custom","path":at,"message":"A Task suspension must retain its canonical input and project lane."}));
    }
    let cycle = &value["target"]["taskGoalCycle"];
    if !cycle.is_null()
        && (!task.is_null()
            || value["target"]["contextKind"] != "project"
            || !super::coercion::truthy(value["target"].get("projectId"))
            || !super::coercion::truthy(value["target"].get("executionLaneId"))
            || value["target"]["originalOperationId"] != cycle["operationId"])
    {
        let mut at = path.to_vec();
        at.extend([json!("target"), json!("taskGoalCycle")]);
        result.issues.push(json!({"code":"custom","path":at,"message":"An autonomous Goal suspension must retain its own execution and project lane."}));
    }
    for (invalid, field, message) in [
        (
            !value["actorControlId"].is_null()
                && (value["actorControlId"] != value["controlId"] || value["actor"].is_null()),
            "actorControlId",
            "An actor claim must belong to the current control.",
        ),
        (
            phase == "paused" && !checkpoint,
            "checkpoint",
            "A durable paused turn requires its committed checkpoint.",
        ),
        (
            phase == "resuming" && !checkpoint && (value["action"] != "resume" || !active),
            "active",
            "A live Resume requires its original active turn and resume intent.",
        ),
        (
            checkpoint
                && value["target"]["threadId"] != value["checkpoint"]["suspension"]["threadId"],
            "checkpoint",
            "A checkpoint must belong to its exact source thread.",
        ),
        (
            checkpoint
                && (value["active"]["threadId"] != value["checkpoint"]["suspension"]["threadId"]
                    || value["active"]["turnId"] != value["checkpoint"]["suspension"]["turnId"]),
            "active",
            "A checkpoint must retain the original native turn identity.",
        ),
        (
            active && value["active"]["threadId"] != value["target"]["threadId"],
            "active",
            "An active turn must belong to its exact source thread.",
        ),
        (
            matches!(phase, "stopped" | "completed" | "failed" | "idle") && checkpoint,
            "checkpoint",
            "Terminal or idle turns cannot retain resumability.",
        ),
        (
            phase == "error" && value["error"].is_null(),
            "error",
            "A recovery error requires an explicit error code.",
        ),
    ] {
        if invalid {
            let mut at = path.to_vec();
            at.push(json!(field));
            result
                .issues
                .push(json!({"code":"custom","path":at,"message":message}));
        }
    }
    Ok(true)
}
