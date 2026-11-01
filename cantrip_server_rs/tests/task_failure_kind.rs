use anyhow::{Context, Result};
use cantrip_server::{tasks::failure_kind, wire::Value};
use std::{path::PathBuf, process::Command};
#[test]
fn task_failure_categories_match_actual_source() -> Result<()> {
    let output = Command::new("node")
        .args([
            "--import",
            "tsx",
            "scripts/server-rust/task-failure-oracle.mjs",
        ])
        .current_dir(PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap())
        .output()?;
    anyhow::ensure!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let vectors: Value = serde_json::from_slice(&output.stdout)?;
    let cases = vectors["cases"].as_array().context("Task failure cases")?;
    for (i, case) in cases.iter().enumerate() {
        assert_eq!(
            failure_kind::classify(&case["input"]),
            case["kind"].as_str().unwrap(),
            "case {i}: {:?}",
            case["input"]
        );
    }
    println!(
        "{} actual Source Task failure categories matched",
        cases.len()
    );
    Ok(())
}
#[test]
fn command_failure_keeps_explicit_category_through_shared_error() {
    use cantrip_server::{
        operations::shared_failure,
        workers::{bridge::CommandError, command_bus::CommandFailure},
    };
    let error: anyhow::Error = CommandFailure::Bridge(CommandError {
        message: "network timeout".into(),
        code: Some("task-capacity".into()),
        unavailable: false,
        request_id: None,
        encoding_error: None,
    })
    .into();
    assert_eq!(failure_kind::for_error(&error), "capacity");
    let shared = shared_failure::owned(std::sync::Arc::new(error));
    assert_eq!(failure_kind::for_error(&shared), "capacity");
    let native = cantrip_server::native_commands::CommandError::new(
        "task-needs-input",
        Some("network timeout"),
        409,
    );
    assert_eq!(failure_kind::for_error(&native.into()), "needs-input");
}
