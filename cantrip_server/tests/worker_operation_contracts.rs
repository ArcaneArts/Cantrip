use anyhow::{Context, Result};
use cantrip_server::wire::{self, ValidationError, Value};
use std::{path::Path, process::Command};

#[test]
fn worker_operation_contracts_match_source() -> Result<()> {
    let mut count = 0;
    for schema in [
        "cantripVersionSchema",
        "codeGraphActionAcknowledgementSchema",
        "codeGraphProjectStatusSchema",
        "managedWebRuntimeActionRequestSchema",
        "managedWebRuntimeActionResultSchema",
    ] {
        let output = Command::new("node")
            .args([
                "--import",
                "tsx",
                "scripts/server-rust/worker-operation-contract-oracle.mjs",
                schema,
            ])
            .current_dir(Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap())
            .output()?;
        anyhow::ensure!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let data: Value = serde_json::from_slice(&output.stdout)?;
        for (index, case) in data["cases"]
            .as_array()
            .context("Source contract cases")?
            .iter()
            .enumerate()
        {
            let actual = match wire::parse(schema, case.get("input")) {
                Ok(value) => Value::object([("ok", value)]),
                Err(ValidationError::Invalid(issues)) => {
                    Value::object([("issues", Value::Array(issues))])
                }
                Err(ValidationError::Operation) => {
                    Value::object([("thrown", Value::String("TypeError".into()))])
                }
            };
            assert_eq!(actual, case["outcome"], "{schema} case{index}");
            if let Some(message) = case.get("errorMessage") {
                assert_eq!(
                    Value::String(actual["issues"].stringify_pretty().into()),
                    *message,
                    "{schema} error{index}"
                );
            }
            count += 1;
        }
    }
    println!("{count} actual worker operation value/issue/exact-error comparisons matched");
    Ok(())
}
