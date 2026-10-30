use super::{Parsed, ValidationError, Value, value::json};
pub(super) fn refine(
    tag: &str,
    result: &mut Parsed,
    path: &[Value],
    message: Option<&str>,
) -> Result<bool, ValidationError> {
    if ![
        "browser-placement",
        "browser-title",
        "browser-update",
        "browser-service-http-url",
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
        let mut at = path.to_vec();
        at.extend(suffix.iter().map(|s| json!(s)));
        result.issue(json!({"code":"custom"}), &at, message.into(), false);
    };
    match tag {
        "browser-service-http-url" => {
            let text = value.as_js_string().ok_or(ValidationError::Operation)?;
            if !text
                .units()
                .starts_with(&"http://".encode_utf16().collect::<Vec<_>>())
                && !text
                    .units()
                    .starts_with(&"https://".encode_utf16().collect::<Vec<_>>())
            {
                issue(
                    &[],
                    message.unwrap_or("Browser service URLs must use HTTP or HTTPS."),
                );
            }
        }
        "browser-placement" => {
            if ["paneId", "tabGroupId", "targetRegion"]
                .iter()
                .filter(|k| value.get(k).is_some())
                .count()
                > 1
            {
                issue(
                    &[],
                    message.unwrap_or(
                        "Specify only one of paneId, the deprecated tabGroupId, or targetRegion.",
                    ),
                );
            }
        }
        "browser-title" => {
            if value["titleProtection"]["classification"]["recordKind"] != "browser" {
                issue(
                    &[],
                    message.unwrap_or("Browser title classification must be browser."),
                );
            }
        }
        "browser-update" => {
            let title = value.get("titleProtection");
            let state = value.get("stateProtection");
            let expected = value.get("expectedStateRevision");
            if title.is_none() && state.is_none() {
                issue(&[], "At least one browser field is required.");
            }
            if state.is_none() != expected.is_none() {
                issue(
                    &["expectedStateRevision"],
                    "Browser state updates require an expected revision.",
                );
            }
            if title.is_some_and(|t| t["classification"]["recordKind"] != "browser") {
                issue(
                    &["titleProtection", "classification", "recordKind"],
                    "Browser title classification must be browser.",
                );
            }
        }
        _ => unreachable!(),
    }
    Ok(true)
}
