//! Worker-owned, encrypted evidence before projection or server acknowledgment.
//! No server application, database, HTTP client, runtime or process ownership.
pub mod content;
pub mod cursor;
pub mod files;
pub mod native;
pub mod reducer;
pub mod source;

use anyhow::{Result, anyhow};
use cantrip_wire::Value;
use sha2::{Digest, Sha256};

pub(crate) fn checked(schema: &str, value: &Value) -> Result<Value> {
    cantrip_protocol::parse(schema, Some(value)).map_err(cantrip_protocol::response::response_error)
}
pub(crate) fn parse(text: &str) -> Result<Value> {
    cantrip_wire::parse_json_text(text).map_err(|error| anyhow!("{}", error.lossy()))
}
/// Source journal hashes preserve parsed field order. They are deliberately
/// different from sorted canonical payload digests used by batch archives.
pub fn source_digest(value: &Value) -> String {
    Sha256::digest(value.stringify().as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
