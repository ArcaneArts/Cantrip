use anyhow::{Context, Result};
use cantrip_server::{operations::TransportMetrics, wire::Value};
use std::{path::PathBuf, process::Command};
#[test]
fn transport_counters_and_prometheus_values_match_actual_source() -> Result<()> {
    let output = Command::new("node")
        .args([
            "--import",
            "tsx",
            "scripts/server-rust/transport-metrics-oracle.mjs",
        ])
        .current_dir(PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap())
        .output()?;
    anyhow::ensure!(
        output.status.success(),
        "Transport metrics oracle: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let cases: Value = serde_json::from_slice(&output.stdout)?;
    for (index, case) in cases
        .as_array()
        .context("Metric vectors")?
        .iter()
        .enumerate()
    {
        let metrics = TransportMetrics::default();
        for operation in case["operations"].as_array().unwrap() {
            if operation["type"] == "direct" {
                metrics.direct(operation["kind"].as_str().unwrap(), &operation["value"]);
            } else {
                metrics.worker_link(&operation["value"]);
            }
        }
        assert_eq!(
            Value::from_serialize(&metrics.prometheus_series()),
            case["expected"],
            "Transport metrics case{index}"
        );
    }
    println!(
        "{} actual transport metric snapshots matched",
        cases.as_array().unwrap().len()
    );
    Ok(())
}
