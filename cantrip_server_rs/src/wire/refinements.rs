use super::{Parsed, ValidationError};
use super::{Value, value::json};

pub(super) fn apply(
    tag: &str,
    result: &mut Parsed,
    path: &[Value],
    message: Option<&str>,
) -> Result<(), ValidationError> {
    let value = result
        .value
        .as_ref()
        .ok_or(ValidationError::Operation)?
        .clone();
    let mut custom = |suffix: &[&str], message: &str| {
        let mut at = path.to_vec();
        at.extend(suffix.iter().map(|v| json!(v)));
        result.issue(json!({"code":"custom"}), &at, message.into(), false);
    };
    let wrapper = &value["passwordWrappedMasterKey"];
    match tag {
        "canonical-base64url" => {
            let value = value.as_js_string().ok_or(ValidationError::Operation)?;
            let len = value.len();
            let remainder = len % 4;
            let last = value
                .units()
                .last()
                .and_then(|ch| char::from_u32(u32::from(*ch)))
                .and_then(|ch| {
                    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_".find(ch)
                });
            let valid = remainder == 0
                || last.is_some_and(|last| {
                    if remainder == 2 {
                        last & 15 == 0
                    } else if remainder == 3 {
                        last & 3 == 0
                    } else {
                        false
                    }
                });
            if !valid {
                custom(
                    &[],
                    message.unwrap_or("Value is not canonical unpadded base64url."),
                );
            }
        }
        "password-wrapper-pair" => {
            if value["passwordKdf"].is_null() != wrapper.is_null() {
                custom(
                    &["passwordWrappedMasterKey"],
                    "Password KDF parameters and wrapper must both be present or absent.",
                );
            } else if !wrapper.is_null() {
                if value["passwordKdf"] != wrapper["kdf"] {
                    custom(
                        &["passwordKdf"],
                        "Password KDF parameters must match the wrapped key envelope.",
                    );
                }
                if wrapper["masterKeyRevision"] != value["activeMasterKeyRevision"] {
                    custom(
                        &["passwordWrappedMasterKey", "masterKeyRevision"],
                        "Password wrapper must target the active Account Master Key revision.",
                    );
                }
            }
        }
        "password-wrapper" => {
            if value["envelope"]["keyRevision"] != value["masterKeyRevision"] {
                custom(
                    &["envelope", "keyRevision"],
                    "Master-key and envelope revisions must match.",
                );
            }
            if value["envelope"]["ciphertext"]
                .as_js_string()
                .map(super::JsString::len)
                != Some(64)
            {
                custom(
                    &["envelope", "ciphertext"],
                    "Wrapped Account Master Key must contain exactly 48 bytes.",
                );
            }
        }
        "initial-client-wrapper" => {
            if value["initialClient"]["wrappedMasterKey"]["clientId"]
                != value["initialClient"]["id"]
                || value["initialClient"]["wrappedMasterKey"]["masterKeyRevision"]
                    != value["profile"]["activeMasterKeyRevision"]
            {
                custom(
                    &["initialClient", "wrappedMasterKey"],
                    "Initial client wrapper does not match the profile or principal.",
                );
            }
        }
        "password-change-kdf" => {
            if value["passwordKdf"] != wrapper["kdf"] {
                custom(
                    &["passwordKdf"],
                    "Password KDF parameters must match the wrapped key envelope.",
                );
            }
        }
        "principal-state" => {
            if (value["kind"] == "worker") == value["workerId"].is_null() {
                custom(
                    &["workerId"],
                    "Only worker principals may bind a worker identity.",
                );
            }
            let approved = super::coercion::truthy(Some(&value["approvedAt"]));
            let revoked = super::coercion::truthy(Some(&value["revokedAt"]));
            if value["state"] == "pending" && (approved || revoked) {
                custom(
                    &["state"],
                    "Pending principals cannot have approval or revocation timestamps.",
                );
            }
            if value["state"] == "approved" && (!approved || revoked) {
                custom(
                    &["state"],
                    "Approved principals require an approval timestamp only.",
                );
            }
            if value["state"] == "revoked" && !revoked {
                custom(
                    &["state"],
                    "Revoked principals require a revocation timestamp.",
                );
            }
        }
        "grant-create-metadata" | "grant-metadata" => {
            let wrapped = &value["wrappedKey"];
            if wrapped["purpose"] == "client-account-master-key" {
                if value["component"] != "account-master-key"
                    || wrapped["masterKeyRevision"] != value["keyRevision"]
                    || (tag == "grant-metadata" && wrapped["clientId"] != value["principalId"])
                {
                    custom(
                        &["wrappedKey"],
                        "Client grant metadata does not match its wrapped key.",
                    );
                }
            } else if wrapped["purpose"] == "worker-component-key"
                && (value["component"] != wrapped["component"]
                    || value["keyRevision"] != wrapped["keyRevision"])
            {
                custom(
                    &["wrappedKey"],
                    "Worker grant metadata does not match its wrapped key.",
                );
            }
            if tag == "grant-metadata"
                && (value["state"] == "revoked") == value["revokedAt"].is_null()
            {
                custom(
                    &["state"],
                    "Grant state and revocation timestamp must agree.",
                );
            }
        }
        "worker-encryption-status" => {
            if value["supported"] == false && value["state"] != "unavailable" {
                custom(
                    &["state"],
                    "Unsupported worker encryption must be unavailable.",
                );
            }
            if value["state"] == "ready" && value["principalId"].is_null() {
                custom(
                    &["principalId"],
                    "Ready worker encryption requires a principal.",
                );
            }
        }
        "worker-bootstrap" => {
            if value["principal"]["ownerId"] != value["ownerId"]
                || value["principal"]["kind"] != "worker"
            {
                custom(
                    &["principal"],
                    "Worker bootstrap identity does not match its owner.",
                );
            }
            if value["grants"]
                .as_array()
                .ok_or(ValidationError::Operation)?
                .iter()
                .any(|g| {
                    g["ownerId"] != value["ownerId"]
                        || g["principalId"] != value["principal"]["id"]
                        || g["state"] != "active"
                        || g["wrappedKey"]["purpose"] != "worker-component-key"
                })
            {
                custom(&["grants"], "Worker bootstrap contains an invalid grant.");
            }
        }
        "managed-runtime-components" => {
            if value["search"]["component"] != "searxng" {
                custom(
                    &["search", "component"],
                    "Search runtime status must describe SearXNG.",
                );
            }
            if value["browser"]["component"] != "playwright" {
                custom(
                    &["browser", "component"],
                    "Browser runtime status must describe Playwright.",
                );
            }
        }
        "managed-runtime-progress" => {
            if value["totalBytes"] != 0
                && super::numeric(&value["completedBytes"]) > super::numeric(&value["totalBytes"])
            {
                custom(
                    &[],
                    message.unwrap_or("Managed web runtime progress cannot exceed its total."),
                );
            }
        }
        _ => return Err(ValidationError::Operation),
    }
    Ok(())
}
