use crate::encryption::{ComponentKey, Service};
use anyhow::Result;
use cantrip_crypto::{
    DecryptionError, checked,
    content::{decrypt_surface_private_state, encrypt_surface_private_state},
};
use cantrip_wire::{JsString, Value, value::json};

#[derive(Debug)]
pub struct SurfacePrivateStateWorkerError {
    pub state: &'static str,
    message: &'static str,
}
impl std::fmt::Display for SurfacePrivateStateWorkerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.message)
    }
}
impl std::error::Error for SurfacePrivateStateWorkerError {}
fn error(state: &'static str, message: &'static str) -> anyhow::Error {
    SurfacePrivateStateWorkerError { state, message }.into()
}
fn material(service: &Service, owner: &JsString, revision: Option<u64>) -> Result<ComponentKey> {
    let view = service.component_view("surface-private-state");
    if view.status["error"]
        .as_js_string()
        .is_some_and(|text| text.lowercase().lossy().contains("revok"))
    {
        return Err(error(
            "revoked",
            "The worker's surface private-state grant was revoked.",
        ));
    }
    let missing = |_| {
        error(
            "missing-grant",
            "The worker does not have an active surface private-state grant.",
        )
    };
    if view.owner_id.map_err(missing)? != *owner {
        return Err(error(
            "wrong-recipient",
            "The worker encryption key belongs to another account.",
        ));
    }
    let key = view.component.map_err(missing)?;
    if revision.is_some_and(|revision| revision != key.key_revision) {
        return Err(error(
            "stale",
            "The protected surface state uses another worker key revision.",
        ));
    }
    Ok(key)
}
fn parse_opaque(value: &Value) -> Result<Value> {
    if let Ok(parsed) = checked("surfacePrivateStateOpaqueSchema", value) {
        return Ok(parsed);
    }
    let candidate = &value["protectedState"];
    if candidate.get("formatVersion").is_some()
        && (candidate["formatVersion"] != 1 || candidate["envelope"]["version"] != 1)
    {
        return Err(error(
            "unsupported",
            "The protected surface-state format is not supported.",
        ));
    }
    Err(error(
        if value.is_null() {
            "missing"
        } else {
            "corrupt"
        },
        "The protected surface-state envelope is missing or corrupt.",
    ))
}
pub fn protect_private_state(
    service: &Service,
    owner: &JsString,
    binding: &Value,
    content: &Value,
) -> Result<Value> {
    let key = material(service, owner, None)?;
    encrypt_surface_private_state(
        &key.key,
        &json!({"ownerId":owner,"keyRevision":key.key_revision,"context":binding}),
        content,
    )
}
pub fn open_private_state(
    service: &Service,
    owner: &JsString,
    binding: &Value,
    opaque: &Value,
) -> Result<Value> {
    let opaque = parse_opaque(opaque)?;
    let key = material(
        service,
        owner,
        opaque["protectedState"]["keyRevision"].as_u64(),
    )?;
    decrypt_surface_private_state(
        &key.key,
        &json!({"ownerId":owner,"keyRevision":key.key_revision,"context":binding}),
        &opaque,
    )
    .map_err(|e| {
        if e.is::<DecryptionError>() {
            error(
                "corrupt",
                "The protected surface state could not be authenticated.",
            )
        } else {
            e
        }
    })
}
