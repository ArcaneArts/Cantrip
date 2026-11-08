//! Opaque Task operation metadata is checked without opening encrypted content.
use super::{Parsed, ValidationError, Value, value::json};

fn goal_operation_matches(operation: &Value, thread: &Value, turn: &Value, cycle: &Value) -> bool {
    let mut expected = "native-inference:".encode_utf16().collect::<Vec<_>>();
    for (index, part) in [thread, turn, &cycle["scopeId"], &cycle["gateAttemptId"]]
        .iter()
        .enumerate()
    {
        let Some(text) = part.as_js_string() else {
            return false;
        };
        if index > 0 {
            expected.push(u16::from(b':'));
        }
        expected.extend_from_slice(text.units());
    }
    operation
        .as_js_string()
        .is_some_and(|operation| operation.units() == expected.as_slice())
}

fn private_goal_source(record: &Value) -> bool {
    let identity = &record["identity"];
    let recovery = &identity["recovery"];
    let cycle = &recovery["taskGoalCycle"];
    let truthy = super::coercion::truthy;
    if cycle.is_null()
        || !truthy(identity.get("chatId"))
        || !truthy(recovery.get("threadId"))
        || !truthy(recovery.get("turnId"))
        || [
            "messageId",
            "commandId",
            "commandGeneration",
            "taskInput",
            "autonomousGoal",
        ]
        .iter()
        .any(|key| truthy(recovery.get(key)))
    {
        return false;
    }
    goal_operation_matches(
        &identity["operationId"],
        &recovery["threadId"],
        &recovery["turnId"],
        cycle,
    ) && (!truthy(record.get("nativeExecution"))
        || (record["nativeExecution"].get("threadId") == recovery.get("threadId")
            && record["nativeExecution"].get("turnId") == recovery.get("turnId")
            && record["nativeExecution"].get("scopeId") == cycle.get("scopeId")))
}
fn goal_input_source(record: &Value) -> bool {
    let identity = &record["identity"];
    let recovery = &identity["recovery"];
    let input = &recovery["taskInput"];
    let truthy = super::coercion::truthy;
    input["kind"] == "goal"
        && truthy(recovery.get("threadId"))
        && [
            "turnId",
            "commandId",
            "commandGeneration",
            "taskGoalCycle",
            "autonomousGoal",
        ]
        .iter()
        .all(|key| !truthy(recovery.get(key)))
        && !truthy(record.get("nativeExecution"))
        && identity.get("operationId") == input.get("operationId")
        && identity.get("chatId") == input.get("chatId")
        && identity.get("providerId") == input.get("providerId")
        && recovery.get("messageId") == input.get("clientMessageId")
}

