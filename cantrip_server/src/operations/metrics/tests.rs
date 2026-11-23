use super::*;
use anyhow::{Context, Result};
use std::process::Command;

#[test]
fn snapshots_and_complete_prometheus_match_actual_source() -> Result<()> {
    let output = Command::new("node")
        .args([
            "--import",
            "tsx",
            "scripts/server-rust/operational-metrics-oracle.mjs",
        ])
        .current_dir(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .unwrap(),
        )
        .output()?;
    anyhow::ensure!(
        output.status.success(),
        "Source collector oracle: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let cases: Vec<Value> = serde_json::from_slice(&output.stdout)?;
    assert!(cases.len() > 150);
    for (index, case) in cases.iter().enumerate() {
        let metrics = OperationalMetrics::new(case["startedAt"].as_f64().unwrap() as i64);
        let transport = super::super::TransportMetrics::default();
        let mut operation_now = case["startedAt"].as_f64().unwrap() as i64;
        for operation in case["operations"]
            .as_array()
            .context("collector operations")?
        {
            operation_now += 17;
            match operation["type"]
                .as_str()
                .context("collector operation type")?
            {
                "begin" => metrics.begin_http(),
                "finish" => metrics.finish_http(
                    operation["method"].as_str().unwrap(),
                    operation["status"].as_f64().unwrap() as u16,
                    operation["durationMs"].as_f64().unwrap(),
                ),
                "probe" => metrics.database_probe(
                    operation["ready"] == true,
                    operation["durationMs"].as_f64().unwrap(),
                ),
                "legacy" => metrics.legacy_request(operation["endpoint"].as_str().unwrap()),
                "direct" => {
                    transport.direct(operation["kind"].as_str().unwrap(), &operation["value"])
                }
                "scheduler" => metrics.scheduler_scan(&operation["value"], operation_now),
                other => anyhow::bail!("Unknown collector operation: {other}"),
            }
        }
        let now = case["now"].as_f64().unwrap() as i64;
        assert_eq!(
            metrics.snapshot_at(now),
            case["snapshot"],
            "snapshot case {index}"
        );
        assert_eq!(
            metrics.render_at(&case["input"], &transport, now),
            case["prometheus"].as_str().context("Source Prometheus")?,
            "complete Prometheus case {index}"
        );
    }
    Ok(())
}
