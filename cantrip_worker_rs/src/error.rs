//! Retain endpoint error messages as UTF-16 until the wire response is encoded.
use cantrip_wire::JsString;
#[derive(Debug)]
pub struct WireError(pub JsString);
impl std::fmt::Display for WireError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0.lossy())
    }
}
impl std::error::Error for WireError {}
pub fn message(error: &anyhow::Error) -> JsString {
    if let Some(error) = error.downcast_ref::<crate::codex::rpc_requests::Failure>() {
        return error.message.clone();
    }
    if error.is::<crate::metadata::DelayAborted>() {
        return error.to_string().into();
    }
    error
        .downcast_ref::<WireError>()
        .map_or_else(|| error.to_string().into(), |error| error.0.clone())
}
