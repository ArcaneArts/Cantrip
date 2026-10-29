use anyhow::{Context, Result};
use cantrip_server::{
    operations::{log_sanitize, logging::Emitter},
    wire::{JsString, Value},
};
use std::{
    path::PathBuf,
    process::Command,
    sync::{Arc, Mutex},
};
fn string(v: &Value) -> JsString {
    v.as_js_string().expect("log string").clone()
}
#[test]
fn service_log_sanitization_and_noise_match_actual_shared_logger() -> Result<()> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_owned();
    let output = Command::new("node")
        .args([
            "--import",
            "tsx",
            "scripts/server-rust/service-log-oracle.mjs",
        ])
        .current_dir(root)
        .output()?;
    anyhow::ensure!(
        output.status.success(),
        "Source log oracle: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let oracle: Value = serde_json::from_slice(&output.stdout)?;
    let cases = oracle["cases"].as_array().context("Log cases")?;
    for (index, case) in cases.iter().enumerate() {
        let actual = match case["kind"].as_str().unwrap() {
            "text" => Value::String(log_sanitize::text(case["input"].as_js_string().unwrap())),
            "context" => log_sanitize::context(&case["input"]),
            "error" => log_sanitize::error(case.get("input")),
            _ => unreachable!(),
        };
        assert_eq!(
            actual,
            case["expected"],
            "{} case {index}: {}",
            case["kind"].as_str().unwrap(),
            case["input"].stringify()
        );
    }
    let scenarios = oracle["scenarios"].as_array().unwrap();
    let mut actions = 0;
    for scenario in scenarios {
        let clock = Arc::new(Mutex::new((
            scenario["initial"].as_f64().unwrap(),
            0.0,
            0_u64,
        )));
        let records = Arc::new(Mutex::new(Vec::new()));
        let emitter = Emitter::new(
            string(&scenario["system"]),
            {
                let clock = clock.clone();
                Arc::new(move || {
                    let mut state = clock.lock().unwrap();
                    state.2 += 1;
                    let at = state.0;
                    state.0 += state.1;
                    at
                })
            },
            {
                let records = records.clone();
                Arc::new(move |record| records.lock().unwrap().push(record))
            },
        );
        let mut results = Vec::new();
        for action in scenario["actions"].as_array().unwrap() {
            actions += 1;
            if action["op"] == "clock" {
                let mut clock = clock.lock().unwrap();
                clock.0 = action["now"].as_f64().unwrap_or(f64::NAN);
                clock.1 = action["step"].as_f64().unwrap_or(0.0);
                continue;
            }
            let key = action.get("key").map(string);
            let message = action
                .get("message")
                .map(string)
                .unwrap_or_else(|| "Event".into());
            let level = action["level"].as_str().unwrap_or("info");
            let result: Result<Value> = match action["op"].as_str().unwrap() {
                "event" => emitter
                    .event(level, &message, action.get("context"))
                    .map(|_| Value::Null),
                "sample" => emitter
                    .sampled(
                        key.unwrap(),
                        action.get("every"),
                        level,
                        &message,
                        action.get("context"),
                    )
                    .map(Value::Bool),
                "repeat" => emitter
                    .rate_limited(
                        key.unwrap(),
                        level,
                        &message,
                        action.get("context"),
                        action.get("options"),
                    )
                    .map(|_| Value::Null),
                "flush" => emitter.flush_repeated(key.as_ref()).map(|_| Value::Null),
                _ => unreachable!(),
            };
            results.push(match result {
                Ok(value) => Value::object([("result", value)]),
                Err(error) => Value::object([("error", Value::String(error.to_string().into()))]),
            });
        }
        let actual = Value::from_serialize(
            &serde_json::json!({"records":*records.lock().unwrap(),"results":results,"clockCalls":clock.lock().unwrap().2}),
        );
        assert_eq!(
            actual,
            scenario["expected"],
            "logger scenario {}",
            scenario["name"].as_str().unwrap()
        );
    }
    println!(
        "{} sanitizer/error cases and {actions} actions across {} actual shared-logger scenarios matched",
        cases.len(),
        scenarios.len()
    );
    Ok(())
}
