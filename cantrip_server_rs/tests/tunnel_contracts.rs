use anyhow::{Context, Result};
use cantrip_server::wire::{self, ValidationError, Value};
use std::{path::PathBuf, process::Command};
#[test]
fn tunnel_catalog_contracts_match_actual_protocol() -> Result<()> {
    let mut total = 0;
    for name in [
        "tunnelUserWireCreateSchema",
        "tunnelUserWireUpdateSchema",
        "tunnelWireSummarySchema",
        "tunnelWireListSchema",
        "tunnelDataPlaneFrameHeaderSchema",
        "directTunnelPrepareRequestSchema",
        "tunnelAttachmentCreateSchema",
        "tunnelAttachmentCreateResultSchema",
        "tunnelAttachmentInitializeSchema",
        "tunnelAttachmentReadySchema",
        "tunnelDirectActivationSchema",
    ] {
        let output = Command::new("node")
            .args(["scripts/server-rust/security-oracle.mjs", "--vectors", name])
            .current_dir(PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap())
            .output()?;
        anyhow::ensure!(
            output.status.success(),
            "Protocol oracle: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let vectors: Value = serde_json::from_slice(&output.stdout)?;
        for (index, case) in vectors["cases"]
            .as_array()
            .context("Tunnel vectors")?
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
                    "{name} message {index}"
                );
            }
            total += 1;
        }
    }
    println!("{total} tunnel catalog validation/error cases matched");
    Ok(())
}
