use anyhow::{Context, Result};
use cantrip_server::wire::{self, ValidationError, Value};
use std::{path::Path, process::Command};

#[test]
fn mcp_settings_contracts_match_actual_protocol() -> Result<()> {
    let mut total = 0;
    let mut differences = 0;
    for schema in [
        "encryptedMcpServerCreateSchema",
        "encryptedMcpServerUpdateSchema",
        "mcpServerWireSummarySchema",
        "mcpServerWireListSchema",
        "mcpServerDiscoveryResultSchema",
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
            "{schema}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let vectors: Value = serde_json::from_slice(&output.stdout)?;
        for (index, case) in vectors["cases"]
            .as_array()
            .context("MCP settings cases")?
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
            let differs = actual != case["outcome"]
                || case.get("errorMessage").is_some_and(|message| {
                    Value::String(actual["issues"].stringify_pretty().into()) != *message
                });
            if differs {
                differences += 1;
                if differences <= 20 {
                    eprintln!(
                        "{schema} case {index}\ninput: {}\nexpected: {}\nactual: {}",
                        case.get("input").unwrap_or(&Value::Null).stringify(),
                        case["outcome"].stringify(),
                        actual.stringify()
                    );
                }
            }
            total += 1;
        }
    }
    assert_eq!(
        differences, 0,
        "{differences} differences across {total} actual Source MCP settings contract cases"
    );
    println!(
        "{total} actual Source MCP settings contracts, transformations and exact validation messages matched"
    );
    Ok(())
}

#[test]
fn mcp_boundaries_and_worker_binding_match_actual_source() -> Result<()> {
    let output = Command::new("node")
        .arg("scripts/server-rust/mcp-settings-boundary-oracle.mjs")
        .current_dir(Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap())
        .output()?;
    anyhow::ensure!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let vectors: Value = serde_json::from_slice(&output.stdout)?;
    let cases = vectors["cases"].as_array().context("MCP boundaries")?;
    for (index, case) in cases.iter().enumerate() {
        let schema = case["schema"].as_str().context("MCP boundary schema")?;
        let actual = match wire::parse(schema, case.get("input")) {
            Ok(value) => Value::object([("ok", value)]),
            Err(ValidationError::Invalid(issues)) => {
                Value::object([("issues", Value::Array(issues))])
            }
            Err(ValidationError::Operation) => {
                Value::object([("thrown", Value::String("TypeError".into()))])
            }
        };
        assert_eq!(actual, case["outcome"], "{schema} boundary{index}");
        if let Some(message) = case.get("errorMessage") {
            assert_eq!(
                Value::String(actual["issues"].stringify_pretty().into()),
                *message,
                "{schema} exact error{index}"
            );
        }
    }
    println!(
        "{} exact Source MCP large-array and worker-binding boundaries matched",
        cases.len()
    );
    Ok(())
}
