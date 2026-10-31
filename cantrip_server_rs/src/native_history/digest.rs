use crate::wire::Value;
use sha2::{Digest, Sha256};

/// Source stableJson sorts object keys by their UTF-16 units, including numeric
/// keys. Construct the JSON directly so ordinary property enumeration cannot
/// reorder those keys again. Arrays retain their original order.
pub fn payload_digest(value: &Value) -> String {
    fn stable(value: &Value) -> String {
        match value {
            Value::Array(items) => format!(
                "[{}]",
                items.iter().map(stable).collect::<Vec<_>>().join(",")
            ),
            Value::Object(object) => {
                let mut entries = object.iter().collect::<Vec<_>>();
                entries.sort_by(|(a, _), (b, _)| a.units().cmp(b.units()));
                format!(
                    "{{{}}}",
                    entries
                        .into_iter()
                        .map(|(k, v)| format!(
                            "{}:{}",
                            Value::String(k.clone()).stringify(),
                            stable(v)
                        ))
                        .collect::<Vec<_>>()
                        .join(",")
                )
            }
            value => value.stringify(),
        }
    }
    format!("{:x}", Sha256::digest(stable(value).as_bytes()))
}
