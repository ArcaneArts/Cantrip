use anyhow::{Context, Result};
use base64::{Engine, engine::general_purpose::STANDARD};
use cantrip_server::{tunnels::frame, wire::Value};
use std::{path::PathBuf, process::Command};

#[test]
fn tunnel_frame_bytes_and_failures_match_actual_codec() -> Result<()> {
    let output = Command::new("node")
        .args(["scripts/server-rust/tunnel-frame-oracle.mjs"])
        .current_dir(PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap())
        .output()?;
    anyhow::ensure!(
        output.status.success(),
        "Codec oracle: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let vectors: Value = serde_json::from_slice(&output.stdout)?;
    let cases = vectors["cases"].as_array().context("Codec vectors")?;
    for (index, case) in cases.iter().enumerate() {
        let input = &case["input"];
        let result = if input["op"] == "create" {
            frame::create(
                input["header"].clone(),
                &vec![91; input["payloadLength"].as_u64().unwrap_or(0) as usize],
            )
        } else {
            frame::decode(
                STANDARD
                    .decode(input["frame"].as_str().context("Frame bytes")?)?
                    .into(),
            )
        };
        let actual = match result {
            Ok(frame) => Value::object([(
                "value",
                Value::object([
                    ("header", frame.header().clone()),
                    (
                        "payload",
                        Value::String(STANDARD.encode(frame.payload()).into()),
                    ),
                    (
                        "frame",
                        Value::String(STANDARD.encode(frame.bytes()).into()),
                    ),
                ]),
            )]),
            Err(error) => Value::object([("error", Value::String(error.to_string().into()))]),
        };
        assert_eq!(
            actual, case["outcome"],
            "codec case {index}: {}",
            input["op"]
        );
    }
    println!(
        "{} actual tunnel codec byte/error cases matched",
        cases.len()
    );
    Ok(())
}
