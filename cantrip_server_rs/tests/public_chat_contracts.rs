use anyhow::{Context, Result};
use cantrip_server::wire::{self, ValidationError, Value};
use std::{path::PathBuf, process::Command};

#[test]
fn public_chat_contracts_match_source_outcomes_and_exact_errors() -> Result<()> {
    let mut total = 0;
    for name in [
        "encryptedChatTurnCreateSchema",
        "encryptedQueuedPromptListSchema",
        "encryptedQueuedPromptUpdateSchema",
        "queuedPromptOrderSchema",
        "encryptedChatPromptSubmitResultSchema",
        "encryptedConversationPromptSubmitResultSchema",
        "encryptedChatPromptSteerResultSchema",
    ] {
        let output = Command::new("node")
            .args(["scripts/server-rust/security-oracle.mjs", "--vectors", name])
            .current_dir(PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap())
            .output()?;
        anyhow::ensure!(
            output.status.success(),
            "Public Chat oracle failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let vectors: Value = serde_json::from_slice(&output.stdout)?;
        let cases = vectors["cases"]
            .as_array()
            .context("Public Chat protocol vectors")?;
        for (index, case) in cases.iter().enumerate() {
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
                    "{name} message{index}"
                );
            }
        }
        println!("{name}: {} outcomes and exact errors matched", cases.len());
        total += cases.len();
    }
    println!("{total} Public Chat protocol outcomes and messages matched");
    Ok(())
}
