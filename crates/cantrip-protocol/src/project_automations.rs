use super::{Parsed, ValidationError, Value, value::json};
pub(super) fn refine(
    tag: &str,
    result: &mut Parsed,
    path: &[Value],
    message: Option<&str>,
) -> Result<bool, ValidationError> {
    if !matches!(
        tag,
        "automation-timezone"
            | "automation-cron"
            | "automation-update"
            | "automation-condition-script"
            | "automation-protected-dispatch"
    ) {
        return Ok(false);
    }
    let value = result.value.as_ref().ok_or(ValidationError::Operation)?;
    if tag == "automation-timezone" {
        if value
            .as_str()
            .is_none_or(|v| cantrip_scheduling::timezone(v).is_err())
        {
            result.issue(
                json!({"code":"custom"}),
                path,
                message.unwrap_or("Choose a valid IANA time zone.").into(),
                false,
            );
        }
    } else if tag == "automation-condition-script" {
        if value
            .as_js_string()
            .is_none_or(|script| script.trim().is_empty())
        {
            result.issue(
                json!({"code":"custom"}),
                path,
                message.unwrap_or("Condition script is required.").into(),
                false,
            );
        }
    } else if tag == "automation-cron" {
        let mut at = path.to_vec();
        let zone = value["timeZone"]
            .as_str()
            .and_then(|v| cantrip_scheduling::timezone(v).ok());
        if let Some(zone) = zone {
            if let Some(message) = cantrip_scheduling::cron_error(
                value["expression"]
                    .as_js_string()
                    .ok_or(ValidationError::Operation)?,
                &zone,
            ) {
                at.push(json!("expression"));
                result
                    .issues
                    .push(json!({"code":"custom","message":message,"path":at}));
            }
        } else {
            at.push(json!("timeZone"));
            result.issues.push(
                json!({"code":"custom","message":"Choose a valid IANA time zone.","path":at}),
            );
        }
    } else if tag == "automation-update" {
        if ["chatId", "schedule", "enabled"]
            .iter()
            .all(|k| value.get(k).is_none())
            && value
                .get("content")
                .and_then(Value::as_object)
                .is_none_or(|o| o.is_empty())
        {
            result.issue(
                json!({"code":"custom"}),
                path,
                message
                    .unwrap_or("Provide at least one encrypted automation update.")
                    .into(),
                false,
            );
        }
    } else if value["allowed"] != Value::Bool(super::coercion::truthy(value.get("protectedTurn"))) {
        let mut at = path.to_vec();
        at.push(json!("protectedTurn"));
        result.issues.push(json!({"code":"custom","message":"Allowed automation dispatches require a protected turn.","path":at}));
    }
    Ok(true)
}
