use anyhow::{Context, Result};
use cantrip_server::{
    operations::log_records::{self, Buffer},
    wire::Value,
};
use std::{path::PathBuf, process::Command};
#[test]
fn persisted_minimization_buffer_bounds_and_cursors_match_source() -> Result<()> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_owned();
    let output = Command::new("node")
        .arg("scripts/server-rust/log-records-oracle.mjs")
        .current_dir(root)
        .output()?;
    anyhow::ensure!(
        output.status.success(),
        "Source record oracle: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let corpus: Value = serde_json::from_slice(&output.stdout)?;
    for (index, case) in corpus["minima"]
        .as_array()
        .context("minimization corpus")?
        .iter()
        .enumerate()
    {
        assert_eq!(
            log_records::minimize(&case["input"]),
            case["expected"],
            "minimization {index}"
        );
    }
    for (index, scenario) in corpus["scenarios"].as_array().unwrap().iter().enumerate() {
        let mut buffer = Buffer::new(&scenario["options"])?;
        for (step, action) in scenario["actions"].as_array().unwrap().iter().enumerate() {
            let actual = match action["op"].as_str().unwrap() {
                "append" => buffer.append(&action["input"]),
                "read" => buffer.read(&action["input"])?,
                "clear" => {
                    buffer.clear();
                    Value::Null
                }
                _ => unreachable!(),
            };
            assert_eq!(actual, action["expected"], "scenario{index} step{step}");
            assert_eq!(
                buffer.stats(),
                action["stats"],
                "stats scenario{index} step{step}"
            );
        }
    }
    Ok(())
}
