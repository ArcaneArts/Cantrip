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
            | "cantrip-os-unique-packages"
            | "cantrip-os-package-repair"
            | "cantrip-os-file-placement"
            | "cantrip-os-reset-path"
            | "cantrip-os-reset-paths"
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
        "cantrip-os-reset-path" => {
            let units = value
                .as_js_string()
                .ok_or(ValidationError::Operation)?
                .units();
            units == [46]
                || (!units.contains(&0)
                    && units
                        .split(|unit| *unit == 47)
                        .all(|part| !part.is_empty() && part != [46] && part != [46, 46]))
        }
        "cantrip-os-reset-paths" => {
            let entries = value.as_array().ok_or(ValidationError::Operation)?;
            let paths = entries
                .iter()
                .map(|entry| entry.as_js_string().map(|s| s.units()))
                .collect::<Option<Vec<_>>>()
                .ok_or(ValidationError::Operation)?;
            let mut seen = HashSet::new();
            paths.iter().all(|path| seen.insert(*path))
                && !(paths.len() != 1 && paths.iter().any(|path| *path == [46]))
                && !paths.iter().any(|path| {
                    paths.iter().any(|parent| {
                        path.len() > parent.len()
                            && path.starts_with(parent)
                            && path[parent.len()] == 47
                    })
                })
        }
        "cantrip-os-package-repair" => {
            value["action"] == "repair" || value["configuration"] == "preserve"
        }
        "cantrip-os-unique-overlays" | "cantrip-os-unique-packages" => {
            let entries = value.as_array().ok_or(ValidationError::Operation)?;
            let mut seen = HashSet::new();
            let key = if tag == "cantrip-os-unique-packages" {
                "name"
            } else {
                "path"
            };
            entries
                .iter()
                .all(|entry| seen.insert(entry[key].as_js_string().cloned()))
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
