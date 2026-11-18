//! Prepare Task inputs and their failure records inside the trusted worker.
use crate::{
    encryption::{BoundComponentKey, Service},
    http::checked,
    native_items::concat,
};
use anyhow::{Result, bail};
use cantrip_crypto::{
    blind_lookup_tag,
    content::{Communication, decrypt_communication, encrypt_communication},
    derive_lookup_key,
};
use cantrip_wire::{JsString, Value, value::json};

const MESSAGE: &str = "task.message.protect";
const PREPARE: &str = "task.operation.prepare";
const COMPONENT: &str = "task-content";

pub(crate) fn supports(kind: &str) -> bool {
    matches!(kind, MESSAGE | PREPARE)
}

pub(crate) fn execute(service: &Service, command: &Value) -> Result<Value> {
    let task = service.bound_component(COMPONENT, None)?;
    let context = json!({"ownerId":task.owner_id,"keyRevision":task.component.key_revision});
    let result = match command["type"].as_str() {
        Some(MESSAGE) => protect_message(service, &task, &context, &command["message"]),
        Some(PREPARE) => prepare(&task, &context, command),
        _ => bail!("Unsupported protected Task command."),
    }?;
    let (owner, server) = service.bound_identity()?;
    if owner != task.owner_id || server != task.server_id {
        bail!("The worker binding changed during protected Task processing.");
    }
    Ok(result)
}

fn protect_message(
    service: &Service,
    task: &BoundComponentKey,
    context: &Value,
    message: &Value,
) -> Result<Value> {
    let chat = service.bound_component("chat-content", None)?;
    if chat.owner_id != task.owner_id || chat.server_id != task.server_id {
        bail!("The worker binding changed during protected Task processing.");
    }
    let content = decrypt_communication(
        Communication::Message,
        &chat.component.key,
        &json!({
            "ownerId": chat.owner_id, "messageId": message["id"],
            "keyRevision": message["protectedContent"]["keyRevision"],
        }),
        &message["protectedContent"],
        message.get("classification"),
    )?;
    let mut protected = message.clone();
    let mut context = context.clone();
    context["messageId"] = message["id"].clone();
    protected["protectedContent"] = encrypt_communication(
        Communication::TaskMessage,
        &task.component.key,
        &context,
        &content,
    )?;
    checked("taskMessageOpaqueContentSchema", &protected)
}

