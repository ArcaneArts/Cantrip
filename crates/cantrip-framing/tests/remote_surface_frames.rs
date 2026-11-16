use anyhow::{Context, Result};
use base64::{Engine, engine::general_purpose::STANDARD};
use cantrip_framing::remote_surface as frame;
use cantrip_protocol::{Value, value::json};
use sha2::{Digest, Sha256};
use std::{path::Path, process::Command, sync::Arc};

#[test]
fn remote_surface_bytes_errors_and_retained_buffers_match_source() -> Result<()> {
    let output = Command::new("node")
        .arg("scripts/server-rust/remote-surface-frame-oracle.mjs")
        .current_dir(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .ancestors()
                .nth(2)
                .unwrap(),
        )
        .output()?;
    anyhow::ensure!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let cases: Value = serde_json::from_slice(&output.stdout)?;
    for case in cases.as_array().context("frame cases")? {
        let input = &case["input"];
        let result = if input["op"] == "create" {
            frame::create(
                input["header"].clone(),
                &vec![91; input["payloadLength"].as_u64().unwrap() as usize],
            )
        } else {
            let bytes: Arc<[u8]> = if input["op"] == "bytes" {
                STANDARD.decode(input["bytes"].as_str().unwrap())?.into()
            } else {
                let header = STANDARD.decode(input["headerBytes"].as_str().unwrap())?;
                let length = input["declared"].as_u64().unwrap_or(header.len() as u64) as u32;
                let mut bytes = b"CTRS".to_vec();
                bytes.extend_from_slice(&length.to_be_bytes());
                bytes.extend_from_slice(&header);
                bytes.resize(
                    bytes.len() + input["payloadLength"].as_u64().unwrap() as usize,
                    91,
                );
                bytes.into()
            };
            let decoded = frame::decode(bytes.clone());
            if let Ok(frame) = &decoded {
                assert_eq!(
                    frame.bytes().as_ptr(),
                    bytes.as_ptr(),
                    "decoded bytes must be retained, including ignored header fields"
                );
                assert_eq!(frame.clone().bytes().as_ptr(), bytes.as_ptr());
            }
            decoded
        };
        let actual = match result {
            Ok(frame) => json!({"value":json!({
                "header":frame.header(),
                "frameHash":format!("{:x}",Sha256::digest(frame.bytes())),
                "payloadHash":format!("{:x}",Sha256::digest(frame.payload())),
            })}),
            Err(error) => json!({"error":error.to_string()}),
        };
        assert_eq!(actual, case["outcome"], "{}", input.stringify());
    }
    println!(
        "{} actual remote-surface codec cases matched",
        cases.as_array().unwrap().len()
    );
    Ok(())
}