pub(super) fn refine(
    tag: &str,
    result: &mut Parsed,
    path: &[Value],
) -> Result<bool, ValidationError> {
    if !matches!(
        tag,
        "task-input-native-binding"
            | "task-goal-suspension-source"
            | "task-goal-turn-resumption"
            | "task-goal-outcome-delivery"
            | "task-goal-outcome-commit"
            | "task-operation-start"
            | "task-operation-result"
            | "task-goal-worker-result"
            | "chat-placement-create"
            | "encrypted-task-create"
            | "encrypted-chat-create"
            | "chat-root-model"
            | "chat-goal-update"
            | "agent-sync-user-message"
            | "task-goal-cycle-source"
            | "task-goal-cycle-capture"
            | "task-goal-input-source"
            | "task-goal-input-capture"
            | "task-goal-handoff-source"
            | "task-workload-chat-binding"
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
        "task-workload-chat-binding" => {
            if value["plan"]["chatId"] != value["task"]["chatId"]
                || value["messages"]
                    .as_array()
                    .ok_or(ValidationError::Operation)?
                    .iter()
                    .any(|message| message["chatId"] != value["task"]["chatId"])
            {
                custom(
                    &[],
                    "Task workload material must belong to the same Task Chat.",
                );
            }
        }
        "task-goal-suspension-source" => {
            if value["parent"]["kind"] != "goal"
                || value["parent"]["dispatch"]["cycleId"] != value["cycle"]["cycleId"]
                || !goal_operation_matches(
                    &value["operationId"],
                    &value["threadId"],
                    &value["turnId"],
                    &value["cycle"],
                )
            {
                custom(
                    &["parent"],
                    "Goal cycle suspension must retain its actual native execution and canonical parent.",
                );
            }
        }
        "task-goal-turn-resumption" => {
            let cycle = &value["goalCycle"];
            if !cycle.is_null()
                && (cycle["parent"].stringify() != value["source"].stringify()
                    || cycle["threadId"] != value["checkpoint"]["suspension"]["threadId"]
                    || cycle["turnId"] != value["checkpoint"]["suspension"]["turnId"])
            {
                custom(
                    &["goalCycle"],
                    "The Goal restoration must retain its canonical parent and exact native turn.",
                );
            }
        }
        "task-goal-outcome-delivery" => {
            let source = &value["goalCycleSource"];
            if (value["inputKind"] == "goal-cycle") == source.is_null()
                || (!source.is_null()
                    && (super::coercion::truthy(
                        value["notification"].get("taskInferenceInputOperationId"),
                    ) || value["notification"]["chatId"] != source["parent"]["chatId"]
                        || value["notification"]["clientMessageId"]
                            != source["parent"]["clientMessageId"]))
            {
                custom(
                    &["goalCycleSource"],
                    "An autonomous Goal result must retain its actual source without inventing input.",
                );
            }
        }
        "task-goal-outcome-commit" => {
            if super::coercion::truthy(value.get("taskInferenceInputOperationId"))
                == super::coercion::truthy(value.get("goalCycleSourceKey"))
            {
                custom(
                    &[],
                    "A committed outcome must name exactly one physical source.",
                );
            }
        }
        "task-input-native-binding" => {
            let native = value["phase"] == "native";
            if native != super::coercion::truthy(value.get("nativeExecution"))
                || native != super::coercion::truthy(value.get("nativeRuntimeGeneration"))
            {
                custom(
                    &["nativeExecution"],
                    "Only native binding requires its actual execution identity.",
                );
            }
        }
        "task-goal-cycle-source" => {
            if !private_goal_source(&value) {
                custom(&[], "Invalid private Task Goal source");
            }
        }
        "task-goal-input-source" => {
            if !goal_input_source(&value) {
                custom(&[], "Invalid unused Task Goal input source");
            }
        }
        "task-goal-handoff-source" => {
            if super::coercion::truthy(value.get("taskGoalInput"))
                != (value["taskGoal"]["identity"]["recovery"]["taskInput"]["kind"] == "goal")
            {
                custom(
                    &[],
                    "Task Goal input context must match its actual receipt source",
                );
            }
        }
        "task-goal-cycle-capture" | "task-goal-input-capture" => {
            let record = &value["record"];
            let context = &value["snapshot"]["context"];
            if !matches!(record["state"].as_str(), Some("waiting" | "granted"))
                || !record["outcome"].is_null()
                || record["identity"].get("chatId") != context.get("chatId")
                || record["identity"]["recovery"].get("threadId") != context.get("threadId")
            {
                custom(
                    &[],
                    if tag == "task-goal-input-capture" {
                        "The snapshot does not capture an unused Task Goal input"
                    } else {
                        "The native snapshot does not capture a pending Task Goal source"
                    },
                );
            }
        }
        "agent-sync-user-message" => {
            if value["text"]
                .as_js_string()
                .is_some_and(|text| text.trim().is_empty())
                && value["externalAttachmentIds"]
                    .as_array()
                    .is_some_and(Vec::is_empty)
            {
                custom(&[], "User messages require text or an external attachment.");
            }
        }
        "chat-goal-update" => {
            if value.get("status").is_none() && value.get("protectedObjective").is_none() {
                custom(&[], "A goal update needs a status or encrypted objective.");
            }
        }
        "chat-root-model" => {
            if value["modelId"].is_null() {
                // The generated refine check already includes its declared path.
                custom(&[], "A root model must be selected.");
            }
        }
        "chat-placement-create" => {
            if crate::wire::coercion::truthy(value.get("cantripOsBindingId"))
                && (crate::wire::coercion::truthy(value.get("worktreeId"))
                    || crate::wire::coercion::truthy(value.get("target")))
            {
                custom(
                    &["cantripOsBindingId"],
                    "An OS binding already selects its exact worktree; do not also supply another target.",
                );
            }
            if crate::wire::coercion::truthy(value.get("worktreeId"))
                && crate::wire::coercion::truthy(value.get("target"))
            {
                custom(
                    &[],
                    "Choose either a legacy worktreeId or an execution target.",
                );
            }
            if ["paneId", "tabGroupId", "targetRegion"]
                .iter()
                .filter(|key| value.get(key).is_some())
                .count()
                > 1
            {
                custom(
                    &["paneId"],
                    "Specify only one of paneId, the deprecated tabGroupId, or targetRegion.",
                );
            }
        }
        "encrypted-chat-create" => {
            if value["titleProtection"]["classification"]["recordKind"] != "chat" {
                custom(
                    &["titleProtection", "classification", "recordKind"],
                    "Chat title classification must be chat.",
                );
            }
        }
        "encrypted-task-create" => {
            let c = &value["task"]["classification"];
            if c["state"] != "draft"
                || !c["stableStateBeforeFailure"].is_null()
                || !c["activeOperationKind"].is_null()
                || c["planAuthorship"] != "agent"
                || c["planningRound"] != 0
                || c["hasPlan"] == true
                || c["hasQuestions"] == true
                || c["hasFinalPlan"] == true
                || c["hasGoalPrompt"] == true
                || !c["lastError"].is_null()
            {
                custom(
                    &["task", "classification"],
                    "A new encrypted Task must begin as an empty draft.",
                );
            }
            if value["titleProtection"]["classification"]["recordKind"] != "chat" {
                custom(
                    &["titleProtection", "classification", "recordKind"],
                    "Task title classification must be chat.",
                );
            }
        }
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
