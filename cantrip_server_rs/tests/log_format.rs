use anyhow::{Result, ensure};
use cantrip_server::{operations::log_format, wire::Value};
use std::{path::PathBuf, process::Command};
#[test]
fn console_records_http_statuses_and_durations_match_node() -> Result<()> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_owned();
    let output = Command::new("node")
        .arg("scripts/server-rust/log-format-oracle.mjs")
        .current_dir(root)
        .output()?;
    ensure!(
        output.status.success(),
        "Source formatter: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let corpus: Value = serde_json::from_slice(&output.stdout)?;
    for (i, case) in corpus["services"].as_array().unwrap().iter().enumerate() {
        let actual = log_format::service(&case["record"], case["colors"].as_bool().unwrap());
        if let Some(error) = case["error"].as_str() {
            assert_eq!(actual.unwrap_err().to_string(), error, "error {i}");
        } else {
            assert_eq!(Value::String(actual?), case["expected"], "service {i}");
        }
    }
    for (i, case) in corpus["http"].as_array().unwrap().iter().enumerate() {
        assert_eq!(
            Value::String(log_format::http(
                &case["record"],
                case["colors"].as_bool().unwrap()
            )),
            case["expected"],
            "http {i}"
        );
    }
    for case in corpus["durations"].as_array().unwrap() {
        assert_eq!(
            Value::String(log_format::duration(case["input"].as_f64().unwrap())),
            case["expected"]
        );
    }
    for case in corpus["paths"].as_array().unwrap() {
        assert_eq!(
            Value::String(cantrip_server::http::request_logs::safe_path(
                case["input"].as_js_string().unwrap()
            )),
            case["expected"],
            "URL {:?}",
            case["input"]
        );
    }
    Ok(())
}
