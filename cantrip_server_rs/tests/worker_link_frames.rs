use anyhow::{Context, Result};
use base64::{Engine, engine::general_purpose::STANDARD};
use cantrip_server::{
    wire::{self, ValidationError, Value},
    worker_links::{Error, frame},
};
use sha2::{Digest, Sha256};
use std::{path::PathBuf, process::Command};
fn json(value: impl serde::Serialize) -> Value {
    Value::from_serialize(&value)
}
fn payload(length: usize) -> Vec<u8> {
    (0..length).map(|n| n as u8).collect()
}
fn number(value: &Value, key: &str) -> u64 {
    value[key].as_f64().unwrap() as u64
}
fn raw(value: &Value, key: &str) -> Vec<u8> {
    STANDARD.decode(value[key].as_str().unwrap()).unwrap()
}
fn outcome(result: std::result::Result<Value, Error>) -> Value {
    match result {
        Ok(value) => Value::object([("ok", value)]),
        Err(error) => Value::object([("error", json(error.to_string()))]),
    }
}
fn details(frame: frame::Frame) -> Value {
    Value::object([
        ("header", frame.header().clone()),
        ("bytes", json(STANDARD.encode(frame.bytes()))),
        ("payload", json(STANDARD.encode(frame.payload()))),
    ])
}

#[test]
fn binary_frames_and_remote_chunks_match_actual_protocol() -> Result<()> {
    let output = Command::new("node")
        .arg("scripts/server-rust/worker-link-frame-oracle.mjs")
        .current_dir(PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap())
        .output()?;
    anyhow::ensure!(
        output.status.success(),
        "Actual frame oracle failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let vectors: Value = serde_json::from_slice(&output.stdout)?;
    for (i, case) in vectors["cases"]
        .as_array()
        .context("Frame cases")?
        .iter()
        .enumerate()
    {
        let actual = match case["op"].as_str().unwrap() {
            "signaling-limit" => {
                let signals = (0..number(case, "count"))
                    .map(|sequence| {
                        let mut value = case["template"].clone();
                        value["signalSequence"] = json(sequence);
                        value["signal"] = Value::object([
                            ("type", json("offer")),
                            ("sdp", json("🦀".repeat(200000))),
                        ]);
                        value
                    })
                    .collect();
                let mut input = if case["mailbox"] == true {
                    case["mailboxTemplate"].clone()
                } else {
                    Value::Object(Default::default())
                };
                input["signals"] = Value::Array(signals);
                match wire::parse(case["root"].as_str().unwrap(), Some(&input)) {
                    Ok(value) => Value::object([
                        ("accepted", json(true)),
                        (
                            "sha256",
                            json(format!(
                                "{:x}",
                                Sha256::digest(value.stringify().as_bytes())
                            )),
                        ),
                    ]),
                    Err(ValidationError::Invalid(issues)) => {
                        let issues = Value::Array(issues);
                        Value::object([
                            ("accepted", json(false)),
                            ("errorMessage", json(issues.stringify_pretty())),
                            ("issues", issues),
                        ])
                    }
                    Err(ValidationError::Operation) => {
                        anyhow::bail!("Native signaling validation failed")
                    }
                }
            }
            "create" => outcome(
                frame::create(
                    case["header"].clone(),
                    &payload(number(case, "length") as usize),
                )
                .map(details),
            ),
            "decode" => {
                let bytes = raw(case, "bytes");
                assert_eq!(json(frame::is_frame(&bytes)), case["isFrame"]);
                outcome(frame::decode(bytes.into()).map(details))
            }
            "chunk-create" => {
                let bytes = payload(number(case, "length") as usize);
                outcome(
                    frame::encode_chunk(&frame::Chunk {
                        frame_id: number(case, "frameId"),
                        frame_length: number(case, "frameLength"),
                        offset: number(case, "offset"),
                        payload: &bytes,
                    })
                    .map(|b| json(STANDARD.encode(b))),
                )
            }
            "chunk-decode" => outcome(frame::decode_chunk(&raw(case, "bytes")).map(|c| {
                Value::object([
                    ("frameId", json(c.frame_id)),
                    ("frameLength", json(c.frame_length)),
                    ("offset", json(c.offset)),
                    ("payload", json(STANDARD.encode(c.payload))),
                ])
            })),
            "assemble" => {
                let mut assembler = frame::Assembler::new(case["replace"] == true);
                Value::Array(
                    case["chunks"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|chunk| {
                            if chunk.is_null() {
                                assembler.reset();
                                return outcome(Ok(Value::Null));
                            }
                            outcome(
                                assembler
                                    .push(&STANDARD.decode(chunk.as_str().unwrap()).unwrap())
                                    .map(|v| v.map_or(Value::Null, |v| json(STANDARD.encode(v)))),
                            )
                        })
                        .collect(),
                )
            }
            _ => anyhow::bail!("Unknown frame vector"),
        };
        assert_eq!(
            actual,
            case["outcome"],
            "frame case {i} {}",
            case["op"].stringify()
        );
    }
    println!(
        "{} actual binary frame/chunk/assembly cases matched",
        vectors["cases"].as_array().unwrap().len()
    );
    Ok(())
}
