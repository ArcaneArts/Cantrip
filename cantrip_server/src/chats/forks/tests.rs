use super::*;
use std::{path::PathBuf, process::Command};

#[test]
fn snapshots_match_reference_node_date_equality() -> Result<()> {
    let output = Command::new("node")
        .arg("scripts/server-rust/chat-fork-snapshot-oracle.mjs")
        .current_dir(PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap())
        .output()?;
    anyhow::ensure!(
        output.status.success(),
        "Fork snapshot oracle failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let oracle: Value = serde_json::from_slice(&output.stdout)?;
    let cases = oracle["cases"]
        .as_array()
        .context("Snapshot oracle cases")?;
    for (index, case) in cases.iter().enumerate() {
        assert_eq!(
            dates(case["left"].clone())? == dates(case["right"].clone())?,
            case["equal"].as_bool().context("Snapshot equality")?,
            "{} snapshot {index}: {case:?}",
            oracle["nodeVersion"]
        );
    }
    println!(
        "{}: {} actual fork snapshot comparisons",
        oracle["nodeVersion"],
        cases.len()
    );
    Ok(())
}
