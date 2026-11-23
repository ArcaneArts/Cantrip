//! Synthetic driver of the real native presentation APIs; no real profile.
use super::*;
use cantrip_worker::{
    history::render,
    native_items::{self, command_output, raw},
};
pub fn run(input: &Value) -> Result<Value> {
    Ok(match input["op"].as_str().unwrap() {
        "presentation.render" => Value::Array(render::item(&input["item"], &input["context"])?),
        "presentation.normalize" => native_items::normalize(
            &input["item"],
            &input["cwd"],
            input["lifecycle"].as_str().unwrap(),
            &input["correlation"],
            &input["telemetry"],
        )?
        .unwrap_or(Value::Null),
        "presentation.capture" => {
            let bytes = |key: &str| -> Option<Vec<u8>> {
                input[key]
                    .as_array()
                    .map(|v| v.iter().map(|b| b.as_u64().unwrap() as u8).collect())
            };
            let request = bytes("requestBytes");
            let response = bytes("responseBytes");
            raw::envelope(
                request
                    .as_deref()
                    .map(raw::Input::Bytes)
                    .or_else(|| input.get("request").map(raw::Input::Json)),
                response
                    .as_deref()
                    .map(raw::Input::Bytes)
                    .or_else(|| input.get("response").map(raw::Input::Json)),
                &input["metadata"],
            )?
        }
        "presentation.redact" => Value::String(raw::redact(input["text"].as_js_string().unwrap())),
        "presentation.command.bound" => command_output::bounded(input.get("output"))?,
        "presentation.command.append" => {
            command_output::append(&input["current"], input["delta"].as_js_string().unwrap())
        }
        "presentation.command.transcript" => command_output::transcript(input.get("output"))?,
        "presentation.diff" => Value::object([
            (
                "latestLine",
                native_items::latest_changed_line(input["diff"].as_js_string().unwrap())
                    .map_or(Value::Null, Value::String),
            ),
            (
                "diffPreview",
                native_items::changed_lines_preview(input["diff"].as_js_string().unwrap())
                    .map_or(Value::Null, Value::String),
            ),
        ]),
        _ => bail!("Unknown native presentation fixture operation"),
    })
}
