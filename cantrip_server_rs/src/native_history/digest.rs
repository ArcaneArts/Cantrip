use crate::wire::Value;
use sha2::{Digest, Sha256};

/// Match the Node reference's persisted digest, with sorted object keys and
/// unchanged array order.
pub fn payload_digest(value: &Value) -> String {
    format!(
        "{:x}",
        Sha256::digest(value.stringify_canonical().as_bytes())
    )
}
