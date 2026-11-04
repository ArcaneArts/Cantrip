use anyhow::{Context, Result};
use cantrip_server::wire::{self, ValidationError, Value};
use std::{path::PathBuf, process::Command};

#[test]
fn linux_source_contracts_match_the_actual_protocol() -> Result<()> {
    let mut count = 0;
    for name in [
        "cantripOsExecutionSchema",
        "cantripOsExecutionScopeSchema",
        "cantripOsDispatchScopeSchema",
        "cantripOsSourceDispatchScopeSchema",
        "cantripOsProvisionIntentSchema",
        "cantripOsProvisionRequestContentSchema",
        "cantripOsObservedInstanceSchema",
        "cantripOsSourceReceiptSchema",
        "cantripOsOperationResultSchema",
        "cantripOsInspectSchema",
        "cantripOsWorkspaceCreateSchema",
        "cantripOsBindingCreateSchema",
        "cantripOsProvisionSchema",
        "cantripOsGuestPathSchema",
        "projectSourceLocationSchema",
        "cantripOsTransportSchema",
        "cantripOsDependencyOverlaySchema",
        "cantripOsDependencyOverlaysSchema",
        "cantripOsAttachSchema",
        "cantripOsWorkspaceObservationSchema",
        "cantripOsInstanceSummarySchema",
        "cantripOsWorkspaceSummarySchema",
        "cantripOsProjectSourceSummarySchema",
        "cantripOsProjectWorktreeSummarySchema",
        "cantripOsSourceBindingSummarySchema",
        "cantripOsRunDefinitionRequestSchema",
        "cantripOsRunDefinitionApiSchema",
        "cantripOsRunDefinitionResponseSchema",
        "cantripOsRunPrimarySchema",
        "cantripOsRunRootsSchema",
        "cantripOsRunLaunchSchema",
        "cantripOsRunCaptureSchema",
        "cantripOsRunSelectionSchema",
        "cantripOsRunSourceSchema",
    ] {
        let output = Command::new("node")
            .args(["scripts/server-rust/security-oracle.mjs", "--vectors", name])
            .current_dir(PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap())
            .output()?;
        anyhow::ensure!(
            output.status.success(),
            "Source oracle: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let vectors: Value = serde_json::from_slice(&output.stdout)?;
        for (index, case) in vectors["cases"]
            .as_array()
            .context("source cases")?
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
            assert_eq!(actual, case["outcome"], "{name} case {index}");
            if let Some(message) = case.get("errorMessage") {
                assert_eq!(
                    Value::String(actual["issues"].stringify_pretty().into()),
                    *message,
                    "{name} error {index}"
                );
            }
            count += 1;
        }
    }
    println!("{count} Linux source validation cases matched the real protocol");
    Ok(())
}

#[test]
fn os_chat_placement_contracts_match_actual_protocol() -> Result<()> {
    let output = Command::new("node")
        .arg("scripts/server-rust/cantrip-os-chat-vectors.mjs")
        .current_dir(PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap())
        .output()?;
    anyhow::ensure!(
        output.status.success(),
        "OS chat oracle: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let cases: Value = serde_json::from_slice(&output.stdout)?;
    for (index, case) in cases.as_array().unwrap().iter().enumerate() {
        let schema = case["schema"].as_str().unwrap();
        let actual = match wire::parse(schema, case.get("input")) {
            Ok(value) => Value::object([("ok", value)]),
            Err(ValidationError::Invalid(issues)) => {
                Value::object([("issues", Value::Array(issues))])
            }
            Err(ValidationError::Operation) => {
                Value::object([("thrown", Value::String("TypeError".into()))])
            }
        };
        assert_eq!(
            actual, case["outcome"],
            "{schema} OS placement case {index}"
        );
    }
    Ok(())
}
