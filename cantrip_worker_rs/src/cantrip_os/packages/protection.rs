//! Preserve the Node worker's protected package outcome and terminal cache.
use super::{account, verify_guest};
use crate::{
    cantrip_os::{
        checked,
        operations::{Operations, digest},
    },
    encryption::Service,
};
use anyhow::{Result, ensure};
use cantrip_crypto::{Zeroizing, derive_field_key, encode, encrypt_payload};
use cantrip_wire::{JsString, Value, value::json};
use sha2::{Digest, Sha256};

const COMPONENT: &str = "repository-content";
const MAXIMUM: usize = 4 * 1024 * 1024;

pub(super) fn result(
    operations: &Operations,
    encryption: &Service,
    command: &Value,
    request: &Value,
    record: &Value,
) -> Result<Value> {
    let checkpoint = &record["checkpoint"];
    let guest = &checkpoint["guest"];
    if !guest.is_null() {
        verify_guest(command, request, guest.clone())?;
    }
    let scope = &command["scope"];
    account(scope, encryption)?;
    let proof = digest(Value::Array(vec![
        record["state"].clone(),
        guest.clone(),
        record["error"].clone(),
    ]));
    let envelope = if record["receipt"].is_null() {
        let envelope = encrypt(encryption, command, request, guest, &record["error"])?;
        let outcome = if matches!(record["state"].as_str(), Some("ready" | "failed")) {
            let saved = operations.record_terminal_receipt(
                record,
                json!({
                    "kind":"package-protected-result","version":1,
                    "admissionFingerprint":record["admissionFingerprint"],
                    "proofSha256":proof,"protectedResult":envelope,
                }),
            )?;
            cached(record, &saved["receipt"], &proof)?
        } else {
            envelope
        };
        outcome
    } else {
        cached(record, &record["receipt"], &proof)?
    };
    checked(
        "cantripOsPackageOperationResultSchema",
        json!({
            "operationId":command["operationId"],"targetGeneration":command["target"]["generation"],
            "action":command["action"],"configuration":command["configuration"],"state":record["state"],
            "phase":checkpoint["phase"],"startedAt":record["startedAt"],"updatedAt":record["updatedAt"],
            "protectedResult":envelope,
            "error":if matches!(record["state"].as_str(),Some("failed" | "unknown")) {
                json!("Inspect the protected package outcome; uncertain installation was not repeated.")
            } else { Value::Null },
        }),
    )
}

fn cached(record: &Value, receipt: &Value, proof: &str) -> Result<Value> {
    ensure!(
        receipt["kind"] == "package-protected-result"
            && receipt["version"] == 1
            && receipt["admissionFingerprint"] == record["admissionFingerprint"]
            && receipt["proofSha256"] == proof,
        "The protected package receipt does not match its original outcome."
    );
    checked(
        "cantripOsPackageProtectedResultSchema",
        receipt["protectedResult"].clone(),
    )
}

fn encrypt(
    encryption: &Service,
    command: &Value,
    request: &Value,
    guest: &Value,
    error: &Value,
) -> Result<Value> {
    let scope = &command["scope"];
    let material = encryption.bound_component(COMPONENT, None)?;
    ensure!(
        scope["ownerId"].as_js_string() == Some(&material.owner_id)
            && scope["serverId"] == material.server_id,
        "The package receipt authority changed."
    );
    let diagnostic = error
        .as_js_string()
        .map(|error| JsString::new(error.units()[..error.len().min(32768)].to_vec()));
    let value = checked(
        "cantripOsPackagePrivateResultSchema",
        json!({"version":1,"request":request,"record":guest,"diagnostic":diagnostic}),
    )?;
    let bytes = Zeroizing::new(value.stringify().into_bytes());
    ensure!(
        bytes.len() <= MAXIMUM,
        "Private package result is too large"
    );
    let context = checked(
        "cantripOsPackageCryptoContextSchema",
        json!({
            "ownerId":scope["ownerId"],"serverId":scope["serverId"],"workerId":scope["workerId"],
            "instanceId":scope["instanceId"],"attachmentGeneration":scope["attachmentGeneration"],
            "targetGeneration":command["target"]["generation"],"operationId":command["operationId"],
        }),
    )?;
    let server_id = String::from_utf16_lossy(context["serverId"].as_js_string().unwrap().units());
    let row = Value::Array(vec![
        json!(encode(&Sha256::digest(server_id.as_bytes()))),
        context["workerId"].clone(),
        context["instanceId"].clone(),
        context["attachmentGeneration"].clone(),
        context["targetGeneration"].clone(),
        context["operationId"].clone(),
    ])
    .stringify();
    let associated = json!({
        "ownerId":context["ownerId"],"component":COMPONENT,"table":"protocol:cantrip-os-package-operations",
        "field":"private_result","rowId":row,"formatVersion":1,"keyRevision":material.component.key_revision,
    });
    let key = derive_field_key(&material.component.key, &associated)?;
    let result = encrypt_payload(&key, &bytes, &associated)?;
    account(scope, encryption)?;
    Ok(result)
}
