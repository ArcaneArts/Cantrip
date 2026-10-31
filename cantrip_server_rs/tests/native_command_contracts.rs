use anyhow::{Context, Result};
use cantrip_server::wire::{self, ValidationError, Value};
use std::{path::PathBuf, process::Command};

#[test]
fn native_command_contracts_match_actual_protocol() -> Result<()> {
    let mut total = 0;
    for schema in [
        "nativeCommandEventSchema",
        "nativePermissionTransitionResolveSchema",
        "cuaPreviewAuthoritySchema",
        "agentInteractionRequestCreateSchema",
        "encryptedAgentInteractionRequestCreateSchema",
        "agentInteractionRequestSchema",
        "encryptedAgentInteractionRequestSchema",
        "agentInteractionResolutionCreateSchema",
        "encryptedAgentInteractionResolutionCreateSchema",
        "agentInteractionRequestQuerySchema",
        "agentInteractionRequestWireListSchema",
        "nativeModelInventoryRequestSchema",
        "nativeModelInventorySchema",
        "nativeChatModelInventoryQuerySchema",
        "nativeChatModelInventorySchema",
        "nativeSettingsRefreshRequestSchema",
        "nativeSettingsUpdateRequestSchema",
        "nativeSettingsUpdateReceiptSchema",
        "nativeAccountDefaultsRequestSchema",
        "nativeAccountDefaultsResponseSchema",
        "chatPlanOpaqueStateSchema",
        "chatAttachmentOpaqueSummarySchema",
        "nativeCommandSessionSchema",
        "nativeCommandAdmissionSchema",
        "nativeCommandIntentSchema",
        "nativeCommandReceiptSchema",
        "nativeCommandDispatchSchema",
        "nativeCommandContinuationSchema",
        "nativePendingRequestSchema",
        "nativeSettingsStateSchema",
        "nativeSettingsIntentSchema",
        "nativeSettingsBindingSchema",
        "nativeSettingsReadScopeSchema",
        "protectedNativeSettingsSnapshotSchema",
        "nativeSettingsVersionSchema",
        "nativeSettingsObservationRequestSchema",
        "nativeSettingsObservationReceiptSchema",
        "nativeSettingsEvidenceSchema",
        "nativeSettingsEvidenceResultSchema",
        "nativeCommandSettlementSchema",
        "nativeCommandTerminalEvidenceSchema",
        "queuedPromptOpaqueContentSchema",
        "encryptedQueuedPromptSchema",
        "nativeTurnRecoveryObservationSchema",
        "managedQueueClaimSchema",
        "managedQueueReadSchema",
        "managedQueueSnapshotSchema",
        "managedQueueMutationSchema",
        "managedQueueMutateSchema",
        "managedQueueMutationResultSchema",
        "managedQueueStartReceiptSchema",
        "managedQueueStartReceiptResultSchema",
        "managedQueueImportSchema",
        "managedQueueImportAckSchema",
        "managedQueueImportResultSchema",
        "managedQueueLookupSchema",
        "managedQueueLookupResultSchema",
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
            "Command protocol oracle failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let vectors: Value = serde_json::from_slice(&output.stdout)?;
        for (index, case) in vectors["cases"]
            .as_array()
            .context("Command contract vectors")?
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
            if actual.get("ok").is_some() {
                assert_eq!(
                    actual["ok"].stringify(),
                    case["outcome"]["ok"].stringify(),
                    "{schema} serialization order {index}"
                );
            }
            if let Some(message) = case.get("errorMessage") {
                assert_eq!(
                    Value::String(actual["issues"].stringify_pretty().into()),
                    *message,
                    "{schema} issue message {index}"
                );
            }
            total += 1;
        }
    }
    println!("{total} actual native command contract cases matched");
    Ok(())
}
