use super::{Parsed, ValidationError, Value, value::json};
pub(super) fn refine(
    tag: &str,
    result: &mut Parsed,
    path: &[Value],
    message: Option<&str>,
) -> Result<bool, ValidationError> {
    let kind = tag.strip_prefix("surface-title:");
    if kind.is_none() && tag != "surface-code-update" {
        return Ok(false);
    }
    let value = result
        .value
        .as_ref()
        .ok_or(ValidationError::Operation)?
        .clone();
    let mut issue = |suffix: &[&str], message: &str| {
        let mut at = path.to_vec();
        at.extend(suffix.iter().map(|s| json!(s)));
        result.issue(json!({"code":"custom"}), &at, message.into(), false);
    };
    if let Some(kind) = kind {
        if value["titleProtection"]["classification"]["recordKind"] != kind {
            issue(&[], message.unwrap_or("Invalid input"));
        }
    } else {
        if value.get("titleProtection").is_none() {
            issue(&[], "At least one Code tab field is required.");
        }
        if value
            .get("titleProtection")
            .is_some_and(|v| v["classification"]["recordKind"] != "code-tab")
        {
            issue(
                &["titleProtection", "classification", "recordKind"],
                "Code-tab title classification must be code-tab.",
            );
        }
    }
    Ok(true)
}
