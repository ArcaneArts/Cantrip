//! Refinements of the retained worker-local Codex history schemas.
use super::{Parsed, ValidationError, Value, value::json};

pub(super) fn refine(
    tag: &str,
    result: &mut Parsed,
    path: &[Value],
) -> Result<bool, ValidationError> {
    if !matches!(
        tag,
        "history-source-native-sequence" | "history-source-live-boundary"
    ) {
        return Ok(false);
    }
    let value = result
        .value
        .as_ref()
        .ok_or(ValidationError::Operation)?
        .clone();
    match tag {
        "history-source-native-sequence" => {
            if !value.as_str().is_some_and(|text| {
                !text.is_empty()
                    && text.len() <= 20
                    && text.bytes().all(|b| b.is_ascii_digit())
                    && text.parse::<u64>().is_ok()
            }) {
                result.issue(
                    json!({"code":"custom"}),
                    path,
                    "Native history sequence exceeds u64.".into(),
                    false,
                );
            }
        }
        "history-source-live-boundary" => {
            for item in value["items"]
                .as_array()
                .ok_or(ValidationError::Operation)?
            {
                if item["cursor"]["epoch"] != value["epoch"]
                    || sequence(&item["cursor"]["sequence"])
                        .zip(sequence(&value["throughSequence"]))
                        .is_some_and(|(a, b)| a > b)
                {
                    result.issue(
                        json!({"code":"custom"}),
                        path,
                        "Live history item is outside its native snapshot boundary.".into(),
                        false,
                    );
                }
            }
        }
        _ => return Ok(false),
    }
    Ok(true)
}
pub(crate) fn sequence(value: &Value) -> Option<u64> {
    let text = value.as_str()?;
    if text.len() > 20
        || text.is_empty()
        || (text.len() > 1 && text.starts_with('0'))
        || !text.bytes().all(|b| b.is_ascii_digit())
    {
        return None;
    }
    text.parse().ok()
}
