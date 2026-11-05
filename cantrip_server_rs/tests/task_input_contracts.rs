use anyhow::{Context, Result};
use cantrip_server::wire::{self, ValidationError, Value};
use std::{path::Path, process::Command};

#[test]
fn task_input_receipts_and_worker_bindings_match_source() -> Result<()> {
    let output = Command::new("node")
        .arg("scripts/server-rust/task-input-worker-oracle.mjs")
        .current_dir(Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap())
        .output()?;
    anyhow::ensure!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let mut count = 0;
    let mut done = None;
    for line in std::str::from_utf8(&output.stdout)?.lines() {
        let case: Value = serde_json::from_str(line)?;
        if let Some(receipt) = case.get("done") {
            anyhow::ensure!(done.is_none(), "Duplicate completion receipt");
            done = receipt.as_u64();
            continue;
        }
        anyhow::ensure!(done.is_none(), "Data after completion receipt");
        let schema = case["schema"].as_str().context("Task input schema")?;
        let actual = match wire::parse(schema, case.get("input")) {
            Ok(value) => Value::object([("ok", value)]),
            Err(ValidationError::Invalid(issues)) => {
                Value::object([("issues", Value::Array(issues))])
            }
            Err(ValidationError::Operation) => {
                Value::object([("thrown", Value::String("TypeError".into()))])
            }
        };
        assert_eq!(
            actual, case["outcome"],
            "{schema} case {count} {}",
            case["name"]
        );
        if let Some(message) = case.get("errorMessage") {
            assert_eq!(
                Value::String(actual["issues"].stringify_pretty().into()),
                *message,
                "{schema} error {count}"
            );
        }
        count += 1;
    }
    anyhow::ensure!(
        count > 0 && done == Some(count),
        "Incomplete Task oracle receipt"
    );
    println!("{count} actual Source Task input value/issue/error comparisons matched");
    Ok(())
}
