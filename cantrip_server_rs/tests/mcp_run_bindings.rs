use anyhow::{Context, Result};
use cantrip_server::{agent_alerts, wire::Value};
use serde_json::json;
use std::{path::Path, process::Command};

#[test]
fn all_mcp_bindings_match_source_authority_and_readiness() -> Result<()> {
    let output = Command::new("node")
        .args([
            "--import",
            "tsx",
            "scripts/server-rust/mcp-run-binding-oracle.mjs",
            "--all-operations",
        ])
        .current_dir(Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap())
        .output()?;
    anyhow::ensure!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let oracle: Value = serde_json::from_slice(&output.stdout)?;
    assert_eq!(
        Value::from_serialize(&agent_alerts::OPERATIONS),
        oracle["operations"],
        "advertised operations preserve the complete Source registry and order"
    );
    let mutations = agent_alerts::OPERATIONS
        .iter()
        .filter(|operation| agent_alerts::is_mutation(operation))
        .copied()
        .collect::<Vec<_>>();
    assert_eq!(Value::from_serialize(&mutations), oracle["mutations"]);
    let now = oracle["now"].as_i64().context("Source clock")?;
    let cases = oracle["cases"].as_array().context("Source binding cases")?;
    for (index, case) in cases.iter().enumerate() {
        let operation = case["operation"].as_str().context("Source operation")?;
        let actual = match agent_alerts::validate_binding(
            "owner",
            &case["binding"],
            &case["context"],
            operation,
            &case["permission"],
            now,
        ) {
            Ok(()) => Value::from_serialize(&json!({"ok":true})),
            Err(error) => Value::from_serialize(
                &json!({"status":error.status,"code":error.code,"message":error.message}),
            ),
        };
        assert_eq!(
            actual, case["outcome"],
            "authority case{index}: {operation} {}",
            case["variant"]
        );
        assert_eq!(
            agent_alerts::readiness(&case["binding"], &case["context"], &case["permission"]),
            case["readiness"],
            "readiness case{index}: {operation} {}",
            case["variant"]
        );
    }
    println!(
        "{} actual Source MCP authority/readiness pairs matched",
        cases.len()
    );
    Ok(())
}
