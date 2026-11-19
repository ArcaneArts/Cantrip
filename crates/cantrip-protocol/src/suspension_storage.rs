//! Semantic checks for the Node worker's protected continuation records.
use super::{Parsed, ValidationError, Value, value::json};
use std::collections::HashSet;

fn array(value: &Value) -> &[Value] {
    value.as_array().map(Vec::as_slice).unwrap_or_default()
}

fn duplicate<'a>(values: impl Iterator<Item = &'a Value>) -> bool {
    let mut seen = HashSet::new();
    values
        .filter_map(Value::as_js_string)
        .any(|value| !seen.insert(value))
}

pub(super) fn refine(
    tag: &str,
    result: &mut Parsed,
    path: &[Value],
) -> Result<bool, ValidationError> {
    if !tag.starts_with("suspension-") {
        return Ok(false);
    }
    let value = result.value.as_ref().ok_or(ValidationError::Operation)?;
    let mut issue = |at: &[&str], message: &str| {
        let mut path = path.to_vec();
        path.extend(at.iter().map(|part| json!(*part)));
        result
            .issues
            .push(json!({"code":"custom","path":path,"message":message}));
    };
    match tag {
        "suspension-storage-source" => {
            let task = &value["taskInput"];
            let goal = &value["taskGoalCycle"];
            let project = value["contextKind"] == "project"
                && super::coercion::truthy(value.get("projectId"));
            if !goal.is_null()
                && (!task.is_null()
                    || !project
                    || goal["parent"]["chatId"] != value["chatId"]
                    || goal["threadId"] != value["threadId"]
                    || goal["parent"]["worktreeId"] != value["placementId"]
                    || goal["cycle"]["modelRouteId"] != value["modelRouteId"]
                    || goal["cycle"]["providerAccountId"] != value["providerAccountId"])
            {
                issue(
                    &["taskGoalCycle"],
                    "Goal checkpoint changed its canonical execution or placement.",
                );
            }
            if !task.is_null()
                && (!project
                    || task["chatId"] != value["chatId"]
                    || task["worktreeId"] != value["placementId"]
                    || task["modelRouteId"] != value["modelRouteId"]
                    || task["providerAccountId"] != value["providerAccountId"])
            {
                issue(
                    &["taskInput"],
                    "Task checkpoint source changed its canonical round or placement.",
                );
            }
        }
        "suspension-storage-snapshot" => {
            let receipt = &value["source"]["taskInput"];
            let goal = &value["source"]["taskGoalCycle"];
            let third = value["version"] == 3;
            let task = &value["task"];
            if third != (!receipt.is_null() || !goal.is_null()) {
                issue(
                    &["source", "taskInput"],
                    "Task checkpoints require their protected Task continuation.",
                );
            }
            if third && !receipt.is_null() {
                let different = if task["version"] == 1 {
                    receipt["kind"] == "goal"
                        || task["request"]["chatId"] != receipt["chatId"]
                        || task["request"]["operationId"] != receipt["dispatch"]["operationId"]
                        || task["request"]["userMessage"]["id"] != receipt["clientMessageId"]
                } else {
                    receipt["kind"] != "goal" || task["prompt"]["id"] != receipt["clientMessageId"]
                };
                if different {
                    issue(
                        &["task"],
                        "Task continuation belongs to another canonical input.",
                    );
                }
            }
            if third
                && !goal.is_null()
                && (task["version"] != 2
                    || task["prompt"]["id"] != goal["parent"]["clientMessageId"]
                    || task["publication"] != goal["publication"])
            {
                issue(
                    &["task"],
                    "Goal continuation changed its original publisher.",
                );
            }
        }
        "suspension-storage-record" => {
            if value["version"] == 3 && value["protectedSource"]["formatVersion"] != 2 {
                issue(
                    &["protectedSource"],
                    "Task checkpoints require Task-content protection.",
                );
            }
        }
        "suspension-worker-continuation" => {
            if value["startedAtMs"].as_f64() > value["capturedAtMs"].as_f64() {
                issue(&[], "Worker continuation begins after its capture.");
            }
            for field in [
                "baseline",
                "commandTelemetry",
                "fileStartedAtMs",
                "itemStartedAtMs",
                "pendingActivities",
                "reasoningSummaries",
            ] {
                if duplicate(
                    array(&value[field])
                        .iter()
                        .filter_map(|item| array(item).first()),
                ) {
                    issue(
                        &[field],
                        "Worker continuation contains duplicate map identities.",
                    );
                }
            }
            for field in [
                "completedCommandIds",
                "liveAgentMessageFingerprints",
                "observedActivityFingerprints",
            ] {
                if duplicate(array(&value[field]).iter()) {
                    issue(
                        &[field],
                        "Worker continuation contains duplicate set identities.",
                    );
                }
            }
            let model = &value["nativeModelAttribution"];
            if !model.is_null()
                && (model["threadId"] != value["threadId"] || model["turnId"] != value["turnId"])
            {
                issue(
                    &["nativeModelAttribution"],
                    "Worker model attribution belongs to another native turn.",
                );
            }
        }
        "suspension-round-continuation" => {
            let mode = if value["request"]["classification"]["kind"] == "direct" {
                "default"
            } else {
                "plan"
            };
            if value["events"]["mode"] != mode {
                issue(
                    &["events", "mode"],
                    "Task continuation changed its original round mode.",
                );
            }
        }
        "suspension-goal-continuation" => {
            if value["prompt"]["classification"]["mode"] != "goal"
                || value["events"]["mode"] != "goal"
            {
                issue(
                    &["events", "mode"],
                    "Goal continuation changed its original mode.",
                );
            }
        }
        "suspension-event-state" => {
            let ids = array(&value["ids"]);
            if duplicate(ids.iter().filter_map(|item| array(item).first()))
                || duplicate(ids.iter().filter_map(|item| array(item).get(1)))
            {
                issue(
                    &["ids"],
                    "Task event continuation contains duplicate identities.",
                );
            }
            let completed = &value["completedRootMessage"];
            let message = &completed["message"];
            if !completed.is_null()
                && (!ids
                    .iter()
                    .any(|item| array(item).get(1) == Some(&message["id"]))
                    || message["classification"]["role"] != "assistant"
                    || message["classification"]["mode"] != value["mode"])
            {
                issue(
                    &["completedRootMessage"],
                    "Task completion does not belong to its event continuation.",
                );
            }
        }
        _ => return Ok(false),
    }
    Ok(true)
}
