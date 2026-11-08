//! Public surface refinements authored from the protocol callbacks.
use super::{Parsed, ValidationError, Value, value::json};
pub(super) fn refine(
    tag: &str,
    result: &mut Parsed,
    path: &[Value],
    message: Option<&str>,
) -> Result<bool, ValidationError> {
    if !matches!(
        tag,
        "remote-surface-create"
            | "remote-surface-update"
            | "remote-surface-wire"
            | "desktop-os-source"
            | "desktop-title"
            | "desktop-wire-title"
            | "desktop-fleet-inventory"
    ) {
        return Ok(false);
    }
    let value = result
        .value
        .as_ref()
        .ok_or(ValidationError::Operation)?
        .clone();
    let mut issue = |suffix: &[&str], text: &str| {
        let mut at = path.to_vec();
        at.extend(suffix.iter().map(|s| json!(s)));
        result.issue(json!({"code":"custom"}), &at, text.into(), false);
    };
    match tag {
        "remote-surface-create" => {
            if value["titleProtection"]["classification"]["recordKind"] != "remote-surface" {
                issue(
                    &["titleProtection", "classification", "recordKind"],
                    "Remote Surface title classification must be remote-surface.",
                );
            }
            let expected = if value["configuration"]["kind"] == "browser" {
                "browser-state"
            } else {
                "remote-desktop-state"
            };
            if value["stateProtection"]["classification"]["recordKind"] != expected {
                issue(
                    &["stateProtection"],
                    "Remote Surface protected state must match its kind.",
                );
            }
        }
        "remote-surface-update" => {
            if [
                "titleProtection",
                "configuration",
                "preferredTransport",
                "stateProtection",
            ]
            .iter()
            .all(|key| value.get(key).is_none())
            {
                issue(&[], "At least one remote surface field is required.");
            }
            if value.get("stateProtection").is_none()
                != value.get("expectedStateRevision").is_none()
            {
                issue(
                    &["expectedStateRevision"],
                    "Remote Surface state updates require an expected revision.",
                );
            }
            if value
                .get("titleProtection")
                .is_some_and(|v| v["classification"]["recordKind"] != "remote-surface")
            {
                issue(
                    &["titleProtection", "classification", "recordKind"],
                    "Remote Surface title classification must be remote-surface.",
                );
            }
        }
        "remote-surface-wire" => {
            let kind = &value["titleProtection"]["classification"]["recordKind"];
            if *kind != "remote-surface"
                && !(value["kind"] == "browser" && *kind == "browser")
                && !(value["kind"] == "desktop" && *kind == "project-view")
            {
                issue(
                    &["titleProtection", "classification", "recordKind"],
                    "Remote Surface title classification must match its canonical owner.",
                );
            }
            let expected = if value["kind"] == "browser" {
                "browser-state"
            } else {
                "remote-desktop-state"
            };
            if value["stateProtection"]["classification"]["recordKind"] != expected
                || value["stateRevision"].is_null()
            {
                issue(
                    &["stateProtection"],
                    "Remote Surfaces require protected state matching their kind.",
                );
            }
        }
        "desktop-os-source" => {
            let binding = super::coercion::truthy(value.get("cantripOsBindingId"));
            if binding != super::coercion::truthy(value.get("cantripOsRuntimeGeneration"))
                || binding && super::coercion::truthy(value.get("target"))
            {
                issue(
                    &[],
                    message.unwrap_or(
                        "Choose an OS binding and runtime generation, or a Host target.",
                    ),
                );
            }
        }
        "desktop-title" | "desktop-wire-title" => {
            if value["titleProtection"]["classification"]["recordKind"] != "project-view" {
                issue(
                    if tag == "desktop-title" {
                        &[]
                    } else {
                        &["titleProtection", "classification", "recordKind"]
                    },
                    message.unwrap_or("Remote Desktop title classification must be project-view."),
                );
            }
        }
        "desktop-fleet-inventory" => {
            if (value["status"] == "ok")
                != (!value["inventoryOperationId"].is_null()
                    && !value["inventoryProtection"].is_null())
            {
                issue(
                    &["inventoryProtection"],
                    "Available Remote Desktop workers require protected inventory.",
                );
            }
        }
        _ => unreachable!(),
    }
    Ok(true)
}
