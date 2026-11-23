//! Endpoint-side Task state and encrypted Goal projection.
use crate::{
    http::checked,
    native_items::concat,
    task_content::{opaque, seal_message},
};
use anyhow::Result;
use cantrip_crypto::content::{Communication, encrypt_communication};
use cantrip_wire::{JsString, Value, value::json};

pub(super) fn started(
    key: &[u8],
    scope: &Value,
    current: &Value,
    context: &Value,
    native: &Value,
) -> Result<Value> {
    let (state, code, label) = projection(context, native);
    let mut task = current.clone();
    let persisted = if state.is_empty() {
        context["task"].clone()
    } else {
        let failure = &context["runtimeFailure"];
        let error = if code.is_empty() {
            Value::Null
        } else if current["lastError"]["operationKind"] == "implementation"
            && (current["lastError"]["code"] == code
                || current["lastError"]["code"] == format!("{code}-failed").as_str())
            && (failure.is_null() || current["lastError"]["occurredAt"] == failure["occurredAt"])
        {
            current["lastError"].clone()
        } else {
            json!({
                "code":code,"message":label,"operationKind":"implementation",
                "occurredAt":failure["occurredAt"].as_str().map_or_else(now, str::to_owned),
            })
        };
        classify(&mut task, state, Value::Null, error);
        if task == *current {
            context["task"].clone()
        } else {
            opaque(Communication::Task, key, scope, &task)?
        }
    };
    let mut sealed = Value::Null;
    let mut message = Value::Null;
    if !native.is_null() {
        let mut scope = scope.clone();
        scope["threadId"] = native["threadId"].clone();
        let classification = json!({"chatId":scope["chatId"],"threadId":native["threadId"],"status":native["status"]});
        sealed = native.clone();
        let Value::Object(fields) = &mut sealed else {
            unreachable!()
        };
        fields.shift_remove("objective");
        sealed["chatId"] = scope["chatId"].clone();
        sealed["protectedObjective"] = encrypt_communication(
            Communication::TaskGoalObjective,
            key,
            &scope,
            &json!({"version":1,"classification":classification,"objective":native["objective"]}),
        )?;
        let requested = &context["message"];
        if !requested.is_null() {
            let objective = native["objective"].as_js_string().unwrap();
            let prefix = if requested["kind"] == "resume" {
                "Resume Task Goal:\n\n"
            } else {
                "Begin Task Goal:\n\n"
            };
            let text = concat(&[JsString::from(prefix), objective.clone()]);
            scope["messageId"] = requested["id"].clone();
            message = seal_message(
                key,
                &scope,
                "user",
                "goal",
                &requested["idempotencyKey"],
                json!({"type":"text","phase":"final_answer","text":text}),
            )?;
        }
    }
    checked(
        "taskGoalWorkerResultSchema",
        &json!({"goal":sealed,"task":persisted,"message":message}),
    )
}

pub(super) fn failed(
    key: &[u8],
    scope: &Value,
    current: Value,
    continuation: bool,
    error: &anyhow::Error,
) -> Result<Value> {
    let mut task = current;
    let reason = error.to_string();
    let reason = reason.trim();
    let reason = if reason.is_empty() {
        ".".to_owned()
    } else {
        format!(": {reason}")
    };
    let (code, message, operation, stable) = if continuation {
        (
            "implementation-runtime-failed",
            format!(
                "Goal continuation failed{reason} The saved implementation plan and progress are retained. You can retry continuation without regenerating the saved plan."
            ),
            "implementation",
            Value::Null,
        )
    } else {
        let reason = if reason == "." {
            ". Implementation has not started."
        } else {
            reason.as_str()
        };
        (
            "task-goal-start-failed",
            format!(
                "Goal startup failed{reason} You can retry implementation without regenerating the saved plan."
            ),
            "finalize",
            json!("review"),
        )
    };
    let message = JsString::new(message.encode_utf16().take(4000).collect());
    let error = json!({"code":code,"message":message,"operationKind":operation,"occurredAt":now()});
    classify(&mut task, "failed", stable, error);
    checked(
        "taskGoalWorkerResultSchema",
        &json!({
            "goal":Value::Null,"message":Value::Null,"task":opaque(Communication::Task, key, scope, &task)?,
        }),
    )
}

fn classify(task: &mut Value, state: &str, stable: Value, error: Value) {
    let classification = &mut task["classification"];
    classification["state"] = json!(state);
    classification["stableStateBeforeFailure"] = stable;
    classification["activeOperationKind"] = Value::Null;
    classification["lastError"] = if error.is_null() {
        Value::Null
    } else {
        json!({"code":error["code"],"operationKind":error["operationKind"],"occurredAt":error["occurredAt"]})
    };
    task["lastError"] = error;
}

fn prior_failure(context: &Value, goal: &Value) -> Option<(&'static str, &'static str)> {
    let fallback = || {
        if context["task"]["classification"]["state"] != "failed"
            || !context["message"].is_null()
            || (goal["status"] == "active" && context["chatStatus"] == "running")
        {
            return None;
        }
        let code = context["task"]["classification"]["lastError"]["code"]
            .as_str()?
            .strip_prefix("implementation-")?;
        Some(code.strip_suffix("-failed").unwrap_or(code))
    };
    match context["runtimeFailure"]["kind"].as_str().or_else(fallback) {
        Some("timeout") => Some(("implementation-timeout", "The implementation timed out.")),
        Some("capacity") => Some((
            "implementation-capacity",
            "The provider is temporarily at capacity.",
        )),
        Some("rate-limit") => Some((
            "implementation-rate-limit",
            "The provider temporarily rate-limited the implementation.",
        )),
        Some("connection") => Some((
            "implementation-connection",
            "The implementation lost its connection.",
        )),
        Some("runtime") if goal["status"] != "blocked" => Some((
            "implementation-runtime",
            "The implementation runtime failed.",
        )),
        Some("needs-input") => Some((
            "implementation-needs-input",
            "The implementation needs your input.",
        )),
        Some("configuration") => Some((
            "implementation-configuration",
            "The implementation needs a configuration change.",
        )),
        Some("usage-limit") => Some((
            "implementation-usage-limit",
            "The implementation reached a provider usage limit.",
        )),
        Some("budget-limit") => Some((
            "implementation-budget-limit",
            "The implementation reached its token budget.",
        )),
        _ => None,
    }
}

fn projection(context: &Value, goal: &Value) -> (&'static str, &'static str, &'static str) {
    let status = goal["status"].as_str();
    if status == Some("complete") {
        return ("complete", "", "");
    }
    if context["automationPaused"] == true || status == Some("paused") {
        return ("paused", "", "");
    }
    if !matches!(status, Some("usageLimited" | "budgetLimited"))
        && let Some((code, message)) = prior_failure(context, goal)
    {
        return (
            if code == "implementation-needs-input" {
                "blocked"
            } else {
                "failed"
            },
            code,
            message,
        );
    }
    if context["chatStatus"] == "failed" && matches!(status, Some("active" | "paused") | None) {
        return (
            "failed",
            "implementation-runtime-failed",
            "The implementation runtime failed.",
        );
    }
    match status {
        Some("active") => ("implementing", "", ""),
        Some("blocked") => ("blocked", "goal-blocked", "The Goal reported a blocker."),
        Some("usageLimited") => (
            "failed",
            "goal-usage-limited",
            "The Goal reached a provider usage limit.",
        ),
        Some("budgetLimited") => (
            "failed",
            "goal-budget-limited",
            "The Goal reached its token budget.",
        ),
        _ => ("", "", ""),
    }
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
