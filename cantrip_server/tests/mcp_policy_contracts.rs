use anyhow::{Context, Result};
use cantrip_server::wire::{self, ValidationError, Value};
use std::{path::Path, process::Command};

#[test]
fn opaque_mcp_policy_results_match_source() -> Result<()> {
    let mut count = 0;
    for schema in [
        "policyCliWireListResultSchema",
        "policyCliWireReadResultSchema",
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
        for (index, case) in vectors["cases"]
            .as_array()
            .context("MCP policy vectors")?
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
            assert_eq!(actual, case["outcome"], "{schema} case {index}");
            if let Some(message) = case.get("errorMessage") {
                assert_eq!(
                    Value::String(actual["issues"].stringify_pretty().into()),
                    *message,
                    "{schema} error {index}"
                );
            }
            count += 1;
        }
    }
    println!(
        "{count} actual Source MCP policy normalization/value/issue/error comparisons matched"
    );
    Ok(())
}
