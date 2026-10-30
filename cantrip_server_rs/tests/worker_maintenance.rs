use anyhow::{Context, Result};
use cantrip_server::{
    wire::Value,
    workers::maintenance::{material_fingerprint, surface_material_changed},
};
use std::{path::PathBuf, process::Command};

fn oracle(script: &str) -> Result<Value> {
    let output = Command::new("node")
        .args(["--import", "tsx", script])
        .current_dir(PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap())
        .output()?;
    anyhow::ensure!(
        output.status.success(),
        "Reference oracle failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(serde_json::from_slice(&output.stdout)?)
}
#[test]
fn encryption_material_and_refresh_decisions_match_the_actual_source() -> Result<()> {
    let cases = oracle("scripts/server-rust/maintenance-oracle.mjs")?;
    for (index, case) in cases
        .as_array()
        .context("Fingerprint cases")?
        .iter()
        .enumerate()
    {
        assert_eq!(
            material_fingerprint(&case["after"]).stringify(),
            case["fingerprint"].as_str().unwrap(),
            "fingerprint case {index}"
        );
        assert_eq!(
            surface_material_changed(&case["component"], &case["before"], &case["after"]),
            case["changed"].as_bool().unwrap(),
            "refresh case {index}"
        );
    }
    println!(
        "{} actual fingerprint/refresh comparisons passed",
        cases.as_array().unwrap().len()
    );
    Ok(())
}
#[test]
fn terminal_sql_diagnostics_match_the_current_reference_queries() -> Result<()> {
    assert_eq!(
        oracle("scripts/server-rust/maintenance-query-manifest.mjs")?,
        serde_json::from_str::<Value>(include_str!("../src/workers/maintenance/queries.json"))?
    );
    Ok(())
}
