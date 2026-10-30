use anyhow::{Context, Result};
use cantrip_server::wire::{self, ValidationError, Value};
use std::{path::PathBuf, process::Command};

fn oracle(args: &[&str]) -> Result<Value> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_owned();
    let output = Command::new("node")
        .arg("scripts/server-rust/security-oracle.mjs")
        .args(args)
        .current_dir(root)
        .output()?;
    anyhow::ensure!(
        output.status.success(),
        "Protocol oracle failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(serde_json::from_slice(&output.stdout)?)
}

#[test]
fn generated_contracts_match_the_current_protocol() -> Result<()> {
    assert_eq!(
        oracle(&["--manifest"])?,
        serde_json::from_str::<Value>(include_str!("../contracts/security.json"))?
    );
    Ok(())
}

#[test]
fn json_round_trips_match_ecmascript_numbers_order_and_every_utf16_unit() -> Result<()> {
    let cases = oracle(&["--json-vectors"])?;
    for (index, case) in cases
        .as_array()
        .context("JSON oracle cases")?
        .iter()
        .enumerate()
    {
        let raw = case["raw"].as_str().context("raw JSON input")?;
        let value: Value = serde_json::from_str(raw)?;
        assert_eq!(
            value.stringify(),
            case["expected"].as_str().unwrap(),
            "JSON case {index}: {raw}"
        );
        assert_eq!(serde_json::to_string(&value)?, value.stringify());
        assert_eq!(
            value.stringify_pretty(),
            case["expectedPretty"].as_str().unwrap(),
            "Pretty JSON case {index}: {raw}"
        );
    }
    println!(
        "{} ECMAScript JSON round trips matched",
        cases.as_array().unwrap().len()
    );
    Ok(())
}

#[test]
fn native_validation_matches_real_security_and_worker_schemas() -> Result<()> {
    let manifest: Value = serde_json::from_str(include_str!("../contracts/security.json"))?;
    let mut total = 0;
    let mut message_failures = 0;
    for name in manifest["roots"].as_object().unwrap().keys() {
        let name = name.as_str().context("protocol export name")?;
        // The full outgoing command corpus uses a streaming oracle in
        // worker_command_contracts so its inputs/errors stay bounded in memory.
        if name == "workerRequestEnvelopeSchema" {
            continue;
        }
        let vectors = oracle(&["--vectors", name]).with_context(|| name.to_owned())?;
        let mut reported_message = false;
        for (index, case) in vectors["cases"].as_array().unwrap().iter().enumerate() {
            let actual = match wire::parse(name, case.get("input")) {
                Ok(value) => Value::object([("ok", value)]),
                Err(ValidationError::Invalid(issues)) => {
                    Value::object([("issues", Value::Array(issues))])
                }
                Err(ValidationError::Operation) => {
                    Value::object([("thrown", Value::String("TypeError".into()))])
                }
            };
            assert_eq!(
                actual,
                case["outcome"],
                "{name} case {index}: {}",
                case.get("input")
                    .unwrap_or(&Value::String("<missing>".into()))
            );
            total += 1;
            if let Some(expected) = case.get("errorMessage") {
                let message = Value::String(actual["issues"].stringify_pretty().into());
                if message != *expected {
                    message_failures += 1;
                    if !reported_message {
                        println!(
                            "MESSAGE_MISMATCH {}",
                            Value::object([
                                ("schema", Value::String(name.into())),
                                ("case", Value::from_serialize(&index)),
                                ("actual", message),
                                ("expected", expected.clone())
                            ])
                        );
                        reported_message = true;
                    }
                }
            }
        }
        println!(
            "{} Node/Rust cases matched for {name}",
            vectors["cases"].as_array().unwrap().len()
        );
    }
    println!("{total} actual protocol cases matched");
    assert_eq!(
        message_failures, 0,
        "Exact protocol validation error messages must match Node."
    );
    Ok(())
}
