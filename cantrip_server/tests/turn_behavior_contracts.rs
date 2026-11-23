use anyhow::{Context, Result};
use cantrip_server::wire::{self, ValidationError, Value};
use std::{path::PathBuf, process::Command};
#[test]
fn native_behavior_evidence_matches_source_validation() -> Result<()> {
    let name = "nativeBehaviorAttributionSchema";
    let output = Command::new("node")
        .args(["scripts/server-rust/security-oracle.mjs", "--vectors", name])
        .current_dir(PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap())
        .output()?;
    anyhow::ensure!(
        output.status.success(),
        "Native behavior oracle failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let vectors: Value = serde_json::from_slice(&output.stdout)?;
    let cases = vectors["cases"]
        .as_array()
        .context("Behavior protocol vectors")?;
    for (index, case) in cases.iter().enumerate() {
        let actual = match wire::parse(name, case.get("input")) {
            Ok(value) => Value::object([("ok", value)]),
            Err(ValidationError::Invalid(issues)) => {
                Value::object([("issues", Value::Array(issues))])
            }
            Err(ValidationError::Operation) => {
                Value::object([("thrown", Value::String("TypeError".into()))])
            }
        };
        assert_eq!(actual, case["outcome"], "{name} case{index}");
        if let Some(message) = case.get("errorMessage") {
            assert_eq!(
                Value::String(actual["issues"].stringify_pretty().into()),
                *message,
                "{name} message{index}"
            );
        }
    }
    println!(
        "{} native behavior evidence protocol outcomes and messages matched",
        cases.len()
    );
    Ok(())
}
