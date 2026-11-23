use super::{Parsed, ValidationError, Value, coercion, value::json};
pub(super) fn refine(
    tag: &str,
    result: &mut Parsed,
    path: &[Value],
    message: Option<&str>,
) -> Result<bool, ValidationError> {
    if ![
        "terminal-placement",
        "terminal-title",
        "terminal-wire",
        "script-command-text",
    ]
    .contains(&tag)
    {
        return Ok(false);
    }
    let value = result
        .value
        .as_ref()
        .ok_or(ValidationError::Operation)?
        .clone();
    let mut issue = |suffix: &[&str], message: &str| {
        let mut path = path.to_vec();
        path.extend(suffix.iter().map(|v| json!(v)));
        result.issue(json!({"code":"custom"}), &path, message.into(), false);
    };
    match tag {
        "script-command-text" => {
            if value
                .as_js_string()
                .is_some_and(|text| text.units().iter().any(|unit| matches!(unit, 0..=31 | 127)))
            {
                issue(&[], message.ok_or(ValidationError::Operation)?);
            }
        }
        "terminal-placement" => {
            if coercion::truthy(value.get("worktreeId")) && coercion::truthy(value.get("target")) {
                issue(
                    &[],
                    "Choose either a legacy worktreeId or an execution target.",
                );
            }
            if ["paneId", "tabGroupId", "targetRegion"]
                .into_iter()
                .filter(|key| value.get(key).is_some())
                .count()
                > 1
            {
                issue(
                    &["paneId"],
                    "Specify only one of paneId, the deprecated tabGroupId, or targetRegion.",
                );
            }
        }
        "terminal-title" => {
            if value["titleProtection"]["classification"]["recordKind"] != "terminal" {
                issue(
                    &[],
                    message.unwrap_or("Terminal title classification must be terminal."),
                );
            }
        }
        "terminal-wire" => {
            if value["kind"] == "run-configuration" {
                if !value["titleProtection"].is_null()
                    || !value["stateProtection"].is_null()
                    || !value["linkedChatId"].is_null()
                    || value["runConfigurationId"].is_null()
                    || value["runConfigurationRuntimeId"].is_null()
                    || value["serviceEnabled"] == true
                {
                    issue(
                        &[],
                        "Run configuration terminals require only their runtime binding.",
                    );
                }
            } else if value["titleProtection"].is_null()
                || value["stateProtection"].is_null()
                || !value["runConfigurationId"].is_null()
                || !value["runConfigurationRuntimeId"].is_null()
            {
                issue(
                    &[],
                    "Interactive terminals require protected label and state fields.",
                );
            } else {
                if value["titleProtection"]["classification"]["recordKind"] != "terminal" {
                    issue(
                        &["titleProtection", "classification", "recordKind"],
                        "Terminal title classification must be terminal.",
                    );
                }
                if (value["kind"] == "chat-console") == value["linkedChatId"].is_null() {
                    issue(
                        &["linkedChatId"],
                        "Only chat console terminals may have a linked chat.",
                    );
                }
            }
        }
        _ => unreachable!(),
    }
    Ok(true)
}
