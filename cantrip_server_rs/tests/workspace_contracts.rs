use anyhow::{Context, Result};
use cantrip_server::wire::{self, ValidationError, Value};
use std::{path::PathBuf, process::Command};
#[test]
fn workspace_ownership_matches_actual_protocol_and_error_messages() -> Result<()> {
    let mut count = 0;
    for name in [
        "workspaceOwnershipSchema",
        "workspaceTabSchema",
        "projectCenterLayoutNodeSchema",
    ] {
        let output = Command::new("node")
            .args(["scripts/server-rust/workspace-contract-oracle.mjs", name])
            .current_dir(PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap())
            .output()?;
        anyhow::ensure!(
            output.status.success(),
            "Source oracle failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let vectors: Value = serde_json::from_slice(&output.stdout)?;
        for (index, case) in vectors["cases"]
            .as_array()
            .context("Ownership cases")?
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
            if let Some(message) = case.get("errorMessage") {
                assert_eq!(
                    Value::String(actual["issues"].stringify_pretty().into()),
                    *message,
                    "{name} error message {index}"
                );
            }
            count += 1;
        }
    }
    println!("{count} actual workspace validation/error cases matched");
    Ok(())
}
