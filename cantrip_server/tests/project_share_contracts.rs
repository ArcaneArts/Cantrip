use anyhow::{Context, Result};
use cantrip_server::wire::{self, ValidationError, Value};
use std::{path::PathBuf, process::Command};
#[test]
fn share_queries_match_actual_repository() -> Result<()> {
    let output = Command::new("node")
        .args([
            "--import",
            "tsx",
            "scripts/server-rust/project-share-query-manifest.mjs",
        ])
        .current_dir(PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap())
        .output()?;
    anyhow::ensure!(
        output.status.success(),
        "Reference query export failed:{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        serde_json::from_slice::<Value>(&output.stdout)?,
        serde_json::from_str::<Value>(include_str!("../src/project_shares/queries.json"))?
    );
    Ok(())
}
#[test]
fn share_contracts_match_actual_protocol() -> Result<()> {
    let mut total = 0;
    for name in [
        "projectShareTunnelCreateSchema",
        "projectShareAttachmentWireSchema",
        "standaloneChatShareAttachmentWireSchema",
        "workerProjectShareOpenResultSchema",
    ] {
        let output = Command::new("node")
            .args(["scripts/server-rust/security-oracle.mjs", "--vectors", name])
            .current_dir(PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap())
            .output()?;
        anyhow::ensure!(
            output.status.success(),
            "Reference failed:{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let vectors: Value = serde_json::from_slice(&output.stdout)?;
        for (i, case) in vectors["cases"]
            .as_array()
            .context("Share protocol cases")?
            .iter()
            .enumerate()
        {
            let actual = match wire::parse(name, case.get("input")) {
                Ok(v) => Value::object([("ok", v)]),
                Err(ValidationError::Invalid(issues)) => {
                    Value::object([("issues", Value::Array(issues))])
                }
                Err(ValidationError::Operation) => {
                    Value::object([("thrown", Value::String("TypeError".into()))])
                }
            };
            assert_eq!(actual, case["outcome"], "{name} case{i}");
            if let Some(expected) = case.get("errorMessage") {
                assert_eq!(
                    Value::String(actual["issues"].stringify_pretty().into()),
                    *expected,
                    "{name} error{i}"
                );
            }
            total += 1;
        }
    }
    println!("{total} project-share protocol and error-message cases matched");
    Ok(())
}
