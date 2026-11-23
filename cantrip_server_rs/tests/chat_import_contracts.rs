use anyhow::{Context, Result};
use cantrip_server::wire::{self, ValidationError, Value};
use std::{path::PathBuf, process::Command};
#[test]
fn external_history_and_chat_import_contracts_match_actual_protocol() -> Result<()> {
    let mut count = 0;
    for name in [
        "chatImportJobSummarySchema",
        "chatImportJobListSchema",
        "chatImportCreateSchema",
        "chatImportJobRetrySchema",
        "externalChatImportReferenceSchema",
        "externalChatAttachmentSchema",
        "externalChatTranscriptSchema",
        "externalChatReadWorkerResultSchema",
        "externalChatAttachmentReadResultSchema",
        "externalChatDiscoveryWorkerResultSchema",
        "projectExternalChatDiscoverySchema",
    ] {
        let output = Command::new("node")
            .args(["scripts/server-rust/chat-import-contract-oracle.mjs", name])
            .current_dir(PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap())
            .output()?;
        anyhow::ensure!(
            output.status.success(),
            "Source import oracle: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let data: Value = serde_json::from_slice(&output.stdout)?;
        for (index, case) in data["cases"]
            .as_array()
            .context("Import oracle cases")?
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
            assert_eq!(actual, case["outcome"], "{name} case{index}");
            if let Some(message) = case.get("errorMessage") {
                assert_eq!(
                    Value::String(actual["issues"].stringify_pretty().into()),
                    *message,
                    "{name} pretty error{index}"
                );
            }
            count += 1;
        }
    }
    println!("{count} actual external history/import validation and error cases matched");
    Ok(())
}
