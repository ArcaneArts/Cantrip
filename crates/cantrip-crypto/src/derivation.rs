use crate::{checked, encode, require_length};
use anyhow::{Result, bail};
use cantrip_wire::{JsString, Value, value::json};
use hkdf::{
    Hkdf,
    hmac::{Hmac, KeyInit, Mac},
};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

fn bounded<'a>(value: &'a Value, label: &str, max: usize) -> Result<&'a JsString> {
    let Some(value) = value
        .as_js_string()
        .filter(|v| !v.is_empty() && v.units().len() <= max)
    else {
        bail!("{label} length is out of range.");
    };
    Ok(value)
}
fn derive(
    source: &[u8],
    owner: &Value,
    domain: &str,
    fields: Vec<Value>,
) -> Result<Zeroizing<Vec<u8>>> {
    require_length(source, 32, "Key")?;
    // TextEncoder replaces lone surrogates, whereas JSON.stringify escapes them.
    let owner = bounded(owner, "Owner ID", 255)?.lossy();
    let salt = Sha256::digest(format!("cantrip:e2ee:hkdf-salt:v1\0{owner}").as_bytes());
    let mut info = vec![json!(domain)];
    info.extend(fields);
    let mut key = Zeroizing::new(vec![0; 32]);
    Hkdf::<Sha256>::new(Some(&salt), source)
        .expand(Value::Array(info).stringify().as_bytes(), &mut key)
        .expect("fixed 32-byte HKDF output");
    Ok(key)
}
pub fn derive_component_key(source: &[u8], context: &Value) -> Result<Zeroizing<Vec<u8>>> {
    let component = checked("encryptionComponentScopeSchema", &context["component"])?;
    let revision = checked("encryptionKeyRevisionSchema", &context["keyRevision"])?;
    derive(
        source,
        &context["ownerId"],
        "cantrip:e2ee:component-key:v1",
        vec![component, revision],
    )
}
fn subkey(source: &[u8], context: &Value, domain: &str) -> Result<Zeroizing<Vec<u8>>> {
    let component = checked("encryptionComponentScopeSchema", &context["component"])?;
    let revision = checked("encryptionKeyRevisionSchema", &context["keyRevision"])?;
    bounded(&context["table"], "Table", 120)?;
    bounded(&context["field"], "Field", 120)?;
    derive(
        source,
        &context["ownerId"],
        domain,
        vec![
            component,
            context["table"].clone(),
            context["field"].clone(),
            revision,
        ],
    )
}
pub fn derive_field_key(source: &[u8], context: &Value) -> Result<Zeroizing<Vec<u8>>> {
    subkey(source, context, "cantrip:e2ee:field-key:v1")
}
pub fn derive_lookup_key(source: &[u8], context: &Value) -> Result<Zeroizing<Vec<u8>>> {
    subkey(source, context, "cantrip:e2ee:lookup-key:v1")
}
pub fn blind_lookup_tag(key: &[u8], canonical: &JsString) -> Result<String> {
    require_length(key, 32, "Lookup key")?;
    Ok(encode(&hmac_sha256(key, &[canonical.lossy().as_bytes()])?))
}

pub fn hmac_sha256(key: &[u8], parts: &[&[u8]]) -> Result<[u8; 32]> {
    require_length(key, 32, "HMAC key")?;
    let mut mac =
        <Hmac<Sha256> as KeyInit>::new_from_slice(key).expect("HMAC accepts 32-byte keys");
    for part in parts {
        mac.update(part);
    }
    Ok(mac.finalize().into_bytes().into())
}
