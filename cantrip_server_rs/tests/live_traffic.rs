use anyhow::{Context, Result};
use cantrip_server::{
    usage::{
        live_traffic::{LiveTrafficMeter, Options, Query},
        meter::{Counter, Measurement},
    },
    wire,
};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    io::{BufRead, BufReader},
    path::PathBuf,
    process::{Child, Command, Stdio},
};
struct Oracle(Option<Child>);
impl Drop for Oracle {
    fn drop(&mut self) {
        if let Some(child) = self.0.as_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}
fn numeric(value: &Value) -> f64 {
    value
        .as_f64()
        .unwrap_or_else(|| match value["number"].as_str() {
            Some("Infinity") => f64::INFINITY,
            Some("-Infinity") => f64::NEG_INFINITY,
            _ => f64::NAN,
        })
}
fn counter(value: &Value) -> Counter {
    match value["integer"].as_str() {
        Some(v) => Counter::Integer(v.parse().unwrap()),
        None => Counter::Number(numeric(value)),
    }
}
fn run(scenario: &Value) -> Result<Value> {
    let options = &scenario["options"];
    let meter = LiveTrafficMeter::new(Options {
        epoch: options["epoch"].as_str().unwrap().into(),
        instance_id: options["instanceId"].as_str().unwrap().into(),
        max_owners: options["maxOwners"].as_u64().unwrap_or(2048) as usize,
        owner_retention_seconds: options["ownerRetentionSeconds"].as_u64().unwrap_or(600),
    });
    let mut meter = match meter {
        Ok(meter) => meter,
        Err(error) => return Ok(json!({"constructorError":error.to_string()})),
    };
    let mut now = 1_793_059_200_123.0;
    let mut saved: HashMap<String, Value> = HashMap::new();
    let mut outcome = vec![];
    for step in scenario["steps"].as_array().context("traffic steps")? {
        if let Some(at) = step.get("at") {
            now = numeric(at);
        }
        let value = match step["op"].as_str().context("traffic operation")? {
            "record" => {
                let input = &step["input"];
                meter
                    .record(
                        &Measurement {
                            owner_id: input["ownerId"].as_str().unwrap().into(),
                            bytes: counter(&input["bytes"]),
                            operation_count: input.get("operationCount").map(counter),
                            direction: input["direction"].as_str().unwrap().into(),
                            channel: input["channel"].as_str().unwrap().into(),
                            notify_change: input["notifyChange"].as_bool(),
                        },
                        now,
                    )
                    .map(|v| json!(v))
            }
            "http" => meter
                .record_http_request(
                    step["owner"].as_str().unwrap(),
                    step["route"].as_str().unwrap(),
                    now,
                )
                .map(|v| json!(v)),
            "count" => meter.owner_count(now).map(|v| json!(v)),
            "snapshot" => {
                let query = if let Some(from) = step["afterFrom"].as_str() {
                    let previous = saved.get(from).context("previous snapshot")?;
                    Query {
                        epoch: previous["epoch"].as_str().map(str::to_owned),
                        after: previous["cursor"].as_str().map(str::to_owned),
                    }
                } else {
                    Query {
                        epoch: step["query"]["epoch"].as_str().map(str::to_owned),
                        after: step["query"]["after"].as_str().map(str::to_owned),
                    }
                };
                let value = meter.snapshot(step["owner"].as_str().unwrap(), &query, now);
                if let (Some(name), Ok(value)) = (step["save"].as_str(), &value) {
                    saved.insert(name.into(), value.clone());
                }
                value
            }
            _ => anyhow::bail!("unknown traffic step"),
        };
        outcome.push(match value {
            Ok(value) => json!({"value":value}),
            Err(error) => json!({"error":error.to_string()}),
        });
    }
    Ok(json!(outcome))
}
fn difference(actual: &Value, expected: &Value, path: &str) -> Option<String> {
    if wire::Value::from_serialize(actual) == wire::Value::from_serialize(expected) {
        return None;
    }
    if let (Some(a), Some(e)) = (actual.as_array(), expected.as_array()) {
        if a.len() != e.len() {
            return Some(format!("{path}: array lengths {} != {}", a.len(), e.len()));
        }
        for (i, (a, e)) in a.iter().zip(e).enumerate() {
            if let Some(diff) = difference(a, e, &format!("{path}[{i}]")) {
                return Some(diff);
            }
        }
    } else if let (Some(a), Some(e)) = (actual.as_object(), expected.as_object()) {
        for key in a.keys().chain(e.keys()) {
            if let Some(diff) = difference(&actual[key], &expected[key], &format!("{path}.{key}")) {
                return Some(diff);
            }
        }
    }
    Some(format!(
        "{path}: actual {} != expected {}",
        actual.to_string().chars().take(250).collect::<String>(),
        expected.to_string().chars().take(250).collect::<String>()
    ))
}
#[test]
fn live_traffic_matches_actual_node_samples_cursors_eviction_and_saturation() -> Result<()> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_owned();
    let mut oracle = Oracle(Some(
        Command::new("node")
            .args([
                "--import",
                "tsx",
                "scripts/server-rust/live-traffic-oracle.mjs",
            ])
            .current_dir(root)
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()?,
    ));
    let stdout = oracle
        .0
        .as_mut()
        .unwrap()
        .stdout
        .take()
        .context("traffic oracle stdout")?;
    let mut cases = 0;
    let mut receipt = None;
    for line in BufReader::new(stdout).lines() {
        let case: Value = serde_json::from_str(&line?)?;
        if let Some(done) = case.get("done") {
            anyhow::ensure!(receipt.is_none(), "duplicate traffic oracle receipt");
            receipt = Some(done.as_u64().context("traffic oracle count")?);
            continue;
        }
        anyhow::ensure!(receipt.is_none(), "traffic case after completion receipt");
        let actual = run(&case["scenario"])?;
        if let Some(diff) = difference(&actual, &case["outcome"], "$") {
            anyhow::bail!(
                "Traffic scenario {} {}: {diff}",
                case["id"],
                case["scenario"]["name"]
            );
        }
        cases += 1;
    }
    let status = oracle.0.as_mut().unwrap().wait()?;
    oracle.0 = None;
    anyhow::ensure!(
        status.success() && cases > 0 && receipt == Some(cases),
        "Incomplete traffic oracle: {status}, cases {cases}, receipt {receipt:?}"
    );
    println!("{cases} actual Node live traffic scenarios matched");
    Ok(())
}
