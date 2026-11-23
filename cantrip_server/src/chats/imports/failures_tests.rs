use super::*;
use crate::workers::bridge::CommandError;
use std::{path::PathBuf, process::Command};

#[test]
fn error_classification_matches_actual_source_executor() -> Result<()> {
    let output = Command::new("node")
        .args([
            "--import",
            "tsx",
            "scripts/server-rust/chat-import-error-oracle.mjs",
        ])
        .current_dir(PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap())
        .output()?;
    anyhow::ensure!(
        output.status.success(),
        "Source import executor oracle: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let data: Value = serde_json::from_slice(&output.stdout)?;
    let cases = data["cases"].as_array().context("Import executor cases")?;
    for (index, case) in cases.iter().enumerate() {
        let input = &case["input"];
        let kind = input["kind"].as_str().context("Import error kind")?;
        let error: anyhow::Error = match kind {
            "digest-mismatch" => hydration::Error::DigestMismatch.into(),
            "target-mismatch" => hydration::Error::TargetMismatch.into(),
            "too-many-skills" => hydration::Error::TooManySkills.into(),
            "validation" => crate::settings::parse_response(
                "externalChatReadWorkerResultSchema",
                Some(&Value::object([] as [(&str, Value); 0])),
            )
            .unwrap_err(),
            _ => CommandFailure::Bridge(CommandError {
                message: input["message"]
                    .as_js_string()
                    .context("Worker error text")?
                    .clone(),
                unavailable: kind == "offline",
                code: None,
                request_id: None,
                inference: None,
                encoding_error: if kind == "encoding-validation" {
                    Some(Arc::new(
                        crate::wire::parse(
                            "externalChatReadWorkerResultSchema",
                            Some(&Value::object([] as [(&str, Value); 0])),
                        )
                        .unwrap_err(),
                    ))
                } else {
                    None
                },
            })
            .into(),
        };
        let actual = mapped(&error);
        assert_eq!(
            actual, case["outcome"]["error"],
            "Source executor case {index}: {input:?}"
        );
    }
    println!(
        "{} real Source executor error settlements matched",
        cases.len()
    );
    Ok(())
}
