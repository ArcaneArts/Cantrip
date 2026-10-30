use anyhow::{Context, Result};
use cantrip_server::{
    usage::{BandwidthHistory, CurrentStorage, StorageHistory, response},
    wire,
};
use serde_json::{Value, json};
use std::{path::PathBuf, process::Command};
#[test]
fn embedded_storage_query_manifest_and_traffic_constants_match_actual_sources() -> Result<()> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_owned();
    let output = Command::new("node")
        .args([
            "--import",
            "tsx",
            "scripts/server-rust/usage-contracts.mjs",
            "--json",
        ])
        .current_dir(root)
        .output()?;
    anyhow::ensure!(
        output.status.success(),
        "usage contract exporter failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        serde_json::from_slice::<Value>(&output.stdout)?,
        serde_json::from_str::<Value>(include_str!("../contracts/resource-usage.json"))?
    );
    Ok(())
}
#[test]
fn usage_projections_match_actual_node_decimal_totals_order_dates_and_staleness() -> Result<()> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_owned();
    let output = Command::new("node")
        .args([
            "--import",
            "tsx",
            "scripts/server-rust/usage-response-oracle.mjs",
        ])
        .current_dir(root)
        .output()?;
    anyhow::ensure!(
        output.status.success(),
        "Usage response oracle failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let mut cases = 0;
    let mut receipt = None;
    for line in output
        .stdout
        .split(|v| *v == b'\n')
        .filter(|v| !v.is_empty())
    {
        let case: Value = serde_json::from_slice(line)?;
        if let Some(done) = case.get("done") {
            anyhow::ensure!(receipt.is_none(), "duplicate usage response receipt");
            receipt = Some(done.as_u64().context("response case count")?);
            continue;
        }
        anyhow::ensure!(receipt.is_none(), "usage response case after completion");
        let scenario = &case["scenario"];
        let rows = scenario["rows"].clone();
        let actual = match scenario["op"]
            .as_str()
            .context("response fixture operation")?
        {
            "current" => response::current(
                &serde_json::from_value::<Vec<CurrentStorage>>(rows)?,
                &serde_json::from_value::<Vec<BandwidthHistory>>(scenario["bandwidth"].clone())?,
                scenario["now"].as_str().unwrap().parse()?,
            )?,
            "period" => {
                let (start, end) =
                    response::bandwidth_period(scenario["now"].as_str().unwrap().parse()?)?;
                json!({"start":start.timestamp_millis(),"end":end.timestamp_millis()})
            }
            "storage" => response::storage_history(
                &serde_json::from_value(scenario["query"].clone())?,
                &serde_json::from_value::<Vec<StorageHistory>>(rows)?,
            ),
            "bandwidth" => response::bandwidth_history(
                &serde_json::from_value(scenario["query"].clone())?,
                &serde_json::from_value::<Vec<BandwidthHistory>>(rows)?,
            ),
            _ => anyhow::bail!("unknown usage response operation"),
        };
        assert_eq!(
            wire::Value::from_serialize(&actual),
            wire::Value::from_serialize(&case["outcome"]),
            "usage response {} {}",
            case["id"],
            scenario
        );
        cases += 1;
    }
    anyhow::ensure!(
        cases > 0 && receipt == Some(cases),
        "incomplete usage response oracle"
    );
    println!("{cases} actual Node usage response scenarios matched");
    Ok(())
}
