use anyhow::{Context, Result};
use cantrip_server::wire::{self, ValidationError, Value};
use std::{path::PathBuf, process::Command};

#[test]
fn contextual_chat_contracts_match_actual_protocol() -> Result<()> {
    let mut total = 0;
    for schema in [
        "projectChatWireSummarySchema",
        "standaloneChatWireSummarySchema",
        "contextualChatWireSummarySchema",
        "standaloneChatRootJobSummarySchema",
        "standaloneChatScratchProvisionResultSchema",
        "standaloneChatScratchDeleteResultSchema",
        "standaloneChatScratchReconciliationResultSchema",
        "encryptedStandaloneChatCreateSchema",
        "archivedStandaloneChatWireSummarySchema",
    ] {
        let output = Command::new("node")
            .args([
                "scripts/server-rust/security-oracle.mjs",
                "--vectors",
                schema,
            ])
            .current_dir(PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap())
            .output()?;
        anyhow::ensure!(
            output.status.success(),
            "Protocol oracle failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let vectors: Value = serde_json::from_slice(&output.stdout)?;
        for (index, case) in vectors["cases"]
            .as_array()
            .context("Chat protocol cases")?
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
            total += 1;
        }
    }
    println!("{total} actual contextual Chat protocol/error cases matched");
    Ok(())
}
