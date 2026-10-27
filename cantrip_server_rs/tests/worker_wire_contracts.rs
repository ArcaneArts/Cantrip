use anyhow::{Context, Result};
use cantrip_server::wire::{self, ValidationError, Value};
use std::{path::PathBuf, process::Command};

#[test]
fn complete_worker_envelopes_match_actual_protocol_normalization_and_errors() -> Result<()> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_owned();
    let output = Command::new("node")
        .args([
            "scripts/server-rust/worker-wire-oracle.mjs",
            "--worker-vectors",
        ])
        .current_dir(root)
        .output()?;
    anyhow::ensure!(
        output.status.success(),
        "Worker protocol oracle failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let vectors: Value = serde_json::from_slice(&output.stdout)?;
    let cases = vectors.as_array().context("worker protocol cases")?;
    for (index, case) in cases.iter().enumerate() {
        let input = case
            .get("raw")
            .and_then(Value::as_str)
            .map(serde_json::from_str::<Value>)
            .transpose()?;
        let result = match wire::parse("workerServerEnvelopeSchema", input.as_ref()) {
            Ok(value) => Value::object([("ok", value)]),
            Err(ValidationError::Invalid(issues)) => {
                Value::object([("issues", Value::Array(issues))])
            }
            Err(ValidationError::Operation) => {
                Value::object([("thrown", Value::String("TypeError".into()))])
            }
        };
        // The wire canonicalizes nonfinite values allowed by z.unknown to null.
        let actual: Value = serde_json::from_str(&result.stringify())?;
        assert_eq!(
            actual, case["outcome"],
            "worker case {index}: {}",
            case["name"]
        );
    }
    println!(
        "{} complete worker envelope comparisons matched",
        cases.len()
    );
    Ok(())
}
