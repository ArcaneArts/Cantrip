use super::{Parsed, ValidationError, Value, value::json};
use std::collections::HashSet;

pub(super) fn refine(
    tag: &str,
    result: &mut Parsed,
    path: &[Value],
    message: Option<&str>,
) -> Result<bool, ValidationError> {
    if !matches!(
        tag,
        "cantrip-os-guest-path"
            | "cantrip-os-overlay-path"
            | "cantrip-os-unique-overlays"
            | "cantrip-os-file-placement"
    ) {
        return Ok(false);
    }
    let value = result.value.as_ref().ok_or(ValidationError::Operation)?;
    let valid = match tag {
        "cantrip-os-file-placement" => {
            value.get("cantripOsBindingId").is_some()
                == value.get("cantripOsRuntimeGeneration").is_some()
        }
        "cantrip-os-guest-path" => {
            let units = value
                .as_js_string()
                .ok_or(ValidationError::Operation)?
                .units();
            units.first() == Some(&47) && !units.contains(&0)
        }
        "cantrip-os-overlay-path" => {
            let units = value
                .as_js_string()
                .ok_or(ValidationError::Operation)?
                .units();
            let mut parts = units.split(|unit| *unit == 47).peekable();
            !units.contains(&0)
                && parts
                    .peek()
                    .is_some_and(|first| *first != [46, 103, 105, 116])
                && parts.all(|part| !part.is_empty() && part != [46] && part != [46, 46])
        }
        "cantrip-os-unique-overlays" => {
            let entries = value.as_array().ok_or(ValidationError::Operation)?;
            let mut seen = HashSet::new();
            entries
                .iter()
                .all(|entry| seen.insert(entry["path"].as_js_string().cloned()))
        }
        _ => return Ok(false),
    };
    if !valid {
        result.issue(
            json!({"code":"custom"}),
            path,
            message.unwrap_or("Invalid CantripOS location.").into(),
            false,
        );
    }
    Ok(true)
}
