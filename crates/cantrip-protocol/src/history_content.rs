//! Refinements of actual private communication content, not envelope authority.
use super::{Parsed, ValidationError, Value, value::json};
pub(super) fn refine(
    tag: &str,
    result: &mut Parsed,
    path: &[Value],
    message: Option<&str>,
) -> Result<bool, ValidationError> {
    if !matches!(
        tag,
        "history-content-message" | "history-content-plan" | "history-content-prompt"
    ) {
        return Ok(false);
    }
    let value = result.value.as_ref().ok_or(ValidationError::Operation)?;
    let (invalid, suffix, default): (bool, Vec<Value>, &str) = match tag {
        "history-content-message" => {
            let ids = value["content"]
                .as_array()
                .unwrap()
                .iter()
                .filter_map(|item| {
                    if !matches!(item, Value::Object(_))
                        || item["type"] != "attachment"
                        || !matches!(item["attachment"], Value::Object(_))
                    {
                        return None;
                    }
                    item["attachment"]["id"]
                        .as_js_string()
                        .filter(|id| !id.is_empty())
                        .map(|id| Value::String(id.clone()))
                })
                .collect::<Vec<_>>();
            (
                Value::Array(ids).stringify()
                    != value["classification"]["attachmentIds"].stringify(),
                vec![json!("classification"), json!("attachmentIds")],
                "Protected chat message attachment classification does not match its content.",
            )
        }
        "history-content-plan" => (
            value["classification"]["hasQuestion"] != (!value["question"].is_null()),
            Vec::new(),
            "Protected plan question classification does not match content.",
        ),
        _ => (
            value["text"].as_js_string().unwrap().is_empty()
                && value["classification"]["attachmentIds"]
                    .as_array()
                    .unwrap()
                    .is_empty(),
            Vec::new(),
            "A protected queued prompt needs text or an attachment.",
        ),
    };
    if invalid {
        let mut at = path.to_vec();
        at.extend(suffix);
        result.issue(
            json!({"code":"custom"}),
            &at,
            message.unwrap_or(default).into(),
            false,
        );
    }
    Ok(true)
}
