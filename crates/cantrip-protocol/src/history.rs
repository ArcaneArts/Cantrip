//! Stable history item keys and protected-event identities shared with workers.
//! Pure usage reconciliation accepts caller locale policy. No function here
//! assigns ownership, admits execution or performs durable ingestion.
use cantrip_wire::{Value, payload_digest, value::json};
use sha2::{Digest, Sha256};

pub fn item_key(chat: &Value, identity: &Value) -> String {
    payload_digest(&Value::Array(vec![
        json!("native-history-item-v1"),
        chat.clone(),
        identity.clone(),
    ]))
}
pub fn event_id(chat: &str, key: &str) -> String {
    let mut hash = Sha256::new();
    hash.update(b"cantrip:protected-agent-event\0");
    hash.update(chat.as_bytes());
    hash.update(b"\0");
    hash.update(key.as_bytes());
    let hash = hash.finalize();
    let mut bytes: [u8; 16] = hash[..16].try_into().unwrap();
    bytes[6] = (bytes[6] & 15) | 80;
    bytes[8] = (bytes[8] & 63) | 128;
    uuid::Uuid::from_bytes(bytes).to_string()
}

mod usage;
pub use usage::reconcile as reconcile_usage;
