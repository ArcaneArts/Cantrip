use anyhow::{Context, Result};
use cantrip_server::wire::{self, ValidationError, Value};
use std::{path::PathBuf, process::Command};
fn reference(args: &[&str]) -> Result<Vec<u8>> {
    let output = Command::new("node")
        .args(args)
        .current_dir(PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap())
        .output()?;
    anyhow::ensure!(
        output.status.success(),
        "Reference failed:{}",
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(output.stdout)
}
#[test]
fn document_queries_match_actual_repository() -> Result<()> {
    assert_eq!(
        serde_json::from_slice::<Value>(&reference(&[
            "--import",
            "tsx",
            "scripts/server-rust/file-document-query-manifest.mjs"
        ])?)?,
        serde_json::from_str::<Value>(include_str!("../src/file_documents/queries.json"))?
    );
    Ok(())
}
#[test]
fn document_and_surface_contracts_match_actual_protocol() -> Result<()> {
    let mut count = 0;
    for name in [
        "fileDocumentCreateSchema",
        "fileDocumentWireSummarySchema",
        "fileDocumentWireListSchema",
        "surfaceStreamWireRequestSchema",
        "surfaceStreamWireResponseSchema",
    ] {
        let vectors: Value = serde_json::from_slice(&reference(&[
            "scripts/server-rust/security-oracle.mjs",
            "--vectors",
            name,
        ])?)?;
        for (i, case) in vectors["cases"]
            .as_array()
            .context("Document cases")?
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
            if let Some(message) = case.get("errorMessage") {
                assert_eq!(
                    Value::String(actual["issues"].stringify_pretty().into()),
                    *message,
                    "{name} error{i}"
                );
            }
            count += 1;
        }
    }
    println!("{count} document/surface validation and rendered-error cases matched");
    Ok(())
}
