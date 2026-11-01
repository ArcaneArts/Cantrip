//! Opaque Task operation metadata is checked without opening encrypted content.
use super::{Parsed, ValidationError, Value, value::json};

pub(super) fn refine(
    tag: &str,
    result: &mut Parsed,
    path: &[Value],
) -> Result<bool, ValidationError> {
    if !matches!(
        tag,
        "task-operation-start" | "task-operation-result" | "task-goal-worker-result"
    ) {
        return Ok(false);
    }
    let value = result
        .value
        .as_ref()
        .ok_or(ValidationError::Operation)?
        .clone();
    let mut custom = |suffix: &[&str], message: &str| {
        let mut at = path.to_vec();
        at.extend(suffix.iter().map(|s| json!(s)));
        result
            .issues
            .push(json!({"code":"custom","message":message,"path":at}));
    };
    match tag {
        "task-goal-worker-result" => {
            if !value["message"].is_null()
                && (value["message"]["classification"]["role"] != "user"
                    || value["message"]["classification"]["mode"] != "goal")
            {
                custom(
                    &["message", "classification"],
                    "Encrypted Task Goal control messages must be user messages.",
                );
            }
        }
        "task-operation-start" => {
            let classification = &value["operation"]["classification"];
            let task = &value["operation"]["task"]["classification"];
            let failed = &value["failure"]["task"]["classification"];
            let round = &value["failure"]["round"]["classification"];
            let kind = &classification["kind"];
            let state = if kind == "direct" {
                "implementing"
            } else if kind == "finalize" {
                "finalizing"
            } else {
                "planning"
            };
            let stable = if kind == "direct" || kind == "initial-plan" {
                "draft"
            } else {
                "review"
            };
            if task["state"] != state
                || task["stableStateBeforeFailure"] != stable
                || task["activeOperationKind"] != *kind
                || task["planningRound"] != classification["ordinal"]
                || !task["lastError"].is_null()
            {
                custom(
                    &["operation", "task", "classification"],
                    "Encrypted Task operation state is inconsistent.",
                );
            }
            if failed["state"] != "failed"
                || failed["stableStateBeforeFailure"] != stable
                || !failed["activeOperationKind"].is_null()
                || failed["planningRound"] != classification["ordinal"]
                || failed["lastError"].get("operationKind") != Some(kind)
            {
                custom(
                    &["failure", "task", "classification"],
                    "Encrypted Task failure state is inconsistent.",
                );
            }
            if round["ordinal"] != classification["ordinal"]
                || round["kind"] != *kind
                || round["status"] != "failed"
                || round["error"].get("operationKind") != Some(kind)
            {
                custom(
                    &["failure", "round", "classification"],
                    "Encrypted planning-round failure state is inconsistent.",
                );
            }
        }
        "task-operation-result" => {
            let c = &value["classification"];
            let direct = c["kind"] == "direct";
            let finalizing = c["kind"] == "finalize";
            let goal = &value["goal"];
            if c["status"] != "completed"
                || c["hasOutputPlan"] == direct
                || (c["hasOutputQuestions"] == true && direct)
                || !c["error"].is_null()
                || c["hasOutputGoalPrompt"] != finalizing
                || goal.is_null() == finalizing
            {
                custom(
                    &["classification"],
                    "Encrypted Task relay result classification is inconsistent.",
                );
            }
            if !goal.is_null()
                && (goal["classification"]["chatId"] != value["chatId"]
                    || goal["classification"]["status"] != "active")
            {
                custom(
                    &["goal", "classification"],
                    "Encrypted Task Goal metadata does not match its operation.",
                );
            }
            let task = &value["task"]["classification"];
            if let Some(failure) = goal.get("failureTask") {
                let failed = &failure["classification"];
                if failed["state"] != "failed"
                    || failed["stableStateBeforeFailure"] != "review"
                    || !failed["activeOperationKind"].is_null()
                    || failed["planningRound"] != c["ordinal"]
                    || failed["planAuthorship"] != task["planAuthorship"]
                    || failed["hasPlan"] != true
                    || failed["hasQuestions"] != false
                    || failed["hasFinalPlan"] != true
                    || failed["hasGoalPrompt"] != true
                    || failed["lastError"].get("code") != Some(&json!("task-goal-start-failed"))
                    || failed["lastError"].get("operationKind") != Some(&json!("finalize"))
                    || failure["protectedContent"]["keyRevision"]
                        != value["task"]["protectedContent"]["keyRevision"]
                {
                    custom(
                        &["goal", "failureTask"],
                        "Encrypted Task Goal startup failure is inconsistent.",
                    );
                }
            }
            let state = if direct {
                "complete"
            } else if finalizing {
                "implementing"
            } else {
                "review"
            };
            let message = &value["assistantMessage"]["classification"];
            if task["state"] != state
                || !task["stableStateBeforeFailure"].is_null()
                || !task["activeOperationKind"].is_null()
                || task["planningRound"] != c["ordinal"]
                || task["hasPlan"] == direct
                || task["hasQuestions"] != c["hasOutputQuestions"]
                || task["hasFinalPlan"] != finalizing
                || task["hasGoalPrompt"] != finalizing
                || !task["lastError"].is_null()
                || message["role"] != "assistant"
                || message["mode"] != (if direct { "default" } else { "plan" })
            {
                custom(
                    &["task", "classification"],
                    "Encrypted Task result state is inconsistent.",
                );
            }
        }
        _ => unreachable!(),
    }
    Ok(true)
}
