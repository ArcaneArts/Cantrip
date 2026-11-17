use crate::checked;
use anyhow::{Result, bail};
use cantrip_wire::{JsString, Value};

pub fn snapshot(raw: &Value, expected_thread: &JsString) -> Result<Value> {
    let mut parsed = checked("codexNativeHistorySnapshotSchema", raw)?;
    if parsed["thread"]["id"].as_js_string() != Some(expected_thread) {
        bail!("Native history belongs to a different thread.");
    }
    // Absence is unknown retained metadata, never measured zero usage.
    if parsed.get("history").is_none() {
        parsed["history"] = Value::Null;
    }
    Ok(parsed)
}
pub fn source(raw: &Value, thread: &JsString) -> Result<Value> {
    let mut frame = checked("nativeHistorySourceFrameSchema", raw)?;
    if frame["threadId"].as_js_string() != Some(thread) {
        bail!("Native history source belongs to another thread.");
    }
    if frame["kind"] == "snapshot" {
        if frame["readBarrierSequence"].as_f64() > frame["completedSequence"].as_f64() {
            bail!("Native history source has an invalid snapshot barrier.");
        }
        frame["snapshot"] = snapshot(&frame["snapshot"], thread)?;
    }
    Ok(frame)
}
