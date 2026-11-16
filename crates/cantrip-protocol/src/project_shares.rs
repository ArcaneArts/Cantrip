use super::{Parsed, ValidationError, Value, value::json};
pub(super) fn refine(
    tag: &str,
    result: &mut Parsed,
    path: &[Value],
    message: Option<&str>,
) -> Result<bool, ValidationError> {
    if tag != "project-share-tunnel-identity" {
        return Ok(false);
    }
    let value = result.value.as_ref().ok_or(ValidationError::Operation)?;
    if value["tunnelId"] != value["protectedRecord"]["operationId"]
        && value["protectedRecord"]["revision"]
            .as_f64()
            .is_none_or(|r| r <= 1.0)
    {
        result.issue(
            json!({"code":"custom"}),
            path,
            message
                .unwrap_or(
                    "A new project share must bind its tunnel identity to its protected record.",
                )
                .into(),
            false,
        );
    }
    Ok(true)
}
