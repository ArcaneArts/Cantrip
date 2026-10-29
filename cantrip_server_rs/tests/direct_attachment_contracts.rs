use anyhow::{Context, Result};
use cantrip_server::wire::{self, ValidationError, Value};
use std::{path::PathBuf, process::Command};
#[test]
fn direct_attachment_contracts_match_actual_protocol() -> Result<()> {
    let mut count = 0;
    for name in [
        "directAttachmentTicketSchema",
        "projectShareDirectCreateSchema",
        "directTunnelTicketSchema",
        "directCapabilityPrepareResultSchema",
        "directCapabilityRenewResultSchema",
        "directTransportTelemetrySchema",
    ] {
        let output = Command::new("node")
            .args(["scripts/server-rust/security-oracle.mjs", "--vectors", name])
            .current_dir(PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap())
            .output()?;
        anyhow::ensure!(
            output.status.success(),
            "Direct protocol oracle: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let vectors: Value = serde_json::from_slice(&output.stdout)?;
        for (index, case) in vectors["cases"]
            .as_array()
            .context("Direct vectors")?
            .iter()
            .enumerate()
        {
            let outcome = match wire::parse(name, case.get("input")) {
                Ok(value) => Value::object([("ok", value)]),
                Err(ValidationError::Invalid(issues)) => {
                    Value::object([("issues", Value::Array(issues))])
                }
                Err(ValidationError::Operation) => {
                    Value::object([("thrown", Value::String("TypeError".into()))])
                }
            };
            assert_eq!(outcome, case["outcome"], "{name} case {index}");
            if let Some(message) = case.get("errorMessage") {
                assert_eq!(
                    Value::String(outcome["issues"].stringify_pretty().into()),
                    *message,
                    "{name} case{index} message"
                );
            }
            count += 1;
        }
    }
    println!("{count} actual direct-attachment validation/error cases matched");
    Ok(())
}
