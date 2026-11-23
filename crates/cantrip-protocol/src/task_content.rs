//! Cross-field validation for endpoint-only decrypted Task content.
use super::{Parsed, ValidationError, Value, value::json};
use std::collections::HashSet;

pub(super) fn refine(
    tag: &str,
    result: &mut Parsed,
    path: &[Value],
) -> Result<bool, ValidationError> {
    if !matches!(
        tag,
        "task-content-classification"
            | "task-content-goal-prompt"
            | "task-round-content-classification"
            | "task-message-content-classification"
            | "task-content-question"
            | "task-content-questions"
            | "task-content-answer"
            | "task-content-answers"
    ) {
        return Ok(false);
    }

    let value = result.value.as_ref().ok_or(ValidationError::Operation)?;
    let issues = &mut result.issues;
    let mut custom = |suffix: &[Value], message: &str| {
        let at = [path, suffix].concat();
        issues.push(json!({"code":"custom","message":message,"path":at}));
    };
    match tag {
        "task-content-classification" | "task-round-content-classification" => {
            let (name, fields, error) = if tag == "task-content-classification" {
                (
                    "Task",
                    &[
                        ("hasPlan", "planMarkdown"),
                        ("hasQuestions", "currentQuestions"),
                        ("hasFinalPlan", "finalPlanMarkdown"),
                        ("hasGoalPrompt", "goalPrompt"),
                    ][..],
                    "lastError",
                )
            } else {
                (
                    "planning-round",
                    &[
                        ("hasOutputPlan", "outputPlanMarkdown"),
                        ("hasOutputQuestions", "outputQuestions"),
                        ("hasOutputGoalPrompt", "outputGoalPrompt"),
                    ][..],
                    "error",
                )
            };
            for (flag, field) in fields {
                let present = value[*field]
                    .as_array()
                    .map_or_else(|| !value[*field].is_null(), |list| !list.is_empty());
                if value["classification"][*flag] != present {
                    custom(
                        &[json!("classification"), json!(flag)],
                        &format!(
                            "Protected {name} {flag} classification does not match its content."
                        ),
                    );
                }
            }
            if ["code", "operationKind", "occurredAt"]
                .iter()
                .any(|field| value["classification"][error][*field] != value[error][*field])
            {
                custom(
                    &[json!("classification"), json!(error)],
                    &format!("Protected {name} error classification does not match its content."),
                );
            }
        }
        "task-message-content-classification" => {
            let ids = array(&value["content"])?
                .iter()
                .filter(|item| item["type"] == "attachment")
                .filter_map(|item| item["attachment"]["id"].as_js_string())
                .map(|id| json!(id))
                .collect();
            if value["classification"]["attachmentIds"] != Value::Array(ids) {
                custom(
                    &[json!("classification"), json!("attachmentIds")],
                    "Protected Task message attachment classification does not match its content.",
                );
            }
        }
        "task-content-goal-prompt" => {
            let text = value.as_js_string().ok_or(ValidationError::Operation)?;
            if std::char::decode_utf16(text.units().iter().copied()).count() > 2000 {
                custom(&[], "The Task Goal prompt must be at most 2000 characters.");
            }
        }
        "task-content-question" => {
            let options = array(&value["options"])?;
            let mut ids = HashSet::new();
            for (index, option) in options.iter().enumerate() {
                if !ids.insert(option["id"].as_js_string()) {
                    custom(
                        &[json!("options"), json!(index), json!("id")],
                        "Task question option IDs must be unique.",
                    );
                }
            }
            if !value["recommendedOptionId"].is_null()
                && !ids.contains(&value["recommendedOptionId"].as_js_string())
            {
                custom(
                    &[json!("recommendedOptionId")],
                    "The recommended option must exist in the question.",
                );
            }
            if options.is_empty() && value["allowFreeform"] != true {
                custom(
                    &[json!("allowFreeform")],
                    "A question needs options or a freeform answer.",
                );
            }
        }
        "task-content-questions" | "task-content-answers" => {
            let (key, message) = if tag == "task-content-questions" {
                ("id", "Task question IDs must be unique within a round.")
            } else {
                (
                    "questionId",
                    "A Task question can have only one current answer.",
                )
            };
            let mut ids = HashSet::new();
            for (index, item) in array(value)?.iter().enumerate() {
                if !ids.insert(item[key].as_js_string()) {
                    custom(&[json!(index), json!(key)], message);
                }
            }
        }
        "task-content-answer" => {
            if value["optionId"].is_null()
                && value["freeform"]
                    .as_js_string()
                    .is_none_or(|text| text.trim().is_empty())
            {
                custom(
                    &[],
                    "A Task answer needs a selected option or freeform text.",
                );
            }
        }
        _ => unreachable!(),
    }
    Ok(true)
}

fn array(value: &Value) -> Result<&[Value], ValidationError> {
    value
        .as_array()
        .map(Vec::as_slice)
        .ok_or(ValidationError::Operation)
}
