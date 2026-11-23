use base64::{Engine, engine::general_purpose::STANDARD};
use serde::Serialize;
use serde_json::Value;

use super::{
    ConfigError, Result,
    value::{Reader, entries, trim},
};

#[derive(Clone, Serialize)]
pub struct SecretKey {
    pub id: String,
    pub key: [u8; 32],
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretEncryption {
    pub active_key_id: String,
    pub keys: Vec<SecretKey>,
}

pub(super) fn read(reader: &Reader<'_>) -> Result<Option<SecretEncryption>> {
    let Some(encoded) = reader.nonempty("CANTRIP_SECRET_ENCRYPTION_KEYS") else {
        return Ok(None);
    };
    let invalid = || {
        ConfigError::new(
            "CANTRIP_SECRET_ENCRYPTION_KEYS must be a JSON object of key IDs to base64-encoded 32-byte keys.",
        )
    };
    let parsed: Value = serde_json::from_str(&encoded).map_err(|_| invalid())?;
    let object = parsed.as_object().ok_or_else(invalid)?;
    let mut keys = Vec::new();
    for (id, value) in entries(object) {
        if id.is_empty()
            || id.len() > 64
            || !id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
        {
            return Err(ConfigError::new(
                "CANTRIP_SECRET_ENCRYPTION_KEYS contains an invalid key identifier.",
            ));
        }
        let encoded = value.as_str().ok_or_else(|| {
            ConfigError::new(format!(
                "CANTRIP_SECRET_ENCRYPTION_KEYS entry {id} must be a base64 string."
            ))
        })?;
        let invalid_key = || {
            ConfigError::new(format!(
                "CANTRIP_SECRET_ENCRYPTION_KEYS entry {id} must encode exactly 32 bytes using canonical base64."
            ))
        };
        let bytes = STANDARD.decode(encoded).map_err(|_| invalid_key())?;
        if bytes.len() != 32 || STANDARD.encode(&bytes) != encoded {
            return Err(invalid_key());
        }
        keys.push(SecretKey {
            id: id.clone(),
            key: bytes.try_into().map_err(|_| invalid_key())?,
        });
    }
    if keys.is_empty() || keys.len() > 16 {
        return Err(ConfigError::new(
            "CANTRIP_SECRET_ENCRYPTION_KEYS must contain between 1 and 16 keys.",
        ));
    }
    let active_key_id = reader
        .get("CANTRIP_ACTIVE_SECRET_ENCRYPTION_KEY_ID")
        .map(trim)
        .map(String::from)
        .unwrap_or_else(|| {
            if keys.len() == 1 {
                keys[0].id.clone()
            } else {
                String::new()
            }
        });
    if !keys.iter().any(|k| k.id == active_key_id) {
        return Err(ConfigError::new(
            "CANTRIP_ACTIVE_SECRET_ENCRYPTION_KEY_ID must name a configured encryption key.",
        ));
    }
    Ok(Some(SecretEncryption {
        active_key_id,
        keys,
    }))
}
