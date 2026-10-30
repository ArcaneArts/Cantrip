use anyhow::{Context, Result};
use cantrip_server::wire::{self, ValidationError, Value};
use std::{path::PathBuf, process::Command};

#[test]
fn worktree_recovery_errors_match_protocol() -> Result<()> {
    let output = Command::new("node")
        .arg("scripts/server-rust/worktree-contract-oracle.mjs")
        .current_dir(PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap())
        .output()?;
    anyhow::ensure!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let data: Value = serde_json::from_slice(&output.stdout)?;
    let cases = data["cases"]
        .as_array()
        .context("Recovery contract cases")?;
    for (index, case) in cases.iter().enumerate() {
        let actual = match wire::parse("worktreeCreateMutationFailureSchema", case.get("input")) {
            Ok(value) => Value::object([("ok", value)]),
            Err(ValidationError::Invalid(issues)) => {
                Value::object([("issues", Value::Array(issues))])
            }
            Err(ValidationError::Operation) => {
                Value::object([("thrown", Value::String("TypeError".into()))])
            }
        };
        assert_eq!(actual, case["outcome"], "case {index}");
        if let Some(message) = case.get("errorMessage") {
            assert_eq!(
                Value::String(actual["issues"].stringify_pretty().into()),
                *message,
                "case {index} serialized issues"
            );
        }
    }
    assert_eq!(cases.len(), 42);
    Ok(())
}

#[test]
fn runtime_operation_results_match_protocol() -> Result<()> {
    let output = Command::new("node")
        .arg("scripts/server-rust/run-runtime-contract-oracle.mjs")
        .current_dir(PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap())
        .output()?;
    anyhow::ensure!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let data: Value = serde_json::from_slice(&output.stdout)?;
    let cases = data["cases"]
        .as_array()
        .context("Recovery contract cases")?;
    for (index, case) in cases.iter().enumerate() {
        let actual = match wire::parse(
            "runConfigurationRuntimeWorkerOperationResultSchema",
            case.get("input"),
        ) {
            Ok(value) => Value::object([("ok", value)]),
            Err(ValidationError::Invalid(issues)) => {
                Value::object([("issues", Value::Array(issues))])
            }
            Err(ValidationError::Operation) => {
                Value::object([("thrown", Value::String("TypeError".into()))])
            }
        };
        assert_eq!(actual, case["outcome"], "case {index}");
        if let Some(message) = case.get("errorMessage") {
            assert_eq!(
                Value::String(actual["issues"].stringify_pretty().into()),
                *message,
                "case {index} serialized issues"
            );
        }
    }
    assert_eq!(cases.len(), 68);
    Ok(())
}

#[test]
fn run_definition_responses_match_protocol() -> Result<()> {
    let output = Command::new("node")
        .arg("scripts/server-rust/run-definition-contract-oracle.mjs")
        .current_dir(PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap())
        .output()?;
    anyhow::ensure!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let data: Value = serde_json::from_slice(&output.stdout)?;
    let cases = data["cases"]
        .as_array()
        .context("Run definition contracts")?;
    for (index, case) in cases.iter().enumerate() {
        let actual = match wire::parse(case["schema"].as_str().unwrap(), case.get("input")) {
            Ok(value) => Value::object([("ok", value)]),
            Err(ValidationError::Invalid(issues)) => {
                Value::object([("issues", Value::Array(issues))])
            }
            Err(ValidationError::Operation) => {
                Value::object([("thrown", Value::String("TypeError".into()))])
            }
        };
        assert_eq!(actual, case["outcome"], "Run definition contract {index}");
    }
    assert_eq!(cases.len(), 106);
    Ok(())
}
