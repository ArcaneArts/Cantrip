use super::aad;
use crate::{checked, derive_field_key, encrypt_payload, hmac_sha256};
use anyhow::{Result, ensure};
use cantrip_wire::{Value, payload_digest, value::json};
use zeroize::Zeroizing;

/// Protect the complete versioned native snapshot. Model attribution has its
/// own fingerprint so inventory changes do not masquerade as native edits.
pub fn protect_native_settings_snapshot(
    component_key: &[u8],
    grant: &Value,
    context: &Value,
    settings: &Value,
    selection: &Value,
) -> Result<Value> {
    let context = checked("nativeSettingsSnapshotContextSchema", context)?;
    let settings = checked("nativeThreadSettingsSchema", settings)?;
    ensure!(
        settings["settingsVersion"] == context["settingsVersion"],
        "Native settings snapshot does not match its declared version."
    );
    let selection = checked("nativeModelAttributionSchema", selection)?;
    let mut identity = context.clone();
    identity["serverId"] = grant["serverId"].clone();
    let associated = aad(
        grant,
        &json!("chat-content"),
        &json!("native-settings-state"),
        &json!(payload_digest(&identity)),
        &json!("snapshot"),
    )?;
    let key = derive_field_key(component_key, &associated)?;
    let plaintext = Zeroizing::new(settings.stringify_canonical());
    let content = fingerprint(&key, &associated, plaintext.as_bytes())?;
    let attribution = fingerprint(
        &key,
        &json!({"domain":"native-model-attribution","associatedData":associated}),
        json!({"contentFingerprint":content,"selection":selection})
            .stringify_canonical()
            .as_bytes(),
    )?;
    checked(
        "protectedNativeSettingsSnapshotSchema",
        &json!({
            "context":context,"contentFingerprint":content,
            "modelAttribution":json!({"selection":selection,"fingerprint":attribution}),
            "protectedContent":encrypt_payload(&key, plaintext.as_bytes(), &associated)?,
        }),
    )
}

fn fingerprint(key: &[u8], associated: &Value, bytes: &[u8]) -> Result<String> {
    let digest = hmac_sha256(key, &[associated.stringify_canonical().as_bytes(), bytes])?;
    Ok(digest.iter().map(|byte| format!("{byte:02x}")).collect())
}
