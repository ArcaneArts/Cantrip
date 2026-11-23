use anyhow::{Context, Result};
use cantrip_server::wire::{self, ValidationError, Value};
use std::{path::PathBuf, process::Command};

#[test]
fn ciphertext_checks_cover_full_blocks_and_the_tail() {
    let valid = "Aa09-_".repeat(17) + "AA";
    let message = |ciphertext| {
        Value::from_serialize(&serde_json::json!({
            "id": "66666666-6666-4666-8666-000000000001",
            "classification": {"role": "user", "mode": "default", "attachmentIds": []},
            "protectedContent": {
                "formatVersion": 1, "keyRevision": 2,
                "envelope": {
                    "version": 1, "algorithm": "AES-256-GCM", "keyRevision": 2,
                    "nonce": "AAAAAAAAAAAAAAAA", "ciphertext": ciphertext,
                }
            },
            "idempotencyKey": "message:1",
        }))
    };
    let parse = |value: &Value| wire::parse("chatMessageOpaqueContentSchema", Some(value));
    let accepted = message(valid.clone());
    let key = accepted["protectedContent"]["envelope"]["ciphertext"]
        .as_js_string()
        .unwrap();
    let object = Value::object([(key.clone(), Value::Bool(true))]);
    assert!(parse(&accepted).is_ok());
    let from_units = wire::JsString::new(key.units().to_vec());
    assert_eq!(
        object.as_object().unwrap().get(&from_units),
        Some(&Value::Bool(true))
    );
    for position in [0, 31, 32, 63, 64, 95, 96, valid.len() - 1] {
        let mut invalid = valid.clone();
        invalid.replace_range(position..position + 1, "=");
        let Err(ValidationError::Invalid(issues)) = parse(&message(invalid)) else {
            panic!("invalid alphabet at byte {position} accepted");
        };
        assert!(issues.iter().any(|issue| issue["code"] == "invalid_format"));
    }
    let Err(ValidationError::Invalid(issues)) = parse(&message(valid + "AB")) else {
        panic!("invalid trailing bits accepted");
    };
    assert!(issues.iter().any(|issue| issue["code"] == "custom"));
}

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
        "archivedChatWireSummarySchema",
        "conversationRestoreSchema",
        "encryptedChatUpdateSchema",
        "chatRuntimeSelectionSchema",
        "chatComposerDraftOpaqueStateSchema",
        "encryptedChatComposerDraftWireStateSchema",
        "encryptedChatComposerDraftUpdateSchema",
        "standaloneChatScratchArchiveResultSchema",
        "standaloneChatFileWireRequestSchema",
        "encryptedChatForkSchema",
        "chatMessageOpaqueSummarySchema",
        "chatMessageOpaqueContentListSchema",
        "taskMessageOpaqueSummarySchema",
        "chatMessagePageQuerySchema",
        "chatMessageWireListSchema",
        "chatMessageWirePageSchema",
        "chatMessageOpaqueContentSchema",
        "taskMessageOpaqueContentSchema",
        "nativeHistoryTurnReadRequestSchema",
        "nativeHistoryTurnReadResponseSchema",
        "encryptedChatCreateSchema",
        "conversationCatalogQuerySchema",
        "conversationCatalogWirePageSchema",
        "conversationCursorSchema",
        "conversationUsageSchema",
        "conversationUsageResultSchema",
        "agentThreadSyncSchema",
        "agentThreadSyncItemSchema",
        "archivedChatCleanupResultSchema",
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
