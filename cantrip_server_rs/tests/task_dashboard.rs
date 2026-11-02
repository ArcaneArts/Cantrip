use anyhow::{Context, Result};
use cantrip_server::{tasks::dashboard, wire::Value};
use std::{path::PathBuf, process::Command};

#[test]
fn pull_request_associations_and_warnings_match_source() -> Result<()> {
    let output = Command::new("node")
        .args([
            "--import",
            "tsx",
            "scripts/server-rust/task-dashboard-oracle.mjs",
        ])
        .current_dir(PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap())
        .output()?;
    anyhow::ensure!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let cases: Value = serde_json::from_slice(&output.stdout)?;
    let cases = cases.as_array().context("Task dashboard vectors")?;
    for (index, case) in cases.iter().enumerate() {
        let requests = dashboard::associate_pull_requests(&case["input"])?;
        let mut input = case["input"].clone();
        input["pullRequests"] = Value::Array(requests.clone());
        let warnings = dashboard::advisory_warnings(&input)?;
        assert_eq!(
            Value::object([
                ("pullRequests", Value::Array(requests)),
                ("warnings", Value::Array(warnings))
            ]),
            case["expected"],
            "case{index}"
        );
    }
    println!(
        "{} exact Source Task dashboard association/warning cases matched",
        cases.len()
    );
    Ok(())
}