fn prepare(task: &BoundComponentKey, context: &Value, command: &Value) -> Result<Value> {
    let summary = &command["task"];
    if summary["protectedContent"]["keyRevision"] != context["keyRevision"] {
        bail!("The Task encryption key revision is unavailable.");
    }
    let mut context = context.clone();
    context["chatId"] = summary["chatId"].clone();
    context["roundId"] = command["operationId"].clone();
    let key = &task.component.key;
    let classification = Value::object(
        [
            "state",
            "stableStateBeforeFailure",
            "activeOperationKind",
            "planAuthorship",
            "planningRound",
            "hasPlan",
            "hasQuestions",
            "hasFinalPlan",
            "hasGoalPrompt",
            "lastError",
        ]
        .map(|field| (field, summary[field].clone())),
    );
    let current = decrypt_communication(
        Communication::Task,
        key,
        &context,
        &summary["protectedContent"],
        Some(&classification),
    )?;
    let kind = &command["operationKind"];
    let (stable, state, mode) = match kind.as_str() {
        Some("direct") => ("draft", "implementing", "default"),
        Some("initial-plan") => ("draft", "planning", "plan"),
        Some("continue-plan") => ("review", "planning", "plan"),
        Some("finalize") => ("review", "finalizing", "plan"),
        _ => bail!("Unsupported protected Task operation kind."),
    };
    let ordinal = current["classification"]["planningRound"].as_f64().unwrap() + 1.0;
    let mut round = checked(
        "taskPlanningRoundProtectedContentSchema",
        &json!({
            "version": 1,
            "classification": json!({
                "ordinal": ordinal, "kind": kind, "status": "running",
                "hasOutputPlan": false, "hasOutputQuestions": false, "hasOutputGoalPrompt": false,
                "error": Value::Null,
            }),
            "inputBriefMarkdown": current["briefMarkdown"],
            "inputPlanMarkdown": current["planMarkdown"],
            "inputQuestions": current["currentQuestions"],
            "inputAnswers": current["currentAnswers"],
            "additionalDirection": current["additionalDirection"],
            "outputPlanMarkdown": Value::Null, "outputQuestions": Vec::<Value>::new(),
            "outputGoalPrompt": Value::Null, "error": Value::Null,
        }),
    )?;
    let mut running = current;
    running["classification"]["state"] = json!(state);
    running["classification"]["stableStateBeforeFailure"] = json!(stable);
    running["classification"]["activeOperationKind"] = kind.clone();
    running["classification"]["planningRound"] = json!(ordinal);
    running["classification"]["lastError"] = Value::Null;
    running["lastError"] = Value::Null;
    let mut running = checked("taskProtectedContentSchema", &running)?;

    let id = uuid::Uuid::new_v4().to_string();
    context["messageId"] = json!(id);
    let user_classification =
        json!({"role":"user","mode":mode,"attachmentIds":Vec::<Value>::new()});
    let input = json!({
        "version": 1, "classification": user_classification,
        "content": vec![json!({"type":"text","phase":"final_answer","text":operation_message(kind, &running)})],
    });
    let user_message = checked(
        "taskMessageOpaqueContentSchema",
        &json!({
            "id": id, "classification": user_classification,
            "protectedContent": encrypt_communication(Communication::TaskMessage, key, &context, &input)?,
            "reasoningEffort": Value::Null,
            "idempotencyKey": format!("task-operation:{}", command["operationId"].as_str().unwrap()),
        }),
    )?;
    let lookup = derive_lookup_key(
        key,
        &json!({
            "ownerId": context["ownerId"], "keyRevision": context["keyRevision"],
            "component": COMPONENT, "table": "task_planning_rounds", "field": "operation_fingerprint",
        }),
    )?;
    let fingerprint = blind_lookup_tag(
        &lookup,
        &json!([
            json!(1),
            context["chatId"].clone(),
            command["operationId"].clone(),
            round.clone(),
            running.clone(),
            user_message.clone(),
        ])
        .stringify()
        .into(),
    )?;
    let operation = json!({
        "chatId": context["chatId"], "operationId": command["operationId"],
        "fingerprint": fingerprint, "classification": round["classification"],
        "protectedInput": encrypt_communication(Communication::TaskPlanningRound, key, &context, &round)?,
        "task": opaque(Communication::Task, key, &context, &running)?,
        "userMessage": user_message,
    });

    let occurred_at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let mut error = json!({
        "code":"task-operation-failed", "operationKind":kind, "occurredAt":occurred_at,
    });
    running["classification"]["state"] = json!("failed");
    running["classification"]["activeOperationKind"] = Value::Null;
    running["classification"]["lastError"] = error.clone();
    round["classification"]["status"] = json!("failed");
    round["classification"]["error"] = error.clone();
    error["message"] = json!("The Task operation failed. You can retry it.");
    running["lastError"] = error.clone();
    round["error"] = error;

    checked(
        "taskEncryptedOperationStartSchema",
        &json!({
            "rowVersion": summary["rowVersion"],
            "operation": operation,
            "failure": json!({
                "task": opaque(Communication::Task, key, &context, &running)?,
                "round": opaque(Communication::TaskPlanningRound, key, &context, &round)?,
            }),
        }),
    )
}

fn opaque(kind: Communication, key: &[u8], context: &Value, content: &Value) -> Result<Value> {
    Ok(json!({
        "classification": content["classification"],
        "protectedContent": encrypt_communication(kind, key, context, content)?,
    }))
}

fn operation_message(kind: &Value, current: &Value) -> JsString {
    let brief = &current["briefMarkdown"];
    match kind.as_str() {
        Some("direct") => brief.as_js_string().unwrap().clone(),
        Some("initial-plan") => concat(&[
            "Plan this Task from the saved brief.\n\n".into(),
            brief.as_js_string().unwrap().clone(),
        ]),
        _ => {
            let prefix = if kind == "finalize" {
                "Finalize this Task plan for implementation.\n\n"
            } else {
                "Continue planning this Task.\n\n"
            };
            let direction = current["additionalDirection"]
                .as_js_string()
                .unwrap()
                .trim();
            let direction = if direction.is_empty() {
                "No additional direction was supplied.".into()
            } else {
                direction
            };
            concat(&[prefix.into(), direction])
        }
    }
}
