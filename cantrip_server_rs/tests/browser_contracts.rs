use anyhow::{Context, Result};
use cantrip_server::wire::{self, ValidationError, Value};
use std::{path::PathBuf, process::Command};

#[test]
fn browser_query_diagnostics_match_actual_repository_statements() -> Result<()> {
    let output = Command::new("node")
        .args([
            "--import",
            "tsx",
            "scripts/server-rust/browser-query-manifest.mjs",
        ])
        .current_dir(PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap())
        .output()?;
    anyhow::ensure!(
        output.status.success(),
        "Reference query export failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        serde_json::from_slice::<Value>(&output.stdout)?,
        serde_json::from_str::<Value>(include_str!("../src/browsers/queries.json"))?
    );
    Ok(())
}
#[test]
fn browser_contracts_match_actual_protocol_exports() -> Result<()> {
    let mut total = 0;
    for name in [
        "encryptedBrowserCreateSchema",
        "encryptedBrowserUpdateSchema",
        "browserWireSummarySchema",
        "browserWireListSchema",
        "browserTunnelWireRequestSchema",
    ] {
        let output = Command::new("node")
            .args(["scripts/server-rust/security-oracle.mjs", "--vectors", name])
            .current_dir(PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap())
            .output()?;
        anyhow::ensure!(
            output.status.success(),
            "Reference failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let vectors: Value = serde_json::from_slice(&output.stdout)?;
        for (index, case) in vectors["cases"]
            .as_array()
            .context("Protocol vectors")?
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
            if let Some(expected) = case.get("errorMessage") {
                assert_eq!(
                    Value::String(actual["issues"].stringify_pretty().into()),
                    *expected,
                    "{name} message {index}"
                );
            }
            total += 1;
        }
    }
    println!("{total} browser protocol and error-message cases matched");
    Ok(())
}
