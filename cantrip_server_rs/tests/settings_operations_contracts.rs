use anyhow::{Context, Result};
use cantrip_server::{
    settings::provider_connection,
    wire::{self, ValidationError, Value},
};
use std::{path::Path, process::Command};

#[test]
fn settings_operation_responses_match_actual_source() -> Result<()> {
    let mut total = 0;
    for schema in [
        "desktopUpdateActiveWorkSummarySchema",
        "providerConnectionTestResultSchema",
        "workerProviderConnectionTestResultSchema",
    ] {
        let output = Command::new("node")
            .args([
                "scripts/server-rust/security-oracle.mjs",
                "--vectors",
                schema,
            ])
            .current_dir(Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap())
            .output()?;
        anyhow::ensure!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let vectors: Value = serde_json::from_slice(&output.stdout)?;
        for (i, case) in vectors["cases"]
            .as_array()
            .context("response cases")?
            .iter()
            .enumerate()
        {
            let actual = match wire::parse(schema, case.get("input")) {
                Ok(v) => Value::object([("ok", v)]),
                Err(ValidationError::Invalid(issues)) => {
                    Value::object([("issues", Value::Array(issues))])
                }
                Err(ValidationError::Operation) => {
                    Value::object([("thrown", Value::String("TypeError".into()))])
                }
            };
            assert_eq!(actual, case["outcome"], "{schema} case{i}");
            if let Some(message) = case.get("errorMessage") {
                assert_eq!(
                    Value::String(actual["issues"].stringify_pretty().into()),
                    *message,
                    "{schema} message{i}"
                );
            }
            total += 1;
        }
    }
    println!("{total} actual Source settings response contract cases matched");
    Ok(())
}
#[test]
fn provider_failure_precedence_and_utf16_details_match_source() -> Result<()> {
    let output = Command::new("node")
        .args([
            "--import",
            "tsx",
            "scripts/server-rust/provider-connection-oracle.mjs",
        ])
        .current_dir(Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap())
        .output()?;
    anyhow::ensure!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let vectors: Value = serde_json::from_slice(&output.stdout)?;
    let cases = vectors["cases"].as_array().context("failure cases")?;
    for (i, case) in cases.iter().enumerate() {
        let input = case["input"].as_js_string().context("failure text")?;
        let stage = provider_connection::failure_stage(input);
        assert_eq!(stage.name(), case["stage"].as_str().unwrap(), "stage{i}");
        assert_eq!(
            Value::String(stage.message(input)),
            case["message"],
            "message{i}"
        );
    }
    println!(
        "{} actual Source provider failure stages/details matched",
        cases.len()
    );
    Ok(())
}
