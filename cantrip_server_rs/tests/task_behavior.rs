use anyhow::{Context, Result};
use cantrip_server::{
    tasks::{policy, relay},
    wire::Value,
};
use std::{path::PathBuf, process::Command};
#[test]
fn task_state_retry_and_encrypted_relay_match_source() -> Result<()> {
    let output = Command::new("node")
        .args([
            "--import",
            "tsx",
            "scripts/server-rust/task-behavior-oracle.mjs",
        ])
        .current_dir(PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap())
        .output()?;
    anyhow::ensure!(
        output.status.success(),
        "Task behavior oracle failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let vectors: Value = serde_json::from_slice(&output.stdout)?;
    let cases = vectors["cases"].as_array().context("Task behavior cases")?;
    for (index, case) in cases.iter().enumerate() {
        let input = &case["input"];
        let result: Result<Value> = match case["kind"].as_str().unwrap() {
            "transition" => Ok(Value::from_serialize(&policy::can_transition(
                input["from"].as_str().unwrap(),
                input["to"].as_str().unwrap(),
            ))),
            "start" => policy::validate_start(
                input["state"].as_str().unwrap(),
                input["stable"].as_str(),
                input["kind"].as_str().unwrap(),
            ),
            "retry-summary" => {
                policy::retry_summary(&input["record"], input["now"].as_i64().unwrap())
            }
            "retry-schedule" => policy::schedule_retry(
                Some(&input["record"]),
                input["key"].as_str().unwrap(),
                input["failureKind"].as_str().unwrap(),
                input["now"].as_f64().unwrap(),
            ),
            "relay-fields" => relay::turn_fields(&input["request"]),
            "relay-result" => relay::parse_result(&input["request"], &input["result"]),
            _ => anyhow::bail!("Unknown Task behavior case"),
        };
        let actual = match result {
            Ok(value) => Value::object([("ok", value)]),
            Err(error) => Value::object([("error", Value::from_serialize(&error.to_string()))]),
        };
        assert_eq!(actual, case["outcome"], "case{index}: {input:?}");
    }
    println!(
        "{} Task state, retry and encrypted relay outcomes matched Source",
        cases.len()
    );
    Ok(())
}
