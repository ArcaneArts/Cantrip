//! WorkerLink value validation, error classification, and stable identity keys.
//! Keys require validated identities and convey no session or resource authority.
use crate::{JsString, Value};
use std::sync::Arc;

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Clone, Debug)]
pub enum Error {
    Unavailable(JsString),
    Failure(Arc<anyhow::Error>),
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unavailable(v) => f.write_str(&v.lossy()),
            Self::Failure(v) => v.fmt(f),
        }
    }
}
impl std::error::Error for Error {}
impl From<anyhow::Error> for Error {
    fn from(value: anyhow::Error) -> Self {
        Self::Failure(Arc::new(value))
    }
}
pub fn checked(schema: &str, value: Value) -> Result<Value> {
    crate::parse(schema, Some(&value)).map_err(|e| crate::response::response_error(e).into())
}
fn key(parts: &[&Value]) -> Vec<u16> {
    let mut out = Vec::new();
    for part in parts {
        let part = part.as_js_string().expect("validated WorkerLink identity");
        out.extend(format!("{}:", part.len()).encode_utf16());
        out.extend_from_slice(part.units());
    }
    out
}
pub fn identity_key(identity: &Value) -> Vec<u16> {
    key(&[
        &identity["serverId"],
        &identity["serverGeneration"],
        &identity["ownerId"],
        &identity["accountSessionId"],
        &identity["clientInstanceId"],
        &identity["workerId"],
        &identity["workerProcessGeneration"],
    ])
}
pub fn resource_key(owner: &Value, kind: &Value, resource: &Value) -> Vec<u16> {
    key(&[owner, kind, resource])
}
