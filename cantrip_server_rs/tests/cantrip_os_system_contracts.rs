use anyhow::{Context, Result};
use cantrip_server::wire::{self, ValidationError, Value};
use std::{path::PathBuf, process::Command};

#[test]
fn system_ciphertext_bounds_and_completion_match_source() -> Result<()> {
    let output = Command::new("node")
        .arg("scripts/server-rust/cantrip-os-system-policy-vectors.mjs")
        .current_dir(PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap())
        .output()?;
    anyhow::ensure!(
        output.status.success(),
        "Source oracle: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let cases: Value = serde_json::from_slice(&output.stdout)?;
    for (index, case) in cases
        .as_array()
        .context("System policy cases")?
        .iter()
        .enumerate()
    {
        let name = case["schema"].as_str().context("System policy schema")?;
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
            actual, case["outcome"],
            "System policy/bound {index} {name}"
        );
    }
    println!(
        "7 explicit system completion, command-envelope and ciphertext-bound cases matched source"
    );
    Ok(())
}

#[test]
fn system_contracts_match_actual_source_protocol() -> Result<()> {
    let mut count = 0;
    for name in [
        "cantripOsSystemScopeSchema",
        "cantripOsSystemTargetSchema",
        "cantripOsSystemReferenceSchema",
        "cantripOsSystemBaseImageSchema",
        "cantripOsSystemSourceSchema",
        "cantripOsSystemOperationCommandSchema",
        "cantripOsSystemWorkerCommandSchema",
        "cantripOsSystemStatusResultSchema",
        "cantripOsSystemOperationContextSchema",
        "cantripOsSystemProtectedOperationResultSchema",
        "cantripOsSystemRootReceiptSchema",
        "cantripOsSystemOperationResultSchema",
        "cantripOsSystemPrivateOperationResultSchema",
    ] {
        let output = Command::new("node")
            .args(["scripts/server-rust/security-oracle.mjs", "--vectors", name])
            .current_dir(PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap())
            .output()?;
        anyhow::ensure!(
            output.status.success(),
            "Source oracle: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let vectors: Value = serde_json::from_slice(&output.stdout)?;
        for (index, case) in vectors["cases"]
            .as_array()
            .context("Source cases")?
            .iter()
            .enumerate()
        {
            let actual = match wire::parse(name, case.get("input")) {
                Ok(value) => Value::object([("ok", value)]),
                Err(ValidationError::Invalid(issues)) => {
                    Value::object([("issues", Value::Array(issues))])
                }
                Err(ValidationError::Operation) => {
                    Value::object([("thrown", Value::String("TypeError".into()))])
                }
            };
            assert_eq!(actual, case["outcome"], "{name} case {index}");
            count += 1;
        }
    }
    println!("{count} system command/result cases matched actual source");
    Ok(())
}
