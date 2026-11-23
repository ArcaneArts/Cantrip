use anyhow::{Context, Result};
use cantrip_server::wire::{self, ValidationError, Value};
use std::{path::PathBuf, process::Command};

#[test]
fn project_surface_contracts_match_actual_protocol() -> Result<()> {
    let mut count = 0;
    for name in [
        "encryptedExplorerCreateSchema",
        "encryptedExplorerUpdateSchema",
        "encryptedExplorerPinSchema",
        "encryptedExplorerViewStateUpdateSchema",
        "encryptedExplorerWorktreeUpdateSchema",
        "explorerWireSummarySchema",
        "explorerWireListSchema",
        "explorerOperationWireRequestSchema",
        "encryptedCodeTabCreateSchema",
        "encryptedCodeTabUpdateSchema",
        "codeTabWireSummarySchema",
        "codeTabWireListSchema",
        "encryptedProjectViewCreateSchema",
        "encryptedProjectViewUpdateSchema",
        "projectViewWireSummarySchema",
        "projectViewWireListSchema",
    ] {
        let output = Command::new("node")
            .args([
                "scripts/server-rust/project-surface-contract-oracle.mjs",
                name,
            ])
            .current_dir(PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap())
            .output()?;
        anyhow::ensure!(
            output.status.success(),
            "Source project surface oracle: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let data: Value = serde_json::from_slice(&output.stdout)?;
        for (index, case) in data["cases"]
            .as_array()
            .context("Project surface oracle cases")?
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
                    "{name} pretty error {index}"
                );
            }
            count += 1;
        }
    }
    println!("{count} actual project surface validation and error cases matched");
    Ok(())
}
