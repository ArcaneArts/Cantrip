//! Public turn submission binds its two parsed encrypted representations and
//! optional selected model exactly as Source's superRefine callback does.
use super::{Parsed, ValidationError, Value, value::json};

pub(super) fn refine(
    tag: &str,
    result: &mut Parsed,
    path: &[Value],
) -> Result<bool, ValidationError> {
    if tag != "encrypted-chat-turn-pair" {
        return Ok(false);
    }
    let value = result.value.as_ref().ok_or(ValidationError::Operation)?;
    let message_mismatch =
        value["message"].stringify() != value["queuedPrompt"]["pendingMessage"].stringify();
    let model_mismatch = value
        .get("modelId")
        .is_some_and(|model| Some(model) != value["queuedPrompt"].get("modelId"));
    for (invalid, field, detail) in [
        (
            message_mismatch,
            "pendingMessage",
            "The queued prompt must carry the submitted encrypted message.",
        ),
        (
            model_mismatch,
            "modelId",
            "The queued prompt model must match the submitted model.",
        ),
    ] {
        if invalid {
            let mut at = path.to_vec();
            at.extend([json!("queuedPrompt"), json!(field)]);
            // Keep the callback's code/message/path insertion order for errors.
            result
                .issues
                .push(json!({"code":"custom","message":detail,"path":at}));
        }
    }
    Ok(true)
}
